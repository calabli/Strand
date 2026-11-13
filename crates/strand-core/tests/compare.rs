//! 比较、补丁、查看某个版本的仓库（说明书 10.3–10.5）。

use std::path::Path;
use std::process::Command;

use strand_core::model::{FileStatus, SelectedFile, Selection};
use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(p: &Path, file: &str, text: &str, msg: &str) -> String {
    if let Some(d) = Path::new(file).parent() {
        std::fs::create_dir_all(p.join(d)).unwrap();
    }
    std::fs::write(p.join(file), text).unwrap();
    git(p, &["add", file]);
    git(p, &["commit", "-q", "-m", msg]);
    git(p, &["rev-parse", "HEAD"])
}

/// main: A - B - C；feature 从 A 分出：F1 - F2
fn sample() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    commit(p, "a.txt", "a\n", "A");
    git(p, &["checkout", "-q", "-b", "feature"]);
    commit(p, "f.txt", "f1\n", "F1");
    commit(p, "src/lib.rs", "fn f() {}\n", "F2");
    git(p, &["checkout", "-q", "main"]);
    commit(p, "b.txt", "b\n", "B");
    commit(p, "a.txt", "a 改\n", "C");
    d
}

#[test]
fn compare_branches_and_files() {
    let d = sample();
    let p = d.path();
    let s = Session::open(p).unwrap();
    let c = s.compare("main", "feature").unwrap();
    let titles = |v: &Vec<strand_core::model::Commit>| v.iter().map(|x| x.title.clone()).collect::<Vec<_>>();
    assert_eq!(titles(&c.only_from), ["C", "B"]);
    assert_eq!(titles(&c.only_to), ["F2", "F1"]);
    assert!(!c.truncated);
    let files: Vec<(String, FileStatus)> = c.files.iter().map(|f| (f.path.clone(), f.status)).collect();
    assert!(files.contains(&("b.txt".into(), FileStatus::D)));
    assert!(files.contains(&("f.txt".into(), FileStatus::A)));
    assert!(files.contains(&("a.txt".into(), FileStatus::M)));

    let diff = s.diff_compare("main", "feature", "a.txt").unwrap();
    assert_eq!(diff.hunks.len(), 1);
    assert_eq!(s.compare("main", "不存在").unwrap_err().code, ErrorCode::NotFound);

    // 和本地比较：不能是最新提交本身
    let head = git(p, &["rev-parse", "HEAD"]);
    assert!(!s.commit_caps(&head).unwrap().compare_local.ok);
    let a = git(p, &["rev-parse", "HEAD~2"]);
    assert!(s.commit_caps(&a).unwrap().compare_local.ok);
    let local = s.compare(&a, "HEAD").unwrap();
    assert!(local.only_from.is_empty() && local.only_to.len() == 2);
}

#[test]
fn patches_and_tree() {
    let d = sample();
    let p = d.path();
    let s = Session::open(p).unwrap();
    let patch = s.patch_commit("feature").unwrap();
    assert!(patch.starts_with("From "));
    assert!(patch.contains("Subject: [PATCH] F2"));
    assert!(patch.contains("+fn f() {}"));

    std::fs::write(p.join("a.txt"), "工作区里改\n").unwrap();
    std::fs::write(p.join("b.txt"), "不选\n").unwrap();
    let sel = Selection { files: vec![SelectedFile { path: "a.txt".into(), old_path: None, whole: true, lines: vec![] }] };
    let wp = s.patch_worktree(&sel).unwrap();
    assert!(wp.contains("+工作区里改") && !wp.contains("不选"));
    // 补丁能原样应用回去
    git(p, &["checkout", "--", "a.txt"]);
    std::fs::write(p.join("x.patch"), &wp).unwrap();
    git(p, &["apply", "x.patch"]);
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "工作区里改\n");
    assert_eq!(s.patch_worktree(&Selection { files: vec![] }).unwrap_err().code, ErrorCode::NothingSelected);

    assert_eq!(s.commit_tree("feature").unwrap(), ["a.txt", "f.txt", "src/lib.rs"]);
}
