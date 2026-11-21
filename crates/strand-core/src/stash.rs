//! Stash and shelf (spec §4.9).
//!
//! - Stash: Git's native stash, putting away all tracked changes at once; also visible with `git stash list` on the command line.
//! - Shelf: patches saved by the client itself, shelved per file and nameable. Patches live in `.git/strand/shelf/<id>.patch`,
//!   the list in `.git/strand/shelf/index.json`. Deleting and restoring only mark the entry deleted; files are actually removed after 30 days,
//!   so undo (spec §11) can bring entries back.
//!
//! When restoring conflicts with the worktree, the repository enters "restore in progress" (`RepoMode::Unstashing`) and the conflict resolution flow (§8) takes over;
//! "yours" is the worktree and "theirs" is the restored changes. `.git/strand/unstash.json` records what is being restored;
//! the stash entry (pop) or shelf entry is only deleted on finish; on abort `git reset --merge` goes back to before the restore and the entry stays.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::model::FileStatus;
use crate::repo::Session;

const SHELF_KEEP_SECS: i64 = 30 * 86_400;

#[derive(Debug, Clone, Serialize)]
pub struct StashEntry {
    /// `stash@{index}`
    pub index: usize,
    pub id: String,
    pub message: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShelfFile {
    pub path: String,
    pub status: FileStatus,
    /// Was an untracked file when shelved: restored as untracked again
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub untracked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShelfEntry {
    pub id: u64,
    pub name: String,
    pub time: i64,
    pub files: Vec<ShelfFile>,
    /// The commit HEAD was on when shelved
    #[serde(default)]
    pub base: String,
    /// When it was deleted or restored; hidden from the list, and the patch file is deleted after expiry
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<i64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ShelfIndex {
    next_id: u64,
    entries: Vec<ShelfEntry>,
}

/// Restoring produced conflicts: record what was restored, delete the entry on finish
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Unstash {
    pub source: UnstashSource,
    /// The stash's commit hash, or the shelf entry's id
    pub id: String,
    /// Name shown on the "theirs" side
    pub label: String,
    /// Delete the entry after finishing (restore and delete)
    pub drop: bool,
    /// When restoring only some files of a shelf entry, the entry the remaining files were saved as; deleted when the restore is aborted (the original entry still exists)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remainder: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnstashSource {
    Stash,
    Shelf,
    /// Applying a patch to the worktree hit conflicts (no entry to delete on finish)
    Patch,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn io(msg: &str) -> impl Fn(std::io::Error) -> CoreError + '_ {
    move |e| CoreError::git(msg, e)
}

impl Session {
    pub(crate) fn strand_dir(&self) -> Result<PathBuf> {
        Ok(self.git2()?.path().join("strand"))
    }

    // ---------- Stash ----------

    pub fn stash_list(&self) -> Result<Vec<StashEntry>> {
        let mut repo = self.git2()?;
        let mut raw = Vec::new();
        repo.stash_foreach(|i, msg, id| {
            raw.push((i, id.to_string(), msg.to_string()));
            true
        })
        .map_err(|e| CoreError::git("读取贮藏失败", e))?;
        Ok(raw
            .into_iter()
            .map(|(index, id, message)| {
                let time = git2::Oid::from_str(&id).ok().and_then(|o| repo.find_commit(o).ok()).map(|c| c.time().seconds()).unwrap_or(0);
                StashEntry { index, id, message, time }
            })
            .collect())
    }

    /// Files changed in a stash (relative to HEAD at stash time)
    pub fn stash_files(&self, index: usize) -> Result<Vec<crate::model::FileChange>> {
        let e = self.stash_at(index)?;
        let mut files = self.commit_files(&e.id)?;
        // Stashed with -u: untracked files live in the third parent, shown as added
        if let Some(u) = crate::history::stash_untracked(&self.git2()?, &e.id) {
            files.extend(self.commit_files(&u)?);
        }
        Ok(files)
    }

    /// Untracked files kept in a stash (made with -u); empty otherwise
    pub fn stash_untracked_files(&self, index: usize) -> Result<Vec<String>> {
        let e = self.stash_at(index)?;
        match crate::history::stash_untracked(&self.git2()?, &e.id) {
            Some(u) => Ok(self.commit_files(&u)?.into_iter().map(|f| f.path).collect()),
            None => Ok(Vec::new()),
        }
    }

    /// Create a branch at the commit a stash was made on, switch to it and bring the stash back there
    /// (`git stash branch`); the stash entry is dropped when that succeeds. Useful when the stash no longer applies
    /// cleanly to the current branch.
    pub fn stash_branch(&self, index: usize, name: &str) -> Result<()> {
        self.require_clean_state()?;
        self.check_branch_name(name)?;
        self.stash_at(index)?;
        git_cli::run(self.path(), &["stash", "branch", name.trim(), &format!("stash@{{{index}}}")], None).map(|_| ())
    }

    fn stash_at(&self, index: usize) -> Result<StashEntry> {
        self.stash_list()?
            .into_iter()
            .find(|e| e.index == index)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "这条贮藏已经不在了，列表可能已经变化"))
    }

    /// Stash all tracked changes; with `include_untracked`, untracked files too (git stash -u; ignored files stay)
    pub fn stash_push(&self, message: Option<&str>, include_untracked: bool) -> Result<()> {
        let before = self.stash_list()?.first().map(|e| e.id.clone());
        let mut args = vec!["stash", "push", "--quiet"];
        if include_untracked {
            args.push("--include-untracked");
        }
        if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
            args.extend(["--message", m]);
        }
        git_cli::run(self.path(), &args, None)?;
        if self.stash_list()?.first().map(|e| e.id.clone()) == before {
            return Err(CoreError::new(ErrorCode::NothingSelected, "没有可以贮藏的改动"));
        }
        Ok(())
    }

