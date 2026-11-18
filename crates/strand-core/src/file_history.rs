//! Browsing project files and a file's change chain:
//! - `project_files`: files in the project (tracked, plus untracked files that aren't ignored), for the tree on the left;
//! - `file_text`: a file's content now (worktree) or at a revision;
//! - `file_history`: commits that changed the file, newest first, following renames (`git log --follow`);
//! - `file_diff_versions`: the diff between two versions of one file; the two paths may differ (renamed in between), and the newer side may be the worktree.

use serde::Serialize;

use crate::diff;
use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::model::{Author, Commit, FileDiff, FileStatus};
use crate::repo::Session;

/// Read at most this many bytes of file content; truncate beyond
const MAX_BYTES: usize = 4 << 20;
/// List at most this many versions in the change chain
pub const MAX_VERSIONS: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct FileText {
    pub path: String,
    /// Text content; absent for binary or missing files
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub binary: bool,
    /// The file doesn't exist at this revision (or in the worktree)
    pub missing: bool,
    /// Size in bytes
    pub size: u64,
    /// Too large, only the beginning was read
    pub truncated: bool,
    /// A Git LFS file whose content hasn't been downloaded: the pointer's object (text is the pointer itself)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lfs_missing: Option<crate::lfs::Pointer>,
}

/// One version in the change chain
#[derive(Debug, Clone, Serialize)]
pub struct FileVersion {
    pub commit: Commit,
    /// The file's path in this commit
    pub path: String,
    /// The path this commit renamed the file from
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub added: u32,
    pub deleted: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileHistory {
    /// Newest first
    pub versions: Vec<FileVersion>,
    /// Over MAX_VERSIONS, older ones aren't listed
    pub truncated: bool,
}

impl Session {
    /// Project files sorted by path: tracked, plus untracked files not ignored by .gitignore
    pub fn project_files(&self) -> Result<Vec<String>> {
        // -t tags each entry; "S " marks files a sparse checkout leaves out (not on disk), which aren't listed
        let out = git_cli::run(self.path(), &["ls-files", "-z", "-t", "--cached", "--others", "--exclude-standard"], None)?;
        let mut list: Vec<String> = out
            .split('\0')
            .filter(|e| e.len() > 2 && !e.starts_with("S "))
            .map(|e| e[2..].to_string())
            .collect();
        list.sort();
        list.dedup();
        Ok(list)
    }

    /// File content: from the worktree when `rev` is empty, otherwise from that revision (hash or branch name)
    pub fn file_text(&self, path: &str, rev: Option<&str>) -> Result<FileText> {
        let repo = self.git2()?;
        let data = self.content(&repo, path, rev)?;
        let Some(mut data) = data else {
            return Ok(FileText { path: path.to_string(), text: None, binary: false, missing: true, size: 0, truncated: false, lfs_missing: None });
        };
        let lfs_missing = match crate::lfs::resolve(&repo, std::mem::take(&mut data)) {
            crate::lfs::Content::Real(d) => {
                data = d;
                None
            }
            crate::lfs::Content::Missing(p, d) => {
                data = d;
                Some(p)
            }
        };
        let size = data.len() as u64;
        let binary = data.iter().take(8000).any(|&b| b == 0);
        let truncated = data.len() > MAX_BYTES;
        if truncated {
            data.truncate(MAX_BYTES);
        }
        let text = (!binary).then(|| String::from_utf8_lossy(&data).into_owned());
        Ok(FileText { path: path.to_string(), text, binary, missing: false, size, truncated, lfs_missing })
    }

    /// Commits that changed this file (back from the current HEAD), following renames to the earliest version
    pub fn file_history(&self, path: &str) -> Result<FileHistory> {
        let mut h = history_at(self.path(), path)?;
        self.fill_versions(&mut h);
        Ok(h)
    }

    /// Replace commits that are in the log with full ones (with refs and unpushed markers)
    pub fn fill_versions(&self, h: &mut FileHistory) {
        for v in &mut h.versions {
            if let Ok(c) = self.find_logged(&v.commit.id) {
                v.commit = c;
            }
        }
    }

    /// The diff between two versions of the same file. `from` empty means the old side doesn't have the file (added); `to` empty means the new side is the worktree.
    /// The two paths may differ (renamed in between).
    pub fn file_diff_versions(&self, from: Option<&str>, from_path: &str, to: Option<&str>, to_path: &str) -> Result<FileDiff> {
        self.file_diff_versions_ctx(from, from_path, to, to_path, 3)
    }

