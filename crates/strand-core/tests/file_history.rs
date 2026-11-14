//! Project files, file content, file change chain (following renames), diff between two versions.

use std::path::Path;
use std::process::Command;

use strand_core::model::FileStatus;
use strand_core::Session;

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
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(dir: &Path, f: &str, s: &str) {
    let p = dir.join(f);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, s).unwrap();
}

/// Add a → change a → rename to b (changing a line too) → change another file → change b; b also has uncommitted changes in the worktree
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    write(p, "src/a.txt", "一\n二\n三\n四\n五\n六\n");
    write(p, ".gitignore", "*.log\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "加 a"]);
    write(p, "src/a.txt", "一\n二（改）\n三\n四\n五\n六\n");
    git(p, &["commit", "-q", "-am", "改 a"]);
    git(p, &["mv", "src/a.txt", "src/b.txt"]);
    write(p, "src/b.txt", "一\n二（改）\n三\n四\n五\n六\n七\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "改名成 b"]);
    write(p, "other.txt", "无关\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "别的文件"]);
    write(p, "src/b.txt", "一\n二（改）\n三\n四（再改）\n五\n六\n七\n");
    git(p, &["commit", "-q", "-am", "改 b"]);
    write(p, "src/b.txt", "一\n二（改）\n三\n四（再改）\n五\n六\n七\n八（没提交）\n");
    write(p, "new.txt", "未跟踪\n");
    write(p, "debug.log", "被忽略\n");
    d
}

#[test]
fn project_files_include_untracked_but_not_ignored() {
    let d = repo();
    let s = Session::open(d.path()).unwrap();
    assert_eq!(s.project_files().unwrap(), [".gitignore", "new.txt", "other.txt", "src/b.txt"]);
}

#[test]
fn history_follows_renames() {
    let d = repo();
    let s = Session::open(d.path()).unwrap();
    let h = s.file_history("src/b.txt").unwrap();
    assert!(!h.truncated);
    let got: Vec<(&str, FileStatus, &str)> = h.versions.iter().map(|v| (v.commit.title.as_str(), v.status, v.path.as_str())).collect();
    assert_eq!(got, [("改 b", FileStatus::M, "src/b.txt"), ("改名成 b", FileStatus::R, "src/b.txt"), ("改 a", FileStatus::M, "src/a.txt"), ("加 a", FileStatus::A, "src/a.txt")]);
    assert_eq!(h.versions[1].old_path.as_deref(), Some("src/a.txt"));
    assert_eq!((h.versions[0].added, h.versions[0].deleted), (1, 1));
    assert_eq!(h.versions[3].added, 6);
    // Commits in the log carry full info (refs)
    assert!(h.versions[0].commit.refs.iter().any(|r| r.name == "main"));
}

#[test]
fn text_at_versions_and_worktree() {
    let d = repo();
    let s = Session::open(d.path()).unwrap();
    let now = s.file_text("src/b.txt", None).unwrap();
    assert!(now.text.unwrap().ends_with("八（没提交）\n"));
    let first = git(d.path(), &["rev-list", "--max-parents=0", "HEAD"]);
    let old = s.file_text("src/a.txt", Some(&first)).unwrap();
    assert_eq!(old.text.as_deref(), Some("一\n二\n三\n四\n五\n六\n"));
    assert!(s.file_text("src/b.txt", Some(&first)).unwrap().missing);
    assert!(s.file_text("没有.txt", None).unwrap().missing);
}

#[test]
fn diff_between_versions_across_rename_and_with_worktree() {
    let d = repo();
    let s = Session::open(d.path()).unwrap();
    let first = git(d.path(), &["rev-list", "--max-parents=0", "HEAD"]);
    // The earliest version (old path) against the latest commit (new path)
    let fd = s.file_diff_versions(Some(&first), "src/a.txt", Some("HEAD"), "src/b.txt").unwrap();
    let adds: Vec<&str> = fd.hunks.iter().flat_map(|h| h.lines.iter()).filter(|l| matches!(l.kind, strand_core::model::LineKind::Add)).map(|l| l.text.as_str()).collect();
    assert_eq!(adds, ["二（改）", "四（再改）", "七"]);
    // The latest commit against the worktree
    let fd = s.file_diff_versions(Some("HEAD"), "src/b.txt", None, "src/b.txt").unwrap();
    let adds: Vec<&str> = fd.hunks.iter().flat_map(|h| h.lines.iter()).filter(|l| matches!(l.kind, strand_core::model::LineKind::Add)).map(|l| l.text.as_str()).collect();
    assert_eq!(adds, ["八（没提交）"]);
    // Added: the old side doesn't have it
    let fd = s.file_diff_versions(None, "src/a.txt", Some(&first), "src/a.txt").unwrap();
    assert_eq!(fd.hunks[0].lines.len(), 6);
    // Identical: no change blocks
    assert!(s.file_diff_versions(Some("HEAD"), "other.txt", None, "other.txt").unwrap().hunks.is_empty());
}

/// Full view in the diff window: with a very large context the whole file is one block; with the default 3 lines only around the changes
#[test]
fn full_context_diff_contains_whole_file() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    let body: String = (1..=40).map(|i| format!("第 {i} 行\n")).collect();
    write(p, "f.txt", &body);
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "一"]);
    write(p, "f.txt", &body.replace("第 20 行\n", "第 20 行（改）\n"));
    git(p, &["commit", "-q", "-am", "二"]);
    let s = Session::open(p).unwrap();
    let id = git(p, &["rev-parse", "HEAD"]);
    let short = s.diff_commit(&id, "f.txt").unwrap();
    assert_eq!(short.hunks.len(), 1);
    assert_eq!(short.hunks[0].lines.len(), 8, "改动前后各 3 行");
    let full = s.diff_commit_ctx(&id, "f.txt", 1_000_000).unwrap();
    assert_eq!(full.hunks.len(), 1);
    assert_eq!(full.hunks[0].lines.len(), 41, "40 行加一行删除");
    let first = git(p, &["rev-parse", "HEAD~1"]);
    assert_eq!(s.diff_compare_ctx(&first, &id, "f.txt", 1_000_000).unwrap().hunks[0].lines.len(), 41);
    assert_eq!(s.file_diff_versions_ctx(Some(&first), "f.txt", Some(&id), "f.txt", 1_000_000).unwrap().hunks[0].lines.len(), 41);
}

