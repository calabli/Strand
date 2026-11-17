//! Stash and shelf (spec §4.9), plus conflicts and undo when restoring.

use std::path::Path;
use std::process::Command;

use strand_core::conflict::{SessionKind, Side};
use strand_core::model::RepoMode;
use strand_core::oplog::OpKind;
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

fn write(p: &Path, f: &str, s: &str) {
    std::fs::write(p.join(f), s).unwrap();
}

fn read(p: &Path, f: &str) -> String {
    std::fs::read_to_string(p.join(f)).unwrap_or_default()
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    write(p, "a.txt", "a1\n");
    write(p, "b.txt", "b1\n");
    write(p, "gone.txt", "将被删除\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "初始提交"]);
    d
}

#[test]
fn stash_push_apply_pop_drop() {
    let d = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    assert_eq!(s.stash_push(None, false).unwrap_err().code, ErrorCode::NothingSelected);

    write(p, "a.txt", "a2\n");
    s.stash_push(Some("改 a"), false).unwrap();
    assert_eq!(read(p, "a.txt"), "a1\n");
    write(p, "b.txt", "b2\n");
    s.stash_push(None, false).unwrap();
    let list = s.stash_list().unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[1].message.ends_with("改 a"));
    assert_eq!(s.stash_files(1).unwrap()[0].path, "a.txt");

    // Restore but keep
    s.stash_apply(1, false).unwrap();
    assert_eq!(read(p, "a.txt"), "a2\n");
    assert_eq!(s.stash_list().unwrap().len(), 2);
    // Restore and delete
    s.stash_apply(0, true).unwrap();
    assert_eq!(read(p, "b.txt"), "b2\n");
    assert_eq!(s.stash_list().unwrap().len(), 1);
    s.stash_drop(0).unwrap();
    assert!(s.stash_list().unwrap().is_empty());
}

#[test]
fn stash_pop_conflict_then_finish_or_abort() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    write(p, "a.txt", "贮藏里的 a\n");
    s.stash_push(None, false).unwrap();
    write(p, "a.txt", "提交里的 a\n");
    git(p, &["commit", "-qam", "改 a"]);
    write(p, "b.txt", "我在改 b\n");
    s.reload().unwrap();

    // Restore conflicts: enters "restore in progress"
    let err = s.stash_apply(0, true).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflicts);
    assert_eq!(s.state().unwrap().state, RepoMode::Unstashing);
    let session = s.merge_session().unwrap().unwrap();
    assert_eq!(session.kind, SessionKind::Unstash);
    assert_eq!(session.mine.label, "工作区");
    assert!(session.theirs.label.starts_with("WIP on main"));
    assert_eq!(session.files[0].path, "a.txt");

    // Abort: back to before the restore, the stash is still there, the changes to b.txt are kept
    s.merge_abort().unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(read(p, "a.txt"), "提交里的 a\n");
    assert_eq!(read(p, "b.txt"), "我在改 b\n");
    assert_eq!(s.stash_list().unwrap().len(), 1);

    // Restore again, this time taking "theirs" (the restored changes) for the whole file and finishing: the stash is deleted
    s.stash_apply(0, true).unwrap_err();
    s.merge_take_file("a.txt", Side::Theirs).unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Unstashing, "完成前一直是取回进行中");
    let r = s.merge_finish().unwrap();
    assert!(r.done);
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(read(p, "a.txt"), "贮藏里的 a\n");
    assert!(s.stash_list().unwrap().is_empty());
}

