//! Worktree status, diffs, commits, commit details, file watching.

use std::path::Path;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use strand_core::model::{ChangeScope, FileStatus, LineKind, SelectedFile, Selection};
use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "林夏")
        .env("GIT_AUTHOR_EMAIL", "linxia@example.com")
        .env("GIT_COMMITTER_NAME", "林夏")
        .env("GIT_COMMITTER_EMAIL", "linxia@example.com")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {:?}：{}", args, String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn write(dir: &Path, f: &str, s: &str) {
    if let Some(p) = Path::new(f).parent() {
        std::fs::create_dir_all(dir.join(p)).unwrap();
    }
    std::fs::write(dir.join(f), s).unwrap();
}

/// A repository with two commits; author info is written to the repository config for `commit_create` calling system git.
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    git(p, &["config", "commit.gpgsign", "false"]);
    write(p, ".gitignore", "target/\n");
    write(p, "src/lib.rs", "fn a() {}\nfn b() {}\nfn c() {}\n");
    write(p, "README.md", "说明\n");
    write(p, "old.txt", "旧文件的内容，足够长以便被识别为重命名。\n第二行。\n第三行。\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "初始提交"]);
    write(p, "src/lib.rs", "fn a() {}\nfn b2() {}\nfn c() {}\nfn d() {}\n");
    git(p, &["commit", "-q", "-am", "修改 lib"]);
    d
}

fn sel(paths: &[&str]) -> Selection {
    Selection { files: paths.iter().map(|p| SelectedFile { path: p.to_string(), old_path: None, whole: true, lines: vec![] }).collect() }
}

#[test]
fn status_lists_changes_and_untracked() {
    let d = repo();
    let p = d.path();
    write(p, "src/lib.rs", "fn a() {}\nfn c() {}\n");
    std::fs::remove_file(p.join("README.md")).unwrap();
    write(p, "new.txt", "新文件\n");
    write(p, "target/build.log", "被忽略\n");
    git(p, &["mv", "old.txt", "renamed.txt"]);
    write(p, "staged.txt", "已暂存\n");
    git(p, &["add", "staged.txt"]);

    let s = Session::open(p).unwrap();
    let st = s.status().unwrap();
    let by = |path: &str| st.changes.iter().find(|c| c.path == path).unwrap_or_else(|| panic!("没有 {path}：{:?}", st.changes));
    assert_eq!(by("src/lib.rs").status, FileStatus::M);
    assert_eq!((by("src/lib.rs").added, by("src/lib.rs").deleted), (0, 2));
    assert_eq!(by("README.md").status, FileStatus::D);
    assert_eq!(by("staged.txt").status, FileStatus::A);
    let r = by("renamed.txt");
    assert_eq!(r.status, FileStatus::R);
    assert_eq!(r.old_path.as_deref(), Some("old.txt"));
    assert_eq!(st.untracked, vec!["new.txt".to_string()]);
}

#[test]
fn worktree_diff_has_hunks_and_line_numbers() {
    let d = repo();
    let p = d.path();
    write(p, "src/lib.rs", "fn a() {}\nfn b2() {}\nfn c() {}\nfn d() {}\nfn e() {}\n");
    write(p, "new.txt", "一\n二\n");
    let s = Session::open(p).unwrap();

    let f = s.diff_worktree("src/lib.rs", false, 3).unwrap();
    assert_eq!(f.hunks.len(), 1);
    let added: Vec<_> = f.hunks[0].lines.iter().filter(|l| l.kind == LineKind::Add).collect();
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].text, "fn e() {}");
    assert_eq!(added[0].new_no, Some(5));

    let n = s.diff_worktree("new.txt", false, 3).unwrap();
    assert_eq!(n.hunks[0].lines.len(), 2);
    assert!(n.hunks[0].lines.iter().all(|l| l.kind == LineKind::Add));
}

#[test]
fn commit_only_selected_files() {
    let d = repo();
    let p = d.path();
    write(p, "src/lib.rs", "改了\n");
    write(p, "README.md", "也改了\n");
    let mut s = Session::open(p).unwrap();

    let id = s.commit_create("只提交 lib\n\n正文", &sel(&["src/lib.rs"]), false, None).unwrap();
    assert_eq!(id.len(), 40);
    s.reload().unwrap();
    let page = s.log_page(0, 10).unwrap();
    assert_eq!(page.rows[0].id, id);
    assert_eq!(page.rows[0].title, "只提交 lib");
    assert_eq!(page.rows[0].body, "正文");

    let st = s.status().unwrap();
    let paths: Vec<_> = st.changes.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(paths, vec!["README.md"], "没勾选的文件应当留在工作区");

    let det = s.commit_detail(&id).unwrap();
    assert_eq!(det.files.len(), 1);
    assert_eq!(det.files[0].path, "src/lib.rs");
}

