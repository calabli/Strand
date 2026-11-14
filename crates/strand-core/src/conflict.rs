//! Conflict resolution (spec §8).
//!
//! The core layer: reads the conflicted files and splits them into context and change blocks using the three versions "base / yours / theirs";
//! builds the result from the frontend's marks and writes it back; finish, skip, abort.
//! The marks themselves are kept by the frontend (including undo, redo and "continue later"); the core layer keeps no mark state,
//! and when a file is applied the frontend passes in all of that file's marks at once.
//!
//! "Yours" and "theirs" are already mapped per spec §8.1: during a rebase git's ours is the target branch and theirs is your commit.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::RepoMode;
use crate::{git_cli, Session};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    /// Restoring a stash or shelf entry
    Unstash,
}

#[derive(Debug, Clone, Serialize)]
pub struct SideInfo {
    /// A branch name, or a description like "your commit"
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RebaseStep {
    pub index: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    /// Text file, can be resolved block by block
    Text,
    /// Modified on one side, deleted on the other
    ModifyDelete,
    Binary,
    /// Lock file: whole file only, theirs recommended
    Lock,
    /// Both sides renamed the same file to different names: you can only pick whose name (and content) to keep
    Rename,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SideChange {
    Modified,
    Deleted,
    Added,
    Renamed,
}

/// The commit that introduced a change block (Block.origin in spec §8.10): which commit last changed these lines on this side
#[derive(Debug, Clone, Serialize)]
pub struct Origin {
    pub commit: String,
    pub author: String,
    /// Unix seconds
    pub time: i64,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
// A file has few change blocks, not worth boxing Change to save memory
#[allow(clippy::large_enum_variant)]
pub enum Segment {
    /// Content that is the same on all three sides (or both sides made the exact same change)
    Context { lines: Vec<String> },
    Change(Change),
}

#[derive(Debug, Clone, Serialize)]
pub struct Change {
    /// An id within the file, e.g. `c3`. Stable as long as the file's three versions don't change
    pub id: String,
    /// Base content (before either side changed it)
    pub base: Vec<String>,
    /// What this side changed it to; empty means this side has no change
    pub mine: Option<Vec<String>>,
    pub theirs: Option<Vec<String>>,
    /// The commit that introduced this side's content; empty when this side didn't change, only deleted lines, or has no commit (worktree)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mine_origin: Option<Origin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theirs_origin: Option<Origin>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictFile {
    pub path: String,
    pub kind: FileKind,
    pub mine_change: SideChange,
    pub theirs_change: SideChange,
    /// Text files only
    pub segments: Vec<Segment>,
    /// Already resolved (had conflicts during this operation, none now): segments is empty
    pub resolved: bool,
    /// Rename conflict: each side's new name (path is the original name)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mine_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theirs_path: Option<String>,
}

impl MergeSession {
    /// Files not resolved yet
    pub fn unresolved(&self) -> impl Iterator<Item = &ConflictFile> {
        self.files.iter().filter(|f| !f.resolved)
    }
}

/// Files that had conflicts during this operation (`.git/strand/conflicts.json`), used to show "resolved" files in the list
#[derive(Debug, Default, Serialize, Deserialize)]
struct ConflictRecord {
    key: String,
    files: Vec<RecordedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecordedFile {
    path: String,
    kind: FileKind,
    mine_change: SideChange,
    theirs_change: SideChange,
    #[serde(default)]
    mine_path: Option<String>,
    #[serde(default)]
    theirs_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeSession {
    pub kind: SessionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<RebaseStep>,
    pub mine: SideInfo,
    pub theirs: SideInfo,
    /// Files with conflicts in this operation: unresolved first (by path), resolved after (resolved true)
    pub files: Vec<ConflictFile>,
    /// Frontend marks restored after undoing "abort merge" (the exact content the frontend handed over when aborting)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_marks: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Mine,
    Theirs,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Mark {
    #[default]
    None,
    Accept,
    Discard,
}

/// The mark for one block. `custom` is a hand-edited result; when present both sides count as handled.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChangeMark {
    #[serde(default)]
    pub mine: Mark,
    #[serde(default)]
    pub theirs: Mark,
    #[serde(default)]
    pub custom: Option<Vec<String>>,
}

/// Result of `merge_finish` and `merge_skip`: either the whole operation finished, or the rebase stopped at the next commit with conflicts.
#[derive(Debug, Clone, Serialize)]
pub struct FinishResult {
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<MergeSession>,
}

const LOCK_FILES: &[&str] = &[
    "Cargo.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Gemfile.lock", "poetry.lock",
    "composer.lock", "go.sum", "Podfile.lock", "Package.resolved", "bun.lockb", "uv.lock",
];

impl Session {
    /// The current conflict session; `None` when not merging, rebasing, cherry-picking or reverting.
    pub fn merge_session(&self) -> Result<Option<MergeSession>> {
        let kind = match self.state()?.state {
            RepoMode::Normal => return Ok(None),
            RepoMode::Merging => SessionKind::Merge,
            RepoMode::Rebasing => SessionKind::Rebase,
            RepoMode::CherryPicking => SessionKind::CherryPick,
            RepoMode::Reverting => SessionKind::Revert,
            RepoMode::Unstashing => SessionKind::Unstash,
        };
        let repo = self.git2()?;
        let git_dir = repo.path().to_path_buf();
        let (mine, mut theirs, step) = sides(self.path(), &git_dir, kind);
        if kind == SessionKind::Unstash
            && let Some(u) = self.unstash()
        {
            theirs.label = u.label;
        }
        let swap = kind == SessionKind::Rebase;

        let index = repo.index().map_err(|e| CoreError::git("读取索引失败", e))?;
        let mut files = Vec::new();
        // Entries with only one version: when both sides rename to different names, git splits the original name (base only), your new name and their new name into three entries
        let mut lone: Vec<(usize, char, Vec<u8>)> = Vec::new();
        for c in index.conflicts().map_err(|e| CoreError::git("读取冲突失败", e))? {
            let Ok(c) = c else { continue };
            let (git_ours, git_theirs) = (c.our, c.their);
            let (m, t) = if swap { (git_theirs, git_ours) } else { (git_ours, git_theirs) };
            let path_bytes = m.as_ref().or(t.as_ref()).or(c.ancestor.as_ref()).map(|e| e.path.clone()).unwrap_or_default();
            let path = String::from_utf8_lossy(&path_bytes).into_owned();
            let blob = |e: &Option<git2::IndexEntry>| -> Option<Vec<u8>> {
                e.as_ref().and_then(|e| repo.find_blob(e.id).ok()).map(|b| b.content().to_vec())
            };
            let (base, mine_b, theirs_b) = (blob(&c.ancestor), blob(&m), blob(&t));
            let change = |side: &Option<Vec<u8>>| match (side, &base) {
                (None, _) => SideChange::Deleted,
                (Some(_), None) => SideChange::Added,
                (Some(_), Some(_)) => SideChange::Modified,
            };
            let (mine_change, theirs_change) = (change(&mine_b), change(&theirs_b));
            let name = path.rsplit('/').next().unwrap_or(&path);
            let kind = match (&mine_b, &theirs_b) {
                (None, _) | (_, None) => FileKind::ModifyDelete,
                (Some(a), Some(b)) if is_binary(a) || is_binary(b) => FileKind::Binary,
                _ if LOCK_FILES.contains(&name) => FileKind::Lock,
                _ => FileKind::Text,
            };
            let segments = if kind == FileKind::Text {
                let to_lines = |b: &Option<Vec<u8>>| lines_of(b.as_deref().unwrap_or(&[]));
                segments(&to_lines(&base), &to_lines(&mine_b), &to_lines(&theirs_b))
            } else {
                Vec::new()
            };
            match (&base, &mine_b, &theirs_b) {
                (Some(b), None, None) => lone.push((files.len(), 'b', b.clone())),
                (None, Some(m), None) => lone.push((files.len(), 'm', m.clone())),
                (None, None, Some(t)) => lone.push((files.len(), 't', t.clone())),
                _ => {}
            }
            files.push(ConflictFile { path, kind, mine_change, theirs_change, segments, resolved: false, mine_path: None, theirs_path: None });
        }
        let mut files = pair_renames(files, &lone);
        files.sort_by(|a, b| a.path.cmp(&b.path));
        // Which commit introduced each change block (Block.origin in spec §8.10): blame on that side's commit
        let mine_rev = (kind != SessionKind::Unstash).then(|| mine.commit.clone()).flatten();
        let theirs_rev = matches!(kind, SessionKind::Merge | SessionKind::Rebase | SessionKind::CherryPick).then(|| theirs.commit.clone()).flatten();
        for f in files.iter_mut().filter(|f| f.kind == FileKind::Text) {
            self.fill_origins(f, mine_rev.as_deref(), theirs_rev.as_deref());
        }
        // Resolved files: recorded during this operation and no longer conflicted
        let key = format!(
            "{:?}:{}:{}:{}",
            kind,
            mine.commit.as_deref().unwrap_or(""),
            theirs.commit.as_deref().unwrap_or(""),
            if kind == SessionKind::Unstash { self.unstash().map(|u| u.id).unwrap_or_default() } else { String::new() }
        );
        let resolved = self.record_conflicts(&key, &files);
        files.extend(resolved);
        let saved_marks = self.strand_dir().ok().and_then(|d| std::fs::read(d.join("marks.json")).ok()).and_then(|b| serde_json::from_slice(&b).ok());
        Ok(Some(MergeSession { kind, step, mine, theirs, files, saved_marks }))
    }

    fn conflict_record_file(&self) -> Result<std::path::PathBuf> {
        Ok(self.strand_dir()?.join("conflicts.json"))
    }

    /// Merge this run's conflicted files into the record and return the recorded files that no longer conflict (marked resolved)
    fn record_conflicts(&self, key: &str, current: &[ConflictFile]) -> Vec<ConflictFile> {
        let Ok(path) = self.conflict_record_file() else { return Vec::new() };
        let mut rec: ConflictRecord = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if rec.key != key {
            rec = ConflictRecord { key: key.to_string(), files: Vec::new() };
        }
        for f in current {
            if !rec.files.iter().any(|r| r.path == f.path) {
                rec.files.push(RecordedFile {
                    path: f.path.clone(),
                    kind: f.kind,
                    mine_change: f.mine_change,
                    theirs_change: f.theirs_change,
                    mine_path: f.mine_path.clone(),
                    theirs_path: f.theirs_path.clone(),
                });
            }
        }
        // git records the files that conflicted at the start in MERGE_MSG (under "# Conflicts:"): include those resolved on the command line before Strand opened
        if !key.starts_with("Unstash")
            && let Ok(git_dir) = self.git2().map(|r| r.path().to_path_buf())
            && let Ok(msg) = std::fs::read_to_string(git_dir.join("MERGE_MSG"))
        {
            let listed: Vec<String> = msg
                .lines()
                .skip_while(|l| !l.starts_with("# Conflicts:"))
                .skip(1)
                .map_while(|l| l.strip_prefix("#\t").map(str::to_string))
                .collect();
            for p in listed {
                let known = rec.files.iter().any(|r| r.path == p || r.mine_path.as_deref() == Some(&p) || r.theirs_path.as_deref() == Some(&p));
                if !known {
                    rec.files.push(RecordedFile { path: p, kind: FileKind::Text, mine_change: SideChange::Modified, theirs_change: SideChange::Modified, mine_path: None, theirs_path: None });
                }
            }
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, serde_json::to_vec(&rec).unwrap_or_default());
        let mut done: Vec<ConflictFile> = rec
            .files
            .iter()
            .filter(|r| !current.iter().any(|f| f.path == r.path))
            .map(|r| ConflictFile {
                path: r.path.clone(),
                kind: r.kind,
                mine_change: r.mine_change,
                theirs_change: r.theirs_change,
                segments: Vec::new(),
                resolved: true,
                mine_path: r.mine_path.clone(),
                theirs_path: r.theirs_path.clone(),
            })
            .collect();
        done.sort_by(|a, b| a.path.cmp(&b.path));
        done
    }

    /// The operation ended (finished or aborted): clear the conflict record
    pub(crate) fn clear_conflict_record(&self) {
        if let Ok(p) = self.conflict_record_file() {
            let _ = std::fs::remove_file(p);
        }
        if let Ok(d) = self.strand_dir() {
            let _ = std::fs::remove_file(d.join("marks.json"));
        }
    }

    /// Blame this file on both sides' commits to find the commit that introduced each change block (the newest among those lines)
    fn fill_origins(&self, f: &mut ConflictFile, mine_rev: Option<&str>, theirs_rev: Option<&str>) {
        let blame = |rev: Option<&str>| -> Option<Vec<String>> {
            let rev = rev?;
            let out = git_cli::run(self.path(), &["blame", "--porcelain", rev, "--", &f.path], None).ok()?;
            let (lines, ids) = crate::blame::parse(&out);
            Some(lines.iter().map(|l| ids[l.commit as usize].clone()).collect())
        };
        let (mb, tb) = (blame(mine_rev), blame(theirs_rev));
        if mb.is_none() && tb.is_none() {
            return;
        }
        let repo = match self.git2() {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut cache: HashMap<String, Option<Origin>> = HashMap::new();
        let mut info = |id: &str| -> Option<Origin> {
            cache
                .entry(id.to_string())
                .or_insert_with(|| {
                    let c = repo.find_commit(git2::Oid::from_str(id).ok()?).ok()?;
                    Some(Origin {
                        commit: id.to_string(),
                        author: String::from_utf8_lossy(c.author().name_bytes()).into_owned(),
                        time: c.time().seconds(),
                        title: String::from_utf8_lossy(c.summary_bytes().unwrap_or_default()).into_owned(),
                    })
                })
                .clone()
        };
        // The newest commit among a range of lines
        let mut newest = |by_line: &Option<Vec<String>>, from: usize, len: usize| -> Option<Origin> {
            let by_line = by_line.as_ref()?;
            let ids: Vec<String> = by_line.get(from..(from + len).min(by_line.len()))?.to_vec();
            ids.iter().filter_map(|id| info(id)).max_by_key(|o| o.time)
        };
        let (mut mi, mut ti) = (0usize, 0usize);
        for seg in &mut f.segments {
            match seg {
                Segment::Context { lines } => {
                    mi += lines.len();
                    ti += lines.len();
                }
                Segment::Change(c) => {
                    let mlen = c.mine.as_ref().map_or(c.base.len(), Vec::len);
                    let tlen = c.theirs.as_ref().map_or(c.base.len(), Vec::len);
                    if c.mine.as_ref().is_some_and(|v| !v.is_empty()) {
                        c.mine_origin = newest(&mb, mi, mlen);
                    }
                    if c.theirs.as_ref().is_some_and(|v| !v.is_empty()) {
                        c.theirs_origin = newest(&tb, ti, tlen);
                    }
                    mi += mlen;
                    ti += tlen;
                }
            }
        }
    }

    /// Build a text file's result from the marks, write it to the worktree and mark it resolved.
    /// Returns `UNMARKED_BLOCKS` when blocks are unmarked, with the incomplete ones in `detail.ids`.
    pub fn merge_apply_file(&self, path: &str, marks: &HashMap<String, ChangeMark>) -> Result<()> {
        let session = self.merge_session()?.ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "现在没有要解决的冲突"))?;
        let file = session
            .unresolved()
            .find(|f| f.path == path)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("{path} 没有冲突，或已经解决")))?;
        if file.kind != FileKind::Text {
            return Err(CoreError::new(ErrorCode::InvalidRange, "这个文件只能整个接受一边"));
        }
        let mut out: Vec<String> = Vec::new();
        let mut unmarked = Vec::new();
        for seg in &file.segments {
            match seg {
                Segment::Context { lines } => out.extend(lines.iter().cloned()),
                Segment::Change(c) => {
                    let m = marks.get(&c.id).cloned().unwrap_or_default();
                    if let Some(custom) = m.custom {
                        out.extend(custom);
                        continue;
                    }
                    let mine_ok = c.mine.is_none() || m.mine != Mark::None;
                    let theirs_ok = c.theirs.is_none() || m.theirs != Mark::None;
                    if !mine_ok || !theirs_ok {
                        unmarked.push(c.id.clone());
                        continue;
                    }
                    out.extend(resolve(c, &m));
                }
            }
        }
        if !unmarked.is_empty() {
            return Err(CoreError::new(
                ErrorCode::UnmarkedBlocks,
                format!("这个文件还有 {} 处修改块没有标记，不能应用", unmarked.len()),
            )
            .with_detail(serde_json::json!({ "ids": unmarked })));
        }
        let mut text = out.join("\n");
        if !out.is_empty() && ends_with_newline(self.path(), path) {
            text.push('\n');
        }
        std::fs::write(self.path().join(path), text).map_err(|e| CoreError::git("写入文件失败", e))?;
        git_cli::run(self.path(), &["add", "--", path], None)?;
        Ok(())
    }

    /// Take one side for the whole file (spec §8.7). When that side deleted the file, the result is a deletion.
    pub fn merge_take_file(&self, path: &str, side: Side) -> Result<()> {
        let session = self.merge_session()?.ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "现在没有要解决的冲突"))?;
        let file = session
            .unresolved()
            .find(|f| f.path == path)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("{path} 没有冲突，或已经解决")))?;
        // Rename conflict: keep the chosen side's new name, remove the other new name and the original
        if file.kind == FileKind::Rename {
            let (keep, other) = match side {
                Side::Mine => (&file.mine_path, &file.theirs_path),
                Side::Theirs => (&file.theirs_path, &file.mine_path),
            };
            let (Some(keep), Some(other)) = (keep, other) else {
                return Err(CoreError::new(ErrorCode::InvalidRange, "重命名冲突缺少新名字"));
            };
            git_cli::run(self.path(), &["rm", "-q", "-f", "--ignore-unmatch", "--", other], None)?;
            git_cli::run(self.path(), &["rm", "-q", "--cached", "--ignore-unmatch", "--", path], None)?;
            let _ = std::fs::remove_file(self.path().join(path));
            git_cli::run(self.path(), &["add", "--", keep], None)?;
            return Ok(());
        }
        let deleted = match side {
            Side::Mine => file.mine_change == SideChange::Deleted,
            Side::Theirs => file.theirs_change == SideChange::Deleted,
        };
        if deleted {
            git_cli::run(self.path(), &["rm", "--quiet", "--", path], None)?;
            return Ok(());
        }
        // During a rebase "yours" is git's theirs
        let git_side = match (side, session.kind == SessionKind::Rebase) {
            (Side::Mine, false) | (Side::Theirs, true) => "--ours",
            _ => "--theirs",
        };
        git_cli::run(self.path(), &["checkout", git_side, "--", path], None)?;
        git_cli::run(self.path(), &["add", "--", path], None)?;
        Ok(())
    }

    /// Finish: once every file is resolved, commit (merge, cherry-pick, revert) or continue the rebase.
    /// Returns the next session when the rebase stops at the next conflicting commit.
    pub fn merge_finish(&self) -> Result<FinishResult> {
        let session = self.merge_session()?.ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "现在没有要解决的冲突"))?;
        let open: Vec<&ConflictFile> = session.unresolved().collect();
        if !open.is_empty() {
            let blocks: usize = open
                .iter()
                .map(|f| f.segments.iter().filter(|s| matches!(s, Segment::Change(_))).count().max(1))
                .sum();
            return Err(CoreError::new(
                ErrorCode::UnmarkedBlocks,
                format!("还有 {} 个文件、{} 处修改块没有处理，不能完成", open.len(), blocks),
            )
            .with_detail(serde_json::json!({ "files": open.iter().map(|f| &f.path).collect::<Vec<_>>() })));
        }
        // No conflict markers may remain in the result (spec §8.8)
        if let Err(e) = git_cli::run(self.path(), &["diff", "--cached", "--check"], None) {
            let out = e.detail.as_ref().and_then(|d| d.get("stdout")).and_then(|s| s.as_str()).unwrap_or("").to_string();
            let hits: Vec<String> = out.lines().filter(|l| l.contains("conflict marker")).map(|l| l.split(": ").next().unwrap_or(l).to_string()).collect();
            if !hits.is_empty() {
                return Err(CoreError::new(ErrorCode::ConflictMarkers, format!("结果里还有冲突标记：{}", hits.join("、")))
                    .with_detail(serde_json::json!({ "places": hits })));
            }
        }
        let args: &[&str] = match session.kind {
            SessionKind::Unstash => {
                // Restoring has no git command to continue: finish once all conflicts are resolved, deleting the entry if needed
                self.unstash_finish()?;
                self.clear_conflict_record();
                return Ok(FinishResult { done: true, next: None });
            }
            // Squash merge: commit the result as a normal commit, not a merge (spec §6.7)
            SessionKind::Merge if self.squash_pending().is_some() => {
                self.squash_commit()?;
                self.clear_conflict_record();
                return Ok(FinishResult { done: true, next: None });
            }
            SessionKind::Merge => &["merge", "--continue"],
            SessionKind::CherryPick => &["cherry-pick", "--continue"],
            SessionKind::Revert => &["revert", "--continue"],
            SessionKind::Rebase => &["rebase", "--continue"],
        };
        self.continue_or_next(args)
    }

    /// Skip the current commit (rebase only).
    pub fn merge_skip(&self) -> Result<FinishResult> {
        if self.state()?.state != RepoMode::Rebasing {
            return Err(CoreError::new(ErrorCode::InvalidRange, "只有变基时可以跳过提交"));
        }
        self.continue_or_next(&["rebase", "--skip"])
    }

    fn continue_or_next(&self, args: &[&str]) -> Result<FinishResult> {
        let r = git_cli::run(self.path(), args, None);
        // Continuing the rebase may stop on conflicts again: git reports failure then, but that is the normal next step
        let next = self.merge_session()?;
        match (r, next) {
            (_, Some(s)) if s.unresolved().next().is_some() => Ok(FinishResult { done: false, next: Some(s) }),
            (Ok(_), None) => {
                self.clear_conflict_record();
                Ok(FinishResult { done: true, next: None })
            }
            (Ok(_), Some(s)) => Ok(FinishResult { done: false, next: Some(s) }),
            (Err(e), _) => Err(e),
        }
    }
}

