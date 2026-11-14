//! Undo after abort (spec §8.9): aborting a merge or rebase is one log entry, and undoing it returns to the conflicts, resolved files and marks from before the abort.

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

/// main and feature both changed the same line of a.txt and b.txt; feature also added new.txt
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

    // a.txt resolved, b.txt not yet
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

    // Undo the abort: back in conflict, with the resolved a.txt, unresolved b.txt and marks restored
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
    // Back in conflict, redo isn't possible; this step shows as undone on the timeline
    assert!(!s.oplog_list(10).unwrap().can_redo);

    // Then finish: the whole merge is one entry (the before snapshot is back too), and undoing it returns to before the merge
    s.merge_take_file("b.txt", Side::Theirs).unwrap();
    assert!(s.merge_finish().unwrap().done);
    let fin = s.op_finish_pending().unwrap().expect("合并写成日志");
    assert_eq!(fin.label, "合并 feature");
    assert_eq!(ok(p, &["log", "-1", "--format=%p"]).split(' ').count(), 2);
    // The marks file is cleared after finishing
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

    // Abort once more, still back to before the rebase; git itself recognizes the rebase too
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
    // First an ordinary step, then merge and abort
    s.run_op("新建分支 x", OpKind::Branch, |s| s.branch_create("x", None, false)).unwrap();
    assert!(s.run_op("合并 feature", OpKind::Merge, |s| s.branch_merge("feature")).is_err());
    s.merge_abort_logged("中止合并", None).unwrap();
    let first = s.oplog_list(10).unwrap().entries.last().unwrap().id;
    // Undoing several steps at once stops at "abort merge": back in conflict, the earlier "create branch" untouched
    let done = s.oplog_undo(Some(first), false).unwrap();
    assert_eq!(done.len(), 1);
    assert_eq!(s.state().unwrap().state, RepoMode::Merging);
    assert!(ok(p, &["branch", "--list", "x"]).contains('x'));
    s.merge_abort_logged("中止合并", None).unwrap();

    // The conflicted files changed after the abort: the abort can't be undone
    write(p, "a.txt", "中止后改的\n");
    assert!(s.oplog_undo(None, false).is_err());
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(read(p, "a.txt"), "中止后改的\n");
}
