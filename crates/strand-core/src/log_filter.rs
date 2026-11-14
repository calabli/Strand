//! 日志过滤和排序（说明书 5.1）：搜索（说明、正文、哈希，可选正则和区分大小写）、分支、作者、日期、路径，
//! 以及按提交时间排序。多个条件取交集；有过滤或按时间排序时不返回图谱。
//!
//! 便宜的条件先算（分支可达、日期、作者、路径），最后才解码剩下的提交去匹配说明文字，并分到多个线程上做。
//! 作者和作者时间第一次用到时读一遍全部提交并缓存；上一次的过滤结果也缓存，翻页时不用重算。
//!
//! 首批结果先返回，其余分批追加（说明书 15）：
//! - 路径过滤要在全部历史上跑一次 `git rev-list`，大仓库上要几秒。它在后台线程里跑，输出边读边记；
//!   每次查询用目前读到的结果过滤，结果标记为 `partial`。
//! - 说明文字的匹配按块扫描，每次查询最多花 `BUDGET`，没扫完的下次查询接着扫。
//!   界面看到 `partial` 时过一会儿再查，直到不再是 `partial`。

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::LogPage;
use crate::repo::{MAX_PAGE, Session};
use crate::git_cli;

/// 过滤条件。所有字段都可以省略，省略表示不按这一项过滤。
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct LogFilter {
    /// 搜索文字：匹配提交说明（标题和正文）；不是正则时，4 位以上的十六进制还匹配哈希前缀
    pub text: String,
    pub regex: bool,
    pub case_sensitive: bool,
    /// 只看从这个分支（本地或远程分支名，也可以是标签或 HEAD）能到达的提交
    pub branch: Option<String>,
    /// 作者邮箱，不区分大小写（只选一个时的旧写法，和 `authors` 合在一起算）
    pub author: Option<String>,
    /// 选中的作者邮箱（多选），不区分大小写
    pub authors: Vec<String>,
    /// 按规则匹配作者：名字或邮箱满足就算。和选中的作者是“或”的关系
    pub author_match: Option<AuthorMatch>,
    /// 作者时间不早于这个时间（Unix 秒）
    pub since: Option<i64>,
    /// 作者时间早于这个时间（Unix 秒，不含）
    pub until: Option<i64>,
    /// 路径子串：只看改过匹配文件的提交
    pub path: Option<String>,
    /// 搜索文字搜哪里：提交说明（默认），还是改动内容（`git log -S` / `-G`，说明书 5.1 的扩展）
    pub search_in: SearchIn,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchIn {
    #[default]
    Message,
    /// 改动内容：普通文字找“这段文字出现次数变了”的提交（加进来或删掉的那次），正则找改动的行里有匹配的提交
    Changes,
}

impl LogFilter {
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
            && self.branch.is_none()
            && self.author.is_none()
            && self.authors.is_empty()
            && self.author_match.as_ref().is_none_or(|m| m.text.is_empty())
            && self.since.is_none()
            && self.until.is_none()
            && self.path.as_deref().is_none_or(str::is_empty)
    }

    fn path(&self) -> Option<&str> {
        self.path.as_deref().filter(|p| !p.is_empty())
    }

    /// 按改动内容搜索的文字
    fn changes(&self) -> Option<&str> {
        (self.search_in == SearchIn::Changes && !self.text.is_empty()).then_some(self.text.as_str())
    }
}

