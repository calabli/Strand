//! 带说明的标签、签名标签和签名提交（用临时生成的 SSH 密钥签名，本机能验证）。

use std::path::Path;
use std::process::Command;

use strand_core::sign::SigStatus;
use strand_core::Session;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "l@x.cn"]);
    std::fs::write(p.join("a.txt"), "1\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "第一个"]);
    d
}

#[test]
fn annotated_tag_keeps_message() {
    let d = repo();
    let s = Session::open(d.path()).unwrap();
    s.tag_create("v1", "HEAD", Some("第一版\n\n修了很多"), false).unwrap();
    s.tag_create("light", "HEAD", None, false).unwrap();
    let refs = s.refs_list().unwrap();
    let v1 = refs.tags.iter().find(|t| t.name == "v1").unwrap();
    assert_eq!(v1.message.as_deref(), Some("第一版\n\n修了很多"));
    assert!(refs.tags.iter().find(|t| t.name == "light").unwrap().message.is_none());
    assert_eq!(git(d.path(), &["cat-file", "-t", "v1"]), "tag");
}

#[test]
fn ssh_signed_commits_and_tags_verify() {
    if Command::new("ssh-keygen").arg("-?").output().is_err() {
        return;
    }
    let d = repo();
    let p = d.path();
    let key = p.join(".git/test_key");
    let ok = Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "l@x.cn", "-f"]).arg(&key).status().unwrap();
    assert!(ok.success());
    let pubkey = std::fs::read_to_string(key.with_extension("pub")).unwrap();
    let allowed = p.join(".git/allowed_signers");
    std::fs::write(&allowed, format!("l@x.cn {}", pubkey.trim())).unwrap();
    git(p, &["config", "gpg.format", "ssh"]);
    git(p, &["config", "user.signingkey", &key.with_extension("pub").to_string_lossy()]);
    git(p, &["config", "gpg.ssh.allowedSignersFile", &allowed.to_string_lossy()]);

    let s = Session::open(p).unwrap();
    let unsigned = git(p, &["rev-parse", "HEAD"]);
    assert_eq!(s.commit_signature(&unsigned).unwrap().status, SigStatus::None);

    // 打开这个仓库的提交签名后，git commit 自动签名
    let cfg = s.signing_set(true).unwrap();
    assert!(cfg.commit && cfg.format == "ssh" && cfg.key.is_some());
    std::fs::write(p.join("a.txt"), "2\n").unwrap();
    git(p, &["commit", "-qam", "签名的提交"]);
    let sig = s.commit_signature(&git(p, &["rev-parse", "HEAD"])).unwrap();
    assert_eq!(sig.status, SigStatus::Good);
    assert_eq!(sig.signer, "l@x.cn");
    assert!(!s.signing_set(false).unwrap().commit);

    s.tag_create("v2", "HEAD", Some("签名标签"), true).unwrap();
    git(p, &["tag", "-v", "v2"]);
    assert!(s.commit_signature("zz").is_err());
}
