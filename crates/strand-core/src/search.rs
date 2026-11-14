//! Searching by content:
//! - `commit_change_matches`: when searching the log by changes, which files in the selected commit have matching changed lines (the commit detail lists only those and the diff highlights them);
//! - `project_search`: full-text search in project files (`git grep`), in the worktree (including untracked files not ignored) or at a revision.

use std::path::Path;

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::repo::Session;

/// Maximum matches a project search returns; maximum per file
pub const MAX_HITS: usize = 2000;
pub const MAX_PER_FILE: usize = 100;
/// When a line is too long, keep only this many characters around the match
const MAX_LINE: usize = 300;

/// A file in a commit whose changed lines match
#[derive(Debug, Clone, Serialize)]
pub struct ChangeMatch {
    pub path: String,
    /// Number of matching changed lines (added plus deleted)
    pub lines: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchFile {
    pub path: String,
    pub hits: Vec<SearchHit>,
    /// This file has more than MAX_PER_FILE matches; the rest aren't listed
    pub more: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectSearch {
    pub files: Vec<SearchFile>,
    /// Total matches (listed)
    pub total: usize,
    /// Over MAX_HITS, not all listed
    pub truncated: bool,
}

/// Turn search text into a regex (prefixing (?i) when case-insensitive); INVALID_REGEX when invalid
pub fn search_regex(text: &str, regex: bool, case_sensitive: bool) -> Result<regex::Regex> {
    let p = if regex { text.to_string() } else { regex::escape(text) };
    regex::RegexBuilder::new(&p)
        .case_insensitive(!case_sensitive)
        .size_limit(1 << 22)
        .build()
        .map_err(|e| CoreError::new(ErrorCode::InvalidRegex, "正则表达式写得不对").with_detail(serde_json::json!({ "source": e.to_string() })))
}

impl Session {
    /// Files in this commit (relative to its first parent) whose changed lines (added or deleted) match, sorted by path
    pub fn commit_change_matches(&self, id: &str, text: &str, regex: bool, case_sensitive: bool) -> Result<Vec<ChangeMatch>> {
        let re = search_regex(text, regex, case_sensitive)?;
        let repo = self.git2()?;
        let oid = git2::Oid::from_str(id).map_err(|_| CoreError::new(ErrorCode::NotFound, "提交不存在"))?;
        let c = repo.find_commit(oid).map_err(|_| CoreError::new(ErrorCode::NotFound, "提交不存在"))?;
        let tree = c.tree().map_err(|e| CoreError::git("读取提交内容失败", e))?;
        let parent = c.parent(0).ok().and_then(|p| p.tree().ok());
        let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), None).map_err(|e| CoreError::git("读取提交差异失败", e))?;
        let mut out: Vec<ChangeMatch> = Vec::new();
        diff.foreach(
            &mut |_, _| true,
            None,
            None,
            Some(&mut |delta, _hunk, line| {
                if matches!(line.origin(), '+' | '-') && re.is_match(&String::from_utf8_lossy(line.content())) {
                    let path = delta.new_file().path().or(delta.old_file().path()).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                    match out.last_mut() {
                        Some(m) if m.path == path => m.lines += 1,
                        _ => out.push(ChangeMatch { path, lines: 1 }),
                    }
                }
                true
            }),
        )
        .map_err(|e| CoreError::git("读取提交差异失败", e))?;
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }
}

/// Full-text search in project files (`git grep`). With `rev` empty, search the worktree (tracked plus untracked files not ignored), otherwise that revision.
/// Binary files are skipped. Needs no Session: the command layer runs it in the background without holding the repository.
pub fn project_search(dir: &Path, text: &str, regex: bool, case_sensitive: bool, rev: Option<&str>) -> Result<ProjectSearch> {
    if text.is_empty() {
        return Ok(ProjectSearch { files: Vec::new(), total: 0, truncated: false });
    }
    // Check with Rust's regex first so an invalid one gets a consistent message (git's -P syntax is mostly the same)
    let re = search_regex(text, regex, case_sensitive)?;
    let mut args: Vec<&str> = vec!["grep", "-n", "-z", "-I", "--no-color", "--full-name"];
    if !case_sensitive {
        args.push("-i");
    }
    args.push(if regex { "-P" } else { "-F" });
    args.push("-e");
    args.push(text);
    match rev {
        Some(r) => args.push(r),
        None => args.push("--untracked"),
    }
    let mut out = grep(dir, &args)?;
    if out.is_none() && regex {
        // Fall back to -E (POSIX extended regex) when -P isn't available (git built without PCRE)
        let alt: Vec<&str> = args.iter().map(|a| if *a == "-P" { "-E" } else { a }).collect();
        out = grep(dir, &alt)?;
    }
    let out = out.unwrap_or_default();
    let prefix = rev.map(|r| format!("{r}:"));
    let mut files: Vec<SearchFile> = Vec::new();
    let mut total = 0;
    let mut truncated = false;
    for rec in out.split('\n').filter(|r| !r.is_empty()) {
        let mut parts = rec.splitn(3, '\0');
        let (Some(path), Some(line), Some(body)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let path = prefix.as_deref().and_then(|p| path.strip_prefix(p)).unwrap_or(path);
        let Ok(line) = line.parse::<u32>() else { continue };
        if total >= MAX_HITS {
            truncated = true;
            break;
        }
        let f = match files.last_mut() {
            Some(f) if f.path == path => f,
            _ => {
                files.push(SearchFile { path: path.to_string(), hits: Vec::new(), more: false });
                files.last_mut().expect("刚放进去")
            }
        };
        if f.hits.len() >= MAX_PER_FILE {
            f.more = true;
            continue;
        }
        f.hits.push(SearchHit { line, text: clip(body.trim_end_matches('\r'), &re) });
        total += 1;
    }
    Ok(ProjectSearch { files, total, truncated })
}

/// Run git grep once: output on matches, empty string with no matches; None when `-P` isn't supported
fn grep(dir: &Path, args: &[&str]) -> Result<Option<String>> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(dir).stdin(std::process::Stdio::null()).env("GIT_NO_LAZY_FETCH", "1");
    git_cli::hide_console(&mut cmd);
    let o = cmd.output().map_err(|e| CoreError::new(ErrorCode::GitMissing, "没有找到 Git，请先安装").with_detail(serde_json::json!({ "source": e.to_string() })))?;
    match o.status.code() {
        Some(0) => Ok(Some(String::from_utf8_lossy(&o.stdout).into_owned())),
        // No matches
        Some(1) => Ok(Some(String::new())),
        _ => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if args.contains(&"-P") && (err.contains("PCRE") || err.contains("perl")) {
                return Ok(None);
            }
            Err(CoreError::new(ErrorCode::GitFailed, "搜索失败").with_detail(serde_json::json!({ "stderr": err })))
        }
    }
}

/// Keep only a stretch around the match on very long lines
fn clip(line: &str, re: &regex::Regex) -> String {
    if line.chars().count() <= MAX_LINE {
        return line.to_string();
    }
    let at = re.find(line).map(|m| m.start()).unwrap_or(0);
    let start = line[..at].char_indices().rev().nth(MAX_LINE / 3).map(|(i, _)| i).unwrap_or(0);
    let s: String = line[start..].chars().take(MAX_LINE).collect();
    format!("{}{s}…", if start > 0 { "…" } else { "" })
}
