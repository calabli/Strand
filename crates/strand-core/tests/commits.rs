//! Commit operations and availability (spec §5.6, §5.7).

use std::path::Path;
use std::process::Command;

use strand_core::commits::ResetMode;
use strand_core::model::RepoMode;
use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success() || args[0] == "cherry-pick", "git {:?}：{}", args, String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(p: &Path, file: &str, text: &str, msg: &str) -> String {
    std::fs::write(p.join(file), text).unwrap();
    git(p, &["add", file]);
    git(p, &["commit", "-q", "-m", msg]);
    git(p, &["rev-parse", "HEAD"])
}

struct Repo {
    _origin: tempfile::TempDir,
    dir: tempfile::TempDir,
    a: String,
    b: String,
    c: String,
    d: String,
    f: String,
}

/// main: A - B (pushed) - C - D (unpushed); feature: B - F
fn sample() -> Repo {
    let origin = tempfile::tempdir().unwrap();
    git(origin.path(), &["init", "-q", "--bare", "-b", "main"]);
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    let a = commit(p, "a.txt", "a\n", "A");
    let b = commit(p, "b.txt", "b\n", "B");
    git(p, &["remote", "add", "origin", origin.path().to_str().unwrap()]);
    git(p, &["push", "-q", "-u", "origin", "main"]);
    git(p, &["checkout", "-q", "-b", "feature"]);
    let f = commit(p, "f.txt", "f\n", "F 加 f");
    git(p, &["checkout", "-q", "main"]);
    let c = commit(p, "c.txt", "c\n", "C");
    let d = commit(p, "d.txt", "d\n", "D");
    Repo { _origin: origin, dir, a, b, c, d, f }
}

#[test]
fn unpushed_and_caps() {
    let r = sample();
    let s = Session::open(r.dir.path()).unwrap();
    let rows = s.log_page(0, 50).unwrap().rows;
    let unpushed = |id: &str| rows.iter().find(|c| c.id == id).unwrap().unpushed;
    assert!(unpushed(&r.c) && unpushed(&r.d));
    assert!(!unpushed(&r.a) && !unpushed(&r.b) && !unpushed(&r.f));

    let d = s.commit_caps(&r.d).unwrap();
    assert!(d.undo.ok && d.reword.ok && d.drop.ok && d.revert.ok);
    assert!(!d.reset.ok && !d.cherry_pick.ok);
    assert_eq!(d.cherry_pick.why.as_deref(), Some("这个提交已经在当前分支的历史里"));
    assert_eq!(d.parent.as_deref(), Some(r.c.as_str()));
    assert_eq!(d.child, None);

    let c = s.commit_caps(&r.c).unwrap();
    assert!(c.reset.ok && c.drop.ok && !c.undo.ok);
    assert!(c.reword.ok, "更早的未推送提交也能改说明");
    assert_eq!(c.child.as_deref(), Some(r.d.as_str()));

    let b = s.commit_caps(&r.b).unwrap();
    assert!(b.reset.ok, "B 之后只有未推送的提交");
    assert_eq!(b.reword.why.as_deref(), Some("这个提交已经推送"));
    assert_eq!(s.commit_caps(&r.f).unwrap().reword.why.as_deref(), Some("这个提交不在当前分支的历史里"));
    assert!(!b.drop.ok && b.revert.ok);
    let a = s.commit_caps(&r.a).unwrap();
    assert!(!a.reset.ok, "A 之后的 B 已经推送");
    assert_eq!(a.reset.why.as_deref(), Some("它之后有已经推送的提交"));

    let f = s.commit_caps(&r.f).unwrap();
    assert!(f.cherry_pick.ok && !f.revert.ok && !f.reset.ok);
}

#[test]
fn cherry_pick_revert_undo_reword() {
    let r = sample();
    let p = r.dir.path();
    let mut s = Session::open(p).unwrap();
    s.commit_cherry_pick(std::slice::from_ref(&r.f)).unwrap();
    s.reload().unwrap();
    assert_eq!(git(p, &["log", "-1", "--format=%s"]), "F 加 f");
    assert!(p.join("f.txt").exists());
    // A cherry-picked commit isn't in the history (different hash), so it can be picked again; new commits on the current branch are unpushed
    let top = s.log_page(0, 1).unwrap().rows.remove(0);
    assert!(top.unpushed);

    s.commit_revert(&r.c).unwrap();
    s.reload().unwrap();
    assert_eq!(git(p, &["log", "-1", "--format=%s"]), "还原“C”");
    assert!(!p.join("c.txt").exists());

    let head = git(p, &["rev-parse", "HEAD"]);
    s.commit_reword(&head, "还原 C（改过说明）").unwrap();
    s.reload().unwrap();
    assert_eq!(git(p, &["log", "-1", "--format=%s"]), "还原 C（改过说明）");
    assert_eq!(s.commit_reword(&git(p, &["rev-parse", "HEAD"]), "  ").unwrap_err().code, ErrorCode::EmptyMessage);

    s.commit_undo().unwrap();
    s.reload().unwrap();
    assert_eq!(git(p, &["log", "-1", "--format=%s"]), "F 加 f");
    // Changes stay in the worktree (c.txt's deletion is still there)
    assert!(git(p, &["status", "--porcelain"]).contains("c.txt"));

    // Rejected when unavailable
    assert_eq!(s.commit_reword(&r.b, "x").unwrap_err().code, ErrorCode::InvalidRange);
}

