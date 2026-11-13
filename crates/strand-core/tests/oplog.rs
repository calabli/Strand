//! 操作日志、撤销和重做（说明书第 11 节）。

use std::path::Path;
use std::process::Command;

use strand_core::model::{RepoMode, SelectedFile, Selection};
use strand_core::oplog::OpKind;
use strand_core::{ErrorCode, Session};

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

fn read(dir: &Path, f: &str) -> String {
    std::fs::read_to_string(dir.join(f)).unwrap_or_default()
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    write(p, "a.txt", "a1\n");
    write(p, "b.txt", "b1\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "初始提交"]);
    d
}

fn sel(files: &[&str]) -> Selection {
    Selection { files: files.iter().map(|f| SelectedFile { path: f.to_string(), old_path: None, whole: true, lines: vec![] }).collect() }
}

fn head(p: &Path) -> String {
    git(p, &["rev-parse", "HEAD"])
}

#[test]
fn undo_and_redo_a_commit_keeps_the_changes() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    let start = head(p);
    write(p, "a.txt", "a2\n");
    let (id, op) = s.run_op("提交“改 a”", OpKind::Commit, |s| s.commit_create("改 a", &sel(&["a.txt"]), false)).unwrap();
    let op = op.expect("提交应该记入日志");
    assert_eq!(op.label, "提交“改 a”");
    assert_eq!(head(p), id);

    let list = s.oplog_list(10).unwrap();
    assert!(list.can_undo && !list.can_redo);

    let undone = s.oplog_undo(None, false).unwrap();
    assert_eq!(undone[0].id, op.id);
    assert_eq!(head(p), start, "提交被撤掉");
    assert_eq!(read(p, "a.txt"), "a2\n", "改动留在工作区");
    assert!(git(p, &["status", "--porcelain"]).contains("a.txt"));
    let list = s.oplog_list(10).unwrap();
    assert!(list.can_redo && !list.can_undo);

    s.oplog_redo().unwrap();
    assert_eq!(head(p), id, "重做后提交回来");
    assert_eq!(git(p, &["status", "--porcelain"]), "");
}

#[test]
fn switch_create_delete_and_multi_step_undo() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    let (_, create) = s.run_op("新建分支 feature", OpKind::Branch, |s| s.branch_create("feature", None, true)).unwrap();
    write(p, "c.txt", "c1\n");
    git(p, &["add", "c.txt"]);
    s.run_op("提交", OpKind::Commit, |s| s.commit_create("加 c", &sel(&["c.txt"]), false)).unwrap();
    s.run_op("切换到 main", OpKind::Switch, |s| s.branch_switch("main", false)).unwrap();
    assert!(!p.join("c.txt").exists());
    s.run_op("删除分支 feature", OpKind::Branch, |s| s.branch_delete("feature", true)).unwrap();
    assert_eq!(git(p, &["branch", "--list", "feature"]), "");

    // 一步：删除撤销，分支回来
    s.oplog_undo(None, false).unwrap();
    assert_eq!(git(p, &["branch", "--list", "feature"]), "feature");
    // 再一步：切换撤销，回到 feature，文件回来
    s.oplog_undo(None, false).unwrap();
    assert_eq!(git(p, &["branch", "--show-current"]), "feature");
    assert_eq!(read(p, "c.txt"), "c1\n");

    // 退回到“新建分支”之前：提交和新建一起撤销
    let undone = s.oplog_undo(Some(create.unwrap().id), false).unwrap();
    assert_eq!(undone.len(), 2);
    assert_eq!(git(p, &["branch", "--show-current"]), "main");
    assert_eq!(git(p, &["branch", "--list", "feature"]), "");
    // 撤销提交不丢改动：c.txt 回到提交前的样子（已加入索引、还没提交）
    assert_eq!(git(p, &["status", "--porcelain"]), "A  c.txt");

    // 重做一次恢复这两步
    let redone = s.oplog_redo().unwrap();
    assert_eq!(redone.len(), 2);
    assert_eq!(git(p, &["branch", "--show-current"]), "feature");
    assert_eq!(read(p, "c.txt"), "c1\n");
    // 再重做前面单独撤销的两步
    s.oplog_redo().unwrap();
    s.oplog_redo().unwrap();
    assert_eq!(git(p, &["branch", "--show-current"]), "main");
    assert_eq!(git(p, &["branch", "--list", "feature"]), "");

    // 撤销后做新操作，重做列表清空
    s.oplog_undo(None, false).unwrap();
    s.run_op("新建标签 v1", OpKind::Tag, |s| s.tag_create("v1", "HEAD")).unwrap();
    assert!(!s.oplog_list(10).unwrap().can_redo);
}

