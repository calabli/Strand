//! 逐行追溯的耗时：首屏 300 行和整个文件（说明书 15 节：5000 行的文件首屏 500 ms 内）。
//!
//! cargo run --release -p strand-core --example blame -- /path/to/repo 文件路径

use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let repo = args.next().unwrap_or_else(|| ".".into());
    let path = args.next().expect("需要文件路径");
    let s = strand_core::Session::open(&repo).expect("打开仓库失败");
    let t = Instant::now();
    let first = s.blame_file(&path, Some("HEAD"), 0, 300).expect("追溯失败");
    let a = t.elapsed();
    let t = Instant::now();
    let rest = s.blame_file(&path, Some("HEAD"), 300, 100_000).expect("追溯失败");
    let b = t.elapsed();
    println!("共 {} 行；首屏 300 行 {:.0} ms（{} 个提交）；其余 {} 行 {:.0} ms", first.total, a.as_secs_f64() * 1000.0, first.commits.len(), rest.lines.len(), b.as_secs_f64() * 1000.0);
}
