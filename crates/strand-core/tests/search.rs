//! Searching by content: in historical changes (git log -S / -G, a kind of log filter), which files in a commit match, full-text search of project files (git grep).

use std::path::Path;
use std::process::Command;

use strand_core::log_filter::{LogFilter, LogSort, SearchIn};
use strand_core::search::project_search;
use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "林夏")
        .env("GIT_AUTHOR_EMAIL", "l@x.cn")
        .env("GIT_COMMITTER_NAME", "林夏")
        .env("GIT_COMMITTER_EMAIL", "l@x.cn")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(dir: &Path, f: &str, s: &str) {
    let p = dir.join(f);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, s).unwrap();
}

fn commit(dir: &Path, msg: &str) {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", msg]);
}

/// 1 add fetchUser → 2 change another line → 3 also call fetchUser in another file → 4 remove fetchUser from a
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    write(p, "src/a.js", "function fetchUser(id) {\n  return id;\n}\n");
    commit(p, "加 fetchUser");
    write(p, "src/a.js", "function fetchUser(id) {\n  return id + 1;\n}\n");
    commit(p, "改了返回值");
    write(p, "src/b.js", "const u = fetchUser(1);\nconst v = FETCHUSER(2);\n");
    commit(p, "b 里调用");
    write(p, "src/a.js", "function loadUser(id) {\n  return id + 1;\n}\n");
    commit(p, "改名成 loadUser");
    write(p, "notes.md", "记得改 fetchUser 的调用\n");
    d
}