#[test]
fn unrelated_edits_survive_and_conflicting_edits_diverge() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    write(p, "a.txt", "a2\n");
    s.run_op("提交 a", OpKind::Commit, |s| s.commit_create("改 a", &sel(&["a.txt"]), false)).unwrap();
    write(p, "b.txt", "我在改 b\n");
    write(p, "new.txt", "新文件\n");
    s.oplog_undo(None, false).unwrap();
    assert_eq!(read(p, "b.txt"), "我在改 b\n", "别的文件上的改动保留");
    assert_eq!(read(p, "new.txt"), "新文件\n");
    s.oplog_redo().unwrap();

    // 提交后又改了同一个文件：撤销提交只改回索引，工作区里的新改动保留
    write(p, "a.txt", "a3\n");
    s.run_op("提交 a3", OpKind::Commit, |s| s.commit_create("a3", &sel(&["a.txt"]), false)).unwrap();
    write(p, "a.txt", "又改了\n");
    s.oplog_undo(None, false).unwrap();
    assert_eq!(read(p, "a.txt"), "又改了\n");
    s.oplog_redo().unwrap();

    // 在外面用 git 移动了分支：不能撤销，而且更早的也标记为不能撤销
    git(p, &["reset", "-q", "--soft", "HEAD~1"]);
    let err = s.oplog_undo(None, false).unwrap_err();
    assert_eq!(err.code, ErrorCode::StateDiverged);
    let list = s.oplog_list(10).unwrap();
    assert!(!list.can_undo);
    assert!(list.entries.iter().filter(|e| !e.undone).all(|e| !e.undoable));
}

#[test]
fn push_needs_confirmation_and_log_survives_reopen() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    s.run_op("新建分支 x", OpKind::Branch, |s| s.branch_create("x", None, false)).unwrap();
    s.op_note("推送到 origin/main", OpKind::Push).unwrap();
    let err = s.oplog_undo(None, false).unwrap_err();
    assert_eq!(err.code, ErrorCode::AlreadyPushed);
    s.oplog_undo(None, true).unwrap();
    assert_eq!(git(p, &["branch", "--list", "x"]), "");
    s.oplog_redo().unwrap();

    // 快照引用不出现在日志和分支里
    assert!(git(p, &["for-each-ref", "refs/strand/ops"]).lines().count() >= 2);
    let page = s.log_page(0, 50).unwrap();
    assert!(page.rows.iter().all(|c| !c.title.starts_with("strand op")));

    drop(s);
    let mut s = Session::open(p).unwrap();
    let list = s.oplog_list(10).unwrap();
    assert_eq!(list.entries.len(), 2);
    assert_eq!(list.entries[0].kind, OpKind::Push);
    assert!(list.can_undo && !list.can_redo, "重做列表不跨重启");
}

