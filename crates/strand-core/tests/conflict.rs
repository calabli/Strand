//! 冲突会话：读出修改块、按标记应用、整文件接受、完成、变基逐个提交、跳过。

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use strand_core::conflict::{ChangeMark, FileKind, Mark, Segment, SessionKind, Side, SideChange};
use strand_core::model::RepoMode;
use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> (bool, String) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_EDITOR", "true")
        .output()
        .unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn ok(dir: &Path, args: &[&str]) -> String {
    let (s, o) = git(dir, args);
    assert!(s, "git {args:?} 失败");
    o
}

fn write(dir: &Path, f: &str, s: &str) {
    std::fs::write(dir.join(f), s).unwrap();
}

/// main 和 feature 都改了 a.txt 的第 2 行；feature 还改了第 6 行（无冲突），删了 d.txt；main 改了 d.txt。
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    ok(p, &["init", "-q", "-b", "main"]);
    ok(p, &["config", "user.name", "林夏"]);
    ok(p, &["config", "user.email", "linxia@example.com"]);
    ok(p, &["config", "commit.gpgsign", "false"]);
    write(p, "a.txt", "1\n2\n3\n4\n5\n6\n7\n");
    write(p, "d.txt", "要被删的文件\n");
    write(p, "Cargo.lock", "lock v1\n");
    ok(p, &["add", "."]);
    ok(p, &["commit", "-q", "-m", "初始提交"]);
    ok(p, &["switch", "-q", "-c", "feature"]);
    write(p, "a.txt", "1\n2 对方\n3\n4\n5\n6 对方\n7\n");
    write(p, "Cargo.lock", "lock feature\n");
    ok(p, &["rm", "-q", "d.txt"]);
    ok(p, &["commit", "-q", "-am", "feature 的修改"]);
    ok(p, &["switch", "-q", "main"]);
    write(p, "a.txt", "1\n2 你的\n3\n4\n5\n6\n7\n");
    write(p, "d.txt", "main 改了它\n");
    write(p, "Cargo.lock", "lock main\n");
    ok(p, &["commit", "-q", "-am", "main 的修改"]);
    d
}

fn mark(m: Mark, t: Mark) -> ChangeMark {
    ChangeMark { mine: m, theirs: t, custom: None }
}

#[test]
fn merge_session_and_finish() {
    let d = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    assert!(s.merge_session().unwrap().is_none());
    assert_eq!(s.branch_merge("feature").unwrap_err().code, ErrorCode::Conflicts);

    let ms = s.merge_session().unwrap().unwrap();
    assert_eq!(ms.kind, SessionKind::Merge);
    assert_eq!(ms.mine.label, "main");
    assert_eq!(ms.theirs.label, "feature");
    assert_eq!(ms.theirs.title.as_deref(), Some("feature 的修改"));
    let paths: Vec<_> = ms.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["Cargo.lock", "a.txt", "d.txt"]);

    let lock = &ms.files[0];
    assert_eq!(lock.kind, FileKind::Lock);
    let d_txt = &ms.files[2];
    assert_eq!((d_txt.kind, d_txt.mine_change, d_txt.theirs_change), (FileKind::ModifyDelete, SideChange::Modified, SideChange::Deleted));

    let a = &ms.files[1];
    assert_eq!(a.kind, FileKind::Text);
    let changes: Vec<_> = a.segments.iter().filter_map(|s| if let Segment::Change(c) = s { Some(c) } else { None }).collect();
    assert_eq!(changes.len(), 2);
    assert!(changes[0].mine.is_some() && changes[0].theirs.is_some(), "第 2 行是冲突");
    assert!(changes[1].mine.is_none() && changes[1].theirs.is_some(), "第 6 行只有对方改");

    // 没标记完不能应用，也不能完成
    let mut marks = HashMap::new();
    marks.insert("c1".to_string(), mark(Mark::Accept, Mark::None));
    let e = s.merge_apply_file("a.txt", &marks).unwrap_err();
    assert_eq!(e.code, ErrorCode::UnmarkedBlocks);
    assert_eq!(e.detail.unwrap()["ids"], serde_json::json!(["c1", "c2"]));
    assert_eq!(s.merge_finish().unwrap_err().code, ErrorCode::UnmarkedBlocks);

    // 两边都接受 + 接受对方的无冲突修改
    marks.insert("c1".into(), mark(Mark::Accept, Mark::Accept));
    marks.insert("c2".into(), mark(Mark::None, Mark::Accept));
    s.merge_apply_file("a.txt", &marks).unwrap();
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "1\n2 你的\n2 对方\n3\n4\n5\n6 对方\n7\n");

    s.merge_take_file("Cargo.lock", Side::Theirs).unwrap();
    assert_eq!(std::fs::read_to_string(p.join("Cargo.lock")).unwrap(), "lock feature\n");
    // 对方删除了 d.txt：接受对方的就是删除
    s.merge_take_file("d.txt", Side::Theirs).unwrap();
    assert!(!p.join("d.txt").exists());

    // 都解决了：files 里还在，标记为已解决
    let ms = s.merge_session().unwrap().unwrap();
    assert!(ms.unresolved().next().is_none());
    assert_eq!(ms.files.iter().filter(|f| f.resolved).map(|f| f.path.as_str()).collect::<Vec<_>>(), ["Cargo.lock", "a.txt", "d.txt"]);
    let r = s.merge_finish().unwrap();
    assert!(r.done);
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(ok(p, &["log", "-1", "--format=%p"]).split(' ').count(), 2);
}

