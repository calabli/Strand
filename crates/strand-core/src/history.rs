//! Commit details and file diffs within a commit (spec §5.5, §10.6).

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::{CommitDetail, FileDiff};
use crate::worktree::find_renames;
use crate::{diff, Session};

impl Session {
    pub fn commit_detail(&self, id: &str) -> Result<CommitDetail> {
        let commit = self.find_logged(id)?;
        let files = self.commit_files(id)?;
        let caps = self.commit_caps(id)?;
        Ok(CommitDetail { commit, files, caps })
    }

    /// Files a commit (also a commit not in the log, like a stash) changed relative to its first parent
    pub(crate) fn commit_files(&self, id: &str) -> Result<Vec<crate::model::FileChange>> {
        let repo = self.git2()?;
        let mut d = commit_diff(&repo, id, None)?;
        // Partial clone: download the missing file contents in one go first (finding renames reads contents too)
        diff::prefetch(&repo, &d, diff::PREFETCH_LIMIT);
        find_renames(&mut d)?;
        let mut ignored = Vec::new();
        diff::files(&d, &mut ignored)
    }

    pub fn diff_commit(&self, id: &str, path: &str) -> Result<FileDiff> {
        self.diff_commit_ctx(id, path, 3)
    }

    /// Same as [`Session::diff_commit`], with the number of context lines (a huge value means the whole file, for the full view in the diff window)
    pub fn diff_commit_ctx(&self, id: &str, path: &str, context: u32) -> Result<FileDiff> {
        let repo = self.git2()?;
        let d = commit_diff_ctx(&repo, id, Some(path), context)?;
        // A stash made with -u keeps untracked files in its third parent: show them as added
        if d.deltas().len() == 0 {
            if let Some(untracked) = stash_untracked(&repo, id) {
                let d = commit_diff_ctx(&repo, &untracked, Some(path), context)?;
                return diff::first_file_lfs(&repo, &d, path, context);
            }
        }
        diff::prefetch(&repo, &d, usize::MAX);
        diff::first_file_lfs(&repo, &d, path, context)
    }
}

/// A commit's diff against its first parent; a root commit against the empty tree.
fn commit_diff<'r>(repo: &'r git2::Repository, id: &str, path: Option<&str>) -> Result<git2::Diff<'r>> {
    commit_diff_ctx(repo, id, path, 3)
}

fn commit_diff_ctx<'r>(repo: &'r git2::Repository, id: &str, path: Option<&str>, context: u32) -> Result<git2::Diff<'r>> {
    let oid = git2::Oid::from_str(id).map_err(|_| CoreError::new(ErrorCode::NotFound, "提交不存在"))?;
    let c = repo.find_commit(oid).map_err(|_| CoreError::new(ErrorCode::NotFound, "提交不存在"))?;
    let tree = c.tree().map_err(|e| CoreError::git("读取提交内容失败", e))?;
    let parent = c.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = git2::DiffOptions::new();
    opts.include_typechange(true).context_lines(context);
    if let Some(p) = path {
        opts.pathspec(p).disable_pathspec_match(true);
    }
    repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts))
        .map_err(|e| CoreError::git("读取提交差异失败", e))
}

/// The commit holding a stash's untracked files (its third parent), when it was made with -u
pub(crate) fn stash_untracked(repo: &git2::Repository, id: &str) -> Option<String> {
    let c = repo.find_commit(git2::Oid::from_str(id).ok()?).ok()?;
    (c.parent_count() == 3).then(|| c.parent_id(2).ok().map(|o| o.to_string())).flatten()
}
