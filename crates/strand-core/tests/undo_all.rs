//! 说明书第 16 节“撤销和重做”验收：11.2 列为可撤销的每个操作，撤销后仓库和操作前一致，重做后和操作后一致。
//!
//! 比较的是：HEAD、本地分支和标签、索引、贮藏列表、暂存架，加上工作区里每个文件（含未跟踪文件）的内容，
//! 以及链接的工作目录列表。

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use strand_core::commits::ResetMode;
use strand_core::model::{MergeMode, SelectedFile, Selection};
use strand_core::oplog::{OpKind, OpScope};
use strand_core::rebase::{Step, StepAction};
use strand_core::remote::{self, Cancel, PullMode};
use strand_core::{Result, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(dir: &Path, f: &str, s: &str) {
    if let Some(p) = Path::new(f).parent() {
        std::fs::create_dir_all(dir.join(p)).unwrap();
    }
    std::fs::write(dir.join(f), s).unwrap();
}

fn commit(p: &Path, f: &str, s: &str, msg: &str) -> String {
    write(p, f, s);
    git(p, &["add", f]);
    git(p, &["commit", "-q", "-m", msg]);
    git(p, &["rev-parse", "HEAD"])
}

fn sel(files: &[&str]) -> Selection {
    Selection { files: files.iter().map(|f| SelectedFile { path: f.to_string(), old_path: None, whole: true, lines: vec![] }).collect() }
}

fn files(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.file_name().is_some_and(|n| n == ".git") {
            continue;
        }
        if p.is_dir() {
            files(root, &p, out);
        } else {
            out.insert(p.strip_prefix(root).unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap());
        }
    }
}

#[derive(Debug, PartialEq)]
struct State {
    head: String,
    refs: BTreeMap<String, String>,
    index: Option<String>,
    stash: Vec<String>,
    shelf: Vec<u64>,
    files: BTreeMap<String, Vec<u8>>,
    worktrees: Vec<String>,
}

fn state(s: &Session) -> State {
    let p = s.path();
    let snap = s.snapshot().unwrap();
    let mut f = BTreeMap::new();
    files(p, p, &mut f);
    State {
        head: format!("{:?}", snap.head),
        refs: snap.refs,
        index: snap.index,
        stash: snap.stash.into_iter().map(|x| x.id).collect(),
        shelf: snap.shelf,
        files: f,
        // 链接的工作目录：路径和检出的分支
        worktrees: s.worktree_list().unwrap().into_iter().filter(|w| !w.is_main).map(|w| format!("{} {:?}", w.path, w.branch)).collect(),
    }
}

/// 做一步（必须记入日志），撤销后和之前一样，重做后和之后一样
fn check(s: &mut Session, name: &str, f: impl FnOnce(&mut Session) -> Result<Option<strand_core::oplog::OpInfo>>) {
    let before = state(s);
    let op = f(s).unwrap_or_else(|e| panic!("{name}：{e:?}"));
    let op = op.unwrap_or_else(|| panic!("{name}：没有记入操作日志"));
    assert!(op.undoable, "{name}：应该可以撤销");
    s.reload().unwrap();
    let after = state(s);
    assert_ne!(before, after, "{name}：操作没有改变任何东西");
    s.oplog_undo(None, false).unwrap_or_else(|e| panic!("{name} 撤销：{e:?}"));
    s.reload().unwrap();
    assert_eq!(state(s), before, "{name}：撤销后应该和操作前一致");
    s.oplog_redo().unwrap_or_else(|e| panic!("{name} 重做：{e:?}"));
    s.reload().unwrap();
    assert_eq!(state(s), after, "{name}：重做后应该和操作后一致");
}

