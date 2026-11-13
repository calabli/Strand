//! 修订上一次提交（说明书 4.5）。

use std::path::Path;
use std::process::Command;

use strand_core::model::{LineKind, LineRef, SelectedFile, Selection};
use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn whole(p: &str) -> SelectedFile {
    SelectedFile { path: p.into(), old_path: None, whole: true, lines: vec![] }
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    std::fs::write(p.join("a.txt"), "a\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "第一个"]);
    std::fs::write(p.join("b.txt"), (1..=20).map(|i| format!("{i}\n")).collect::<String>()).unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "第二个\n\n正文"]);
    d
}

#[test]
fn amend_files_and_message() {
    let d = repo();
    let p = d.path();
    let parent = git(p, &["rev-parse", "HEAD~1"]);
    let s = Session::open(p).unwrap();
    // 说明为空：保留原说明，改动并进去
    std::fs::write(p.join("a.txt"), "a 改\n").unwrap();
    s.commit_amend(None, &Selection { files: vec![whole("a.txt")] }, false).unwrap();
    assert_eq!(git(p, &["log", "-1", "--format=%B"]), "第二个\n\n正文");
    assert_eq!(git(p, &["show", "HEAD:a.txt"]), "a 改");
    assert_eq!(git(p, &["rev-parse", "HEAD~1"]), parent, "还是同一个父提交");
    assert_eq!(git(p, &["rev-list", "--count", "HEAD"]), "2");
    assert_eq!(git(p, &["status", "--porcelain"]), "");

    // 只改说明
    let mut s = Session::open(p).unwrap();
    s.commit_amend(Some("第二个（改过）"), &Selection { files: vec![] }, false).unwrap();
    s.reload().unwrap();
    assert_eq!(git(p, &["log", "-1", "--format=%s"]), "第二个（改过）");
    assert_eq!(s.commit_amend(Some("  "), &Selection { files: vec![] }, false).unwrap_err().code, ErrorCode::NothingSelected);
}

#[test]
fn amend_some_lines() {
    let d = repo();
    let p = d.path();
    let changed: String = (1..=20).map(|i| if i == 2 { "二\n".to_string() } else if i == 19 { "十九\n".to_string() } else { format!("{i}\n") }).collect();
    std::fs::write(p.join("b.txt"), &changed).unwrap();
    let s = Session::open(p).unwrap();
    let d0 = s.diff_worktree("b.txt", false, 3).unwrap();
    let lines: Vec<LineRef> = d0.hunks[0].lines.iter().enumerate().filter(|(_, l)| l.kind != LineKind::Context).map(|(j, _)| LineRef { hunk: 0, line: j as u32 }).collect();
    s.commit_amend(None, &Selection { files: vec![SelectedFile { path: "b.txt".into(), old_path: None, whole: false, lines }] }, false).unwrap();
    let committed = git(p, &["show", "HEAD:b.txt"]);
    assert!(committed.contains("二\n") && committed.contains("19"));
    assert_eq!(git(p, &["log", "-1", "--format=%s"]), "第二个");
    assert_eq!(git(p, &["status", "--porcelain"]), "M b.txt");
}

#[test]
fn cannot_amend_pushed_commit() {
    let d = repo();
    let p = d.path();
    let origin = tempfile::tempdir().unwrap();
    git(origin.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(p, &["remote", "add", "origin", origin.path().to_str().unwrap()]);
    git(p, &["push", "-q", "-u", "origin", "main"]);
    std::fs::write(p.join("a.txt"), "a 改\n").unwrap();
    let s = Session::open(p).unwrap();
    let e = s.commit_amend(None, &Selection { files: vec![whole("a.txt")] }, false).unwrap_err();
    assert_eq!(e.code, ErrorCode::AlreadyPushed);
}