/// 作者的匹配规则（说明书 5.1 作者过滤）：对名字和邮箱分别比较，不区分大小写
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct AuthorMatch {
    pub kind: MatchKind,
    pub text: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchKind {
    #[default]
    Contains,
    Prefix,
    Suffix,
    Regex,
}

impl AuthorMatch {
    /// 换成一个判断函数；正则写错时返回 `INVALID_REGEX`（detail 里 field 是 author）
    pub fn matcher(&self) -> Result<impl Fn(&str) -> bool + use<>> {
        let t = self.text.trim();
        let pattern = match self.kind {
            MatchKind::Contains => regex::escape(t),
            MatchKind::Prefix => format!("^{}", regex::escape(t)),
            MatchKind::Suffix => format!("{}$", regex::escape(t)),
            MatchKind::Regex => t.to_string(),
        };
        let re = regex::RegexBuilder::new(&pattern).case_insensitive(true).size_limit(1 << 20).build().map_err(|e| {
            CoreError::new(ErrorCode::InvalidRegex, "作者的正则表达式写得不对").with_detail(serde_json::json!({ "field": "author", "source": e.to_string() }))
        })?;
        Ok(move |s: &str| re.is_match(s))
    }

    /// 这个作者算不算匹配：名字或邮箱满足规则
    pub fn hits(m: &impl Fn(&str) -> bool, name: &str, email: &str) -> bool {
        m(name) || m(email)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogSort {
    /// 图谱（拓扑）顺序
    #[default]
    Topo,
    /// 按提交时间从新到旧
    Date,
}

/// 作者过滤的选项
#[derive(Debug, Clone, Serialize)]
pub struct LogAuthor {
    pub name: String,
    pub email: String,
    /// 日志里这个作者的提交数
    pub count: u32,
}

struct Meta {
    /// 每行的作者时间
    time: Vec<i64>,
    /// 每行的作者在 `authors` 里的位置
    author: Vec<u32>,
    /// 按提交数从多到少
    authors: Vec<LogAuthor>,
}

/// 每次查询最多花在扫描说明文字上的时间；扫不完的下次查询接着扫
const BUDGET: Duration = Duration::from_millis(150);
/// 路径查询刚开始时最多等多久、攒够多少个提交就先返回
const FIRST_WAIT: Duration = Duration::from_millis(200);
const FIRST_BATCH: usize = 200;
/// 每次交给多个线程扫描的行数
const CHUNK: usize = 8192;

#[derive(Default)]
pub struct Cache {
    meta: Option<Arc<Meta>>,
    /// 当前这组条件的过滤进度
    run: Option<Run>,
    /// 路径过滤的后台查询
    path: Option<PathJob>,
    /// 按改动内容搜索的后台查询
    changes: Option<PathJob>,
}

impl Cache {
    /// 引用变了、提交没变：过滤结果重算，作者信息和路径查询留着
    pub(crate) fn forget_results(&mut self) {
        self.run = None;
    }
}

/// 一组过滤条件的计算进度
struct Run {
    filter: LogFilter,
    sort: LogSort,
    /// 算 `base` 时路径查询和改动内容查询已经找到的提交数、是否都已经结束；变了就重算
    path_seen: usize,
    path_done: bool,
    /// 便宜的条件（分支、日期、作者、路径）过滤后的行，按行号
    base: Vec<u32>,
    /// `base` 里已经匹配过说明文字的个数
    scanned: usize,
    /// 目前的结果（按行号）
    out: Vec<u32>,
    /// 按排序方式排好的结果
    rows: Arc<Vec<u32>>,
    done: bool,
}

/// 后台运行的 git 查询（路径过滤的 `git rev-list --all -- <路径>`、改动内容的 `git log -S`）：
/// 边读输出边记下命中的提交（每行一个哈希）
struct PathJob {
    /// 这组参数的标识，条件变了就换一个查询
    key: String,
    hits: Arc<Mutex<HashSet<gix::ObjectId>>>,
    done: Arc<AtomicBool>,
    failed: Arc<Mutex<Option<CoreError>>>,
    stop: Arc<AtomicBool>,
}

impl Drop for PathJob {
    fn drop(&mut self) {
        // 条件换了：不再需要，让后台线程结束 git
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl PathJob {
    fn start(dir: &Path, pattern: &str, case_sensitive: bool) -> PathJob {
        let spec = path_spec(pattern, case_sensitive);
        PathJob::run(dir, format!("path:{case_sensitive}:{pattern}"), &["rev-list".to_string(), "--all".into(), "--".into(), spec], "按路径过滤失败")
    }

    fn run(dir: &Path, key: String, args: &[String], fail_msg: &'static str) -> PathJob {
        let job = PathJob { key, hits: Arc::default(), done: Arc::default(), failed: Arc::default(), stop: Arc::default() };
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // 输出到管道时 git 会攒满一块（约 8 KB）再写：命中少的要等到最后才一起出来。让它每条都立刻写出
        cmd.env("GIT_FLUSH", "1");
        // 部分克隆：不要为了查询去下载缺的文件内容（会极慢）；需要时宁可失败
        cmd.env("GIT_NO_LAZY_FETCH", "1");
        git_cli::hide_console(&mut cmd);
        let (hits, done, failed, stop) = (job.hits.clone(), job.done.clone(), job.failed.clone(), job.stop.clone());
        std::thread::spawn(move || {
            let fail = |msg: String| {
                // -G 的正则写错时 git 报 “Invalid regex” 之类
                let bad_re = msg.contains("regex") || msg.contains("regcomp");
                let e = if bad_re { CoreError::new(ErrorCode::InvalidRegex, "正则表达式写得不对") } else { CoreError::new(ErrorCode::GitFailed, fail_msg) };
                *failed.lock().unwrap() = Some(e.with_detail(serde_json::json!({ "stderr": msg })));
            };
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    fail(e.to_string());
                    done.store(true, Ordering::SeqCst);
                    return;
                }
            };
            let out = child.stdout.take().expect("已设置为 piped");
            // 攒一点再放进结果，少抢锁；但命中少的路径不能等攒满：最多攒 256 个或 100 ms
            let mut batch = Vec::with_capacity(256);
            let mut last = Instant::now();
            for line in BufReader::new(out).lines() {
                if stop.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    break;
                }
                let Ok(line) = line else { break };
                if let Ok(id) = gix::ObjectId::from_hex(line.trim().as_bytes()) {
                    batch.push(id);
                }
                if batch.len() >= 256 || (!batch.is_empty() && last.elapsed() >= Duration::from_millis(100)) {
                    hits.lock().unwrap().extend(batch.drain(..));
                    last = Instant::now();
                }
            }
            hits.lock().unwrap().extend(batch);
            match child.wait_with_output() {
                Ok(o) if !o.status.success() && !stop.load(Ordering::SeqCst) => fail(String::from_utf8_lossy(&o.stderr).trim().to_string()),
                Err(e) => fail(e.to_string()),
                _ => {}
            }
            done.store(true, Ordering::SeqCst);
        });
        job
    }
}

/// 路径过滤的 pathspec：不带 glob 魔法时 `*` 也匹配 `/`，`*x*` 就是整个路径里的子串
fn path_spec(pattern: &str, case_sensitive: bool) -> String {
    format!(":({}){}{}{}", if case_sensitive { "" } else { "icase" }, "*", pattern, "*")
}

/// 按改动内容搜索的 `git log` 参数：普通文字用 -S（出现次数变了的提交），正则用 -G（改动的行匹配，POSIX 扩展正则）。
/// 分支、日期、路径也交给 git，范围小了快得多（10 万提交上全量 5 秒，限定路径或日期 0.3 秒以内）。
fn changes_args(f: &LogFilter, text: &str) -> Vec<String> {
    let mut a: Vec<String> = vec!["log".into(), "--format=%H".into()];
    a.push(f.branch.clone().unwrap_or_else(|| "--all".into()));
    a.push(if f.regex { format!("-G{text}") } else { format!("-S{text}") });
    if !f.case_sensitive {
        a.push("--regexp-ignore-case".into());
    }
    if let Some(t) = f.since {
        a.push(format!("--since=@{t}"));
    }
    if let Some(t) = f.until {
        a.push(format!("--until=@{t}"));
    }
    a.push("--".into());
    if let Some(p) = f.path() {
        a.push(path_spec(p, f.case_sensitive));
    }
    a
}

/// 仓库是不是部分克隆（文件内容没有全部下载）
pub fn is_partial_clone(dir: &Path) -> bool {
    let Ok(repo) = git2::Repository::open(dir) else { return false };
    let Ok(cfg) = repo.config() else { return false };
    if cfg.get_string("extensions.partialclone").is_ok_and(|v| !v.is_empty()) {
        return true;
    }
    let Ok(mut entries) = cfg.entries(Some(r"remote\..*\.promisor")) else { return false };
    let mut hit = false;
    while let Some(Ok(e)) = entries.next() {
        if e.value() == Ok("true") {
            hit = true;
        }
    }
    hit
}

/// 改过匹配路径的提交（在全部引用上运行 `git rev-list`，等它结束）。测试和工具用；日志过滤走后台查询。
pub fn path_commits(dir: &Path, pattern: &str, case_sensitive: bool) -> Result<HashSet<gix::ObjectId>> {
    let job = PathJob::start(dir, pattern, case_sensitive);
    while !job.done.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(10));
    }
    if let Some(e) = job.failed.lock().unwrap().take() {
        return Err(e);
    }
    let hits = job.hits.lock().unwrap().clone();
    Ok(hits)
}

