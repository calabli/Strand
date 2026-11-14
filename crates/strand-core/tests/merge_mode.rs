//! Merge modes (spec §6.3, §6.7): no fast-forward, squash merge (including finishing after conflict resolution, and aborting).

use std::path::Path;
use std::process::Command;

use strand_core::model::{MergeMode, MergeResult, RepoMode};
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

/// main: initial commit; feature branches from here: f1, f2 (main unchanged, can fast-forward)
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    commit(p, "a.txt", "a\n", "初始提交");
    git(p, &["switch", "-q", "-c", "feature"]);
    commit(p, "f.txt", "f1\n", "f1");
    commit(p, "g.txt", "g\n", "f2");
    git(p, &["switch", "-q", "main"]);
    d
}

fn parents(p: &Path) -> usize {
    git(p, &["rev-list", "--parents", "-n", "1", "HEAD"]).split(' ').count() - 1
}

#[test]
fn no_ff_always_creates_merge_commit() {
    let d = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    assert_eq!(s.branch_merge_mode("feature", MergeMode::NoFf).unwrap(), MergeResult::Merged);
    assert_eq!(parents(p), 2, "能快进时也生成合并提交");
    assert_eq!(s.branch_merge_mode("feature", MergeMode::NoFf).unwrap(), MergeResult::UpToDate);
}

#[test]
fn squash_makes_one_plain_commit_and_undo() {
    let d = repo();
    let p = d.path();
    let before = git(p, &["rev-parse", "HEAD"]);
    let mut s = Session::open(p).unwrap();
    let (r, _) = s.run_op("压缩合并 feature", OpKind::Merge, |s| s.branch_merge_mode("feature", MergeMode::Squash)).unwrap();
    assert_eq!(r, MergeResult::Squashed);
    assert_eq!(parents(p), 1, "只有一个父提交");
    assert_eq!(git(p, &["rev-parse", "HEAD~1"]), before);
    assert_eq!(git(p, &["log", "-1", "--format=%B"]), "压缩合并 feature\n\n* f2\n* f1");
    assert!(p.join("f.txt").exists() && p.join("g.txt").exists());
    assert_eq!(git(p, &["status", "--porcelain"]), "");
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    // feature isn't recorded as merged in
    assert_ne!(git(p, &["merge-base", "HEAD", "feature"]), git(p, &["rev-parse", "feature"]));
    s.oplog_undo(None, false).unwrap();
    assert_eq!(git(p, &["rev-parse", "HEAD"]), before);
}

/// Spec §6.7: let the user edit the message before a squash merge; the prefilled message equals the one used when unedited
#[test]
fn squash_with_edited_message() {
    let d = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    assert_eq!(s.squash_message("feature", None).unwrap(), "压缩合并 feature\n\n* f2\n* f1");
    assert_eq!(s.branch_merge_with("feature", MergeMode::Squash, Some("  新功能：f 和 g\n\n两个文件\n ")).unwrap(), MergeResult::Squashed);
    assert_eq!(git(p, &["log", "-1", "--format=%B"]), "新功能：f 和 g\n\n两个文件");
}

#[test]
fn squash_with_conflict_finishes_as_one_commit() {
    let d = repo();
    let p = d.path();
    commit(p, "f.txt", "main 的 f\n", "main 改 f");
    let before = git(p, &["rev-parse", "HEAD"]);
    let s = Session::open(p).unwrap();
    let e = s.branch_merge_mode("feature", MergeMode::Squash).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflicts, "{e:?}");
    assert_eq!(s.state().unwrap().state, RepoMode::Merging);
    // Finish after resolving conflicts: still a normal commit
    std::fs::write(p.join("f.txt"), "合好的 f\n").unwrap();
    git(p, &["add", "f.txt"]);
    assert!(s.merge_finish().unwrap().done);
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(parents(p), 1);
    assert_eq!(git(p, &["rev-parse", "HEAD~1"]), before);
    assert!(git(p, &["log", "-1", "--format=%s"]).starts_with("压缩合并 feature"));
    assert_eq!(std::fs::read_to_string(p.join("f.txt")).unwrap(), "合好的 f\n");
    assert!(!p.join(".git/strand/squash").exists());
}

#[test]
fn squash_conflict_abort_and_stale_marker() {
    let d = repo();
    let p = d.path();
    commit(p, "f.txt", "main 的 f\n", "main 改 f");
    let before = git(p, &["rev-parse", "HEAD"]);
    let s = Session::open(p).unwrap();
    assert_eq!(s.branch_merge_mode("feature", MergeMode::Squash).unwrap_err().code, ErrorCode::Conflicts);
    s.merge_abort().unwrap();
    assert_eq!(git(p, &["rev-parse", "HEAD"]), before);
    assert!(!p.join(".git/strand/squash").exists());

    // A squash merge stopped on conflicts and aborted on the command line; a later normal merge creates a merge commit as usual
    assert_eq!(s.branch_merge_mode("feature", MergeMode::Squash).unwrap_err().code, ErrorCode::Conflicts);
    git(p, &["merge", "--abort"]);
    assert_eq!(s.branch_merge("feature").unwrap_err().code, ErrorCode::Conflicts);
    std::fs::write(p.join("f.txt"), "合好的 f\n").unwrap();
    git(p, &["add", "f.txt"]);
    s.merge_finish().unwrap();
    assert_eq!(parents(p), 2, "旧的压缩合并记录作废了");
}

#[test]
fn squash_of_changes_already_here_does_nothing() {
    let d = repo();
    let p = d.path();
    git(p, &["cherry-pick", "feature~1", "feature"]);
    let before = git(p, &["rev-parse", "HEAD"]);
    let s = Session::open(p).unwrap();
    assert_eq!(s.branch_merge_mode("feature", MergeMode::Squash).unwrap(), MergeResult::UpToDate);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), before);
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
}
