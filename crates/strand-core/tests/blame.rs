//! 逐行追溯（说明书 10.2）。

use std::path::Path;
use std::process::Command;

use strand_core::{ErrorCode, Session};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit_as(p: &Path, who: &str, text: &str, msg: &str) -> String {
    std::fs::write(p.join("a.txt"), text).unwrap();
    git(p, &["add", "a.txt"]);
    git(p, &["-c", &format!("user.name={who}"), "-c", "user.email=x@example.com", "commit", "-q", "-m", msg]);
    git(p, &["rev-parse", "HEAD"])
}

#[test]
fn blame_lines_pages_and_worktree() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    let c1 = commit_as(p, "林夏", "一\n二\n三\n四\n", "第一版\n\n正文说明");
    let c2 = commit_as(p, "周舟", "一\n二改\n三\n四\n", "改第二行");
    let s = Session::open(p).unwrap();

    let all = s.blame_file("a.txt", Some("HEAD"), 0, 100).unwrap();
    assert_eq!(all.total, 4);
    let who: Vec<(&str, &str)> = all.lines.iter().map(|l| (l.text.as_str(), all.commits[l.commit as usize].id.as_str())).collect();
    assert_eq!(who, [("一", c1.as_str()), ("二改", c2.as_str()), ("三", c1.as_str()), ("四", c1.as_str())]);
    let first = &all.commits[all.lines[0].commit as usize];
    assert_eq!((first.title.as_str(), first.body.as_str(), first.author.as_str()), ("第一版", "正文说明", "林夏"));
    assert!(first.in_log && !first.uncommitted);

    // 分页
    let page = s.blame_file("a.txt", Some("HEAD"), 2, 1).unwrap();
    assert_eq!((page.offset, page.lines.len(), page.lines[0].no, page.lines[0].text.as_str()), (2, 1, 3, "三"));
    assert!(s.blame_file("a.txt", Some("HEAD"), 10, 5).unwrap().lines.is_empty());

    // 某个旧版本
    let old = s.blame_file("a.txt", Some(&c1), 0, 100).unwrap();
    assert!(old.lines.iter().all(|l| old.commits[l.commit as usize].id == c1));

    // 工作区：没提交的行
    std::fs::write(p.join("a.txt"), "一\n二改\n三\n四\n五（没提交）").unwrap();
    let wt = s.blame_file("a.txt", None, 0, 100).unwrap();
    assert_eq!(wt.total, 5);
    let last = &wt.commits[wt.lines[4].commit as usize];
    assert!(last.uncommitted && !last.in_log);

    assert_eq!(s.blame_file("没有.txt", Some("HEAD"), 0, 10).unwrap_err().code, ErrorCode::NotFound);
}
