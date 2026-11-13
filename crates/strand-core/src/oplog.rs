//! 操作日志、撤销和重做（说明书第 11 节）。
//!
//! 每个写操作执行前后各拍一张快照：HEAD、本地分支和标签的位置、索引对应的树、工作区已跟踪文件对应的树。
//! 日志只保存前后不同的引用；树对象写进 Git 对象库，每条日志在 `refs/strand/ops/<id>` 下留一个提交
//! （树里放四棵快照树，父提交是变动前后的提交），这样撤销掉的提交、删掉的分支不会被垃圾回收。
//!
//! 撤销 = 恢复到 `before`，重做 = 恢复到 `after`。恢复前核对仓库现在的样子：
//! - HEAD 和这一步改过的引用必须还是这一步结束时的位置，否则说明仓库在别处被改过，返回 `STATE_DIVERGED`；
//! - 文件按路径核对：只改这一步改过的文件，用户之后在别的文件上的改动保留；同一个文件又被改过时返回 `STATE_DIVERGED`。
//!
//! 日志保存在 `.git/strand/oplog.json`，保留最近 200 条、30 天。重做列表只在内存里，重启后清空。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::RepoMode;
use crate::repo::Session;

const MAX_ENTRIES: usize = 200;
const MAX_AGE_SECS: i64 = 30 * 86_400;
const KEEP_PREFIX: &str = "refs/strand/ops/";

/// 操作的类别。推送只在时间线里显示，不能撤销。
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
    /// 完整引用名，如 `refs/heads/main`；分支还没有提交时也是它
    Branch(String),
    Detached(String),
}

/// 仓库某一刻的样子
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    pub head: HeadRef,
    /// 本地分支和标签：完整引用名 → 对象哈希
    pub refs: BTreeMap<String, String>,
    /// 索引对应的树；裸仓库没有
    pub index: Option<String>,
    /// 工作区里已跟踪文件对应的树；裸仓库没有
    pub worktree: Option<String>,
    /// 贮藏列表（新的在前）
    #[serde(default)]
    pub stash: Vec<StashRef>,
    /// 暂存架里没删除的条目
    #[serde(default)]
    pub shelf: Vec<u64>,
    /// 指定的几个文件（不管跟踪与否）的样子，只有 [`Session::run_op_scoped`] 才拍
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<FilesSnap>,
    /// 链接的工作目录，只有 [`Session::run_op_scoped`] 才拍
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktrees: Option<Vec<WorktreeSnap>>,
}

/// 快照里额外记下的文件：`paths` 是记下的路径，`tree` 里只有当时存在的那些
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FilesSnap {
    pub paths: Vec<String>,
    pub tree: String,
}

/// 一个链接的工作目录：检出的分支，或分离头指针时的提交
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeSnap {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached: Option<String>,
}

/// 普通快照之外还要记下的东西。快照只管已跟踪文件，未跟踪文件和工作目录要操作自己说明：
/// - `files`：加入版本控制、加入忽略规则、删除未跟踪文件涉及的路径；
/// - `worktrees`：新建、移除工作目录。
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