    /// Restore a stash. With `drop` true delete it after restoring (pop), otherwise keep it (apply).
    /// On conflicts with the worktree enters "restore in progress" and returns `CONFLICTS`; deleted only after conflict resolution finishes.
    pub fn stash_apply(&self, index: usize, drop: bool) -> Result<()> {
        self.require_clean_state()?;
        let e = self.stash_at(index)?;
        let r = git_cli::run(self.path(), &["stash", "apply", &e.id], None);
        match r {
            Ok(_) => {
                if drop {
                    self.drop_stash_id(&e.id)?;
                }
                Ok(())
            }
            Err(err) => {
                if self.index_has_conflicts() {
                    self.set_unstash(&Unstash { source: UnstashSource::Stash, id: e.id.clone(), label: e.message.clone(), drop, remainder: None })?;
                    return Err(CoreError::new(ErrorCode::Conflicts, "取回的改动和工作区有冲突，请逐个处理"));
                }
                Err(overwrite_error(err))
            }
        }
    }

    pub fn stash_drop(&self, index: usize) -> Result<()> {
        let e = self.stash_at(index)?;
        self.drop_stash_id(&e.id)
    }

    /// Drop a stash by commit hash (its index may have changed)
    fn drop_stash_id(&self, id: &str) -> Result<()> {
        let e = self.stash_list()?.into_iter().find(|e| e.id == id);
        match e {
            Some(e) => git_cli::run(self.path(), &["stash", "drop", "--quiet", &format!("stash@{{{}}}", e.index)], None).map(|_| ()),
            None => Ok(()),
        }
    }

    // ---------- Shelf ----------

    fn shelf_dir(&self) -> Result<PathBuf> {
        Ok(self.strand_dir()?.join("shelf"))
    }

