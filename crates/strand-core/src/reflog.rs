//! Reflog: which commits HEAD or a local branch pointed to, newest first.
//! For recovering deleted branches and commits from before a reset or rebase; what Strand's own undo can't cover (done on the command line, older than 200 steps) can be found here too.

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::repo::Session;

/// Read at most this many entries
pub const MAX_ENTRIES: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct ReflogEntry {
    /// The n in HEAD@{n}
    pub index: usize,
    /// The commit pointed to after this step
    pub id: String,
    /// The commit pointed to before this step (all zeros for the first step)
    pub old_id: String,
    /// Action, e.g. commit, checkout, reset, merge origin/main, rebase (finish)
    pub action: String,
    /// The text after the colon, e.g. moving from main to dev
    pub message: String,
    pub time: i64,
    /// The commit title; empty when the commit is no longer in the repository
    pub title: String,
    /// The commit still exists in the repository (not pruned)
    pub exists: bool,
    /// The commit is in the log (can be located there)
    pub in_log: bool,
}

impl Session {
    /// Refs that have a reflog: HEAD first, then local branches (by name)
    pub fn reflog_refs(&self) -> Result<Vec<String>> {
        let repo = self.git2()?;
        let mut out = vec!["HEAD".to_string()];
        let mut names: Vec<String> = repo
            .branches(Some(git2::BranchType::Local))
            .map_err(|e| CoreError::git("读取分支失败", e))?
            .filter_map(|b| b.ok().and_then(|(b, _)| b.name().ok().flatten().map(str::to_string)))
            .filter(|n| repo.reflog(&format!("refs/heads/{n}")).is_ok_and(|r| !r.is_empty()))
            .collect();
        names.sort();
        out.extend(names);
        Ok(out)
    }

    /// The reflog of one ref, newest first. `name` is HEAD or a local branch name.
    pub fn reflog(&self, name: &str) -> Result<Vec<ReflogEntry>> {
        let repo = self.git2()?;
        let full = if name == "HEAD" { "HEAD".to_string() } else { format!("refs/heads/{name}") };
        if name != "HEAD" && repo.find_reference(&full).is_err() && repo.reflog(&full).map(|r| r.is_empty()).unwrap_or(true) {
            return Err(CoreError::new(ErrorCode::NotFound, format!("没有分支 {name}")));
        }
        let log = repo.reflog(&full).map_err(|e| CoreError::git("读取操作记录失败", e))?;
        let mut out = Vec::new();
        for (i, e) in log.iter().enumerate().take(MAX_ENTRIES) {
            let id = e.id_new().to_string();
            let msg = e.message().ok().flatten().unwrap_or("").to_string();
            let (action, message) = match msg.split_once(": ") {
                Some((a, m)) => (a.to_string(), m.to_string()),
                None => (msg.clone(), String::new()),
            };
            let commit = repo.find_commit(e.id_new()).ok();
            let in_log = gix::ObjectId::from_hex(id.as_bytes()).ok().is_some_and(|o| self.index.contains_key(&o));
            out.push(ReflogEntry {
                index: i,
                old_id: e.id_old().to_string(),
                action,
                message,
                time: e.committer().when().seconds(),
                title: commit.as_ref().and_then(|c| c.summary().ok().flatten().map(str::to_string)).unwrap_or_default(),
                exists: commit.is_some(),
                in_log,
                id,
            });
        }
        Ok(out)
    }
}
