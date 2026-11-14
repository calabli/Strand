//! Try opening and reading the log on a real repository, printing the time of each stage. Used to check the performance targets in spec §15.
//!
//! cargo run --release -p strand-core --example log -- /path/to/repo

use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let t = Instant::now();
    let s = match strand_core::Session::open(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("打开失败：{} {}", serde_json::to_string(&e.code).unwrap(), e.message);
            std::process::exit(1);
        }
    };
    let opened = t.elapsed();
    let st = s.state().unwrap();
    let t2 = Instant::now();
    let page = s.log_page(0, 200).unwrap();
    let paged = t2.elapsed();
    let mid = s.log_page(page.total / 2, 200).unwrap();
    let ls = s.load_stats();
    println!("仓库：{}（{:?}，分支 {:?}）", st.path, st.head.kind, st.head.branch);
    println!("提交 {} 个，泳道 {} 条，commit-graph：{}", page.total, page.lanes, if ls.commit_graph { "有" } else { "没有" });
    println!(
        "打开 {:.0} ms（引用 {:.0}，遍历 {:.0}，排序 {:.0}，图谱 {:.0}）；第一页 200 行 {:.1} ms；首屏合计 {:.0} ms",
        opened.as_secs_f64() * 1000.0,
        ls.refs_ms,
        ls.walk_ms,
        ls.order_ms,
        ls.layout_ms,
        paged.as_secs_f64() * 1000.0,
        (opened + paged).as_secs_f64() * 1000.0
    );
    assert_eq!(mid.rows.len(), 200.min(page.total - page.total / 2));
    for (c, g) in page.rows.iter().zip(&page.graph).take(5) {
        let refs: Vec<&str> = c.refs.iter().map(|r| r.name.as_str()).collect();
        println!("{:>2}  {}  {}  {:?}", g.lane, &c.id[..7], c.title, refs);
    }

    // Filtering (spec §5.1, §15: first results within 300 ms)
    let mut s = s;
    use strand_core::log_filter::{LogFilter, LogSort};
    let cases: Vec<(&str, LogFilter, LogSort)> = vec![
        ("搜索 fix（第一次）", LogFilter { text: "fix".into(), ..Default::default() }, LogSort::Topo),
        ("搜索 fsmonitor", LogFilter { text: "fsmonitor".into(), ..Default::default() }, LogSort::Topo),
        ("正则 ^Merge branch", LogFilter { text: "^Merge branch".into(), regex: true, ..Default::default() }, LogSort::Topo),
        ("作者表（第一次）", LogFilter { since: Some(0), ..Default::default() }, LogSort::Topo),
        ("最近 30 天", LogFilter { since: Some(now() - 30 * 86400), ..Default::default() }, LogSort::Topo),
        ("按时间排序", LogFilter::default(), LogSort::Date),
        ("分支 HEAD + 搜索 doc", LogFilter { branch: Some("HEAD".into()), text: "doc".into(), ..Default::default() }, LogSort::Topo),
        ("路径 refs.c", LogFilter { path: Some("refs.c".into()), ..Default::default() }, LogSort::Topo),
        ("路径 refs.c（缓存）", LogFilter { path: Some("refs.c".into()), text: "x".into(), ..Default::default() }, LogSort::Topo),
    ];
    for (name, f, sort) in cases {
        let t = Instant::now();
        let p = s.log_query(&f, sort, 0, 200).unwrap();
        println!("{name}：{} 个，{:.0} ms", p.total, t.elapsed().as_secs_f64() * 1000.0);
    }
    let t = Instant::now();
    let a = s.log_authors().unwrap();
    println!("作者 {} 位，{:.1} ms", a.len(), t.elapsed().as_secs_f64() * 1000.0);
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}
