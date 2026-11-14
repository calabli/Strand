//! 写说明用的信息（说明历史、提交说明模板、身份）、换作者提交、变更列表的保存。

use std::path::Path;
use std::process::Command;

use strand_core::compose::{Changelist, Changelists};
use strand_core::model::{SelectedFile, Selection};
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
    git(p, &["commit", "-q", "-m", "第一个\n\n正文"]);
    git(p, &["-c", "user.email=o@x.cn", "-c", "user.name=别人", "commit", "-q", "--allow-empty", "-m", "别人的"]);
    git(p, &["commit", "-q", "--allow-empty", "-m", "第一个\n\n正文"]);
    git(p, &["commit", "-q", "--allow-empty", "-m", "第三个"]);
    d
}

fn sel(paths: &[&str]) -> Selection {
    Selection { files: paths.iter().map(|p| SelectedFile { path: p.to_string(), old_path: None, whole: true, lines: vec![] }).collect() }
}

#[test]
fn history_is_mine_newest_first_deduped() {
    let d = repo();
    let s = Session::open(d.path()).unwrap();
    let i = s.compose_info().unwrap();
    assert_eq!(i.history, vec!["第三个".to_string(), "第一个\n\n正文".to_string()]);
    assert_eq!(i.me.as_deref(), Some("林夏 <l@x.cn>"));
    assert!(i.template.is_none());
}

#[test]
fn template_drops_comment_lines() {
    let d = repo();
    std::fs::write(d.path().join(".msg"), "# 注释\n类型: 标题\n\n# 再一行\n为什么改：\n").unwrap();
    git(d.path(), &["config", "commit.template", ".msg"]);
    let s = Session::open(d.path()).unwrap();
    let i = s.compose_info().unwrap();
    assert_eq!(i.template.as_deref(), Some("类型: 标题\n\n为什么改："));
    assert_eq!(i.template_path.as_deref(), Some(".msg"));
}

#[test]
fn commit_with_other_author() {
    let d = repo();
    std::fs::write(d.path().join("a.txt"), "2\n").unwrap();
    let mut s = Session::open(d.path()).unwrap();
    assert!(s.commit_create("改", &sel(&["a.txt"]), false, Some("没有邮箱")).is_err());
    s.commit_create("改\n\nCo-authored-by: 别人 <o@x.cn>", &sel(&["a.txt"]), false, Some("王五 <w@x.cn>")).unwrap();
    assert_eq!(git(d.path(), &["log", "-1", "--format=%an <%ae>|%cn"]), "王五 <w@x.cn>|林夏");
    assert_eq!(git(d.path(), &["log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly)"]), "别人 <o@x.cn>");
    // 修订时只换作者
    s.reload().unwrap();
    s.commit_amend(None, &sel(&[]), false, Some("赵六 <z@x.cn>")).unwrap();
    assert_eq!(git(d.path(), &["log", "-1", "--format=%an|%s"]), "赵六|改");
}

#[test]
fn changelists_roundtrip_and_normalize() {
    let d = repo();
    let s = Session::open(d.path()).unwrap();
    assert_eq!(s.changelists_get().unwrap(), Changelists::default());
    let mut c = Changelists::default();
    c.lists.push(Changelist { id: "ui".into(), name: "界面".into() });
    c.active = "ui".into();
    c.files.insert("a.txt".into(), "ui".into());
    c.files.insert("b.txt".into(), "gone".into());
    let saved = s.changelists_set(c).unwrap();
    assert_eq!(saved.files.len(), 1);
    assert_eq!(s.changelists_get().unwrap(), saved);
    // 同名、没名字的不行
    let mut bad = saved.clone();
    bad.lists.push(Changelist { id: "x".into(), name: "界面".into() });
    assert!(s.changelists_set(bad).is_err());
    let mut bad = saved.clone();
    bad.lists.push(Changelist { id: "y".into(), name: " ".into() });
    assert!(s.changelists_set(bad).is_err());
    // 活动列表被删掉了：回到默认
    let mut c = saved;
    c.lists.retain(|l| l.id == "default");
    let c = s.changelists_set(c).unwrap();
    assert_eq!(c.active, "default");
    assert!(c.files.is_empty());
}
