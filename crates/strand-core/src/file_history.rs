//! 项目文件浏览和文件修改链：
//! - `project_files`：项目里的文件（已跟踪的，加上没被忽略的未跟踪文件），给左侧的目录树；
//! - `file_text`：某个文件现在（工作区）或某个版本时的内容；
//! - `file_history`：改过这个文件的提交，从新到旧，跟着重命名往前找（`git log --follow`）；
//! - `file_diff_versions`：同一个文件两个版本之间的差异，两边的路径可以不同（中间改过名），新的一边可以是工作区。

use serde::Serialize;

use crate::diff;
use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::model::{Author, Commit, FileDiff, FileStatus};
use crate::repo::Session;

/// 文件内容最多读这么多字节，超过的截断
const MAX_BYTES: usize = 4 << 20;
/// 修改链最多列这么多个版本
pub const MAX_VERSIONS: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct FileText {
    pub path: String,
    /// 文字内容；二进制文件或不存在时没有
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub binary: bool,
    /// 这个版本（或工作区）里没有这个文件
    pub missing: bool,
    /// 字节数
    pub size: u64,
    /// 太大，只读了前面一部分
    pub truncated: bool,
}

/// 修改链里的一个版本
#[derive(Debug, Clone, Serialize)]
pub struct FileVersion {
    pub commit: Commit,
    /// 这个提交里文件的路径
    pub path: String,
    /// 这个提交把文件从哪个路径改名过来
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub added: u32,
    pub deleted: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileHistory {
    /// 从新到旧
    pub versions: Vec<FileVersion>,
    /// 超过 MAX_VERSIONS，更早的没有列出
    pub truncated: bool,
}

impl Session {
    /// 项目里的文件，按路径排序：已跟踪的，加上没被 .gitignore 忽略的未跟踪文件
    pub fn project_files(&self) -> Result<Vec<String>> {
        let out = git_cli::run(self.path(), &["ls-files", "-z", "--cached", "--others", "--exclude-standard"], None)?;
        let mut list: Vec<String> = out.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect();
        list.sort();
        list.dedup();
        Ok(list)
    }

    /// 文件内容：`rev` 为空时读工作区里的，否则读这个版本（哈希、分支名都行）里的
    pub fn file_text(&self, path: &str, rev: Option<&str>) -> Result<FileText> {
        let repo = self.git2()?;
        let data = self.content(&repo, path, rev)?;
        let Some(mut data) = data else {
            return Ok(FileText { path: path.to_string(), text: None, binary: false, missing: true, size: 0, truncated: false });
        };
        let size = data.len() as u64;
        let binary = data.iter().take(8000).any(|&b| b == 0);
        let truncated = data.len() > MAX_BYTES;
        if truncated {
            data.truncate(MAX_BYTES);
        }
        let text = (!binary).then(|| String::from_utf8_lossy(&data).into_owned());
        Ok(FileText { path: path.to_string(), text, binary, missing: false, size, truncated })
    }

    /// 改过这个文件的提交（从当前 HEAD 往前），跟着重命名找到最早的版本
    pub fn file_history(&self, path: &str) -> Result<FileHistory> {
        let mut h = history_at(self.path(), path)?;
        self.fill_versions(&mut h);
        Ok(h)
    }

    /// 在日志里的提交换成完整的（带引用和未推送标记）
    pub fn fill_versions(&self, h: &mut FileHistory) {
        for v in &mut h.versions {
            if let Ok(c) = self.find_logged(&v.commit.id) {
                v.commit = c;
            }
        }
    }

    /// 同一个文件两个版本之间的差异。`from` 为空表示旧的一边没有这个文件（新增）；`to` 为空表示新的一边是工作区。
    /// 两边的路径可以不同（中间改过名）。
    pub fn file_diff_versions(&self, from: Option<&str>, from_path: &str, to: Option<&str>, to_path: &str) -> Result<FileDiff> {
        let repo = self.git2()?;
        let old = match from {
            Some(rev) => self.content(&repo, from_path, Some(rev))?,
            None => None,
        };
        let new = self.content(&repo, to_path, to)?;
        let (old, new) = (old.unwrap_or_default(), new.unwrap_or_default());
        let binary = old.iter().take(8000).any(|&b| b == 0) || new.iter().take(8000).any(|&b| b == 0);
        if binary {
            return Ok(FileDiff { path: to_path.to_string(), binary: true, hunks: Vec::new(), truncated: false });
        }
        let mut opts = git2::DiffOptions::new();
        opts.context_lines(3);
        let mut patch = git2::Patch::from_buffers(&old, Some(std::path::Path::new(from_path)), &new, Some(std::path::Path::new(to_path)), Some(&mut opts))
            .map_err(|e| CoreError::git("计算差异失败", e))?;
        let buf = patch.to_buf().map_err(|e| CoreError::git("计算差异失败", e))?;
        if buf.is_empty() {
            return Ok(FileDiff { path: to_path.to_string(), binary: false, hunks: Vec::new(), truncated: false });
        }
        let d = git2::Diff::from_buffer(&buf).map_err(|e| CoreError::git("计算差异失败", e))?;
        let mut fd = diff::first_file(&d, to_path)?;
        fd.path = to_path.to_string();
        Ok(fd)
    }

