//! Console (spec §5.8) and local log file (spec §15).
//!
//! Git commands run by the core layer are recorded here in order: a `$` entry is a command (followed by its output), a `#` entry is the client's own operation
//! (e.g. shelve, undo) with no direct git command. The UI receives new entries through `set_sink` and uses `tail` for the latest when opened.
//!
//! - Only commands that change the repository or use the network are recorded; queries (rev-parse, cherry, diff, log, etc.) are not,
//!   otherwise every branch list refresh would add dozens of lines and push out what matters.
//! - Each command keeps at most `MAX_OUTPUT` lines of output; for network commands only the last progress (percentage) line is kept.
//! - Only the latest `MAX_LINES` lines are kept in total (commands and output both count), and it can be cleared. Undo doesn't roll it back.
//! - Credentials in commands and output are masked: passwords in URLs, whatever follows `Authorization:`, whatever follows `password=`.
//!
//! The same content is also appended to a local log file (directory set by `set_log_dir`, one file per day, kept 7 days, never uploaded).

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

pub const MAX_LINES: usize = 300;
pub const MAX_OUTPUT: usize = 12;
const LOG_KEEP_DAYS: i64 = 7;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    /// `$`: a git command that ran
    Command,
    /// `#`: the client's own operation
    Note,
}

/// One console entry
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub seq: u64,
    /// Timestamp in milliseconds
    pub time: i64,
    pub kind: EntryKind,
    /// The command (without the leading `$`) or the operation description (without `#`), already masked
    pub text: String,
    /// The command's output (stdout and stderr), masked and truncated
    pub output: Vec<String>,
    /// Number of output lines cut off
    #[serde(skip_serializing_if = "is_zero")]
    pub more: usize,
    /// The command succeeded; always true for operations
    pub ok: bool,
    /// Duration (ms)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

impl Entry {
    fn lines(&self) -> usize {
        1 + self.output.len() + usize::from(self.more > 0)
    }
}

pub type Sink = Arc<dyn Fn(&Entry) + Send + Sync>;

static SEQ: AtomicU64 = AtomicU64::new(0);
static SINK: RwLock<Option<Sink>> = RwLock::new(None);
static LOG_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

fn buffer() -> &'static Mutex<VecDeque<Entry>> {
    static B: OnceLock<Mutex<VecDeque<Entry>>> = OnceLock::new();
    B.get_or_init(Default::default)
}

/// Notify the UI about new entries
pub fn set_sink(s: Sink) {
    *SINK.write().unwrap() = Some(s);
}

/// Set the directory for local log files and delete log files older than 7 days
pub fn set_log_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let today = days(now_ms() / 1000);
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(date) = name.strip_prefix("strand-").and_then(|n| n.strip_suffix(".log")) else { continue };
            if let Some(d) = parse_date(date)
                && today - d >= LOG_KEEP_DAYS
            {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    *LOG_DIR.write().unwrap() = Some(dir);
}

/// The latest entries (oldest to newest), at most `limit`
pub fn tail(limit: usize) -> Vec<Entry> {
    let b = buffer().lock().unwrap();
    b.iter().skip(b.len().saturating_sub(limit)).cloned().collect()
}

/// Clear the console (log files are untouched)
pub fn clear() {
    buffer().lock().unwrap().clear();
}

/// Record one of the client's own operations (`#`)
pub fn note(text: &str) {
    push(EntryKind::Note, mask(text), Vec::new(), 0, true, None);
}