#[test]
fn save_worktree_file_checks_path_and_concurrent_change() {
    let d = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    let before = s.file_text("src/b.txt", None).unwrap().text.unwrap();
    s.save_worktree_file("src/b.txt", "改好了\n", &before).unwrap();
    assert_eq!(std::fs::read_to_string(p.join("src/b.txt")).unwrap(), "改好了\n");
    // Don't overwrite when the file on disk changed (differs from what was read when editing started)
    let err = s.save_worktree_file("src/b.txt", "又改\n", &before).unwrap_err();
    assert!(matches!(err.code, strand_core::error::ErrorCode::StateDiverged));
    assert_eq!(std::fs::read_to_string(p.join("src/b.txt")).unwrap(), "改好了\n");
    // Escaping the repository, writing into .git, and nonexistent files are all rejected
    for bad in ["../x.txt", ".git/config", "/etc/hosts", "src", "nope.txt"] {
        assert!(s.save_worktree_file(bad, "x", "").is_err(), "{bad}");
    }
    // A CRLF file is still CRLF after saving
    write(p, "w.txt", "a\r\nb\r\n");
    s.save_worktree_file("w.txt", "a\nc\n", "a\r\nb\r\n").unwrap();
    assert_eq!(std::fs::read_to_string(p.join("w.txt")).unwrap(), "a\r\nc\r\n");
}