#[test]
fn cherry_pick_empty_commits() {
    let r = sample();
    let p = r.dir.path();
    // A commit that was empty to begin with: still picked
    git(p, &["checkout", "-q", "feature"]);
    git(p, &["commit", "-q", "--allow-empty", "-m", "空提交"]);
    let empty = git(p, &["rev-parse", "HEAD"]);
    // Changes identical to what's already on main: empty after picking, skipped automatically, not left in the cherry-pick state
    let dup = commit(p, "c.txt", "c\n", "和 C 一样");
    git(p, &["checkout", "-q", "main"]);
    let mut s = Session::open(p).unwrap();
    s.commit_cherry_pick(&[dup, empty]).unwrap();
    s.reload().unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(git(p, &["log", "-2", "--format=%s"]), "空提交\nD");
}

#[test]
fn reset_modes_and_drop() {
    let r = sample();
    let p = r.dir.path();
    let mut s = Session::open(p).unwrap();
    s.commit_drop(&r.c).unwrap();
    s.reload().unwrap();
    assert_eq!(git(p, &["log", "--format=%s", "-3"]), "D\nB\nA");
    assert!(!p.join("c.txt").exists() && p.join("d.txt").exists());

    // Mixed reset to B: D's changes go back to the worktree, not staged
    s.commit_reset(&r.b, ResetMode::Mixed).unwrap();
    s.reload().unwrap();
    assert_eq!(git(p, &["rev-parse", "HEAD"]), r.b);
    assert_eq!(git(p, &["status", "--porcelain"]), "?? d.txt");

    // Hard reset: commit again first, then discard
    git(p, &["add", "d.txt"]);
    git(p, &["commit", "-q", "-m", "D2"]);
    s.reload().unwrap();
    s.commit_reset(&r.b, ResetMode::Hard).unwrap();
    assert!(!p.join("d.txt").exists());
    assert_eq!(git(p, &["status", "--porcelain"]), "");
}

#[test]
fn cherry_pick_conflict_stops_and_caps_turn_off() {
    let r = sample();
    let p = r.dir.path();
    // Change d.txt again on feature, conflicting with D on main
    git(p, &["checkout", "-q", "feature"]);
    let g = commit(p, "d.txt", "feature 的 d\n", "G 改 d");
    git(p, &["checkout", "-q", "main"]);
    let mut s = Session::open(p).unwrap();
    let err = s.commit_cherry_pick(&[g.clone(), r.f.clone()]).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflicts);
    s.reload().unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::CherryPicking);
    let caps = s.commit_caps(&r.d).unwrap();
    assert!(!caps.undo.ok && !caps.checkout.ok);
    assert_eq!(caps.undo.why.as_deref(), Some("合并或变基还没完成"));
    s.merge_abort().unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), r.d);
}

/// Reword an earlier commit (spec §5.6): the message is replaced via rebase and later commits are reattached as they are; worktree changes are kept; can be undone
#[test]
fn reword_earlier_commit() {
    let r = sample();
    let p = r.dir.path();
    let mut s = Session::open(p).unwrap();
    std::fs::write(p.join("a.txt"), "a 改\n").unwrap();
    let tree = git(p, &["rev-parse", "HEAD^{tree}"]);
    s.run_op("修改说明", strand_core::oplog::OpKind::Commit, |s| s.commit_reword(&r.c, "C（改过说明）\n\n正文")).unwrap();
    assert_eq!(git(p, &["log", "-2", "--format=%s"]), "D\nC（改过说明）");
    assert_eq!(git(p, &["log", "-1", "--format=%b", "HEAD~1"]), "正文");
    assert_eq!(git(p, &["rev-parse", "HEAD^{tree}"]), tree, "改动不变");
    assert_eq!(git(p, &["rev-parse", "HEAD~2"]), r.b, "接在原来的位置");
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "a 改\n", "工作区改动保留");
    assert_eq!(s.state().unwrap().state, strand_core::model::RepoMode::Normal);
    s.reload().unwrap();
    assert_eq!(s.commit_reword(&git(p, &["rev-parse", "HEAD~1"]), " ").unwrap_err().code, ErrorCode::EmptyMessage);

    s.oplog_undo(None, false).unwrap();
    assert_eq!(git(p, &["rev-parse", "HEAD"]), r.d);
}
