//! Common Git settings: read and write user.name, user.email, proxy and friends in global and local scope.
//! One test function only: it points GIT_CONFIG_GLOBAL at a temporary file for the whole process.

use std::path::Path;
use std::process::Command;

use strand_core::error::ErrorCode;
use strand_core::gitconfig::{config_read, config_write, proxy_enable, ConfigScope};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn read_and_write_global_and_local() {
    let home = tempfile::tempdir().unwrap();
    let global = home.path().join("gitconfig");
    std::fs::write(&global, "").unwrap();
    // SAFETY: the only test in this binary, set before any git runs
    unsafe {
        std::env::set_var("GIT_CONFIG_GLOBAL", &global);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    }
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);

    let get = |repo: Option<&Path>, key: &str| config_read(repo).unwrap().into_iter().find(|v| v.key == key).unwrap();

    // Global without a repository
    config_write(None, ConfigScope::Global, "user.name", Some("林夏")).unwrap();
    config_write(None, ConfigScope::Global, "user.email", Some("l@x.cn")).unwrap();
    let n = get(None, "user.name");
    assert_eq!((n.global.as_deref(), n.local.as_deref(), n.effective.as_deref()), (Some("林夏"), None, Some("林夏")));

    // Proxy: the address is remembered; git only uses it while the proxy is on
    assert_eq!(proxy_enable(None, ConfigScope::Global, true).unwrap_err().code, ErrorCode::InvalidName);
    config_write(None, ConfigScope::Global, "http.proxy", Some("http://127.0.0.1:7890")).unwrap();
    assert!(get(None, "http.proxy").global.is_none());
    assert_eq!(get(None, "strand.httpProxy").global.as_deref(), Some("http://127.0.0.1:7890"));
    proxy_enable(None, ConfigScope::Global, true).unwrap();
    assert_eq!(get(None, "http.proxy").global.as_deref(), Some("http://127.0.0.1:7890"));
    // Editing while on keeps both in sync
    config_write(None, ConfigScope::Global, "http.proxy", Some("http://127.0.0.1:8888")).unwrap();
    assert_eq!(get(None, "http.proxy").global.as_deref(), Some("http://127.0.0.1:8888"));
    // Off: git's key is gone, the address stays
    proxy_enable(None, ConfigScope::Global, false).unwrap();
    assert!(get(None, "http.proxy").global.is_none());
    assert_eq!(get(None, "strand.httpProxy").global.as_deref(), Some("http://127.0.0.1:8888"));
    // Editing while off only changes the remembered address
    config_write(None, ConfigScope::Global, "http.proxy", Some("http://127.0.0.1:7890")).unwrap();
    assert!(get(None, "http.proxy").global.is_none());
    proxy_enable(None, ConfigScope::Global, true).unwrap();
    assert!(std::fs::read_to_string(&global).unwrap().contains("proxy = http://127.0.0.1:7890"));
    // A proxy set on the command line is remembered when turned off
    git(p, &["config", "--global", "https.proxy", "socks5://127.0.0.1:1080"]);
    proxy_enable(None, ConfigScope::Global, false).unwrap();
    assert!(get(None, "https.proxy").global.is_none());
    assert_eq!(get(None, "strand.httpsProxy").global.as_deref(), Some("socks5://127.0.0.1:1080"));
    proxy_enable(None, ConfigScope::Global, true).unwrap();
    assert_eq!(get(None, "https.proxy").global.as_deref(), Some("socks5://127.0.0.1:1080"));

    // Local overrides global
    config_write(Some(p), ConfigScope::Local, "user.email", Some("work@corp.cn")).unwrap();
    let e = get(Some(p), "user.email");
    assert_eq!((e.global.as_deref(), e.local.as_deref(), e.effective.as_deref()), (Some("l@x.cn"), Some("work@corp.cn"), Some("work@corp.cn")));
    assert_eq!(git(p, &["config", "--local", "user.email"]), "work@corp.cn");

    // Clearing the local value falls back to global; clearing a missing key is fine
    config_write(Some(p), ConfigScope::Local, "user.email", None).unwrap();
    config_write(Some(p), ConfigScope::Local, "user.email", Some("  ")).unwrap();
    assert_eq!(get(Some(p), "user.email").effective.as_deref(), Some("l@x.cn"));
    // Clearing the address removes both
    config_write(None, ConfigScope::Global, "http.proxy", None).unwrap();
    assert!(get(None, "http.proxy").global.is_none());
    assert!(get(None, "strand.httpProxy").global.is_none());

    // Validation
    let bad = |key: &str, v: &str| config_write(Some(p), ConfigScope::Local, key, Some(v)).unwrap_err().code;
    assert_eq!(bad("user.email", "not an email"), ErrorCode::InvalidName);
    assert_eq!(bad("user.name", "A <b>"), ErrorCode::InvalidName);
    assert_eq!(bad("http.proxy", "127.0.0.1:7890"), ErrorCode::InvalidName);
    assert_eq!(bad("http.proxy", "ftp://h:1"), ErrorCode::InvalidName);
    assert_eq!(bad("http.proxy", "http://127.0.0.1:7890127.0.0.1:7890"), ErrorCode::InvalidName);
    assert_eq!(bad("http.proxy", "http://127.0.0.1:99999"), ErrorCode::InvalidName);
    assert_eq!(bad("http.proxy", "http://:8080"), ErrorCode::InvalidName);
    config_write(Some(p), ConfigScope::Local, "http.proxy", Some("http://[::1]:7890")).unwrap();
    config_write(Some(p), ConfigScope::Local, "http.proxy", Some("http://proxy.corp.example")).unwrap();
    assert_eq!(bad("core.autocrlf", "yes"), ErrorCode::InvalidName);
    assert_eq!(bad("init.defaultBranch", "a..b"), ErrorCode::InvalidName);
    assert_eq!(bad("core.editor", "vim"), ErrorCode::InvalidName);
    config_write(Some(p), ConfigScope::Local, "https.proxy", Some("socks5://user:pw@127.0.0.1:1080")).unwrap();
    config_write(Some(p), ConfigScope::Local, "core.autocrlf", Some("input")).unwrap();
    config_write(None, ConfigScope::Global, "init.defaultBranch", Some("trunk")).unwrap();
    assert_eq!(get(Some(p), "init.defaultBranch").effective.as_deref(), Some("trunk"));

    // Local needs a repository
    assert_eq!(config_write(None, ConfigScope::Local, "user.name", Some("x")).unwrap_err().code, ErrorCode::NoRepo);
}
