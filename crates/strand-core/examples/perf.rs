//! 说明书第 15 节的性能指标，在一个仓库上逐项计时（核心层部分，不含界面渲染）。
//! 写操作照应用里的做法：记操作日志（前后各拍一次快照，操作后的快照和重新读取日志同时进行）、读状态和第一页。
//!
//! cargo run --release -p strand-core --example perf -- /path/to/repo
//! 仓库用 scripts/gen_perf_repo.py 造（里面有 big/diff.txt、big/blame.txt、src/d023、src/d042、feature-10 分支）；
//! 测试会改动工作区和分支，用临时仓库。

use std::time::Instant;

use strand_core::log_filter::{LogFilter, LogSort};
use strand_core::model::{SelectedFile, Selection};
use strand_core::oplog::OpKind;
use strand_core::Session;

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn row(name: &str, target: &str, took: f64, limit: f64) {
    println!("{:<28} {:>9.1} ms   目标 {:<10} {}", name, took, target, if took <= limit { "✓" } else { "✗ 超出" });
}

fn main() {
    let path = std::env::args().nth(1).expect("仓库路径");
    let p = std::path::Path::new(&path);

    // 1. 打开仓库到第一屏日志
    let t = Instant::now();
    let mut s = Session::open(&path).unwrap();
    let first = s.log_page(0, 200).unwrap();
    row("打开仓库 + 第一屏日志", "1 s", ms(t), 1000.0);
    println!("    （{} 个提交，commit-graph：{}）", first.total, if s.load_stats().commit_graph { "有" } else { "没有" });

    // 2. 日志翻页
    let t = Instant::now();
    let mid = s.log_page(first.total / 2, 200).unwrap();
    row("日志中间一页（200 行）", "50 ms", ms(t), 50.0);
    let t = Instant::now();
    s.log_page(first.total - 200, 200).unwrap();
    row("日志最后一页（200 行）", "50 ms", ms(t), 50.0);
    assert_eq!(mid.rows.len(), 200);

    // 3. 工作区状态
    let t = Instant::now();
    let st = s.status().unwrap();
    row("工作区状态（干净）", "300 ms", ms(t), 300.0);
    assert!(st.changes.is_empty(), "测试仓库的工作区应该是干净的");
    std::fs::write(p.join("src/d023/f045.txt"), "改了\n").unwrap();
    let t = Instant::now();
    let st = s.status().unwrap();
    row("工作区状态（改了 1 个文件）", "300 ms", ms(t), 300.0);
    assert_eq!(st.changes.len(), 1);

    // 4. 2000 行改动的差异
    let head = s.state().unwrap().head.commit.unwrap();
    let t = Instant::now();
    let d = s.diff_commit(&head, "big/diff.txt").unwrap();
    row("提交里 2000 行改动的差异", "200 ms", ms(t), 200.0);
    let lines: usize = d.hunks.iter().map(|h| h.lines.len()).sum();
    println!("    （{} 块、{} 行）", d.hunks.len(), lines);
    let text = std::fs::read_to_string(p.join("big/diff.txt")).unwrap();
    let changed: String = text.lines().enumerate().map(|(i, l)| if (500..2500).contains(&i) { format!("{l}（工作区）\n") } else { format!("{l}\n") }).collect();
    std::fs::write(p.join("big/diff.txt"), changed).unwrap();
    let t = Instant::now();
    s.diff_worktree("big/diff.txt", false, 3).unwrap();
    row("工作区里 2000 行改动的差异", "200 ms", ms(t), 200.0);

    // 工作区里的 2000 行改动放回去，免得切换分支时和别的分支冲突
    std::fs::write(p.join("big/diff.txt"), text).unwrap();

    // 5. 搜索和过滤
    let f = LogFilter { text: "第 7777".into(), ..Default::default() };
    let t = Instant::now();
    let r = s.log_query(&f, LogSort::Topo, 0, 200).unwrap();
    row("搜索说明（首批）", "300 ms", ms(t), 300.0);
    println!("    （{} 个，partial={}）", r.total, r.partial);
    let f = LogFilter { path: Some("src/d042/".into()), ..Default::default() };
    let t = Instant::now();
    let r = s.log_query(&f, LogSort::Topo, 0, 200).unwrap();
    row("按路径过滤（首批）", "300 ms", ms(t), 300.0);
    println!("    （首批 {} 个，partial={}）", r.total, r.partial);

    // 6. 逐行追溯：首屏 300 行
    let t = Instant::now();
    let b = s.blame_file("big/blame.txt", None, 0, 300).unwrap();
    row("逐行追溯 5000 行文件（首屏）", "500 ms", ms(t), 500.0);
    let t = Instant::now();
    s.blame_file("big/blame.txt", None, 300, 4700).unwrap();
    println!("    （共 {} 行；其余 4700 行后台读取 {:.0} ms）", b.total, ms(t));

    // 7. 本地写操作：照应用里的做法，记操作日志 + 重新读取 + 读状态
    let write = |s: &mut Session, name: &str, f: &mut dyn FnMut(&mut Session)| {
        let t = Instant::now();
        s.run_op_reload(name, OpKind::Other, |s| {
            f(s);
            Ok(())
        })
        .unwrap();
        let t_op = ms(t);
        s.state().unwrap();
        s.status().unwrap();
        s.log_page(0, 200).unwrap();
        row(name, "500 ms", ms(t), 500.0);
        println!("    （其中操作、快照和重新读取日志 {:.0} ms，读状态和第一页 {:.0} ms）", t_op, ms(t) - t_op);
    };
    let sel = Selection { files: vec![SelectedFile { path: "src/d023/f045.txt".into(), old_path: None, whole: true, lines: Vec::new() }] };
    write(&mut s, "提交 1 个文件", &mut |s| {
        s.commit_create("性能测试的提交", &sel, false).unwrap();
    });
    // 切换分支：相距 10 个提交（一般情况）；切到 feature-10（相距很远、很多文件要改写，极端情况）
    let near = s.log_page(10, 1).unwrap().rows[0].id.clone();
    std::process::Command::new("git").args(["branch", "-f", "near", &near]).current_dir(p).output().unwrap();
    s.reload().unwrap();
    write(&mut s, "切换到相距 10 个提交的分支", &mut |s| s.branch_switch("near", false).unwrap());
    write(&mut s, "切回 main", &mut |s| s.branch_switch("main", false).unwrap());
    write(&mut s, "切换到很远的分支 feature-10", &mut |s| s.branch_switch("feature-10", false).unwrap());
    write(&mut s, "再切回 main", &mut |s| s.branch_switch("main", false).unwrap());
    write(&mut s, "重置（混合）到上一个提交", &mut |s| {
        let id = s.log_page(1, 1).unwrap().rows[0].id.clone();
        s.commit_reset(&id, strand_core::commits::ResetMode::Mixed).unwrap();
    });
}
