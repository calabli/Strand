//! Log filtering and sorting (spec §5.1): search (message, body, hash, optional regex and case sensitivity), branch, author, date, path,
//! and sorting by commit time. Conditions are intersected; no graph is returned when filtering or sorting by time.
//!
//! Cheap conditions run first (branch reachability, date, author, path); only then are the remaining commits decoded to match message text, spread across threads.
//! Authors and author times are read for all commits on first use and cached; the last filter result is cached too so paging doesn't recompute.
//!
//! First results return first, the rest are appended in batches (spec §15):
//! - Path filtering runs `git rev-list` over the whole history once, which takes seconds on large repositories. It runs on a background thread, recording output as it reads;
//!   each query filters with what has been read so far and marks the result `partial`.
//! - Message matching scans in chunks, spending at most `BUDGET` per query; the next query continues where it stopped.
//!   When the UI sees `partial` it queries again a little later, until it is no longer `partial`.

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

/// Filter conditions. Every field may be omitted, meaning no filtering on it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct LogFilter {
    /// Search text: matches the commit message (title and body); when not a regex, 4+ hex characters also match hash prefixes
    pub text: String,
    pub regex: bool,
    pub case_sensitive: bool,
    /// Only commits reachable from this branch (local or remote branch name, or a tag or HEAD)
    pub branch: Option<String>,
    /// Author email, case-insensitive (the old single-author form, combined with `authors`)
    pub author: Option<String>,
    /// Selected author emails (multiple), case-insensitive
    pub authors: Vec<String>,
    /// Match authors by rule: name or email matching counts. OR-ed with the selected authors
    pub author_match: Option<AuthorMatch>,
    /// Author time not earlier than this (Unix seconds)
    pub since: Option<i64>,
    /// Author time earlier than this (Unix seconds, exclusive)
    pub until: Option<i64>,
    /// Path substring: only commits that changed matching files
    pub path: Option<String>,
    /// Where the search text searches: commit messages (default) or changes (`git log -S` / `-G`, an extension of spec §5.1)
    pub search_in: SearchIn,
    /// First parent only: walk back from the current branch (or the filtered branch) along first parents; commits on merged-in branches aren't shown
    pub first_parent: bool,
    /// Hide merge commits
    pub no_merges: bool,
    /// Collapse linear branches (only without other filters, in graph order): consecutive commits on side lines with no refs, one parent and one child are folded,
    /// the graph is drawn as usual, and the row above shows how many were folded
    pub collapse_linear: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchIn {
    #[default]
    Message,
    /// Changes: plain text finds commits where the number of occurrences changed (the commit that added or removed it); a regex finds commits whose changed lines match
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
            && !self.first_parent
            && !self.no_merges
            && self.path.as_deref().is_none_or(str::is_empty)
    }

    fn path(&self) -> Option<&str> {
        self.path.as_deref().filter(|p| !p.is_empty())
    }

    /// Text to search for in changes
    fn changes(&self) -> Option<&str> {
        (self.search_in == SearchIn::Changes && !self.text.is_empty()).then_some(self.text.as_str())
    }
}