/// 日志里保存的一侧：只有这一步改过的引用
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Side {
    head: HeadRef,
    /// 这一步改过的引用在这一侧的位置；`None` 表示不存在
    refs: BTreeMap<String, Option<String>>,
    index: Option<String>,
    worktree: Option<String>,
    /// 这一步改了贮藏列表时，这一侧的完整列表
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stash: Option<Vec<StashRef>>,
    /// 这一步改了暂存架时，这一侧没删除的条目
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shelf: Option<Vec<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    files: Option<FilesSnap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktrees: Option<Vec<WorktreeSnap>>,
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
    /// 已被撤销（等待重做）
    #[serde(default)]
    undone: bool,
    /// 不能撤销的原因
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// 合并、拉取停在冲突时，先记下开始前的快照，整个冲突解决完成后才写成一条日志
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

/// 前端看到的一条日志
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
    /// 新的在前
    pub entries: Vec<OpInfo>,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// 内存里的日志状态，挂在 `Session` 上
#[derive(Default)]
pub struct OpLog {
    file: Option<File>,
    /// 重做列表：每项是一次撤销涉及的日志（一次退回多步算一项），按撤销的顺序
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
            // 重做列表不跨重启保留
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

    /// 仓库现在的快照。树对象会写进对象库。
    pub fn snapshot(&self) -> Result<Snapshot> {
        let repo = self.git2()?;
        let trees = if repo.is_bare() { (None, None) } else { snapshot_trees(repo.path(), self.path(), &self.oplog_dir()?, None) };
        self.snapshot_with(trees)
    }

    /// 快照里便宜的部分（HEAD、引用、贮藏、暂存架），配上算好的索引树和工作区树
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
        Ok(Snapshot { head, refs, index, worktree, stash, shelf: self.shelf_visible(), files: None, worktrees: None })
    }

    /// 普通快照，加上 `scope` 要求额外记下的文件和工作目录
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

    /// 执行一个要记入日志的写操作。操作失败但仓库停在合并或变基中（冲突）时，记下开始前的快照，
    /// 冲突解决完成（[`Session::op_finish_pending`]）后再写成一条日志。
    pub fn run_op<T>(&mut self, label: &str, kind: OpKind, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<(T, Option<OpInfo>)> {
        let before = self.snapshot()?;
        crate::console::note(label);
        let r = f(self);
        let op = self.op_end(label, kind, before);
        let t = r?;
        Ok((t, op?))
    }

    /// 同 [`Session::run_op`]，另外按 `scope` 记下未跟踪文件和工作目录，让这些也能撤销
    pub fn run_op_scoped<T>(&mut self, label: &str, kind: OpKind, scope: &OpScope, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<(T, Option<OpInfo>)> {
        let before = self.snapshot_scoped(scope)?;
        crate::console::note(label);
        let r = f(self);
        let op = self.op_end_scoped(label, kind, before, scope);
        let t = r?;
        Ok((t, op?))
    }

    /// 同 [`Session::run_op`]，最后再重新读取日志（界面要刷新）。操作后的快照和重新读取同时进行，
    /// 省下其中一个的时间（说明书 15）。不管操作成功与否都会重新读取。
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
            // 操作后的快照、界面紧接着要的工作区状态（都从同一次 git status 出发，免得把全部文件扫两遍），
            // 和重新读取日志同时做
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

    /// 写操作结束：和开始前的快照比较，有变化就写一条日志
    pub fn op_end(&mut self, label: &str, kind: OpKind, before: Snapshot) -> Result<Option<OpInfo>> {
        self.op_end_scoped(label, kind, before, &OpScope::default())
    }

    fn op_end_scoped(&mut self, label: &str, kind: OpKind, before: Snapshot, scope: &OpScope) -> Result<Option<OpInfo>> {
        if self.state()?.state != RepoMode::Normal {
            self.oplog_file()?.pending = Some(Pending { label: label.to_string(), kind, before });
            self.oplog_save()?;
            return Ok(None);
        }
        // 之前停在冲突、后来在别处中止的合并：它记下的开始前快照已经没用了
        if self.oplog_file()?.pending.take().is_some() {
            self.oplog_save()?;
        }
        let after = self.snapshot_scoped(scope)?;
        if after == before {
            return Ok(None);
        }
        self.op_push(label, kind, before, after, true).map(Some)
    }

    /// 推送：只在时间线里显示
    pub fn op_note(&mut self, label: &str, kind: OpKind) -> Result<OpInfo> {
        crate::console::note(label);
        let s = self.snapshot()?;
        self.op_push(label, kind, s.clone(), s, false)
    }

    /// 冲突解决完成：把合并或拉取的整个过程写成一条日志
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

    /// 中止了合并或变基：仓库回到开始前，不写日志
    pub fn op_drop_pending(&mut self) -> Result<()> {
        if self.state()?.state == RepoMode::Normal && self.oplog_file()?.pending.take().is_some() {
            self.oplog_save()?;
        }
        Ok(())
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
        };
        let (b, a) = (side(&before), side(&after));
        // 新的写操作清空重做列表
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
        // 清理太旧的日志
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

    /// 留一个引用，防止快照用到的对象被垃圾回收
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
            s.refs.values().flatten().cloned().chain(head).chain(stashes)
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

    /// 最近的日志（新的在前）
    pub fn oplog_list(&mut self, limit: usize) -> Result<OpList> {
        let can_redo = !self.oplog.redo.is_empty();
        // 最近一步结束后仓库在别处被改过（命令行里提交、切换分支、改了它改过的文件）：
        // 这一步和更早的都显示为不能撤销。只是显示，不写进日志，外部又改回去就恢复。
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

    /// 这一步结束后，它改过的东西有没有在别处被改过。只看这一步改过的 HEAD、引用、索引条目、文件、
    /// 贮藏和暂存架，不拍整个快照（每次刷新时间线都要调用）。改过时返回原因。
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
        let index = changes(&repo, &e.before.index, &a.index);
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
            // 只比内容；符号链接和文件模式交给撤销时的完整核对
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

    /// 撤销。`to` 为空时撤销最近一步，否则撤销到这一条（含）为止。
    /// 要越过已经推送的步骤时，`confirm_pushed` 为假就返回 `ALREADY_PUSHED`，前端确认后再调用。
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
        if !done.is_empty() {
            self.oplog.redo.push(done.iter().map(|o| o.id).collect());
        }
        self.oplog_save()
    }

    /// 重做最近一次撤销（一次退回多步的会一起恢复）
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
                    // 没重做的那几步留在重做列表里
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

    /// 把一条日志撤销（恢复到 before）或重做（恢复到 after）
    fn restore(&mut self, id: u64, undo: bool) -> Result<OpInfo> {
        let e = self.oplog_file()?.entries.iter().find(|e| e.id == id).cloned().ok_or_else(|| CoreError::new(ErrorCode::NotFound, "这一步已经不在时间线里"))?;
        crate::console::note(&format!("{}：{}", if undo { "撤销" } else { "重做" }, e.label));
        let (from, to) = if undo { (&e.after, &e.before) } else { (&e.before, &e.after) };
        let scope = OpScope { files: to.files.as_ref().map(|f| f.paths.clone()).unwrap_or_default(), worktrees: to.worktrees.is_some() };
        let cur = self.snapshot_scoped(&scope)?;
        let repo = self.git2()?;
        let checked = check(&repo, from, to, &cur).and_then(|plan| {
            // 要移除的工作目录里不能有没提交的改动
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
                    // 这一条和更早的都不能再自动撤销
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
        let f = self.oplog_file()?;
        let x = f.entries.iter_mut().find(|x| x.id == id).expect("刚找到");
        x.undone = undo;
        Ok(info(x))
    }
}

/// 工作区已跟踪文件的树：复制一份索引，按工作区的内容刷新后写成树（不改动真正的索引）
/// 快照里贵的部分：索引的树和工作区的树。两者互不相干，分两个线程算（说明书 15：大仓库上写操作 500 ms 内完成）
fn snapshot_trees(git_dir: &Path, workdir: &Path, scratch: &Path, pre: Option<&str>) -> (Option<String>, Option<String>) {
    std::thread::scope(|sc| {
        let wt = sc.spawn(|| worktree_tree(git_dir, workdir, scratch, pre).ok());
        let index = git2::Repository::open(git_dir)
            .ok()
            .and_then(|r| r.index().ok().and_then(|mut i| i.write_tree_to(&r).ok()));
        (index.map(|t| t.to_string()), wt.join().ok().flatten().map(|t| t.to_string()))
    })
}

/// 工作区里已跟踪文件的样子，存成一棵树：从索引出发，换上工作区里和索引不一样的文件。
///
/// 先用系统 `git status`（多线程）找出哪些已跟踪的文件和索引不一样：通常一个都没有或只有几个，
/// 只需把这几个加进索引的副本里；不用像 libgit2 的 `update_all` 那样把全部文件检查一遍
/// （5 万个文件约 150 ms）。有没解决的冲突或 `git status` 失败时退回 `update_all`。
/// `pre` 是已经跑好的 `git status --porcelain=v2` 输出（没有就自己跑一次）。
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

/// 从 `git status --porcelain=v2 -z` 里取出工作区和索引不一样的已跟踪文件：(路径, 工作区里删掉了)。
/// 有没解决的冲突（u 条目）时返回 `None`，交给 `update_all`。
fn worktree_changes(out: &str) -> Option<Vec<(String, bool)>> {
    let mut list = Vec::new();
    for e in out.split('\0').filter(|e| !e.is_empty()) {
        match e.as_bytes()[0] {
            b'1' => {
                let mut f = e.splitn(9, ' ');
                let xy = f.nth(1)?;
                // 子模块（sub 字段以 S 开头）在快照里不动，和 update_all 一样
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

/// 要恢复的文件：路径 → 目标里的 (blob, 文件模式)，`None` 表示删除
type FileSet = BTreeMap<String, Option<(git2::Oid, u32)>>;

struct Plan {
    index: FileSet,
    worktree: FileSet,
    /// 额外记下的文件（见 [`OpScope`]）
    files: FileSet,
    remove_worktrees: Vec<WorktreeSnap>,
    add_worktrees: Vec<WorktreeSnap>,
}

/// 树里某个路径的 (blob, 文件模式)
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

/// 两棵树之间改过的文件，以及它们在 `b` 里的样子
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

/// 核对仓库现在的样子能不能从 `from` 恢复到 `to`；不能时返回有冲突的引用和文件
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
    // 额外记下的文件：现在的样子必须和 from 一样；由它们决定这些路径写成什么，不再看已跟踪文件的树
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
    // 要写出的文件现在是未跟踪文件（不在任何一边的已跟踪文件里）且内容不同，覆盖会丢数据
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

/// 恢复：引用、HEAD、索引、工作区
fn apply(repo: &git2::Repository, to: &Side, plan: &Plan, root: &Path) -> Result<()> {
    let msg = "strand: undo/redo";
    // 引用：先删再建，避免 a 和 a/b 这类父子名字互相挡住
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

/// 把工作区里这些文件写成目标的样子（`None` 是删除）
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
                // 删掉因此变空的上级目录
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

/// 把贮藏列表恢复成 `list`（新的在前）：清空后按从旧到新的顺序重新放进去，说明保持不变
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