    fn shelf_read(&self) -> Result<ShelfIndex> {
        let p = self.shelf_dir()?.join("index.json");
        Ok(std::fs::read(p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default())
    }

    fn shelf_write(&self, idx: &ShelfIndex) -> Result<()> {
        let dir = self.shelf_dir()?;
        std::fs::create_dir_all(&dir).map_err(io("保存暂存架失败"))?;
        let data = serde_json::to_vec_pretty(idx).map_err(|e| CoreError::git("保存暂存架失败", e))?;
        let tmp = dir.join("index.json.tmp");
        std::fs::write(&tmp, data).map_err(io("保存暂存架失败"))?;
        std::fs::rename(&tmp, dir.join("index.json")).map_err(io("保存暂存架失败"))
    }

    /// Shelf entries, newest first (deleted ones hidden; expired ones cleaned up along the way)
    pub fn shelf_list(&self) -> Result<Vec<ShelfEntry>> {
        let mut idx = self.shelf_read()?;
        let cutoff = now() - SHELF_KEEP_SECS;
        let dir = self.shelf_dir()?;
        let before = idx.entries.len();
        idx.entries.retain(|e| {
            let expired = e.deleted.is_some_and(|t| t < cutoff);
            if expired {
                let _ = std::fs::remove_file(dir.join(format!("{}.patch", e.id)));
            }
            !expired
        });
        if idx.entries.len() != before {
            self.shelf_write(&idx)?;
        }
        Ok(idx.entries.into_iter().rev().filter(|e| e.deleted.is_none()).collect())
    }

    /// Ids of shelf entries not deleted (for op log snapshots)
    pub(crate) fn shelf_visible(&self) -> Vec<u64> {
        self.shelf_read().map(|i| i.entries.iter().filter(|e| e.deleted.is_none()).map(|e| e.id).collect()).unwrap_or_default()
    }

    /// Restore the shelf's visible entries on undo or redo
    pub(crate) fn shelf_set_visible(&self, ids: &[u64]) -> Result<()> {
        let mut idx = self.shelf_read()?;
        for e in &mut idx.entries {
            let show = ids.contains(&e.id);
            if show {
                e.deleted = None;
            } else if e.deleted.is_none() {
                e.deleted = Some(now());
            }
        }
        self.shelf_write(&idx)
    }

    /// Shelve the changes of the selected files and reset those files in the worktree to HEAD. `paths` includes old paths of renames.
    pub fn shelf_save(&self, name: &str, paths: &[String]) -> Result<ShelfEntry> {
        self.require_clean_state()?;
        if paths.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "至少勾选一个文件"));
        }
        let status = self.status()?;
        let mut files: Vec<ShelfFile> = status
            .changes
            .iter()
            .filter(|c| paths.contains(&c.path))
            .map(|c| ShelfFile { path: c.path.clone(), status: c.status, untracked: false })
            .collect();
        // Untracked files among the paths are shelved as added files
        let untracked: Vec<String> = status.untracked.iter().filter(|p| paths.contains(p)).cloned().collect();
        files.extend(untracked.iter().map(|p| ShelfFile { path: p.clone(), status: FileStatus::A, untracked: true }));
        if files.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "选中的文件没有改动"));
        }
        let patch = self.shelf_patch_text(paths, &untracked)?;
        if patch.trim().is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "选中的文件没有改动"));
        }
        let mut idx = self.shelf_read()?;
        idx.next_id += 1;
        let id = idx.next_id;
        let dir = self.shelf_dir()?;
        std::fs::create_dir_all(&dir).map_err(io("保存暂存架失败"))?;
        // Write the patch before changing the worktree: if it can't be written, change nothing (spec §15: data safety)
        std::fs::write(dir.join(format!("{id}.patch")), patch.as_bytes()).map_err(io("保存暂存架失败"))?;
        let name = if name.trim().is_empty() { format!("改动 · {id}") } else { name.trim().to_string() };
        let base = self.git2()?.head().ok().and_then(|h| h.target()).map(|o| o.to_string()).unwrap_or_default();
        let entry = ShelfEntry { id, name, time: now(), files, base, deleted: None };
        idx.entries.push(entry.clone());
        self.shelf_write(&idx)?;
        let tracked: Vec<&str> = paths.iter().filter(|p| !untracked.contains(p)).map(String::as_str).collect();
        if !tracked.is_empty() {
            let mut restore: Vec<&str> = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
            restore.extend(tracked);
            git_cli::run(self.path(), &restore, None)?;
        }
        // Shelved untracked files leave the worktree (they're in the patch now)
        for p in &untracked {
            let full = self.path().join(p);
            std::fs::remove_file(&full).map_err(io("搁置未跟踪的文件失败"))?;
            remove_empty_parents(self.path(), &full);
        }
        Ok(entry)
    }

    /// The patch for shelving: `git diff HEAD` of the paths; untracked ones are marked "intent to add" in a temporary
    /// copy of the index so they appear as new files (the real index is untouched)
    fn shelf_patch_text(&self, paths: &[String], untracked: &[String]) -> Result<String> {
        let mut args: Vec<&str> = vec!["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--"];
        args.extend(paths.iter().map(String::as_str));
        if untracked.is_empty() {
            return git_cli::run(self.path(), &args, None);
        }
        let git_dir = self.git2()?.path().to_path_buf();
        let tmp = git_dir.join("strand").join("shelf-index");
        std::fs::create_dir_all(git_dir.join("strand")).map_err(io("保存暂存架失败"))?;
        let real = git_dir.join("index");
        if real.exists() {
            std::fs::copy(&real, &tmp).map_err(io("保存暂存架失败"))?;
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
        let idx = tmp.to_string_lossy().to_string();
        let env = [("GIT_INDEX_FILE", idx.as_str())];
        let mut add: Vec<&str> = vec!["add", "--intent-to-add", "--"];
        add.extend(untracked.iter().map(String::as_str));
        let r = git_cli::run_env(self.path(), &add, None, &env).and_then(|_| git_cli::run_env(self.path(), &args, None, &env));
        let _ = std::fs::remove_file(&tmp);
        r
    }

    /// Restore a shelf entry to the worktree and delete the entry. On conflicts with the worktree enters "restore in progress" and returns `CONFLICTS`.
    pub fn shelf_restore(&self, id: u64) -> Result<()> {
        self.require_clean_state()?;
        let entry = self.shelf_entry(id)?;
        let patch = self.shelf_dir()?.join(format!("{id}.patch"));
        let p = patch.to_string_lossy().to_string();
        refresh_index(self.path());
        match git_cli::run(self.path(), &["apply", "--3way", "--binary", &p], None) {
            Ok(_) => {
                self.unstage_restored_untracked(&entry, None);
                self.shelf_mark_deleted(id)
            }
            Err(err) => {
                if self.index_has_conflicts() {
                    self.set_unstash(&Unstash { source: UnstashSource::Shelf, id: id.to_string(), label: entry.name, drop: true, remainder: None })?;
                    return Err(CoreError::new(ErrorCode::Conflicts, "取回的改动和工作区有冲突，请逐个处理"));
                }
                Err(overwrite_error(err))
            }
        }
    }

    /// Restore only some files of a shelf entry (spec §4.9). `paths` are file paths in the entry (new paths for renames).
    /// The original entry is marked deleted and the remaining files are saved as a new same-named entry in its place; undo brings back the whole original.
    /// Same as `shelf_restore` when all files are checked. Conflicts with the worktree also enter "restore in progress".
    pub fn shelf_restore_files(&self, id: u64, paths: &[String]) -> Result<()> {
        self.require_clean_state()?;
        if paths.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "至少勾选一个文件"));
        }
        let entry = self.shelf_entry(id)?;
        let patch = self.shelf_patch(id)?;
        let sections = split_patch(&patch)?;
        let (take, keep): (Vec<_>, Vec<_>) = sections.into_iter().partition(|(names, _)| names.iter().any(|n| paths.contains(n)));
        if take.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "勾选的文件不在这个条目里"));
        }
        if keep.is_empty() {
            return self.shelf_restore(id);
        }
        let dir = self.shelf_dir()?;
        // Save the rest as a new entry first: if it can't be written, change nothing
        let rest_id = self.shelf_add_rest(&entry, &keep)?;

        let part = dir.join(format!("{id}.part.patch"));
        let taken: Vec<u8> = take.iter().flat_map(|(_, b)| b.iter().copied()).collect();
        std::fs::write(&part, &taken).map_err(io("取回失败"))?;
        let p = part.to_string_lossy().to_string();
        refresh_index(self.path());
        let r = git_cli::run(self.path(), &["apply", "--3way", "--binary", &p], None);
        let _ = std::fs::remove_file(&part);
        match r {
            Ok(_) => {
                self.unstage_restored_untracked(&entry, Some(paths));
                self.shelf_mark_deleted(id)
            }
            Err(err) => {
                if self.index_has_conflicts() {
                    self.set_unstash(&Unstash { source: UnstashSource::Shelf, id: id.to_string(), label: entry.name, drop: true, remainder: Some(rest_id) })?;
                    return Err(CoreError::new(ErrorCode::Conflicts, "取回的改动和工作区有冲突，请逐个处理"));
                }
                // Nothing was restored: remove the entry just saved, leaving the original
                self.shelf_mark_deleted(rest_id)?;
                Err(overwrite_error(err))
            }
        }
    }

    /// Save the patches of the `keep` files as a new same-named entry after the original and return its id
    fn shelf_add_rest(&self, entry: &ShelfEntry, keep: &[(Vec<String>, Vec<u8>)]) -> Result<u64> {
        let mut idx = self.shelf_read()?;
        idx.next_id += 1;
        let rest_id = idx.next_id;
        let rest: Vec<u8> = keep.iter().flat_map(|(_, b)| b.iter().copied()).collect();
        std::fs::write(self.shelf_dir()?.join(format!("{rest_id}.patch")), &rest).map_err(io("保存暂存架失败"))?;
        let kept: Vec<&String> = keep.iter().flat_map(|(n, _)| n.iter()).collect();
        let files = entry.files.iter().filter(|f| kept.contains(&&f.path)).cloned().collect();
        let rest_entry = ShelfEntry { id: rest_id, name: entry.name.clone(), time: entry.time, files, base: entry.base.clone(), deleted: None };
        let pos = idx.entries.iter().position(|e| e.id == entry.id).map(|i| i + 1).unwrap_or(idx.entries.len());
        idx.entries.insert(pos, rest_entry);
        self.shelf_write(&idx)?;
        Ok(rest_id)
    }

    // ---------- Auto-shelve before pull (spec §7.2) ----------

    /// Before pulling, shelve changes to tracked worktree files ("auto-shelve before pull") and record the entry id.
    /// Does nothing and returns `None` when there are no changes. Untracked files are left alone.
    pub fn pull_shelve(&self) -> Result<Option<ShelfEntry>> {
        let st = self.status()?;
        if st.changes.is_empty() {
            return Ok(None);
        }
        let mut paths: Vec<String> = Vec::new();
        for c in &st.changes {
            paths.push(c.path.clone());
            if let Some(o) = &c.old_path {
                paths.push(o.clone());
            }
        }
        crate::console::note(&format!("拉取前把 {} 个文件的改动搁置到暂存架", st.changes.len()));
        let e = self.shelf_save("拉取前自动搁置", &paths)?;
        std::fs::write(self.strand_dir()?.join("pull-shelf"), e.id.to_string()).map_err(io("保存暂存架失败"))?;
        Ok(Some(e))
    }

    /// After the pull ends (finished directly, or conflict resolution finished or aborted), restore the auto-shelved changes. Does nothing while still mid merge or rebase.
    /// Returns `Ok(None)` on success; when restoring conflicts or would overwrite files, go back to before restoring, leave the changes on the shelf, and return an explanation for the user.
    pub fn pull_unshelve(&self) -> Result<Option<String>> {
        let marker = self.strand_dir()?.join("pull-shelf");
        let Ok(text) = std::fs::read_to_string(&marker) else { return Ok(None) };
        if self.state()?.state != crate::model::RepoMode::Normal {
            return Ok(None);
        }
        let _ = std::fs::remove_file(&marker);
        let Ok(id) = text.trim().parse::<u64>() else { return Ok(None) };
        let Ok(entry) = self.shelf_entry(id) else { return Ok(None) };
        crate::console::note("放回拉取前搁置的改动");
        let e = match self.shelf_restore(id) {
            Ok(()) => return Ok(None),
            Err(e) => e,
        };
        if self.state()?.state == crate::model::RepoMode::Unstashing {
            self.unstash_abort()?;
        }
        // Can't restore it all: restore file by file, leaving those that can't (conflicts or would overwrite files) on the shelf
        let (taken, kept) = self.unshelve_each(id)?;
        let why = if e.code == ErrorCode::Conflicts { "和拉取下来的内容有冲突" } else { "会覆盖拉取下来的文件" };
        if taken == 0 {
            return Ok(Some(format!("放回拉取前的改动时{why}，改动留在暂存架“{}”里，可以稍后手动取回", entry.name)));
        }
        Ok(Some(format!("拉取前的改动放回了 {taken} 个文件；{kept} 个文件{why}，留在暂存架“{}”里，可以稍后手动取回", entry.name)))
    }

    /// Restore the files of a shelf entry one by one: restore what can be, reset conflicting ones to HEAD and leave them on the shelf.
    /// Delete the entry when all were restored; when some were, delete the original and save the rest as a new same-named entry (undo brings back the whole original).
    /// Returns (files restored, files left). Only called when the repository is normal and tracked files have no changes (right after a pull).
    fn unshelve_each(&self, id: u64) -> Result<(usize, usize)> {
        let entry = self.shelf_entry(id)?;
        let sections = split_patch(&self.shelf_patch(id)?)?;
        let part = self.shelf_dir()?.join(format!("{id}.part.patch"));
        let p = part.to_string_lossy().to_string();
        let (mut take, mut keep) = (0usize, Vec::new());
        for (names, bytes) in sections {
            std::fs::write(&part, &bytes).map_err(io("放回失败"))?;
            refresh_index(self.path());
            match git_cli::run(self.path(), &["apply", "--3way", "--binary", &p], None) {
                Ok(_) => take += 1,
                Err(_) => {
                    // On conflicts git has already written files with conflict markers: reset to HEAD
                    if self.index_has_conflicts() {
                        self.reset_to_head(&names)?;
                    }
                    keep.push((names, bytes));
                }
            }
        }
        let _ = std::fs::remove_file(&part);
        let kept = keep.len();
        if take > 0 {
            if !keep.is_empty() {
                self.shelf_add_rest(&entry, &keep)?;
            }
            self.shelf_mark_deleted(id)?;
        }
        Ok((take, kept))
    }

    /// Reset these paths in the worktree and index to HEAD; delete those not in HEAD
    fn reset_to_head(&self, names: &[String]) -> Result<()> {
        for n in names {
            let spec = format!("HEAD:{n}");
            if git_cli::run(self.path(), &["cat-file", "-e", &spec], None).is_ok() {
                git_cli::run(self.path(), &["checkout", "HEAD", "--", n], None)?;
            } else {
                git_cli::run(self.path(), &["rm", "-q", "-f", "--cached", "--ignore-unmatch", "--", n], None)?;
                let _ = std::fs::remove_file(self.path().join(n));
            }
        }
        Ok(())
    }

    pub fn shelf_delete(&self, id: u64) -> Result<()> {
        self.shelf_entry(id)?;
        self.shelf_mark_deleted(id)
    }

    /// Files and changed line counts in a shelf entry, read from the saved patch (spec §4.9)
    pub fn shelf_files(&self, id: u64) -> Result<Vec<crate::model::FileChange>> {
        let patch = self.shelf_patch(id)?;
        let diff = git2::Diff::from_buffer(&patch).map_err(|e| CoreError::git("读取暂存架的补丁失败", e))?;
        crate::diff::files(&diff, &mut Vec::new())
    }

    /// A file's diff in a shelf entry (relative to HEAD at shelve time), read from the saved patch without touching the worktree
    /// A file's diff in a shelf entry. With `context`, show the whole file: take the original content from the commit at shelve time,
    /// rebuild the shelved content from the patch and compare in full; fall back to the patch hunks when the original can't be read (commit pruned).
    pub fn shelf_diff(&self, id: u64, path: &str, context: Option<u32>) -> Result<crate::model::FileDiff> {
        let patch = self.shelf_patch(id)?;
        let diff = git2::Diff::from_buffer(&patch).map_err(|e| CoreError::git("读取暂存架的补丁失败", e))?;
        let short = crate::diff::file_named(&diff, path)?.ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("这个条目里没有 {path}")))?;
        let Some(ctx) = context else { return Ok(short) };
        if short.binary || short.truncated {
            return Ok(short);
        }
        let entry = self.shelf_entry(id)?;
        let old_path = path;
        let added = entry.files.iter().any(|f| f.path == path && f.status == crate::model::FileStatus::A);
        let old: Vec<u8> = if added {
            Vec::new()
        } else {
            let repo = self.git2()?;
            match repo.revparse_single(&format!("{}:{old_path}", entry.base)).and_then(|o| o.peel_to_blob()) {
                Ok(b) => b.content().to_vec(),
                Err(_) => return Ok(short),
            }
        };
        let Some(new) = apply_hunks(&old, &short.hunks) else { return Ok(short) };
        crate::diff::buffers_diff(&old, &new, path, ctx)
    }

    fn shelf_patch(&self, id: u64) -> Result<Vec<u8>> {
        self.shelf_entry(id)?;
        std::fs::read(self.shelf_dir()?.join(format!("{id}.patch"))).map_err(|_| shelf_gone())
    }

    pub fn shelf_rename(&self, id: u64, name: &str) -> Result<()> {
        if name.trim().is_empty() {
            return Err(CoreError::new(ErrorCode::InvalidName, "名字不能为空"));
        }
        let mut idx = self.shelf_read()?;
        let e = idx.entries.iter_mut().find(|e| e.id == id && e.deleted.is_none()).ok_or_else(shelf_gone)?;
        e.name = name.trim().to_string();
        self.shelf_write(&idx)
    }

    fn shelf_entry(&self, id: u64) -> Result<ShelfEntry> {
        self.shelf_read()?.entries.into_iter().find(|e| e.id == id && e.deleted.is_none()).ok_or_else(shelf_gone)
    }

    fn shelf_mark_deleted(&self, id: u64) -> Result<()> {
        let mut idx = self.shelf_read()?;
        if let Some(e) = idx.entries.iter_mut().find(|e| e.id == id) {
            e.deleted = Some(now());
        }
        self.shelf_write(&idx)
    }

    /// `git apply --3way` stages the files it creates; files that were untracked when shelved go back to untracked
    fn unstage_restored_untracked(&self, entry: &ShelfEntry, only: Option<&[String]>) {
        let files: Vec<&str> = entry.files.iter().filter(|f| f.untracked && only.is_none_or(|o| o.contains(&f.path))).map(|f| f.path.as_str()).collect();
        if files.is_empty() {
            return;
        }
        let mut args = vec!["rm", "--cached", "--quiet", "--ignore-unmatch", "--"];
        args.extend(files);
        let _ = git_cli::run(self.path(), &args, None);
    }

    // ---------- Conflicts when restoring ----------

    pub(crate) fn require_clean_state(&self) -> Result<()> {
        if self.state()?.state != crate::model::RepoMode::Normal {
            return Err(CoreError::new(ErrorCode::MergeInProgress, "合并或取回还没完成，先解决冲突或中止"));
        }
        Ok(())
    }

    pub(crate) fn index_has_conflicts(&self) -> bool {
        self.git2().ok().and_then(|r| r.index().ok()).is_some_and(|i| i.has_conflicts())
    }

    fn unstash_file(&self) -> Result<PathBuf> {
        Ok(self.strand_dir()?.join("unstash.json"))
    }

    pub(crate) fn set_unstash(&self, u: &Unstash) -> Result<()> {
        let f = self.unstash_file()?;
        std::fs::create_dir_all(f.parent().expect("有上级目录")).map_err(io("保存取回状态失败"))?;
        std::fs::write(f, serde_json::to_vec(u).unwrap_or_default()).map_err(io("保存取回状态失败"))
    }

    /// The restore in progress (conflicts not all resolved)
    pub fn unstash(&self) -> Option<Unstash> {
        let f = self.unstash_file().ok()?;
        std::fs::read(f).ok().and_then(|b| serde_json::from_slice(&b).ok())
    }

    pub(crate) fn unstash_in_progress(&self) -> bool {
        self.unstash_file().is_ok_and(|f| f.exists()) || self.index_has_conflicts()
    }

    /// All restore conflicts are resolved: delete the entry (for restore-and-delete) and return to normal
    pub(crate) fn unstash_finish(&self) -> Result<()> {
        if let Some(u) = self.unstash()
            && u.drop
        {
            match u.source {
                UnstashSource::Stash => self.drop_stash_id(&u.id)?,
                UnstashSource::Shelf => self.shelf_mark_deleted(u.id.parse().unwrap_or(0))?,
                UnstashSource::Patch => {}
            }
        }
        let _ = std::fs::remove_file(self.unstash_file()?);
        Ok(())
    }

    /// Abort the restore: back to before it, keeping the entry
    pub(crate) fn unstash_abort(&self) -> Result<()> {
        git_cli::run(self.path(), &["reset", "--merge"], None)?;
        if let Some(rest) = self.unstash().and_then(|u| u.remainder) {
            self.shelf_mark_deleted(rest)?;
        }
        let _ = std::fs::remove_file(self.unstash_file()?);
        Ok(())
    }
}