fn titles(s: &mut Session, f: &LogFilter) -> Vec<String> {
    let t0 = std::time::Instant::now();
    loop {
        let p = s.log_query(f, LogSort::Topo, 0, 100).unwrap();
        if !p.partial {
            return p.rows.into_iter().map(|c| c.title).collect();
        }
        assert!(t0.elapsed().as_secs() < 10);
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn changes(text: &str) -> LogFilter {
    LogFilter { text: text.into(), search_in: SearchIn::Changes, case_sensitive: true, ..Default::default() }
}

#[test]
fn search_history_changes() {
    let d = repo();
    let mut s = Session::open(d.path()).unwrap();
    // Text: commits where the occurrence count changed (added, called, removed); "changed the return value", which only changed another line, doesn't count
    assert_eq!(titles(&mut s, &changes("fetchUser")), ["改名成 loadUser", "b 里调用", "加 fetchUser"]);
    // Case-insensitive: FETCHUSER in b.js counts too, but "call in b" was already there
    let ci = LogFilter { case_sensitive: false, ..changes("fetchuser") };
    assert_eq!(titles(&mut s, &ci), ["改名成 loadUser", "b 里调用", "加 fetchUser"]);
    // Regex: a matching changed line counts, and "changed the return value" changed the return line
    let re = LogFilter { regex: true, ..changes(r"return id( \+ 1)?;") };
    assert_eq!(titles(&mut s, &re), ["改了返回值", "加 fetchUser"]);
    // Combined with a path
    let path = LogFilter { path: Some("b.js".into()), ..changes("fetchUser") };
    assert_eq!(titles(&mut s, &path), ["b 里调用"]);
    // Commits with the word only in the message don't count; message search works as before
    assert_eq!(titles(&mut s, &LogFilter { text: "loadUser".into(), ..Default::default() }), ["改名成 loadUser"]);
    // Bad regex
    let bad = LogFilter { regex: true, ..changes("(fetch") };
    let e = loop {
        match s.log_query(&bad, LogSort::Topo, 0, 10) {
            Err(e) => break e,
            Ok(p) if p.partial => std::thread::sleep(std::time::Duration::from_millis(10)),
            Ok(p) => panic!("应该报错，得到 {} 行", p.total),
        }
    };
    assert_eq!(e.code, ErrorCode::InvalidRegex);
}

#[test]
fn partial_clone_refuses_history_search() {
    let d = repo();
    git(d.path(), &["remote", "add", "origin", "https://example.invalid/x.git"]);
    git(d.path(), &["config", "remote.origin.promisor", "true"]);
    let mut s = Session::open(d.path()).unwrap();
    let e = s.log_query(&changes("fetchUser"), LogSort::Topo, 0, 10).unwrap_err();
    assert_eq!(e.code, ErrorCode::PartialClone);
    // Message search is unaffected
    assert!(s.log_query(&LogFilter { text: "fetch".into(), ..Default::default() }, LogSort::Topo, 0, 10).is_ok());
}

#[test]
fn files_matching_in_a_commit() {
    let d = repo();
    let s = Session::open(d.path()).unwrap();
    let id = git(d.path(), &["rev-parse", "HEAD"]);
    let m = s.commit_change_matches(&id, "fetchUser", false, true).unwrap();
    assert_eq!(m.iter().map(|x| (x.path.as_str(), x.lines)).collect::<Vec<_>>(), [("src/a.js", 1)]);
    let b = git(d.path(), &["rev-parse", "HEAD~1"]);
    let m = s.commit_change_matches(&b, "fetchuser", false, false).unwrap();
    assert_eq!(m.iter().map(|x| (x.path.as_str(), x.lines)).collect::<Vec<_>>(), [("src/b.js", 2)]);
}

#[test]
fn project_search_worktree_and_versions() {
    let d = repo();
    let p = d.path();
    // Worktree: includes the untracked notes.md
    let r = project_search(p, "fetchUser", false, true, None).unwrap();
    let got: Vec<(&str, Vec<u32>)> = r.files.iter().map(|f| (f.path.as_str(), f.hits.iter().map(|h| h.line).collect())).collect();
    assert_eq!(got, [("notes.md", vec![1]), ("src/b.js", vec![1])]);
    assert_eq!(r.total, 2);
    assert_eq!(r.files[1].hits[0].text, "const u = fetchUser(1);");
    // Case-insensitive
    assert_eq!(project_search(p, "fetchuser", false, false, None).unwrap().total, 3);
    // A revision: in the earliest commit a.js still has fetchUser
    let first = git(p, &["rev-list", "--max-parents=0", "HEAD"]);
    let r = project_search(p, "fetchUser", false, true, Some(&first)).unwrap();
    assert_eq!(r.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["src/a.js"]);
    // Regex
    let r = project_search(p, r"(load|fetch)User\(", true, true, None).unwrap();
    assert_eq!(r.total, 2);
    // No matches
    assert_eq!(project_search(p, "没有这个词", false, true, None).unwrap().total, 0);
    // Bad regex
    assert_eq!(project_search(p, "(x", true, true, None).unwrap_err().code, ErrorCode::InvalidRegex);
}

/// Search and path filtering only scan the log's refs: Strand's undo snapshots in refs/strand/ops/* aren't scanned
#[test]
fn background_queries_skip_internal_snapshots() {
    let d = repo();
    let p = d.path();
    let mut s = Session::open(p).unwrap();
    // Do one write, leaving a snapshot commit (its tree has paths like before-worktree/src/a.js)
    s.run_op("新建分支 x", strand_core::oplog::OpKind::Branch, |s| s.branch_create("x", None, false)).unwrap();
    assert!(!git(p, &["for-each-ref", "refs/strand/ops"]).is_empty(), "应该有快照引用");
    let snapshots: Vec<String> = git(p, &["log", "--format=%H", "--glob=refs/strand/ops/*", "--no-walk"]).lines().map(str::to_string).collect();
    let hits = strand_core::log_filter::path_commits(p, "a.js", false).unwrap();
    assert!(!hits.is_empty());
    assert!(hits.iter().all(|h| !snapshots.contains(&h.to_string())), "路径过滤扫到了内部快照");
    // Change search results are all in the log too
    assert_eq!(titles(&mut s, &changes("fetchUser")), ["改名成 loadUser", "b 里调用", "加 fetchUser"]);
}