#[test]
fn manual_edit_and_conflict_markers() {
    let d = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    let _ = s.branch_merge("feature");
    let mut marks = HashMap::new();
    marks.insert("c1".to_string(), ChangeMark { custom: Some(vec!["<<<<<<< 手动写错了".into(), "2".into()]), ..Default::default() });
    marks.insert("c2".to_string(), mark(Mark::None, Mark::Discard));
    s.merge_apply_file("a.txt", &marks).unwrap();
    s.merge_take_file("Cargo.lock", Side::Mine).unwrap();
    s.merge_take_file("d.txt", Side::Mine).unwrap();
    assert!(p.join("d.txt").exists());
    // 结果里残留冲突标记，不能完成
    assert_eq!(s.merge_finish().unwrap_err().code, ErrorCode::ConflictMarkers);
    s.merge_abort().unwrap();
}

#[test]
fn rebase_swaps_sides_and_steps() {
    let d = repo();
    let p = d.path();
    // main 上再加一个改第 6 行的提交（和对方的第 6 行冲突），变成两个要重放的提交
    write(p, "a.txt", "1\n2 你的\n3\n4\n5\n6 你的\n7\n");
    ok(p, &["commit", "-q", "-am", "main 第二次修改"]);
    let s = Session::open(p).unwrap();
    let (rebased, _) = git(p, &["rebase", "feature"]);
    assert!(!rebased);

    let ms = s.merge_session().unwrap().unwrap();
    assert_eq!(ms.kind, SessionKind::Rebase);
    let step = ms.step.clone().unwrap();
    assert_eq!((step.index, step.total), (1, 2));
    // 变基时“你的”是正在重放的本地提交，“对方的”是目标分支
    assert_eq!(ms.mine.title.as_deref(), Some("main 的修改"));
    assert_eq!(ms.theirs.label, "feature");
    let a = ms.files.iter().find(|f| f.path == "a.txt").unwrap();
    let c = a.segments.iter().find_map(|s| if let Segment::Change(c) = s { Some(c) } else { None }).unwrap();
    assert_eq!(c.mine.as_deref(), Some(&["2 你的".to_string()][..]));
    assert_eq!(c.theirs.as_ref().unwrap()[0], "2 对方");

    // 第一个提交：a.txt 用对方的（保留了对方的第 6 行，第二个提交会在第 6 行冲突），其余用你的
    for f in &ms.files {
        let side = if f.path == "a.txt" { Side::Theirs } else { Side::Mine };
        s.merge_take_file(&f.path, side).unwrap();
    }
    let r = s.merge_finish().unwrap();
    assert!(!r.done, "第二个提交也有冲突");
    let next = r.next.unwrap();
    assert_eq!(next.step.unwrap().index, 2);
    assert_eq!(next.mine.title.as_deref(), Some("main 第二次修改"));

    // 第二个提交：跳过
    let r = s.merge_skip().unwrap();
    assert!(r.done);
    assert_eq!(s.state().unwrap().state, RepoMode::Normal);
    assert_eq!(ok(p, &["log", "-1", "--format=%s"]), "main 的修改");
}

/// 已解决的文件也列出来（说明书 8.2、8.10 的 resolved）：在命令行里 git add 的也算；完成或中止后记录清掉
#[test]
fn resolved_files_are_listed() {
    let d = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    let _ = s.branch_merge("feature");
    assert_eq!(s.merge_session().unwrap().unwrap().files.iter().filter(|f| !f.resolved).count(), 3);
    write(p, "a.txt", "命令行里改好的\n");
    ok(p, &["add", "a.txt"]);
    let ms = s.merge_session().unwrap().unwrap();
    let a = ms.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert!(a.resolved && a.segments.is_empty());
    assert_eq!((a.kind, a.mine_change, a.theirs_change), (FileKind::Text, SideChange::Modified, SideChange::Modified));
    assert_eq!(ms.unresolved().count(), 2);
    // 应用已解决的文件：不再有冲突
    assert_eq!(s.merge_take_file("a.txt", Side::Mine).unwrap_err().code, ErrorCode::NotFound);
    s.merge_abort().unwrap();
    assert!(!p.join(".git/strand/conflicts.json").exists());
    // 再合并一次：上次的“已解决”不会带过来
    let _ = s.branch_merge("feature");
    assert!(s.merge_session().unwrap().unwrap().files.iter().all(|f| !f.resolved));
    s.merge_abort().unwrap();

}

