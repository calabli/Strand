//! Op log, undo and redo (spec §11).
//!
//! Each write operation takes a snapshot before and after: positions of HEAD, local branches and tags, the tree for the index, and the tree for tracked worktree files.
//! The log stores only refs that differ; trees are written into the Git object database, and each entry leaves a commit under `refs/strand/ops/<id>`
//! (its tree holds the four snapshot trees, its parents are the commits before and after), so undone commits and deleted branches aren't garbage-collected.
//!
//! Undo = restore `before`, redo = restore `after`. Before restoring, the repository's current state is checked:
//! - HEAD and the refs this step changed must still be where the step left them, otherwise the repository was changed elsewhere and `STATE_DIVERGED` is returned;
//! - files are checked by path: only files this step changed are touched, so later edits to other files are kept; `STATE_DIVERGED` when the same file changed again.
//!
//! The log is stored in `.git/strand/oplog.json`, keeping the latest 200 entries and 30 days. The redo list is in memory only and cleared on restart.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::RepoMode;
use crate::repo::Session;

const MAX_ENTRIES: usize = 200;
const MAX_AGE_SECS: i64 = 30 * 86_400;
const KEEP_PREFIX: &str = "refs/strand/ops/";

/// Operation category. Pushes only appear on the timeline and can't be undone.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    Commit,
    Branch,
    Switch,
    Merge,
    Checkout,
    Tag,
    Pull,
    Push,
    Stash,
    Shelf,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
pub enum HeadRef {
    /// Full ref name, e.g. `refs/heads/main`; also this when the branch has no commits yet
    Branch(String),
    Detached(String),
}

/// What the repository looks like at one moment
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    pub head: HeadRef,
    /// Local branches and tags: full ref name → object hash
    pub refs: BTreeMap<String, String>,
    /// The tree for the index; none for bare repositories
    pub index: Option<String>,
    /// The tree for tracked worktree files; none for bare repositories
    pub worktree: Option<String>,
    /// The stash list (newest first)
    #[serde(default)]
    pub stash: Vec<StashRef>,
    /// Shelf entries not deleted
    #[serde(default)]
    pub shelf: Vec<u64>,
    /// The state of specific files (tracked or not); only captured by [`Session::run_op_scoped`]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<FilesSnap>,
    /// Linked worktrees; only captured by [`Session::run_op_scoped`]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktrees: Option<Vec<WorktreeSnap>>,
    /// The state while stopped in a conflict (see [`Session::merge_abort_logged`]): a tree holding the index file under `.git`,
    /// the merge and rebase state files, Strand's own conflict record, the frontend's marks, and the step not yet written to the log (`pending.json`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
}

/// Extra files recorded in a snapshot: `paths` are the recorded paths, `tree` only holds those that existed then
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FilesSnap {
    pub paths: Vec<String>,
    pub tree: String,
}

/// A linked worktree: the branch checked out, or the commit when detached
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeSnap {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached: Option<String>,
}