    /// 文件在某个版本（或工作区）里的内容；没有这个文件时返回 None
    fn content(&self, repo: &git2::Repository, path: &str, rev: Option<&str>) -> Result<Option<Vec<u8>>> {
        let Some(rev) = rev else {
            let full = self.path().join(path);
            return Ok(if full.is_file() { Some(std::fs::read(&full).map_err(|e| CoreError::git("读取文件失败", e))?) } else { None });
        };
        let commit = repo
            .revparse_single(rev)
            .and_then(|o| o.peel_to_commit())
            .map_err(|_| CoreError::new(ErrorCode::NotFound, format!("找不到 {rev}")))?;
        let tree = commit.tree().map_err(|e| CoreError::git("读取提交内容失败", e))?;
        let Ok(entry) = tree.get_path(std::path::Path::new(path)) else { return Ok(None) };
        match entry.to_object(repo).ok().and_then(|o| o.into_blob().ok()) {
            Some(b) => Ok(Some(b.content().to_vec())),
            None => Ok(None),
        }
    }
}

/// 修改链里费时的部分（`git log --follow` 要翻全部历史），不需要 Session：命令层在后台跑它，不占着仓库，
/// 跑完再用 [`Session::fill_versions`] 补上引用
pub fn history_at(dir: &std::path::Path, path: &str) -> Result<FileHistory> {
    let max = format!("--max-count={}", MAX_VERSIONS + 1);
    let out = git_cli::run(
        dir,
        &["log", "--follow", "-M", &max, "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s", "--raw", "--numstat", "-z", "HEAD", "--", path],
        None,
    )
    .or_else(|e| {
        // 还没有提交的仓库：没有历史
        if git2::Repository::open(dir).is_ok_and(|r| r.head().is_err()) { Ok(String::new()) } else { Err(e) }
    })?;
    let mut versions = parse_history(&out);
    let truncated = versions.len() > MAX_VERSIONS;
    versions.truncate(MAX_VERSIONS);
    Ok(FileHistory { versions, truncated })
}

/// 解析 `git log --format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s --raw --numstat -z` 的输出
pub fn parse_history(out: &str) -> Vec<FileVersion> {
    let mut list = Vec::new();
    for rec in out.split('\x1e').filter(|r| !r.trim().is_empty()) {
        let (head, rest) = rec.split_once('\0').unwrap_or((rec, ""));
        let f: Vec<&str> = head.split('\x1f').collect();
        if f.len() < 6 {
            continue;
        }
        let parents: Vec<String> = f[1].split_whitespace().map(str::to_string).collect();
        let commit = Commit {
            id: f[0].to_string(),
            is_merge: parents.len() > 1,
            parents,
            title: f[5].to_string(),
            body: String::new(),
            author: Author { name: f[2].to_string(), email: f[3].to_string() },
            time: f[4].parse().unwrap_or(0),
            refs: Vec::new(),
            unpushed: false,
        };
        let mut v = FileVersion { commit, path: String::new(), old_path: None, status: FileStatus::M, added: 0, deleted: 0, binary: false };
        let toks: Vec<&str> = rest.split('\0').collect();
        let mut i = 0;
        let mut seen_raw = false;
        let mut seen_num = false;
        while i < toks.len() {
            let tok = toks[i].trim_start_matches('\n');
            i += 1;
            if tok.is_empty() {
                continue;
            }
            if let Some(raw) = tok.strip_prefix(':') {
                // ":100644 100644 abc def M" 后面跟路径；改名、复制（R100、C75）跟两个路径
                let st = raw.split_whitespace().last().unwrap_or("M");
                let two = st.starts_with('R') || st.starts_with('C');
                let (a, b) = if two { (toks.get(i).copied(), toks.get(i + 1).copied()) } else { (None, toks.get(i).copied()) };
                i += if two { 2 } else { 1 };
                if !seen_raw {
                    seen_raw = true;
                    v.path = b.unwrap_or("").to_string();
                    v.old_path = a.map(str::to_string);
                    v.status = match st.as_bytes()[0] {
                        b'A' => FileStatus::A,
                        b'D' => FileStatus::D,
                        b'R' => FileStatus::R,
                        b'C' => FileStatus::A,
                        b'T' => FileStatus::T,
                        _ => FileStatus::M,
                    };
                }
            } else if tok.contains('\t') {
                // "增\t删\t路径"；改名时路径为空，后面跟旧路径和新路径
                let mut p = tok.splitn(3, '\t');
                let (a, d, path) = (p.next().unwrap_or(""), p.next().unwrap_or(""), p.next().unwrap_or(""));
                if path.is_empty() {
                    i += 2;
                }
                if !seen_num {
                    seen_num = true;
                    v.binary = a == "-";
                    v.added = a.parse().unwrap_or(0);
                    v.deleted = d.parse().unwrap_or(0);
                }
            }
        }
        list.push(v);
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rename_modify_and_add() {
        let out = "\x1eaaa\x1fbbb\x1f林夏\x1fl@x.cn\x1f100\x1f改名 b\0\n:100644 100644 a7 a7 R100\0src/a.txt\0src/b.txt\0\
                   0\t0\t\0src/a.txt\0src/b.txt\0\
                   \x1ebbb\x1fccc\x1f林夏\x1fl@x.cn\x1f90\x1f改 a\0\n:100644 100644 de a7 M\0src/a.txt\0\
                   2\t1\tsrc/a.txt\0\
                   \x1eccc\x1f\x1f周\x1fz@x.cn\x1f80\x1f加 a\0\n:000000 100644 00 de A\0src/a.txt\0-\t-\tsrc/a.txt\0";
        let v = parse_history(out);
        assert_eq!(v.len(), 3);
        assert_eq!((v[0].status, v[0].path.as_str(), v[0].old_path.as_deref()), (FileStatus::R, "src/b.txt", Some("src/a.txt")));
        assert_eq!((v[1].status, v[1].added, v[1].deleted), (FileStatus::M, 2, 1));
        assert_eq!((v[2].status, v[2].binary, v[2].commit.parents.len()), (FileStatus::A, true, 0));
        assert_eq!(v[2].commit.author.name, "周");
    }
}
