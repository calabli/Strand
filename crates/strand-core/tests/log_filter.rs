//! Log filtering and sorting (spec §5.1).

use std::path::Path;
use std::process::Command;

use strand_core::log_filter::{AuthorMatch, LogFilter, LogSort, MatchKind};
use strand_core::{ErrorCode, Session};

fn git_as(dir: &Path, args: &[&str], who: (&str, &str), t: i64) {
    let date = format!("{t} +0800");
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", who.0)
        .env("GIT_AUTHOR_EMAIL", who.1)
        .env("GIT_COMMITTER_NAME", who.0)
        .env("GIT_COMMITTER_EMAIL", who.1)
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("需要安装 git 才能运行这个测试");
    assert!(out.status.success(), "git {:?} 失败：{}", args, String::from_utf8_lossy(&out.stderr));
}

const LIN: (&str, &str) = ("林夏", "linxia@example.com");
const ZHOU: (&str, &str) = ("周舟", "Zhou@Example.com");
const BASE: i64 = 1_700_000_000;

fn commit(d: &Path, file: &str, msg: &str, who: (&str, &str), t: i64) {
    let p = d.join(file);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, msg).unwrap();
    git_as(d, &["add", file], who, BASE + t);
    git_as(d, &["commit", "-q", "-m", msg], who, BASE + t);
}

/// main:    1 initial - 2 fix login - 5 merge feature
/// feature:           \ 3 add src/ui/Button.tsx - 4 Fix button
/// other:   branches from 2: 6 fix other (commit time earlier than 2)
fn sample() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git_as(d, &["init", "-q", "-b", "main"], LIN, BASE);
    commit(d, "README.md", "初始提交", LIN, 0);
    commit(d, "src/login.rs", "修复登录\n\n正文里提到 token 过期", LIN, 100);
    git_as(d, &["checkout", "-q", "-b", "feature"], LIN, BASE);
    commit(d, "src/ui/Button.tsx", "新增按钮", ZHOU, 200);
    commit(d, "src/ui/Button.tsx", "Fix button color", ZHOU, 300);
    git_as(d, &["checkout", "-q", "main"], LIN, BASE);
    git_as(d, &["merge", "-q", "--no-ff", "-m", "合并 feature", "feature"], LIN, BASE + 400);
    git_as(d, &["checkout", "-q", "-b", "other", "HEAD~1"], LIN, BASE);
    commit(d, "other.txt", "修复 other", LIN, 50);
    git_as(d, &["checkout", "-q", "main"], LIN, BASE);
    dir
}

