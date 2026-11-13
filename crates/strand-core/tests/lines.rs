//! 行级提交、丢弃改动、未跟踪文件的操作（说明书 4.3、4.7、4.8）。

use std::path::Path;
use std::process::Command;

use strand_core::model::{LineKind, LineRef, SelectedFile, Selection};
use strand_core::oplog::OpKind;
use strand_core::Session;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

fn repo(files: &[(&str, &str)]) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    for (f, t) in files {
        std::fs::write(p.join(f), t).unwrap();
    }
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "初始提交"]);
    d
}

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("第 {i} 行\n")).collect()
}

/// 某个文件里，满足条件的改动行
fn pick(s: &Session, path: &str, f: impl Fn(LineKind, &str) -> bool) -> Vec<LineRef> {
    let d = s.diff_worktree(path, false, 3).unwrap();
    let mut out = Vec::new();
    for (h, hk) in d.hunks.iter().enumerate() {
        for (l, x) in hk.lines.iter().enumerate() {
            if x.kind != LineKind::Context && f(x.kind, &x.text) {
                out.push(LineRef { hunk: h as u32, line: l as u32 });
            }
        }
    }
    out
}

fn partial(path: &str, lines: Vec<LineRef>) -> SelectedFile {
    SelectedFile { path: path.into(), old_path: None, whole: false, lines }
}

#[test]
fn commit_only_some_lines() {
    let d = repo(&[("a.txt", &numbered(30)), ("b.txt", "b\n")]);
    let p = d.path();
    // 第 2 行改掉、第 29 行改掉（两个修改块），另一个文件整文件提交
    let changed = numbered(30).replace("第 2 行\n", "第二行\n").replace("第 29 行\n", "第二十九行\n");
    std::fs::write(p.join("a.txt"), &changed).unwrap();
    std::fs::write(p.join("b.txt"), "b2\n").unwrap();
    let s = Session::open(p).unwrap();
    assert_eq!(s.diff_worktree("a.txt", false, 3).unwrap().hunks.len(), 2);
    let first = pick(&s, "a.txt", |_, t| t.contains("2 行") || t == "第二行");
    let sel = Selection { files: vec![partial("a.txt", first), SelectedFile { path: "b.txt".into(), old_path: None, whole: true, lines: vec![] }] };
    s.commit_create("只提交上面那处", &sel, false).unwrap();

    let committed = git(p, &["show", "HEAD:a.txt"]);
    assert!(committed.contains("第二行") && committed.contains("第 29 行"));
    assert_eq!(git(p, &["show", "HEAD:b.txt"]), "b2");
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), changed, "工作区不变");
    assert_eq!(git(p, &["status", "--porcelain"]), " M a.txt", "剩下的改动还在，索引对齐到新 HEAD");
    assert_eq!(git(p, &["diff", "--stat"]).lines().count(), 2);
}

#[test]
fn one_pair_and_no_newline_at_end() {
    // 最后一行没有换行
    let d = repo(&[("c.txt", "一\n二\n三")]);
    let p = d.path();
    std::fs::write(p.join("c.txt"), "零\n一\n二改\n三").unwrap();
    let s = Session::open(p).unwrap();
    // 只提交“删掉二、加上二改”这一对，开头新加的“零”不提交
    let lines = pick(&s, "c.txt", |_, t| t == "二" || t == "二改");
    assert_eq!(lines.len(), 2);
    s.commit_create("改二", &Selection { files: vec![partial("c.txt", lines)] }, false).unwrap();
    let raw = Command::new("git").args(["cat-file", "-p", "HEAD:c.txt"]).current_dir(p).output().unwrap().stdout;
    assert_eq!(String::from_utf8(raw).unwrap(), "一\n二改\n三", "文件末尾没有换行的保持不变");

    // 再提交剩下的“零”
    let s = Session::open(p).unwrap();
    let lines = pick(&s, "c.txt", |_, t| t == "零");
    s.commit_create("加零", &Selection { files: vec![partial("c.txt", lines)] }, false).unwrap();
    assert_eq!(git(p, &["status", "--porcelain"]), "");

    // 同一块里只选一部分：和 git add -p 一样，没选的删除行留在原处，选中的新增行接在它后面
    std::fs::write(p.join("c.txt"), "零\n一\nA\nB").unwrap();
    let s = Session::open(p).unwrap();
    let lines = pick(&s, "c.txt", |_, t| t == "二改" || t == "A");
    s.commit_create("部分", &Selection { files: vec![partial("c.txt", lines)] }, false).unwrap();
    assert_eq!(git(p, &["cat-file", "-p", "HEAD:c.txt"]), "零\n一\n三\nA");
}

#[test]
fn discard_and_undo() {
    let d = repo(&[("a.txt", "a\n"), ("gone.txt", "g\n")]);
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    std::fs::write(p.join("a.txt"), "a 改\n").unwrap();
    std::fs::remove_file(p.join("gone.txt")).unwrap();
    std::fs::write(p.join("new.txt"), "新\n").unwrap();
    git(p, &["add", "new.txt"]);
    let paths: Vec<String> = ["a.txt", "gone.txt", "new.txt"].map(String::from).to_vec();
    s.run_op("丢弃改动", OpKind::Other, |s| s.changes_discard(&paths)).unwrap();
    assert_eq!(git(p, &["status", "--porcelain"]), "");
    assert!(!p.join("new.txt").exists());

    s.oplog_undo(None, false).unwrap();
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "a 改\n");
    assert!(!p.join("gone.txt").exists());
    assert_eq!(std::fs::read_to_string(p.join("new.txt")).unwrap(), "新\n");
}

#[test]
fn untracked_add_and_ignore() {
    let d = repo(&[("a.txt", "a\n")]);
    let p = d.path();
    let s = Session::open(p).unwrap();
    std::fs::write(p.join("x.log"), "x").unwrap();
    std::fs::write(p.join("keep.txt"), "k").unwrap();
    s.untracked_ignore("x.log").unwrap();
    s.untracked_ignore("x.log").unwrap();
    assert_eq!(std::fs::read_to_string(p.join(".gitignore")).unwrap(), "/x.log\n", "不重复追加");
    s.untracked_add("keep.txt").unwrap();
    let st = s.status().unwrap();
    assert!(st.untracked.iter().all(|u| u != "x.log" && u != "keep.txt"));
    assert!(st.changes.iter().any(|c| c.path == "keep.txt"));
    assert!(st.untracked.contains(&".gitignore".to_string()));
}

#[test]
fn sign_off_line() {
    let d = repo(&[("a.txt", &numbered(30))]);
    let p = d.path();
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    let s = Session::open(p).unwrap();
    // 整文件提交
    std::fs::write(p.join("a.txt"), numbered(30).replace("第 1 行\n", "第一行\n")).unwrap();
    let sel = Selection { files: vec![SelectedFile { path: "a.txt".into(), old_path: None, whole: true, lines: vec![] }] };
    s.commit_create("加签名", &sel, true).unwrap();
    assert!(git(p, &["log", "-1", "--format=%B"]).contains("Signed-off-by: 林夏 <linxia@example.com>"));
    // 部分行提交
    let s = Session::open(p).unwrap();
    std::fs::write(p.join("a.txt"), numbered(30).replace("第 1 行\n", "第一行\n").replace("第 30 行\n", "第三十行\n")).unwrap();
    let lines = pick(&s, "a.txt", |_, _| true);
    s.commit_create("部分也加签名", &Selection { files: vec![partial("a.txt", lines)] }, true).unwrap();
    assert!(git(p, &["log", "-1", "--format=%B"]).contains("Signed-off-by: 林夏"));
}