/// Author matching rule (author filter in spec §5.1): compared against name and email separately, case-insensitive
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
    /// Turn into a predicate; returns `INVALID_REGEX` for a bad regex (field in detail is author)
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

    /// Whether this author matches: name or email satisfies the rule
    pub fn hits(m: &impl Fn(&str) -> bool, name: &str, email: &str) -> bool {
        m(name) || m(email)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogSort {
    /// Graph (topological) order
    #[default]
    Topo,
    /// By commit time, newest first
    Date,
}

/// Options for the author filter
#[derive(Debug, Clone, Serialize)]
pub struct LogAuthor {
    pub name: String,
    pub email: String,
    /// This author's number of commits in the log
    pub count: u32,
}

struct Meta {
    /// Author time of each row
    time: Vec<i64>,
    /// Each row's author index in `authors`
    author: Vec<u32>,
    /// By number of commits, most first
    authors: Vec<LogAuthor>,
}

/// Maximum time per query spent scanning message text; the next query continues what's left
const BUDGET: Duration = Duration::from_millis(150);
/// When a path query has just started, how long to wait at most, and how many commits are enough to return early
const FIRST_WAIT: Duration = Duration::from_millis(200);
const FIRST_BATCH: usize = 200;
/// Rows handed to the worker threads per round
const CHUNK: usize = 8192;

#[derive(Default)]
pub struct Cache {
    meta: Option<Arc<Meta>>,
    /// Filter progress for the current set of conditions
    run: Option<Run>,
    /// Background query for path filtering
    path: Option<PathJob>,
    /// The view with linear branches collapsed
    collapsed: Option<Arc<Collapsed>>,
    /// Background query for searching changes
    changes: Option<PathJob>,
}

impl Cache {
    /// Refs changed but commits didn't: recompute filter results, keep author info and path queries
    pub(crate) fn forget_results(&mut self) {
        self.run = None;
        // Refs changed, so which commits have refs (and aren't folded) changed too
        self.collapsed = None;
    }
}

/// The view with linear branches collapsed: the remaining rows, their graph, and how many are folded under each row
struct Collapsed {
    rows: Vec<u32>,
    graph: Vec<crate::model::GraphRow>,
    lanes: u32,
    folded: Vec<u32>,
}

/// Computation progress for one set of filter conditions
struct Run {
    filter: LogFilter,
    sort: LogSort,
    /// When `base` was computed: commits already found by the path and change queries, and whether both had finished; recompute when this changes
    path_seen: usize,
    path_done: bool,
    /// Rows passing the cheap conditions (branch, date, author, path), by row number
    base: Vec<u32>,
    /// How many in `base` have already been matched against message text
    scanned: usize,
    /// Current results (by row number)
    out: Vec<u32>,
    /// Results sorted by the sort order
    rows: Arc<Vec<u32>>,
    done: bool,
}

/// A git query running in the background (`git rev-list <log refs> -- <path>` for path filtering, `git log -S` for changes):
/// records matching commits (one hash per line) as output is read
struct PathJob {
    /// An id for this set of parameters; a different query when conditions change
    key: String,
    hits: Arc<Mutex<HashSet<gix::ObjectId>>>,
    done: Arc<AtomicBool>,
    failed: Arc<Mutex<Option<CoreError>>>,
    stop: Arc<AtomicBool>,
}

impl Drop for PathJob {
    fn drop(&mut self) {
        // Conditions changed: no longer needed, let the background thread end git
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl PathJob {
    fn start(dir: &Path, pattern: &str, case_sensitive: bool) -> PathJob {
        let spec = path_spec(pattern, case_sensitive);
        let mut args = vec!["rev-list".to_string()];
        args.extend(log_roots(dir));
        args.extend(["--".into(), spec]);
        PathJob::run(dir, format!("path:{case_sensitive}:{pattern}"), &args, "按路径过滤失败")
    }

    fn run(dir: &Path, key: String, args: &[String], fail_msg: &'static str) -> PathJob {
        let job = PathJob { key, hits: Arc::default(), done: Arc::default(), failed: Arc::default(), stop: Arc::default() };
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // When writing to a pipe git buffers a full block (about 8 KB) first: with few hits they would all arrive at the end. Make it write each one right away
        cmd.env("GIT_FLUSH", "1");
        // Partial clone: don't download missing file contents for a query (extremely slow); rather fail when needed
        cmd.env("GIT_NO_LAZY_FETCH", "1");
        git_cli::hide_console(&mut cmd);
        let (hits, done, failed, stop) = (job.hits.clone(), job.done.clone(), job.failed.clone(), job.stop.clone());
        std::thread::spawn(move || {
            let fail = |msg: String| {
                // git reports something like "Invalid regex" for a bad -G regex
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
            // Batch a little before adding to results to reduce lock contention; but paths with few hits can't wait for a full batch: at most 256 or 100 ms
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

/// Pathspec for path filtering: without glob magic `*` also matches `/`, so `*x*` is a substring anywhere in the path
fn path_spec(pattern: &str, case_sensitive: bool) -> String {
    format!(":({}){}{}{}", if case_sensitive { "" } else { "icase" }, "*", pattern, "*")
}

/// `git log` arguments for searching changes: plain text uses -S (commits where the occurrence count changed), regex uses -G (changed lines match, POSIX extended regex).
/// Branch, date and path are passed to git too; a narrower range is much faster (5 s for everything on 100k commits, under 0.3 s with a path or date).
fn changes_args(dir: &Path, f: &LogFilter, text: &str) -> Vec<String> {
    let mut a: Vec<String> = vec!["log".into(), "--format=%H".into()];
    match &f.branch {
        Some(b) => a.push(b.clone()),
        None => a.extend(log_roots(dir)),
    }
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

/// Which refs background queries start from: same as the log, local branches, remote branches, tags, plus HEAD when detached.
/// Not `--all`: that would also scan Strand's own undo snapshots in `refs/strand/ops/*` and stashes (wasted time, and the results aren't in the log)
fn log_roots(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = vec!["--branches".into(), "--remotes".into(), "--tags".into()];
    if git2::Repository::open(dir).is_ok_and(|r| r.head_detached().unwrap_or(false)) {
        v.push("HEAD".into());
    }
    v
}

/// Whether the repository is a partial clone (not all file contents downloaded)
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

/// Commits that changed matching paths (runs `git rev-list` on the log's refs and waits for it). For tests and tools; log filtering uses the background query.
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
    /// One page of the log with filtering and sorting. Same as [`Session::log_page`] without filters in graph order.
    pub fn log_query(&mut self, f: &LogFilter, sort: LogSort, offset: usize, limit: usize) -> Result<LogPage> {
        if f.is_empty() && sort == LogSort::Topo {
            if f.collapse_linear {
                let v = self.collapsed();
                let total = v.rows.len();
                let start = offset.min(total);
                let end = (start + limit.min(MAX_PAGE)).min(total);
                let commits = self.commits_at(v.rows[start..end].iter().copied())?;
                return Ok(LogPage {
                    offset: start,
                    rows: commits,
                    graph: v.graph[start..end].to_vec(),
                    total,
                    lanes: v.lanes,
                    partial: false,
                    folded: v.folded[start..end].to_vec(),
                });
            }
            return self.log_page(offset, limit);
        }
        let (rows, partial) = self.filtered(f, sort)?;
        let total = rows.len();
        let start = offset.min(total);
        let end = (start + limit.min(MAX_PAGE)).min(total);
        let commits = self.commits_at(rows[start..end].iter().copied())?;
        Ok(LogPage { offset: start, rows: commits, graph: Vec::new(), total, lanes: 0, partial, folded: Vec::new() })
    }

    /// A commit's position in the filtered results; `None` when not in them
    pub fn log_locate_in(&mut self, rev: &str, f: &LogFilter, sort: LogSort) -> Result<Option<usize>> {
        let Some(row) = self.log_locate(rev) else { return Ok(None) };
        if f.is_empty() && sort == LogSort::Topo {
            if f.collapse_linear {
                // Folded commits aren't in the list
                return Ok(self.collapsed().rows.iter().position(|&r| r as usize == row));
            }
            return Ok(Some(row));
        }
        let (rows, _) = self.filtered(f, sort)?;
        Ok(rows.iter().position(|&r| r as usize == row))
    }

    /// The row HEAD is on; the first row when there is none (empty repository, HEAD not in the log)
    fn head_row_or_top(&self) -> usize {
        self.head_row().map(|r| r as usize).unwrap_or(0)
    }

    /// Rows passed walking back from a row along first parents
    fn first_parent_chain(&self, from: usize) -> Vec<bool> {
        let mut on = vec![false; self.ids.len()];
        let mut r = from;
        while r < on.len() && !on[r] {
            on[r] = true;
            match self.parents[r].first() {
                Some(&p) => r = p as usize,
                None => break,
            }
        }
        on
    }

    /// The view with linear branches collapsed (computed once and cached, recomputed when refs or the log change).
    /// The current branch's first-parent line is kept entirely; other commits with no refs, one parent in the log and one child are folded,
    /// the remaining rows' parents skip the folded ones and connect directly to the next remaining commit, and the graph is laid out again.
    fn collapsed(&mut self) -> Arc<Collapsed> {
        if let Some(c) = &self.filter_cache.collapsed {
            return c.clone();
        }
        let n = self.ids.len();
        let main = self.first_parent_chain(self.head_row_or_top());
        let mut kids = vec![0u32; n];
        for ps in &self.parents {
            for &p in ps {
                kids[p as usize] += 1;
            }
        }
        let hide: Vec<bool> = (0..n)
            .map(|r| !main[r] && self.parents[r].len() == 1 && kids[r] == 1 && !self.refs.contains_key(&self.ids[r]))
            .collect();
        let rows: Vec<u32> = (0..n as u32).filter(|&r| !hide[r as usize]).collect();
        let mut pos = vec![u32::MAX; n];
        for (i, &r) in rows.iter().enumerate() {
            pos[r as usize] = i as u32;
        }
        let mut folded = vec![0u32; rows.len()];
        let mut parents: Vec<Vec<u32>> = Vec::with_capacity(rows.len());
        for (i, &r) in rows.iter().enumerate() {
            let mut ps = Vec::new();
            for &p in &self.parents[r as usize] {
                let mut p = p as usize;
                while hide[p] {
                    folded[i] += 1;
                    p = self.parents[p][0] as usize;
                }
                ps.push(pos[p]);
            }
            parents.push(ps);
        }
        let layout = crate::graph::layout(&parents);
        let c = Arc::new(Collapsed { rows, graph: layout.rows, lanes: layout.lanes, folded });
        self.filter_cache.collapsed = Some(c.clone());
        c
    }

    /// Authors in the repository, by number of commits, most first
    pub fn log_authors(&mut self) -> Result<Vec<LogAuthor>> {
        Ok(self.meta()?.authors.clone())
    }

    /// Filter results (sorted) and whether computation isn't finished. When unfinished, each call continues for a stretch (at most `BUDGET`).
    fn filtered(&mut self, f: &LogFilter, sort: LogSort) -> Result<(Arc<Vec<u32>>, bool)> {
        // Compile the regex first so a bad one fails right away without wasted work
        let matcher = Matcher::new(f)?;

        // Path filtering and change search: start a background query if there isn't one
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
                    PathJob::run(&dir, key, &changes_args(&dir, f, f.changes().unwrap_or("")), "按改动内容搜索失败")
                };
                // A query that just started has no results yet: wait at most FIRST_WAIT and return once a page is collected or it ends, so the first call brings back the first results
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
            // Read done before the count: when done is seen, the count is final
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

    /// Rows passing the cheap conditions (branch, date, author, path), by row number. Paths use the commits the background query has found so far.
    fn base_rows(&mut self, f: &LogFilter) -> Result<Vec<u32>> {
        let n = self.ids.len();
        let mut rows: Vec<u32> = match &f.branch {
            Some(b) => self.reachable(b),
            None => (0..n as u32).collect(),
        };
        if f.first_parent {
            let tip = f.branch.as_deref().and_then(|b| self.log_locate(b)).unwrap_or_else(|| self.head_row_or_top());
            let on = self.first_parent_chain(tip);
            rows.retain(|&r| on[r as usize]);
        }
        if f.no_merges {
            rows.retain(|&r| self.parents[r as usize].len() < 2);
        }
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
                // First work out on the author table which authors count (usually only tens to hundreds), then filter rows
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

    /// All rows reachable from a ref, sorted by row number
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
                // The log runs newest to oldest, so the first name seen is the one this email used most recently
                authors.push(LogAuthor { name, email, count: 0 });
                (authors.len() - 1) as u32
            });
            authors[i as usize].count += 1;
            time.push(t);
            author.push(i);
        }
        // Renumber after sorting by commit count
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

    /// Decode the commits in `rows` on several threads and keep those where `keep` returns true, preserving order
    fn scan(&self, rows: &[u32], keep: impl Fn(&gix::oid, &gix::Commit<'_>) -> bool + Sync) -> Vec<u32> {
        let hits = self.scan_map(rows, |id, c| keep(id, c).then_some(()));
        rows.iter().zip(hits).filter_map(|(&r, h)| h.map(|_| r)).collect()
    }

    /// Decode the commits in `rows` on several threads and call `f` on each; unreadable commits get `None`
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
    /// Hash prefix (lowercase)
    hash: Option<String>,
}

impl Matcher {
    fn new(f: &LogFilter) -> Result<Option<Matcher>> {
        // When searching changes the text goes to git log -S / -G, not matched against messages
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