/// Things to record beyond a normal snapshot. Snapshots only cover tracked files; untracked files and worktrees must be declared by the operation:
/// - `files`: paths involved in adding to version control, adding to ignore rules, deleting untracked files;
/// - `worktrees`: creating and removing worktrees.
#[derive(Debug, Clone, Default)]
pub struct OpScope {
    pub files: Vec<String>,
    pub worktrees: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StashRef {
    pub id: String,
    pub message: String,
}

/// One side as stored in the log: only the refs this step changed
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Side {
    head: HeadRef,
    /// Where the refs changed by this step are on this side; `None` means it doesn't exist
    refs: BTreeMap<String, Option<String>>,
    index: Option<String>,
    worktree: Option<String>,
    /// When this step changed the stash list, the full list on this side
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stash: Option<Vec<StashRef>>,
    /// When this step changed the shelf, the entries on this side that aren't deleted
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shelf: Option<Vec<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    files: Option<FilesSnap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktrees: Option<Vec<WorktreeSnap>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conflict: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    id: u64,
    label: String,
    kind: OpKind,
    time: i64,
    before: Side,
    after: Side,
    undoable: bool,
    /// Undone (waiting for redo)
    #[serde(default)]
    undone: bool,
    /// Why it can't be undone
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// When a merge or pull stops on conflicts, record the snapshot from before it started and write one log entry only after the whole conflict resolution finishes
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pending {
    label: String,
    kind: OpKind,
    before: Snapshot,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    next_id: u64,
    entries: Vec<Entry>,
    #[serde(default)]
    pending: Option<Pending>,
}

/// One log entry as the frontend sees it
#[derive(Debug, Clone, Serialize)]
pub struct OpInfo {
    pub id: u64,
    pub label: String,
    pub kind: OpKind,
    pub time: i64,
    pub undoable: bool,
    pub undone: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpList {
    /// Newest first
    pub entries: Vec<OpInfo>,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// In-memory op log state, attached to `Session`
#[derive(Default)]
pub struct OpLog {
    file: Option<File>,
    /// The redo list: each item is the entries touched by one undo (undoing several steps at once is one item), in undo order
    redo: Vec<Vec<u64>>,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn git_err(msg: &str) -> impl Fn(git2::Error) -> CoreError + '_ {
    move |e| CoreError::git(msg, e)
}

fn info(e: &Entry) -> OpInfo {
    OpInfo { id: e.id, label: e.label.clone(), kind: e.kind, time: e.time, undoable: e.undoable, undone: e.undone, reason: e.reason.clone() }
}

impl Session {
    fn oplog_dir(&self) -> Result<PathBuf> {
        Ok(self.git2()?.path().join("strand"))
    }

    fn oplog_file(&mut self) -> Result<&mut File> {
        if self.oplog.file.is_none() {
            let path = self.oplog_dir()?.join("oplog.json");
            let mut f: File = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            // The redo list isn't kept across restarts
            f.entries.retain(|e| !e.undone);
            self.oplog.file = Some(f);
        }
        Ok(self.oplog.file.as_mut().expect("刚读过"))
    }

    fn oplog_save(&mut self) -> Result<()> {
        let dir = self.oplog_dir()?;
        let f = self.oplog_file()?;
        let data = serde_json::to_vec_pretty(f).map_err(|e| CoreError::git("保存操作日志失败", e))?;
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::git("保存操作日志失败", e))?;
        let tmp = dir.join("oplog.json.tmp");
        std::fs::write(&tmp, data).map_err(|e| CoreError::git("保存操作日志失败", e))?;
        std::fs::rename(&tmp, dir.join("oplog.json")).map_err(|e| CoreError::git("保存操作日志失败", e))
    }

    /// A snapshot of the repository now. Tree objects are written to the object database.
    pub fn snapshot(&self) -> Result<Snapshot> {
        let repo = self.git2()?;
        let trees = if repo.is_bare() { (None, None) } else { snapshot_trees(repo.path(), self.path(), &self.oplog_dir()?, None) };
        self.snapshot_with(trees)
    }

    /// The cheap parts of a snapshot (HEAD, refs, stashes, shelf), paired with the computed index and worktree trees
    fn snapshot_with(&self, (index, worktree): (Option<String>, Option<String>)) -> Result<Snapshot> {
        let repo = self.git2()?;
        let head = match repo.find_reference("HEAD").map_err(git_err("读取 HEAD 失败"))?.symbolic_target().ok().flatten() {
            Some(t) => HeadRef::Branch(t.to_string()),
            None => HeadRef::Detached(repo.refname_to_id("HEAD").map_err(git_err("读取 HEAD 失败"))?.to_string()),
        };
        let mut refs = BTreeMap::new();
        for r in repo.references().map_err(git_err("读取引用失败"))?.flatten() {
            let (Ok(name), Some(id)) = (r.name(), r.target()) else { continue };
            if name.starts_with("refs/heads/") || name.starts_with("refs/tags/") {
                refs.insert(name.to_string(), id.to_string());
            }
        }
        let stash = self.stash_list()?.into_iter().map(|e| StashRef { id: e.id, message: e.message }).collect();
        Ok(Snapshot { head, refs, index, worktree, stash, shelf: self.shelf_visible(), files: None, worktrees: None, conflict: None })
    }

    /// A normal snapshot plus the files and worktrees `scope` asks to record
    fn snapshot_scoped(&self, scope: &OpScope) -> Result<Snapshot> {
        let mut s = self.snapshot()?;
        if !scope.files.is_empty() {
            s.files = Some(self.capture_files(&scope.files)?);
        }
        if scope.worktrees {
            s.worktrees = Some(self.capture_worktrees()?);
        }
        Ok(s)
    }

    fn capture_files(&self, paths: &[String]) -> Result<FilesSnap> {
        let repo = self.git2()?;
        let mut idx = git2::Index::new().map_err(git_err("拍快照失败"))?;
        for p in paths {
            let full = self.path().join(p);
            let Ok(meta) = std::fs::symlink_metadata(&full) else { continue };
            let (data, mode) = if meta.file_type().is_symlink() {
                (std::fs::read_link(&full).map(|t| t.to_string_lossy().into_owned().into_bytes()).unwrap_or_default(), 0o120000)
            } else if meta.is_file() {
                #[cfg(unix)]
                let exec = std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o111 != 0;
                #[cfg(not(unix))]
                let exec = false;
                (std::fs::read(&full).map_err(|e| CoreError::git("拍快照失败", e))?, if exec { 0o100755 } else { 0o100644 })
            } else {
                continue;
            };
            let id = repo.blob(&data).map_err(git_err("拍快照失败"))?;
            idx.add(&index_entry(p, id, mode)).map_err(git_err("拍快照失败"))?;
        }
        let tree = idx.write_tree_to(&repo).map_err(git_err("拍快照失败"))?;
        Ok(FilesSnap { paths: paths.to_vec(), tree: tree.to_string() })
    }

    fn capture_worktrees(&self) -> Result<Vec<WorktreeSnap>> {
        let mut list: Vec<WorktreeSnap> = self
            .worktree_list()?
            .into_iter()
            .filter(|w| !w.is_main && !w.prunable)
            .map(|w| WorktreeSnap { detached: w.branch.is_none().then(|| w.head.clone()), path: w.path, branch: w.branch })
            .collect();
        list.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(list)
    }

    /// Run a write operation recorded in the log. When the operation fails but the repository is stopped mid merge or rebase (conflicts), record the snapshot from before it started
    /// and write one entry after conflict resolution finishes ([`Session::op_finish_pending`]).
    pub fn run_op<T>(&mut self, label: &str, kind: OpKind, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<(T, Option<OpInfo>)> {
        let before = self.snapshot()?;
        crate::console::note(label);
        let r = f(self);
        let op = self.op_end(label, kind, before);
        let t = r?;
        Ok((t, op?))
    }

    /// Same as [`Session::run_op`], also recording untracked files and worktrees per `scope` so those can be undone too
    pub fn run_op_scoped<T>(&mut self, label: &str, kind: OpKind, scope: &OpScope, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<(T, Option<OpInfo>)> {
        let before = self.snapshot_scoped(scope)?;
        crate::console::note(label);
        let r = f(self);
        let op = self.op_end_scoped(label, kind, before, scope);
        let t = r?;
        Ok((t, op?))
    }

    /// Same as [`Session::run_op`], then re-read the log (the UI needs to refresh). The after snapshot and the re-read run at the same time,
    /// saving one of their durations (spec §15). The log is re-read whether or not the operation succeeds.
    pub fn run_op_reload<T>(&mut self, label: &str, kind: OpKind, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<(T, Option<OpInfo>)> {
        let before = self.snapshot()?;
        crate::console::note(label);
        let r = f(self);
        let op = self.op_end_reload(label, kind, before);
        let t = r?;
        Ok((t, op?))
    }

    fn op_end_reload(&mut self, label: &str, kind: OpKind, before: Snapshot) -> Result<Option<OpInfo>> {
        if self.state()?.state != RepoMode::Normal {
            let op = self.op_end(label, kind, before);
            self.reload()?;
            return op;
        }
        if self.oplog_file()?.pending.take().is_some() {
            self.oplog_save()?;
        }
        let repo = self.git2()?;
        let trees = if repo.is_bare() {
            self.reload()?;
            (None, None)
        } else {
            let (git_dir, workdir, scratch) = (repo.path().to_path_buf(), self.path().to_path_buf(), self.oplog_dir()?);
            // The after snapshot and the worktree status the UI needs next (both from the same git status, so all files aren't scanned twice),
            // done alongside re-reading the log
            let ((trees, status), reloaded) = std::thread::scope(|sc| {
                let h = sc.spawn(|| {
                    let pre = crate::worktree::porcelain(&workdir);
                    let trees = snapshot_trees(&git_dir, &workdir, &scratch, pre.as_deref());
                    (trees, crate::worktree::status_at(&workdir, pre.as_deref()).ok())
                });
                let reloaded = self.reload();
                (h.join().unwrap_or(((None, None), None)), reloaded)
            });
            reloaded?;
            if let (Some(st), Ok(mut c)) = (status, self.status_cache.lock()) {
                *c = Some((std::time::Instant::now(), st));
            }
            trees
        };
        let after = self.snapshot_with(trees)?;
        if after == before {
            return Ok(None);
        }
        self.op_push(label, kind, before, after, true).map(Some)
    }

    /// A write operation ended: compare with the before snapshot and write an entry if anything changed
    pub fn op_end(&mut self, label: &str, kind: OpKind, before: Snapshot) -> Result<Option<OpInfo>> {
        self.op_end_scoped(label, kind, before, &OpScope::default())
    }

    fn op_end_scoped(&mut self, label: &str, kind: OpKind, before: Snapshot, scope: &OpScope) -> Result<Option<OpInfo>> {
        if self.state()?.state != RepoMode::Normal {
            self.oplog_file()?.pending = Some(Pending { label: label.to_string(), kind, before });
            self.oplog_save()?;
            return Ok(None);
        }
        // A merge that stopped on conflicts and was later aborted elsewhere: its recorded before snapshot is no longer useful
        if self.oplog_file()?.pending.take().is_some() {
            self.oplog_save()?;
        }
        let after = self.snapshot_scoped(scope)?;
        if after == before {
            return Ok(None);
        }
        self.op_push(label, kind, before, after, true).map(Some)
    }

    /// Push: only shown on the timeline
    pub fn op_note(&mut self, label: &str, kind: OpKind) -> Result<OpInfo> {
        crate::console::note(label);
        let s = self.snapshot()?;
        self.op_push(label, kind, s.clone(), s, false)
    }

    /// Conflict resolution finished: write the whole merge or pull as one entry
    pub fn op_finish_pending(&mut self) -> Result<Option<OpInfo>> {
        if self.state()?.state != RepoMode::Normal {
            return Ok(None);
        }
        let Some(p) = self.oplog_file()?.pending.take() else { return Ok(None) };
        let after = self.snapshot()?;
        if after == p.before {
            self.oplog_save()?;
            return Ok(None);
        }
        self.op_push(&p.label, p.kind, p.before, after, true).map(Some)
    }

    /// The merge or rebase was aborted: the repository is back to before it started; no entry
    pub fn op_drop_pending(&mut self) -> Result<()> {
        if self.state()?.state == RepoMode::Normal && self.oplog_file()?.pending.take().is_some() {
            self.oplog_save()?;
        }
        Ok(())
    }

    /// Abort a merge, rebase, cherry-pick, revert, restore or pull, writing it as one undoable entry (spec §8.9):
    /// before aborting, save the conflict state (see [`Snapshot::conflict`]); undoing this step returns to the conflicts and marks before the abort.
    /// `marks` are the frontend's marks (stored as is and returned as is through [`crate::conflict::MergeSession::saved_marks`]).
    /// Changes auto-shelved before a pull are restored as usual; returns the restore notice and this entry.
    pub fn merge_abort_logged(&mut self, label: &str, marks: Option<serde_json::Value>) -> Result<(Option<String>, Option<OpInfo>)> {
        if self.state()?.state == RepoMode::Normal {
            self.merge_abort()?;
            return Ok((None, None));
        }
        let mut before = self.snapshot()?;
        let pending = self.oplog_file()?.pending.clone();
        before.conflict = Some(self.capture_conflict(pending.as_ref(), marks.as_ref())?.to_string());
        crate::console::note(label);
        self.merge_abort()?;
        let note = self.pull_unshelve()?;
        if self.oplog_file()?.pending.take().is_some() {
            self.oplog_save()?;
        }
        let after = self.snapshot()?;
        Ok((note, Some(self.op_push(label, OpKind::Merge, before, after, true)?)))
    }

    /// Write the conflict state as a tree: state files under `.git` at their original paths (`git/…`), plus `marks.json` and `pending.json`
    fn capture_conflict(&self, pending: Option<&Pending>, marks: Option<&serde_json::Value>) -> Result<git2::Oid> {
        let repo = self.git2()?;
        let git_dir = repo.path().to_path_buf();
        let mut files: Vec<(String, Vec<u8>)> = Vec::new();
        for name in CONFLICT_FILES {
            let full = git_dir.join(name);
            if full.is_dir() {
                for f in walk(&full) {
                    let rel = f.strip_prefix(&git_dir).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                    if let Ok(b) = std::fs::read(&f) {
                        files.push((format!("git/{rel}"), b));
                    }
                }
            } else if let Ok(b) = std::fs::read(&full) {
                files.push((format!("git/{name}"), b));
            }
        }
        if let Some(m) = marks {
            files.push(("marks.json".into(), serde_json::to_vec(m).unwrap_or_default()));
        }
        if let Some(p) = pending {
            files.push(("pending.json".into(), serde_json::to_vec(p).unwrap_or_default()));
        }
        write_tree(&repo, &files)
    }

    fn op_push(&mut self, label: &str, kind: OpKind, before: Snapshot, after: Snapshot, undoable: bool) -> Result<OpInfo> {
        let keys: BTreeSet<&String> = before.refs.keys().chain(after.refs.keys()).collect();
        let changed: Vec<String> = keys.into_iter().filter(|k| before.refs.get(*k) != after.refs.get(*k)).cloned().collect();
        let stash_changed = before.stash != after.stash;
        let shelf_changed = before.shelf != after.shelf;
        let side = |s: &Snapshot| Side {
            head: s.head.clone(),
            refs: changed.iter().map(|k| (k.clone(), s.refs.get(k).cloned())).collect(),
            index: s.index.clone(),
            worktree: s.worktree.clone(),
            stash: stash_changed.then(|| s.stash.clone()),
            shelf: shelf_changed.then(|| s.shelf.clone()),
            files: s.files.clone(),
            worktrees: s.worktrees.clone(),
            conflict: s.conflict.clone(),
        };
        let (b, a) = (side(&before), side(&after));
        // A new write operation clears the redo list
        self.oplog.redo.clear();
        let dropped: Vec<u64> = self.oplog_file()?.entries.iter().filter(|e| e.undone).map(|e| e.id).collect();
        let f = self.oplog_file()?;
        f.entries.retain(|e| !e.undone);
        f.next_id += 1;
        let id = f.next_id;
        let entry = Entry { id, label: label.to_string(), kind, time: now(), before: b, after: a, undoable, undone: false, reason: None };
        let op = info(&entry);
        let keep = self.keep(&entry);
        let f = self.oplog_file()?;
        f.entries.push(entry);
        // Prune old entries
        let cutoff = now() - MAX_AGE_SECS;
        let mut pruned = dropped;
        while f.entries.len() > MAX_ENTRIES || f.entries.first().is_some_and(|e| e.time < cutoff) {
            pruned.push(f.entries.remove(0).id);
        }
        let repo = self.git2()?;
        for id in pruned {
            if let Ok(mut r) = repo.find_reference(&format!("{KEEP_PREFIX}{id}")) {
                let _ = r.delete();
            }
        }
        keep?;
        self.oplog_save()?;
        Ok(op)
    }

    /// Keep a ref so objects used by the snapshot aren't garbage-collected
    fn keep(&self, e: &Entry) -> Result<()> {
        let repo = self.git2()?;
        let mut tb = repo.treebuilder(None).map_err(git_err("保存快照失败"))?;
        let files = |s: &Side| s.files.as_ref().map(|f| f.tree.clone());
        let (bf, af) = (files(&e.before), files(&e.after));
        for (name, t) in [
            ("before-index", &e.before.index),
            ("before-worktree", &e.before.worktree),
            ("after-index", &e.after.index),
            ("after-worktree", &e.after.worktree),
            ("before-files", &bf),
            ("after-files", &af),
            ("before-conflict", &e.before.conflict),
            ("after-conflict", &e.after.conflict),
        ] {
            if let Some(t) = t.as_deref().and_then(|t| git2::Oid::from_str(t).ok()) {
                tb.insert(name, t, 0o040000).map_err(git_err("保存快照失败"))?;
            }
        }
        let tree = repo.find_tree(tb.write().map_err(git_err("保存快照失败"))?).map_err(git_err("保存快照失败"))?;
        let mut parents: Vec<git2::Commit> = Vec::new();
        let mut seen = BTreeSet::new();
        let ids = [&e.before, &e.after].into_iter().flat_map(|s| {
            let head = match &s.head {
                HeadRef::Detached(id) => Some(id.clone()),
                HeadRef::Branch(_) => None,
            };
            let stashes: Vec<String> = s.stash.iter().flatten().map(|x| x.id.clone()).collect();
            // Also keep the commits named by state files in the conflict state (MERGE_HEAD, the rebase's onto, etc.)
            let mentioned = s.conflict.as_deref().map(|t| conflict_commits(&repo, t)).unwrap_or_default();
            s.refs.values().flatten().cloned().chain(head).chain(stashes).chain(mentioned)
        });
        for id in ids {
            let Ok(oid) = git2::Oid::from_str(&id) else { continue };
            let Ok(c) = repo.find_object(oid, None).and_then(|o| o.peel_to_commit()) else { continue };
            if seen.insert(c.id()) {
                parents.push(c);
            }
        }
        let sig = git2::Signature::now("Strand", "strand@localhost").map_err(git_err("保存快照失败"))?;
        let refs: Vec<&git2::Commit> = parents.iter().collect();
        let c = repo
            .commit(None, &sig, &sig, &format!("strand op {}: {}", e.id, e.label), &tree, &refs)
            .map_err(git_err("保存快照失败"))?;
        repo.reference(&format!("{KEEP_PREFIX}{}", e.id), c, true, "strand: keep op snapshot").map_err(git_err("保存快照失败"))?;
        Ok(())
    }

    /// Recent entries (newest first)
    pub fn oplog_list(&mut self, limit: usize) -> Result<OpList> {
        let can_redo = !self.oplog.redo.is_empty();
        // The repository changed elsewhere after the latest step (committed or switched branches on the command line, changed files it changed):
        // this step and earlier ones show as not undoable. Display only, not written to the log; it recovers if the external change is reverted.
        let top = self.oplog_file()?.entries.iter().rev().find(|e| !e.undone && e.kind != OpKind::Push && e.undoable).cloned();
        let stale = top.as_ref().and_then(|e| self.changed_elsewhere(e).map(|why| (e.id, why)));
        let f = self.oplog_file()?;
        let entries: Vec<OpInfo> = f
            .entries
            .iter()
            .rev()
            .take(limit)
            .map(|e| {
                let mut i = info(e);
                if let Some((id, why)) = &stale
                    && e.id <= *id
                    && !e.undone
                    && e.kind != OpKind::Push
                    && i.undoable
                {
                    i.undoable = false;
                    i.reason = Some(why.clone());
                }
                i
            })
            .collect();
        let can_undo = stale.is_none() && f.entries.iter().rev().filter(|e| !e.undone && e.kind != OpKind::Push).take(1).any(|e| e.undoable);
        Ok(OpList { entries, can_undo, can_redo })
    }

    /// Whether anything this step changed was changed elsewhere afterwards. Only looks at the HEAD, refs, index entries, files,
    /// stashes and shelf this step changed, without a full snapshot (called on every timeline refresh). Returns the reason when it was.
    fn changed_elsewhere(&self, e: &Entry) -> Option<String> {
        let repo = self.git2().ok()?;
        let a = &e.after;
        let head = match repo.find_reference("HEAD").ok()?.symbolic_target().ok().flatten() {
            Some(t) => HeadRef::Branch(t.to_string()),
            None => HeadRef::Detached(repo.refname_to_id("HEAD").ok()?.to_string()),
        };
        if head != a.head {
            return Some("HEAD 在别处被修改过".into());
        }
        for (name, want) in &a.refs {
            let now = repo.refname_to_id(name).ok().map(|o| o.to_string());
            if now != *want {
                let short = name.trim_start_matches("refs/heads/").trim_start_matches("refs/tags/");
                return Some(format!("{short} 在别处被修改过"));
            }
        }
        if a.stash.as_ref().is_some_and(|want| {
            let now: Vec<StashRef> = self.stash_list().map(|l| l.into_iter().map(|x| StashRef { id: x.id, message: x.message }).collect()).unwrap_or_default();
            *want != now
        }) {
            return Some("贮藏列表在别处被修改过".into());
        }
        if a.shelf.as_ref().is_some_and(|want| *want != self.shelf_visible()) {
            return Some("暂存架在别处被修改过".into());
        }
        if repo.is_bare() {
            return None;
        }
        // Before aborting a merge the index has conflicts and no matching tree, so no per-entry check here (the full check on undo compares the whole index)
        let index = if e.before.conflict.is_some() { FileSet::new() } else { changes(&repo, &e.before.index, &a.index) };
        if !index.is_empty() {
            let mut idx = repo.index().ok()?;
            idx.read(false).ok()?;
            for (p, want) in &index {
                let now = idx.get_path(Path::new(p), 0).map(|x| (x.id, x.mode));
                if now != *want {
                    return Some(format!("{p} 在别处被修改过"));
                }
            }
        }
        let root = self.path();
        for (p, want) in changes(&repo, &e.before.worktree, &a.worktree) {
            let full = root.join(&p);
            let now = std::fs::read(&full).ok().and_then(|b| git2::Oid::hash_object(git2::ObjectType::Blob, &b).ok());
            // Content only; symlinks and file modes are left to the full check on undo
            let same = match want {
                Some((id, mode)) if mode != 0o120000 => now == Some(id),
                Some(_) => true,
                None => !full.exists(),
            };
            if !same {
                return Some(format!("{p} 在别处被修改过"));
            }
        }
        None
    }

    /// Undo. With `to` empty undo the latest step, otherwise undo up to and including this entry.
    /// When crossing already-pushed steps, returns `ALREADY_PUSHED` while `confirm_pushed` is false; the frontend confirms and calls again.
    pub fn oplog_undo(&mut self, to: Option<u64>, confirm_pushed: bool) -> Result<Vec<OpInfo>> {
        if self.state()?.state != RepoMode::Normal {
            return Err(CoreError::new(ErrorCode::MergeInProgress, "合并或变基还没完成，先完成或中止"));
        }
        let f = self.oplog_file()?;
        let live: Vec<&Entry> = f.entries.iter().rev().filter(|e| !e.undone).collect();
        let steps: Vec<u64> = match to {
            None => live.iter().find(|e| e.kind != OpKind::Push).map(|e| vec![e.id]).unwrap_or_default(),
            Some(to) => {
                if !live.iter().any(|e| e.id == to) {
                    return Err(CoreError::new(ErrorCode::NotFound, "这一步已经不在时间线里"));
                }
                live.iter().take_while(|e| e.id >= to).filter(|e| e.kind != OpKind::Push).map(|e| e.id).collect()
            }
        };
        // After undoing "abort merge" the repository is back in conflict, and earlier steps can only be undone after this merge finishes or is aborted again: stop at this entry
        let steps: Vec<u64> = match steps.iter().position(|id| live.iter().any(|e| e.id == *id && e.before.conflict.is_some())) {
            Some(i) => steps[..=i].to_vec(),
            None => steps,
        };
        let Some(&last) = steps.last() else {
            return Err(CoreError::new(ErrorCode::NotFound, "没有可以撤销的操作"));
        };
        if let Some(bad) = live.iter().find(|e| e.id >= last && e.kind != OpKind::Push && !e.undoable) {
            return Err(CoreError::new(ErrorCode::StateDiverged, format!("“{}”不能撤销", bad.label))
                .with_detail(serde_json::json!({ "reason": bad.reason })));
        }
        if !confirm_pushed && let Some(p) = live.iter().find(|e| e.id > last && e.kind == OpKind::Push) {
            return Err(CoreError::new(ErrorCode::AlreadyPushed, "这一步已经推送，撤销后需要强制推送才能让远程一致")
                .with_detail(serde_json::json!({ "push": p.label })));
        }
        let mut done = Vec::new();
        for id in steps {
            match self.restore(id, true) {
                Ok(op) => done.push(op),
                Err(e) => {
                    self.finish_undo(&done)?;
                    return Err(e);
                }
            }
        }
        self.finish_undo(&done)?;
        Ok(done)
    }

    fn finish_undo(&mut self, done: &[OpInfo]) -> Result<()> {
        // After undoing "abort merge" the repository is back in conflict and can't redo; to abort again, press abort again in conflict resolution
        let back_in_conflict = self.oplog.file.as_ref().is_some_and(|f| f.entries.iter().any(|e| done.iter().any(|o| o.id == e.id) && e.before.conflict.is_some()));
        if !done.is_empty() && !back_in_conflict {
            self.oplog.redo.push(done.iter().map(|o| o.id).collect());
        }
        self.oplog_save()
    }

    /// Redo the latest undo (several steps undone at once are restored together)
    pub fn oplog_redo(&mut self) -> Result<Vec<OpInfo>> {
        if self.state()?.state != RepoMode::Normal {
            return Err(CoreError::new(ErrorCode::MergeInProgress, "合并或变基还没完成，先完成或中止"));
        }
        let Some(group) = self.oplog.redo.pop() else {
            return Err(CoreError::new(ErrorCode::NotFound, "没有可以重做的操作"));
        };
        let mut done = Vec::new();
        for (i, id) in group.iter().rev().enumerate() {
            match self.restore(*id, false) {
                Ok(op) => done.push(op),
                Err(e) => {
                    // Steps not redone stay in the redo list
                    let rest: Vec<u64> = group[..group.len() - i].to_vec();
                    self.oplog.redo.push(rest);
                    self.oplog_save()?;
                    return Err(e);
                }
            }
        }
        self.oplog_save()?;
        Ok(done)
    }

    /// Undo one entry (restore before) or redo it (restore after)
    fn restore(&mut self, id: u64, undo: bool) -> Result<OpInfo> {
        let e = self.oplog_file()?.entries.iter().find(|e| e.id == id).cloned().ok_or_else(|| CoreError::new(ErrorCode::NotFound, "这一步已经不在时间线里"))?;
        crate::console::note(&format!("{}：{}", if undo { "撤销" } else { "重做" }, e.label));
        let (from, to) = if undo { (&e.after, &e.before) } else { (&e.before, &e.after) };
        if from.conflict.is_some() {
            return Err(CoreError::new(ErrorCode::NotFound, "回到冲突中的那一步不能重做，可以在冲突解决里再中止一次"));
        }
        let scope = OpScope { files: to.files.as_ref().map(|f| f.paths.clone()).unwrap_or_default(), worktrees: to.worktrees.is_some() };
        let cur = self.snapshot_scoped(&scope)?;
        let repo = self.git2()?;
        let checked = check(&repo, from, to, &cur).and_then(|mut plan| {
            // Back to the conflict state: replace the whole index with the index file from then (including all conflict versions) rather than restoring entry by entry;
            // but the index must still be as it was after the abort
            if to.conflict.is_some() {
                plan.index.clear();
                if cur.index != from.index {
                    return Err(vec!["索引".to_string()]);
                }
            }
            // A worktree to be removed must not have uncommitted changes
            let dirty: Vec<String> = plan
                .remove_worktrees
                .iter()
                .filter(|w| crate::git_cli::run(Path::new(&w.path), &["status", "--porcelain"], None).map(|o| !o.trim().is_empty()).unwrap_or(false))
                .map(|w| w.path.clone())
                .collect();
            if dirty.is_empty() { Ok(plan) } else { Err(dirty) }
        });
        let plan = match checked {
            Ok(p) => p,
            Err(files) => {
                if undo {
                    // This entry and earlier ones can no longer be undone automatically
                    let why = "仓库在别处被修改过".to_string();
                    for x in self.oplog_file()?.entries.iter_mut().filter(|x| x.id <= id) {
                        x.undoable = false;
                        x.reason = Some(why.clone());
                    }
                    self.oplog_save()?;
                }
                let msg = if undo { format!("仓库在别处被修改过，“{}”不能自动撤销", e.label) } else { format!("仓库在别处被修改过，“{}”不能自动重做", e.label) };
                return Err(CoreError::new(ErrorCode::StateDiverged, msg)
                    .with_detail(serde_json::json!({ "files": files })));
            }
        };
        for w in &plan.remove_worktrees {
            crate::git_cli::run(self.path(), &["worktree", "remove", &w.path], None)?;
        }
        apply(&repo, to, &plan, self.path())?;
        for w in &plan.add_worktrees {
            match (&w.branch, &w.detached) {
                (Some(b), _) => crate::git_cli::run(self.path(), &["worktree", "add", &w.path, b], None)?,
                (None, Some(c)) => crate::git_cli::run(self.path(), &["worktree", "add", "--detach", &w.path, c], None)?,
                (None, None) => continue,
            };
        }
        if let Some(list) = &to.stash {
            rebuild_stash(self.path(), list)?;
        }
        if let Some(ids) = &to.shelf {
            self.shelf_set_visible(ids)?;
        }
        if let Some(t) = &to.conflict {
            let pending = restore_conflict(&repo, t)?;
            self.oplog_file()?.pending = pending;
        }
        let f = self.oplog_file()?;
        let x = f.entries.iter_mut().find(|x| x.id == id).expect("刚找到");
        x.undone = undo;
        Ok(info(x))
    }
}

/// What to save from the conflict state (relative paths under `.git`; directories are saved whole)
const CONFLICT_FILES: &[&str] = &[
    "index",
    "MERGE_HEAD",
    "MERGE_MSG",
    "MERGE_MODE",
    "AUTO_MERGE",
    "ORIG_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "SQUASH_MSG",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "strand/conflicts.json",
    "strand/squash",
    "strand/pull-shelf",
    "strand/unstash.json",
];

/// All files in a directory
fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out.sort();
    out
}

/// Write (path, content) pairs as a tree
fn write_tree(repo: &git2::Repository, files: &[(String, Vec<u8>)]) -> Result<git2::Oid> {
    let mut dirs: BTreeMap<&str, Vec<(String, Vec<u8>)>> = BTreeMap::new();
    let mut tb = repo.treebuilder(None).map_err(git_err("保存冲突现场失败"))?;
    for (path, data) in files {
        match path.split_once('/') {
            Some((d, rest)) => dirs.entry(d).or_default().push((rest.to_string(), data.clone())),
            None => {
                let id = repo.blob(data).map_err(git_err("保存冲突现场失败"))?;
                tb.insert(path, id, 0o100644).map_err(git_err("保存冲突现场失败"))?;
            }
        }
    }
    for (d, list) in dirs {
        let id = write_tree(repo, &list)?;
        tb.insert(d, id, 0o040000).map_err(git_err("保存冲突现场失败"))?;
    }
    tb.write().map_err(git_err("保存冲突现场失败"))
}

/// All files in a tree: (path, content)
fn read_tree(repo: &git2::Repository, tree: &git2::Tree, prefix: &str, out: &mut Vec<(String, Vec<u8>)>) {
    for e in tree.iter() {
        let name = format!("{prefix}{}", e.name().unwrap_or_default());
        match e.kind() {
            Some(git2::ObjectType::Tree) => {
                if let Ok(t) = repo.find_tree(e.id()) {
                    read_tree(repo, &t, &format!("{name}/"), out);
                }
            }
            _ => {
                if let Ok(b) = repo.find_blob(e.id()) {
                    out.push((name, b.content().to_vec()));
                }
            }
        }
    }
}

/// Write back the conflict state: state files go back into `.git`, marks are written to `.git/strand/marks.json`; returns the step that hadn't been written to the log then
fn restore_conflict(repo: &git2::Repository, tree: &str) -> Result<Option<Pending>> {
    let t = git2::Oid::from_str(tree).and_then(|o| repo.find_tree(o)).map_err(git_err("读取冲突现场失败"))?;
    let mut files = Vec::new();
    read_tree(repo, &t, "", &mut files);
    let git_dir = repo.path();
    let mut pending = None;
    for (path, data) in files {
        let target = match path.as_str() {
            "pending.json" => {
                pending = serde_json::from_slice(&data).ok();
                continue;
            }
            "marks.json" => git_dir.join("strand/marks.json"),
            p => match p.strip_prefix("git/") {
                Some(rel) => git_dir.join(rel),
                None => continue,
            },
        };
        if let Some(d) = target.parent() {
            std::fs::create_dir_all(d).map_err(|e| CoreError::git("恢复冲突现场失败", e))?;
        }
        std::fs::write(&target, data).map_err(|e| CoreError::git("恢复冲突现场失败", e))?;
    }
    Ok(pending)
}

/// Commits named in the conflict state's state files (40-character hashes)
fn conflict_commits(repo: &git2::Repository, tree: &str) -> Vec<String> {
    let Ok(t) = git2::Oid::from_str(tree).and_then(|o| repo.find_tree(o)) else { return Vec::new() };
    let mut files = Vec::new();
    read_tree(repo, &t, "", &mut files);
    let mut out = Vec::new();
    for (path, data) in files {
        if !path.starts_with("git/") || path == "git/index" || data.len() > 64 * 1024 {
            continue;
        }
        let text = String::from_utf8_lossy(&data);
        for w in text.split(|c: char| !c.is_ascii_hexdigit()) {
            if w.len() == 40 {
                out.push(w.to_string());
            }
        }
    }
    out
}

/// The tree for tracked worktree files: copy the index, refresh it from worktree content and write it as a tree (the real index is untouched)
/// The expensive parts of a snapshot: the index tree and the worktree tree. They're independent, so they're computed on two threads (spec §15: writes finish within 500 ms on large repositories)
fn snapshot_trees(git_dir: &Path, workdir: &Path, scratch: &Path, pre: Option<&str>) -> (Option<String>, Option<String>) {
    std::thread::scope(|sc| {
        let wt = sc.spawn(|| worktree_tree(git_dir, workdir, scratch, pre).ok());
        let index = git2::Repository::open(git_dir)
            .ok()
            .and_then(|r| r.index().ok().and_then(|mut i| i.write_tree_to(&r).ok()));
        (index.map(|t| t.to_string()), wt.join().ok().flatten().map(|t| t.to_string()))
    })
}

/// The state of tracked worktree files, stored as a tree: start from the index and swap in worktree files that differ from it.
///
/// First use system `git status` (multi-threaded) to find tracked files that differ from the index: usually none or only a few,
/// which are added to a copy of the index; no need to check every file like libgit2's `update_all` does
/// (about 150 ms for 50k files). Falls back to `update_all` with unresolved conflicts or when `git status` fails.
/// `pre` is `git status --porcelain=v2` output already run (runs it if absent).
fn worktree_tree(git_dir: &Path, workdir: &Path, scratch: &Path, pre: Option<&str>) -> Result<git2::Oid> {
    std::fs::create_dir_all(scratch).map_err(|e| CoreError::git("拍快照失败", e))?;
    let tmp = scratch.join("snapshot-index");
    let src = git_dir.join("index");
    if src.exists() {
        std::fs::copy(&src, &tmp).map_err(|e| CoreError::git("拍快照失败", e))?;
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
    let handle = git2::Repository::open(git_dir).map_err(git_err("拍快照失败"))?;
    let mut idx = git2::Index::open(&tmp).map_err(git_err("拍快照失败"))?;
    handle.set_index(&mut idx).map_err(git_err("拍快照失败"))?;
    let mut idx = handle.index().map_err(git_err("拍快照失败"))?;
    let changed = match pre {
        Some(out) => worktree_changes(out),
        None => crate::git_cli::run(workdir, &["status", "--porcelain=v2", "-z", "--untracked-files=no", "--no-renames", "--ignore-submodules=all"], None)
            .ok()
            .and_then(|out| worktree_changes(&out)),
    };
    match changed {
        Some(list) => {
            for (path, deleted) in list {
                let p = Path::new(&path);
                if deleted {
                    idx.remove_path(p).map_err(git_err("拍快照失败"))?;
                } else {
                    idx.add_path(p).map_err(git_err("拍快照失败"))?;
                }
            }
        }
        None => idx.update_all(["*"].iter(), None).map_err(git_err("拍快照失败"))?,
    }
    let t = idx.write_tree_to(&handle).map_err(git_err("拍快照失败"));
    let _ = std::fs::remove_file(&tmp);
    t
}

/// From `git status --porcelain=v2 -z`, take tracked files where the worktree differs from the index: (path, deleted in worktree).
/// Returns `None` when there are unresolved conflicts (u entries), leaving it to `update_all`.
fn worktree_changes(out: &str) -> Option<Vec<(String, bool)>> {
    let mut list = Vec::new();
    for e in out.split('\0').filter(|e| !e.is_empty()) {
        match e.as_bytes()[0] {
            b'1' => {
                let mut f = e.splitn(9, ' ');
                let xy = f.nth(1)?;
                // Submodules (sub field starts with S) are left alone in snapshots, as update_all does
                if f.next()?.starts_with('S') {
                    continue;
                }
                let path = f.nth(5)?;
                match xy.as_bytes().get(1) {
                    Some(b'.') | None => {}
                    Some(b'D') => list.push((path.to_string(), true)),
                    Some(_) => list.push((path.to_string(), false)),
                }
            }
            b'u' => return None,
            _ => {}
        }
    }
    Some(list)
}

/// Files to restore: path → (blob, file mode) in the target, `None` means delete
type FileSet = BTreeMap<String, Option<(git2::Oid, u32)>>;

struct Plan {
    index: FileSet,
    worktree: FileSet,
    /// Extra recorded files (see [`OpScope`])
    files: FileSet,
    remove_worktrees: Vec<WorktreeSnap>,
    add_worktrees: Vec<WorktreeSnap>,
}

/// (blob, file mode) of a path in a tree
fn entry_in(tree: Option<&git2::Tree>, path: &str) -> Option<(git2::Oid, u32)> {
    let e = tree?.get_path(Path::new(path)).ok()?;
    Some((e.id(), e.filemode() as u32))
}

fn index_entry(path: &str, id: git2::Oid, mode: u32) -> git2::IndexEntry {
    git2::IndexEntry {
        ctime: git2::IndexTime::new(0, 0),
        mtime: git2::IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: 0,
        id,
        flags: (path.len().min(0xfff)) as u16,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}

fn tree_of<'r>(repo: &'r git2::Repository, id: &Option<String>) -> Option<git2::Tree<'r>> {
    id.as_deref().and_then(|s| git2::Oid::from_str(s).ok()).and_then(|o| repo.find_tree(o).ok())
}

/// Files that differ between two trees, and how they look in `b`
fn changes(repo: &git2::Repository, a: &Option<String>, b: &Option<String>) -> FileSet {
    let mut out = FileSet::new();
    let (ta, tb) = (tree_of(repo, a), tree_of(repo, b));
    if a == b {
        return out;
    }
    let Ok(diff) = repo.diff_tree_to_tree(ta.as_ref(), tb.as_ref(), None) else { return out };
    for d in diff.deltas() {
        let new = d.new_file();
        let old = d.old_file();
        if let Some(p) = old.path() {
            out.entry(p.to_string_lossy().replace('\\', "/")).or_insert(None);
        }
        if let Some(p) = new.path()
            && d.status() != git2::Delta::Deleted
        {
            out.insert(p.to_string_lossy().replace('\\', "/"), Some((new.id(), u32::from(new.mode()))));
        }
    }
    out
}

/// Check whether the repository as it is now can be restored from `from` to `to`; returns conflicting refs and files when it can't
fn check(repo: &git2::Repository, from: &Side, to: &Side, cur: &Snapshot) -> std::result::Result<Plan, Vec<String>> {
    let mut bad = Vec::new();
    if cur.head != from.head {
        bad.push("HEAD".to_string());
    }
    for (k, v) in &from.refs {
        if cur.refs.get(k) != v.as_ref() {
            bad.push(k.clone());
        }
    }
    if from.stash.as_ref().is_some_and(|s| *s != cur.stash) {
        bad.push("贮藏列表".to_string());
    }
    if from.shelf.as_ref().is_some_and(|s| *s != cur.shelf) {
        bad.push("暂存架".to_string());
    }
    let index = changes(repo, &from.index, &to.index);
    let mut worktree = changes(repo, &from.worktree, &to.worktree);
    // Extra recorded files: their current state must equal from; they decide what these paths become, the tracked-file trees aren't consulted
    let mut files = FileSet::new();
    if let (Some(ff), Some(tf)) = (&from.files, &to.files) {
        let tree = |t: &str| git2::Oid::from_str(t).ok().and_then(|o| repo.find_tree(o).ok());
        let (ft, tt) = (tree(&ff.tree), tree(&tf.tree));
        let ct = cur.files.as_ref().and_then(|c| tree(&c.tree));
        for p in &tf.paths {
            worktree.remove(p);
            let (f, t) = (entry_in(ft.as_ref(), p), entry_in(tt.as_ref(), p));
            if entry_in(ct.as_ref(), p) != f {
                bad.push(p.clone());
            }
            if f != t {
                files.insert(p.clone(), t);
            }
        }
    }
    let (mut remove_worktrees, mut add_worktrees) = (Vec::new(), Vec::new());
    if let (Some(fw), Some(tw)) = (&from.worktrees, &to.worktrees) {
        if cur.worktrees.as_ref() != Some(fw) {
            bad.push("工作目录".to_string());
        }
        remove_worktrees = fw.iter().filter(|w| !tw.contains(w)).cloned().collect();
        add_worktrees = tw.iter().filter(|w| !fw.contains(w)).cloned().collect();
    }
    let user_index = changes(repo, &from.index, &cur.index);
    let user_wt = changes(repo, &from.worktree, &cur.worktree);
    for p in index.keys().filter(|p| user_index.contains_key(*p)) {
        bad.push(p.clone());
    }
    for p in worktree.keys().filter(|p| user_wt.contains_key(*p)) {
        bad.push(p.clone());
    }
    // A file to be written is currently untracked (not tracked on either side) with different content; overwriting would lose data
    if let Some(root) = repo.workdir() {
        let tracked_now = tree_of(repo, &cur.worktree);
        for (p, target) in &worktree {
            let Some((blob, _)) = target else { continue };
            let on_disk = root.join(p);
            let tracked = tracked_now.as_ref().is_some_and(|t| t.get_path(Path::new(p)).is_ok());
            if !tracked && on_disk.is_file() {
                let same = std::fs::read(&on_disk).ok().and_then(|b| git2::Oid::hash_object(git2::ObjectType::Blob, &b).ok()) == Some(*blob);
                if !same {
                    bad.push(p.clone());
                }
            }
        }
    }
    bad.sort();
    bad.dedup();
    if bad.is_empty() { Ok(Plan { index, worktree, files, remove_worktrees, add_worktrees }) } else { Err(bad) }
}

/// Restore: refs, HEAD, index, worktree
fn apply(repo: &git2::Repository, to: &Side, plan: &Plan, root: &Path) -> Result<()> {
    let msg = "strand: undo/redo";
    // Refs: delete first, then create, so parent/child names like a and a/b don't block each other
    for (k, v) in &to.refs {
        if v.is_none()
            && let Ok(mut r) = repo.find_reference(k)
        {
            r.delete().map_err(git_err("恢复引用失败"))?;
        }
    }
    for (k, v) in &to.refs {
        if let Some(v) = v {
            let oid = git2::Oid::from_str(v).map_err(git_err("恢复引用失败"))?;
            repo.reference(k, oid, true, msg).map_err(git_err("恢复引用失败"))?;
        }
    }
    match &to.head {
        HeadRef::Branch(name) => repo.reference_symbolic("HEAD", name, true, msg).map(|_| ()),
        HeadRef::Detached(id) => git2::Oid::from_str(id).and_then(|o| repo.set_head_detached(o)),
    }
    .map_err(git_err("恢复 HEAD 失败"))?;
    if repo.is_bare() {
        return Ok(());
    }
    if !plan.index.is_empty() {
        let mut idx = repo.index().map_err(git_err("恢复索引失败"))?;
        for (p, v) in &plan.index {
            match v {
                Some((id, mode)) => idx.add(&index_entry(p, *id, *mode)).map_err(git_err("恢复索引失败"))?,
                None => {
                    let _ = idx.remove_path(Path::new(p));
                }
            }
        }
        idx.write().map_err(git_err("恢复索引失败"))?;
    }
    write_set(repo, root, &plan.worktree)?;
    write_set(repo, root, &plan.files)
}

/// Write these worktree files as they are in the target (`None` deletes)
fn write_set(repo: &git2::Repository, root: &Path, set: &FileSet) -> Result<()> {
    for (p, v) in set {
        let full = root.join(p);
        match v {
            Some((id, mode)) => {
                let blob = repo.find_blob(*id).map_err(git_err("恢复文件失败"))?;
                if let Some(dir) = full.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| CoreError::git("恢复文件失败", e))?;
                }
                let _ = std::fs::remove_file(&full);
                write_file(&full, blob.content(), *mode)?;
            }
            None => {
                if full.is_file() || full.is_symlink() {
                    std::fs::remove_file(&full).map_err(|e| CoreError::git("恢复文件失败", e))?;
                }
                // Remove parent directories that became empty as a result
                let mut dir = full.parent();
                while let Some(d) = dir {
                    if d == root || std::fs::remove_dir(d).is_err() {
                        break;
                    }
                    dir = d.parent();
                }
            }
        }
    }
    Ok(())
}

/// Restore the stash list to `list` (newest first): clear it, then push back from oldest to newest, keeping messages
fn rebuild_stash(root: &Path, list: &[StashRef]) -> Result<()> {
    crate::git_cli::run(root, &["stash", "clear"], None)?;
    for s in list.iter().rev() {
        crate::git_cli::run(root, &["stash", "store", "--message", &s.message, &s.id], None)?;
    }
    Ok(())
}

fn write_file(path: &Path, data: &[u8], mode: u32) -> Result<()> {
    #[cfg(unix)]
    if mode == 0o120000 {
        let target = String::from_utf8_lossy(data).into_owned();
        return std::os::unix::fs::symlink(target, path).map_err(|e| CoreError::git("恢复文件失败", e));
    }
    std::fs::write(path, data).map_err(|e| CoreError::git("恢复文件失败", e))?;
    #[cfg(unix)]
    if mode == 0o100755 {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
    Ok(())
}