#[test]
fn merge_with_conflicts_is_one_step() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    git(p, &["checkout", "-q", "-b", "side"]);
    write(p, "a.txt", "side\n");
    git(p, &["commit", "-q", "-am", "side 改 a"]);
    git(p, &["checkout", "-q", "main"]);
    write(p, "a.txt", "main\n");
    git(p, &["commit", "-q", "-am", "main 改 a"]);
    s.reload().unwrap();
    let start = head(p);

    let r = s.run_op("把 side 合并到 main", OpKind::Merge, |s| s.branch_merge("side"));
    assert_eq!(r.unwrap_err().code, ErrorCode::Conflicts);
    assert_eq!(s.state().unwrap().state, RepoMode::Merging);
    assert!(s.oplog_list(10).unwrap().entries.is_empty(), "冲突解决完之前不记日志");

    write(p, "a.txt", "合起来\n");
    git(p, &["add", "a.txt"]);
    s.merge_finish().unwrap();
    let op = s.op_finish_pending().unwrap().expect("完成后写成一条");
    assert_eq!(op.label, "把 side 合并到 main");

    s.oplog_undo(None, false).unwrap();
    assert_eq!(head(p), start);
    assert_eq!(read(p, "a.txt"), "main\n");
    assert_eq!(git(p, &["status", "--porcelain"]), "");

    // 中止的合并不记日志
    s.run_op("合并", OpKind::Merge, |s| s.branch_merge("side")).unwrap_err();
    s.merge_abort().unwrap();
    s.op_drop_pending().unwrap();
    assert_eq!(s.oplog_list(10).unwrap().entries.len(), 1);
}

/// 说明书第 16 节“外部修改”：在命令行里提交、切换分支、改了这一步改过的文件后，时间线上这一步和更早的显示为不能撤销；
/// 没碰到这一步改过的东西时照样可以撤销；外部又改回去就恢复。
#[test]
fn external_changes_mark_affected_steps() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    let top = |s: &mut Session| {
        let l = s.oplog_list(10).unwrap();
        (l.can_undo, l.entries[0].undoable, l.entries[0].reason.clone())
    };

    // 新建标签：之后在命令行里提交，标签没动，仍然可以撤销
    s.run_op("新建标签 v1", OpKind::Tag, |s| s.tag_create("v1", "HEAD")).unwrap();
    write(p, "b.txt", "b2\n");
    git(p, &["commit", "-qam", "命令行提交"]);
    assert_eq!(top(&mut s), (true, true, None), "没碰到这一步改过的东西");

    // 提交：之后在命令行里又提交一次，main 变了
    s.reload().unwrap();
    write(p, "a.txt", "a2\n");
    s.run_op("提交 a", OpKind::Commit, |s| s.commit_create("改 a", &sel(&["a.txt"]), false)).unwrap();
    let mine = head(p);
    git(p, &["commit", "-q", "--allow-empty", "-m", "命令行又提交"]);
    let (can, ok, why) = top(&mut s);
    assert!(!can && !ok);
    assert_eq!(why.as_deref(), Some("main 在别处被修改过"));
    let l = s.oplog_list(10).unwrap();
    assert!(l.entries.iter().all(|e| !e.undoable), "更早的步骤也不能撤销");
    // 改回去就恢复
    git(p, &["reset", "-q", "--soft", &mine]);
    assert_eq!(top(&mut s), (true, true, None));

    // 切换分支
    git(p, &["switch", "-q", "-c", "other"]);
    assert_eq!(top(&mut s).2.as_deref(), Some("HEAD 在别处被修改过"));
    git(p, &["switch", "-q", "main"]);
    assert_eq!(top(&mut s), (true, true, None));

    // 丢弃改动：之后又在别处改了同一个文件
    s.reload().unwrap();
    write(p, "a.txt", "a3\n");
    s.run_op("丢弃改动", OpKind::Other, |s| s.changes_discard(&["a.txt".into()])).unwrap();
    write(p, "b.txt", "b 无关的改动\n");
    assert_eq!(top(&mut s), (true, true, None), "改别的文件不影响");
    write(p, "a.txt", "a 在编辑器里改的\n");
    assert_eq!(top(&mut s).2.as_deref(), Some("a.txt 在别处被修改过"));
    assert_eq!(s.oplog_undo(None, false).unwrap_err().code, ErrorCode::StateDiverged);
}
