//! 整理提交（说明书第 9 节）。

use std::path::Path;
use std::process::Command;

use strand_core::model::{RepoMode, SelectedFile, Selection};
use strand_core::oplog::OpKind;
use strand_core::rebase::{Step, StepAction};
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
    std::fs::write(p.join(file), text).unwrap();
    git(p, &["add", file]);
    git(p, &["commit", "-q", "-m", msg]);
    git(p, &["rev-parse", "HEAD"])
}

fn read(p: &Path, f: &str) -> String {
    std::fs::read_to_string(p.join(f)).unwrap_or_default()
}

fn titles(p: &Path, n: usize) -> String {
    git(p, &["log", &format!("-{n}"), "--format=%s"])
}

/// main: M1 - M2；feature 从 M1 分出：A B C D（每个提交改自己的文件）
struct R {
    dir: tempfile::TempDir,
    a: String,
    b: String,
    c: String,
    d: String,
}

fn sample() -> R {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    commit(p, "m.txt", "m1\n", "M1");
    git(p, &["checkout", "-q", "-b", "feature"]);
    let a = commit(p, "a.txt", "a\n", "A");
    let b = commit(p, "b.txt", "b\n", "B");
    let c = commit(p, "c.txt", "c\n", "C");
    let d = commit(p, "d.txt", "d\n", "D");
    git(p, &["checkout", "-q", "main"]);
    commit(p, "m.txt", "m2\n", "M2");
    git(p, &["checkout", "-q", "feature"]);
    R { dir, a, b, c, d }
}

fn step(id: &str, action: StepAction) -> Step {
    Step { id: id.to_string(), action, message: None }
}

#[test]
fn range_stops_at_other_branches() {
    let r = sample();
    let s = Session::open(r.dir.path()).unwrap();
    let range = s.rebase_range(None).unwrap();
    let t: Vec<&str> = range.commits.iter().map(|c| c.title.as_str()).collect();
    assert_eq!(t, ["A", "B", "C", "D"], "从旧到新，停在 main 也有的 M1");
    assert!(!range.has_pushed);
    let from_c = s.rebase_range(Some(&r.c)).unwrap();
    assert_eq!(from_c.commits.len(), 2);

    let caps = s.commit_caps(&r.b).unwrap();
    assert!(caps.rebase_from.ok && caps.fixup.ok);
    assert!(!s.commit_caps(&r.d).unwrap().rebase_from.ok, "最新提交不能从这里开始整理");
}

#[test]
fn reorder_squash_and_drop() {
    let r = sample();
    let p = r.dir.path();
    let mut s = Session::open(p).unwrap();
    // 新顺序：D、B、C 并入 B、A 丢弃
    let steps = vec![step(&r.d, StepAction::Pick), step(&r.b, StepAction::Pick), step(&r.c, StepAction::Squash), step(&r.a, StepAction::Drop)];
    let (res, op) = s.run_op("整理 4 个提交", OpKind::Commit, |s| s.rebase_apply(&steps)).unwrap();
    assert_eq!((res.before, res.after), (4, 2));
    assert_eq!(titles(p, 3), "B\nD\nM1");
    assert_eq!(git(p, &["log", "-1", "--format=%b"]), "C", "并入的说明追加到正文");
    assert!(!p.join("a.txt").exists() && p.join("c.txt").exists());
    assert_eq!(git(p, &["status", "--porcelain"]), "");

    // 整个整理是一步，可以撤销
    assert!(op.is_some());
    s.reload().unwrap();
    s.oplog_undo(None, false).unwrap();
    assert_eq!(git(p, &["rev-parse", "HEAD"]), r.d);
}

#[test]
fn first_squash_is_kept_all_drop_resets_and_bad_steps_rejected() {
    let r = sample();
    let p = r.dir.path();
    let mut s = Session::open(p).unwrap();
    // 不连续（漏了 B）
    let bad = vec![step(&r.a, StepAction::Pick), step(&r.c, StepAction::Pick), step(&r.d, StepAction::Pick)];
    assert_eq!(s.rebase_apply(&bad).unwrap_err().code, ErrorCode::InvalidRange);

    // 只整理 C、D：第一行“并入”按保留
    let res = s.rebase_apply(&[step(&r.c, StepAction::Squash), step(&r.d, StepAction::Squash)]).unwrap();
    assert_eq!(res.after, 1);
    assert_eq!(titles(p, 3), "C\nB\nA");
    s.reload().unwrap();

    // 全部丢弃：分支退回到范围之前，工作区里没提交的改动保留
    std::fs::write(p.join("m.txt"), "我在改\n").unwrap();
    let ids: Vec<String> = s.rebase_range(None).unwrap().commits.into_iter().map(|c| c.id).collect();
    let all: Vec<Step> = ids.iter().map(|i| step(i, StepAction::Drop)).collect();
    s.rebase_apply(&all).unwrap();
    assert_eq!(titles(p, 1), "M1");
    assert_eq!(read(p, "m.txt"), "我在改\n");
}

