//! Convert git2 diffs into the `Hunk` and `FileChange` of spec §13.

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::{DiffLine, FileChange, FileDiff, FileStatus, Hunk, LineKind};

/// Maximum diff lines returned for one file; the rest is truncated (spec §15: open a 2000-line change within 200 ms).
pub const MAX_LINES: usize = 20_000;

/// When listing files, download at most this many missing file contents for line counts (partial clones)
pub const PREFETCH_LIMIT: usize = 1000;

pub fn file_status(d: git2::Delta) -> Option<FileStatus> {
    Some(match d {
        git2::Delta::Modified => FileStatus::M,
        git2::Delta::Added | git2::Delta::Copied => FileStatus::A,
        git2::Delta::Deleted => FileStatus::D,
        git2::Delta::Renamed => FileStatus::R,
        git2::Delta::Typechange => FileStatus::T,
        _ => return None,
    })
}

fn path_str(p: Option<&std::path::Path>) -> String {
    p.map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}

/// The object isn't local (file contents not yet downloaded in a partial clone)
fn is_missing(e: &git2::Error) -> bool {
    e.code() == git2::ErrorCode::NotFound && e.class() == git2::ErrorClass::Odb
}

/// Partial clones (`git clone --filter=blob:none`): when file contents in a diff aren't local, download them from the promisor remote in one go,
/// using the same command git uses for on-demand downloads. Returns false when nothing is missing, it isn't a partial clone, or the download fails (e.g. offline);
/// the computation then continues as usual and missing files have no line counts (see [`files`]). Nothing is downloaded when more than `limit` are missing, so we don't download too much just for line counts.
pub fn prefetch(repo: &git2::Repository, diff: &git2::Diff<'_>, limit: usize) -> bool {
    let Ok(odb) = repo.odb() else { return false };
    let mut missing: Vec<String> = Vec::new();
    for d in diff.deltas() {
        for f in [d.old_file(), d.new_file()] {
            let id = f.id();
            // Submodules (FileMode::Commit) point at another repository; don't download
            if !id.is_zero() && f.mode() != git2::FileMode::Commit && !odb.exists(id) {
                missing.push(id.to_string());
            }
        }
    }
    missing.sort();
    missing.dedup();
    if missing.is_empty() || missing.len() > limit {
        return false;
    }
    let Some(remote) = promisor_remote(repo) else { return false };
    let dir = repo.workdir().unwrap_or_else(|| repo.path()).to_path_buf();
    let input = missing.join("\n") + "\n";
    let ok = crate::git_cli::run_env(
        &dir,
        &["-c", "fetch.negotiationAlgorithm=noop", "fetch", &remote, "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "--stdin"],
        Some(&input),
        &[],
    )
    .is_ok();
    if ok {
        let _ = odb.refresh();
    }
    ok
}

/// The partial clone's remote: `extensions.partialClone`, otherwise the one with `remote.<name>.promisor = true`
fn promisor_remote(repo: &git2::Repository) -> Option<String> {
    let cfg = repo.config().ok()?.snapshot().ok()?;
    if let Ok(r) = cfg.get_string("extensions.partialclone") {
        return Some(r);
    }
    let mut it = cfg.entries(Some(r"remote\..*\.promisor")).ok()?;
    while let Some(Ok(e)) = it.next() {
        if e.value().ok() == Some("true") {
            let name = e.name().ok()?.strip_prefix("remote.")?.strip_suffix(".promisor")?;
            return Some(name.to_string());
        }
    }
    None
}

/// List the files in a diff with line stats. Untracked files go into `untracked`.
/// When file contents aren't local (partial clone, couldn't download) it doesn't fail; the file is marked `no_stats`.
pub fn files(diff: &git2::Diff<'_>, untracked: &mut Vec<String>) -> Result<Vec<FileChange>> {
    let mut out = Vec::new();
    for (i, delta) in diff.deltas().enumerate() {
        if delta.status() == git2::Delta::Untracked {
            untracked.push(path_str(delta.new_file().path()));
            continue;
        }
        let Some(status) = file_status(delta.status()) else { continue };
        let binary = delta.flags().is_binary();
        let mut no_stats = false;
        let (added, deleted) = if binary {
            (0, 0)
        } else {
            match git2::Patch::from_diff(diff, i) {
                Ok(Some(p)) => {
                    let (_, a, d) = p.line_stats().map_err(|e| CoreError::git("计算改动行数失败", e))?;
                    (a as u32, d as u32)
                }
                Ok(None) => (0, 0),
                Err(e) if is_missing(&e) => {
                    no_stats = true;
                    (0, 0)
                }
                Err(e) => return Err(CoreError::git("计算改动行数失败", e)),
            }
        };
        let new_path = path_str(delta.new_file().path());
        let old_path = path_str(delta.old_file().path());
        let (path, old_path) = match status {
            FileStatus::D => (old_path, None),
            FileStatus::R => (new_path, Some(old_path)),
            _ => (new_path, None),
        };
        out.push(FileChange { path, old_path, status, added, deleted, binary: binary || is_binary_path(&delta), no_stats });
    }
    Ok(out)
}

fn is_binary_path(delta: &git2::DiffDelta<'_>) -> bool {
    delta.new_file().is_binary() || delta.old_file().is_binary()
}

/// All change blocks of the first file in a diff. The diff should already be limited to one file by pathspec.
pub fn first_file(diff: &git2::Diff<'_>, path: &str) -> Result<FileDiff> {
    let Some(idx) = diff.deltas().position(|d| d.status() != git2::Delta::Unmodified) else {
        return Ok(FileDiff { path: path.to_string(), binary: false, hunks: Vec::new(), truncated: false });
    };
    file_at(diff, idx, path)
}

/// All change blocks of one file in a diff (whose new or old path is `path`); `None` when the file isn't there.
/// Used for diffs parsed from patch text (shelf), which can't be limited by pathspec.
pub fn file_named(diff: &git2::Diff<'_>, path: &str) -> Result<Option<FileDiff>> {
    let hit = diff.deltas().position(|d| {
        d.new_file().path().is_some_and(|p| p.to_string_lossy() == path) || d.old_file().path().is_some_and(|p| p.to_string_lossy() == path)
    });
    hit.map(|i| file_at(diff, i, path)).transpose()
}

fn file_at(diff: &git2::Diff<'_>, idx: usize, path: &str) -> Result<FileDiff> {
    let delta = diff.get_delta(idx).expect("索引来自 deltas()");
    let binary = delta.flags().is_binary() || is_binary_path(&delta);
    let patch = git2::Patch::from_diff(diff, idx).map_err(|e| {
        if is_missing(&e) {
            CoreError::new(ErrorCode::Network, "这个仓库是部分克隆，这个文件的内容还没下载，联网后再打开")
                .with_detail(serde_json::json!({ "source": e.to_string() }))
        } else {
            CoreError::git("读取差异失败", e)
        }
    })?;
    // Whether a worktree file is binary is only known after reading its content: check again after building the patch
    let binary = binary || patch.as_ref().is_some_and(|p| p.delta().flags().is_binary() || is_binary_path(&p.delta()));
    let (hunks, truncated) = match (patch, binary) {
        (Some(p), false) => patch_hunks(&p)?,
        _ => (Vec::new(), false),
    };
    Ok(FileDiff { path: path.to_string(), binary, hunks, truncated })
}

/// All change blocks of a patch (at most `MAX_LINES` lines, truncated beyond that)
fn patch_hunks(p: &git2::Patch<'_>) -> Result<(Vec<Hunk>, bool)> {
    let mut hunks = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;
    'outer: for h in 0..p.num_hunks() {
        let (hunk, n) = p.hunk(h).map_err(|e| CoreError::git("读取差异失败", e))?;
        let mut lines = Vec::with_capacity(n);
        for l in 0..n {
            if total >= MAX_LINES {
                truncated = true;
                if !lines.is_empty() {
                    hunks.push(make_hunk(&hunk, lines));
                }
                break 'outer;
            }
            let line = p.line_in_hunk(h, l).map_err(|e| CoreError::git("读取差异失败", e))?;
            let kind = match line.origin() {
                '+' => LineKind::Add,
                '-' => LineKind::Del,
                ' ' => LineKind::Context,
                _ => continue, // Notice lines such as "no newline at end of file"
            };
            let mut text = String::from_utf8_lossy(line.content()).into_owned();
            if text.ends_with('\n') {
                text.pop();
                if text.ends_with('\r') {
                    text.pop();
                }
            }
            lines.push(DiffLine { kind, old_no: line.old_lineno(), new_no: line.new_lineno(), text });
            total += 1;
        }
        hunks.push(make_hunk(&hunk, lines));
    }
    Ok((hunks, truncated))
}

