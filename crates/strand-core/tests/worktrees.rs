//! 工作目录（说明书 6.6）和克隆。

use std::path::Path;
use std::process::Command;

use strand_core::remote::{self, Cancel};
use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    std::fs::write(p.join("a.txt"), "a\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "初始提交"]);
    git(p, &["branch", "feature"]);
    d
}

#[test]
fn add_list_and_remove() {
    let d = repo();
    let p = d.path();
    let outer = tempfile::tempdir().unwrap();
    let wt = outer.path().join("feature-wt");
    let s = Session::open(p).unwrap();

    s.worktree_add(wt.to_str().unwrap(), "feature", false, None).unwrap();
    let list = s.worktree_list().unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[0].is_main && list[0].is_current);
    assert_eq!(list[1].branch.as_deref(), Some("feature"));
    assert!(!list[1].is_main && !list[1].is_current);

    // 分支列表里标出在别处检出的分支；在这里切换过去给出好懂的说明
    let refs = s.refs_list().unwrap();
    let f = refs.branches.iter().find(|b| b.name == "feature").unwrap();
    assert!(f.worktree.as_deref().unwrap().ends_with("feature-wt"));
    assert_eq!(refs.worktrees.len(), 2);
    let e = s.branch_switch("feature", false).unwrap_err();
    assert!(e.message.contains("已经在工作目录") && e.message.contains("feature-wt"), "{}", e.message);

    // 同一个分支不能检出两次；非空文件夹不行；相对路径不行
    let e = s.worktree_add(outer.path().join("again").to_str().unwrap(), "feature", false, None).unwrap_err();
    assert!(e.message.contains("同一个分支不能同时检出两次"), "{}", e.message);
    assert!(!outer.path().join("again").exists());
    std::fs::create_dir(outer.path().join("full")).unwrap();
    std::fs::write(outer.path().join("full/x"), "").unwrap();
    assert_eq!(s.worktree_add(outer.path().join("full").to_str().unwrap(), "main", false, None).unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(s.worktree_add("rel/path", "main", false, None).unwrap_err().code, ErrorCode::InvalidName);

    // 新建分支并检出
    let wt2 = outer.path().join("fix");
    s.worktree_add(wt2.to_str().unwrap(), "fix/x", true, Some("main")).unwrap();
    assert_eq!(git(&wt2, &["branch", "--show-current"]), "fix/x");
    let e = s.worktree_add(outer.path().join("fix2").to_str().unwrap(), "fix/x", true, None).unwrap_err();
    assert!(e.message.contains("已经存在"), "{}", e.message);
    assert_eq!(s.worktree_add(outer.path().join("bad").to_str().unwrap(), "a..b", true, None).unwrap_err().code, ErrorCode::InvalidName);

    // 有改动时要确认
    std::fs::write(wt.join("new.txt"), "n").unwrap();
    let e = s.worktree_remove(wt.to_str().unwrap(), false).unwrap_err();
    assert_eq!(e.code, ErrorCode::WorktreeConflict);
    assert!(wt.exists());
    s.worktree_remove(wt.to_str().unwrap(), true).unwrap();
    assert!(!wt.exists());

    // 文件夹被删掉了：只清理记录
    std::fs::remove_dir_all(&wt2).unwrap();
    assert!(s.worktree_list().unwrap().iter().any(|w| w.prunable));
    s.worktree_remove(wt2.to_str().unwrap(), false).unwrap();
    assert_eq!(s.worktree_list().unwrap().len(), 1);

    // 主工作目录不能移除
    assert!(s.worktree_remove(p.to_str().unwrap(), true).is_err());
}

#[test]
fn open_a_linked_worktree() {
    let d = repo();
    let outer = tempfile::tempdir().unwrap();
    let wt = outer.path().join("wt");
    Session::open(d.path()).unwrap().worktree_add(wt.to_str().unwrap(), "feature", false, None).unwrap();
    // 在工作目录里打开：当前的是它，主仓库不是
    let s = Session::open(&wt).unwrap();
    let list = s.worktree_list().unwrap();
    assert!(list[0].is_main && !list[0].is_current);
    assert!(list[1].is_current);
    assert!(s.worktree_remove(wt.to_str().unwrap(), true).is_err(), "不能移除正在打开的");
}

#[test]
fn clone_local_repository() {
    let src = repo();
    let outer = tempfile::tempdir().unwrap();
    let dest = outer.path().join("copy");
    let url = src.path().to_str().unwrap();
    let lines = std::sync::Mutex::new(0);
    remote::clone(url, &dest, &Cancel::default(), &|_| *lines.lock().unwrap() += 1).unwrap();
    assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), "a\n");
    assert_eq!(git(&dest, &["rev-parse", "--abbrev-ref", "origin/HEAD"]), "origin/main");

    // 目标不是空文件夹
    assert_eq!(remote::clone(url, &dest, &Cancel::default(), &|_| {}).unwrap_err().code, ErrorCode::InvalidName);
    // 地址不对：报错，不留半截的文件夹
    let bad = outer.path().join("bad");
    let e = remote::clone(outer.path().join("nothing-here").to_str().unwrap(), &bad, &Cancel::default(), &|_| {}).unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound, "{e:?}");
    assert!(!bad.exists());
    // 空文件夹可以用，失败后还是空的
    std::fs::create_dir(&bad).unwrap();
    assert!(remote::clone("/nope/nope", &bad, &Cancel::default(), &|_| {}).is_err());
    assert!(bad.exists() && std::fs::read_dir(&bad).unwrap().next().is_none());
    // 不能把选项当地址
    assert_eq!(remote::clone("--upload-pack=x", &outer.path().join("o"), &Cancel::default(), &|_| {}).unwrap_err().code, ErrorCode::InvalidName);
}