#[test]
fn resolved_before_strand_looked() {
    let d = repo();
    let p = d.path();
    let _ = git(p, &["merge", "feature"]);
    write(p, "a.txt", "命令行里改好的\n");
    ok(p, &["add", "a.txt"]);
    let s = Session::open(p).unwrap();
    let ms = s.merge_session().unwrap().unwrap();
    let done: Vec<_> = ms.files.iter().filter(|f| f.resolved).map(|f| f.path.as_str()).collect();
    assert_eq!(done, ["a.txt"]);
    assert_eq!(ms.unresolved().count(), 2);
}

/// 每个修改块是哪个提交引入的（说明书 8.10 的 Block.origin）
#[test]
fn change_blocks_carry_origin() {
    let d = repo();
    let p = d.path();
    // main 上再加一个提交，只改第 2 行：这一块的来源应该是它，而不是更早的“main 的修改”
    write(p, "a.txt", "1\n2 你的（又改）\n3\n4\n5\n6\n7\n");
    ok(p, &["commit", "-q", "-am", "main 再改第 2 行"]);
    let s = Session::open(p).unwrap();
    let _ = s.branch_merge("feature");
    let ms = s.merge_session().unwrap().unwrap();
    let a = ms.files.iter().find(|f| f.path == "a.txt").unwrap();
    let changes: Vec<_> = a.segments.iter().filter_map(|x| if let Segment::Change(c) = x { Some(c) } else { None }).collect();
    let c1 = changes.iter().find(|c| c.mine.is_some() && c.theirs.is_some()).unwrap();
    assert_eq!(c1.mine_origin.as_ref().unwrap().title, "main 再改第 2 行");
    assert_eq!(c1.theirs_origin.as_ref().unwrap().title, "feature 的修改");
    assert_eq!(c1.mine_origin.as_ref().unwrap().author, "林夏");
    // 只有对方改的那一块：你的一侧没有来源
    let c2 = changes.iter().find(|c| c.mine.is_none()).unwrap();
    assert!(c2.mine_origin.is_none() && c2.theirs_origin.is_some());
}

/// 两边把同一个文件重命名成不同名字（说明书 8.3）：合成一个“重命名”冲突，选一边的名字
#[test]
fn rename_rename_conflict() {
    for side in [Side::Mine, Side::Theirs] {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        ok(p, &["init", "-q", "-b", "main"]);
        ok(p, &["config", "user.name", "林夏"]);
        ok(p, &["config", "user.email", "linxia@example.com"]);
        write(p, "old.txt", "一\n二\n三\n四\n五\n");
        ok(p, &["add", "."]);
        ok(p, &["commit", "-q", "-m", "初始提交"]);
        ok(p, &["switch", "-q", "-c", "feature"]);
        ok(p, &["mv", "old.txt", "theirs.txt"]);
        ok(p, &["commit", "-q", "-m", "改名成 theirs"]);
        ok(p, &["switch", "-q", "main"]);
        ok(p, &["mv", "old.txt", "mine.txt"]);
        ok(p, &["commit", "-q", "-m", "改名成 mine"]);
        let s = Session::open(p).unwrap();
        assert_eq!(s.branch_merge("feature").unwrap_err().code, ErrorCode::Conflicts);
        let ms = s.merge_session().unwrap().unwrap();
        let open: Vec<_> = ms.unresolved().collect();
        assert_eq!(open.len(), 1, "{open:#?}");
        let f = open[0];
        assert_eq!((f.path.as_str(), f.kind), ("old.txt", FileKind::Rename));
        assert_eq!((f.mine_path.as_deref(), f.theirs_path.as_deref()), (Some("mine.txt"), Some("theirs.txt")));
        assert_eq!((f.mine_change, f.theirs_change), (SideChange::Renamed, SideChange::Renamed));

        s.merge_take_file("old.txt", side).unwrap();
        let after = s.merge_session().unwrap().unwrap();
        assert!(after.unresolved().next().is_none());
        // 解决后只列一行“old.txt 已解决”，两个新名字不当成单独的文件
        assert_eq!(after.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["old.txt"]);
        assert!(s.merge_finish().unwrap().done);
        let (keep, gone) = if side == Side::Mine { ("mine.txt", "theirs.txt") } else { ("theirs.txt", "mine.txt") };
        assert!(p.join(keep).exists() && !p.join(gone).exists() && !p.join("old.txt").exists());
        assert_eq!(ok(p, &["ls-files"]), keep);
    }
}
