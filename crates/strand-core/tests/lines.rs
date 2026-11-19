//! Line-level commits, discarding changes, untracked file operations (spec §4.3, §4.7, §4.8).

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
        let path = p.join(f);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, t).unwrap();
    }
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "初始提交"]);
    d
}

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("第 {i} 行\n")).collect()
}

/// Changed lines in a file that match a condition
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
    // Line 2 changed and line 29 changed (two change blocks), another file committed whole
    let changed = numbered(30).replace("第 2 行\n", "第二行\n").replace("第 29 行\n", "第二十九行\n");
    std::fs::write(p.join("a.txt"), &changed).unwrap();
    std::fs::write(p.join("b.txt"), "b2\n").unwrap();
    let s = Session::open(p).unwrap();
    assert_eq!(s.diff_worktree("a.txt", false, 3).unwrap().hunks.len(), 2);
    let first = pick(&s, "a.txt", |_, t| t.contains("2 行") || t == "第二行");
    let sel = Selection { files: vec![partial("a.txt", first), SelectedFile { path: "b.txt".into(), old_path: None, whole: true, lines: vec![] }] };
    s.commit_create("只提交上面那处", &sel, false, None).unwrap();

    let committed = git(p, &["show", "HEAD:a.txt"]);
    assert!(committed.contains("第二行") && committed.contains("第 29 行"));
    assert_eq!(git(p, &["show", "HEAD:b.txt"]), "b2");
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), changed, "工作区不变");
    assert_eq!(git(p, &["status", "--porcelain"]), " M a.txt", "剩下的改动还在，索引对齐到新 HEAD");
    assert_eq!(git(p, &["diff", "--stat"]).lines().count(), 2);
}

#[test]
fn one_pair_and_no_newline_at_end() {
    // The last line has no newline
    let d = repo(&[("c.txt", "一\n二\n三")]);
    let p = d.path();
    std::fs::write(p.join("c.txt"), "零\n一\n二改\n三").unwrap();
    let s = Session::open(p).unwrap();
    // Commit only the pair "delete 二, add 二改", not the new "零" at the top
    let lines = pick(&s, "c.txt", |_, t| t == "二" || t == "二改");
    assert_eq!(lines.len(), 2);
    s.commit_create("改二", &Selection { files: vec![partial("c.txt", lines)] }, false, None).unwrap();
    let raw = Command::new("git").args(["cat-file", "-p", "HEAD:c.txt"]).current_dir(p).output().unwrap().stdout;
    assert_eq!(String::from_utf8(raw).unwrap(), "一\n二改\n三", "文件末尾没有换行的保持不变");

    // Then commit the remaining "零"
    let s = Session::open(p).unwrap();
    let lines = pick(&s, "c.txt", |_, t| t == "零");
    s.commit_create("加零", &Selection { files: vec![partial("c.txt", lines)] }, false, None).unwrap();
    assert_eq!(git(p, &["status", "--porcelain"]), "");

    // Selecting part of one block: like git add -p, unselected deleted lines stay in place and selected added lines follow them
    std::fs::write(p.join("c.txt"), "零\n一\nA\nB").unwrap();
    let s = Session::open(p).unwrap();
    let lines = pick(&s, "c.txt", |_, t| t == "二改" || t == "A");
    s.commit_create("部分", &Selection { files: vec![partial("c.txt", lines)] }, false, None).unwrap();
    assert_eq!(git(p, &["cat-file", "-p", "HEAD:c.txt"]), "零\n一\n三\nA");
}

#[test]
fn rollback_one_line_keeps_other_lines_and_the_index_and_is_undoable() {
    let d = repo(&[("a.txt", "start\none\ntwo\nkeep\ndeleted\nstay\nend\n")]);
    let p = d.path();
    let file = p.join("a.txt");
    let original = "start\nONE\nTWO\nkeep\nstay\nadded\nend\n";
    std::fs::write(&file, original).unwrap();
    git(p, &["add", "a.txt"]);
    let index = git(p, &["show", ":a.txt"]);
    let mut s = Session::open(p).unwrap();
    let plan = s.line_rollbacks("a.txt").unwrap().unwrap();
    let index_of = plan.lines.iter().position(|row| row.new_no == Some(2)).unwrap();
    let (result, op) = s.run_op("回退一行", OpKind::Other, |s| s.rollback_line("a.txt", &plan.stamp, index_of)).unwrap();
    assert_eq!(result, original.replace("ONE", "one"));
    assert_eq!(git(p, &["show", ":a.txt"]), index);
    assert!(op.unwrap().undoable);
    assert!(s.rollback_line("a.txt", &plan.stamp, index_of).is_err());
    s.oplog_undo(None, false).unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), original);

    let plan = s.line_rollbacks("a.txt").unwrap().unwrap();
    let deleted = plan.lines.iter().position(|row| row.old_text.as_deref() == Some("deleted") && row.new_no.is_none()).unwrap();
    assert_eq!(plan.lines[deleted].before, 5);
    let result = s.rollback_line("a.txt", &plan.stamp, deleted).unwrap();
    assert_eq!(result, original.replace("stay", "deleted\nstay"));

    let plan = s.line_rollbacks("a.txt").unwrap().unwrap();
    let added = plan.lines.iter().position(|row| row.new_text.as_deref() == Some("added") && row.old_no.is_none()).unwrap();
    assert_eq!(s.rollback_line("a.txt", &plan.stamp, added).unwrap(), result.replace("added\n", ""));
    assert_eq!(git(p, &["show", ":a.txt"]), index);
}