/// Record a git command. Queries are not recorded.
pub(crate) fn command(args: &[&str], stdout: &str, stderr: &str, ok: bool, took: Duration) {
    // Failed queries aren't recorded either: many are expected (e.g. asking for @{upstream} with no upstream)
    if is_query(args) {
        return;
    }
    let text = mask(&format!("git {}", args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ")));
    let mut out: Vec<String> = Vec::new();
    let mut progress: Option<String> = None;
    for line in stdout.lines().chain(stderr.lines()) {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        // Keep only the last progress (percentage) line of each run
        if is_progress(line) {
            let head = line.split(':').next().unwrap_or("");
            if let Some(p) = &progress
                && p.split(':').next().unwrap_or("") != head
            {
                out.push(p.clone());
            }
            progress = Some(line.to_string());
            continue;
        }
        if let Some(p) = progress.take() {
            out.push(p);
        }
        out.push(line.to_string());
    }
    if let Some(p) = progress {
        out.push(p);
    }
    let more = out.len().saturating_sub(MAX_OUTPUT);
    out.truncate(MAX_OUTPUT);
    let out = out.iter().map(|l| mask(l)).collect();
    push(EntryKind::Command, text, out, more, ok, Some(took.as_millis() as u64));
}

/// Timing: `let t = Timer::start(); ...; t.done(args, out, err, ok)`
pub(crate) struct Timer(Instant);

impl Timer {
    pub fn start() -> Self {
        Timer(Instant::now())
    }
    pub fn done(&self, args: &[&str], stdout: &str, stderr: &str, ok: bool) {
        command(args, stdout, stderr, ok, self.0.elapsed());
    }
}

fn push(kind: EntryKind, text: String, output: Vec<String>, more: usize, ok: bool, ms: Option<u64>) {
    let e = Entry { seq: SEQ.fetch_add(1, Ordering::SeqCst) + 1, time: now_ms(), kind, text, output, more, ok, ms };
    {
        let mut b = buffer().lock().unwrap();
        b.push_back(e.clone());
        let mut total: usize = b.iter().map(Entry::lines).sum();
        while total > MAX_LINES && b.len() > 1 {
            total -= b.pop_front().map(|x| x.lines()).unwrap_or(0);
        }
    }
    write_log(&e);
    let sink = SINK.read().ok().and_then(|s| s.clone());
    if let Some(s) = sink {
        s(&e);
    }
}

fn write_log(e: &Entry) {
    let Some(dir) = LOG_DIR.read().ok().and_then(|d| d.clone()) else { return };
    let secs = e.time / 1000;
    let (y, m, d) = civil(days(secs));
    let file = dir.join(format!("strand-{y:04}-{m:02}-{d:02}.log"));
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) else { return };
    let t = secs.rem_euclid(86_400);
    let stamp = format!("{:02}:{:02}:{:02}.{:03}Z", t / 3600, t / 60 % 60, t % 60, e.time.rem_euclid(1000));
    let head = match e.kind {
        EntryKind::Command => format!("{stamp} $ {}{}{}", e.text, if e.ok { "" } else { "  [失败]" }, e.ms.map(|m| format!("  ({m} ms)")).unwrap_or_default()),
        EntryKind::Note => format!("{stamp} # {}", e.text),
    };
    // One write: entries from several threads don't interleave
    let mut text = head + "\n";
    for l in &e.output {
        text += &format!("    {l}\n");
    }
    if e.more > 0 {
        text += &format!("    …（还有 {} 行）\n", e.more);
    }
    let _ = f.write_all(text.as_bytes());
}

/// Read-only commands that don't touch the network: not recorded in the console
fn is_query(args: &[&str]) -> bool {
    // Skip global options like `-c key=value` and `-C dir`
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        i += if matches!(args[i], "-c" | "-C") { 2 } else { 1 };
    }
    let Some(&cmd) = args.get(i) else { return true };
    let rest = &args[i + 1..];
    let has = |o: &str| rest.contains(&o);
    match cmd {
        "rev-parse" | "cherry" | "rev-list" | "cat-file" | "merge-base" | "for-each-ref" | "ls-files" | "ls-tree" | "show" | "log" | "diff" | "blame"
        | "status" | "symbolic-ref" | "var" | "version" | "check-ignore" | "check-attr" | "name-rev" | "describe" | "count-objects" | "format-patch"
        | "show-ref" | "check-ref-format" | "diff-tree" | "diff-index" | "diff-files" | "shortlog" | "grep" | "hash-object" | "credential" => true,
        // Only refreshes file status
        "update-index" => has("--refresh"),
        "config" => rest.iter().any(|a| matches!(*a, "--get" | "--get-all" | "--get-regexp" | "-l" | "--list")) || (rest.len() == 1 && !rest[0].starts_with('-')),
        "remote" => rest.is_empty() || has("-v") || has("get-url"),
        "branch" => rest.is_empty() || has("--show-current") || has("--list") || has("--contains") || has("--merged"),
        "tag" => rest.is_empty() || has("--list") || has("-l") || has("--contains"),
        "stash" => matches!(rest.first(), Some(&"list") | Some(&"show")),
        "worktree" => matches!(rest.first(), Some(&"list")),
        _ => false,
    }
}

