//! 中止后撤销（说明书 8.9）：中止合并或变基写成一条日志，撤销它回到中止前的冲突、已解决的文件和标记。

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use strand_core::conflict::{ChangeMark, Mark, SessionKind, Side};
use strand_core::model::RepoMode;
use strand_core::oplog::OpKind;
use strand_core::Session;

fn git(dir: &Path, args: &[&str]) -> (bool, String) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_EDITOR", "true")
        .output()
        .unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn ok(dir: &Path, args: &[&str]) -> String {
    let (s, o) = git(dir, args);
    assert!(s, "git {args:?} 失败");
    o
}

fn write(dir: &Path, f: &str, s: &str) {
    std::fs::write(dir.join(f), s).unwrap();
}

fn read(dir: &Path, f: &str) -> String {
    std::fs::read_to_string(dir.join(f)).unwrap_or_default()
}

/// main 和 feature 都改了 a.txt 和 b.txt 的同一行；feature 另外加了 new.txt
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    ok(p, &["init", "-q", "-b", "main"]);
    ok(p, &["config", "user.name", "林夏"]);
    ok(p, &["config", "user.email", "linxia@example.com"]);
    ok(p, &["config", "commit.gpgsign", "false"]);
    write(p, "a.txt", "1\n2\n3\n");
    write(p, "b.txt", "x\ny\n");
    ok(p, &["add", "."]);
    ok(p, &["commit", "-q", "-m", "初始提交"]);
    ok(p, &["switch", "-q", "-c", "feature"]);
    write(p, "a.txt", "1\n2 对方\n3\n");
    write(p, "b.txt", "x 对方\ny\n");
    write(p, "new.txt", "对方新加的\n");
    ok(p, &["add", "."]);
    ok(p, &["commit", "-q", "-m", "feature 的修改"]);
    ok(p, &["switch", "-q", "main"]);
    write(p, "a.txt", "1\n2 你的\n3\n");
    write(p, "b.txt", "x 你的\ny\n");
    ok(p, &["commit", "-q", "-am", "main 的修改"]);
    d
}

fn unresolved(s: &Session) -> Vec<String> {
    s.merge_session().unwrap().unwrap().files.iter().filter(|f| !f.resolved).map(|f| f.path.clone()).collect()
}

#[test]
fn undo_abort_restores_merge_conflicts_and_marks() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    let main = ok(p, &["rev-parse", "main"]);
    assert!(s.run_op("合并 feature", OpKind::Merge, |s| s.branch_merge("feature")).is_err());
    assert_eq!(s.state().unwrap().state, RepoMode::Merging);

    // 解决了 a.txt，b.txt 还没解决
    let mut marks = HashMap::new();
    marks.insert("c1".to_string(), ChangeMark { mine: Mark::Accept, theirs: Mark::Accept, custom: None });
    s.merge_apply_file("a.txt", &marks).unwrap();
    assert_eq!(unresolved(&s), ["b.txt"]);
    let b_conflict = read(p, "b.txt");
    assert!(b_conflict.contains("<<<<<<<"));
    let front = serde_json::json!({ "strand.marks:x": { "marks": { "b.txt": { "c1": { "mine": "accept" } } }, "resolved": ["a.txt"] } });

    let (_, op) = s.merge_abort_logged("中止合并", Some(front.clone())).unwrap();
    let op = op.expect("中止写成一条日志");
    assert_eq!(op.label, "中止合并");
    assert!(op.undoable);
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(ok(p, &["rev-parse", "HEAD"]), main);
    assert_eq!(read(p, "a.txt"), "1\n2 你的\n3\n");
    assert!(!p.join("new.txt").exists());
    assert!(s.merge_session().unwrap().is_none());

    // 撤销中止：回到冲突中，已解决的 a.txt、没解决的 b.txt、标记都回来
    let done = s.oplog_undo(None, false).unwrap();
    assert_eq!(done.len(), 1);
    assert_eq!(s.state().unwrap().state, RepoMode::Merging);
    assert_eq!(read(p, "a.txt"), "1\n2 你的\n2 对方\n3\n");
    assert_eq!(read(p, "b.txt"), b_conflict);
    assert_eq!(read(p, "new.txt"), "对方新加的\n");
    let ms = s.merge_session().unwrap().unwrap();
    assert_eq!(ms.kind, SessionKind::Merge);
    assert_eq!(ms.saved_marks, Some(front));
    assert_eq!(unresolved(&s), ["b.txt"]);
    assert!(ms.files.iter().any(|f| f.path == "a.txt" && f.resolved));
    // 回到冲突中不能重做；时间线上这一步显示为已撤销
    assert!(!s.oplog_list(10).unwrap().can_redo);

    // 接着完成：整个合并写成一条日志（开始前的快照也回来了），撤销它回到合并前
    s.merge_take_file("b.txt", Side::Theirs).unwrap();
    assert!(s.merge_finish().unwrap().done);
    let fin = s.op_finish_pending().unwrap().expect("合并写成日志");
    assert_eq!(fin.label, "合并 feature");
    assert_eq!(ok(p, &["log", "-1", "--format=%p"]).split(' ').count(), 2);
    // 完成后标记文件清掉
    assert!(!p.join(".git/strand/marks.json").exists());
    s.oplog_undo(None, false).unwrap();
    assert_eq!(ok(p, &["rev-parse", "HEAD"]), main);
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert!(ok(p, &["status", "--porcelain"]).is_empty());
}

