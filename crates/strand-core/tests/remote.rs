//! Fetch, pull, push. A local bare repository serves as origin, and another clone simulates "someone else" pushing to the remote.

use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use strand_core::remote::{self, Cancel, PullMode, PullOutcome, PushOptions};
use strand_core::ErrorCode;

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

fn setup_user(p: &Path) {
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    git(p, &["config", "commit.gpgsign", "false"]);
}

struct World {
    _dirs: Vec<tempfile::TempDir>,
    me: std::path::PathBuf,
    other: std::path::PathBuf,
}

/// origin has one commit; me and other each clone it.
fn world() -> World {
    let origin = tempfile::tempdir().unwrap();
    let me = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    git(origin.path(), &["init", "-q", "--bare", "-b", "main"]);
    let seed = tempfile::tempdir().unwrap();
    git(seed.path(), &["init", "-q", "-b", "main"]);
    setup_user(seed.path());
    write(seed.path(), "a.txt", "一\n二\n三\n");
    git(seed.path(), &["add", "."]);
    git(seed.path(), &["commit", "-q", "-m", "初始提交"]);
    git(seed.path(), &["push", "-q", origin.path().to_str().unwrap(), "main"]);
    for d in [&me, &other] {
        git(d.path(), &["clone", "-q", origin.path().to_str().unwrap(), "."]);
        setup_user(d.path());
    }
    World { me: me.path().to_path_buf(), other: other.path().to_path_buf(), _dirs: vec![origin, me, other, seed] }
}

fn commit(p: &Path, f: &str, s: &str, msg: &str) {
    write(p, f, s);
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", msg]);
}

fn none(_: remote::Progress) {}

#[test]
fn fetch_counts_incoming() {
    // See fetch_reports_refs_changed below
    let w = world();
    let r = remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    assert_eq!((r.behind, r.incoming), (0, 0));
    commit(&w.other, "b.txt", "别人的\n", "别人的提交 1");
    commit(&w.other, "c.txt", "别人的\n", "别人的提交 2");
    git(&w.other, &["push", "-q"]);
    let r = remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    assert_eq!((r.behind, r.incoming), (2, 2));
    // Fetch doesn't change local branches
    assert_eq!(git(&w.me, &["log", "-1", "--format=%s"]), "初始提交");
}

#[test]
fn pull_fast_forward_merge_and_rebase() {
    let w = world();
    assert_eq!(remote::pull(&w.me, PullMode::Merge, &Cancel::default(), &none).unwrap().outcome, PullOutcome::UpToDate);

    commit(&w.other, "b.txt", "别人的\n", "别人的提交");
    git(&w.other, &["push", "-q"]);
    // Pulling works with uncommitted changes, which are put back
    write(&w.me, "a.txt", "一\n二\n三\n本地没提交的改动\n");
    let r = remote::pull(&w.me, PullMode::Merge, &Cancel::default(), &none).unwrap();
    assert_eq!((r.outcome, r.incoming), (PullOutcome::FastForward, 1));
    assert!(std::fs::read_to_string(w.me.join("a.txt")).unwrap().contains("本地没提交的改动"));
    git(&w.me, &["checkout", "--", "a.txt"]);

    // New commits on both sides: merge mode creates a merge commit
    commit(&w.other, "c.txt", "别人的\n", "别人的提交 2");
    git(&w.other, &["push", "-q"]);
    commit(&w.me, "d.txt", "我的\n", "我的提交");
    let r = remote::pull(&w.me, PullMode::Merge, &Cancel::default(), &none).unwrap();
    assert_eq!(r.outcome, PullOutcome::Merged);
    assert_eq!(git(&w.me, &["log", "-1", "--format=%p"]).split(' ').count(), 2);
    git(&w.me, &["push", "-q"]);

    // Rebase mode: the history is a straight line
    git(&w.other, &["pull", "-q", "--no-rebase"]);
    commit(&w.other, "e.txt", "别人的\n", "别人的提交 3");
    git(&w.other, &["push", "-q"]);
    commit(&w.me, "f.txt", "我的\n", "我的提交 2");
    let r = remote::pull(&w.me, PullMode::Rebase, &Cancel::default(), &none).unwrap();
    assert_eq!(r.outcome, PullOutcome::Rebased);
    assert_eq!(git(&w.me, &["log", "-1", "--format=%s"]), "我的提交 2");
    assert_eq!(git(&w.me, &["log", "-1", "--format=%p"]).split(' ').count(), 1);
}

