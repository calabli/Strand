//! Rebase the current branch onto another branch (spec §6.3).

use std::path::Path;
use std::process::Command;

use strand_core::model::{RebaseOutcome, RepoMode};
use strand_core::oplog::OpKind;
use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

fn commit(dir: &Path, file: &str, text: &str, msg: &str) {
    std::fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", msg]);
}

/// main: initial → m1; feature branches from initial: f1, f2 (changing different files)
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    commit(p, "a.txt", "a\n", "初始提交");
    git(p, &["switch", "-q", "-c", "feature"]);
    commit(p, "f.txt", "f1\n", "f1");
    commit(p, "f.txt", "f1\nf2\n", "f2");
    git(p, &["switch", "-q", "main"]);
    commit(p, "m.txt", "m1\n", "m1");
    git(p, &["switch", "-q", "feature"]);
    d
}

#[test]
fn rebase_onto_main_and_undo() {
    let d = repo();
    let p = d.path();
    let before = git(p, &["rev-parse", "HEAD"]);
    let mut s = Session::open(p).unwrap();
    let plan = s.branch_rebase_plan("main").unwrap();
    assert_eq!((plan.own, plan.incoming, plan.pushed, plan.has_merge), (2, 1, 0, false));
    assert_eq!(plan.branch, "feature");

    // Uncommitted worktree changes: stashed automatically and restored after
    std::fs::write(p.join("a.txt"), "a 改\n").unwrap();
    let (r, _op) = s.run_op("把 feature 变基到 main 之上", OpKind::Merge, |s| s.branch_rebase("main")).unwrap();
    assert_eq!(r, RebaseOutcome::Rebased);
    assert_eq!(git(p, &["log", "--format=%s", "main..HEAD"]), "f2\nf1");
    assert_eq!(git(p, &["merge-base", "HEAD", "main"]), git(p, &["rev-parse", "main"]), "接在 main 最新提交之后");
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "a 改\n");
    assert_eq!(git(p, &["branch", "--show-current"]), "feature");

    // Again: already on top
    assert_eq!(s.branch_rebase("main").unwrap(), RebaseOutcome::UpToDate);

    // Undo goes back to before the rebase
    s.oplog_undo(None, false).unwrap();
    assert_eq!(git(p, &["rev-parse", "feature"]), before);
}

#[test]
fn fast_forward_when_nothing_own() {
    let d = repo();
    let p = d.path();
    git(p, &["switch", "-q", "-c", "behind", "main~1"]);
    let s = Session::open(p).unwrap();
    assert_eq!(s.branch_rebase("main").unwrap(), RebaseOutcome::FastForward);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), git(p, &["rev-parse", "main"]));
}

#[test]
fn merge_commits_are_refused() {
    let d = repo();
    let p = d.path();
    git(p, &["switch", "-q", "-c", "side", "main~1"]);
    commit(p, "s.txt", "s\n", "s1");
    git(p, &["switch", "-q", "feature"]);
    git(p, &["merge", "-q", "--no-edit", "side"]);
    let s = Session::open(p).unwrap();
    assert!(s.branch_rebase_plan("main").unwrap().has_merge);
    let e = s.branch_rebase("main").unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidRange);
    assert!(e.message.contains("合并提交"));
}

#[test]
fn conflict_stops_in_rebase_and_abort_restores() {
    let d = repo();
    let p = d.path();
    // main also changed f.txt: conflicts with feature
    git(p, &["switch", "-q", "main"]);
    commit(p, "f.txt", "main 的 f\n", "main 改 f");
    git(p, &["switch", "-q", "feature"]);
    let before = git(p, &["rev-parse", "HEAD"]);
    let s = Session::open(p).unwrap();
    let e = s.branch_rebase("main").unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflicts, "{e:?}");
    assert_eq!(s.state().unwrap().state, RepoMode::Rebasing);
    s.merge_abort().unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), before);
}

#[test]
fn pushed_commits_are_counted() {
    let d = repo();
    let p = d.path();
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(p, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    git(p, &["push", "-q", "origin", "feature"]);
    commit(p, "g.txt", "g\n", "f3 未推送");
    let s = Session::open(p).unwrap();
    let plan = s.branch_rebase_plan("main").unwrap();
    assert_eq!((plan.own, plan.pushed), (3, 2));
    assert!(s.branch_rebase_plan("nope").is_err());
    git(p, &["switch", "-q", "--detach"]);
    assert!(s.branch_rebase_plan("main").is_err(), "不在分支上");
}

#[test]
fn rebased_pushed_branch_needs_force() {
    let d = repo();
    let p = d.path();
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(p, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    git(p, &["push", "-q", "-u", "origin", "feature", "main"]);
    let mut s = Session::open(p).unwrap();
    let feature = |s: &Session| s.refs_list().unwrap().branches.into_iter().find(|b| b.name == "feature").unwrap();
    assert!(!feature(&s).needs_force);

    // The rebase rewrote pushed f1 and f2: every remote-only commit has a rewritten version locally
    s.run_op("变基", OpKind::Merge, |s| s.branch_rebase("main")).unwrap();
    let b = feature(&s);
    assert_eq!((b.ahead, b.behind, b.needs_force), (3, 2, true));

    // The marker disappears after a force push
    git(p, &["push", "-q", "--force-with-lease", "origin", "feature"]);
    assert!(!feature(&s).needs_force);

    // Only others' new commits on the remote: behind, but no force push needed
    git(p, &["switch", "-q", "main"]);
    git(p, &["reset", "-q", "--hard", "main~1"]);
    let m = s.refs_list().unwrap().branches.into_iter().find(|b| b.name == "main").unwrap();
    assert_eq!((m.behind, m.needs_force), (1, false));
}

/// The branch list computes rebase availability up front so the menu greys it out (spec §6.3)
#[test]
fn rebase_block_in_refs_list() {
    let d = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    let block = |s: &Session, n: &str| s.refs_list().unwrap().branches.into_iter().find(|b| b.name == n).unwrap().rebase_block;
    // On feature: main has new commits, so rebase is possible; itself doesn't count
    assert_eq!(block(&s, "main"), None);
    assert_eq!(block(&s, "feature"), None);

    // On main: feature isn't an ancestor, so yes; old, which is behind (an ancestor of main), is already on top
    git(p, &["switch", "-q", "main"]);
    git(p, &["branch", "old", "main~1"]);
    assert_eq!(block(&s, "feature"), None);
    assert!(block(&s, "old").unwrap().contains("已经在 old 之上"));

    // Own commits include a merge commit
    git(p, &["merge", "-q", "--no-edit", "feature"]);
    git(p, &["switch", "-q", "-c", "base", "main~1"]);
    commit(p, "x.txt", "x\n", "x");
    git(p, &["switch", "-q", "main"]);
    assert!(block(&s, "base").unwrap().contains("合并提交"));

    // Remote branches count too; all empty when not on a branch
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(p, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    git(p, &["push", "-q", "origin", "old"]);
    git(p, &["fetch", "-q", "origin"]);
    let r = s.refs_list().unwrap().remotes.into_iter().find(|r| r.name == "origin/old").unwrap();
    assert!(r.rebase_block.unwrap().contains("已经在 origin/old 之上"));
    git(p, &["switch", "-q", "--detach"]);
    assert!(s.refs_list().unwrap().branches.iter().all(|b| b.rebase_block.is_none()));
}