#[test]
fn undo_abort_restores_rebase_in_progress() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    let main = ok(p, &["rev-parse", "main"]);
    assert!(s.run_op("变基到 feature", OpKind::Merge, |s| s.branch_rebase("feature")).is_err());
    assert_eq!(s.state().unwrap().state, RepoMode::Rebasing);
    let head = ok(p, &["rev-parse", "HEAD"]);
    let a_conflict = read(p, "a.txt");

    s.merge_abort_logged("中止变基", None).unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(ok(p, &["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(ok(p, &["rev-parse", "HEAD"]), main);

    s.oplog_undo(None, false).unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Rebasing);
    assert_eq!(ok(p, &["rev-parse", "HEAD"]), head);
    assert_eq!(read(p, "a.txt"), a_conflict);
    let ms = s.merge_session().unwrap().unwrap();
    assert_eq!(ms.kind, SessionKind::Rebase);
    assert_eq!(ms.step.unwrap().index, 1);
    assert!(ms.saved_marks.is_none());

    // 再中止一次，仍然回到变基之前；git 自己也认这个变基
    let (_, op) = s.merge_abort_logged("中止变基", None).unwrap();
    assert!(op.is_some());
    assert_eq!(ok(p, &["rev-parse", "HEAD"]), main);
    assert_eq!(ok(p, &["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert!(ok(p, &["status", "--porcelain"]).is_empty());
}

#[test]
fn undo_stops_at_abort_and_refuses_when_changed_after() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    // 先有一步普通的操作，再合并、中止
    s.run_op("新建分支 x", OpKind::Branch, |s| s.branch_create("x", None, false)).unwrap();
    assert!(s.run_op("合并 feature", OpKind::Merge, |s| s.branch_merge("feature")).is_err());
    s.merge_abort_logged("中止合并", None).unwrap();
    let first = s.oplog_list(10).unwrap().entries.last().unwrap().id;
    // 一次退回多步时停在“中止合并”：回到冲突中，更早的“新建分支”不动
    let done = s.oplog_undo(Some(first), false).unwrap();
    assert_eq!(done.len(), 1);
    assert_eq!(s.state().unwrap().state, RepoMode::Merging);
    assert!(ok(p, &["branch", "--list", "x"]).contains('x'));
    s.merge_abort_logged("中止合并", None).unwrap();

    // 中止后又改了冲突涉及的文件：不能撤销中止
    write(p, "a.txt", "中止后改的\n");
    assert!(s.oplog_undo(None, false).is_err());
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(read(p, "a.txt"), "中止后改的\n");
}