#[test]
fn shelf_roundtrip_is_byte_identical() {
    let d = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    // Modified, deleted and added (added to version control); plus one file not shelved
    write(p, "a.txt", "a2\n中文和没有结尾换行");
    std::fs::remove_file(p.join("gone.txt")).unwrap();
    write(p, "new.bin", "\u{0}\u{1}二进制");
    git(p, &["add", "new.bin"]);
    write(p, "b.txt", "不搁置\n");
    let paths: Vec<String> = ["a.txt", "gone.txt", "new.bin"].map(String::from).to_vec();
    let before: Vec<Vec<u8>> = ["a.txt", "new.bin"].iter().map(|f| std::fs::read(p.join(f)).unwrap()).collect();

    let e = s.shelf_save("", &paths).unwrap();
    assert_eq!(e.name, "改动 · 1");
    assert_eq!(e.files.len(), 3);
    assert_eq!(read(p, "a.txt"), "a1\n");
    assert!(p.join("gone.txt").exists() && !p.join("new.bin").exists());
    assert_eq!(read(p, "b.txt"), "不搁置\n");
    assert_eq!(git(p, &["status", "--porcelain"]), "M b.txt");
    assert_eq!(s.shelf_list().unwrap().len(), 1);

    s.shelf_rename(e.id, "试验").unwrap();
    assert_eq!(s.shelf_list().unwrap()[0].name, "试验");

    s.shelf_restore(e.id).unwrap();
    let after: Vec<Vec<u8>> = ["a.txt", "new.bin"].iter().map(|f| std::fs::read(p.join(f)).unwrap()).collect();
    assert_eq!(before, after, "取回后逐字节一致");
    assert!(!p.join("gone.txt").exists());
    assert!(s.shelf_list().unwrap().is_empty(), "取回后条目删除");
    assert_eq!(s.shelf_save("x", &[]).unwrap_err().code, ErrorCode::NothingSelected);
}

#[test]
fn shelf_restore_conflict_and_undo() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    write(p, "a.txt", "搁置的 a\n");
    let (e, op) = s.run_op("搁置", OpKind::Other, |s| s.shelf_save("改 a", &["a.txt".to_string()])).unwrap();
    assert!(op.is_some());

    // Undo the shelve: changes return to the worktree and the entry leaves the shelf; redo shelves it again
    s.oplog_undo(None, false).unwrap();
    assert_eq!(read(p, "a.txt"), "搁置的 a\n");
    assert!(s.shelf_list().unwrap().is_empty());
    s.oplog_redo().unwrap();
    assert_eq!(read(p, "a.txt"), "a1\n");
    assert_eq!(s.shelf_list().unwrap()[0].id, e.id);

    // Conflicts when restoring
    write(p, "a.txt", "提交里的 a\n");
    git(p, &["commit", "-qam", "改 a"]);
    s.reload().unwrap();
    assert_eq!(s.shelf_restore(e.id).unwrap_err().code, ErrorCode::Conflicts);
    assert_eq!(s.state().unwrap().state, RepoMode::Unstashing);
    assert_eq!(s.merge_session().unwrap().unwrap().theirs.label, "改 a");
    s.merge_take_file("a.txt", Side::Mine).unwrap();
    s.merge_finish().unwrap();
    assert_eq!(read(p, "a.txt"), "提交里的 a\n");
    assert!(s.shelf_list().unwrap().is_empty(), "完成后条目删除");
}

#[test]
fn undo_stash_pop_brings_the_stash_back() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    write(p, "a.txt", "a2\n");
    s.run_op("贮藏", OpKind::Other, |s| s.stash_push(None, false)).unwrap();
    s.run_op("取回贮藏", OpKind::Other, |s| s.stash_apply(0, true)).unwrap();
    assert!(s.stash_list().unwrap().is_empty());
    assert_eq!(read(p, "a.txt"), "a2\n");

    s.oplog_undo(None, false).unwrap();
    assert_eq!(read(p, "a.txt"), "a1\n", "撤销取回：改动离开工作区");
    let list = s.stash_list().unwrap();
    assert_eq!(list.len(), 1, "贮藏条目回来了");
    assert!(list[0].message.starts_with("WIP on main"));
    s.oplog_undo(None, false).unwrap();
    assert_eq!(read(p, "a.txt"), "a2\n", "撤销贮藏：改动回到工作区");
    assert!(s.stash_list().unwrap().is_empty());
}