/// Diff between two contents (outside the repository): compare any two files, compare with clipboard, whole-file shelf diffs
pub fn buffers_diff(old: &[u8], new: &[u8], path: &str, context: u32) -> Result<FileDiff> {
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(context);
    let p = git2::Patch::from_buffers(old, Some(std::path::Path::new(path)), new, Some(std::path::Path::new(path)), Some(&mut opts))
        .map_err(|e| CoreError::git("计算差异失败", e))?;
    let binary = p.delta().flags().is_binary() || is_binary_path(&p.delta());
    let (hunks, truncated) = if binary { (Vec::new(), false) } else { patch_hunks(&p)? };
    Ok(FileDiff { path: path.to_string(), binary, hunks, truncated })
}

fn make_hunk(h: &git2::DiffHunk<'_>, lines: Vec<DiffLine>) -> Hunk {
    let header = String::from_utf8_lossy(h.header());
    // "@@ -41,6 +41,9 @@ impl LaneLayout {" → take the part after @@
    let ctx = header.splitn(3, "@@").nth(2).map(|s| s.trim()).unwrap_or("");
    let start = h.new_start();
    let title = if ctx.is_empty() { format!("第 {start} 行起") } else { format!("{ctx} · 第 {start} 行起") };
    Hunk { title, old_start: h.old_start(), new_start: start, lines }
}