#[test]
fn pull_conflict_then_abort() {
    let w = world();
    commit(&w.other, "a.txt", "别人改的\n", "别人改 a");
    git(&w.other, &["push", "-q"]);
    commit(&w.me, "a.txt", "我改的\n", "我改 a");
    for mode in [PullMode::Merge, PullMode::Rebase] {
        let e = remote::pull(&w.me, mode, &Cancel::default(), &none).unwrap_err();
        assert_eq!(e.code, ErrorCode::Conflicts, "{mode:?}");
        assert_eq!(e.detail.as_ref().unwrap()["files"][0], "a.txt");
        // Can't pull again while in a conflict
        assert_eq!(remote::pull(&w.me, mode, &Cancel::default(), &none).unwrap_err().code, ErrorCode::MergeInProgress);
        let s = strand_core::Session::open(&w.me).unwrap();
        s.merge_abort().unwrap();
        assert_eq!(git(&w.me, &["log", "-1", "--format=%s"]), "我改 a");
        assert_eq!(git(&w.me, &["status", "--porcelain"]), "");
    }
}

#[test]
fn push_preview_and_push() {
    let w = world();
    commit(&w.me, "b.txt", "我的\n", "我的提交 1");
    commit(&w.me, "c.txt", "我的\n", "我的提交 2");
    let p = remote::push_preview(&w.me, None).unwrap();
    assert_eq!(p.target, "origin/main");
    assert_eq!(p.commits.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), vec!["我的提交 2", "我的提交 1"]);
    assert_eq!((p.behind, p.needs_force, p.new_branch), (0, false, false));

    let steps = Mutex::new(Vec::new());
    remote::push(&w.me, &PushOptions::default(), &Cancel::default(), &|p| steps.lock().unwrap().push(p.text)).unwrap();
    assert!(remote::push_preview(&w.me, None).unwrap().commits.is_empty());
    git(&w.other, &["pull", "-q"]);
    assert_eq!(git(&w.other, &["log", "-1", "--format=%s"]), "我的提交 2");

    // New branch: pushing creates the remote branch and sets it as upstream
    git(&w.me, &["switch", "-q", "-c", "topic"]);
    commit(&w.me, "t.txt", "主题\n", "主题提交");
    let p = remote::push_preview(&w.me, None).unwrap();
    assert!(p.new_branch);
    assert_eq!(p.commits.len(), 1);
    remote::push(&w.me, &PushOptions::default(), &Cancel::default(), &none).unwrap();
    assert_eq!(git(&w.me, &["rev-parse", "--abbrev-ref", "topic@{upstream}"]), "origin/topic");
}

#[test]
fn push_rejections_and_force() {
    let w = world();
    // The remote has new commits: rejected outright without force
    commit(&w.other, "b.txt", "别人的\n", "别人的提交");
    git(&w.other, &["push", "-q"]);
    commit(&w.me, "c.txt", "我的\n", "我的提交");
    remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    let p = remote::push_preview(&w.me, None).unwrap();
    assert_eq!((p.behind, p.needs_force), (1, false));
    let e = remote::push(&w.me, &PushOptions::default(), &Cancel::default(), &none).unwrap_err();
    assert_eq!((e.code, e.detail.unwrap()["reason"].as_str().unwrap()), (ErrorCode::PushRejected, "behind"));

    // Pushed commits rewritten: needs a force push
    git(&w.me, &["pull", "-q", "--rebase"]);
    git(&w.me, &["push", "-q"]);
    git(&w.me, &["commit", "-q", "--amend", "-m", "我的提交（改了说明）"]);
    let p = remote::push_preview(&w.me, None).unwrap();
    assert_eq!((p.behind, p.needs_force), (1, true));
    let e = remote::push(&w.me, &PushOptions::default(), &Cancel::default(), &none).unwrap_err();
    assert_eq!(e.detail.unwrap()["reason"], "needs_force");
    remote::push(&w.me, &PushOptions { force: true, ..Default::default() }, &Cancel::default(), &none).unwrap();
    git(&w.other, &["fetch", "-q"]);
    assert_eq!(git(&w.other, &["log", "-1", "--format=%s", "origin/main"]), "我的提交（改了说明）");

    // Someone pushed again after my last fetch during a force push: --force-with-lease rejects it
    git(&w.other, &["reset", "-q", "--hard", "origin/main"]);
    commit(&w.other, "x.txt", "别人又推\n", "别人又推");
    git(&w.other, &["push", "-q"]);
    git(&w.me, &["commit", "-q", "--amend", "-m", "我又改了说明"]);
    let e = remote::push(&w.me, &PushOptions { force: true, ..Default::default() }, &Cancel::default(), &none).unwrap_err();
    assert_eq!(e.detail.unwrap()["reason"], "lease_stale");
}

