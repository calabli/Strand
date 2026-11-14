//! Applying patches (listed as out of scope in spec §17 originally, added later):
//! - `patch_preview`: which files the patch changes, whether it's mailbox format from `git format-patch` (with commit messages), and whether it applies cleanly;
//! - `patch_apply`: apply to the worktree (`git apply --3way`, entering "restore in progress" conflict resolution on conflicts),
//!   or create commits from mailbox format (`git am --3way`, rolled back entirely on failure, leaving the repository unchanged).

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::model::FileStatus;
use crate::repo::Session;
use crate::stash::{overwrite_error, refresh_index, Unstash, UnstashSource};

#[derive(Debug, Clone, Serialize)]
pub struct PatchFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub added: u32,
    pub deleted: u32,
    pub binary: bool,
}

/// One commit in a mailbox-format patch
#[derive(Debug, Clone, Serialize)]
pub struct PatchCommit {
    pub title: String,
    pub author: String,
}

/// Whether it applies
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PatchFit {
    /// Applies cleanly
    Clean,
    /// Needs a three-way apply (the files have changed), may conflict
    ThreeWay,
    /// Doesn't apply
    Fails,
}

#[derive(Debug, Clone, Serialize)]
pub struct PatchPreview {
    pub files: Vec<PatchFile>,
    /// Commits for mailbox format (git format-patch), in patch order; empty for a plain diff
    pub commits: Vec<PatchCommit>,
    pub fit: PatchFit,
    /// The reason git gives when it doesn't apply (the first error line)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Session {
    fn patch_tmp(&self, text: &str) -> Result<String> {
        let dir = self.strand_dir()?;
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::git("保存补丁失败", e))?;
        let f = dir.join("apply.patch");
        std::fs::write(&f, text).map_err(|e| CoreError::git("保存补丁失败", e))?;
        Ok(f.to_string_lossy().to_string())
    }

    /// Look at a patch: which files it changes, whether it carries commits, whether it applies (repository unchanged)
    pub fn patch_preview(&self, text: &str) -> Result<PatchPreview> {
        if !text.contains("diff --git ") && !text.contains("\n--- ") && !text.starts_with("--- ") {
            return Err(CoreError::new(ErrorCode::InvalidRange, "这不是一个补丁：里面没有找到文件改动（diff）"));
        }
        let f = self.patch_tmp(text)?;
        let numstat = git_cli::run(self.path(), &["apply", "--numstat", "-z", &f], None)
            .map_err(|e| CoreError::new(ErrorCode::InvalidRange, "补丁格式不对，读不出来").with_detail(e.detail.unwrap_or_default()))?;
        let summary = git_cli::run(self.path(), &["apply", "--summary", &f], None).unwrap_or_default();
        let files = parse_numstat(&numstat, &summary);
        if files.is_empty() {
            return Err(CoreError::new(ErrorCode::InvalidRange, "这不是一个补丁：里面没有找到文件改动（diff）"));
        }
        refresh_index(self.path());
        let (fit, reason) = if git_cli::run(self.path(), &["apply", "--check", "--binary", &f], None).is_ok() {
            (PatchFit::Clean, None)
        } else {
            match git_cli::run(self.path(), &["apply", "--check", "--3way", "--binary", &f], None) {
                Ok(_) => (PatchFit::ThreeWay, None),
                Err(e) => (PatchFit::Fails, Some(first_error(&e))),
            }
        };
        Ok(PatchPreview { files, commits: mail_commits(text), fit, reason })
    }

    /// Apply a patch. With `commit` true, create commits from mailbox format (git am) and return how many; otherwise apply to the worktree and return 0.
    pub fn patch_apply(&self, text: &str, commit: bool) -> Result<usize> {
        self.require_clean_state()?;
        let f = self.patch_tmp(text)?;
        refresh_index(self.path());
        if commit {
            let n = mail_commits(text).len();
            if n == 0 {
                return Err(CoreError::new(ErrorCode::InvalidRange, "这个补丁不带提交说明（不是 git format-patch 生成的），只能应用到工作区"));
            }
            return match git_cli::run(self.path(), &["am", "--3way", "--keep-cr", &f], None) {
                Ok(_) => Ok(n),
                Err(e) => {
                    let _ = git_cli::run(self.path(), &["am", "--abort"], None);
                    Err(CoreError::new(ErrorCode::GitFailed, "补丁没法直接生成提交（和现在的代码对不上），仓库没有改动。可以改成应用到工作区，解决冲突后再提交")
                        .with_detail(e.detail.unwrap_or_default()))
                }
            };
        }
        match git_cli::run(self.path(), &["apply", "--3way", "--binary", &f], None) {
            Ok(_) => Ok(0),
            Err(err) => {
                if self.index_has_conflicts() {
                    self.set_unstash(&Unstash { source: UnstashSource::Patch, id: String::new(), label: "补丁".into(), drop: false, remainder: None })?;
                    return Err(CoreError::new(ErrorCode::Conflicts, "补丁和现在的代码有冲突，请逐个处理"));
                }
                Err(overwrite_error(err))
            }
        }
    }
}

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

