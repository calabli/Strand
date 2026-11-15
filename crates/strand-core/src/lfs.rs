//! Git LFS: files tracked by LFS are stored in Git as small pointer files; the real content sits in `.git/lfs/objects`.
//!
//! Strand reads contents with libgit2, which doesn't run the LFS filter, so diffs and file views would show the pointer
//! text (or, with git-lfs installed, compare a pointer with the real file in the worktree). Here pointers are swapped for
//! the real content when it has been downloaded; when it hasn't, callers say so and offer to download it (`git lfs pull`,
//! which needs the git-lfs program).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::remote::{Cancel, Progress};

/// Pointer files are small; anything bigger isn't one
const MAX_POINTER: usize = 1024;
const SPEC: &[u8] = b"version https://git-lfs.github.com/spec/v1";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Pointer {
    /// sha256 of the real content
    pub oid: String,
    /// Size of the real content in bytes
    pub size: u64,
}

/// Parse an LFS pointer file; `None` when the content isn't one
pub fn parse_pointer(data: &[u8]) -> Option<Pointer> {
    if data.len() > MAX_POINTER || !data.starts_with(SPEC) {
        return None;
    }
    let text = std::str::from_utf8(data).ok()?;
    let mut oid = None;
    let mut size = None;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("oid sha256:") {
            oid = Some(v.trim().to_string()).filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()));
        } else if let Some(v) = line.strip_prefix("size ") {
            size = v.trim().parse().ok();
        }
    }
    Some(Pointer { oid: oid?, size: size? })
}

/// Where git-lfs keeps an object: `<common .git>/lfs/objects/ab/cd/abcd…`
pub fn object_path(common_dir: &Path, oid: &str) -> PathBuf {
    common_dir.join("lfs").join("objects").join(&oid[..2]).join(&oid[2..4]).join(oid)
}

/// What reading a file through LFS gave
pub enum Content {
    /// Not an LFS pointer, or the real content (already downloaded)
    Real(Vec<u8>),
    /// An LFS pointer whose content hasn't been downloaded
    Missing(Pointer, Vec<u8>),
}

/// Swap an LFS pointer for its downloaded content
pub fn resolve(repo: &git2::Repository, data: Vec<u8>) -> Content {
    let Some(p) = parse_pointer(&data) else { return Content::Real(data) };
    match std::fs::read(object_path(repo.commondir(), &p.oid)) {
        Ok(real) => Content::Real(real),
        Err(_) => Content::Missing(p, data),
    }
}

/// Same as [`resolve`], keeping the pointer text when the content isn't there
pub fn resolve_bytes(repo: &git2::Repository, data: Vec<u8>) -> Vec<u8> {
    match resolve(repo, data) {
        Content::Real(d) | Content::Missing(_, d) => d,
    }
}

/// Whether the repository uses LFS: some `.gitattributes` line sets `filter=lfs` (only the top-level file is checked)
pub fn uses_lfs(workdir: &Path) -> bool {
    std::fs::read_to_string(workdir.join(".gitattributes")).is_ok_and(|s| s.lines().any(|l| !l.trim_start().starts_with('#') && l.contains("filter=lfs")))
}

/// Whether the git-lfs program is installed (`git lfs version` works)
pub fn installed(dir: &Path) -> bool {
    crate::git_cli::run(dir, &["lfs", "version"], None).is_ok()
}

/// Download the LFS contents of the current checkout and put them in the worktree (`git lfs pull`)
pub fn pull(dir: &Path, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    if !installed(dir) {
        return Err(CoreError::new(ErrorCode::GitMissing, "没有安装 Git LFS（git-lfs），装好后才能下载 LFS 文件"));
    }
    crate::remote::run_net(dir, &["lfs", "pull"], cancel, progress).map(|_| ())
}

/// The diff of one file when either side is an LFS pointer: compare the real contents instead (both sides resolved).
/// `None` when neither side is a pointer, so the caller keeps libgit2's own diff.
pub fn diff_resolved(repo: &git2::Repository, d: &git2::Diff<'_>, path: &str, context: u32) -> Result<Option<crate::model::FileDiff>> {
    let Some(delta) = d.deltas().find(|x| x.status() != git2::Delta::Unmodified) else { return Ok(None) };
    // A side's full content: the blob, or the worktree file when libgit2 didn't hash it
    let read = |f: &git2::DiffFile<'_>| -> Option<Vec<u8>> {
        if !f.exists() {
            return None;
        }
        if !f.id().is_zero() {
            return repo.find_blob(f.id()).ok().map(|b| b.content().to_vec());
        }
        std::fs::read(repo.workdir()?.join(f.path()?)).ok()
    };
    // Whether a side is a pointer, reading only small contents
    let pointer = |f: &git2::DiffFile<'_>| -> bool {
        if !f.exists() {
            return false;
        }
        let small = if f.id().is_zero() {
            repo.workdir().zip(f.path()).and_then(|(w, p)| w.join(p).metadata().ok()).is_some_and(|m| m.len() as usize <= MAX_POINTER)
        } else {
            f.size() as usize <= MAX_POINTER
        };
        small && read(f).is_some_and(|b| parse_pointer(&b).is_some())
    };
    let (of, nf) = (delta.old_file(), delta.new_file());
    if !pointer(&of) && !pointer(&nf) {
        return Ok(None);
    }
    let old = read(&of).map(|b| resolve_bytes(repo, b)).unwrap_or_default();
    let new = read(&nf).map(|b| resolve_bytes(repo, b)).unwrap_or_default();
    let mut fd = crate::diff::buffers_diff(&old, &new, path, context)?;
    fd.lfs = true;
    Ok(Some(fd))
}