impl Session {
    /// 带过滤和排序的一页日志。不过滤、按图谱顺序时和 [`Session::log_page`] 相同。
    pub fn log_query(&mut self, f: &LogFilter, sort: LogSort, offset: usize, limit: usize) -> Result<LogPage> {
        if f.is_empty() && sort == LogSort::Topo {
            return self.log_page(offset, limit);
        }
        let (rows, partial) = self.filtered(f, sort)?;
        let total = rows.len();
        let start = offset.min(total);
        let end = (start + limit.min(MAX_PAGE)).min(total);
        let commits = self.commits_at(rows[start..end].iter().copied())?;
        Ok(LogPage { offset: start, rows: commits, graph: Vec::new(), total, lanes: 0, partial })
    }

    /// 某个提交在过滤结果里的位置；不在结果里返回 `None`
    pub fn log_locate_in(&mut self, rev: &str, f: &LogFilter, sort: LogSort) -> Result<Option<usize>> {
        let Some(row) = self.log_locate(rev) else { return Ok(None) };
        if f.is_empty() && sort == LogSort::Topo {
            return Ok(Some(row));
        }
        let (rows, _) = self.filtered(f, sort)?;
        Ok(rows.iter().position(|&r| r as usize == row))
    }

    /// 仓库里出现过的作者，按提交数从多到少
    pub fn log_authors(&mut self) -> Result<Vec<LogAuthor>> {
        Ok(self.meta()?.authors.clone())
    }

