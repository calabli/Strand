//! Applying patches: inspect a patch and whether it applies; apply to the worktree (including conflicts); create commits from mailbox format; roll back entirely when it doesn't match.

use std::path::Path;
use std::process::Command;

use strand_core::model::FileStatus;
use strand_core::patch::PatchFit;
use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "林夏")
        .env("GIT_AUTHOR_EMAIL", "l@x.cn")
        .env("GIT_COMMITTER_NAME", "林夏")
        .env("GIT_COMMITTER_EMAIL", "l@x.cn")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn write(dir: &Path, f: &str, s: &str) {
    let p = dir.join(f);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, s).unwrap();
}

/// A repository with two commits; returns (repository, format-patch of the second commit, plain diff of the second commit), with the repository reset to the first commit
fn repo() -> (tempfile::TempDir, String, String) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "l@x.cn"]);
    write(p, "a.txt", "一\n二\n三\n");
    write(p, "gone.txt", "要删\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "初始"]);
    write(p, "a.txt", "一\n二（改）\n三\n");
    write(p, "new/b.txt", "新文件\n");
    std::fs::remove_file(p.join("gone.txt")).unwrap();
    git(p, &["add", "-A"]);
    git(p, &["commit", "-q", "-m", "改 a，加 b", "-m", "正文一行"]);
    let mail = git(p, &["format-patch", "-1", "--stdout"]);
    let plain = git(p, &["diff", "HEAD~1", "HEAD"]);
    git(p, &["reset", "-q", "--hard", "HEAD~1"]);
    (d, mail, plain)
}

#[test]
fn preview_lists_files_commits_and_fit() {
    let (d, mail, plain) = repo();
    let s = Session::open(d.path()).unwrap();
    let pv = s.patch_preview(&mail).unwrap();
    assert_eq!(pv.fit, PatchFit::Clean);
    assert_eq!(pv.commits.len(), 1);
    assert_eq!(pv.commits[0].title, "改 a，加 b");
    assert_eq!(pv.commits[0].author, "林夏");
    let st = |p: &str| pv.files.iter().find(|f| f.path == p).map(|f| (f.status, f.added, f.deleted));
    assert!(matches!(st("a.txt"), Some((FileStatus::M, 1, 1))));
    assert!(matches!(st("new/b.txt"), Some((FileStatus::A, 1, 0))));
    assert!(matches!(st("gone.txt"), Some((FileStatus::D, 0, 1))));
    // A plain diff has no commits
    assert!(s.patch_preview(&plain).unwrap().commits.is_empty());
    // Not a patch
    assert!(matches!(s.patch_preview("随便一段文字").unwrap_err().code, ErrorCode::InvalidRange));
    // The same line changed locally: only a three-way apply is possible (it will conflict)
    write(d.path(), "a.txt", "一\n二（本地）\n三\n");
    git(d.path(), &["commit", "-qam", "本地改"]);
    assert_ne!(s.patch_preview(&plain).unwrap().fit, PatchFit::Clean);
}

#[test]
fn apply_as_commit_and_to_worktree() {
    let (d, mail, plain) = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    assert_eq!(s.patch_apply(&mail, true).unwrap(), 1);
    assert_eq!(git(p, &["log", "-1", "--format=%s%n%b"]).trim(), "改 a，加 b\n正文一行");
    assert_eq!(git(p, &["status", "--porcelain"]), "");

    let (d2, _, plain2) = repo();
    let s2 = Session::open(d2.path()).unwrap();
    assert_eq!(s2.patch_apply(&plain2, false).unwrap(), 0);
    assert_eq!(std::fs::read_to_string(d2.path().join("a.txt")).unwrap(), "一\n二（改）\n三\n");
    assert!(d2.path().join("new/b.txt").exists() && !d2.path().join("gone.txt").exists());
    // A plain diff can't create commits
    let (d3, _, _) = repo();
    assert!(Session::open(d3.path()).unwrap().patch_apply(&plain, true).is_err());
}

#[test]
fn conflicts_enter_resolution_and_failed_am_rolls_back() {
    let (d, mail, plain) = repo();
    let p = d.path();
    write(p, "a.txt", "一\n二（本地）\n三\n");
    git(p, &["commit", "-qam", "本地改"]);
    let head = git(p, &["rev-parse", "HEAD"]);
    let s = Session::open(p).unwrap();
    // Creating commits failed: rolled back entirely, not left inside am
    assert!(matches!(s.patch_apply(&mail, true).unwrap_err().code, ErrorCode::GitFailed));
    assert_eq!(git(p, &["rev-parse", "HEAD"]), head);
    assert!(!p.join(".git/rebase-apply").exists());
    // Apply to the worktree: conflicts, entering restore conflict resolution
    assert!(matches!(s.patch_apply(&plain, false).unwrap_err().code, ErrorCode::Conflicts));
    let u = s.unstash().expect("进入取回进行中");
    assert_eq!(u.label, "补丁");
    assert!(std::fs::read_to_string(p.join("a.txt")).unwrap().contains("<<<<<<<"));
}