/// Shelf entries' files and diffs can be viewed, read from the patch without touching the worktree (spec §4.9)
#[test]
fn shelf_files_and_diff() {
    let d = repo();
    let p = d.path();
    write(p, "a.txt", "a1\na2\n");
    std::fs::remove_file(p.join("gone.txt")).unwrap();
    std::fs::write(p.join("img.bin"), [0u8, 1, 2, 3, 255]).unwrap();
    git(p, &["add", "img.bin"]);
    let s = Session::open(p).unwrap();
    let e = s.shelf_save("三个文件", &["a.txt".into(), "gone.txt".into(), "img.bin".into()]).unwrap();

    let files = s.shelf_files(e.id).unwrap();
    let f = |n: &str| files.iter().find(|f| f.path == n).unwrap().clone();
    assert_eq!((f("a.txt").added, f("a.txt").deleted), (1, 0));
    assert_eq!(f("gone.txt").deleted, 1);
    assert!(f("img.bin").binary);

    let a = s.shelf_diff(e.id, "a.txt", None).unwrap();
    let lines: Vec<_> = a.hunks[0].lines.iter().map(|l| (format!("{:?}", l.kind), l.text.clone(), l.new_no)).collect();
    assert_eq!(lines, vec![("Context".into(), "a1".into(), Some(1)), ("Add".into(), "a2".into(), Some(2))]);
    assert!(s.shelf_diff(e.id, "gone.txt", None).unwrap().hunks[0].lines.iter().all(|l| format!("{:?}", l.kind) == "Del"));
    assert!(s.shelf_diff(e.id, "img.bin", None).unwrap().binary);
    assert_eq!(s.shelf_diff(e.id, "b.txt", None).unwrap_err().code, ErrorCode::NotFound);

    // Viewing diffs doesn't change the worktree; unreadable after deletion
    assert_eq!(read(p, "a.txt"), "a1\n");
    s.shelf_delete(e.id).unwrap();
    assert!(s.shelf_files(e.id).is_err());
}

/// Restore only some files of a shelf entry (spec §4.9)
#[test]
fn shelf_restore_some_files() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    write(p, "a.txt", "a 改\n");
    write(p, "b.txt", "b 改\n");
    std::fs::remove_file(p.join("gone.txt")).unwrap();
    let e = s.shelf_save("三处改动", &["a.txt".into(), "b.txt".into(), "gone.txt".into()]).unwrap();
    s.shelf_save("另一个", &["a.txt".into()]).unwrap_err(); // a.txt has no changes anymore

    // Restore a.txt and gone.txt: b.txt stays on the shelf, entry name unchanged, new id
    let (_, op) = s.run_op("取回", OpKind::Shelf, |s| s.shelf_restore_files(e.id, &["a.txt".into(), "gone.txt".into()])).unwrap();
    assert!(op.is_some());
    assert_eq!(read(p, "a.txt"), "a 改\n");
    assert!(!p.join("gone.txt").exists());
    assert_eq!(read(p, "b.txt"), "b1\n");
    let list = s.shelf_list().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "三处改动");
    assert_ne!(list[0].id, e.id);
    assert_eq!(list[0].files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["b.txt"]);
    assert_eq!(s.shelf_files(list[0].id).unwrap().len(), 1);
    assert_eq!(s.shelf_diff(list[0].id, "b.txt", None).unwrap().hunks.len(), 1);

    // Undo: the worktree goes back and the whole original entry returns
    s.oplog_undo(None, false).unwrap();
    assert_eq!(read(p, "a.txt"), "a1\n");
    let list = s.shelf_list().unwrap();
    assert_eq!((list.len(), list[0].id, list[0].files.len()), (1, e.id, 3));

    // Restore the rest too: the entry is gone
    s.shelf_restore_files(e.id, &["b.txt".into()]).unwrap();
    let rest = s.shelf_list().unwrap()[0].id;
    s.shelf_restore_files(rest, &["a.txt".into(), "gone.txt".into()]).unwrap();
    assert!(s.shelf_list().unwrap().is_empty());
    assert_eq!((read(p, "a.txt"), read(p, "b.txt")), ("a 改\n".to_string(), "b 改\n".to_string()));

    assert_eq!(s.shelf_restore_files(rest, &[]).unwrap_err().code, ErrorCode::NothingSelected);
}

