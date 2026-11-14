//! Bisect: after marking bad and good it narrows step by step and finds the first bad commit; ending returns to the original branch.

use std::path::Path;
use std::process::Command;

use strand_core::bisect::BisectMark;
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
fn bisect_finds_first_bad_commit_and_resets() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    let mut ids = Vec::new();
    for i in 0..12 {
        // The problem starts at the 7th commit
        std::fs::write(p.join("state.txt"), if i >= 7 { "bug\n" } else { "ok\n" }).unwrap();
        std::fs::write(p.join("n.txt"), format!("{i}\n")).unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", &format!("第 {i} 个")]);
        ids.push(git(p, &["rev-parse", "HEAD"]));
    }
    let mut s = Session::open(p).unwrap();
    assert!(!s.bisect_status().unwrap().active);
    assert!(!s.state().unwrap().bisecting);
    assert!(s.bisect_mark(BisectMark::Skip, None).is_err());

    // Mark bad (current) and good (first): starts and checks out one in the middle
    s.bisect_mark(BisectMark::Bad, None).unwrap();
    let mut st = s.bisect_mark(BisectMark::Good, Some(&ids[0])).unwrap();
    s.reload().unwrap();
    let rs = s.state().unwrap();
    assert!(rs.bisecting);
    assert_eq!(rs.state, strand_core::model::RepoMode::Normal);
    assert!(st.active && st.bad.is_some() && st.good.len() == 1 && st.steps.is_some());
    let mut rounds = 0;
    while st.first_bad.is_none() {
        rounds += 1;
        assert!(rounds < 8);
        let bug = std::fs::read_to_string(p.join("state.txt")).unwrap().contains("bug");
        st = s.bisect_mark(if bug { BisectMark::Bad } else { BisectMark::Good }, None).unwrap();
    }
    assert_eq!(st.first_bad.as_deref(), Some(ids[7].as_str()));
    assert_eq!(st.first_bad_title.as_deref(), Some("第 7 个"));
    assert!(rounds <= 4);

    s.bisect_reset().unwrap();
    assert!(!s.bisect_status().unwrap().active);
    assert_eq!(git(p, &["branch", "--show-current"]), "main");
}
