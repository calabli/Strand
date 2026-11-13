//! 贮藏和暂存架（说明书 4.9），以及取回时的冲突和撤销。

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
    assert_eq!(s.stash_push(None).unwrap_err().code, ErrorCode::NothingSelected);

    write(p, "a.txt", "a2\n");
    s.stash_push(Some("改 a")).unwrap();
    assert_eq!(read(p, "a.txt"), "a1\n");
    write(p, "b.txt", "b2\n");
    s.stash_push(None).unwrap();
    let list = s.stash_list().unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[1].message.ends_with("改 a"));
    assert_eq!(s.stash_files(1).unwrap()[0].path, "a.txt");

    // 取回但保留
    s.stash_apply(1, false).unwrap();
    assert_eq!(read(p, "a.txt"), "a2\n");
    assert_eq!(s.stash_list().unwrap().len(), 2);
    // 取回并删除
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
    s.stash_push(None).unwrap();
    write(p, "a.txt", "提交里的 a\n");
    git(p, &["commit", "-qam", "改 a"]);
    write(p, "b.txt", "我在改 b\n");
    s.reload().unwrap();

    // 取回冲突：进入“取回进行中”
    let err = s.stash_apply(0, true).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflicts);
    assert_eq!(s.state().unwrap().state, RepoMode::Unstashing);
    let session = s.merge_session().unwrap().unwrap();
    assert_eq!(session.kind, SessionKind::Unstash);
    assert_eq!(session.mine.label, "工作区");
    assert!(session.theirs.label.starts_with("WIP on main"));
    assert_eq!(session.files[0].path, "a.txt");

    // 中止：回到取回之前，贮藏还在，b.txt 上的改动保留
    s.merge_abort().unwrap();
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(read(p, "a.txt"), "提交里的 a\n");
    assert_eq!(read(p, "b.txt"), "我在改 b\n");
    assert_eq!(s.stash_list().unwrap().len(), 1);

    // 再取回，这次整文件接受“对方的”（取回的改动）并完成：贮藏被删除
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
    // 修改、删除、新增（已加入版本控制）三种；还有一个不搁置的文件
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

    // 撤销搁置：改动回到工作区，条目从暂存架消失；重做又搁置回去
    s.oplog_undo(None, false).unwrap();
    assert_eq!(read(p, "a.txt"), "搁置的 a\n");
    assert!(s.shelf_list().unwrap().is_empty());
    s.oplog_redo().unwrap();
    assert_eq!(read(p, "a.txt"), "a1\n");
    assert_eq!(s.shelf_list().unwrap()[0].id, e.id);

    // 取回时冲突
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
    s.run_op("贮藏", OpKind::Other, |s| s.stash_push(None)).unwrap();
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

/// 暂存架条目可以看文件和差异，从补丁里读，不碰工作区（说明书 4.9）
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

    let a = s.shelf_diff(e.id, "a.txt").unwrap();
    let lines: Vec<_> = a.hunks[0].lines.iter().map(|l| (format!("{:?}", l.kind), l.text.clone(), l.new_no)).collect();
    assert_eq!(lines, vec![("Context".into(), "a1".into(), Some(1)), ("Add".into(), "a2".into(), Some(2))]);
    assert!(s.shelf_diff(e.id, "gone.txt").unwrap().hunks[0].lines.iter().all(|l| format!("{:?}", l.kind) == "Del"));
    assert!(s.shelf_diff(e.id, "img.bin").unwrap().binary);
    assert_eq!(s.shelf_diff(e.id, "b.txt").unwrap_err().code, ErrorCode::NotFound);

    // 看差异不改工作区；删掉后读不到
    assert_eq!(read(p, "a.txt"), "a1\n");
    s.shelf_delete(e.id).unwrap();
    assert!(s.shelf_files(e.id).is_err());
}

/// 只取回暂存架条目里的部分文件（说明书 4.9）
#[test]
fn shelf_restore_some_files() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    write(p, "a.txt", "a 改\n");
    write(p, "b.txt", "b 改\n");
    std::fs::remove_file(p.join("gone.txt")).unwrap();
    let e = s.shelf_save("三处改动", &["a.txt".into(), "b.txt".into(), "gone.txt".into()]).unwrap();
    s.shelf_save("另一个", &["a.txt".into()]).unwrap_err(); // a.txt 已经没改动了

    // 取回 a.txt 和 gone.txt：b.txt 留在暂存架，条目名字不变、换了编号
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
    assert_eq!(s.shelf_diff(list[0].id, "b.txt").unwrap().hunks.len(), 1);

    // 撤销：工作区回去，原条目整个回来
    s.oplog_undo(None, false).unwrap();
    assert_eq!(read(p, "a.txt"), "a1\n");
    let list = s.shelf_list().unwrap();
    assert_eq!((list.len(), list[0].id, list[0].files.len()), (1, e.id, 3));

    // 剩下的再全部取回：条目没了
    s.shelf_restore_files(e.id, &["b.txt".into()]).unwrap();
    let rest = s.shelf_list().unwrap()[0].id;
    s.shelf_restore_files(rest, &["a.txt".into(), "gone.txt".into()]).unwrap();
    assert!(s.shelf_list().unwrap().is_empty());
    assert_eq!((read(p, "a.txt"), read(p, "b.txt")), ("a 改\n".to_string(), "b 改\n".to_string()));

    assert_eq!(s.shelf_restore_files(rest, &[]).unwrap_err().code, ErrorCode::NothingSelected);
}

/// 部分取回时冲突：中止后原条目还在、另存的条目去掉；完成后只剩另存的条目
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