#[test]
fn reorder_conflict_stops_in_rebase() {
    let r = sample();
    let p = r.dir.path();
    // E 和 F 改同一个文件，交换顺序必然冲突
    commit(p, "x.txt", "e\n", "E");
    commit(p, "x.txt", "f\n", "F");
    let mut s = Session::open(p).unwrap();
    let range = s.rebase_range(None).unwrap();
    let mut steps: Vec<Step> = range.commits.iter().map(|c| step(&c.id, StepAction::Pick)).collect();
    let n = steps.len();
    steps.swap(n - 1, n - 2);
    assert_eq!(s.rebase_apply(&steps).unwrap_err().code, ErrorCode::Conflicts);
    s.reload().unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Rebasing);
    s.merge_abort().unwrap();
    assert_eq!(titles(p, 2), "F\nE");
    let _ = (&r.a, &r.b);
}

#[test]
fn fixup_and_squash_into() {
    let r = sample();
    let p = r.dir.path();
    let s = Session::open(p).unwrap();
    std::fs::write(p.join("b.txt"), "b 改过\n").unwrap();
    std::fs::write(p.join("d.txt"), "d 不并入\n").unwrap();
    let sel = Selection { files: vec![SelectedFile { path: "b.txt".into(), old_path: None, whole: true, lines: vec![] }] };
    s.commit_fixup(&r.b, &sel, None).unwrap();
    assert_eq!(titles(p, 4), "D\nC\nB\nA", "提交数和说明都不变");
    assert_eq!(git(p, &["show", "HEAD~2:b.txt"]), "b 改过");
    assert_eq!(git(p, &["status", "--porcelain"]), "M d.txt", "没勾选的改动留在工作区");

    // Squash Into：并入并换说明（多行）
    std::fs::write(p.join("c.txt"), "c 改过\n").unwrap();
    let s = Session::open(p).unwrap();
    let c = git(p, &["rev-parse", "HEAD~1"]);
    let sel = Selection { files: vec![SelectedFile { path: "c.txt".into(), old_path: None, whole: true, lines: vec![] }] };
    s.commit_fixup(&c, &sel, Some("C 的新说明\n\n正文第二段")).unwrap();
    assert_eq!(titles(p, 2), "D\nC 的新说明");
    assert_eq!(git(p, &["log", "-1", "--skip=1", "--format=%b"]), "正文第二段");
    assert_eq!(git(p, &["show", "HEAD~1:c.txt"]), "c 改过");
    assert_eq!(git(p, &["status", "--porcelain"]), "M d.txt");
}

/// 说明书第 16 节“整理提交”：范围里有已推送的提交时给出警告，整理后分支需要强制推送
#[test]
fn pushed_commits_in_range_warn_and_need_force() {
    let r = sample();
    let p = r.dir.path();
    // 假装 A、B 已经推送到 origin/feature
    git(p, &["update-ref", "refs/remotes/origin/feature", &r.b]);
    git(p, &["remote", "add", "origin", "/nonexistent"]);
    git(p, &["config", "branch.feature.remote", "origin"]);
    git(p, &["config", "branch.feature.merge", "refs/heads/feature"]);
    let mut s = Session::open(p).unwrap();
    let range = s.rebase_range(None).unwrap();
    assert!(range.has_pushed);
    let pushed: Vec<bool> = range.commits.iter().map(|c| c.pushed).collect();
    assert_eq!(pushed, [true, true, false, false]);
    let feature = |s: &Session| s.refs_list().unwrap().branches.into_iter().find(|b| b.name == "feature").unwrap();
    assert!(!feature(&s).needs_force);
    // 调换 A 和 B：改写了已推送的提交
    let steps = vec![step(&r.b, StepAction::Pick), step(&r.a, StepAction::Pick), step(&r.c, StepAction::Pick), step(&r.d, StepAction::Pick)];
    s.run_op("整理", OpKind::Commit, |s| s.rebase_apply(&steps)).unwrap();
    s.reload().unwrap();
    assert!(feature(&s).needs_force, "整理后要强制推送");
}
