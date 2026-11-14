//! 贮藏和暂存架（说明书 4.9）。
//!
//! - 贮藏：Git 原生 stash，一次收起全部已跟踪的改动，命令行 `git stash list` 也能看到。
//! - 暂存架：客户端自己保存的补丁，按文件搁置、可以命名。补丁存在 `.git/strand/shelf/<id>.patch`，
//!   列表在 `.git/strand/shelf/index.json`。删除和取回只是把条目标记为已删除，30 天后才真正删掉文件，
//!   这样撤销（说明书第 11 节）可以把条目找回来。
//!
//! 取回时和工作区冲突：仓库进入“取回进行中”（`RepoMode::Unstashing`），走冲突解决流程（第 8 节），
//! “你的”是工作区，“对方的”是取回的改动。`.git/strand/unstash.json` 记下取回的是什么，
//! 完成时才删除贮藏条目（pop）或暂存架条目；中止时用 `git reset --merge` 回到取回之前，条目保留。

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShelfEntry {
    pub id: u64,
    pub name: String,
    pub time: i64,
    pub files: Vec<ShelfFile>,
    /// 搁置时 HEAD 所在的提交
    #[serde(default)]
    pub base: String,
    /// 被删除或取回的时间；列表里不显示，到期后删掉补丁文件
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<i64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ShelfIndex {
    next_id: u64,
    entries: Vec<ShelfEntry>,
}

/// 取回时产生了冲突：记下取回的是什么，完成时再删条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Unstash {
    pub source: UnstashSource,
    /// 贮藏的提交哈希，或暂存架条目的编号
    pub id: String,
    /// “对方的”一侧显示的名字
    pub label: String,
    /// 完成后删除条目（取回并删除）
    pub drop: bool,
    /// 暂存架只取回部分文件时，剩下的文件另存成的条目；中止取回时删掉它（原条目还在）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remainder: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnstashSource {
    Stash,
    Shelf,
    /// 应用补丁到工作区时有冲突（完成时没有条目要删）
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

    // ---------- 贮藏 ----------

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

    /// 贮藏里改动的文件（相对贮藏时的 HEAD）
    pub fn stash_files(&self, index: usize) -> Result<Vec<crate::model::FileChange>> {
        let e = self.stash_at(index)?;
        self.commit_files(&e.id)
    }

    fn stash_at(&self, index: usize) -> Result<StashEntry> {
        self.stash_list()?
            .into_iter()
            .find(|e| e.index == index)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "这条贮藏已经不在了，列表可能已经变化"))
    }

    /// 贮藏全部已跟踪的改动
    pub fn stash_push(&self, message: Option<&str>) -> Result<()> {
        let before = self.stash_list()?.first().map(|e| e.id.clone());
        let mut args = vec!["stash", "push", "--quiet"];
        if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
            args.extend(["--message", m]);
        }
        git_cli::run(self.path(), &args, None)?;
        if self.stash_list()?.first().map(|e| e.id.clone()) == before {
            return Err(CoreError::new(ErrorCode::NothingSelected, "没有可以贮藏的改动"));
        }
        Ok(())
    }

    /// 取回贮藏。`drop` 为真时取回后删除（pop），否则保留（apply）。
    /// 和工作区冲突时进入“取回进行中”，返回 `CONFLICTS`；完成冲突解决后才删除。
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

    /// 按提交哈希删除贮藏（序号可能已经变了）
    fn drop_stash_id(&self, id: &str) -> Result<()> {
        let e = self.stash_list()?.into_iter().find(|e| e.id == id);
        match e {
            Some(e) => git_cli::run(self.path(), &["stash", "drop", "--quiet", &format!("stash@{{{}}}", e.index)], None).map(|_| ()),
            None => Ok(()),
        }
    }

    // ---------- 暂存架 ----------

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

    /// 暂存架里的条目，新的在前（已删除的不显示；到期的顺便清理）
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

    /// 暂存架里没删除的条目编号（操作日志的快照用）
    pub(crate) fn shelf_visible(&self) -> Vec<u64> {
        self.shelf_read().map(|i| i.entries.iter().filter(|e| e.deleted.is_none()).map(|e| e.id).collect()).unwrap_or_default()
    }

    /// 撤销或重做时恢复暂存架的可见条目
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

    /// 把选中文件的改动搁置到暂存架，工作区里这些文件回到 HEAD 的样子。`paths` 含重命名的旧路径。
    pub fn shelf_save(&self, name: &str, paths: &[String]) -> Result<ShelfEntry> {
        self.require_clean_state()?;
        if paths.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "至少勾选一个文件"));
        }
        let status = self.status()?;
        let files: Vec<ShelfFile> = status
            .changes
            .iter()
            .filter(|c| paths.contains(&c.path))
            .map(|c| ShelfFile { path: c.path.clone(), status: c.status })
            .collect();
        if files.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "选中的文件没有改动"));
        }
        let mut args: Vec<&str> = vec!["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--"];
        args.extend(paths.iter().map(String::as_str));
        let patch = git_cli::run(self.path(), &args, None)?;
        if patch.trim().is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "选中的文件没有改动"));
        }
        let mut idx = self.shelf_read()?;
        idx.next_id += 1;
        let id = idx.next_id;
        let dir = self.shelf_dir()?;
        std::fs::create_dir_all(&dir).map_err(io("保存暂存架失败"))?;
        // 先把补丁写好再改工作区：写不进去就什么也不改（说明书 15 节：数据安全）
        std::fs::write(dir.join(format!("{id}.patch")), patch.as_bytes()).map_err(io("保存暂存架失败"))?;
        let name = if name.trim().is_empty() { format!("改动 · {id}") } else { name.trim().to_string() };
        let base = self.git2()?.head().ok().and_then(|h| h.target()).map(|o| o.to_string()).unwrap_or_default();
        let entry = ShelfEntry { id, name, time: now(), files, base, deleted: None };
        idx.entries.push(entry.clone());
        self.shelf_write(&idx)?;
        let mut restore: Vec<&str> = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
        restore.extend(paths.iter().map(String::as_str));
        git_cli::run(self.path(), &restore, None)?;
        Ok(entry)
    }

    /// 取回暂存架条目到工作区，条目删除。和工作区冲突时进入“取回进行中”，返回 `CONFLICTS`。
    pub fn shelf_restore(&self, id: u64) -> Result<()> {
        self.require_clean_state()?;
        let entry = self.shelf_entry(id)?;
        let patch = self.shelf_dir()?.join(format!("{id}.patch"));
        let p = patch.to_string_lossy().to_string();
        refresh_index(self.path());
        match git_cli::run(self.path(), &["apply", "--3way", "--binary", &p], None) {
            Ok(_) => self.shelf_mark_deleted(id),
            Err(err) => {
                if self.index_has_conflicts() {
                    self.set_unstash(&Unstash { source: UnstashSource::Shelf, id: id.to_string(), label: entry.name, drop: true, remainder: None })?;
                    return Err(CoreError::new(ErrorCode::Conflicts, "取回的改动和工作区有冲突，请逐个处理"));
                }
                Err(overwrite_error(err))
            }
        }
    }

    /// 只取回暂存架条目里的部分文件（说明书 4.9）。`paths` 是条目里的文件路径（重命名的用新路径）。
    /// 原条目标记删除，剩下的文件另存成一个同名的新条目，放在原来的位置；撤销时原条目整个回来。
    /// 勾选了全部文件时等同于 `shelf_restore`。和工作区冲突时同样进入“取回进行中”。
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
        // 先把剩下的另存成新条目：写不进去就什么也不改
        let rest_id = self.shelf_add_rest(&entry, &keep)?;

        let part = dir.join(format!("{id}.part.patch"));
        let taken: Vec<u8> = take.iter().flat_map(|(_, b)| b.iter().copied()).collect();
        std::fs::write(&part, &taken).map_err(io("取回失败"))?;
        let p = part.to_string_lossy().to_string();
        refresh_index(self.path());
        let r = git_cli::run(self.path(), &["apply", "--3way", "--binary", &p], None);
        let _ = std::fs::remove_file(&part);
        match r {
            Ok(_) => self.shelf_mark_deleted(id),
            Err(err) => {
                if self.index_has_conflicts() {
                    self.set_unstash(&Unstash { source: UnstashSource::Shelf, id: id.to_string(), label: entry.name, drop: true, remainder: Some(rest_id) })?;
                    return Err(CoreError::new(ErrorCode::Conflicts, "取回的改动和工作区有冲突，请逐个处理"));
                }
                // 没取回来：去掉刚另存的条目，原条目不变
                self.shelf_mark_deleted(rest_id)?;
                Err(overwrite_error(err))
            }
        }
    }

    /// 把条目里 `keep` 这些文件的补丁另存成一个同名的新条目，放在原条目后面，返回新编号
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

    // ---------- 拉取前自动搁置（说明书 7.2） ----------

    /// 拉取前把工作区里已跟踪文件的改动搁置到暂存架（“拉取前自动搁置”），记下条目编号。
    /// 没有改动时什么都不做，返回 `None`。未跟踪的文件不动。
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

    /// 拉取结束（直接完成，或冲突解决完成、中止）后放回自动搁置的改动。仓库还停在合并或变基中时不动。
    /// 放回成功返回 `Ok(None)`；放回时有冲突或会覆盖文件，就回到放回之前、改动留在暂存架，返回给用户看的说明。
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
        // 整个放不回去：逐个文件放回，放不回的（有冲突或会覆盖文件）留在暂存架
        let (taken, kept) = self.unshelve_each(id)?;
        let why = if e.code == ErrorCode::Conflicts { "和拉取下来的内容有冲突" } else { "会覆盖拉取下来的文件" };
        if taken == 0 {
            return Ok(Some(format!("放回拉取前的改动时{why}，改动留在暂存架“{}”里，可以稍后手动取回", entry.name)));
        }
        Ok(Some(format!("拉取前的改动放回了 {taken} 个文件；{kept} 个文件{why}，留在暂存架“{}”里，可以稍后手动取回", entry.name)))
    }

    /// 把暂存架条目里的文件一个一个放回：能放回的放回，冲突的退回到 HEAD 的样子、留在暂存架。
    /// 都放回了就删除条目；放回了一部分时原条目删除，剩下的另存成同名新条目（撤销时原条目整个回来）。
    /// 返回（放回的文件数，留下的文件数）。只在仓库正常、已跟踪的文件没有改动时调用（拉取刚结束）。
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
                    // 有冲突时 git 已经写了带冲突标记的文件：退回到 HEAD 的样子
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

    /// 把这些路径的工作区和索引退回到 HEAD 的样子；HEAD 里没有的删掉
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

    /// 暂存架条目里的文件和改动行数，从保存的补丁里读（说明书 4.9）
    pub fn shelf_files(&self, id: u64) -> Result<Vec<crate::model::FileChange>> {
        let patch = self.shelf_patch(id)?;
        let diff = git2::Diff::from_buffer(&patch).map_err(|e| CoreError::git("读取暂存架的补丁失败", e))?;
        crate::diff::files(&diff, &mut Vec::new())
    }

    /// 暂存架条目里一个文件的差异（相对搁置时的 HEAD），从保存的补丁里读，不碰工作区
    pub fn shelf_diff(&self, id: u64, path: &str) -> Result<crate::model::FileDiff> {
        let patch = self.shelf_patch(id)?;
        let diff = git2::Diff::from_buffer(&patch).map_err(|e| CoreError::git("读取暂存架的补丁失败", e))?;
        crate::diff::file_named(&diff, path)?.ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("这个条目里没有 {path}")))
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

    // ---------- 取回时的冲突 ----------

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

    /// 正在进行的取回（冲突还没解决完）
    pub fn unstash(&self) -> Option<Unstash> {
        let f = self.unstash_file().ok()?;
        std::fs::read(f).ok().and_then(|b| serde_json::from_slice(&b).ok())
    }

    pub(crate) fn unstash_in_progress(&self) -> bool {
        self.unstash_file().is_ok_and(|f| f.exists()) || self.index_has_conflicts()
    }

    /// 取回的冲突都解决了：删除条目（取回并删除时），回到正常状态
    pub(crate) fn unstash_finish(&self) -> Result<()> {
        if let Some(u) = self.unstash() {
            if u.drop {
                match u.source {
                    UnstashSource::Stash => self.drop_stash_id(&u.id)?,
                    UnstashSource::Shelf => self.shelf_mark_deleted(u.id.parse().unwrap_or(0))?,
                    UnstashSource::Patch => {}
                }
            }
        }
        let _ = std::fs::remove_file(self.unstash_file()?);
        Ok(())
    }

    /// 中止取回：回到取回之前，条目保留
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

/// 把 `git diff` 的补丁按文件切开：每段从 `diff --git ` 那一行开始，配上这个文件的新旧路径（用 git2 解析得到，顺序一致）。
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

/// `git apply` 按索引里记的文件状态判断工作区有没有改动；撤销等操作刚改写过文件时状态可能是旧的，
/// 会误报“does not match index”。先刷新一次（失败不要紧）。
pub(crate) fn refresh_index(dir: &std::path::Path) {
    let _ = git_cli::run(dir, &["update-index", "-q", "--refresh"], None);
}