    /// 过滤结果（按排序方式排好）和是否还没算完。没算完时每次调用都接着算一段（最多 `BUDGET`）。
    fn filtered(&mut self, f: &LogFilter, sort: LogSort) -> Result<(Arc<Vec<u32>>, bool)> {
        // 先把正则编译好，写错了直接报错，不用白做前面的工作
        let matcher = Matcher::new(f)?;

        // 路径过滤和改动内容搜索：没有对应的后台查询就开一个
        let path_key = f.path().map(|p| format!("path:{}:{p}", f.case_sensitive));
        let changes_key = f.changes().map(|t| format!("changes:{}", serde_json::json!([t, f.regex, f.case_sensitive, f.branch, f.since, f.until, f.path()])));
        if changes_key.is_some() && is_partial_clone(self.path()) {
            return Err(CoreError::new(
                ErrorCode::PartialClone,
                "这个仓库是部分克隆，文件内容没有全部下载。在历史改动里搜索要把全部历史的文件内容下载下来，所以没有执行",
            ));
        }
        let mut seen = 0;
        let mut all_done = true;
        for (slot, key) in [(0, path_key), (1, changes_key)] {
            let dir = self.path().to_path_buf();
            let cache = if slot == 0 { &mut self.filter_cache.path } else { &mut self.filter_cache.changes };
            let Some(key) = key else {
                *cache = None;
                continue;
            };
            if cache.as_ref().is_none_or(|j| j.key != key) {
                let job = if slot == 0 {
                    PathJob::start(&dir, f.path().unwrap_or(""), f.case_sensitive)
                } else {
                    PathJob::run(&dir, key, &changes_args(f, f.changes().unwrap_or("")), "按改动内容搜索失败")
                };
                // 刚开始的查询还没有结果：最多等 FIRST_WAIT，攒够一页或结束就返回，第一次查询就能带回首批结果
                let t0 = Instant::now();
                while t0.elapsed() < FIRST_WAIT && !job.done.load(Ordering::SeqCst) && job.hits.lock().unwrap().len() < FIRST_BATCH {
                    std::thread::sleep(Duration::from_millis(5));
                }
                *cache = Some(job);
            }
            let job = cache.as_ref().expect("刚放进去");
            let failed = job.failed.lock().unwrap().take();
            if let Some(e) = failed {
                *cache = None;
                self.filter_cache.run = None;
                return Err(e);
            }
            // 先读 done 再读数目：读到 done 时数目一定是最终的
            let done = job.done.load(Ordering::SeqCst);
            seen += job.hits.lock().unwrap().len();
            all_done &= done;
        }
        let (path_seen, path_done) = (seen, all_done);

        let mut run = match self.filter_cache.run.take() {
            Some(r) if r.filter == *f && r.sort == sort && r.path_seen == path_seen && r.path_done == path_done => r,
            _ => {
                let base = self.base_rows(f)?;
                let (scanned, out) = if matcher.is_some() { (0, Vec::new()) } else { (base.len(), base.clone()) };
                Run { filter: f.clone(), sort, path_seen, path_done, base, scanned, out, rows: Arc::default(), done: false }
            }
        };
        if !run.done {
            if let Some(m) = &matcher {
                let t0 = Instant::now();
                while run.scanned < run.base.len() && (run.scanned == 0 || t0.elapsed() < BUDGET) {
                    let end = (run.scanned + CHUNK).min(run.base.len());
                    let found = self.scan(&run.base[run.scanned..end], |id, c| {
                        m.hash.as_deref().is_some_and(|h| id.to_hex().to_string().starts_with(h))
                            || c.message_raw().is_ok_and(|msg| m.re.is_match(msg))
                    });
                    run.out.extend(found);
                    run.scanned = end;
                }
            }
            let mut rows = run.out.clone();
            if sort == LogSort::Date {
                rows.sort_by_key(|&r| Reverse(self.times[r as usize]));
            }
            run.rows = Arc::new(rows);
            run.done = run.scanned == run.base.len() && path_done;
        }
        let out = (run.rows.clone(), !run.done);
        self.filter_cache.run = Some(run);
        Ok(out)
    }