    /// Same as [`Session::file_diff_versions`], with the number of context lines
    pub fn file_diff_versions_ctx(&self, from: Option<&str>, from_path: &str, to: Option<&str>, to_path: &str, context: u32) -> Result<FileDiff> {
        let repo = self.git2()?;
        let old = match from {
            Some(rev) => self.content(&repo, from_path, Some(rev))?,
            None => None,
        };
        let new = self.content(&repo, to_path, to)?;
        let (old, new) = (old.unwrap_or_default(), new.unwrap_or_default());
        let (old, new) = (crate::lfs::resolve_bytes(&repo, old), crate::lfs::resolve_bytes(&repo, new));
        let binary = old.iter().take(8000).any(|&b| b == 0) || new.iter().take(8000).any(|&b| b == 0);
        if binary {
            return Ok(FileDiff { path: to_path.to_string(), binary: true, hunks: Vec::new(), truncated: false, lfs: false });
        }
        let mut opts = git2::DiffOptions::new();
        opts.context_lines(context);
        let mut patch = git2::Patch::from_buffers(&old, Some(std::path::Path::new(from_path)), &new, Some(std::path::Path::new(to_path)), Some(&mut opts))
            .map_err(|e| CoreError::git("计算差异失败", e))?;
        let buf = patch.to_buf().map_err(|e| CoreError::git("计算差异失败", e))?;
        if buf.is_empty() {
            return Ok(FileDiff { path: to_path.to_string(), binary: false, hunks: Vec::new(), truncated: false, lfs: false });
        }
        let d = git2::Diff::from_buffer(&buf).map_err(|e| CoreError::git("计算差异失败", e))?;
        let mut fd = diff::first_file(&d, to_path)?;
        fd.path = to_path.to_string();
        Ok(fd)
    }

    /// Save a file in the worktree (after editing directly in the diff).
    /// `expected` is the content read when editing started: if the file on disk was changed elsewhere, don't overwrite it (STATE_DIVERGED) so others' changes aren't lost.
    /// When the original file uses CRLF, the saved content is converted to CRLF too (the editor normalizes line endings to LF).
    /// Only existing regular files in the repository can be written; the path can't escape the repository or point into .git.
    pub fn save_worktree_file(&self, path: &str, text: &str, expected: &str) -> Result<()> {
        check_rel_path(path)?;
        let rel = std::path::Path::new(path);
        let full = self.path().join(rel);
        let meta = std::fs::symlink_metadata(&full).map_err(|_| CoreError::new(ErrorCode::NotFound, format!("工作区里没有这个文件：{path}")))?;
        if !meta.is_file() {
            return Err(CoreError::new(ErrorCode::InvalidName, format!("不能保存这个路径：{path}")));
        }
        let now = std::fs::read(&full).map_err(|e| CoreError::git("读取文件失败", e))?;
        if now != expected.as_bytes() {
            return Err(CoreError::new(ErrorCode::StateDiverged, "文件在别处被改过了，重新打开再编辑"));
        }
        let out = if expected.contains("\r\n") && !text.contains("\r\n") { text.replace('\n', "\r\n") } else { text.to_string() };
        std::fs::write(&full, out).map_err(|e| CoreError::git("写入文件失败", e))
    }