/// Conflicts during a partial restore: after aborting the original entry remains and the split-off entry is removed; after finishing only the split-off entry remains
#[test]
fn shelf_restore_some_files_conflict() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    write(p, "a.txt", "搁置的 a\n");
    write(p, "b.txt", "搁置的 b\n");
    let e = s.shelf_save("两处", &["a.txt".into(), "b.txt".into()]).unwrap();
    write(p, "a.txt", "提交里的 a\n");
    git(p, &["commit", "-qam", "改 a"]);
    s.reload().unwrap();

    assert_eq!(s.shelf_restore_files(e.id, &["a.txt".into()]).unwrap_err().code, ErrorCode::Conflicts);
    assert_eq!(s.state().unwrap().state, RepoMode::Unstashing);
    s.merge_abort().unwrap();
    let list = s.shelf_list().unwrap();
    assert_eq!((list.len(), list[0].id), (1, e.id), "中止后只有原条目");

    assert_eq!(s.shelf_restore_files(e.id, &["a.txt".into()]).unwrap_err().code, ErrorCode::Conflicts);
    s.merge_take_file("a.txt", Side::Theirs).unwrap();
    s.merge_finish().unwrap();
    assert_eq!(read(p, "a.txt"), "搁置的 a\n");
    assert_eq!(read(p, "b.txt"), "b1\n");
    let list = s.shelf_list().unwrap();
    assert_eq!(list.len(), 1);
    assert_ne!(list[0].id, e.id);
    assert_eq!(list[0].files[0].path, "b.txt");
}

/// Stash with untracked files (git stash -u): the list shows them, their diff is readable, undo and pop bring them back
#[test]
fn stash_with_untracked_files() {
    use strand_core::oplog::OpScope;
    let d = repo();
    let p = d.path();
    write(p, "a.txt", "a2\n");
    write(p, "new.txt", "新文件\n");
    let mut s = Session::open(p).unwrap();
    let scope = OpScope { files: vec!["new.txt".into()], ..Default::default() };
    s.run_op_scoped("贮藏", OpKind::Stash, &scope, |s| s.stash_push(Some("带新文件"), true)).unwrap();
    assert!(!p.join("new.txt").exists());
    assert_eq!(read(p, "a.txt"), "a1\n");
    let files = s.stash_files(0).unwrap();
    let paths: Vec<_> = files.iter().map(|f| (f.path.as_str(), format!("{:?}", f.status))).collect();
    assert!(paths.contains(&("a.txt", "M".into())) && paths.contains(&("new.txt", "A".into())), "{paths:?}");
    assert_eq!(s.stash_untracked_files(0).unwrap(), vec!["new.txt".to_string()]);
    let id = s.stash_list().unwrap()[0].id.clone();
    let diff = s.diff_commit(&id, "new.txt").unwrap();
    assert_eq!(diff.hunks[0].lines[0].text, "新文件");

    // Undo: the stash goes away and the untracked file is back
    s.reload().unwrap();
    s.oplog_undo(None, false).unwrap();
    assert_eq!(read(p, "new.txt"), "新文件\n");
    assert_eq!(read(p, "a.txt"), "a2\n");
    assert!(s.stash_list().unwrap().is_empty());
    s.oplog_redo().unwrap();
    assert!(!p.join("new.txt").exists());

    // Pop brings the untracked file back
    s.stash_apply(0, true).unwrap();
    assert_eq!(read(p, "new.txt"), "新文件\n");
    assert!(s.stash_list().unwrap().is_empty());
    // Without -u untracked files stay where they are
    s.stash_push(None, false).unwrap();
    assert_eq!(read(p, "new.txt"), "新文件\n");
}

