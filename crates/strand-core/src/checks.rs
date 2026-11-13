//! 提交前格式化和检查（说明书 4.4、4.6）。
//!
//! 配置按仓库保存在仓库自己的 Git 配置里（`.git/config`），命令行也能改：
//!
//! | 键 | 含义 | 默认 |
//! | --- | --- | --- |
//! | `strand.formatCommand` | 格式化命令 | 空（不格式化） |
//! | `strand.checkCommand` | 检查命令 | 空（不检查） |
//! | `strand.formatOnCommit` | 提交前格式化 | 关 |
//! | `strand.checkOnCommit` | 提交前运行检查 | 开 |
//!
//! 读取时也认全局配置（`git config --global strand.checkCommand …` 对所有仓库生效），写入只写仓库配置。
//!
//! 命令用系统 shell 在仓库根目录运行（macOS 上是 `sh -c`，Windows 上是 `cmd /C`）。
//! 要提交的文件通过两种方式传给命令：命令里的 `{files}` 换成加了引号、用空格隔开的路径；
//! 环境变量 `STRAND_FILES` 是按换行分隔的路径。退出码为 0 算通过。
//! 检查失败时从输出里认出“文件:行:列: 说明”这类问题，认不出的只显示原始输出。

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::remote::Cancel;

/// 输出最多保留这么多字节
const MAX_OUTPUT: usize = 64 * 1024;
/// 最多认出这么多个问题
const MAX_ISSUES: usize = 200;
/// 命令最多运行这么久
const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ChecksConfig {
    pub format_command: String,
    pub check_command: String,
    pub format_on_commit: bool,
    pub check_on_commit: bool,
}