#[test]
fn commit_validation() {
    let d = repo();
    let p = d.path();
    write(p, "README.md", "改了\n");
    let s = Session::open(p).unwrap();
    assert_eq!(s.commit_create("  \n正文", &sel(&["README.md"]), false, None).unwrap_err().code, ErrorCode::EmptyMessage);
    assert_eq!(s.commit_create("说明", &sel(&[]), false, None).unwrap_err().code, ErrorCode::NothingSelected);
}

#[test]
fn commit_detail_and_diff() {
    let d = repo();
    let s = Session::open(d.path()).unwrap();
    let page = s.log_page(0, 10).unwrap();
    let head = &page.rows[0];
    let det = s.commit_detail(&head.id).unwrap();
    assert_eq!(det.files.len(), 1);
    let f = &det.files[0];
    assert_eq!((f.path.as_str(), f.status, f.added, f.deleted), ("src/lib.rs", FileStatus::M, 2, 1));

    let diff = s.diff_commit(&head.id, "src/lib.rs").unwrap();
    let dels: Vec<_> = diff.hunks.iter().flat_map(|h| &h.lines).filter(|l| l.kind == LineKind::Del).map(|l| l.text.as_str()).collect();
    assert_eq!(dels, vec!["fn b() {}"]);

    // A root commit diffs against the empty tree; every file is added
    let root = s.commit_detail(&page.rows[1].id).unwrap();
    assert_eq!(root.files.len(), 4);
    assert!(root.files.iter().all(|f| f.status == FileStatus::A));

    assert_eq!(s.commit_detail("0000000000000000000000000000000000000000").unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn watcher_reports_scopes() {
    let d = repo();
    let p = d.path().canonicalize().unwrap();
    let (tx, rx) = mpsc::channel();
    let _w = strand_core::watch::watch(&p, move |s| {
        let _ = tx.send(s);
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(500));

    let collect = |rx: &mpsc::Receiver<Vec<ChangeScope>>| {
        let mut all = Vec::new();
        while let Ok(s) = rx.recv_timeout(Duration::from_millis(1500)) {
            all.extend(s);
        }
        all
    };

    write(&p, "target/out.log", "被忽略的文件不应触发\n");
    assert!(collect(&rx).is_empty(), "忽略的文件触发了刷新");

    write(&p, "README.md", "改了\n");
    assert!(collect(&rx).contains(&ChangeScope::Status));

    git(&p, &["branch", "feature"]);
    assert!(collect(&rx).contains(&ChangeScope::Refs));

    // Stash on the command line: only Stash (and Status for the worktree) is reported, not Refs (stashes aren't in the log)
    write(&p, "README.md", "再改\n");
    git(&p, &["stash", "push", "-q"]);
    let s = collect(&rx);
    assert!(s.contains(&ChangeScope::Stash) && !s.contains(&ChangeScope::Refs), "{s:?}");

    // Shelf files changed: Shelf is reported
    let shelf = p.join(".git/strand/shelf");
    std::fs::create_dir_all(&shelf).unwrap();
    std::fs::write(shelf.join("index.json"), "{}").unwrap();
    assert!(collect(&rx).contains(&ChangeScope::Shelf));
}

/// Worktree status first finds changed files with git status (spec §15): paths with spaces or Chinese, untracked files in subdirectories,
/// half-staged files and type changes are all listed as before; both lists are empty when nothing changed
#[test]
fn status_handles_odd_paths() {
    let d = repo();
    let p = d.path();
    let s = Session::open(p).unwrap();
    let st = s.status().unwrap();
    assert!(st.changes.is_empty() && st.untracked.is_empty());

    write(p, "带 空格 的 目录/文件 一.txt", "新\n");
    git(p, &["add", "带 空格 的 目录/文件 一.txt"]);
    git(p, &["commit", "-q", "-m", "加一个路径奇怪的文件"]);
    write(p, "带 空格 的 目录/文件 一.txt", "改了\n");
    write(p, "新目录/深/没跟踪 的.txt", "x\n");
    write(p, "target/忽略.txt", "x\n");
    write(p, "README.md", "说明（暂存）\n");
    git(p, &["add", "README.md"]);
    write(p, "README.md", "说明（暂存后又改）\n");
    std::fs::remove_file(p.join("src/lib.rs")).unwrap();
    let st = s.status().unwrap();
    let paths: Vec<(&str, FileStatus)> = st.changes.iter().map(|c| (c.path.as_str(), c.status)).collect();
    assert_eq!(paths, vec![("README.md", FileStatus::M), ("src/lib.rs", FileStatus::D), ("带 空格 的 目录/文件 一.txt", FileStatus::M)]);
    assert_eq!(st.untracked, vec!["新目录/深/没跟踪 的.txt"]);
    let readme = st.changes.iter().find(|c| c.path == "README.md").unwrap();
    assert_eq!((readme.added, readme.deleted), (1, 1), "按工作区内容相对 HEAD 算");
}
