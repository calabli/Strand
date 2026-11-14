//! 提交详情和某个提交里的文件差异（说明书 5.5、10.6）。

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

    /// 提交（也可以是贮藏这种不在日志里的提交）相对第一个父提交改动的文件
    pub(crate) fn commit_files(&self, id: &str) -> Result<Vec<crate::model::FileChange>> {
        let repo = self.git2()?;
        let mut d = commit_diff(&repo, id, None)?;
        // 部分克隆：先把缺的文件内容一次下载下来（找重命名也要读内容）
        diff::prefetch(&repo, &d, diff::PREFETCH_LIMIT);
        find_renames(&mut d)?;
        let mut ignored = Vec::new();
        diff::files(&d, &mut ignored)
    }

    pub fn diff_commit(&self, id: &str, path: &str) -> Result<FileDiff> {
        self.diff_commit_ctx(id, path, 3)
    }

    /// 同 [`Session::diff_commit`]，指定上下文行数（很大时就是整个文件，差异窗口的全文显示用）
    pub fn diff_commit_ctx(&self, id: &str, path: &str, context: u32) -> Result<FileDiff> {
        let repo = self.git2()?;
        let d = commit_diff_ctx(&repo, id, Some(path), context)?;
        diff::prefetch(&repo, &d, usize::MAX);
        diff::first_file(&d, path)
    }
}

/// 提交相对第一个父提交的差异；根提交相对空树。
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
