//! 逐行追溯（说明书 10.2）：文件每一行最后是被哪个提交改的。
//!
//! 调用 `git blame --porcelain`，按行号分页：先取首屏，其余在后台再取，大文件也能很快看到开头。
//! `rev` 为空时追溯工作区里的文件，还没提交的行算作“还没提交”。

use std::collections::HashMap;

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::{git_cli, Session};

/// 还没提交的行在 git blame 里的提交编号
const UNCOMMITTED: &str = "0000000000000000000000000000000000000000";

#[derive(Debug, Clone, Serialize)]
pub struct BlameLine {
    /// 从 1 开始的行号
    pub no: u32,
    pub text: String,
    /// 在 `commits` 里的位置
    pub commit: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlameCommit {
    pub id: String,
    pub title: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    /// 在当前日志里（点它可以跳过去）；被整理掉的提交不在
    pub in_log: bool,
    /// 还没提交的改动
    pub uncommitted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlamePage {
    /// 文件总行数
    pub total: u32,
    pub offset: u32,
    pub lines: Vec<BlameLine>,
    /// 这一页用到的提交
    pub commits: Vec<BlameCommit>,
}

impl Session {
    /// 追溯文件第 offset+1 行起的 limit 行。`rev` 为空表示工作区里的文件。
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
                    };
                }
                let c = git2::Oid::from_str(id).ok().and_then(|o| repo.find_commit(o).ok());
                let in_log = gix::ObjectId::from_hex(id.as_bytes()).ok().is_some_and(|o| self.index.contains_key(&o));
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
                    },
                    None => BlameCommit { id: id.clone(), title: String::new(), body: String::new(), author: String::new(), email: String::new(), time: 0, in_log, uncommitted: false },
                }
            })
            .collect();
        Ok(BlamePage { total, offset, lines, commits })
    }

    /// 文件在某个版本（或工作区）里的行数
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

/// 解析 `git blame --porcelain`：每段以“提交编号 原行号 现行号 [行数]”开头，
/// 这个提交第一次出现时跟着它的信息，最后一行是以制表符开头的内容。
pub(crate) fn parse(out: &str) -> (Vec<BlameLine>, Vec<String>) {
    let mut ids: Vec<String> = Vec::new();
    let mut pos: HashMap<String, u32> = HashMap::new();
    let mut lines = Vec::new();
    let mut cur: Option<(u32, u32)> = None; // (提交位置, 现行号)
    for l in out.lines() {
        if let Some(text) = l.strip_prefix('\t') {
            if let Some((commit, no)) = cur.take() {
                lines.push(BlameLine { no, text: text.trim_end_matches('\r').to_string(), commit });
            }
            continue;
        }
        let mut parts = l.split(' ');
        let first = parts.next().unwrap_or("");
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            let no: u32 = parts.nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
            let next = ids.len() as u32;
            let p = *pos.entry(first.to_string()).or_insert_with(|| {
                ids.push(first.to_string());
                next
            });
            cur = Some((p, no));
        }
    }
    (lines, ids)
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