    /// 便宜的条件（分支、日期、作者、路径）过滤后的行，按行号。路径按后台查询目前找到的提交算。
    fn base_rows(&mut self, f: &LogFilter) -> Result<Vec<u32>> {
        let n = self.ids.len();
        let mut rows: Vec<u32> = match &f.branch {
            Some(b) => self.reachable(b),
            None => (0..n as u32).collect(),
        };
        let rule = f.author_match.as_ref().filter(|m| !m.text.trim().is_empty());
        let by_author = f.author.is_some() || !f.authors.is_empty() || rule.is_some();
        if f.since.is_some() || f.until.is_some() || by_author {
            let meta = self.meta()?;
            if let Some(since) = f.since {
                rows.retain(|&r| meta.time[r as usize] >= since);
            }
            if let Some(until) = f.until {
                rows.retain(|&r| meta.time[r as usize] < until);
            }
            if by_author {
                // 先在作者表上算出哪些作者算数（作者通常只有几十到几百个），再按行筛
                let picked: HashSet<String> = f.authors.iter().chain(f.author.iter()).map(|e| e.to_lowercase()).collect();
                let m = rule.map(|r| r.matcher()).transpose()?;
                let ok: Vec<bool> = meta
                    .authors
                    .iter()
                    .map(|a| picked.contains(&a.email) || m.as_ref().is_some_and(|m| AuthorMatch::hits(m, &a.name, &a.email)))
                    .collect();
                rows.retain(|&r| ok[meta.author[r as usize] as usize]);
            }
        }
        if f.changes().is_some()
            && let Some(job) = &self.filter_cache.changes
        {
            let hits = job.hits.lock().unwrap();
            rows.retain(|&r| hits.contains(&self.ids[r as usize]));
        }
        if f.path().is_some()
            && let Some(job) = &self.filter_cache.path
        {
            let hits = job.hits.lock().unwrap();
            rows.retain(|&r| hits.contains(&self.ids[r as usize]));
        }
        Ok(rows)
    }

    /// 从某个引用能到达的所有行，按行号排好
    fn reachable(&self, rev: &str) -> Vec<u32> {
        let Some(tip) = self.log_locate(rev) else { return Vec::new() };
        let mut seen = vec![false; self.ids.len()];
        let mut stack = vec![tip as u32];
        seen[tip] = true;
        while let Some(r) = stack.pop() {
            for &p in &self.parents[r as usize] {
                if !seen[p as usize] {
                    seen[p as usize] = true;
                    stack.push(p);
                }
            }
        }
        (0..self.ids.len() as u32).filter(|&r| seen[r as usize]).collect()
    }