impl Session {
    /// Cherry-pick or revert only some files of a commit (like JetBrains' Apply / Revert Selected Changes):
    /// apply these files' changes from the commit to the worktree (in reverse for revert), without creating a commit; the user reviews and commits.
    /// When they don't match the current code, apply three-way, entering conflict resolution on conflicts (same as applying a patch).
    pub fn commit_files_apply(&self, id: &str, paths: &[String], revert: bool) -> Result<()> {
        self.require_clean_state()?;
        if paths.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "至少选一个文件"));
        }
        let dir = self.path();
        let commit = git_cli::run(dir, &["rev-parse", "--verify", "-q", &format!("{id}^{{commit}}")], None)
            .map_err(|_| CoreError::new(ErrorCode::NotFound, "提交不存在，日志可能已经变化"))?
            .trim()
            .to_string();
        let parent = git_cli::run(dir, &["rev-parse", "--verify", "-q", &format!("{commit}^")], None).map(|s| s.trim().to_string()).unwrap_or_else(|_| EMPTY_TREE.to_string());
        let (a, b) = if revert { (commit.as_str(), parent.as_str()) } else { (parent.as_str(), commit.as_str()) };
        let f = self.strand_dir()?.join("apply.patch");
        std::fs::create_dir_all(self.strand_dir()?).map_err(|e| CoreError::git("准备改动失败", e))?;
        let out = format!("--output={}", f.to_string_lossy());
        let mut args = vec!["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-renames", out.as_str(), a, b, "--"];
        args.extend(paths.iter().map(String::as_str));
        git_cli::run(dir, &args, None)?;
        if std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0) == 0 {
            return Err(CoreError::new(ErrorCode::NothingSelected, "这几个文件在这个提交里没有改动"));
        }
        refresh_index(dir);
        let fs = f.to_string_lossy().to_string();
        match git_cli::run(dir, &["apply", "--3way", "--binary", &fs], None) {
            Ok(_) => Ok(()),
            Err(err) => {
                if self.index_has_conflicts() {
                    let label = if revert { "还原的改动" } else { "拣选的改动" };
                    self.set_unstash(&Unstash { source: UnstashSource::Patch, id: String::new(), label: label.into(), drop: false, remainder: None })?;
                    return Err(CoreError::new(ErrorCode::Conflicts, "这些改动和现在的代码有冲突，请逐个处理"));
                }
                let stderr = err.detail.as_ref().and_then(|d| d.get("stderr")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                if stderr.contains("does not apply") || stderr.contains("does not exist") || stderr.contains("already exists") {
                    let msg = if revert { "这些文件后来又改过，没法直接还原（工作区没有改动）。可以先看看这个提交之后的修改" } else { "这些文件和现在的代码对不上，没法应用（工作区没有改动）" };
                    return Err(CoreError::new(ErrorCode::GitFailed, msg).with_detail(err.detail.unwrap_or_default()));
                }
                Err(overwrite_error(err))
            }
        }
    }

    /// Replace a worktree file with its content at a revision (like JetBrains' Get from Revision).
    /// When the file doesn't exist at that revision (added later), delete it from the worktree. The result is an ordinary change that can be discarded or undone.
    pub fn file_restore(&self, id: &str, path: &str) -> Result<()> {
        let dir = self.path();
        crate::file_history::check_rel_path(path)?;
        let exists = git_cli::run(dir, &["cat-file", "-e", &format!("{id}:{path}")], None).is_ok();
        if exists {
            git_cli::run(dir, &["restore", &format!("--source={id}"), "--worktree", "--", path], None)?;
        } else {
            git_cli::run(dir, &["rev-parse", "--verify", "-q", &format!("{id}^{{commit}}")], None).map_err(|_| CoreError::new(ErrorCode::NotFound, "提交不存在，日志可能已经变化"))?;
            let full = dir.join(path);
            if full.exists() {
                std::fs::remove_file(&full).map_err(|e| CoreError::git("删除文件失败", e))?;
            }
        }
        Ok(())
    }
}

/// Combine `git apply --numstat -z` with `--summary` creates and deletes into a file list
fn parse_numstat(numstat: &str, summary: &str) -> Vec<PatchFile> {
    let mut created = Vec::new();
    let mut deleted = Vec::new();
    for l in summary.lines() {
        let l = l.trim();
        if let Some(r) = l.strip_prefix("create mode ") {
            created.push(r.split_once(' ').map(|x| x.1).unwrap_or("").to_string());
        } else if let Some(r) = l.strip_prefix("delete mode ") {
            deleted.push(r.split_once(' ').map(|x| x.1).unwrap_or("").to_string());
        }
    }
    let parts: Vec<&str> = numstat.split('\0').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let rec = parts[i];
        i += 1;
        let mut it = rec.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (it.next(), it.next(), it.next()) else { continue };
        let binary = a == "-";
        let (added, del) = (a.parse().unwrap_or(0), d.parse().unwrap_or(0));
        if path.is_empty() {
            // Rename: the next two parts are the old and new paths
            let old = parts.get(i).copied().unwrap_or("").to_string();
            let new = parts.get(i + 1).copied().unwrap_or("").to_string();
            i += 2;
            out.push(PatchFile { path: new, old_path: Some(old), status: FileStatus::R, added, deleted: del, binary });
        } else {
            let status = if created.iter().any(|c| c == path) {
                FileStatus::A
            } else if deleted.iter().any(|c| c == path) {
                FileStatus::D
            } else {
                FileStatus::M
            };
            out.push(PatchFile { path: path.to_string(), old_path: None, status, added, deleted: del, binary });
        }
    }
    out
}

