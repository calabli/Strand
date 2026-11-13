//! 控制台（说明书 5.8）和本地日志文件（说明书 15）。
//!
//! 核心层执行的 git 命令按时间顺序记在这里：`$` 一条是命令（后面跟输出），`#` 一条是客户端自己的操作
//! （如搁置、撤销），没有直接对应的 git 命令。界面通过 `set_sink` 收到新的条目，打开时用 `tail` 取最近的。
//!
//! - 只记会改动仓库或访问网络的命令；查询类命令（rev-parse、cherry、diff、log 等）不记，
//!   否则每次刷新分支列表都会冒出几十行，有用的内容很快被挤掉。
//! - 每条命令最多留 `MAX_OUTPUT` 行输出；网络命令的进度行（百分比）只留最后一行。
//! - 一共保留最近 `MAX_LINES` 行（命令和输出都算），可以清空。不随撤销回退。
//! - 命令和输出里的凭据打码：地址里的密码、`Authorization:` 后面的内容、`password=` 后面的内容。
//!
//! 同样的内容也追加到本地日志文件（`set_log_dir` 设置目录，每天一个文件，保留 7 天，不上传）。

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
    /// `$`：执行的 git 命令
    Command,
    /// `#`：客户端自己的操作
    Note,
}

/// 控制台里的一条
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub seq: u64,
    /// 毫秒时间戳
    pub time: i64,
    pub kind: EntryKind,
    /// 命令（不含开头的 `$`）或操作说明（不含 `#`），已经打码
    pub text: String,
    /// 命令的输出（标准输出和标准错误），已经打码、截断
    pub output: Vec<String>,
    /// 截掉的输出行数
    #[serde(skip_serializing_if = "is_zero")]
    pub more: usize,
    /// 命令成功；操作说明总是 true
    pub ok: bool,
    /// 用时（毫秒）
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

/// 有新条目时通知界面
pub fn set_sink(s: Sink) {
    *SINK.write().unwrap() = Some(s);
}

/// 设置本地日志文件的目录，并删掉 7 天以前的日志文件
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

/// 最近的条目（从旧到新），最多 `limit` 条
pub fn tail(limit: usize) -> Vec<Entry> {
    let b = buffer().lock().unwrap();
    b.iter().skip(b.len().saturating_sub(limit)).cloned().collect()
}

/// 清空控制台（日志文件不动）
pub fn clear() {
    buffer().lock().unwrap().clear();
}

/// 记一条客户端自己的操作（`#`）
pub fn note(text: &str) {
    push(EntryKind::Note, mask(text), Vec::new(), 0, true, None);
}

/// 记一条 git 命令。查询类命令不记。
pub(crate) fn command(args: &[&str], stdout: &str, stderr: &str, ok: bool, took: Duration) {
    // 查询类命令失败也不记：很多是预期内的（如没有跟踪分支时问 @{upstream}）
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
        // 进度行（百分比）只留每一段的最后一行
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

/// 运行计时：`let t = Timer::start(); ...; t.done(args, out, err, ok)`
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
    // 一次写入：几个线程同时记的时候各条不会交错
    let mut text = head + "\n";
    for l in &e.output {
        text += &format!("    {l}\n");
    }
    if e.more > 0 {
        text += &format!("    …（还有 {} 行）\n", e.more);
    }
    let _ = f.write_all(text.as_bytes());
}

/// 只读、不访问网络的命令：不记进控制台
fn is_query(args: &[&str]) -> bool {
    // 跳过 `-c key=value`、`-C dir` 这类全局选项
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
        // 只刷新文件状态
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

/// 带空格或引号的参数加引号，方便复制到终端
fn quote(a: &str) -> String {
    if a.is_empty() {
        "''".into()
    } else if a.chars().any(|c| c.is_whitespace() || "'\"$`\\|&;<>()*?!".contains(c)) {
        format!("'{}'", a.replace('\'', "'\\''"))
    } else {
        a.to_string()
    }
}

/// 凭据打码
pub fn mask(text: &str) -> String {
    static RE: OnceLock<[(regex::Regex, &'static str); 3]> = OnceLock::new();
    let res = RE.get_or_init(|| {
        [
            // https://user:password@host → https://user:***@host；https://token@host → https://***@host
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

/// 1970-01-01 起的天数 → (年, 月, 日)（Howard Hinnant 的算法）
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

/// (年, 月, 日) → 1970-01-01 起的天数
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