    fn meta(&mut self) -> Result<Arc<Meta>> {
        if let Some(m) = &self.filter_cache.meta {
            return Ok(m.clone());
        }
        let all: Vec<u32> = (0..self.ids.len() as u32).collect();
        let sigs = self.scan_map(&all, |_, c| {
            let a = c.author().ok()?;
            Some((a.time().map(|t| t.seconds).unwrap_or(0), a.email.to_string().to_lowercase(), a.name.to_string()))
        });
        let mut by_email: HashMap<String, u32> = HashMap::new();
        let mut authors: Vec<LogAuthor> = Vec::new();
        let mut time = Vec::with_capacity(sigs.len());
        let mut author = Vec::with_capacity(sigs.len());
        for s in sigs {
            let (t, email, name) = s.unwrap_or_default();
            let i = *by_email.entry(email.clone()).or_insert_with(|| {
                // 日志从新到旧，第一次见到的名字就是这个邮箱最近用的名字
                authors.push(LogAuthor { name, email, count: 0 });
                (authors.len() - 1) as u32
            });
            authors[i as usize].count += 1;
            time.push(t);
            author.push(i);
        }
        // 按提交数排序后，重新编号
        let mut order: Vec<u32> = (0..authors.len() as u32).collect();
        order.sort_by_key(|&i| (Reverse(authors[i as usize].count), authors[i as usize].name.to_lowercase()));
        let mut remap = vec![0u32; authors.len()];
        for (new, &old) in order.iter().enumerate() {
            remap[old as usize] = new as u32;
        }
        let authors = order.iter().map(|&i| authors[i as usize].clone()).collect();
        let author = author.into_iter().map(|i| remap[i as usize]).collect();
        let m = Arc::new(Meta { time, author, authors });
        self.filter_cache.meta = Some(m.clone());
        Ok(m)
    }

    /// 在多个线程上解码 `rows` 里的提交，留下 `keep` 返回 true 的，保持原来的顺序
    fn scan(&self, rows: &[u32], keep: impl Fn(&gix::oid, &gix::Commit<'_>) -> bool + Sync) -> Vec<u32> {
        let hits = self.scan_map(rows, |id, c| keep(id, c).then_some(()));
        rows.iter().zip(hits).filter_map(|(&r, h)| h.map(|_| r)).collect()
    }

    /// 在多个线程上解码 `rows` 里的提交并对每个调用 `f`；读不出来的提交得到 `None`
    fn scan_map<T: Send>(&self, rows: &[u32], f: impl Fn(&gix::oid, &gix::Commit<'_>) -> Option<T> + Sync) -> Vec<Option<T>> {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
        let chunk = rows.len().div_ceil(threads).max(1024);
        let f = &f;
        std::thread::scope(|scope| {
            let handles: Vec<_> = rows
                .chunks(chunk)
                .map(|part| {
                    scope.spawn(move || {
                        let mut repo = self.repo.to_thread_local();
                        repo.object_cache_size_if_unset(16 * 1024 * 1024);
                        part.iter()
                            .map(|&r| {
                                let id = self.ids[r as usize];
                                repo.find_commit(id).ok().and_then(|c| f(&id, &c))
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        })
    }
}

struct Matcher {
    re: regex::bytes::Regex,
    /// 哈希前缀（小写）
    hash: Option<String>,
}

impl Matcher {
    fn new(f: &LogFilter) -> Result<Option<Matcher>> {
        // 按改动内容搜索时文字交给 git log -S / -G，不匹配说明
        if f.text.is_empty() || f.search_in == SearchIn::Changes {
            return Ok(None);
        }
        let pattern = if f.regex { f.text.clone() } else { regex::escape(&f.text) };
        let re = regex::bytes::RegexBuilder::new(&pattern)
            .case_insensitive(!f.case_sensitive)
            .size_limit(1 << 22)
            .build()
            .map_err(|e| {
                CoreError::new(ErrorCode::InvalidRegex, "正则表达式写得不对")
                    .with_detail(serde_json::json!({ "source": e.to_string() }))
            })?;
        let t = f.text.trim();
        let hash = (!f.regex && t.len() >= 4 && t.len() <= 40 && t.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| t.to_lowercase());
        Ok(Some(Matcher { re, hash }))
    }
}