/// The result for one block (spec §8.6).
fn resolve(c: &Change, m: &ChangeMark) -> Vec<String> {
    let take_m = c.mine.is_some() && m.mine == Mark::Accept;
    let take_t = c.theirs.is_some() && m.theirs == Mark::Accept;
    match (take_m, take_t) {
        (false, false) => c.base.clone(),
        (true, false) => c.mine.clone().unwrap_or_default(),
        (false, true) => c.theirs.clone().unwrap_or_default(),
        (true, true) => {
            let mut v = c.mine.clone().unwrap_or_default();
            v.extend(c.theirs.clone().unwrap_or_default());
            v
        }
    }
}

/// Three-way merge: align both sides' changes by base lines and combine overlapping or adjacent changes into one block.
fn segments(base: &[String], mine: &[String], theirs: &[String]) -> Vec<Segment> {
    // Each side's changes: the replaced range [start, end) in the base, and the replacement lines
    struct Edit<'a> {
        start: usize,
        end: usize,
        side: Side,
        lines: &'a [String],
    }
    let mut edits: Vec<Edit> = Vec::new();
    for (side, new) in [(Side::Mine, mine), (Side::Theirs, theirs)] {
        let ops = similar::capture_diff_slices(similar::Algorithm::Myers, base, new);
        for op in ops {
            if matches!(op.tag(), similar::DiffTag::Equal) {
                continue;
            }
            let (orng, nrng) = (op.old_range(), op.new_range());
            edits.push(Edit { start: orng.start, end: orng.end, side, lines: &new[nrng] });
        }
    }
    edits.sort_by_key(|e| (e.start, e.end));

    let mut out = Vec::new();
    let mut pos = 0usize;
    let mut i = 0usize;
    let mut n = 0usize;
    while i < edits.len() {
        // Combine overlapping or adjacent changes (like git, two changes right next to each other count as one)
        let start = edits[i].start;
        let mut end = edits[i].end;
        let mut j = i + 1;
        while j < edits.len() && edits[j].start <= end {
            end = end.max(edits[j].end);
            j += 1;
        }
        if start > pos {
            out.push(Segment::Context { lines: base[pos..start].to_vec() });
        }
        let group = &edits[i..j];
        // What one side changed the range [start, end) into
        let side_text = |side: Side| -> Option<Vec<String>> {
            let es: Vec<&Edit> = group.iter().filter(|e| e.side == side).collect();
            if es.is_empty() {
                return None;
            }
            let mut v = Vec::new();
            let mut p = start;
            for e in es {
                v.extend(base[p..e.start].iter().cloned());
                v.extend(e.lines.iter().cloned());
                p = e.end;
            }
            v.extend(base[p..end].iter().cloned());
            Some(v)
        };
        let (m, t) = (side_text(Side::Mine), side_text(Side::Theirs));
        if m.is_some() && m == t {
            // Both sides made the same change: not a conflict
            out.push(Segment::Context { lines: m.unwrap_or_default() });
        } else {
            n += 1;
            out.push(Segment::Change(Change { id: format!("c{n}"), base: base[start..end].to_vec(), mine: m, theirs: t, mine_origin: None, theirs_origin: None }));
        }
        pos = end;
        i = j;
    }
    if pos < base.len() {
        out.push(Segment::Context { lines: base[pos..].to_vec() });
    }
    // Merge adjacent context into one segment
    let mut merged: Vec<Segment> = Vec::new();
    for s in out {
        match (merged.last_mut(), s) {
            (Some(Segment::Context { lines: a }), Segment::Context { lines: b }) => a.extend(b),
            (_, s) => merged.push(s),
        }
    }
    merged
}