#[test]
fn rollback_restores_deletions_at_eof_and_preserves_crlf() {
    let d = repo(&[("a.txt", "first\nold\nlast")]);
    let p = d.path();
    std::fs::write(p.join("a.txt"), "first\r\nnew\r\n").unwrap();
    let s = Session::open(p).unwrap();
    let plan = s.line_rollbacks("a.txt").unwrap().unwrap();
    let eof = plan.lines.iter().position(|row| row.old_text.as_deref() == Some("last") && row.new_no.is_none()).unwrap();
    let result = s.rollback_line("a.txt", &plan.stamp, eof).unwrap();
    assert_eq!(result, "first\r\nnew\r\nlast");
    let plan = s.line_rollbacks("a.txt").unwrap().unwrap();
    let second = plan.lines.iter().position(|row| row.new_no == Some(2)).unwrap();
    assert_eq!(s.rollback_line("a.txt", &plan.stamp, second).unwrap(), "first\r\nold\r\nlast");
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
fn tracking_a_directory_uses_literals_and_preserves_other_changes_on_undo() {
    let d = repo(&[(".gitignore", "*.log\n"), ("docs [x]/tracked.txt", "old\n")]);
    let p = d.path();
    std::fs::create_dir_all(p.join("docs [x]/nested")).unwrap();
    std::fs::write(p.join("docs [x]/tracked.txt"), "modified\n").unwrap();
    std::fs::write(p.join("docs [x]/new.txt"), "new\n").unwrap();
    std::fs::write(p.join("docs [x]/nested/add.txt"), "nested\n").unwrap();
    std::fs::write(p.join("docs [x]/skip.log"), "ignored\n").unwrap();
    std::fs::write(p.join("outside.txt"), "outside\n").unwrap();
    let mut s = Session::open(p).unwrap();
    let scope = strand_core::oplog::OpScope { files: s.untracked_paths("docs [x]/").unwrap(), ..Default::default() };
    assert_eq!(scope.files, ["docs [x]/nested/add.txt", "docs [x]/new.txt"]);
    let (_, op) = s.run_op_scoped("跟踪目录", OpKind::Other, &scope, |s| s.add_untracked_paths(&scope.files)).unwrap();
    assert!(op.unwrap().undoable);
    assert_eq!(git(p, &["diff", "--cached", "--name-only"]), "docs [x]/nested/add.txt\ndocs [x]/new.txt");
    assert!(s.untracked_add("docs [x]/tracked.txt").is_err());
    s.oplog_undo(None, false).unwrap();
    assert_eq!(git(p, &["diff", "--cached", "--name-only"]), "");
    for file in &scope.files { assert!(p.join(file).is_file()); }
    assert_eq!(std::fs::read_to_string(p.join("docs [x]/tracked.txt")).unwrap(), "modified\n");
}

#[test]
fn ignore_directory_is_literal_root_relative_and_keeps_existing_rules() {
    let d = repo(&[(".gitignore", "# existing\r\n"), ("draft [a]/kept.txt", "tracked\n")]);
    let p = d.path();
    std::fs::create_dir_all(p.join("other/draft [a]")).unwrap();
    for file in ["draft [a]/new.txt", "other/draft [a]/new.txt", "draft [a] notes.txt"] {
        std::fs::write(p.join(file), "new\n").unwrap();
    }
    let s = Session::open(p).unwrap();
    s.untracked_ignore("draft [a]/").unwrap();
    s.untracked_ignore("draft [a]/").unwrap();
    s.untracked_ignore("draft [a] notes.txt").unwrap();
    assert_eq!(std::fs::read(p.join(".gitignore")).unwrap(), b"# existing\r\n/draft\\ \\[a\\]/\r\n/draft\\ \\[a\\]\\ notes.txt\r\n");
    assert_eq!(git(p, &["check-ignore", "draft [a]/new.txt"]), "draft [a]/new.txt");
    assert_eq!(git(p, &["check-ignore", "draft [a] notes.txt"]), "draft [a] notes.txt");
    assert!(git(p, &["check-ignore", "other/draft [a]/new.txt"]).is_empty());
    assert_eq!(git(p, &["--literal-pathspecs", "ls-files", "--", "draft [a]/kept.txt"]), "draft [a]/kept.txt");
}

#[test]
fn sign_off_line() {
    let d = repo(&[("a.txt", &numbered(30))]);
    let p = d.path();
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    let s = Session::open(p).unwrap();
    // Whole-file commit
    std::fs::write(p.join("a.txt"), numbered(30).replace("第 1 行\n", "第一行\n")).unwrap();
    let sel = Selection { files: vec![SelectedFile { path: "a.txt".into(), old_path: None, whole: true, lines: vec![] }] };
    s.commit_create("加签名", &sel, true, None).unwrap();
    assert!(git(p, &["log", "-1", "--format=%B"]).contains("Signed-off-by: 林夏 <linxia@example.com>"));
    // Partial-line commit
    let s = Session::open(p).unwrap();
    std::fs::write(p.join("a.txt"), numbered(30).replace("第 1 行\n", "第一行\n").replace("第 30 行\n", "第三十行\n")).unwrap();
    let lines = pick(&s, "a.txt", |_, _| true);
    s.commit_create("部分也加签名", &Selection { files: vec![partial("a.txt", lines)] }, true, None).unwrap();
    assert!(git(p, &["log", "-1", "--format=%B"]).contains("Signed-off-by: 林夏"));
}