/// Shelving untracked files: they leave the worktree (empty folders too), show in the entry, and come back on restore and undo
#[test]
fn shelf_with_untracked_files() {
    use strand_core::oplog::OpScope;
    let d = repo();
    let p = d.path();
    write(p, "a.txt", "a2\n");
    std::fs::create_dir_all(p.join("sub/deep")).unwrap();
    write(p, "sub/deep/n.txt", "n1\nn2\n");
    write(p, "keep.txt", "不搁置\n");
    let mut s = Session::open(p).unwrap();
    let paths = vec!["a.txt".to_string(), "sub/deep/n.txt".to_string()];
    let scope = OpScope { files: vec!["sub/deep/n.txt".into()], ..Default::default() };
    let (e, _) = s.run_op_scoped("搁置", OpKind::Shelf, &scope, |s| s.shelf_save("带新文件", &paths)).unwrap();
    assert!(!p.join("sub").exists(), "empty folders are removed");
    assert_eq!(read(p, "a.txt"), "a1\n");
    assert_eq!(read(p, "keep.txt"), "不搁置\n");
    let files = s.shelf_files(e.id).unwrap();
    let n = files.iter().find(|f| f.path == "sub/deep/n.txt").unwrap();
    assert_eq!((format!("{:?}", n.status), n.added), ("A".to_string(), 2));
    assert_eq!(s.shelf_diff(e.id, "sub/deep/n.txt", Some(1_000_000)).unwrap().hunks[0].lines.len(), 2);
    // The real index wasn't touched by the intent-to-add trick
    assert_eq!(git(p, &["status", "--porcelain", "--", "sub"]), "");

    s.reload().unwrap();
    s.oplog_undo(None, false).unwrap();
    assert_eq!(read(p, "sub/deep/n.txt"), "n1\nn2\n");
    assert_eq!(read(p, "a.txt"), "a2\n");
    s.oplog_redo().unwrap();
    assert!(!p.join("sub/deep/n.txt").exists());

    s.shelf_restore(e.id).unwrap();
    assert_eq!(read(p, "sub/deep/n.txt"), "n1\nn2\n");
    assert_eq!(read(p, "a.txt"), "a2\n");
    assert!(git(p, &["status", "--porcelain"]).contains("?? sub/"), "restored as untracked again");
}

/// A stash that no longer applies cleanly goes to a new branch made where it was stashed
#[test]
fn stash_to_new_branch() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    let git = |args: &[&str]| {
        let o = std::process::Command::new("git").args(args).current_dir(p).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
        assert!(o.status.success(), "{args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.name", "林夏"]);
    git(&["config", "user.email", "l@x.cn"]);
    std::fs::write(p.join("a.txt"), "1\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "一"]);
    let base = git(&["rev-parse", "HEAD"]);
    std::fs::write(p.join("a.txt"), "1 贮藏里的改动\n").unwrap();
    git(&["stash", "push", "-q", "-m", "试验"]);
    // main moves on and changes the same line: applying here would conflict
    std::fs::write(p.join("a.txt"), "1 main 上的改动\n").unwrap();
    git(&["commit", "-q", "-am", "二"]);

    let s = strand_core::Session::open(p).unwrap();
    assert_eq!(s.stash_branch(0, "main").unwrap_err().code, strand_core::ErrorCode::InvalidName);
    s.stash_branch(0, "试验分支").unwrap();
    assert_eq!(git(&["branch", "--show-current"]), "试验分支");
    assert_eq!(git(&["rev-parse", "HEAD"]), base);
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "1 贮藏里的改动\n");
    assert!(git(&["stash", "list"]).is_empty());
}