/// A conflicted file's kind and number of conflicts (for the pull summary panel, spec §7.2). `None` means that side doesn't have the file.
/// The count only makes sense for text files: places where both sides changed the same section; 0 for other kinds.
pub(crate) fn classify(path: &str, base: Option<&[u8]>, mine: Option<&[u8]>, theirs: Option<&[u8]>) -> (FileKind, u32) {
    let name = path.rsplit('/').next().unwrap_or(path);
    let kind = match (mine, theirs) {
        (None, _) | (_, None) => FileKind::ModifyDelete,
        (Some(a), Some(b)) if is_binary(a) || is_binary(b) => FileKind::Binary,
        _ if LOCK_FILES.contains(&name) => FileKind::Lock,
        _ => FileKind::Text,
    };
    if kind != FileKind::Text {
        return (kind, 0);
    }
    let n = segments(&lines_of(base.unwrap_or(&[])), &lines_of(mine.unwrap_or(&[])), &lines_of(theirs.unwrap_or(&[])))
        .iter()
        .filter(|s| matches!(s, Segment::Change(c) if c.mine.is_some() && c.theirs.is_some()))
        .count();
    (kind, n as u32)
}

fn lines_of(b: &[u8]) -> Vec<String> {
    let s = String::from_utf8_lossy(b);
    let s = s.strip_suffix('\n').unwrap_or(&s);
    if s.is_empty() && b.is_empty() {
        return Vec::new();
    }
    s.split('\n').map(str::to_string).collect()
}

