//! Branches, tags and merging.

use std::path::Path;
use std::process::Command;

use strand_core::model::{MergeResult, RepoMode};
use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {:?}：{}", args, String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(dir: &Path, f: &str, s: &str) {
    std::fs::write(dir.join(f), s).unwrap();
}

/// main: initial commit → main 2; feature: branches from the initial commit and changes f.txt;
/// plus a bare repository as origin with main pushed and a remote-only branch remote-only.
fn repo() -> (tempfile::TempDir, tempfile::TempDir) {
    let d = tempfile::tempdir().unwrap();
    let origin = tempfile::tempdir().unwrap();
    let p = d.path();
    git(origin.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    git(p, &["config", "commit.gpgsign", "false"]);
    write(p, "a.txt", "一\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "初始提交"]);
    git(p, &["switch", "-q", "-c", "feature"]);
    write(p, "f.txt", "功能\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "功能"]);
    git(p, &["switch", "-q", "main"]);
    write(p, "a.txt", "一\n二\n");
    git(p, &["commit", "-q", "-am", "main 2"]);
    git(p, &["remote", "add", "origin", origin.path().to_str().unwrap()]);
    git(p, &["push", "-q", "-u", "origin", "main"]);
    git(p, &["push", "-q", "origin", "feature:remote-only"]);
    git(p, &["fetch", "-q", "origin"]);
    (d, origin)
}

#[test]
fn lists_refs() {
    let (d, _o) = repo();
    let p = d.path();
    write(p, "a.txt", "一\n二\n三\n");
    git(p, &["commit", "-q", "-am", "main 3"]);
    git(p, &["tag", "v1"]);
    let s = Session::open(p).unwrap();
    let r = s.refs_list().unwrap();
    let main = r.branches.iter().find(|b| b.name == "main").unwrap();
    assert!(main.is_current);
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    assert_eq!((main.ahead, main.behind), (1, 0));
    let feature = r.branches.iter().find(|b| b.name == "feature").unwrap();
    assert!(!feature.merged);
    assert_eq!(r.remotes.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), vec!["origin/main", "origin/remote-only"]);
    assert_eq!(r.tags.len(), 1);
    assert_eq!(r.head.branch.as_deref(), Some("main"));
    assert_eq!(s.log_locate("v1"), Some(0));
    assert!(s.log_locate("feature").is_some());
}

#[test]
fn create_switch_rename_delete() {
    let (d, _o) = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    assert_eq!(s.branch_create("bad name", None, false).unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(s.branch_create("feature", None, false).unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(s.branch_create("a..b", None, false).unwrap_err().code, ErrorCode::InvalidName);

    // With a feature branch, feature/x can't be created (Git refs are file paths and would conflict)
    assert_eq!(s.branch_create("feature/x", None, false).unwrap_err().code, ErrorCode::InvalidName);

    s.branch_create("topic/x", None, true).unwrap();
    assert_eq!(git(p, &["branch", "--show-current"]), "topic/x");
    assert_eq!(s.branch_create("topic", None, false).unwrap_err().code, ErrorCode::InvalidName);
    s.branch_switch("main", false).unwrap();
    s.branch_rename("topic/x", "topic/y").unwrap();
    assert!(s.refs_list().unwrap().branches.iter().any(|b| b.name == "topic/y"));

    // Merged branches are deleted directly; unmerged ones need force; the current branch can't be deleted
    s.branch_delete("topic/y", false).unwrap();
    let e = s.branch_delete("feature", false).unwrap_err();
    assert_eq!(e.detail.unwrap()["unmerged"], true);
    assert!(s.branch_delete("main", true).is_err());
    s.branch_delete("feature", true).unwrap();
    assert!(!s.refs_list().unwrap().branches.iter().any(|b| b.name == "feature"));
}

#[test]
fn switch_with_conflicting_changes() {
    let (d, _o) = repo();
    let p = d.path();
    // feature lacks the second line of a.txt; changing a.txt on main and switching would overwrite it
    write(p, "a.txt", "本地改动\n");
    let s = Session::open(p).unwrap();
    let e = s.branch_switch("feature", false).unwrap_err();
    assert_eq!(e.code, ErrorCode::WorktreeConflict);
    assert_eq!(e.detail.unwrap()["files"][0], "a.txt");
    assert_eq!(git(p, &["branch", "--show-current"]), "main");

    s.branch_switch("feature", true).unwrap();
    assert_eq!(git(p, &["branch", "--show-current"]), "feature");
    assert!(git(p, &["stash", "list"]).contains("Strand"));

    // Non-conflicting changes (here a new file) carry over to the new branch
    write(p, "n.txt", "新文件\n");
    s.branch_switch("main", false).unwrap();
    assert_eq!(std::fs::read_to_string(p.join("n.txt")).unwrap(), "新文件\n");
}

#[test]
fn merge_results() {
    let (d, _o) = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    // main already contains the initial commit
    assert_eq!(s.branch_merge("main~1").unwrap(), MergeResult::UpToDate);
    // The new branch is one commit behind main: fast-forward
    git(p, &["branch", "behind", "main~1"]);
    s.branch_switch("behind", false).unwrap();
    assert_eq!(s.branch_merge("main").unwrap(), MergeResult::FastForward);
    // main and feature diverged: a merge commit is created
    s.branch_switch("main", false).unwrap();
    assert_eq!(s.branch_merge("feature").unwrap(), MergeResult::Merged);
    assert_eq!(git(p, &["log", "-1", "--format=%p"]).split(' ').count(), 2);
}

#[test]
fn merge_conflict_and_abort() {
    let (d, _o) = repo();
    let p = d.path();
    git(p, &["switch", "-q", "feature"]);
    write(p, "a.txt", "feature 版本\n");
    git(p, &["commit", "-q", "-am", "feature 改 a"]);
    git(p, &["switch", "-q", "main"]);
    let s = Session::open(p).unwrap();
    let e = s.branch_merge("feature").unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflicts);
    assert_eq!(e.detail.unwrap()["files"][0], "a.txt");
    assert_eq!(s.state().unwrap().state, RepoMode::Merging);
    assert_eq!(s.branch_switch("feature", false).unwrap_err().code, ErrorCode::MergeInProgress);
    s.merge_abort().unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
}

#[test]
fn remote_checkout_detached_and_tags() {
    let (d, _o) = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    assert_eq!(s.branch_checkout_remote("origin/remote-only").unwrap(), "remote-only");
    assert_eq!(git(p, &["rev-parse", "--abbrev-ref", "remote-only@{upstream}"]), "origin/remote-only");
    // A same-named local branch exists: switch to it directly
    assert_eq!(s.branch_checkout_remote("origin/main").unwrap(), "main");
    assert_eq!(git(p, &["branch", "--show-current"]), "main");

    s.tag_create("v0.1", "main~1", None, false).unwrap();
    assert_eq!(s.tag_create("v0.1", "main", None, false).unwrap_err().code, ErrorCode::InvalidName);
    s.checkout_detached("v0.1").unwrap();
    assert_eq!(s.state().unwrap().head.kind, strand_core::model::HeadKind::Detached);
    assert_eq!(s.checkout_detached("nope").unwrap_err().code, ErrorCode::NotFound);
    s.branch_switch("main", false).unwrap();
    s.tag_delete("v0.1").unwrap();
    assert!(s.refs_list().unwrap().tags.is_empty());
}

/// Drag merge: merge one branch into another, switching first when the target isn't current; it's one step and can be undone (spec §6.1)
#[test]
fn merge_into_other_branch() {
    let (d, _o) = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    let main_before = git(p, &["rev-parse", "main"]);
    // Currently on main: merge main into feature
    let (r, _) = s
        .run_op("把 main 合并到 feature", strand_core::oplog::OpKind::Merge, |s| s.branch_merge_into("main", "feature"))
        .unwrap();
    assert_eq!(r, MergeResult::Merged);
    assert_eq!(git(p, &["branch", "--show-current"]), "feature");
    assert_eq!(git(p, &["rev-parse", "main"]), main_before, "main 不变");
    assert!(git(p, &["log", "--format=%s", "-1"]).contains("Merge"));
    // Undo: back to main, feature back to before the merge
    s.oplog_undo(None, false).unwrap();
    assert_eq!(git(p, &["branch", "--show-current"]), "main");
    assert_eq!(git(p, &["log", "--format=%s", "-1", "feature"]), "功能");

    // The target is the current branch: merge directly; remote branches can be dragged too
    assert_eq!(s.branch_merge_into("origin/remote-only", "main").unwrap(), MergeResult::Merged);
    // Can't merge into itself or a nonexistent target
    assert_eq!(s.branch_merge_into("main", "main").unwrap_err().code, ErrorCode::InvalidRange);
    assert_eq!(s.branch_merge_into("main", "nope").unwrap_err().code, ErrorCode::NotFound);

    // Worktree changes would be overwritten by the target branch: the switch fails and nothing changes
    git(p, &["switch", "-q", "-c", "other"]);
    write(p, "g.txt", "other 的\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "加 g"]);
    git(p, &["switch", "-q", "main"]);
    write(p, "g.txt", "没跟踪的\n");
    let head = git(p, &["rev-parse", "HEAD"]);
    assert!(s.branch_merge_into("main", "other").is_err());
    assert_eq!(git(p, &["branch", "--show-current"]), "main");
    assert_eq!(git(p, &["rev-parse", "HEAD"]), head);
    let _ = RepoMode::Normal;
}

/// Favorites are stored in the repository (spec §6.1, §6.3): shared between worktrees; follow renames; still a favorite after undoing a delete
#[test]
fn favorites_live_in_repo() {
    let (d, _o) = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    let fav = |s: &Session, n: &str| s.refs_list().unwrap().branches.into_iter().find(|b| b.name == n).map(|b| b.favorite);
    assert_eq!(fav(&s, "feature"), Some(false));
    s.set_favorite("feature", true).unwrap();
    s.set_favorite("feature", true).unwrap();
    assert_eq!(fav(&s, "feature"), Some(true));
    assert_eq!(s.favorites(), vec!["feature"], "重复收藏只记一次");
    assert_eq!(s.set_favorite("nope", true).unwrap_err().code, ErrorCode::NotFound);

    // Still there after reopening and in another worktree
    assert_eq!(fav(&Session::open(p).unwrap(), "feature"), Some(true));
    let wt = tempfile::tempdir().unwrap();
    let wt_path = wt.path().join("wt");
    git(p, &["worktree", "add", "-q", wt_path.to_str().unwrap(), "-b", "other"]);
    let w = Session::open(&wt_path).unwrap();
    assert_eq!(fav(&w, "feature"), Some(true));
    w.set_favorite("other", true).unwrap();
    assert_eq!(fav(&s, "other"), Some(true));

    // Rename: the new name is a favorite
    s.run_op("重命名", strand_core::oplog::OpKind::Branch, |s| s.branch_rename("feature", "feature2")).unwrap();
    assert_eq!(fav(&s, "feature2"), Some(true));
    // Undo the rename: the old name is still a favorite
    s.oplog_undo(None, false).unwrap();
    assert_eq!(fav(&s, "feature"), Some(true));

    // Undo after delete: still a favorite
    s.run_op("删除", strand_core::oplog::OpKind::Branch, |s| s.branch_delete("feature", true)).unwrap();
    assert_eq!(fav(&s, "feature"), None);
    s.oplog_undo(None, false).unwrap();
    assert_eq!(fav(&s, "feature"), Some(true));

    s.set_favorite("feature", false).unwrap();
    assert_eq!(fav(&s, "feature"), Some(false));
}

/// Clean up merged branches: list the local branches already in a target branch, then delete several at once
#[test]
fn merged_branches_and_bulk_delete() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "l@x.cn"]);
    write(p, "a.txt", "1\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "一"]);
    // done-a: merged by fast-forward; done-b: merged with a merge commit; open: has its own commit; same: at main
    git(p, &["switch", "-q", "-c", "done-a"]);
    write(p, "b.txt", "b\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "加 b"]);
    git(p, &["switch", "-q", "main"]);
    git(p, &["merge", "-q", "--ff-only", "done-a"]);
    git(p, &["switch", "-q", "-c", "done-b"]);
    write(p, "c.txt", "c\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "加 c"]);
    git(p, &["switch", "-q", "main"]);
    git(p, &["merge", "-q", "--no-ff", "done-b", "-m", "合并 done-b"]);
    git(p, &["switch", "-q", "-c", "open"]);
    write(p, "d.txt", "d\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "加 d"]);
    git(p, &["switch", "-q", "main"]);
    git(p, &["branch", "same"]);

    let s = Session::open(p).unwrap();
    let names: Vec<String> = s.merged_branches("main").unwrap().into_iter().map(|b| b.name).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(sorted, ["done-a", "done-b", "same"]);
    // Merged into "open" (which has everything main has): main is current, so it's left out
    let into_open: Vec<String> = s.merged_branches("open").unwrap().into_iter().map(|b| b.name).collect();
    assert!(!into_open.contains(&"main".to_string()) && into_open.contains(&"done-a".to_string()));
    assert!(s.merged_branches("nope").is_err());

    // The current branch is refused before anything is deleted
    let e = s.branches_delete(&["done-a".into(), "main".into()]).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidName);
    assert!(git(p, &["branch", "--list", "done-a"]).contains("done-a"));
    assert_eq!(s.branches_delete(&["done-a".into(), "done-b".into()]).unwrap(), 2);
    let left = git(p, &["branch", "--format=%(refname:short)"]);
    assert_eq!(left.lines().collect::<Vec<_>>(), ["main", "open", "same"]);
}

/// Revealing or opening a worktree file: only paths inside the worktree, and apps/scripts aren't opened directly
#[test]
fn worktree_file_paths() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(p.join("src")).unwrap();
    write(p, "src/a.txt", "a\n");
    let s = Session::open(p).unwrap();
    assert!(s.worktree_file("src/a.txt").unwrap().ends_with("src/a.txt"));
    assert_eq!(s.worktree_file("src/none.txt").unwrap_err().code, ErrorCode::NotFound);
    for bad in ["../x", "/etc/passwd", ".git/config", ""] {
        assert!(s.worktree_file(bad).is_err(), "{bad}");
    }
    use strand_core::file_history::runs_when_opened;
    assert!(runs_when_opened("tools/build.sh") && runs_when_opened("Setup.EXE") && runs_when_opened("x/Run.command"));
    assert!(!runs_when_opened("src/main.rs") && !runs_when_opened("README.md") && !runs_when_opened("Makefile"));
}
