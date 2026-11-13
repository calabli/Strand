//! 用系统 git 建一个临时仓库，检查打开、状态和日志分页。

use std::path::Path;
use std::process::Command;

use strand_core::model::{HeadKind, RefKind, RepoMode};
use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "林夏")
        .env("GIT_AUTHOR_EMAIL", "linxia@example.com")
        .env("GIT_COMMITTER_NAME", "林夏")
        .env("GIT_COMMITTER_EMAIL", "linxia@example.com")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("需要安装 git 才能运行这个测试");
    assert!(out.status.success(), "git {:?} 失败：{}", args, String::from_utf8_lossy(&out.stderr));
}

fn commit(dir: &Path, file: &str, msg: &str, t: u32) {
    std::fs::write(dir.join(file), msg).unwrap();
    git(dir, &["add", file]);
    let date = format!("{} +0800", 1_700_000_000 + t);
    let out = Command::new("git")
        .args(["commit", "-q", "-m", msg])
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "林夏")
        .env("GIT_AUTHOR_EMAIL", "linxia@example.com")
        .env("GIT_COMMITTER_NAME", "林夏")
        .env("GIT_COMMITTER_EMAIL", "linxia@example.com")
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

/// main: A - B ------- M
///             \      /
/// feature:      C - D
fn sample_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    commit(d, "a.txt", "初始提交", 1);
    commit(d, "b.txt", "添加 b\n\n正文第一行", 2);
    git(d, &["checkout", "-q", "-b", "feature"]);
    commit(d, "c.txt", "功能 C", 3);
    commit(d, "d.txt", "功能 D", 4);
    git(d, &["checkout", "-q", "main"]);
    let out = Command::new("git")
        .args(["merge", "-q", "--no-ff", "-m", "合并 feature", "feature"])
        .current_dir(d)
        .env("GIT_AUTHOR_NAME", "林夏")
        .env("GIT_AUTHOR_EMAIL", "linxia@example.com")
        .env("GIT_COMMITTER_NAME", "林夏")
        .env("GIT_COMMITTER_EMAIL", "linxia@example.com")
        .env("GIT_AUTHOR_DATE", "1700000005 +0800")
        .env("GIT_COMMITTER_DATE", "1700000005 +0800")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success());
    git(d, &["tag", "v0.1.0", "HEAD~1"]);
    dir
}

#[test]
fn opens_and_reads_state() {
    let dir = sample_repo();
    // 从子目录打开也能找到仓库根
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    let s = Session::open(dir.path().join("sub")).unwrap();
    let st = s.state().unwrap();
    assert_eq!(st.head.kind, HeadKind::Branch);
    assert_eq!(st.head.branch.as_deref(), Some("main"));
    assert_eq!(st.state, RepoMode::Normal);
    assert_eq!(st.head.commit.as_ref().map(|c| c.len()), Some(40));
}

#[test]
fn reads_log_with_refs_and_graph() {
    let dir = sample_repo();
    let s = Session::open(dir.path()).unwrap();
    let page = s.log_page(0, 100).unwrap();
    assert_eq!(page.total, 5);
    let titles: Vec<&str> = page.rows.iter().map(|c| c.title.as_str()).collect();
    assert_eq!(titles, vec!["合并 feature", "功能 D", "功能 C", "添加 b", "初始提交"]);

    let merge = &page.rows[0];
    assert!(merge.is_merge);
    assert!(merge.refs.iter().any(|r| r.kind == RefKind::Branch && r.name == "main"));
    assert!(page.rows[1].refs.iter().any(|r| r.kind == RefKind::Branch && r.name == "feature"));
    assert!(page.rows[3].refs.iter().any(|r| r.kind == RefKind::Tag && r.name == "v0.1.0"));
    assert_eq!(page.rows[3].body, "正文第一行");
    assert_eq!(page.rows[4].author.name, "林夏");
    assert_eq!(page.rows[4].time, 1_700_000_001);

    // 合并提交在泳道 0，feature 的两个提交在泳道 1
    let lanes: Vec<u32> = page.graph.iter().map(|g| g.lane).collect();
    assert_eq!(lanes, vec![0, 1, 1, 0, 0]);
    assert_eq!(page.lanes, 2);
}

#[test]
fn pages_are_slices() {
    let dir = sample_repo();
    let s = Session::open(dir.path()).unwrap();
    let p = s.log_page(3, 10).unwrap();
    assert_eq!(p.offset, 3);
    assert_eq!(p.rows.len(), 2);
    assert_eq!(p.graph.len(), 2);
    assert_eq!(s.log_page(99, 10).unwrap().rows.len(), 0);
}

#[test]
fn rejects_non_repo() {
    let dir = tempfile::tempdir().unwrap();
    let err = Session::open(dir.path()).err().unwrap();
    assert_eq!(err.code, ErrorCode::NotARepo);
}

#[test]
fn parents_never_before_children_in_the_same_second() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    // 所有提交同一时间：只按时间排序会乱
    commit(d, "a.txt", "初始提交", 0);
    git(d, &["checkout", "-q", "-b", "feature"]);
    commit(d, "f.txt", "功能", 0);
    git(d, &["checkout", "-q", "main"]);
    commit(d, "b.txt", "更新说明", 0);
    let out = Command::new("git")
        .args(["merge", "-q", "--no-ff", "-m", "合并", "feature"])
        .current_dir(d)
        .env("GIT_AUTHOR_NAME", "林夏")
        .env("GIT_AUTHOR_EMAIL", "linxia@example.com")
        .env("GIT_COMMITTER_NAME", "林夏")
        .env("GIT_COMMITTER_EMAIL", "linxia@example.com")
        .env("GIT_AUTHOR_DATE", "1700000000 +0800")
        .env("GIT_COMMITTER_DATE", "1700000000 +0800")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success());
    commit(d, "c.txt", "之后", 0);

    let s = Session::open(d).unwrap();
    let rows = s.log_page(0, 100).unwrap().rows;
    let pos = |id: &str| rows.iter().position(|c| c.id == id).unwrap();
    for c in &rows {
        for p in &c.parents {
            assert!(pos(&c.id) < pos(p), "{} 排在了父提交 {} 后面", c.title, p);
        }
    }
    assert_eq!(rows.last().unwrap().title, "初始提交");
}

/// 文件监听触发的刷新：引用和 HEAD 没变时不重新读取
#[test]
fn reload_if_changed_skips_when_nothing_moved() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    commit(p, "a.txt", "第一个", 1);
    let mut s = Session::open(p).unwrap();
    assert!(!s.reload_if_changed().unwrap(), "刚打开，没变");
    std::fs::write(p.join("a.txt"), "只改工作区").unwrap();
    assert!(!s.reload_if_changed().unwrap(), "工作区的改动不影响日志");
    commit(p, "b.txt", "第二个", 2);
    assert!(s.reload_if_changed().unwrap(), "新提交");
    assert_eq!(s.log_page(0, 10).unwrap().rows[0].title, "第二个");
    git(p, &["branch", "side"]);
    assert!(s.reload_if_changed().unwrap(), "新分支");
    git(p, &["checkout", "-q", "side"]);
    assert!(s.reload_if_changed().unwrap(), "切换分支：HEAD 在同一个提交，但分支标签的“当前”变了");
    assert!(!s.reload_if_changed().unwrap());
}