/// Query until it's no longer partial (path filtering runs in the background, so the first results may be incomplete)
fn query_all(s: &mut Session, f: &LogFilter, sort: LogSort) -> strand_core::model::LogPage {
    let t0 = std::time::Instant::now();
    loop {
        let p = s.log_query(f, sort, 0, 100).unwrap();
        if !p.partial {
            return p;
        }
        assert!(t0.elapsed() < std::time::Duration::from_secs(10), "过滤一直没算完");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn titles(s: &mut Session, f: &LogFilter, sort: LogSort) -> Vec<String> {
    let p = query_all(s, f, sort);
    assert!(p.graph.is_empty() || (f.is_empty() && sort == LogSort::Topo), "有过滤时不返回图谱");
    assert_eq!(p.total, p.rows.len());
    p.rows.into_iter().map(|c| c.title).collect()
}

fn text(t: &str) -> LogFilter {
    LogFilter { text: t.into(), ..Default::default() }
}

#[test]
fn text_search_matches_title_body_and_hash() {
    let dir = sample();
    let mut s = Session::open(dir.path()).unwrap();
    // Case-insensitive by default; matches both title and body
    assert_eq!(titles(&mut s, &text("fix"), LogSort::Topo), ["Fix button color"]);
    // Children come before parents: "fix other" is a child of "fix login"
    assert_eq!(titles(&mut s, &text("修复"), LogSort::Topo), ["修复 other", "修复登录"]);
    assert_eq!(titles(&mut s, &text("TOKEN"), LogSort::Topo), ["修复登录"]);
    // Case-sensitive
    let f = LogFilter { text: "fix".into(), case_sensitive: true, ..Default::default() };
    assert!(titles(&mut s, &f, LogSort::Topo).is_empty());
    // Hash prefix
    let first = s.log_page(0, 1).unwrap().rows.remove(0);
    let got = titles(&mut s, &text(&first.id[..7].to_uppercase()), LogSort::Topo);
    assert!(got.contains(&first.title));
}

#[test]
fn regex_and_invalid_regex() {
    let dir = sample();
    let mut s = Session::open(dir.path()).unwrap();
    let f = LogFilter { text: "^(新增|合并)".into(), regex: true, ..Default::default() };
    assert_eq!(titles(&mut s, &f, LogSort::Topo), ["合并 feature", "新增按钮"]);
    let bad = LogFilter { text: "(".into(), regex: true, ..Default::default() };
    let err = s.log_query(&bad, LogSort::Topo, 0, 10).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidRegex);
    // When not a regex, parentheses match literally
    assert!(titles(&mut s, &text("("), LogSort::Topo).is_empty());
}

#[test]
fn branch_author_date_path_combine() {
    let dir = sample();
    let mut s = Session::open(dir.path()).unwrap();
    let branch = |b: &str| LogFilter { branch: Some(b.into()), ..Default::default() };
    assert_eq!(titles(&mut s, &branch("feature"), LogSort::Topo), ["Fix button color", "新增按钮", "修复登录", "初始提交"]);
    assert_eq!(titles(&mut s, &branch("other"), LogSort::Topo), ["修复 other", "修复登录", "初始提交"]);
    assert!(titles(&mut s, &branch("不存在"), LogSort::Topo).is_empty());

    // Authors by email, case-insensitive; the author list is sorted by commit count
    let authors = s.log_authors().unwrap();
    assert_eq!(authors[0].email, "linxia@example.com");
    assert_eq!(authors[0].count, 4);
    assert_eq!(authors[1].name, "周舟");
    let zhou = LogFilter { author: Some("zhou@example.com".into()), ..Default::default() };
    assert_eq!(titles(&mut s, &zhou, LogSort::Topo), ["Fix button color", "新增按钮"]);

    let since = LogFilter { since: Some(BASE + 250), ..Default::default() };
    assert_eq!(titles(&mut s, &since, LogSort::Topo), ["合并 feature", "Fix button color"]);

    // Path substring, case-insensitive
    let path = LogFilter { path: Some("ui/button".into()), ..Default::default() };
    assert_eq!(titles(&mut s, &path, LogSort::Topo), ["Fix button color", "新增按钮"]);
    let path_cs = LogFilter { path: Some("ui/button".into()), case_sensitive: true, ..Default::default() };
    assert!(titles(&mut s, &path_cs, LogSort::Topo).is_empty());

    // Combined conditions intersect
    let all = LogFilter {
        text: "修复".into(),
        branch: Some("main".into()),
        author: Some("linxia@example.com".into()),
        path: Some("src/".into()),
        ..Default::default()
    };
    assert_eq!(titles(&mut s, &all, LogSort::Topo), ["修复登录"]);
}

#[test]
fn date_sort_and_locate_in_results() {
    let dir = sample();
    let mut s = Session::open(dir.path()).unwrap();
    let topo = titles(&mut s, &LogFilter::default(), LogSort::Topo);
    let date = titles(&mut s, &LogFilter::default(), LogSort::Date);
    assert_eq!(date, ["合并 feature", "Fix button color", "新增按钮", "修复登录", "修复 other", "初始提交"]);
    assert_eq!(topo.len(), date.len());

    let f = text("修复");
    assert_eq!(s.log_locate_in("other", &f, LogSort::Topo).unwrap(), Some(0));
    assert_eq!(s.log_locate_in("main~1", &f, LogSort::Topo).unwrap(), Some(1));
    assert_eq!(s.log_locate_in("feature", &f, LogSort::Topo).unwrap(), None);

    // The cache is cleared when the repository is re-read, and the results follow
    commit(dir.path(), "z.txt", "修复 z", LIN, 500);
    s.reload().unwrap();
    assert_eq!(titles(&mut s, &f, LogSort::Topo)[0], "修复 z");
}

/// First results return first (spec §15): path filtering runs in the background and queries don't wait for it; when done the result equals a one-shot computation,
/// and when conditions change the old background query is dropped and never mixes into new results
#[test]
fn path_filter_streams_and_matches_full_result() {
    let dir = sample();
    let mut s = Session::open(dir.path()).unwrap();
    let f = LogFilter { path: Some("ui/button".into()), ..Default::default() };
    let first = s.log_query(&f, LogSort::Topo, 0, 100).unwrap();
    assert!(first.total <= 2);
    let done = query_all(&mut s, &f, LogSort::Topo);
    let full = strand_core::log_filter::path_commits(dir.path(), "ui/button", false).unwrap();
    assert_eq!(done.total, full.len());
    assert!(done.rows.iter().all(|c| full.iter().any(|id| id.to_string() == c.id)));

    // Switch to another path: results come only from the new query
    let g = LogFilter { path: Some("README".into()), ..Default::default() };
    let other = query_all(&mut s, &g, LogSort::Topo);
    assert!(other.rows.iter().all(|c| !done.rows.iter().any(|d| d.id == c.id) || c.title == "初始提交"));
    // Switching back also completes
    assert_eq!(query_all(&mut s, &f, LogSort::Topo).total, full.len());

    // A bad regex still fails immediately
    let bad = LogFilter { text: "(".into(), regex: true, path: Some("ui".into()), ..Default::default() };
    assert!(s.log_query(&bad, LogSort::Topo, 0, 10).is_err());
}

/// Re-reading the repository with commits and refs unchanged (e.g. a fetch with nothing new): filter results and the background path query are kept, no restart
#[test]
fn reload_without_changes_keeps_filter() {
    let dir = sample();
    let mut s = Session::open(dir.path()).unwrap();
    let f = LogFilter { path: Some("ui/button".into()), ..Default::default() };
    let done = query_all(&mut s, &f, LogSort::Topo);
    s.reload().unwrap();
    let again = s.log_query(&f, LogSort::Topo, 0, 100).unwrap();
    assert!(!again.partial, "没有变化时不重新跑路径查询");
    assert_eq!(again.total, done.total);

    // Refs changed (new branch): results are still correct and the branch filter sees the new branch
    git_as(dir.path(), &["branch", "新分支", "main"], LIN, BASE);
    s.reload().unwrap();
    let b = LogFilter { branch: Some("新分支".into()), ..Default::default() };
    assert!(!titles(&mut s, &b, LogSort::Topo).is_empty());
    assert_eq!(query_all(&mut s, &f, LogSort::Topo).total, done.total);
}

/// With many commits at the same time, the order is the same on every read: re-reading isn't taken as "commits changed" and doesn't drop the filter cache
#[test]
fn same_time_commits_keep_order_across_reloads() {
    let dir = sample();
    let p = dir.path();
    for i in 0..12 {
        git_as(p, &["checkout", "-q", "-b", &format!("同时{i}"), "main"], LIN, BASE);
        std::fs::write(p.join(format!("t{i}.txt")), "x\n").unwrap();
        git_as(p, &["add", "."], LIN, BASE);
        git_as(p, &["commit", "-q", "-m", &format!("同时提交 {i}")], LIN, BASE + 999);
    }
    git_as(p, &["checkout", "-q", "main"], LIN, BASE);
    let mut s = Session::open(p).unwrap();
    let order = |s: &Session| s.log_page(0, 100).unwrap().rows.into_iter().map(|c| c.id).collect::<Vec<_>>();
    let first = order(&s);
    for _ in 0..5 {
        s.reload().unwrap();
        assert_eq!(order(&s), first);
        assert_eq!(order(&Session::open(p).unwrap()), first, "重新打开也一样");
    }
    let f = LogFilter { path: Some("ui/button".into()), ..Default::default() };
    query_all(&mut s, &f, LogSort::Topo);
    s.reload().unwrap();
    assert!(!s.log_query(&f, LogSort::Topo, 0, 10).unwrap().partial);
}

/// Multi-select authors, match by rule (contains, prefix, suffix, regex; name or email matching counts), custom date range
#[test]
fn authors_multi_rules_and_date_range() {
    let dir = sample();
    let mut s = Session::open(dir.path()).unwrap();
    // The third author
    git_as(dir.path(), &["checkout", "-q", "main"], LIN, BASE);
    commit(dir.path(), "c.txt", "王五的提交", ("王五", "wangwu@corp.cn"), 500);
    s.reload().unwrap();
    let rule = |kind, t: &str| LogFilter { author_match: Some(AuthorMatch { kind, text: t.into() }), ..Default::default() };

    // Multi-select: union
    let two = LogFilter { authors: vec!["ZHOU@example.com".into(), "wangwu@corp.cn".into()], ..Default::default() };
    assert_eq!(titles(&mut s, &two, LogSort::Topo), ["王五的提交", "Fix button color", "新增按钮"]);
    // Prefix: name starts with "周"
    assert_eq!(titles(&mut s, &rule(MatchKind::Prefix, "周"), LogSort::Topo), ["Fix button color", "新增按钮"]);
    // Suffix: email ends with corp.cn
    assert_eq!(titles(&mut s, &rule(MatchKind::Suffix, "CORP.CN"), LogSort::Topo), ["王五的提交"]);
    // Contains: example (林夏 and 周舟)
    assert_eq!(titles(&mut s, &rule(MatchKind::Contains, "example"), LogSort::Topo).len(), 6);
    // Regex: name is "林夏" or "王五"
    assert_eq!(titles(&mut s, &rule(MatchKind::Regex, "^(林夏|王五)$"), LogSort::Topo).len(), 5);
    // Special characters in a prefix match literally
    assert!(titles(&mut s, &rule(MatchKind::Prefix, "lin.ia"), LogSort::Topo).is_empty());
    // Rule and multi-select are OR-ed
    let mix = LogFilter { authors: vec!["wangwu@corp.cn".into()], author_match: Some(AuthorMatch { kind: MatchKind::Prefix, text: "zhou".into() }), ..Default::default() };
    assert_eq!(titles(&mut s, &mix, LogSort::Topo), ["王五的提交", "Fix button color", "新增按钮"]);
    // An empty rule doesn't filter
    assert_eq!(titles(&mut s, &rule(MatchKind::Regex, "  "), LogSort::Topo).len(), 7);
    // Bad regex
    let e = s.log_query(&rule(MatchKind::Regex, "(林"), LogSort::Topo, 0, 10).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidRegex);
    assert_eq!(e.detail.unwrap()["field"], "author");

    // Date range: [since, until)
    let range = LogFilter { since: Some(BASE + 100), until: Some(BASE + 300), ..Default::default() };
    assert_eq!(titles(&mut s, &range, LogSort::Topo), ["新增按钮", "修复登录"]);
    let until = LogFilter { until: Some(BASE + 100), ..Default::default() };
    assert_eq!(titles(&mut s, &until, LogSort::Date), ["修复 other", "初始提交"]);
}