fn op<T>(s: &mut Session, label: &str, kind: OpKind, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<Option<strand_core::oplog::OpInfo>> {
    s.run_op(label, kind, f).map(|(_, op)| op)
}

fn scoped<T>(s: &mut Session, label: &str, kind: OpKind, scope: OpScope, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<Option<strand_core::oplog::OpInfo>> {
    s.run_op_scoped(label, kind, &scope, f).map(|(_, op)| op)
}

#[test]
fn every_undoable_operation_round_trips() {
    // 远程 origin（裸仓库）和本地克隆 me
    let origin = tempfile::tempdir().unwrap();
    git(origin.path(), &["init", "-q", "--bare", "-b", "main"]);
    let me = tempfile::tempdir().unwrap();
    let p = me.path();
    git(p, &["clone", "-q", origin.path().to_str().unwrap(), "."]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    commit(p, "a.txt", "a1\n", "A1");
    commit(p, "b.txt", "b1\n", "B1");
    git(p, &["push", "-q", "-u", "origin", "main"]);
    git(p, &["branch", "side"]);
    git(p, &["push", "-q", "origin", "side"]);
    git(p, &["checkout", "-q", "side"]);
    commit(p, "s.txt", "s1\n", "S1");
    git(p, &["checkout", "-q", "main"]);
    let wt_root = tempfile::tempdir().unwrap();
    let mut s = Session::open(p).unwrap();

    // ---------- 提交类 ----------
    write(p, "a.txt", "a2\n");
    check(&mut s, "提交", |s| op(s, "提交", OpKind::Commit, |s| s.commit_create("A2", &sel(&["a.txt"]), false, None)));
    write(p, "b.txt", "b2\n");
    check(&mut s, "修订", |s| op(s, "修订", OpKind::Commit, |s| s.commit_amend(Some("A2 和 B2"), &sel(&["b.txt"]), false, None)));
    let h = git(p, &["rev-parse", "HEAD"]);
    check(&mut s, "修改说明", |s| op(s, "修改说明", OpKind::Commit, |s| s.commit_reword(&h, "A2 B2 新说明")));
    let s1 = git(p, &["rev-parse", "side"]);
    check(&mut s, "拣选", |s| op(s, "拣选", OpKind::Commit, |s| s.commit_cherry_pick(std::slice::from_ref(&s1))));
    let h = git(p, &["rev-parse", "HEAD"]);
    check(&mut s, "还原", |s| op(s, "还原", OpKind::Commit, |s| s.commit_revert(&h)));
    let base = git(p, &["rev-parse", "origin/main"]);
    for mode in [ResetMode::Soft, ResetMode::Mixed, ResetMode::Hard] {
        check(&mut s, &format!("重置 {mode:?}"), |s| op(s, "重置", OpKind::Commit, |s| s.commit_reset(&base, mode)));
        // 退回重置之前，好试下一种方式
        s.oplog_undo(None, false).unwrap();
        s.reload().unwrap();
    }
    check(&mut s, "撤销提交", |s| op(s, "撤销提交", OpKind::Commit, |s| s.commit_undo()));
    // 从远程的位置重新开始，好数清楚未推送段
    git(p, &["reset", "-q", "--hard", "origin/main"]);
    let c1 = commit(p, "c.txt", "c1\n", "C1");
    let d1 = commit(p, "d.txt", "d1\n", "D1");
    let e1 = commit(p, "e.txt", "e1\n", "E1");
    s.reload().unwrap();
    check(&mut s, "丢弃提交", |s| op(s, "丢弃提交", OpKind::Commit, |s| s.commit_drop(&d1)));
    // 丢弃后 E1 换了哈希
    git(p, &["reset", "-q", "--hard", &e1]);
    s.reload().unwrap();
    write(p, "c.txt", "c2\n");
    check(&mut s, "Fixup", |s| op(s, "Fixup", OpKind::Commit, |s| s.commit_fixup(&c1, &sel(&["c.txt"]), None)));
    let ids: Vec<String> = git(p, &["rev-list", "--reverse", "origin/main..HEAD"]).lines().map(str::to_string).collect();
    assert_eq!(ids.len(), 3);
    let st = |i: usize, a| Step { id: ids[i].clone(), action: a, message: None };
    check(&mut s, "压缩", |s| op(s, "压缩", OpKind::Commit, |s| s.rebase_apply(&[st(0, StepAction::Pick), st(1, StepAction::Squash), st(2, StepAction::Pick)])));
    s.oplog_undo(None, false).unwrap();
    s.reload().unwrap();
    check(&mut s, "整理提交", |s| op(s, "整理提交", OpKind::Commit, |s| s.rebase_apply(&[st(2, StepAction::Pick), st(0, StepAction::Pick), st(1, StepAction::Drop)])));

    // ---------- 分支类 ----------
    check(&mut s, "新建分支", |s| op(s, "新建分支", OpKind::Branch, |s| s.branch_create("topic", None, true)));
    check(&mut s, "切换", |s| op(s, "切换", OpKind::Switch, |s| s.branch_switch("main", false)));
    check(&mut s, "重命名", |s| op(s, "重命名", OpKind::Branch, |s| s.branch_rename("topic", "topic2")));
    check(&mut s, "删除分支", |s| op(s, "删除分支", OpKind::Branch, |s| s.branch_delete("topic2", true)));
    check(&mut s, "合并", |s| op(s, "合并", OpKind::Merge, |s| s.branch_merge_mode("side", MergeMode::NoFf)));
    s.oplog_undo(None, false).unwrap();
    s.reload().unwrap();
    check(&mut s, "压缩合并", |s| op(s, "压缩合并", OpKind::Merge, |s| s.branch_merge_mode("side", MergeMode::Squash)));
    git(p, &["reset", "-q", "--hard", "origin/main"]);
    commit(p, "f.txt", "f1\n", "F1");
    s.reload().unwrap();
    check(&mut s, "变基", |s| op(s, "变基", OpKind::Merge, |s| s.branch_rebase("side")));
    check(&mut s, "检出远程分支", |s| op(s, "检出远程分支", OpKind::Checkout, |s| s.branch_checkout_remote("origin/side")));
    git(p, &["checkout", "-q", "main"]);
    s.reload().unwrap();
    check(&mut s, "检出指定版本", |s| op(s, "检出指定版本", OpKind::Checkout, |s| s.checkout_detached(&base)));
    git(p, &["checkout", "-q", "main"]);
    s.reload().unwrap();

    // ---------- 标签和工作目录 ----------
    check(&mut s, "新建标签", |s| op(s, "新建标签", OpKind::Tag, |s| s.tag_create("v1", "HEAD", None, false)));
    git(p, &["tag", "v2"]);
    s.reload().unwrap();
    check(&mut s, "删除标签", |s| op(s, "删除标签", OpKind::Tag, |s| s.tag_delete("v2")));
    let wt = wt_root.path().join("wt").to_string_lossy().into_owned();
    let wt_scope = || OpScope { worktrees: true, ..Default::default() };
    check(&mut s, "新建工作目录（新分支）", |s| scoped(s, "新建工作目录", OpKind::Branch, wt_scope(), |s| s.worktree_add(&wt, "wt-branch", true, None)));
    check(&mut s, "移除工作目录", |s| scoped(s, "移除工作目录", OpKind::Branch, wt_scope(), |s| s.worktree_remove(&wt, false)));
    let wt2 = wt_root.path().join("wt2").to_string_lossy().into_owned();
    check(&mut s, "新建工作目录（已有分支）", |s| scoped(s, "新建工作目录", OpKind::Branch, wt_scope(), |s| s.worktree_add(&wt2, "side", false, None)));

    // ---------- 工作区类 ----------
    write(p, "a.txt", "a 未提交\n");
    write(p, "b.txt", "b 未提交\n");
    check(&mut s, "丢弃改动", |s| op(s, "丢弃改动", OpKind::Other, |s| s.changes_discard(&["a.txt".into()])));
    check(&mut s, "搁置", |s| op(s, "搁置", OpKind::Shelf, |s| s.shelf_save("搁置一下", &["b.txt".into()])));
    let id = s.shelf_list().unwrap()[0].id;
    check(&mut s, "取回", |s| op(s, "取回", OpKind::Shelf, |s| s.shelf_restore(id)));
    write(p, "b.txt", "b 再改\n");
    let id = s.shelf_save("第二条", &["b.txt".into()]).unwrap().id;
    s.reload().unwrap();
    check(&mut s, "删除搁置", |s| op(s, "删除搁置", OpKind::Shelf, |s| s.shelf_delete(id)));
    write(p, "a.txt", "a 贮藏\n");
    check(&mut s, "贮藏", |s| op(s, "贮藏", OpKind::Stash, |s| s.stash_push(Some("贮藏一下"))));
    check(&mut s, "取回贮藏", |s| op(s, "取回贮藏", OpKind::Stash, |s| s.stash_apply(0, true)));
    write(p, "a.txt", "a 再贮藏\n");
    s.stash_push(Some("第二个")).unwrap();
    s.reload().unwrap();
    check(&mut s, "丢弃贮藏", |s| op(s, "丢弃贮藏", OpKind::Stash, |s| s.stash_drop(0)));
    write(p, "new.txt", "新文件\n");
    let files = |f: &[&str]| OpScope { files: f.iter().map(|x| x.to_string()).collect(), ..Default::default() };
    check(&mut s, "加入版本控制", |s| scoped(s, "加入版本控制", OpKind::Other, files(&["new.txt"]), |s| s.untracked_add("new.txt")));
    write(p, "junk.log", "垃圾\n");
    check(&mut s, "加入忽略规则", |s| scoped(s, "加入忽略规则", OpKind::Other, files(&[".gitignore"]), |s| s.untracked_ignore("junk.log")));
    write(p, "tmp/scratch.txt", "临时\n");
    check(&mut s, "删除未跟踪文件", |s| scoped(s, "删除未跟踪文件", OpKind::Other, files(&["tmp/scratch.txt"]), |s| s.untracked_delete("tmp/scratch.txt")));

    // ---------- 拉取 ----------
    git(p, &["add", "-A"]);
    git(p, &["commit", "-q", "-m", "收拾"]);
    let other = tempfile::tempdir().unwrap();
    let o = other.path();
    git(o, &["clone", "-q", origin.path().to_str().unwrap(), "."]);
    git(o, &["config", "user.name", "周远"]);
    git(o, &["config", "user.email", "zhouyuan@example.com"]);
    commit(o, "g.txt", "g1\n", "G1");
    git(o, &["push", "-q", "origin", "main"]);
    s.reload().unwrap();
    check(&mut s, "拉取（合并）", |s| {
        let before = s.snapshot()?;
        remote::pull(s.path(), PullMode::Merge, &Cancel::default(), &|_| {})?;
        s.op_end("拉取", OpKind::Pull, before)
    });
}
