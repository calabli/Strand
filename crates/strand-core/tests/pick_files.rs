//! 只拣选或还原一个提交里的部分文件、把文件取回到某个版本。

use std::path::Path;
use std::process::Command;

use strand_core::error::ErrorCode;
use strand_core::Session;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn read(d: &Path, f: &str) -> String {
    std::fs::read_to_string(d.join(f)).unwrap_or_else(|_| "<无>".into())
}

/// main：a=1 b=1；side 上一个提交同时改 a、b，加 c
fn repo() -> (tempfile::TempDir, String) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "l@x.cn"]);
    std::fs::write(p.join("a.txt"), "a1\n").unwrap();
    std::fs::write(p.join("b.txt"), "b1\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "第一个"]);
    git(p, &["switch", "-q", "-c", "side"]);
    std::fs::write(p.join("a.txt"), "a2\n").unwrap();
    std::fs::write(p.join("b.txt"), "b2\n").unwrap();
    std::fs::write(p.join("c.txt"), "c\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "改三个"]);
    let id = git(p, &["rev-parse", "HEAD"]);
    git(p, &["switch", "-q", "main"]);
    (d, id)
}

#[test]
fn pick_only_some_files_into_worktree() {
    let (d, id) = repo();
    let s = Session::open(d.path()).unwrap();
    s.commit_files_apply(&id, &["a.txt".into(), "c.txt".into()], false).unwrap();
    assert_eq!(read(d.path(), "a.txt"), "a2\n");
    assert_eq!(read(d.path(), "b.txt"), "b1\n");
    assert_eq!(read(d.path(), "c.txt"), "c\n");
    // 没有生成提交
    assert_eq!(git(d.path(), &["log", "-1", "--format=%s"]), "第一个");
}

#[test]
fn revert_only_some_files() {
    let (d, id) = repo();
    git(d.path(), &["switch", "-q", "side"]);
    let s = Session::open(d.path()).unwrap();
    s.commit_files_apply(&id, &["b.txt".into(), "c.txt".into()], true).unwrap();
    assert_eq!(read(d.path(), "a.txt"), "a2\n");
    assert_eq!(read(d.path(), "b.txt"), "b1\n");
    assert_eq!(read(d.path(), "c.txt"), "<无>");
}

#[test]
fn pick_conflict_enters_resolution() {
    let (d, id) = repo();
    std::fs::write(d.path().join("a.txt"), "本地\n").unwrap();
    git(d.path(), &["commit", "-qam", "本地改 a"]);
    let s = Session::open(d.path()).unwrap();
    let e = s.commit_files_apply(&id, &["a.txt".into()], false).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflicts);
    assert!(git(d.path(), &["diff", "--name-only", "--diff-filter=U"]).contains("a.txt"));
}

#[test]
fn restore_file_from_revision() {
    let (d, id) = repo();
    let s = Session::open(d.path()).unwrap();
    s.file_restore(&id, "a.txt").unwrap();
    assert_eq!(read(d.path(), "a.txt"), "a2\n");
    // 只改工作区，不暂存
    assert_eq!(git(d.path(), &["diff", "--cached", "--name-only"]), "");
    // 这个版本里没有的文件：删掉
    std::fs::write(d.path().join("new.txt"), "x\n").unwrap();
    git(d.path(), &["add", "new.txt"]);
    git(d.path(), &["commit", "-qm", "加 new"]);
    let first = git(d.path(), &["rev-list", "--max-parents=0", "HEAD"]);
    s.file_restore(&first, "new.txt").unwrap();
    assert!(!d.path().join("new.txt").exists());
    assert!(s.file_restore(&first, "../x").is_err());
}

#[test]
fn file_bytes_at_revision_and_worktree() {
    let (d, id) = repo();
    let s = Session::open(d.path()).unwrap();
    assert_eq!(s.file_bytes("a.txt", Some(&id)).unwrap(), b"a2\n");
    assert_eq!(s.file_bytes("a.txt", Some(&format!("{id}^"))).unwrap(), b"a1\n");
    assert_eq!(s.file_bytes("a.txt", None).unwrap(), b"a1\n");
    assert_eq!(s.file_bytes("c.txt", Some(&format!("{id}^"))).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn revert_of_later_changed_file_explains() {
    let (d, _) = repo();
    let first = git(d.path(), &["rev-list", "--max-parents=0", "HEAD"]);
    std::fs::write(d.path().join("a.txt"), "改过\n").unwrap();
    git(d.path(), &["commit", "-qam", "改 a"]);
    let s = Session::open(d.path()).unwrap();
    // 第一个提交新建了 a.txt，还原就是删掉它；后来改过，删不了
    let e = s.commit_files_apply(&first, &["a.txt".into()], true).unwrap_err();
    assert_eq!(e.code, ErrorCode::GitFailed, "{e:?}");
    assert!(e.message.contains("后来又改过"), "{}", e.message);
    assert_eq!(read(d.path(), "a.txt"), "改过\n");
}

#[test]
fn worktree_binary_diff_is_flagged() {
    let (d, _) = repo();
    std::fs::write(d.path().join("a.txt"), b"\x00\x01\x02binary").unwrap();
    let s = Session::open(d.path()).unwrap();
    assert!(s.diff_worktree("a.txt", false, 3).unwrap().binary);
}
