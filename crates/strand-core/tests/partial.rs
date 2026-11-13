//! 部分克隆（git clone --filter=blob:none）：文件内容不在本地时先一次下载；下载不了时列表照常、行数标成不可用。

use std::path::Path;
use std::process::Command;

use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

/// 源仓库两个提交；部分克隆只检出最新的，第一个提交里的旧内容不在本地
fn setup() -> (tempfile::TempDir, std::path::PathBuf, String) {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("src");
    std::fs::create_dir(&src).unwrap();
    git(&src, &["init", "-q", "-b", "main"]);
    git(&src, &["config", "user.name", "林夏"]);
    git(&src, &["config", "user.email", "linxia@example.com"]);
    git(&src, &["config", "uploadpack.allowFilter", "true"]);
    std::fs::write(src.join("a.txt"), "一\n二\n").unwrap();
    std::fs::write(src.join("b.txt"), "b\n").unwrap();
    git(&src, &["add", "."]);
    git(&src, &["commit", "-q", "-m", "初始提交"]);
    std::fs::write(src.join("a.txt"), "一\n二改\n三\n").unwrap();
    std::fs::write(src.join("b.txt"), "b2\n").unwrap();
    git(&src, &["commit", "-q", "-am", "改两处"]);
    let id = git(&src, &["rev-parse", "HEAD"]);
    let url = format!("file://{}", src.display());
    git(d.path(), &["clone", "-q", "--filter=blob:none", &url, "part"]);
    (d, src, id)
}

fn missing(dir: &Path) -> usize {
    git(dir, &["rev-list", "--objects", "--all", "--missing=print"]).lines().filter(|l| l.starts_with('?')).count()
}

#[test]
fn downloads_missing_contents_once() {
    let (d, _src, id) = setup();
    let part = d.path().join("part");
    assert_eq!(missing(&part), 2, "第一个提交里 a.txt、b.txt 的旧内容不在本地");
    let s = Session::open(&part).unwrap();
    let det = s.commit_detail(&id).unwrap();
    let a = det.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!((a.added, a.deleted, a.no_stats), (2, 1, false));
    assert_eq!(missing(&part), 0, "两个一次下载下来了");
    assert_eq!(s.diff_commit(&id, "b.txt").unwrap().hunks.len(), 1);
}

#[test]
fn offline_keeps_the_list() {
    let (d, src, id) = setup();
    let part = d.path().join("part");
    // 远程没了：下载失败
    std::fs::remove_dir_all(&src).unwrap();
    let s = Session::open(&part).unwrap();
    let det = s.commit_detail(&id).unwrap();
    assert_eq!(det.files.len(), 2);
    assert!(det.files.iter().all(|f| f.no_stats), "{:?}", det.files);
    let e = s.diff_commit(&id, "a.txt").unwrap_err();
    assert_eq!(e.code, ErrorCode::Network);
    assert!(e.message.contains("部分克隆"));
}
