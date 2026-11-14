//! Compare, patches, and browsing the repository at a revision (spec §10.3–10.5). All read-only.

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::{Commit, FileChange, FileDiff, Selection};
use crate::worktree::find_renames;
use crate::{diff, git_cli, Session};

/// Maximum commits listed per side
pub const COMPARE_MAX: usize = 500;

#[derive(Debug, Clone, Serialize)]
pub struct Comparison {
    /// Start and end (full hashes)
    pub from: String,
    pub to: String,
    /// Commits only on the start side (reachable from start, not from end), newest first
    pub only_from: Vec<Commit>,
    /// Commits only on the end side
    pub only_to: Vec<Commit>,
    /// One side was truncated at the limit
    pub truncated: bool,
    /// Files that differ between start and end
    pub files: Vec<FileChange>,
}

fn not_found(rev: &str) -> CoreError {
    CoreError::new(ErrorCode::NotFound, format!("找不到 {rev}"))
}

impl Session {
    fn resolve(&self, repo: &git2::Repository, rev: &str) -> Result<git2::Oid> {
        repo.revparse_single(rev).and_then(|o| o.peel_to_commit()).map(|c| c.id()).map_err(|_| not_found(rev))
    }

    /// Compare two commits (hashes, branch names or tag names)
    pub fn compare(&self, from: &str, to: &str) -> Result<Comparison> {
        let repo = self.git2()?;
        let (a, b) = (self.resolve(&repo, from)?, self.resolve(&repo, to)?);
        let mut truncated = false;
        let mut side = |inc: git2::Oid, exc: git2::Oid| -> Result<Vec<String>> {
            let mut walk = repo.revwalk().map_err(|e| CoreError::git("读取提交历史失败", e))?;
            walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME).map_err(|e| CoreError::git("读取提交历史失败", e))?;
            walk.push(inc).map_err(|e| CoreError::git("读取提交历史失败", e))?;
            walk.hide(exc).map_err(|e| CoreError::git("读取提交历史失败", e))?;
            let mut out = Vec::new();
            for id in walk {
                let id = id.map_err(|e| CoreError::git("读取提交历史失败", e))?;
                if out.len() >= COMPARE_MAX {
                    truncated = true;
                    break;
                }
                out.push(id.to_string());
            }
            Ok(out)
        };
        let only_from = side(a, b)?;
        let only_to = side(b, a)?;
        let only_from = self.commits_by_id(&only_from)?;
        let only_to = self.commits_by_id(&only_to)?;
        let ta = repo.find_commit(a).and_then(|c| c.tree()).map_err(|e| CoreError::git("读取提交内容失败", e))?;
        let tb = repo.find_commit(b).and_then(|c| c.tree()).map_err(|e| CoreError::git("读取提交内容失败", e))?;
        let mut opts = git2::DiffOptions::new();
        opts.include_typechange(true);
        let mut d = repo.diff_tree_to_tree(Some(&ta), Some(&tb), Some(&mut opts)).map_err(|e| CoreError::git("读取差异失败", e))?;
        diff::prefetch(&repo, &d, diff::PREFETCH_LIMIT);
        find_renames(&mut d)?;
        let mut ignored = Vec::new();
        let files = diff::files(&d, &mut ignored)?;
        Ok(Comparison { from: a.to_string(), to: b.to_string(), only_from, only_to, truncated, files })
    }

    /// The diff of one file between two commits
    pub fn diff_compare(&self, from: &str, to: &str, path: &str) -> Result<FileDiff> {
        self.diff_compare_ctx(from, to, path, 3)
    }

    /// Same as [`Session::diff_compare`], with the number of context lines
    pub fn diff_compare_ctx(&self, from: &str, to: &str, path: &str, context: u32) -> Result<FileDiff> {
        let repo = self.git2()?;
        let (a, b) = (self.resolve(&repo, from)?, self.resolve(&repo, to)?);
        let ta = repo.find_commit(a).and_then(|c| c.tree()).map_err(|e| CoreError::git("读取提交内容失败", e))?;
        let tb = repo.find_commit(b).and_then(|c| c.tree()).map_err(|e| CoreError::git("读取提交内容失败", e))?;
        let mut opts = git2::DiffOptions::new();
        opts.include_typechange(true).pathspec(path).disable_pathspec_match(true).context_lines(context);
        let d = repo.diff_tree_to_tree(Some(&ta), Some(&tb), Some(&mut opts)).map_err(|e| CoreError::git("读取差异失败", e))?;
        diff::prefetch(&repo, &d, usize::MAX);
        diff::first_file_lfs(&repo, &d, path, context)
    }

    /// Commit contents; ones in the log carry refs and unpushed markers, ones not in it (e.g. rewritten) carry only basic info
    fn commits_by_id(&self, ids: &[String]) -> Result<Vec<Commit>> {
        let repo = self.git2()?;
        ids.iter()
            .map(|id| {
                if let Ok(c) = self.find_logged(id) {
                    return Ok(c);
                }
                let c = repo.find_commit(git2::Oid::from_str(id).map_err(|_| not_found(id))?).map_err(|_| not_found(id))?;
                let parents: Vec<String> = c.parent_ids().map(|p| p.to_string()).collect();
                Ok(Commit {
                    id: id.clone(),
                    is_merge: parents.len() > 1,
                    parents,
                    title: c.summary().ok().flatten().unwrap_or("").to_string(),
                    body: c.body().ok().flatten().unwrap_or("").trim().to_string(),
                    author: crate::model::Author { name: c.author().name().unwrap_or("").into(), email: c.author().email().unwrap_or("").into() },
                    time: c.author().when().seconds(),
                    refs: Vec::new(),
                    unpushed: false,
                })
            })
            .collect()
    }

    /// The full patch of a commit, in `git format-patch` format (spec §10.4)
    pub fn patch_commit(&self, id: &str) -> Result<String> {
        let repo = self.git2()?;
        let oid = self.resolve(&repo, id)?.to_string();
        git_cli::run(self.path(), &["format-patch", "-1", "--stdout", "--binary", "--no-signature", &oid], None)
    }

    /// The worktree changes of the checked files, in `git diff` format (whole files; line-level picks don't apply to patches)
    pub fn patch_worktree(&self, selection: &Selection) -> Result<String> {
        let mut paths: Vec<&str> = Vec::new();
        for f in &selection.files {
            paths.push(&f.path);
            if let Some(o) = &f.old_path {
                paths.push(o);
            }
        }
        if paths.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "至少勾选一个文件"));
        }
        let mut args = vec!["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--"];
        args.extend(paths);
        let text = git_cli::run(self.path(), &args, None)?;
        if text.trim().is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "选中的文件没有改动"));
        }
        Ok(text)
    }

    /// All files in the repository at a commit, sorted by path (spec §10.5)
    pub fn commit_tree(&self, id: &str) -> Result<Vec<String>> {
        let repo = self.git2()?;
        let oid = self.resolve(&repo, id)?;
        let tree = repo.find_commit(oid).and_then(|c| c.tree()).map_err(|e| CoreError::git("读取提交内容失败", e))?;
        let mut out = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |dir, e| {
            if e.kind() == Some(git2::ObjectType::Blob) || e.kind() == Some(git2::ObjectType::Commit) {
                out.push(format!("{dir}{}", e.name().unwrap_or("")));
            }
            git2::TreeWalkResult::Ok
        })
        .map_err(|e| CoreError::git("读取提交内容失败", e))?;
        out.sort();
        Ok(out)
    }
}

/// Whole-file diff between two texts (compare any two files, compare with clipboard); `name` is used to detect the language and for display
pub fn text_diff(left: &str, right: &str, name: &str) -> crate::Result<crate::model::FileDiff> {
    crate::diff::buffers_diff(left.as_bytes(), right.as_bytes(), name, 1_000_000)
}