#[test]
fn empty_commits_are_not_treated_as_rewritten() {
    let w = world();
    git(&w.other, &["commit", "-q", "--allow-empty", "-m", "别人的空提交"]);
    git(&w.other, &["push", "-q"]);
    git(&w.me, &["commit", "-q", "--allow-empty", "-m", "我的空提交"]);
    remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    let p = remote::push_preview(&w.me, None).unwrap();
    assert_eq!((p.behind, p.needs_force), (1, false));
}

#[test]
fn errors_and_cancel() {
    let w = world();
    // Pointing at a nonexistent URL: a network or repository error, not a crash
    git(&w.me, &["remote", "set-url", "origin", "/nonexistent/repo.git"]);
    let e = remote::fetch(&w.me, &Cancel::default(), &none).unwrap_err();
    assert!(matches!(e.code, ErrorCode::Network | ErrorCode::GitFailed), "{e:?}");

    // A cancelled token: ends immediately and returns CANCELLED
    git(&w.me, &["remote", "set-url", "origin", w.other.to_str().unwrap()]);
    let c = Cancel::default();
    c.cancel();
    assert_eq!(remote::fetch(&w.me, &c, &none).unwrap_err().code, ErrorCode::Cancelled);

    // No origin
    git(&w.me, &["remote", "remove", "origin"]);
    assert_eq!(remote::fetch(&w.me, &Cancel::default(), &none).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn push_up_to_a_commit() {
    let w = world();
    commit(&w.me, "b.txt", "1\n", "我的提交 1");
    commit(&w.me, "c.txt", "2\n", "我的提交 2");
    commit(&w.me, "d.txt", "3\n", "我的提交 3");
    let second = git(&w.me, &["rev-parse", "HEAD~1"]);
    let p = remote::push_preview(&w.me, Some(&second)).unwrap();
    assert_eq!(p.commits.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), vec!["我的提交 2", "我的提交 1"]);
    assert_eq!((p.left, p.to.as_deref()), (1, Some(second.as_str())));

    let opts = PushOptions { to: Some(second.clone()), ..Default::default() };
    remote::push(&w.me, &opts, &Cancel::default(), &none).unwrap();
    assert_eq!(git(&w.me, &["rev-parse", "origin/main"]), second, "远程只到第二个提交");
    let rest = remote::push_preview(&w.me, None).unwrap();
    assert_eq!(rest.commits.len(), 1, "第三个仍未推送");
    // Already pushed commits can't be "pushed up to here" again
    let first = git(&w.me, &["rev-parse", "HEAD~2"]);
    assert_eq!(remote::push(&w.me, &PushOptions { to: Some(first), ..Default::default() }, &Cancel::default(), &none).unwrap_err().code, strand_core::ErrorCode::InvalidRange);

    // Rejected when the remote has new commits
    git(&w.other, &["pull", "-q"]);
    commit(&w.other, "o.txt", "别人\n", "别人的提交");
    git(&w.other, &["push", "-q"]);
    remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    let head = git(&w.me, &["rev-parse", "HEAD"]);
    let e = remote::push(&w.me, &PushOptions { to: Some(head), ..Default::default() }, &Cancel::default(), &none).unwrap_err();
    assert_eq!(e.code, strand_core::ErrorCode::PushRejected);

    // New branch: push up to a commit, then set the upstream
    git(&w.me, &["switch", "-q", "-c", "topic"]);
    commit(&w.me, "t1.txt", "1\n", "主题 1");
    commit(&w.me, "t2.txt", "2\n", "主题 2");
    let t1 = git(&w.me, &["rev-parse", "HEAD~1"]);
    remote::push(&w.me, &PushOptions { to: Some(t1.clone()), ..Default::default() }, &Cancel::default(), &none).unwrap();
    assert_eq!(git(&w.me, &["rev-parse", "--abbrev-ref", "topic@{upstream}"]), "origin/topic");
    assert_eq!(git(&w.me, &["rev-parse", "origin/topic"]), t1);
}

#[test]
fn push_to_caps() {
    let w = world();
    commit(&w.me, "b.txt", "1\n", "我的提交 1");
    let mine = git(&w.me, &["rev-parse", "HEAD"]);
    let pushed = git(&w.me, &["rev-parse", "HEAD~1"]);
    let s = strand_core::Session::open(&w.me).unwrap();
    assert!(s.commit_caps(&mine).unwrap().push_to.ok);
    let c = s.commit_caps(&pushed).unwrap().push_to;
    assert!(!c.ok && c.why.unwrap().contains("已经推送"));

    commit(&w.other, "o.txt", "别人\n", "别人的提交");
    git(&w.other, &["push", "-q"]);
    remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    let s = strand_core::Session::open(&w.me).unwrap();
    let c = s.commit_caps(&mine).unwrap().push_to;
    assert!(!c.ok && c.why.unwrap().contains("先拉取"));
}

/// Unpushed tags (spec §6.5, §7.3, §7.4)
#[test]
fn unpushed_tags_and_tag_push() {
    let w = world();
    let tags_of = |p: &Path| strand_core::Session::open(p).unwrap().refs_list().unwrap().tags;
    git(&w.me, &["tag", "v1"]);
    // Never fetched: we don't know the remote's tags, so nothing is marked
    assert!(remote::unpushed_tags(&w.me).is_none());
    assert!(!tags_of(&w.me)[0].unpushed);
    let p = remote::push_preview(&w.me, None).unwrap();
    assert!(p.tags_unknown && p.unpushed_tags.is_empty());

    // Someone pushed a tag; after fetching we record that the remote has r1 and not v1
    git(&w.other, &["tag", "r1"]);
    git(&w.other, &["push", "-q", "origin", "r1"]);
    remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    assert_eq!(remote::unpushed_tags(&w.me).unwrap(), vec!["v1"]);
    let t = tags_of(&w.me);
    assert_eq!(t.iter().map(|t| (t.name.as_str(), t.unpushed)).collect::<Vec<_>>(), vec![("r1", false), ("v1", true)]);

    // Push one tag
    git(&w.me, &["tag", "-a", "v2", "-m", "第二版"]);
    remote::tag_push(&w.me, "v1", &Cancel::default(), &none).unwrap();
    assert!(git(&w.other, &["ls-remote", "--tags", "origin"]).contains("refs/tags/v1"));
    assert_eq!(remote::unpushed_tags(&w.me).unwrap(), vec!["v2"]);

    // "Also push tags" in the push dialog only pushes unpushed ones
    let p = remote::push_preview(&w.me, None).unwrap();
    assert_eq!(p.unpushed_tags, vec!["v2"]);
    remote::push(&w.me, &PushOptions { tags: true, ..Default::default() }, &Cancel::default(), &none).unwrap();
    assert!(remote::unpushed_tags(&w.me).unwrap().is_empty());
    assert!(git(&w.other, &["ls-remote", "--tags", "origin"]).contains("refs/tags/v2"));

    // The remote already has a same-named tag pointing elsewhere: rejected
    commit(&w.me, "b.txt", "b\n", "新提交");
    git(&w.other, &["tag", "dup"]);
    git(&w.other, &["push", "-q", "origin", "dup"]);
    git(&w.me, &["tag", "dup"]);
    let e = remote::tag_push(&w.me, "dup", &Cancel::default(), &none).unwrap_err();
    assert_eq!(e.code, ErrorCode::PushRejected, "{e:?}");
    assert_eq!(e.detail.unwrap()["reason"], "tag_exists");
    assert_eq!(remote::tag_push(&w.me, "nope", &Cancel::default(), &none).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn clone_records_remote_tags() {
    let w = world();
    git(&w.other, &["tag", "r1"]);
    git(&w.other, &["push", "-q", "origin", "r1"]);
    let d = tempfile::tempdir().unwrap();
    let dest = d.path().join("c");
    let url = git(&w.other, &["remote", "get-url", "origin"]);
    remote::clone(&url, &dest, &Cancel::default(), &none).unwrap();
    assert!(remote::unpushed_tags(&dest).unwrap().is_empty());
    git(&dest, &["tag", "mine"]);
    assert_eq!(remote::unpushed_tags(&dest).unwrap(), vec!["mine"]);
}

/// Auto-shelve to the shelf before pulling and restore afterwards (spec §7.2)
#[test]
fn pull_shelves_local_changes() {
    let w = world();
    let s = strand_core::Session::open(&w.me).unwrap();
    // No changes: nothing shelved
    assert!(s.pull_shelve().unwrap().is_none());

    // 1. Changes don't conflict with what was pulled: restored, nothing left on the shelf
    commit(&w.other, "b.txt", "别人的\n", "别人的提交");
    git(&w.other, &["push", "-q"]);
    write(&w.me, "a.txt", "一\n二\n三\n四（我的）\n");
    let e = s.pull_shelve().unwrap().unwrap();
    assert_eq!(e.name, "拉取前自动搁置");
    assert_eq!(std::fs::read_to_string(w.me.join("a.txt")).unwrap(), "一\n二\n三\n", "搁置后工作区干净");
    assert_eq!(remote::pull(&w.me, PullMode::Rebase, &Cancel::default(), &none).unwrap().outcome, PullOutcome::FastForward);
    assert_eq!(s.pull_unshelve().unwrap(), None);
    assert_eq!(std::fs::read_to_string(w.me.join("a.txt")).unwrap(), "一\n二\n三\n四（我的）\n");
    assert!(w.me.join("b.txt").exists());
    assert!(s.shelf_list().unwrap().is_empty());
    assert_eq!(s.pull_unshelve().unwrap(), None, "只放回一次");

    // 2. Conflicts when restoring: back to before restoring, the changes stay on the shelf
    commit(&w.other, "a.txt", "一\n二（别人的）\n三\n", "别人改 a");
    git(&w.other, &["push", "-q"]);
    write(&w.me, "a.txt", "一\n二（我的）\n三\n");
    s.pull_shelve().unwrap().unwrap();
    remote::pull(&w.me, PullMode::Merge, &Cancel::default(), &none).unwrap();
    let note = s.pull_unshelve().unwrap().unwrap();
    assert!(note.contains("冲突") && note.contains("拉取前自动搁置"), "{note}");
    assert_eq!(s.state().unwrap().state, strand_core::model::RepoMode::Normal);
    assert_eq!(std::fs::read_to_string(w.me.join("a.txt")).unwrap(), "一\n二（别人的）\n三\n");
    assert_eq!(s.shelf_list().unwrap().len(), 1);
    assert_eq!(git(&w.me, &["status", "--porcelain"]), "");
}

/// When restoring, only conflicting files stay on the shelf, the rest are restored (spec §7.2)
#[test]
fn pull_unshelve_keeps_only_conflicting_files() {
    let w = world();
    let s = strand_core::Session::open(&w.me).unwrap();
    commit(&w.me, "b.txt", "1\n2\n3\n4\n5\n6\n7\n", "加 b");
    git(&w.me, &["push", "-q"]);
    git(&w.other, &["pull", "-q"]);
    // Someone changed line 2 of a and line 1 of b
    write(&w.other, "a.txt", "一\n二（别人的）\n三\n");
    commit(&w.other, "b.txt", "1 别人\n2\n3\n4\n5\n6\n7\n", "别人改 a 和 b");
    git(&w.other, &["push", "-q"]);
    // Me: same line of a conflicts; b changes its last line (three-way merges cleanly); new file n.txt
    write(&w.me, "a.txt", "一\n二（我的）\n三\n");
    write(&w.me, "b.txt", "1\n2\n3\n4\n5\n6\n7 我的\n");
    write(&w.me, "n.txt", "新的\n");
    git(&w.me, &["add", "n.txt"]);
    s.pull_shelve().unwrap().unwrap();
    remote::pull(&w.me, PullMode::Merge, &Cancel::default(), &none).unwrap();
    let note = s.pull_unshelve().unwrap().unwrap();
    assert!(note.contains("放回了 2 个文件") && note.contains("1 个文件和拉取下来的内容有冲突"), "{note}");
    assert_eq!(s.state().unwrap().state, strand_core::model::RepoMode::Normal);
    assert_eq!(std::fs::read_to_string(w.me.join("a.txt")).unwrap(), "一\n二（别人的）\n三\n", "冲突的退回拉取后的样子");
    assert_eq!(std::fs::read_to_string(w.me.join("b.txt")).unwrap(), "1 别人\n2\n3\n4\n5\n6\n7 我的\n");
    assert_eq!(std::fs::read_to_string(w.me.join("n.txt")).unwrap(), "新的\n");
    let shelf = s.shelf_list().unwrap();
    assert_eq!(shelf.len(), 1);
    assert_eq!(shelf[0].name, "拉取前自动搁置");
    assert_eq!(shelf[0].files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["a.txt"]);
    // The remaining entry can still be restored manually (through conflict resolution)
    assert_eq!(s.shelf_restore(shelf[0].id).unwrap_err().code, ErrorCode::Conflicts);
}

/// The pull itself has conflicts: restoring waits until conflict resolution finishes or is aborted
#[test]
fn pull_conflict_keeps_shelf_until_abort() {
    let w = world();
    let s = strand_core::Session::open(&w.me).unwrap();
    commit(&w.other, "a.txt", "别人的 a\n", "别人改 a");
    git(&w.other, &["push", "-q"]);
    commit(&w.me, "a.txt", "我的 a\n", "我改 a");
    write(&w.me, "c.txt", "没跟踪的\n");
    git(&w.me, &["add", "c.txt"]);
    s.pull_shelve().unwrap().unwrap();
    assert_eq!(remote::pull(&w.me, PullMode::Merge, &Cancel::default(), &none).unwrap_err().code, ErrorCode::Conflicts);
    assert_eq!(s.pull_unshelve().unwrap(), None, "还在合并中，不放回");
    assert!(!w.me.join("c.txt").exists());
    s.merge_abort().unwrap();
    assert_eq!(s.pull_unshelve().unwrap(), None);
    assert_eq!(std::fs::read_to_string(w.me.join("c.txt")).unwrap(), "没跟踪的\n");
    assert!(s.shelf_list().unwrap().is_empty());
}

/// The pull summary panel's dry run (spec §7.2): merges once in memory without changing the repository; predicted conflicts match the real pull
#[test]
fn pull_preview_predicts_conflicts() {
    let w = world();
    // Files on both sides: b (different lines changed, merges automatically), c (they deleted, I changed)
    commit(&w.me, "b.txt", "1\n2\n3\n4\n5\n6\n7\n", "加 b");
    commit(&w.me, "c.txt", "c\n", "加 c");
    git(&w.me, &["push", "-q"]);
    git(&w.other, &["pull", "-q"]);
    write(&w.other, "a.txt", "一\n二（别人的）\n三\n");
    write(&w.other, "b.txt", "1 别人\n2\n3\n4\n5\n6\n7\n");
    std::fs::remove_file(w.other.join("c.txt")).unwrap();
    git(&w.other, &["add", "-A"]);
    git(&w.other, &["commit", "-q", "-m", "别人改 a、b，删 c"]);
    git(&w.other, &["push", "-q"]);

    // Fast-forward: no conflicts when there are no local-only commits
    remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    let ff = remote::pull_preview(&w.me, PullMode::Merge).unwrap();
    assert_eq!((ff.incoming, ff.ahead, ff.conflicts.len()), (1, 0, 0));

    write(&w.me, "a.txt", "一\n二（我的）\n三\n");
    write(&w.me, "b.txt", "1\n2\n3\n4\n5\n6\n7 我的\n");
    write(&w.me, "c.txt", "c 改\n");
    git(&w.me, &["commit", "-q", "-am", "我改 a、b、c"]);
    commit(&w.me, "d.txt", "d\n", "我加 d");
    let head = git(&w.me, &["rev-parse", "HEAD"]);

    let m = remote::pull_preview(&w.me, PullMode::Merge).unwrap();
    assert_eq!((m.branch.as_str(), m.upstream.as_str(), m.incoming, m.ahead, m.auto_merged), ("main", "origin/main", 1, 2, 1));
    let kinds: Vec<_> = m.conflicts.iter().map(|c| (c.path.as_str(), c.kind, c.blocks)).collect();
    use strand_core::conflict::FileKind;
    assert_eq!(kinds, vec![("a.txt", FileKind::Text, 1), ("c.txt", FileKind::ModifyDelete, 0)]);
    assert!(m.conflicts.iter().all(|c| c.commit.is_none()));

    // Rebase mode: records which local commit the conflict appears in
    let r = remote::pull_preview(&w.me, PullMode::Rebase).unwrap();
    assert_eq!(r.conflicts.len(), 2);
    assert!(r.conflicts.iter().all(|c| c.commit.as_deref() == Some("我改 a、b、c")), "{:?}", r.conflicts);

    // The dry run doesn't change the repository
    assert_eq!(git(&w.me, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&w.me, &["status", "--porcelain"]), "");

    // After confirming, no fetch, merge directly: conflicted files match the dry run
    let e = remote::pull_with(&w.me, PullMode::Merge, false, &Cancel::default(), &none).unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflicts);
    let mut files: Vec<String> = serde_json::from_value(e.detail.unwrap()["files"].clone()).unwrap();
    files.sort();
    assert_eq!(files, vec!["a.txt", "c.txt"]);
    let msg = std::fs::read_to_string(w.me.join(".git/MERGE_MSG")).unwrap();
    assert!(msg.contains("origin/main") && !msg.contains("origin/HEAD"), "{msg}");
    // "Theirs" in conflicts also uses the real branch name, not origin/HEAD
    let ms = strand_core::Session::open(&w.me).unwrap().merge_session().unwrap().unwrap();
    assert_eq!(ms.theirs.label, "origin/main");
    assert!(remote::pull_preview(&w.me, PullMode::Merge).is_err(), "合并进行中不能预演");
}

/// Rebase dry run: after an earlier commit conflicts, later commits continue with the local version
#[test]
fn pull_preview_rebase_continues_after_conflict() {
    let w = world();
    commit(&w.other, "a.txt", "一（别人的）\n二\n三\n", "别人改第一行");
    git(&w.other, &["push", "-q"]);
    commit(&w.me, "a.txt", "一（我的）\n二\n三\n", "我改第一行");
    commit(&w.me, "a.txt", "一（我的）\n二\n三（我的）\n", "我改第三行");
    commit(&w.me, "e.txt", "e\n", "我加 e");
    remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    let r = remote::pull_preview(&w.me, PullMode::Rebase).unwrap();
    assert_eq!(r.ahead, 3);
    assert_eq!(r.conflicts.len(), 1, "a.txt 只记一次");
    assert_eq!(r.conflicts[0].commit.as_deref(), Some("我改第一行"));
    assert_eq!(r.auto_merged, 0);
}

/// Fetch results carry refs_changed: false when there's nothing new, so the UI doesn't re-read the log
#[test]
fn fetch_reports_refs_changed() {
    let w = world();
    let r = remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    assert!(!r.refs_changed, "远程没有新东西");
    commit(&w.other, "b.txt", "别人的\n", "别人的提交");
    git(&w.other, &["push", "-q"]);
    let r = remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    assert!(r.refs_changed && r.incoming == 1);
    assert!(!remote::fetch(&w.me, &Cancel::default(), &none).unwrap().refs_changed);
}

/// Undo after aborting a conflicted pull (spec §8.9): back in conflict, with the auto-shelved changes back on the shelf; aborting again restores the changes as usual
#[test]
fn undo_abort_of_pull_reshelves_changes() {
    use strand_core::model::RepoMode;
    let w = world();
    let mut s = strand_core::Session::open(&w.me).unwrap();
    commit(&w.other, "a.txt", "别人改的\n", "别人改 a");
    git(&w.other, &["push", "-q"]);
    commit(&w.me, "a.txt", "我改的\n", "我改 a");
    write(&w.me, "b.txt", "没提交的改动\n");
    git(&w.me, &["add", "b.txt"]);
    git(&w.me, &["commit", "-q", "-m", "加 b"]);
    write(&w.me, "b.txt", "没提交的改动（又改了）\n");
    s.pull_shelve().unwrap().unwrap();
    let r = s.run_op("拉取 main", strand_core::oplog::OpKind::Pull, |_| remote::pull(&w.me, PullMode::Merge, &Cancel::default(), &none));
    assert_eq!(r.unwrap_err().code, ErrorCode::Conflicts);

    s.merge_abort_logged("中止拉取", None).unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(std::fs::read_to_string(w.me.join("b.txt")).unwrap(), "没提交的改动（又改了）\n");
    assert!(s.shelf_list().unwrap().is_empty());

    s.oplog_undo(None, false).unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Merging);
    assert_eq!(std::fs::read_to_string(w.me.join("b.txt")).unwrap(), "没提交的改动\n", "改动回到暂存架");
    assert_eq!(s.shelf_list().unwrap().len(), 1);
    assert!(std::fs::read_to_string(w.me.join("a.txt")).unwrap().contains("<<<<<<<"));

    s.merge_abort_logged("中止拉取", None).unwrap();
    assert_eq!(std::fs::read_to_string(w.me.join("b.txt")).unwrap(), "没提交的改动（又改了）\n");
    assert!(s.shelf_list().unwrap().is_empty());
    assert_eq!(git(&w.me, &["log", "-1", "--format=%s"]), "加 b");
}

#[test]
fn manage_remotes_and_push_new_branch_to_chosen_remote() {
    let w = world();
    let up = tempfile::tempdir().unwrap();
    git(up.path(), &["init", "-q", "--bare", "-b", "main"]);
    let url = up.path().to_str().unwrap();

    // Add: name and URL validation
    assert_eq!(remote::remote_add(&w.me, "origin", url).unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(remote::remote_add(&w.me, "a b", url).unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(remote::remote_add(&w.me, "up", "").unwrap_err().code, ErrorCode::InvalidName);
    remote::remote_add(&w.me, "up", url).unwrap();
    let list = remote::remote_list(&w.me).unwrap();
    assert_eq!(list.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["origin", "up"]);
    assert_eq!(list[1].url, url);

    // New branch: the preview lists all remotes, defaults to origin, and up can be chosen
    git(&w.me, &["switch", "-q", "-c", "feat"]);
    commit(&w.me, "f.txt", "新\n", "新功能");
    let p = remote::push_preview(&w.me, None).unwrap();
    assert_eq!((p.remote.as_str(), p.remotes.len(), p.target.as_str()), ("origin", 2, "origin/feat"));
    assert_eq!(remote::push_preview_on(&w.me, None, Some("up")).unwrap().target, "up/feat");
    remote::push(&w.me, &PushOptions { remote: Some("up".into()), ..Default::default() }, &Cancel::default(), &none).unwrap();
    assert_eq!(git(&w.me, &["rev-parse", "--abbrev-ref", "feat@{upstream}"]), "up/feat");
    assert_eq!(git(up.path(), &["log", "-1", "--format=%s", "feat"]), "新功能");
    // Afterwards the default is the remote it tracks
    assert_eq!(remote::default_remote(&w.me).unwrap(), "up");
    assert_eq!(remote::push_preview(&w.me, None).unwrap().remote, "up");

    // Fetch all remotes
    commit(&w.other, "b.txt", "别人的\n", "别人的提交");
    git(&w.other, &["push", "-q"]);
    remote::fetch(&w.me, &Cancel::default(), &none).unwrap();
    assert_eq!(git(&w.me, &["log", "-1", "--format=%s", "origin/main"]), "别人的提交");

    // Rename: tracking follows; change URL; remove
    remote::remote_rename(&w.me, "up", "mirror").unwrap();
    assert_eq!(git(&w.me, &["rev-parse", "--abbrev-ref", "feat@{upstream}"]), "mirror/feat");
    remote::remote_set_url(&w.me, "mirror", "https://example.com/x.git").unwrap();
    assert_eq!(remote::remote_list(&w.me).unwrap().iter().find(|r| r.name == "mirror").unwrap().url, "https://example.com/x.git");
    assert_eq!(remote::remote_rename(&w.me, "mirror", "origin").unwrap_err().code, ErrorCode::InvalidName);
    remote::remote_remove(&w.me, "mirror").unwrap();
    assert_eq!(remote::remotes(&w.me), ["origin"]);
    assert_eq!(remote::remote_remove(&w.me, "nope").unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn repo_without_remotes_says_so() {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q", "-b", "main"]);
    let e = remote::fetch(d.path(), &Cancel::default(), &none).unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

/// Remote cleanup: fetch drops remote branches deleted on the remote; delete a remote branch or tag; set or clear the upstream
#[test]
fn remote_cleanup_and_upstream() {
    let w = world();
    let (me, other) = (w.me.as_path(), w.other.as_path());
    let none = |_: remote::Progress| {};
    // Someone pushes a branch, I fetch it, they delete it on the remote: my next fetch prunes it
    git(other, &["push", "-q", "origin", "main:gone"]);
    remote::fetch(me, &Cancel::default(), &none).unwrap();
    assert!(git(me, &["branch", "-r"]).contains("origin/gone"));
    git(other, &["push", "-q", "origin", "--delete", "gone"]);
    remote::fetch(me, &Cancel::default(), &none).unwrap();
    assert!(!git(me, &["branch", "-r"]).contains("origin/gone"));

    // Delete a remote branch from here
    git(me, &["push", "-q", "origin", "main:feature/x"]);
    git(me, &["fetch", "-q"]);
    remote::remote_branch_delete(me, "origin/feature/x", &Cancel::default(), &none).unwrap();
    assert!(!git(me, &["branch", "-r"]).contains("origin/feature/x"));
    assert!(!git(other, &["ls-remote", "--heads", "origin"]).contains("feature/x"));
    assert_eq!(remote::remote_branch_delete(me, "nowhere/x", &Cancel::default(), &none).unwrap_err().code, ErrorCode::NotFound);

    // Delete a remote tag; the local tag stays
    git(me, &["tag", "v1"]);
    git(me, &["push", "-q", "origin", "v1"]);
    remote::remote_tag_delete(me, "v1", &Cancel::default(), &none).unwrap();
    assert!(git(me, &["ls-remote", "--tags", "origin"]).is_empty());
    assert_eq!(git(me, &["tag"]), "v1");

    // Upstream: set to another remote branch, then clear it
    git(me, &["push", "-q", "origin", "main:other-line"]);
    git(me, &["fetch", "-q"]);
    let s = strand_core::Session::open(me).unwrap();
    s.branch_set_upstream("main", Some("origin/other-line")).unwrap();
    assert_eq!(git(me, &["rev-parse", "--abbrev-ref", "main@{upstream}"]), "origin/other-line");
    s.branch_set_upstream("main", None).unwrap();
    assert!(Command::new("git").args(["rev-parse", "--abbrev-ref", "main@{upstream}"]).current_dir(me).output().unwrap().stdout.is_empty());
    assert_eq!(s.branch_set_upstream("main", Some("origin/nope")).unwrap_err().code, ErrorCode::NotFound);
}