fn is_progress(line: &str) -> bool {
    let l = line.trim_start_matches("remote:").trim();
    l.split_whitespace().any(|w| w.ends_with('%') && w[..w.len() - 1].parse::<u8>().is_ok())
}

/// Quote arguments with spaces or quotes so they can be copied into a terminal
fn quote(a: &str) -> String {
    if a.is_empty() {
        "''".into()
    } else if a.chars().any(|c| c.is_whitespace() || "'\"$`\\|&;<>()*?!".contains(c)) {
        format!("'{}'", a.replace('\'', "'\\''"))
    } else {
        a.to_string()
    }
}

/// Mask credentials
pub fn mask(text: &str) -> String {
    static RE: OnceLock<[(regex::Regex, &'static str); 3]> = OnceLock::new();
    let res = RE.get_or_init(|| {
        [
            // https://user:password@host → https://user:***@host; https://token@host → https://***@host
            (regex::Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)([^/@\s:]+):([^/@\s]+)@").unwrap(), "${1}${2}:***@"),
            (regex::Regex::new(r"(?i)(authorization:\s*\S+\s+|authorization:\s*)\S+").unwrap(), "${1}***"),
            (regex::Regex::new(r"(?i)\b(password|passwd|token|secret)=\S+").unwrap(), "${1}=***"),
        ]
    });
    let mut s = text.to_string();
    for (re, to) in res {
        s = re.replace_all(&s, *to).into_owned();
    }
    s
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn days(secs: i64) -> i64 {
    secs.div_euclid(86_400)
}

/// Days since 1970-01-01 → (year, month, day) (Howard Hinnant's algorithm)
fn civil(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// (year, month, day) → days since 1970-01-01
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_date(s: &str) -> Option<i64> {
    let mut it = s.split('-');
    let y = it.next()?.parse().ok()?;
    let m = it.next()?.parse().ok()?;
    let d = it.next()?.parse().ok()?;
    Some(days_from_civil(y, m, d))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_credentials() {
        assert_eq!(mask("git clone https://linxia:s3cret@example.com/r.git"), "git clone https://linxia:***@example.com/r.git");
        assert_eq!(mask("ssh://git@example.com/r.git"), "ssh://git@example.com/r.git");
        assert_eq!(mask("-c http.extraHeader=Authorization: Bearer abc123"), "-c http.extraHeader=Authorization: Bearer ***");
        assert_eq!(mask("password=hunter2 username=x"), "password=*** username=x");
    }

    #[test]
    fn query_commands_are_skipped() {
        assert!(is_query(&["rev-parse", "HEAD"]));
        assert!(is_query(&["-c", "core.quotepath=false", "diff", "HEAD"]));
        assert!(is_query(&["branch", "--show-current"]));
        assert!(is_query(&["update-index", "-q", "--refresh"]));
        assert!(is_query(&["config", "--get", "user.name"]));
        assert!(is_query(&["check-ref-format", "--branch", "x"]));
        assert!(!is_query(&["config", "user.name", "林夏"]));
        assert!(!is_query(&["commit", "-m", "x"]));
        assert!(!is_query(&["branch", "-D", "x"]));
        assert!(!is_query(&["fetch", "origin"]));
        assert!(!is_query(&["stash", "push"]));
    }

    #[test]
    fn dates_round_trip() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(days_from_civil(2026, 11, 13)), (2026, 11, 13));
        assert_eq!(parse_date("2024-02-29"), Some(days_from_civil(2024, 2, 29)));
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("HEAD~1"), "HEAD~1");
    }
}
