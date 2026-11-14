//! Submodules and Git LFS pointers.

use std::path::Path;
use std::process::Command;

use strand_core::remote::Cancel;
use strand_core::submodules::{self, SubmoduleState};
use strand_core::Session;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "protocol.file.allow=always"])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

fn init(p: &Path) {
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
}

/// Submodule clones of local paths are blocked by default (git ≥ 2.38); allow them for the git that Strand runs too
fn allow_file_protocol() {
    // SAFETY: tests in this file all set the same values
    unsafe {
        std::env::set_var("GIT_CONFIG_COUNT", "1");
        std::env::set_var("GIT_CONFIG_KEY_0", "protocol.file.allow");
        std::env::set_var("GIT_CONFIG_VALUE_0", "always");
    }
}

#[test]
fn list_update_and_states() {
    allow_file_protocol();
    let lib = tempfile::tempdir().unwrap();
    let l = lib.path();
    init(l);
    std::fs::write(l.join("lib.txt"), "v1\n").unwrap();
    git(l, &["add", "."]);
    git(l, &["commit", "-q", "-m", "库 v1"]);
    let v1 = git(l, &["rev-parse", "HEAD"]);

    let app = tempfile::tempdir().unwrap();
    let a = app.path();
    init(a);
    std::fs::write(a.join("a.txt"), "a\n").unwrap();
    git(a, &["submodule", "add", "-q", l.to_str().unwrap(), "vendor/lib"]);
    git(a, &["add", "."]);
    git(a, &["commit", "-q", "-m", "加子模块"]);

    let subs = submodules::list(a).unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].path, "vendor/lib");
    assert_eq!(subs[0].state, SubmoduleState::Clean);
    assert_eq!(subs[0].recorded.as_deref(), Some(v1.as_str()));
    assert_eq!(subs[0].url.as_deref(), Some(l.to_str().unwrap()));
    assert!(Session::open(a).unwrap().state().unwrap().submodules);

    // Changes inside the submodule
    std::fs::write(a.join("vendor/lib/lib.txt"), "changed\n").unwrap();
    let s = &submodules::list(a).unwrap()[0];
    assert_eq!((s.state, s.dirty), (SubmoduleState::Dirty, true));
    git(&a.join("vendor/lib"), &["checkout", "-q", "--", "."]);

    // Another commit checked out inside: Moved; update goes back to the recorded one
    std::fs::write(l.join("lib.txt"), "v2\n").unwrap();
    git(l, &["commit", "-q", "-am", "库 v2"]);
    git(&a.join("vendor/lib"), &["pull", "-q", "origin", "main"]);
    let s = &submodules::list(a).unwrap()[0];
    assert_eq!(s.state, SubmoduleState::Moved);
    assert_ne!(s.current, s.recorded);
    submodules::update(a, &["vendor/lib".to_string()], &Cancel::default(), &|_| {}).unwrap();
    let s = &submodules::list(a).unwrap()[0];
    assert_eq!((s.state, s.current.as_deref()), (SubmoduleState::Clean, Some(v1.as_str())));

    // A fresh clone: not initialized until updated
    let other = tempfile::tempdir().unwrap();
    let c = other.path().join("clone");
    git(other.path(), &["clone", "-q", a.to_str().unwrap(), "clone"]);
    let s = &submodules::list(&c).unwrap()[0];
    assert_eq!((s.state, s.current.as_deref()), (SubmoduleState::Uninitialized, None));
    submodules::update(&c, &[], &Cancel::default(), &|_| {}).unwrap();
    assert_eq!(submodules::list(&c).unwrap()[0].state, SubmoduleState::Clean);
    assert_eq!(std::fs::read_to_string(c.join("vendor/lib/lib.txt")).unwrap(), "v1\n");

    // Unknown path
    assert!(submodules::update(&c, &["nope".to_string()], &Cancel::default(), &|_| {}).is_err());
    // No .gitmodules: empty, and the repo state says so
    assert!(submodules::list(l).unwrap().is_empty());
    assert!(!Session::open(l).unwrap().state().unwrap().submodules);
}