fn shelf_gone() -> CoreError {
    CoreError::new(ErrorCode::NotFound, "这条搁置已经不在了")
}

pub(crate) fn overwrite_error(e: CoreError) -> CoreError {
    let text = e.detail.as_ref().map(|d| d.to_string()).unwrap_or_default();
    if text.contains("would be overwritten") || text.contains("does not match index") || text.contains("already exists in working directory") {
        return CoreError::new(ErrorCode::WorktreeConflict, "工作区里这些文件有改动，取回会覆盖它们。先提交、搁置或贮藏这些改动").with_detail(e.detail.unwrap_or_default());
    }
    if text.contains("patch does not apply") {
        return CoreError::new(ErrorCode::GitFailed, "这些改动没法放回当前的工作区：对应的文件已经变化太大").with_detail(e.detail.unwrap_or_default());
    }
    e
}

/// Split a `git diff` patch by file: each part starts at its `diff --git ` line, paired with the file's new and old paths (parsed with git2, same order).
fn split_patch(patch: &[u8]) -> Result<Vec<(Vec<String>, Vec<u8>)>> {
    let diff = git2::Diff::from_buffer(patch).map_err(|e| CoreError::git("读取暂存架的补丁失败", e))?;
    let mut starts = Vec::new();
    let mut at = 0;
    for line in patch.split_inclusive(|&b| b == b'\n') {
        if line.starts_with(b"diff --git ") {
            starts.push(at);
        }
        at += line.len();
    }
    if starts.len() != diff.deltas().len() {
        return Err(CoreError::new(ErrorCode::GitFailed, "暂存架的补丁格式不对，不能只取回部分文件"));
    }
    let mut out = Vec::new();
    for (i, d) in diff.deltas().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(patch.len());
        let mut names: Vec<String> = Vec::new();
        for p in [d.new_file().path(), d.old_file().path()].into_iter().flatten() {
            let n = p.to_string_lossy().to_string();
            if !names.contains(&n) {
                names.push(n);
            }
        }
        out.push((names, patch[starts[i]..end].to_vec()));
    }
    Ok(out)
}

