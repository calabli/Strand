//! Blame (spec §10.2): which commit last changed each line of a file.
//!
//! Calls `git blame --porcelain`, paged by line number: the first screen first and the rest in the background, so even large files show their start quickly.
//! With `rev` empty it blames the file in the worktree, and uncommitted lines count as "not committed yet".

use std::collections::HashMap;

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::{git_cli, Session};

/// The commit id git blame uses for uncommitted lines
const UNCOMMITTED: &str = "0000000000000000000000000000000000000000";

#[derive(Debug, Clone, Serialize)]
pub struct BlameLine {
    /// 1-based line number
    pub no: u32,
    pub text: String,
    /// Index into `commits`
    pub commit: u32,
    /// The line's number in that commit's version of the file (to follow it into the previous revision)
    pub orig: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlameCommit {
    pub id: String,
    pub title: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    /// In the current log (clicking jumps there); rewritten commits aren't
    pub in_log: bool,
    /// Uncommitted changes
    pub uncommitted: bool,
    /// The revision before this commit for this file (its parent) and the file's path there; absent when the commit added the file
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlamePage {
    /// Total number of lines in the file
    pub total: u32,
    pub offset: u32,
    pub lines: Vec<BlameLine>,
    /// Commits used by this page
    pub commits: Vec<BlameCommit>,
}

impl Session {
    /// Blame `limit` lines starting at line offset+1. `rev` empty means the file in the worktree.
    pub fn blame_file(&self, path: &str, rev: Option<&str>, offset: u32, limit: u32) -> Result<BlamePage> {
        let total = self.file_line_count(path, rev)?;
        if total == 0 || offset >= total {
            return Ok(BlamePage { total, offset, lines: Vec::new(), commits: Vec::new() });
        }
        let end = (offset + limit.max(1)).min(total);
        let range = format!("{},{}", offset + 1, end);
        let mut args = vec!["blame", "--porcelain", "-L", range.as_str()];
        if let Some(r) = rev {
            args.push(r);
        }
        args.push("--");
        args.push(path);
        let out = git_cli::run(self.path(), &args, None)?;
        let (lines, ids) = parse(&out);
        let prev = parse_previous(&out);
        let repo = self.git2()?;
        let commits = ids
            .iter()
            .map(|id| {
                if id == UNCOMMITTED {
                    return BlameCommit {
                        id: id.clone(),
                        title: String::new(),
                        body: String::new(),
                        author: String::new(),
                        email: String::new(),
                        time: 0,
                        in_log: false,
                        uncommitted: true,
                        previous: None,
                        previous_path: None,
                    };
                }
                let c = git2::Oid::from_str(id).ok().and_then(|o| repo.find_commit(o).ok());
                let in_log = gix::ObjectId::from_hex(id.as_bytes()).ok().is_some_and(|o| self.index.contains_key(&o));
                let (previous, previous_path) = prev.get(id).cloned().map_or((None, None), |(r, p)| (Some(r), Some(p)));
                match c {
                    Some(c) => BlameCommit {
                        id: id.clone(),
                        title: c.summary().ok().flatten().unwrap_or("").to_string(),
                        body: c.body().ok().flatten().unwrap_or("").trim().to_string(),
                        author: c.author().name().unwrap_or("").to_string(),
                        email: c.author().email().unwrap_or("").to_string(),
                        time: c.author().when().seconds(),
                        in_log,
                        uncommitted: false,
                        previous,
                        previous_path,
                    },
                    None => BlameCommit { id: id.clone(), title: String::new(), body: String::new(), author: String::new(), email: String::new(), time: 0, in_log, uncommitted: false, previous, previous_path },
                }
            })
            .collect();
        Ok(BlamePage { total, offset, lines, commits })
    }

    /// Number of lines of the file at a revision (or in the worktree)
    fn file_line_count(&self, path: &str, rev: Option<&str>) -> Result<u32> {
        let bytes = match rev {
            None => std::fs::read(self.path().join(path)).map_err(|_| CoreError::new(ErrorCode::NotFound, format!("找不到文件 {path}")))?,
            Some(r) => {
                let repo = self.git2()?;
                let gone = || CoreError::new(ErrorCode::NotFound, format!("{r} 里没有文件 {path}"));
                let tree = repo.revparse_single(r).and_then(|o| o.peel_to_tree()).map_err(|_| gone())?;
                let entry = tree.get_path(std::path::Path::new(path)).map_err(|_| gone())?;
                let blob = repo.find_blob(entry.id()).map_err(|_| gone())?;
                if blob.is_binary() {
                    return Err(CoreError::new(ErrorCode::InvalidRange, format!("{path} 是二进制文件，不能逐行追溯")));
                }
                blob.content().to_vec()
            }
        };
        if bytes.contains(&0) {
            return Err(CoreError::new(ErrorCode::InvalidRange, format!("{path} 是二进制文件，不能逐行追溯")));
        }
        let n = bytes.iter().filter(|&&b| b == b'\n').count() + usize::from(!bytes.is_empty() && !bytes.ends_with(b"\n"));
        Ok(n as u32)
    }
}

/// Parse `git blame --porcelain`: each section starts with "commit-id orig-line final-line [count]",
/// followed by the commit's info the first time it appears, and the last line is the content starting with a tab.
pub(crate) fn parse(out: &str) -> (Vec<BlameLine>, Vec<String>) {
    let mut ids: Vec<String> = Vec::new();
    let mut pos: HashMap<String, u32> = HashMap::new();
    let mut lines = Vec::new();
    let mut cur: Option<(u32, u32, u32)> = None; // (commit index, final line, original line)
    for l in out.lines() {
        if let Some(text) = l.strip_prefix('\t') {
            if let Some((commit, no, orig)) = cur.take() {
                lines.push(BlameLine { no, text: text.trim_end_matches('\r').to_string(), commit, orig });
            }
            continue;
        }
        let mut parts = l.split(' ');
        let first = parts.next().unwrap_or("");
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            let orig: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let no: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let next = ids.len() as u32;
            let p = *pos.entry(first.to_string()).or_insert_with(|| {
                ids.push(first.to_string());
                next
            });
            cur = Some((p, no, orig));
        }
    }
    (lines, ids)
}

/// The "previous <id> <path>" header of each commit in `git blame --porcelain`: the parent revision and the file's path there
fn parse_previous(out: &str) -> HashMap<String, (String, String)> {
    let mut map = HashMap::new();
    let mut commit: Option<&str> = None;
    for l in out.lines() {
        if l.starts_with('\t') {
            continue;
        }
        let first = l.split(' ').next().unwrap_or("");
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            commit = Some(first);
        } else if let (Some(rest), Some(c)) = (l.strip_prefix("previous "), commit)
            && let Some((id, path)) = rest.split_once(' ')
        {
            map.insert(c.to_string(), (id.to_string(), path.to_string()));
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let out = format!("{a} 1 1 2\nauthor 林夏\nsummary 第一\nfilename f\n\t一\n{a} 2 2\n\t二\n{b} 3 3 1\nauthor 周\nfilename f\n\t三\n");
        let (lines, ids) = parse(&out);
        assert_eq!(ids, [a, b]);
        assert_eq!(lines.iter().map(|l| (l.no, l.text.as_str(), l.commit)).collect::<Vec<_>>(), [(1, "一", 0), (2, "二", 0), (3, "三", 1)]);
    }
}
