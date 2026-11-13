//! 分支、标签和合并。

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

/// main：初始提交 → main 2；feature：从初始提交分出，改了 f.txt；
/// 另有一个裸仓库作为 origin，推送了 main，并有一个只在远程的分支 remote-only。
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
    assert_eq!(s.log_locate("feature").is_some(), true);
}

#[test]
fn create_switch_rename_delete() {
    let (d, _o) = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    assert_eq!(s.branch_create("bad name", None, false).unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(s.branch_create("feature", None, false).unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(s.branch_create("a..b", None, false).unwrap_err().code, ErrorCode::InvalidName);

    // 已有 feature 分支时不能再建 feature/x（Git 引用是文件路径，会冲突）
    assert_eq!(s.branch_create("feature/x", None, false).unwrap_err().code, ErrorCode::InvalidName);

    s.branch_create("topic/x", None, true).unwrap();
    assert_eq!(git(p, &["branch", "--show-current"]), "topic/x");
    assert_eq!(s.branch_create("topic", None, false).unwrap_err().code, ErrorCode::InvalidName);
    s.branch_switch("main", false).unwrap();
    s.branch_rename("topic/x", "topic/y").unwrap();
    assert!(s.refs_list().unwrap().branches.iter().any(|b| b.name == "topic/y"));

    // 已合并的分支直接删除；未合并的需要 force；当前分支不能删
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
    // feature 上没有 a.txt 的第二行；在 main 上改 a.txt，切过去会覆盖
    write(p, "a.txt", "本地改动\n");
    let s = Session::open(p).unwrap();
    let e = s.branch_switch("feature", false).unwrap_err();
    assert_eq!(e.code, ErrorCode::WorktreeConflict);
    assert_eq!(e.detail.unwrap()["files"][0], "a.txt");
    assert_eq!(git(p, &["branch", "--show-current"]), "main");

    s.branch_switch("feature", true).unwrap();
    assert_eq!(git(p, &["branch", "--show-current"]), "feature");
    assert!(git(p, &["stash", "list"]).contains("Strand"));

    // 不冲突的改动（这里是新文件）会带到新分支
    write(p, "n.txt", "新文件\n");
    s.branch_switch("main", false).unwrap();
    assert_eq!(std::fs::read_to_string(p.join("n.txt")).unwrap(), "新文件\n");
}

#[test]
fn merge_results() {
    let (d, _o) = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    // main 已包含初始提交
    assert_eq!(s.branch_merge("main~1").unwrap(), MergeResult::UpToDate);
    // 新分支落后 main 一个提交：快进
    git(p, &["branch", "behind", "main~1"]);
    s.branch_switch("behind", false).unwrap();
    assert_eq!(s.branch_merge("main").unwrap(), MergeResult::FastForward);
    // main 和 feature 分叉：生成合并提交
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
    // 同名本地分支已存在：直接切换
    assert_eq!(s.branch_checkout_remote("origin/main").unwrap(), "main");
    assert_eq!(git(p, &["branch", "--show-current"]), "main");

    s.tag_create("v0.1", "main~1").unwrap();
    assert_eq!(s.tag_create("v0.1", "main").unwrap_err().code, ErrorCode::InvalidName);
    s.checkout_detached("v0.1").unwrap();
    assert_eq!(s.state().unwrap().head.kind, strand_core::model::HeadKind::Detached);
    assert_eq!(s.checkout_detached("nope").unwrap_err().code, ErrorCode::NotFound);
    s.branch_switch("main", false).unwrap();
    s.tag_delete("v0.1").unwrap();
    assert!(s.refs_list().unwrap().tags.is_empty());
}

/// 拖拽合并：把一个分支合并到另一个分支，目标不是当前分支时先切换过去；整个是一步，可以撤销（说明书 6.1）
#[test]
fn merge_into_other_branch() {
    let (d, _o) = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    let main_before = git(p, &["rev-parse", "main"]);
    // 当前在 main：把 main 合并到 feature
    let (r, _) = s
        .run_op("把 main 合并到 feature", strand_core::oplog::OpKind::Merge, |s| s.branch_merge_into("main", "feature"))
        .unwrap();
    assert_eq!(r, MergeResult::Merged);
    assert_eq!(git(p, &["branch", "--show-current"]), "feature");
    assert_eq!(git(p, &["rev-parse", "main"]), main_before, "main 不变");
    assert!(git(p, &["log", "--format=%s", "-1"]).contains("Merge"));
    // 撤销：回到 main，feature 回到合并前
    s.oplog_undo(None, false).unwrap();
    assert_eq!(git(p, &["branch", "--show-current"]), "main");
    assert_eq!(git(p, &["log", "--format=%s", "-1", "feature"]), "功能");

    // 目标就是当前分支：直接合并；远程分支也能拖
    assert_eq!(s.branch_merge_into("origin/remote-only", "main").unwrap(), MergeResult::Merged);
    // 不能合并到自己、目标不存在
    assert_eq!(s.branch_merge_into("main", "main").unwrap_err().code, ErrorCode::InvalidRange);
    assert_eq!(s.branch_merge_into("main", "nope").unwrap_err().code, ErrorCode::NotFound);

    // 工作区的改动会被目标分支覆盖：切换不过去，什么都不改
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

/// 收藏存进仓库（说明书 6.1、6.3）：工作目录之间共用；重命名跟着走；删除后撤销仍是收藏
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

    // 重新打开、另一个工作目录里都还在
    assert_eq!(fav(&Session::open(p).unwrap(), "feature"), Some(true));
    let wt = tempfile::tempdir().unwrap();
    let wt_path = wt.path().join("wt");
    git(p, &["worktree", "add", "-q", wt_path.to_str().unwrap(), "-b", "other"]);
    let w = Session::open(&wt_path).unwrap();
    assert_eq!(fav(&w, "feature"), Some(true));
    w.set_favorite("other", true).unwrap();
    assert_eq!(fav(&s, "other"), Some(true));

    // 重命名：新名字是收藏
    s.run_op("重命名", strand_core::oplog::OpKind::Branch, |s| s.branch_rename("feature", "feature2")).unwrap();
    assert_eq!(fav(&s, "feature2"), Some(true));
    // 撤销重命名：旧名字仍是收藏
    s.oplog_undo(None, false).unwrap();
    assert_eq!(fav(&s, "feature"), Some(true));

    // 删除后撤销：仍是收藏
    s.run_op("删除", strand_core::oplog::OpKind::Branch, |s| s.branch_delete("feature", true)).unwrap();
    assert_eq!(fav(&s, "feature"), None);
    s.oplog_undo(None, false).unwrap();
    assert_eq!(fav(&s, "feature"), Some(true));

    s.set_favorite("feature", false).unwrap();
    assert_eq!(fav(&s, "feature"), Some(false));
}