    /// A file's content at a revision (or in the worktree); None when the file doesn't exist
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

/// The slow part of the change chain (`git log --follow` walks the whole history); needs no Session: the command layer runs it in the background without holding the repository,
/// then fills in refs with [`Session::fill_versions`]
pub fn history_at(dir: &std::path::Path, path: &str) -> Result<FileHistory> {
    let max = format!("--max-count={}", MAX_VERSIONS + 1);
    let out = git_cli::run(
        dir,
        &["log", "--follow", "-M", &max, "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s", "--raw", "--numstat", "-z", "HEAD", "--", path],
        None,
    )
    .or_else(|e| {
        // A repository with no commits yet: no history
        if git2::Repository::open(dir).is_ok_and(|r| r.head().is_err()) { Ok(String::new()) } else { Err(e) }
    })?;
    let mut versions = parse_history(&out);
    let truncated = versions.len() > MAX_VERSIONS;
    versions.truncate(MAX_VERSIONS);
    Ok(FileHistory { versions, truncated })
}

/// Parse the output of `git log --format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s --raw --numstat -z`
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
                // ":100644 100644 abc def M" is followed by a path; renames and copies (R100, C75) by two paths
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
                // "added\tdeleted\tpath"; for renames the path is empty, followed by the old and new paths
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

/// A relative path in the worktree: not empty, not absolute, no `..`, and not inside .git
pub(crate) fn check_rel_path(path: &str) -> Result<()> {
    let rel = std::path::Path::new(path);
    let bad = path.is_empty()
        || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
        || rel.components().next().is_some_and(|c| c.as_os_str().eq_ignore_ascii_case(".git"));
    if bad {
        return Err(CoreError::new(ErrorCode::InvalidName, format!("不能保存这个路径：{path}")));
    }
    Ok(())
}

impl Session {
    /// The full path of a file in the worktree, for revealing it in the file manager or opening it with the default
    /// application. `path` must stay inside the worktree (not absolute, no `..`, not in .git) and exist.
    pub fn worktree_file(&self, path: &str) -> Result<std::path::PathBuf> {
        check_rel_path(path)?;
        let full = self.path().join(path);
        if !full.exists() {
            return Err(CoreError::new(ErrorCode::NotFound, format!("工作区里没有这个文件：{path}")));
        }
        Ok(full)
    }

    /// A file's raw bytes at a revision (for image diffs); `rev` empty means the worktree. Fails when over 30 MB or the file doesn't exist at this revision
    pub fn file_bytes(&self, path: &str, rev: Option<&str>) -> Result<Vec<u8>> {
        let data = self.file_bytes_raw(path, rev)?;
        // A Git LFS pointer: show the downloaded content (an image, usually)
        Ok(if crate::lfs::parse_pointer(&data).is_some() { crate::lfs::resolve_bytes(&self.git2()?, data) } else { data })
    }

    fn file_bytes_raw(&self, path: &str, rev: Option<&str>) -> Result<Vec<u8>> {
        check_rel_path(path)?;
        const MAX: usize = 30 << 20;
        let too_big = || CoreError::new(ErrorCode::InvalidRange, "文件太大（超过 30 MB），不显示");
        match rev {
            None => {
                let full = self.path().join(path);
                let meta = std::fs::metadata(&full).map_err(|_| CoreError::new(ErrorCode::NotFound, format!("工作区里没有这个文件：{path}")))?;
                if meta.len() as usize > MAX {
                    return Err(too_big());
                }
                std::fs::read(&full).map_err(|e| CoreError::git("读取文件失败", e))
            }
            // The sides in the index during a conflict: ":1" common ancestor, ":2" current branch (ours), ":3" the one being merged in (theirs)
            Some(r @ (":1" | ":2" | ":3")) => {
                let repo = self.git2()?;
                let stage: i32 = r[1..].parse().unwrap_or(2);
                let idx = repo.index().map_err(|e| CoreError::git("读取索引失败", e))?;
                let e = idx.get_path(std::path::Path::new(path), stage).ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("这一方没有 {path}")))?;
                let blob = repo.find_blob(e.id).map_err(|_| CoreError::new(ErrorCode::NotFound, format!("这一方没有 {path}")))?;
                if blob.size() > MAX {
                    return Err(too_big());
                }
                Ok(blob.content().to_vec())
            }
            Some(r) => {
                let repo = self.git2()?;
                let obj = repo.revparse_single(&format!("{r}:{path}")).map_err(|_| CoreError::new(ErrorCode::NotFound, format!("这个版本里没有 {path}")))?;
                let blob = obj.peel_to_blob().map_err(|_| CoreError::new(ErrorCode::NotFound, format!("这个版本里没有 {path}")))?;
                if blob.size() > MAX {
                    return Err(too_big());
                }
                Ok(blob.content().to_vec())
            }
        }
    }
}

/// File types that run something when opened with their default application (apps, scripts, installers):
/// "open with default application" reveals these in the file manager instead of opening them
pub fn runs_when_opened(path: &str) -> bool {
    const EXT: &[&str] = &[
        "app", "command", "tool", "terminal", "workflow", "pkg", "mpkg", "scpt", "applescript", // macOS
        "exe", "bat", "cmd", "com", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msc", "lnk", "scr", "hta", "reg", "cpl", // Windows
        "sh", "bash", "zsh", "desktop", "jar",
    ];
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.rsplit_once('.').is_some_and(|(_, ext)| EXT.iter().any(|e| ext.eq_ignore_ascii_case(e)))
}
