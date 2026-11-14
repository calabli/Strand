//! Whole-file shelf diffs, diffs of two texts, each side's file content during a conflict.

use std::path::Path;
use std::process::Command;

use strand_core::model::LineKind;
use strand_core::Session;

fn git(dir: &Path, args: &[&str]) -> (bool, String) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "l@x.cn"]);
    let body: String = (1..=30).map(|i| format!("第 {i} 行\n")).collect();
    std::fs::write(p.join("a.txt"), body).unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-qm", "第一个"]);
    d
}

#[test]
fn shelf_diff_full_file() {
    let d = repo();
    let p = d.path();
    let mut t = std::fs::read_to_string(p.join("a.txt")).unwrap();
    t = t.replace("第 3 行\n", "第三行\n").replace("第 25 行\n", "").replace("第 30 行\n", "第 30 行\n新的最后一行\n");
    std::fs::write(p.join("a.txt"), &t).unwrap();
    std::fs::write(p.join("new.txt"), "x\ny\n").unwrap();
    git(p, &["add", "new.txt"]);
    let s = Session::open(p).unwrap();
    let e = s.shelf_save("改了几处", &["a.txt".into(), "new.txt".into()]).unwrap();
    let short = s.shelf_diff(e.id, "a.txt", None).unwrap();
    assert!(short.hunks.len() >= 2);
    let full = s.shelf_diff(e.id, "a.txt", Some(1_000_000)).unwrap();
    assert_eq!(full.hunks.len(), 1);
    let lines = &full.hunks[0].lines;
    // Whole file: 30 original lines + 1 changed + 1 added
    assert_eq!(lines.iter().filter(|l| l.kind != LineKind::Add).count(), 30);
    assert_eq!(lines.iter().filter(|l| l.kind == LineKind::Add).map(|l| l.text.as_str()).collect::<Vec<_>>(), vec!["第三行", "新的最后一行"]);
    assert_eq!(lines.iter().filter(|l| l.kind == LineKind::Del).map(|l| l.text.as_str()).collect::<Vec<_>>(), vec!["第 3 行", "第 25 行"]);
    let n = s.shelf_diff(e.id, "new.txt", Some(1_000_000)).unwrap();
    assert_eq!(n.hunks[0].lines.len(), 2);
}

#[test]
fn text_diff_two_texts() {
    let f = strand_core::compare::text_diff("a\nb\nc\n", "a\nB\nc\nd\n", "x.rs").unwrap();
    assert_eq!(f.path, "x.rs");
    let k: Vec<_> = f.hunks[0].lines.iter().map(|l| (format!("{:?}", l.kind), l.text.clone())).collect();
    assert_eq!(k.len(), 5);
    assert!(k.contains(&("Del".into(), "b".into())) && k.contains(&("Add".into(), "d".into())));
    assert!(strand_core::compare::text_diff("same\n", "same\n", "x").unwrap().hunks.is_empty());
}

#[test]
fn conflict_sides_bytes() {
    let d = repo();
    let p = d.path();
    std::fs::write(p.join("img.bin"), [0u8, 1, 2]).unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-qm", "图"]);
    git(p, &["switch", "-qc", "side"]);
    std::fs::write(p.join("img.bin"), [0u8, 9, 9]).unwrap();
    git(p, &["commit", "-qam", "对方改图"]);
    git(p, &["switch", "-q", "main"]);
    std::fs::write(p.join("img.bin"), [0u8, 7, 7, 7]).unwrap();
    git(p, &["commit", "-qam", "我改图"]);
    assert!(!git(p, &["merge", "side"]).0);
    let s = Session::open(p).unwrap();
    assert_eq!(s.file_bytes("img.bin", Some(":1")).unwrap(), vec![0, 1, 2]);
    assert_eq!(s.file_bytes("img.bin", Some(":2")).unwrap(), vec![0, 7, 7, 7]);
    assert_eq!(s.file_bytes("img.bin", Some(":3")).unwrap(), vec![0, 9, 9]);
    assert!(s.file_bytes("a.txt", Some(":3")).is_err());
}
