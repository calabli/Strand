//! Contribution statistics for the current branch: commits and changed lines per author and per month, and when
//! commits are made (weekday × hour, in each author's own time zone). One `git log --shortstat` over a time range;
//! merge commits are left out (their changes are counted in the commits they merge). Authors are grouped by name and
//! email after .mailmap. In a partial clone file contents may be missing locally, so lines aren't counted there
//! (counting would download every changed file).

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::git_cli;
use crate::Result;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct AuthorStats {
    pub name: String,
    pub email: String,
    pub commits: u32,
    pub added: u64,
    pub deleted: u64,
    /// First and last commit in the range, Unix seconds
    pub first: i64,
    pub last: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct MonthStats {
    /// "2026-11"
    pub month: String,
    pub commits: u32,
    pub added: u64,
    pub deleted: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Contributions {
    /// Most commits first
    pub authors: Vec<AuthorStats>,
    /// Oldest first, months without commits included (between the first and the last commit)
    pub months: Vec<MonthStats>,
    /// Commits by weekday (0 = Monday) and hour, in the author's time zone
    pub heat: Vec<[u32; 24]>,
    pub commits: u32,
    pub added: u64,
    pub deleted: u64,
    /// Lines weren't counted (partial clone)
    pub no_lines: bool,
}

const FORMAT: &str = "--format=%x1e%aN%x1f%aE%x1f%at%x1f%ad";

/// Statistics for HEAD's history since `since` (Unix seconds; None = all of it)
pub fn contributions(dir: &Path, since: Option<i64>) -> Result<Contributions> {
    let no_lines = crate::log_filter::is_partial_clone(dir);
    let since_arg = since.map(|s| format!("--since=@{s}"));
    let mut args = vec!["log", "--no-merges", FORMAT, "--date=format:%Y-%m|%u|%H"];
    if !no_lines {
        args.push("--shortstat");
    }
    if let Some(s) = &since_arg {
        args.push(s);
    }
    args.push("HEAD");
    let out = git_cli::run_env(dir, &args, None, &[("GIT_NO_LAZY_FETCH", "1")]).or_else(|e| {
        // No commits yet: nothing to count
        if git2::Repository::open(dir).is_ok_and(|r| r.head().is_err()) { Ok(String::new()) } else { Err(e) }
    })?;
    let mut c = parse(&out);
    c.no_lines = no_lines;
    Ok(c)
}

/// Read `git log` output in FORMAT (with --shortstat or without)
pub fn parse(out: &str) -> Contributions {
    let mut authors: HashMap<(String, String), AuthorStats> = HashMap::new();
    let mut months: HashMap<String, MonthStats> = HashMap::new();
    let mut heat = vec![[0u32; 24]; 7];
    let mut total = Contributions::default();
    for rec in out.split('\x1e').filter(|r| !r.trim().is_empty()) {
        let mut lines = rec.lines();
        let head = lines.next().unwrap_or("");
        let f: Vec<&str> = head.split('\x1f').collect();
        if f.len() < 4 {
            continue;
        }
        let time: i64 = f[2].parse().unwrap_or(0);
        let (added, deleted) = lines.find(|l| l.contains("changed")).map(shortstat).unwrap_or((0, 0));
        let d: Vec<&str> = f[3].split('|').collect();
        let (month, wd, hour) = (d.first().copied().unwrap_or(""), d.get(1).and_then(|x| x.parse::<usize>().ok()), d.get(2).and_then(|x| x.parse::<usize>().ok()));

        let a = authors.entry((f[0].to_string(), f[1].to_lowercase())).or_insert_with(|| AuthorStats {
            name: f[0].to_string(),
            email: f[1].to_string(),
            first: time,
            last: time,
            ..Default::default()
        });
        a.commits += 1;
        a.added += added;
        a.deleted += deleted;
        a.first = a.first.min(time);
        a.last = a.last.max(time);

        if !month.is_empty() {
            let m = months.entry(month.to_string()).or_insert_with(|| MonthStats { month: month.to_string(), ..Default::default() });
            m.commits += 1;
            m.added += added;
            m.deleted += deleted;
        }
        if let (Some(w @ 1..=7), Some(h @ 0..=23)) = (wd, hour) {
            heat[w - 1][h] += 1;
        }
        total.commits += 1;
        total.added += added;
        total.deleted += deleted;
    }
    let mut authors: Vec<AuthorStats> = authors.into_values().collect();
    authors.sort_by(|a, b| b.commits.cmp(&a.commits).then(b.last.cmp(&a.last)));
    total.authors = authors;
    total.months = fill_months(months);
    total.heat = heat;
    total
}

/// "3 files changed, 10 insertions(+), 2 deletions(-)" → (10, 2)
fn shortstat(l: &str) -> (u64, u64) {
    let mut r = (0, 0);
    for part in l.split(',') {
        let n: u64 = part.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0);
        if part.contains("insertion") {
            r.0 = n;
        } else if part.contains("deletion") {
            r.1 = n;
        }
    }
    r
}

/// Sort the months and add the empty ones in between, so a chart's gaps show quiet months
fn fill_months(m: HashMap<String, MonthStats>) -> Vec<MonthStats> {
    let parse = |s: &str| -> Option<(i32, u32)> {
        let (y, mo) = s.split_once('-')?;
        Some((y.parse().ok()?, mo.parse().ok()?))
    };
    let mut keys: Vec<(i32, u32)> = m.keys().filter_map(|k| parse(k)).collect();
    keys.sort();
    let (Some(&first), Some(&last)) = (keys.first(), keys.last()) else { return Vec::new() };
    let mut out = Vec::new();
    let (mut y, mut mo) = first;
    while (y, mo) <= last {
        let k = format!("{y:04}-{mo:02}");
        out.push(m.get(&k).cloned().unwrap_or(MonthStats { month: k, ..Default::default() }));
        mo += 1;
        if mo > 12 {
            mo = 1;
            y += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log() {
        let out = "\x1eLin Xia\x1flin@example.com\x1f1794645000\x1f2026-11|5|14\n\n 2 files changed, 10 insertions(+), 2 deletions(-)\n\
                   \x1eZhou\x1fzhou@example.com\x1f1789000000\x1f2026-09|1|09\n\n 1 file changed, 3 deletions(-)\n\
                   \x1eLin Xia\x1fLIN@example.com\x1f1789100000\x1f2026-09|7|23\n\n 1 file changed, 1 insertion(+)\n";
        let c = parse(out);
        assert_eq!((c.commits, c.added, c.deleted), (3, 11, 5));
        assert_eq!(c.authors.len(), 2);
        assert_eq!((c.authors[0].name.as_str(), c.authors[0].commits, c.authors[0].added), ("Lin Xia", 2, 11));
        assert_eq!(c.months.iter().map(|m| (m.month.as_str(), m.commits)).collect::<Vec<_>>(), vec![("2026-09", 2), ("2026-10", 0), ("2026-11", 1)]);
        assert_eq!((c.heat[4][14], c.heat[0][9], c.heat[6][23]), (1, 1, 1));
    }

    #[test]
    fn counts_a_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git").args(args).current_dir(p).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap().status.success();
            assert!(ok, "{args:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "A"]);
        git(&["config", "user.email", "a@example.com"]);
        std::fs::write(p.join("f.txt"), "1\n2\n3\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "one"]);
        std::fs::write(p.join("f.txt"), "1\n3\n4\n5\n").unwrap();
        git(&["commit", "-qam", "two"]);
        let c = contributions(p, None).unwrap();
        assert_eq!((c.commits, c.added, c.deleted, c.authors.len()), (2, 5, 1, 1));
        assert_eq!(c.months.len(), 1);
        assert_eq!(c.heat.iter().flatten().sum::<u32>(), 2);
        // A range that starts after both commits
        assert_eq!(contributions(p, Some(i64::from(i32::MAX))).unwrap().commits, 0);
    }
}