/// 读取配置时一并给出的建议命令（按仓库里有哪些文件推测），界面上作为占位提示
#[derive(Debug, Clone, Default, Serialize)]
pub struct ChecksInfo {
    #[serde(flatten)]
    pub config: ChecksConfig,
    pub suggest_format: Vec<String>,
    pub suggest_check: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    Format,
    Check,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CheckIssue {
    pub path: String,
    pub line: Option<u32>,
    pub col: Option<u32>,
    /// 级别：error、warning 或空
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckRun {
    pub kind: CheckKind,
    pub command: String,
    pub ok: bool,
    /// 退出码；超时或被取消时为空
    pub code: Option<i32>,
    /// 标准输出和标准错误（去掉颜色控制符），超出 64 KB 的部分截掉
    pub output: String,
    pub truncated: bool,
    pub timed_out: bool,
    pub issues: Vec<CheckIssue>,
    pub ms: u64,
    /// 格式化：内容被改动的文件（只看传进来的文件）
    pub changed: Vec<String>,
}

fn get(dir: &Path, key: &str) -> Option<String> {
    git_cli::run(dir, &["config", "--get", key], None).ok().map(|s| s.trim_end_matches(['\n', '\r']).to_string())
}

fn get_bool(dir: &Path, key: &str, default: bool) -> bool {
    git_cli::run(dir, &["config", "--type=bool", "--get", key], None)
        .ok()
        .map(|s| s.trim() == "true")
        .unwrap_or(default)
}

pub fn config(dir: &Path) -> ChecksInfo {
    let config = ChecksConfig {
        format_command: get(dir, "strand.formatCommand").unwrap_or_default(),
        check_command: get(dir, "strand.checkCommand").unwrap_or_default(),
        format_on_commit: get_bool(dir, "strand.formatOnCommit", false),
        check_on_commit: get_bool(dir, "strand.checkOnCommit", true),
    };
    let (suggest_format, suggest_check) = suggest(dir);
    ChecksInfo { config, suggest_format, suggest_check }
}

pub fn set_config(dir: &Path, c: &ChecksConfig) -> Result<()> {
    for (key, val) in [("strand.formatCommand", c.format_command.trim()), ("strand.checkCommand", c.check_command.trim())] {
        if val.is_empty() {
            // 没有这个键时 --unset 返回 5，忽略
            let _ = git_cli::run(dir, &["config", "--local", "--unset-all", key], None);
        } else {
            if val.contains('\n') {
                return Err(CoreError::new(ErrorCode::InvalidName, "命令只能写一行"));
            }
            git_cli::run(dir, &["config", "--local", key, val], None)?;
        }
    }
    git_cli::run(dir, &["config", "--local", "strand.formatOnCommit", if c.format_on_commit { "true" } else { "false" }], None)?;
    git_cli::run(dir, &["config", "--local", "strand.checkOnCommit", if c.check_on_commit { "true" } else { "false" }], None)?;
    Ok(())
}

/// 按仓库里的文件推测常用命令
fn suggest(dir: &Path) -> (Vec<String>, Vec<String>) {
    let mut f = Vec::new();
    let mut c = Vec::new();
    let has = |p: &str| dir.join(p).exists();
    if has(".pre-commit-config.yaml") {
        c.push("pre-commit run --files {files}".to_string());
    }
    if let Ok(pkg) = std::fs::read_to_string(dir.join("package.json")) {
        let pm = if has("pnpm-lock.yaml") {
            "pnpm"
        } else if has("yarn.lock") {
            "yarn"
        } else if has("bun.lockb") || has("bun.lock") {
            "bun"
        } else {
            "npm"
        };
        let scripts = serde_json::from_str::<serde_json::Value>(&pkg).ok().and_then(|v| v.get("scripts").cloned());
        let script = |name: &str| scripts.as_ref().and_then(|s| s.get(name)).is_some();
        for s in ["format", "fmt", "prettier"] {
            if script(s) {
                f.push(format!("{pm} run {s}"));
            }
        }
        for s in ["lint", "check", "typecheck"] {
            if script(s) {
                c.push(format!("{pm} run {s}"));
            }
        }
    }
    if has("Cargo.toml") {
        f.push("cargo fmt".to_string());
        c.push("cargo clippy --quiet".to_string());
    }
    if has("go.mod") {
        f.push("gofmt -w .".to_string());
        c.push("go vet ./...".to_string());
    }
    if std::fs::read_to_string(dir.join("pyproject.toml")).map(|s| s.contains("ruff")).unwrap_or(false) {
        f.push("ruff format {files}".to_string());
        c.push("ruff check {files}".to_string());
    }
    (f, c)
}

/// 给 shell 用的引号
fn quote(p: &str) -> String {
    if cfg!(windows) {
        format!("\"{}\"", p.replace('"', "\"\""))
    } else {
        format!("'{}'", p.replace('\'', "'\\''"))
    }
}

/// 运行一次格式化或检查。`files` 是要提交的文件（相对仓库根目录）。
pub fn run(dir: &Path, kind: CheckKind, command: &str, files: &[String], cancel: &Cancel) -> Result<CheckRun> {
    let command = command.trim();
    if command.is_empty() {
        return Err(CoreError::new(ErrorCode::NotFound, "还没有设置要运行的命令"));
    }
    let line = command.replace("{files}", &files.iter().map(|f| quote(f)).collect::<Vec<_>>().join(" "));
    // 格式化前记下文件内容，结束后比较
    let before: HashMap<&String, Option<Vec<u8>>> =
        if kind == CheckKind::Format { files.iter().map(|f| (f, std::fs::read(dir.join(f)).ok())).collect() } else { HashMap::new() };

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&line);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&line);
        c
    };
    cmd.current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("STRAND_FILES", files.join("\n"))
        .env("STRAND_KIND", if kind == CheckKind::Format { "format" } else { "check" })
        // 有些工具看到终端以外的输出就不加颜色；再明确说一次
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    git_cli::hide_console(&mut cmd);

    let start = Instant::now();
    let mut child = cmd.spawn().map_err(|e| CoreError::git("没能运行命令", e))?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let read_out = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut b);
        }
        b
    });
    let read_err = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut b);
        }
        b
    });

    let mut timed_out = false;
    let status = loop {
        if let Some(st) = child.try_wait().map_err(|e| CoreError::git("等待命令结束失败", e))? {
            break Some(st);
        }
        if cancel.is_cancelled() || start.elapsed() > TIMEOUT {
            timed_out = !cancel.is_cancelled();
            kill_tree(&mut child);
            break None;
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    // 被取消时子进程可能还拿着管道（sh 启动的孙进程），读线程不一定能结束，不等它们
    let (mut raw, truncated) = if status.is_some() {
        let mut raw = read_out.join().unwrap_or_default();
        let err = read_err.join().unwrap_or_default();
        if !raw.is_empty() && !err.is_empty() && !raw.ends_with(b"\n") {
            raw.push(b'\n');
        }
        raw.extend(err);
        let t = raw.len() > MAX_OUTPUT;
        (raw, t)
    } else {
        (Vec::new(), false)
    };
    if cancel.is_cancelled() {
        return Err(CoreError::new(ErrorCode::Cancelled, "已取消"));
    }
    raw.truncate(MAX_OUTPUT);
    let output = strip_ansi(&String::from_utf8_lossy(&raw));
    let issues = if status.as_ref().map(|s| s.success()).unwrap_or(false) && kind == CheckKind::Format {
        Vec::new()
    } else {
        parse_issues(dir, &output)
    };
    let changed = before
        .into_iter()
        .filter(|(f, b)| std::fs::read(dir.join(f)).ok() != *b)
        .map(|(f, _)| f.clone())
        .collect::<Vec<_>>();
    let mut changed = changed;
    changed.sort();
    Ok(CheckRun {
        kind,
        command: command.to_string(),
        ok: status.as_ref().map(|s| s.success()).unwrap_or(false),
        code: status.and_then(|s| s.code()),
        output,
        truncated,
        timed_out,
        issues,
        ms: start.elapsed().as_millis() as u64,
        changed,
    })
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // sh -c 起的命令可能又起了子进程；先杀直接子进程，孙进程失去管道后通常会自己退出
        let _ = Command::new("pkill").args(["-TERM", "-P", &child.id().to_string()]).status();
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/T", "/F", "/PID", &child.id().to_string()]);
        git_cli::hide_console(&mut c);
        let _ = c.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn strip_ansi(s: &str) -> String {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07").unwrap()).replace_all(s, "").replace('\r', "")
}

/// 从输出里认出问题。认这几种常见格式：
/// - `path:line:col: message`、`path:line: message`、`path(line,col): message`（gcc、tsc、eslint unix、ruff、go vet 等）
/// - rustc / clippy：`error[E0425]: message` 后面一行 `--> path:line:col`
/// - eslint 默认格式：单独一行文件路径，下面若干行 `  line:col  error  message`
///
/// 只保留路径确实在仓库里的，避免把普通输出当成问题。
pub fn parse_issues(dir: &Path, output: &str) -> Vec<CheckIssue> {
    static RES: std::sync::OnceLock<[Regex; 4]> = std::sync::OnceLock::new();
    let [colon, paren, arrow, stylish] = RES.get_or_init(|| {
        [
            Regex::new(r"^\s*([^\s:(][^:(]*?):(\d+)(?::(\d+))?:?\s*(?:-\s*)?(.*)$").unwrap(),
            Regex::new(r"^\s*([^\s(][^(]*?)\((\d+),(\d+)\):\s*(.*)$").unwrap(),
            Regex::new(r"^\s*-->\s*(.+?):(\d+):(\d+)\s*$").unwrap(),
            Regex::new(r"^\s+(\d+):(\d+)\s+(error|warning|warn|info)\s+(.*?)\s*$").unwrap(),
        ]
    });
    let root = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    let rel = |p: &str| -> Option<String> {
        let p = p.trim().trim_start_matches("./");
        if p.is_empty() || p.len() > 400 {
            return None;
        }
        let path = Path::new(p);
        let abs = if path.is_absolute() { path.to_path_buf() } else { root.join(path) };
        if !abs.is_file() {
            return None;
        }
        let abs = abs.canonicalize().ok()?;
        abs.strip_prefix(&root).ok().map(|r| r.to_string_lossy().replace('\\', "/"))
    };
    let level_of = |m: &str| -> (String, String) {
        let l = m.trim_start().to_lowercase();
        for lv in ["error", "warning", "warn"] {
            if l.starts_with(lv) {
                let rest = m.trim_start()[lv.len()..].trim_start_matches(|c: char| c == ':' || c == ' ').to_string();
                let lv = if lv == "warn" { "warning" } else { lv };
                return (lv.to_string(), if rest.is_empty() { m.trim().to_string() } else { rest });
            }
        }
        (String::new(), m.trim().to_string())
    };

    let output = strip_ansi(output);
    let mut out = Vec::new();
    let mut last_head: Option<String> = None; // rustc 的 “error: …” 一行
    let mut cur_file: Option<String> = None; // eslint 默认格式的当前文件
    for line in output.lines() {
        if out.len() >= MAX_ISSUES {
            break;
        }
        if let Some(m) = arrow.captures(line) {
            if let Some(path) = rel(&m[1]) {
                let (level, message) = level_of(last_head.as_deref().unwrap_or(""));
                out.push(CheckIssue { path, line: m[2].parse().ok(), col: m[3].parse().ok(), level, message });
            }
            last_head = None;
            continue;
        }
        let t = line.trim_start();
        if t.starts_with("error") || t.starts_with("warning") {
            last_head = Some(t.to_string());
        }
        if let Some(m) = stylish.captures(line) {
            if let Some(f) = &cur_file {
                let lv = if &m[3] == "warn" { "warning" } else { &m[3] };
                out.push(CheckIssue { path: f.clone(), line: m[1].parse().ok(), col: m[2].parse().ok(), level: lv.to_string(), message: m[4].to_string() });
                continue;
            }
        }
        if let Some(m) = paren.captures(line).or_else(|| colon.captures(line)) {
            if let Some(path) = rel(&m[1]) {
                let (level, message) = level_of(&m[4]);
                out.push(CheckIssue { path, line: m[2].parse().ok(), col: m.get(3).and_then(|c| c.as_str().parse().ok()), level, message });
                continue;
            }
        }
        // 单独一行路径：eslint 默认格式的文件标题
        if !line.starts_with(char::is_whitespace) {
            cur_file = rel(line);
        }
    }
    out
}
