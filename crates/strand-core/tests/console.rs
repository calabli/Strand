//! 控制台（说明书 5.8）：记下改动仓库和访问网络的 git 命令、客户端自己的操作；查询类命令不记；凭据打码。
//! 控制台是整个进程共用的，同一个测试程序里的测试会并行写入，所以只检查“有没有”，不检查确切内容。

use std::path::Path;
use std::process::Command;

use strand_core::console::{self, EntryKind};
use strand_core::oplog::OpKind;
use strand_core::Session;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn records_commands_notes_and_masks() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "林夏"]);
    git(p, &["config", "user.email", "linxia@example.com"]);
    std::fs::write(p.join("a.txt"), "a\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "初始提交"]);

    let mut s = Session::open(p).unwrap();
    std::fs::write(p.join("a.txt"), "a 改\n").unwrap();
    s.run_op("贮藏 控制台测试", OpKind::Stash, |s| s.stash_push(Some("控制台测试"))).unwrap();
    let tail = console::tail(300);
    assert!(tail.iter().any(|e| e.kind == EntryKind::Note && e.text == "贮藏 控制台测试"), "{tail:#?}");
    let cmd = tail.iter().find(|e| e.kind == EntryKind::Command && e.text.contains("stash push") && e.text.contains("控制台测试")).expect("记下了 git stash push");
    assert!(cmd.ok && cmd.ms.is_some());
    assert!(cmd.text.starts_with("git "), "{}", cmd.text);
    // 查询类命令不记
    assert!(!tail.iter().any(|e| e.text.starts_with("git rev-parse") || e.text.starts_with("git cherry")));

    // 撤销记成“# 撤销：…”
    s.oplog_undo(None, false).unwrap();
    assert!(console::tail(300).iter().any(|e| e.kind == EntryKind::Note && e.text == "撤销：贮藏 控制台测试"));

    // 失败的命令：记下错误输出，ok 为假
    let url = "https://linxia:s3cret@127.0.0.1:9/nope.git";
    let _ = strand_core::git_cli::run(p, &["remote", "add", "origin", url], None);
    let _ = strand_core::git_cli::run(p, &["remote", "add", "origin", url], None);
    let tail = console::tail(300);
    let adds: Vec<_> = tail.iter().filter(|e| e.text.starts_with("git remote add origin")).collect();
    assert!(adds.len() >= 2);
    assert!(adds.iter().all(|e| e.text.contains("linxia:***@") && !e.text.contains("s3cret")), "{adds:#?}");
    assert!(adds.iter().any(|e| !e.ok && e.output.iter().any(|l| l.contains("already exists"))), "{adds:#?}");
}

#[test]
fn keeps_at_most_300_lines_and_clears() {
    for i in 0..400 {
        console::note(&format!("填充 {i}"));
    }
    let lines: usize = console::tail(10_000).iter().map(|e| 1 + e.output.len() + usize::from(e.more > 0)).sum();
    assert!(lines <= console::MAX_LINES, "{lines}");
    let t = console::tail(5);
    assert_eq!(t.len(), 5);
    assert!(t.windows(2).all(|w| w[0].seq < w[1].seq), "从旧到新");
}

#[test]
fn writes_log_file() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("strand-2000-01-01.log"), "旧的\n").unwrap();
    std::fs::write(d.path().join("other.txt"), "不动\n").unwrap();
    console::set_log_dir(d.path().to_path_buf());
    assert!(!d.path().join("strand-2000-01-01.log").exists(), "7 天以前的删掉");
    assert!(d.path().join("other.txt").exists());
    console::note("写进日志文件的一条 password=hunter2");
    let text: String = std::fs::read_dir(d.path())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("strand-"))
        .map(|e| std::fs::read_to_string(e.path()).unwrap())
        .collect();
    assert!(text.contains("# 写进日志文件的一条 password=***"), "{text}");
}