fn sha256_hex(data: &[u8]) -> String {
    use std::io::Write;
    let mut c = Command::new("shasum").args(["-a", "256"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    c.stdin.take().unwrap().write_all(data).unwrap();
    String::from_utf8(c.wait_with_output().unwrap().stdout).unwrap().split_whitespace().next().unwrap().to_string()
}

/// Write an LFS pointer for `content` and, when `download`, the object in .git/lfs/objects
fn lfs_pointer(repo: &Path, content: &[u8], download: bool) -> String {
    let oid = sha256_hex(content);
    if download {
        let obj = repo.join(".git/lfs/objects").join(&oid[..2]).join(&oid[2..4]);
        std::fs::create_dir_all(&obj).unwrap();
        std::fs::write(obj.join(&oid), content).unwrap();
    }
    format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize {}\n", content.len())
}

#[test]
fn lfs_pointers_show_real_content() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    init(p);
    std::fs::write(p.join(".gitattributes"), "*.dat filter=lfs diff=lfs merge=lfs -text\n").unwrap();
    std::fs::write(p.join("big.dat"), lfs_pointer(p, b"line one\nline two\n", true)).unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "加 LFS 文件"]);
    std::fs::write(p.join("big.dat"), lfs_pointer(p, b"line one\nline 2\n", true)).unwrap();
    std::fs::write(p.join("gone.dat"), lfs_pointer(p, b"never downloaded\n", false)).unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "改 LFS 文件"]);
    let head = git(p, &["rev-parse", "HEAD"]);

    let s = Session::open(p).unwrap();
    assert!(s.state().unwrap().lfs);

    // File view: the downloaded content, not the pointer
    let t = s.file_text("big.dat", Some(&head)).unwrap();
    assert_eq!(t.text.as_deref(), Some("line one\nline 2\n"));
    assert!(t.lfs_missing.is_none());
    // Not downloaded: the pointer text, and which object is missing
    let t = s.file_text("gone.dat", Some(&head)).unwrap();
    assert!(t.text.unwrap().starts_with("version https://git-lfs"));
    assert_eq!(t.lfs_missing.unwrap().size, 17);
    assert_eq!(s.file_bytes("big.dat", Some(&head)).unwrap(), b"line one\nline 2\n");

    // Commit diff compares the real contents
    let fd = s.diff_commit(&head, "big.dat").unwrap();
    let text: Vec<String> = fd.hunks.iter().flat_map(|h| h.lines.iter().map(|l| format!("{:?}{}", l.kind, l.text))).collect();
    assert!(text.iter().any(|l| l.ends_with("line two")), "{text:?}");
    assert!(text.iter().any(|l| l.ends_with("line 2")), "{text:?}");
    assert!(!text.iter().any(|l| l.contains("oid sha256")), "{text:?}");

    // Worktree holding the real content (as git-lfs leaves it) against a pointer in HEAD: no difference
    std::fs::write(p.join("big.dat"), "line one\nline 2\n").unwrap();
    let fd = s.diff_worktree("big.dat", false, 3).unwrap();
    assert!(fd.hunks.is_empty(), "{:?}", fd.hunks);
    std::fs::write(p.join("big.dat"), "line one\nline 3\n").unwrap();
    let fd = s.diff_worktree("big.dat", false, 3).unwrap();
    let text: Vec<String> = fd.hunks.iter().flat_map(|h| h.lines.iter().map(|l| l.text.clone())).collect();
    assert!(text.contains(&"line 2".to_string()) && text.contains(&"line 3".to_string()), "{text:?}");

    // Versions diff (change chain) too
    let fd = s.file_diff_versions(Some(&format!("{head}~1")), "big.dat", Some(&head), "big.dat").unwrap();
    assert!(fd.hunks.iter().flat_map(|h| &h.lines).any(|l| l.text == "line two"));
}
