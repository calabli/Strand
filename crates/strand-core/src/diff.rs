//! 把 git2 的差异转换成说明书第 13 节的 `Hunk` 和 `FileChange`。

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::{DiffLine, FileChange, FileDiff, FileStatus, Hunk, LineKind};

/// 单个文件最多返回的差异行数，超出部分截断（说明书 15 节：2000 行改动 200 ms 内打开）。
pub const MAX_LINES: usize = 20_000;

/// 列文件时最多为了行数下载这么多个缺的文件内容（部分克隆）
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

/// 对象不在本地（部分克隆里还没下载的文件内容）
fn is_missing(e: &git2::Error) -> bool {
    e.code() == git2::ErrorCode::NotFound && e.class() == git2::ErrorClass::Odb
}

/// 部分克隆（`git clone --filter=blob:none`）：差异涉及的文件内容不在本地时，一次从 promisor 远程下载，
/// 和 git 自己按需下载用的是同一条命令。没有缺的、不是部分克隆、或者下载失败（比如没联网）都返回 false，
/// 之后照常计算，缺的文件没有行数（见 [`files`]）。缺的超过 `limit` 个时也不下载，免得为了行数下载太多。
pub fn prefetch(repo: &git2::Repository, diff: &git2::Diff<'_>, limit: usize) -> bool {
    let Ok(odb) = repo.odb() else { return false };
    let mut missing: Vec<String> = Vec::new();
    for d in diff.deltas() {
        for f in [d.old_file(), d.new_file()] {
            let id = f.id();
            // 子模块（FileMode::Commit）指向别的仓库，不下载
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

/// 部分克隆的远程：`extensions.partialClone`，没有则找 `remote.<名字>.promisor = true` 的
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

/// 列出差异里的文件和行数统计。未跟踪的文件放进 `untracked`。
/// 文件内容不在本地（部分克隆、没能下载）时不报错，这个文件标成 `no_stats`。
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

/// 差异里第一个文件的全部修改块。差异应当已经用 pathspec 限定到一个文件。
pub fn first_file(diff: &git2::Diff<'_>, path: &str) -> Result<FileDiff> {
    let Some(idx) = diff.deltas().position(|d| d.status() != git2::Delta::Unmodified) else {
        return Ok(FileDiff { path: path.to_string(), binary: false, hunks: Vec::new(), truncated: false });
    };
    file_at(diff, idx, path)
}

/// 差异里某个文件（新路径或旧路径是 `path`）的全部修改块；没有这个文件时返回 `None`。
/// 用于从补丁文本解析出来的差异（暂存架），不能用 pathspec 限定。
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
    // 工作区的文件读了内容才知道是不是二进制：生成补丁后再看一次
    let binary = binary || patch.as_ref().is_some_and(|p| p.delta().flags().is_binary() || is_binary_path(&p.delta()));
    let (hunks, truncated) = match (patch, binary) {
        (Some(p), false) => patch_hunks(&p)?,
        _ => (Vec::new(), false),
    };
    Ok(FileDiff { path: path.to_string(), binary, hunks, truncated })
}

/// 一个补丁的全部修改块（最多 `MAX_LINES` 行，超过时截断）
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
                _ => continue, // 文件末尾没有换行之类的提示行
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

/// 两段内容之间的差异（不经过仓库）：任意两个文件对比、和剪贴板对比、暂存架看整个文件
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
    // "@@ -41,6 +41,9 @@ impl LaneLayout {" → 取 @@ 之后的部分
    let ctx = header.splitn(3, "@@").nth(2).map(|s| s.trim()).unwrap_or("");
    let start = h.new_start();
    let title = if ctx.is_empty() { format!("第 {start} 行起") } else { format!("{ctx} · 第 {start} 行起") };
    Hunk { title, old_start: h.old_start(), new_start: start, lines }
}