/// Commits in a mailbox-format patch: each mail starts with `From <40-char hash> `; the title comes from Subject ([PATCH n/m] removed, folded lines joined), the author from From
pub fn mail_commits(text: &str) -> Vec<PatchCommit> {
    let mut out: Vec<PatchCommit> = Vec::new();
    let mut in_head = false;
    let mut subject: Option<String> = None;
    let mut author = String::new();
    let mut last_subject = false;
    let flush = |out: &mut Vec<PatchCommit>, subject: &mut Option<String>, author: &mut String| {
        if let Some(s) = subject.take() {
            out.push(PatchCommit { title: s, author: std::mem::take(author) });
        }
    };
    for line in text.lines() {
        let is_from = line.len() > 46 && line.starts_with("From ") && line[5..45].bytes().all(|b| b.is_ascii_hexdigit()) && line.as_bytes()[45] == b' ';
        if is_from {
            flush(&mut out, &mut subject, &mut author);
            in_head = true;
            subject = Some(String::new());
            continue;
        }
        if !in_head {
            continue;
        }
        if line.is_empty() {
            in_head = false;
            continue;
        }
        if let Some(s) = line.strip_prefix("Subject: ") {
            let s = s.trim();
            let s = if s.starts_with("[PATCH") { s.split_once("] ").map(|x| x.1).unwrap_or(s) } else { s };
            subject = Some(s.to_string());
            last_subject = true;
            continue;
        }
        if last_subject && line.starts_with([' ', '\t']) {
            if let Some(s) = subject.as_mut() {
                s.push(' ');
                s.push_str(line.trim());
            }
            continue;
        }
        last_subject = false;
        if let Some(a) = line.strip_prefix("From: ") {
            author = a.split_once(" <").map(|x| x.0).unwrap_or(a).trim().trim_matches('"').to_string();
        }
    }
    flush(&mut out, &mut subject, &mut author);
    for c in &mut out {
        c.title = decode_words(&c.title);
        c.author = decode_words(&c.author).trim_matches('"').to_string();
        // The [PATCH n/m] prefix is only recognizable after decoding
        if c.title.starts_with("[PATCH") {
            if let Some((_, t)) = c.title.split_once("] ") {
                c.title = t.to_string();
            }
        }
    }
    out
}

/// Decode RFC 2047 encoded words in mail headers (=?UTF-8?q?...?= / =?UTF-8?b?...?=), dropping whitespace between adjacent encoded words
fn decode_words(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    let mut prev_encoded = false;
    while let Some(start) = rest.find("=?") {
        let (before, after) = rest.split_at(start);
        let parsed = (|| {
            let body = &after[2..];
            let (_charset, body) = body.split_once('?')?;
            let (enc, body) = body.split_once('?')?;
            let end = body.find("?=")?;
            let data = &body[..end];
            let bytes = match enc {
                "q" | "Q" => decode_q(data),
                "b" | "B" => decode_b64(data)?,
                _ => return None,
            };
            Some((String::from_utf8_lossy(&bytes).into_owned(), 2 + after[2..].len() - body.len() + end + 2))
        })();
        match parsed {
            Some((text, used)) => {
                if !(prev_encoded && before.trim().is_empty()) {
                    out.push_str(before);
                }
                out.push_str(&text);
                rest = &after[used..];
                prev_encoded = true;
            }
            None => {
                out.push_str(before);
                out.push_str("=?");
                rest = &after[2..];
                prev_encoded = false;
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_q(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'=' && i + 3 <= b.len())
            .then(|| std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()))
            .flatten();
        match (b[i], hex) {
            (_, Some(v)) => {
                out.push(v);
                i += 3;
            }
            (b'_', _) => {
                out.push(b' ');
                i += 1;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn decode_b64(s: &str) -> Option<Vec<u8>> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let v = T.iter().position(|&t| t == c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn first_error(e: &CoreError) -> String {
    let text = e.detail.as_ref().and_then(|d| d.get("stderr").and_then(|s| s.as_str()).map(str::to_string)).unwrap_or_else(|| e.detail.as_ref().map(|d| d.to_string()).unwrap_or_default());
    text.lines().find(|l| l.starts_with("error:")).map(|l| l.trim_start_matches("error:").trim().to_string()).unwrap_or_else(|| e.message.clone())
}