/// `git apply` decides whether the worktree changed from file stats in the index; right after undo and similar operations rewrote files the stats may be stale,
/// causing a false "does not match index". Refresh once first (failure is fine).
pub(crate) fn refresh_index(dir: &std::path::Path) {
    let _ = git_cli::run(dir, &["update-index", "-q", "--refresh"], None);
}

/// Turn the original content into the new content by applying the diff's hunks; `None` when the hunks don't match the original
fn apply_hunks(old: &[u8], hunks: &[crate::model::Hunk]) -> Option<Vec<u8>> {
    use crate::model::LineKind;
    let lines: Vec<&[u8]> = old.split_inclusive(|&b| b == b'\n').collect();
    let eol: &[u8] = if old.windows(2).any(|w| w == b"\r\n") { b"\r\n" } else { b"\n" };
    let strip = |l: &[u8]| -> String {
        let mut t = l;
        if t.ends_with(b"\n") {
            t = &t[..t.len() - 1];
        }
        if t.ends_with(b"\r") {
            t = &t[..t.len() - 1];
        }
        String::from_utf8_lossy(t).into_owned()
    };
    let mut out = Vec::with_capacity(old.len());
    let mut at = 0usize; // Next line of the original content (0-based)
    for h in hunks {
        let start = (h.old_start as usize).saturating_sub(1);
        // old_start is 0 for an empty file or pure additions
        let start = if h.lines.iter().all(|l| l.kind == LineKind::Add) && h.old_start > 0 { h.old_start as usize } else { start };
        if start < at || start > lines.len() {
            return None;
        }
        for l in &lines[at..start] {
            out.extend_from_slice(l);
        }
        at = start;
        for l in &h.lines {
            match l.kind {
                LineKind::Context | LineKind::Del => {
                    let src = lines.get(at)?;
                    if strip(src) != l.text {
                        return None;
                    }
                    if l.kind == LineKind::Context {
                        out.extend_from_slice(src);
                    }
                    at += 1;
                }
                LineKind::Add => {
                    out.extend_from_slice(l.text.as_bytes());
                    out.extend_from_slice(eol);
                }
            }
        }
    }
    for l in &lines[at.min(lines.len())..] {
        out.extend_from_slice(l);
    }
    Some(out)
}

/// Remove directories left empty after deleting `file`, up to (not including) the worktree root
fn remove_empty_parents(root: &std::path::Path, file: &std::path::Path) {
    let mut dir = file.parent();
    while let Some(d) = dir {
        if d == root || !d.starts_with(root) || std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}