fn is_binary(b: &[u8]) -> bool {
    b.iter().take(8000).any(|&c| c == 0)
}

/// Whether the result ends with a newline: follow the worktree file (with conflict markers), which usually matches both sides.
fn ends_with_newline(root: &Path, path: &str) -> bool {
    std::fs::read(root.join(path)).map(|b| b.last() == Some(&b'\n')).unwrap_or(true)
}

/// Labels for the two sides, depending on the scenario (spec §8.1).
fn sides(dir: &Path, git_dir: &Path, kind: SessionKind) -> (SideInfo, SideInfo, Option<RebaseStep>) {
    let rev = |r: &str| -> (Option<String>, Option<String>) {
        match git_cli::run(dir, &["log", "-1", "--format=%H%x00%s", r], None) {
            Ok(s) => match s.trim().split_once('\0') {
                Some((h, t)) => (Some(h.to_string()), Some(t.to_string())),
                None => (None, None),
            },
            Err(_) => (None, None),
        }
    };
    let name_of = |r: &str| -> Option<String> {
        // Use the real branch name, not a symbolic ref like origin/HEAD
        git_cli::run(dir, &["name-rev", "--name-only", "--no-undefined", "--exclude=tags/*", "--exclude=*/HEAD", r], None)
            .ok()
            .map(|s| s.trim().trim_start_matches("remotes/").to_string())
            .filter(|s| !s.is_empty() && !s.contains('~') && !s.contains('^'))
    };
    let branch = git_cli::run(dir, &["branch", "--show-current"], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let info = |label: String, r: &str| {
        let (commit, title) = rev(r);
        SideInfo { label, commit, title }
    };
    let read = |f: &str| std::fs::read_to_string(git_dir.join(f)).ok().map(|s| s.trim().to_string());
    match kind {
        SessionKind::Merge => (
            info(branch.unwrap_or_else(|| "当前分支".into()), "HEAD"),
            info(name_of("MERGE_HEAD").unwrap_or_else(|| "要合并进来的提交".into()), "MERGE_HEAD"),
            None,
        ),
        SessionKind::CherryPick => (
            info(branch.unwrap_or_else(|| "当前分支".into()), "HEAD"),
            info("要拣选的提交".into(), "CHERRY_PICK_HEAD"),
            None,
        ),
        SessionKind::Revert => (
            info(branch.unwrap_or_else(|| "当前分支".into()), "HEAD"),
            info("要还原的提交".into(), "REVERT_HEAD"),
            None,
        ),
        SessionKind::Unstash => (
            SideInfo { label: "工作区".into(), commit: None, title: None },
            SideInfo { label: "取回的改动".into(), commit: None, title: None },
            None,
        ),
        SessionKind::Rebase => {
            let head_name = read("rebase-merge/head-name").or_else(|| read("rebase-apply/head-name"));
            let onto = read("rebase-merge/onto").or_else(|| read("rebase-apply/onto")).unwrap_or_else(|| "HEAD".into());
            let onto_name = name_of(&onto).unwrap_or_else(|| "目标分支".into());
            let step = match (read("rebase-merge/msgnum"), read("rebase-merge/end")) {
                (Some(i), Some(t)) => Some(RebaseStep { index: i.parse().unwrap_or(1), total: t.parse().unwrap_or(1) }),
                _ => None,
            };
            let mine_label = head_name
                .map(|h| format!("{} 上你的提交", h.trim_start_matches("refs/heads/")))
                .unwrap_or_else(|| "你的提交".into());
            (info(mine_label, "REBASE_HEAD"), info(onto_name, "HEAD"), step)
        }
    }
}

/// Both sides renamed the same file to different names: git leaves three single-version entries (the original name has only base,
/// your new name only yours, their new name only theirs). Pair them by content similarity and combine into one "rename" conflict.
fn pair_renames(files: Vec<ConflictFile>, lone: &[(usize, char, Vec<u8>)]) -> Vec<ConflictFile> {
    let similar_enough = |a: &[u8], b: &[u8]| a == b || similar::TextDiff::from_lines(&*String::from_utf8_lossy(a), &*String::from_utf8_lossy(b)).ratio() >= 0.5;
    let mut used: Vec<usize> = Vec::new();
    let mut merged: Vec<ConflictFile> = Vec::new();
    for (bi, k, bb) in lone.iter().filter(|x| x.1 == 'b') {
        let _ = k;
        let pick = |want: char, used: &Vec<usize>| {
            lone.iter()
                .filter(|(i, c, _)| *c == want && !used.contains(i))
                .find(|(_, _, b)| similar_enough(bb, b))
                .map(|(i, _, _)| *i)
        };
        let (Some(mi), Some(ti)) = (pick('m', &used), pick('t', &used)) else { continue };
        used.extend([*bi, mi, ti]);
        merged.push(ConflictFile {
            path: files[*bi].path.clone(),
            kind: FileKind::Rename,
            mine_change: SideChange::Renamed,
            theirs_change: SideChange::Renamed,
            segments: Vec::new(),
            resolved: false,
            mine_path: Some(files[mi].path.clone()),
            theirs_path: Some(files[ti].path.clone()),
        });
    }
    files.into_iter().enumerate().filter(|(i, _)| !used.contains(i)).map(|(_, f)| f).chain(merged).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Vec<String> {
        if s.is_empty() { Vec::new() } else { s.split(',').map(str::to_string).collect() }
    }

    fn kinds(segs: &[Segment]) -> Vec<String> {
        segs.iter()
            .map(|s| match s {
                Segment::Context { lines } => format!("ctx{}", lines.len()),
                Segment::Change(c) => format!("{}{}", if c.mine.is_some() { "m" } else { "" }, if c.theirs.is_some() { "t" } else { "" }),
            })
            .collect()
    }

    #[test]
    fn splits_into_conflicts_and_one_sided_changes() {
        let base = v("a,b,c,d,e,f,g");
        let mine = v("a,B1,c,d,e,f,g2");
        let theirs = v("a,B2,c,d,E,f,g");
        let s = segments(&base, &mine, &theirs);
        // b changed on both sides (conflict); e only theirs; g only yours
        assert_eq!(kinds(&s), vec!["ctx1", "mt", "ctx2", "t", "ctx1", "m"]);
        let Segment::Change(c) = &s[1] else { panic!() };
        assert_eq!((c.base.clone(), c.mine.clone().unwrap(), c.theirs.clone().unwrap()), (v("b"), v("B1"), v("B2")));
    }

    #[test]
    fn same_change_on_both_sides_is_context() {
        let s = segments(&v("a,b,c"), &v("a,X,c"), &v("a,X,c"));
        assert_eq!(kinds(&s), vec!["ctx3"]);
    }

    #[test]
    fn adjacent_edits_form_one_conflict() {
        // You changed b and they changed the adjacent c: counts as one conflict
        let s = segments(&v("a,b,c,d"), &v("a,B,c,d"), &v("a,b,C,d"));
        assert_eq!(kinds(&s), vec!["ctx1", "mt", "ctx1"]);
        let Segment::Change(c) = &s[1] else { panic!() };
        assert_eq!((c.mine.clone().unwrap(), c.theirs.clone().unwrap()), (v("B,c"), v("b,C")));
    }

    #[test]
    fn insertions_and_resolution() {
        let s = segments(&v("a,b"), &v("a,m1,b"), &v("a,t1,b"));
        let Segment::Change(c) = &s[1] else { panic!("{:?}", kinds(&s)) };
        assert!(c.base.is_empty());
        let mk = |m, t| ChangeMark { mine: m, theirs: t, custom: None };
        assert_eq!(resolve(c, &mk(Mark::Accept, Mark::Accept)), v("m1,t1"));
        assert_eq!(resolve(c, &mk(Mark::Discard, Mark::Accept)), v("t1"));
        assert_eq!(resolve(c, &mk(Mark::Discard, Mark::Discard)), Vec::<String>::new());
    }

    /// Every row of the result table in spec §8.6 (the two unmarked rows are rejected by `merge_apply_file`, see tests/conflict.rs)
    #[test]
    fn result_table_rows() {
        let s = segments(&v("a,b,c,d,e"), &v("a,M,c,d,e2"), &v("a,T,c,d,e"));
        let Segment::Change(both) = &s[1] else { panic!("{:?}", kinds(&s)) };
        let Segment::Change(one) = &s[3] else { panic!("{:?}", kinds(&s)) };
        assert!(one.theirs.is_none(), "e 只有你改：无冲突修改");
        let mk = |m, t| ChangeMark { mine: m, theirs: t, custom: None };
        use Mark::{Accept as A, Discard as D, None as N};
        assert_eq!(resolve(both, &mk(A, D)), v("M"), "接受/舍弃 → 你的");
        assert_eq!(resolve(both, &mk(D, A)), v("T"), "舍弃/接受 → 对方的");
        assert_eq!(resolve(both, &mk(A, A)), v("M,T"), "都接受 → 先你的再对方的");
        assert_eq!(resolve(both, &mk(D, D)), v("b"), "都舍弃 → 原始内容");
        assert_eq!(resolve(one, &mk(A, N)), v("e2"), "无冲突修改：接受");
        assert_eq!(resolve(one, &mk(D, N)), v("e"), "无冲突修改：舍弃");
    }
}