/// First parent only, hide merge commits, collapse linear branches
#[test]
fn first_parent_no_merges_and_collapse() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git_as(d, &["init", "-q", "-b", "main"], LIN, BASE);
    commit(d, "a.txt", "主线 1", LIN, 0);
    git_as(d, &["checkout", "-q", "-b", "side"], LIN, BASE);
    commit(d, "s.txt", "旁支 1", ZHOU, 10);
    commit(d, "s.txt", "旁支 2", ZHOU, 20);
    commit(d, "s.txt", "旁支 3", ZHOU, 30);
    git_as(d, &["checkout", "-q", "main"], LIN, BASE);
    commit(d, "b.txt", "主线 2", LIN, 40);
    git_as(d, &["merge", "-q", "--no-ff", "-m", "合并旁支", "side"], LIN, BASE + 50);
    git_as(d, &["branch", "-q", "-D", "side"], LIN, BASE);
    git_as(d, &["checkout", "-q", "-b", "kept", "HEAD~1"], LIN, BASE);
    commit(d, "k.txt", "保留的分支", LIN, 60);
    git_as(d, &["checkout", "-q", "main"], LIN, BASE);
    let mut s = Session::open(d).unwrap();

    let fp = LogFilter { first_parent: true, ..Default::default() };
    assert_eq!(titles(&mut s, &fp, LogSort::Topo), ["合并旁支", "主线 2", "主线 1"]);
    let nm = LogFilter { no_merges: true, ..Default::default() };
    assert!(!titles(&mut s, &nm, LogSort::Topo).contains(&"合并旁支".to_string()));
    assert_eq!(titles(&mut s, &nm, LogSort::Topo).len(), 6);

    // Collapsing: the three commits on the deleted side branch are folded and noted on the merge commit's row; the "kept branch" with a branch isn't folded; the graph is still there
    let c = LogFilter { collapse_linear: true, ..Default::default() };
    let p = s.log_query(&c, LogSort::Topo, 0, 100).unwrap();
    let got: Vec<(&str, u32)> = p.rows.iter().map(|r| r.title.as_str()).zip(p.folded.iter().copied()).collect();
    assert_eq!(got, [("保留的分支", 0), ("合并旁支", 3), ("主线 2", 0), ("主线 1", 0)]);
    assert_eq!(p.graph.len(), 4);
    assert!(p.lanes >= 2, "合并提交仍然画出两条线");
    // Folded commits can't be located; the remaining ones can
    let out = Command::new("git").args(["rev-parse", "main^2"]).current_dir(d).output().unwrap();
    let hidden = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert_eq!(s.log_locate_in(&hidden, &c, LogSort::Topo).unwrap(), None);
    assert_eq!(s.log_locate_in("main", &c, LogSort::Topo).unwrap(), Some(1));
}
