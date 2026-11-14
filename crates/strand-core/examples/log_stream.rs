//! Measure "first results return first, the rest are appended in batches" on a real repository (spec §15): prints each query's time, the number of results so far, and whether it is complete.
//!
//! cargo run --release -p strand-core --example log_stream -- /path/to/repo [path substring] [search text]

use std::time::{Duration, Instant};

use strand_core::log_filter::{LogFilter, LogSort};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| ".".into());
    let sub = args.next().filter(|s| !s.is_empty());
    let text = args.next().unwrap_or_default();
    let mut s = strand_core::Session::open(&path).expect("打开仓库");
    let f = LogFilter { path: sub, text, ..Default::default() };
    let t0 = Instant::now();
    for i in 0.. {
        let t = Instant::now();
        let p = s.log_query(&f, LogSort::Topo, 0, 200).expect("查询");
        println!(
            "第 {:>2} 次：{:>6.1} ms，累计 {:>6.0} ms，结果 {:>6}，第一页 {:>3} 行{}",
            i + 1,
            t.elapsed().as_secs_f64() * 1000.0,
            t0.elapsed().as_secs_f64() * 1000.0,
            p.total,
            p.rows.len(),
            if p.partial { "（还没算完）" } else { "" }
        );
        if !p.partial {
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}
