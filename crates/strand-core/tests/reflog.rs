//! 操作记录：HEAD 和分支的记录从新到旧；被重置掉、不在日志里的提交也列出来，还能找回。

use std::path::Path;
use std::process::Command;

use strand_core::Session;

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

#[test]
fn reflog_lists_steps_newest_first_including_lost_commits() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    std::fs::write(p.join("a.txt"), "1\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "第一个"]);
    std::fs::write(p.join("a.txt"), "2\n").unwrap();
    git(p, &["commit", "-qam", "第二个"]);
    let lost = git(p, &["rev-parse", "HEAD"]);
    git(p, &["reset", "-q", "--hard", "HEAD~1"]);
    git(p, &["checkout", "-q", "-b", "dev"]);

    let s = Session::open(p).unwrap();
    let refs = s.reflog_refs().unwrap();
    assert_eq!(refs[0], "HEAD");
    assert!(refs.contains(&"main".to_string()) && refs.contains(&"dev".to_string()));

    let h = s.reflog("HEAD").unwrap();
    assert_eq!(h[0].action, "checkout");
    assert_eq!(h[0].message, "moving from main to dev");
    assert_eq!(h[1].action, "reset");
    // 被重置掉的提交：还在仓库里，但不在日志里
    let e = h.iter().find(|e| e.id == lost).unwrap();
    assert!(e.exists && !e.in_log);
    assert_eq!(e.title, "第二个");
    assert_eq!(h.last().unwrap().action, "commit (initial)");
    assert!(h.iter().enumerate().all(|(i, e)| e.index == i));

    let m = s.reflog("main").unwrap();
    assert_eq!(m.len(), 3);
    assert!(s.reflog("nope").is_err());
}
