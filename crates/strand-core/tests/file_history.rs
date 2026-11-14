//! 项目文件、文件内容、文件修改链（跟着重命名）、两个版本之间的差异。

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

/// 加 a → 改 a → 改名成 b（顺手改了一行）→ 改别的文件 → 改 b；工作区里 b 还有没提交的改动
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
    // 在日志里的提交带完整信息（引用）
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
    // 最早的版本（旧路径）对比最新提交（新路径）
    let fd = s.file_diff_versions(Some(&first), "src/a.txt", Some("HEAD"), "src/b.txt").unwrap();
    let adds: Vec<&str> = fd.hunks.iter().flat_map(|h| h.lines.iter()).filter(|l| matches!(l.kind, strand_core::model::LineKind::Add)).map(|l| l.text.as_str()).collect();
    assert_eq!(adds, ["二（改）", "四（再改）", "七"]);
    // 最新提交对比工作区
    let fd = s.file_diff_versions(Some("HEAD"), "src/b.txt", None, "src/b.txt").unwrap();
    let adds: Vec<&str> = fd.hunks.iter().flat_map(|h| h.lines.iter()).filter(|l| matches!(l.kind, strand_core::model::LineKind::Add)).map(|l| l.text.as_str()).collect();
    assert_eq!(adds, ["八（没提交）"]);
    // 新增：旧的一边没有
    let fd = s.file_diff_versions(None, "src/a.txt", Some(&first), "src/a.txt").unwrap();
    assert_eq!(fd.hunks[0].lines.len(), 6);
    // 相同：没有修改块
    assert!(s.file_diff_versions(Some("HEAD"), "other.txt", None, "other.txt").unwrap().hunks.is_empty());
}
