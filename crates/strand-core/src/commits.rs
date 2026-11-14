//! Operations on commits and when they are available (spec §5.6, §5.7): cherry-pick, revert, reset, undo commit, reword, drop.
//!
//! Availability is computed here and returned with the commit detail (`caps`); the frontend only greys out and shows the reason.
//! "Unpushed" means reachable from the current branch but not in its upstream; without an upstream, not in any remote branch.
//! "The unpushed run" means the consecutive unpushed non-merge commits walking back from the current branch's latest commit along first parents.

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::model::{HeadKind, RepoMode};
use crate::repo::Session;

/// Whether an operation is available; the reason when it isn't
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Cap {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

impl Cap {
    fn yes() -> Cap {
        Cap { ok: true, why: None }
    }
    fn no(why: &str) -> Cap {
        Cap { ok: false, why: Some(why.to_string()) }
    }
    fn when(ok: bool, why: &str) -> Cap {
        if ok { Cap::yes() } else { Cap::no(why) }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitCaps {
    pub cherry_pick: Cap,
    pub checkout: Cap,
    pub reset: Cap,
    pub revert: Cap,
    pub undo: Cap,
    pub reword: Cap,
    pub drop: Cap,
    /// Rebase from here (spec §9.2)
    pub rebase_from: Cap,
    /// Fixup / Squash Into: fold the checked worktree changes into this commit (also requires checked files in the commit panel, checked by the frontend)
    pub fixup: Cap,
    /// Compare with local (spec §10.3): from this commit to the current HEAD
    pub compare_local: Cap,
    /// Push up to here (spec §5.6): within the unpushed run, and the remote has no new commits (as of the last fetch)
    pub push_to: Cap,
    /// First parent (when in the log)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Child commit: prefer the one that has it as first parent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child: Option<String>,
    /// This commit's page on the hosting service (only when origin's URL is a recognized host)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

impl Session {
    /// After re-reading the log: work out which rows are reachable from HEAD and which are unpushed
    pub(crate) fn compute_reach(&mut self) {
        let n = self.ids.len();
        let head = self.head_row();
        self.head_reach = self.reach(head.into_iter().collect());
        let pushed = self.reach(self.upstream_rows());
        self.unpushed = (0..n).map(|r| self.head_reach[r] && !pushed[r]).collect();
    }

    pub(crate) fn head_row(&self) -> Option<u32> {
        let repo = self.repo.to_thread_local();
        let id = repo.head_id().ok()?.detach();
        self.index.get(&id).copied()
    }

    /// The current branch's upstream; all remote branches when there is none
    fn upstream_rows(&self) -> Vec<u32> {
        let Ok(repo) = self.git2() else { return Vec::new() };
        let up = repo
            .head()
            .ok()
            .filter(|h| h.is_branch())
            .and_then(|h| h.shorthand().ok().map(str::to_string))
            .and_then(|name| repo.find_branch(&name, git2::BranchType::Local).ok())
            .and_then(|b| b.upstream().ok())
            .and_then(|u| u.get().target());
        let ids: Vec<git2::Oid> = match up {
            Some(id) => vec![id],
            None => repo
                .branches(Some(git2::BranchType::Remote))
                .map(|it| it.flatten().filter_map(|(b, _)| b.get().target()).collect())
                .unwrap_or_default(),
        };
        ids.iter()
            .filter_map(|id| gix::ObjectId::from_hex(id.to_string().as_bytes()).ok())
            .filter_map(|id| self.index.get(&id).copied())
            .collect()
    }

    pub(crate) fn reach(&self, mut stack: Vec<u32>) -> Vec<bool> {
        let mut seen = vec![false; self.ids.len()];
        for &r in &stack {
            seen[r as usize] = true;
        }
        while let Some(r) = stack.pop() {
            for &p in &self.parents[r as usize] {
                if !seen[p as usize] {
                    seen[p as usize] = true;
                    stack.push(p);
                }
            }
        }
        seen
    }

    pub(crate) fn row_of(&self, id: &str) -> Result<u32> {
        let oid = gix::ObjectId::from_hex(id.as_bytes()).map_err(|_| not_found())?;
        self.index.get(&oid).copied().ok_or_else(not_found)
    }

    /// The unpushed run: consecutive unpushed non-merge commits walking back from HEAD along first parents
    fn segment(&self) -> Vec<u32> {
        let mut out = Vec::new();
        let mut cur = self.head_row();
        while let Some(r) = cur {
            let ps = &self.parents[r as usize];
            if !self.unpushed[r as usize] || ps.len() > 1 {
                break;
            }
            out.push(r);
            cur = ps.first().copied();
        }
        out
    }

    /// Availability rules from spec §5.6
    pub fn commit_caps(&self, id: &str) -> Result<CommitCaps> {
        let row = self.row_of(id)?;
        let st = self.state()?;
        let normal = st.state == RepoMode::Normal;
        let on_branch = st.head.kind == HeadKind::Branch;
        let head = self.head_row();
        let is_head = head == Some(row);
        let in_history = self.head_reach[row as usize];
        let is_merge = self.parents[row as usize].len() > 1;
        let has_parent = !self.parents[row as usize].is_empty();
        let unpushed = self.unpushed[row as usize];
        let busy = "合并或变基还没完成";
        let gate = |c: Cap| if normal { c } else { Cap::no(busy) };

        let cherry_pick = gate(Cap::when(!in_history, "这个提交已经在当前分支的历史里"));
        let checkout = gate(Cap::yes());
        let reset = gate(if !on_branch {
            Cap::no("现在不在任何分支上")
        } else if !in_history {
            Cap::no("这个提交不在当前分支的历史里")
        } else if is_head {
            Cap::no("这就是当前分支的最新提交")
        } else {
            // All commits after it (reachable from HEAD, not from it) must be unpushed
            let below = self.reach(vec![row]);
            let after_pushed = (0..self.ids.len()).any(|r| self.head_reach[r] && !below[r] && !self.unpushed[r]);
            Cap::when(!after_pushed, "它之后有已经推送的提交")
        });
        let revert = gate(if !in_history {
            Cap::no("这个提交不在当前分支的历史里")
        } else {
            Cap::when(!is_merge, "合并提交不能直接还原")
        });
        let latest_unpushed = || {
            if !on_branch {
                Cap::no("现在不在任何分支上")
            } else if !is_head {
                Cap::no("只能对当前分支的最新提交这样做")
            } else {
                Cap::when(unpushed, "这个提交已经推送")
            }
        };
        let undo = gate(match latest_unpushed() {
            c if !c.ok => c,
            _ if is_merge => Cap::no("合并提交不能撤销，可以重置到它之前"),
            _ => Cap::when(has_parent, "这是仓库的第一个提交"),
        });
        // The latest commit is amended directly; earlier commits are reworded with a rebase (spec §5.6): it and the commits after it must all be in the rebaseable range and unpushed
        let range = self.rebase_rows().unwrap_or_default();
        let reword = gate(if !on_branch {
            Cap::no("现在不在任何分支上")
        } else if is_head {
            Cap::when(unpushed, "这个提交已经推送")
        } else if !in_history {
            Cap::no("这个提交不在当前分支的历史里")
        } else if !unpushed {
            Cap::no("这个提交已经推送")
        } else if let Some(k) = range.iter().position(|&r| r == row) {
            Cap::when(range[..=k].iter().all(|&r| self.unpushed[r as usize]), "这个提交或它之后的提交已经推送")
        } else {
            Cap::no("它和最新提交之间有合并提交，或者其他分支也有它，不能改说明")
        });
        let drop = gate(if !on_branch {
            Cap::no("现在不在任何分支上")
        } else if !self.segment().contains(&row) {
            Cap::no(if !in_history { "这个提交不在当前分支的历史里" } else if !unpushed { "这个提交已经推送" } else { "只能丢弃最近一串未推送、非合并的提交" })
        } else {
            Cap::when(has_parent, "这是仓库的第一个提交")
        });

        let rebase_from = gate(if !range.contains(&row) {
            Cap::no("这个提交不在可以整理的范围里（合并提交、其他分支也有的提交不能整理）")
        } else {
            Cap::when(range.len() >= 2 && !is_head, "从这里开始只有它一个提交")
        });
        let fixup = gate(if !range.contains(&row) {
            Cap::no("这个提交不在可以整理的范围里")
        } else {
            let k = range.iter().position(|&r| r == row).unwrap_or(0);
            Cap::when(range[..=k].iter().all(|&r| self.unpushed[r as usize]), "这个提交或它之后的提交已经推送")
        });
        let compare_local = Cap::when(!is_head, "这就是当前分支的最新提交");
        let push_to = gate(if !on_branch {
            Cap::no("现在不在任何分支上")
        } else if !self.segment().contains(&row) {
            Cap::no(if !in_history { "这个提交不在当前分支的历史里" } else if !unpushed { "这个提交已经推送" } else { "只能推送最近一串未推送、非合并的提交" })
        } else {
            self.remote_behind_cap()
        });
        let parent = self.parents[row as usize].first().map(|&p| self.ids[p as usize].to_string());
        let child = self.child_of(row).map(|c| self.ids[c as usize].to_string());
        let web_url = self
            .git2()
            .ok()
            .and_then(|r| r.find_remote("origin").ok().and_then(|o| o.url().ok().map(str::to_string)))
            .and_then(|u| commit_web_url(&u, id));
        Ok(CommitCaps { cherry_pick, checkout, reset, revert, undo, reword, drop, rebase_from, fixup, compare_local, push_to, parent, child, web_url })
    }

    /// Remote conditions for pushing up to a commit: origin exists; with an upstream, the remote must not have commits we don't (as of the last fetch)
    fn remote_behind_cap(&self) -> Cap {
        let Ok(repo) = self.git2() else { return Cap::no("读取仓库失败") };
        if repo.find_remote("origin").is_err() {
            return Cap::no("没有 origin 远程仓库");
        }
        let Some(name) = repo.head().ok().and_then(|h| h.shorthand().ok().map(str::to_string)) else { return Cap::no("现在不在任何分支上") };
        let Ok(b) = repo.find_branch(&name, git2::BranchType::Local) else { return Cap::yes() };
        let (Some(local), Some(up)) = (b.get().target(), b.upstream().ok().and_then(|u| u.get().target())) else { return Cap::yes() };
        match repo.graph_ahead_behind(local, up) {
            Ok((_, 0)) => Cap::yes(),
            _ => Cap::no("远程有本地没有的提交，先拉取（或者需要强制推送）"),
        }
    }

    /// Child commit: listed before it in the log and has it as a parent; prefer the one with it as first parent, otherwise the nearest
    fn child_of(&self, row: u32) -> Option<u32> {
        let mut any = None;
        for r in (0..row).rev() {
            let ps = &self.parents[r as usize];
            if ps.first() == Some(&row) {
                return Some(r);
            }
            if any.is_none() && ps.contains(&row) {
                any = Some(r);
            }
        }
        any
    }

    /// The title of a commit in the log (used in op log labels)
    pub fn commit_title(&self, id: &str) -> Option<String> {
        self.find_logged(id).ok().map(|c| c.title)
    }

    fn require(&self, c: Cap) -> Result<()> {
        if c.ok { Ok(()) } else { Err(CoreError::new(ErrorCode::InvalidRange, c.why.unwrap_or_default())) }
    }

    fn git_run(&self, args: &[&str], stdin: Option<&str>) -> Result<String> {
        git_cli::run(self.path(), args, stdin).map_err(worktree_error)
    }

    /// Cherry-pick: pick one by one from oldest to newest. Stops in the cherry-pick state on conflicts and returns `CONFLICTS`.
    pub fn commit_cherry_pick(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "没有选中提交"));
        }
        let mut rows = Vec::new();
        for id in ids {
            self.require(self.commit_caps(id)?.cherry_pick)?;
            rows.push(self.row_of(id)?);
        }
        // Higher row numbers in the log are older
        rows.sort_unstable_by(|a, b| b.cmp(a));
        let hex: Vec<String> = rows.iter().map(|&r| self.ids[r as usize].to_string()).collect();
        // --allow-empty: also pick commits that were empty to begin with
        let mut args = vec!["cherry-pick", "--allow-empty"];
        args.extend(hex.iter().map(String::as_str));
        let mut r = self.with_conflicts(&args);
        // When the changes are already on the current branch and the pick ends up empty, git stops and waits; skip such conflict-free stops
        while matches!(&r, Err(e) if e.code == ErrorCode::Conflicts) && self.stopped_empty() {
            r = self.with_conflicts(&["cherry-pick", "--skip"]);
        }
        r
    }

    /// Stopped mid cherry-pick with no conflicted files and nothing to commit (the pick came out empty)
    fn stopped_empty(&self) -> bool {
        let Ok(repo) = self.git2() else { return false };
        if repo.state() != git2::RepositoryState::CherryPick && repo.state() != git2::RepositoryState::CherryPickSequence {
            return false;
        }
        let Ok(idx) = repo.index() else { return false };
        if idx.has_conflicts() {
            return false;
        }
        let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let staged = repo.diff_tree_to_index(head.as_ref(), Some(&idx), None).map(|d| d.deltas().len()).unwrap_or(1);
        staged == 0
    }

    /// Revert: create a new commit that undoes its changes, with the message "Revert "original message""
    pub fn commit_revert(&self, id: &str) -> Result<()> {
        self.require(self.commit_caps(id)?.revert)?;
        let c = self.find_logged(id)?;
        let msg = format!("还原“{}”\n\n这个提交撤掉了 {} 的改动。\n", c.title, c.id);
        match self.with_conflicts(&["revert", "--no-edit", id]) {
            Ok(()) => {
                // The commit just created, only the message changes; hooks already ran during revert
                self.git_run(&["commit", "--amend", "--only", "--no-verify", "--file=-"], Some(&msg)).map(|_| ())
            }
            Err(e) if e.code == ErrorCode::Conflicts => {
                // When conflict resolution finishes git uses MERGE_MSG as the message
                if let Ok(repo) = self.git2() {
                    let _ = std::fs::write(repo.path().join("MERGE_MSG"), &msg);
                }
                Err(e)
            }
            Err(e) => Err(e),
        }
    }

    /// Reset the current branch to this commit (spec §5.7)
    pub fn commit_reset(&self, id: &str, mode: ResetMode) -> Result<()> {
        self.require(self.commit_caps(id)?.reset)?;
        let flag = match mode {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        };
        self.git_run(&["reset", "--quiet", flag, id], None).map(|_| ())
    }

    /// Undo the latest commit: same as a soft reset to its parent, changes stay in the worktree
    pub fn commit_undo(&self) -> Result<()> {
        let head = self.head_row().ok_or_else(not_found)?;
        let id = self.ids[head as usize].to_string();
        self.require(self.commit_caps(&id)?.undo)?;
        self.git_run(&["reset", "--quiet", "--soft", "HEAD~1"], None).map(|_| ())
    }

    /// Change the latest commit's message (without bringing in worktree changes)
    pub fn commit_reword(&self, id: &str, message: &str) -> Result<()> {
        self.require(self.commit_caps(id)?.reword)?;
        if message.trim().is_empty() {
            return Err(CoreError::new(ErrorCode::EmptyMessage, "提交说明不能为空"));
        }
        if self.head_row() == Some(self.row_of(id)?) {
            return self.git_run(&["commit", "--amend", "--only", "--quiet", "--allow-empty", "--file=-"], Some(message)).map(|_| ());
        }
        // Earlier commits: rebase from it, changing only its message, and reattach the later commits as they are (same changes, no conflicts)
        self.reword_earlier(id, message)
    }

    /// Drop a commit in the unpushed run along with its changes. Later commits are reattached to its parent; stops in the rebase state on conflicts.
    pub fn commit_drop(&self, id: &str) -> Result<()> {
        self.require(self.commit_caps(id)?.drop)?;
        let parent = format!("{id}^");
        self.with_conflicts(&["rebase", "--autostash", "--onto", &parent, id])
    }

    /// Run a command that may stop on conflicts: returns `CONFLICTS` when it stops, and the UI then enters conflict resolution
    fn with_conflicts(&self, args: &[&str]) -> Result<()> {
        match git_cli::run(self.path(), args, None) {
            Ok(_) => Ok(()),
            Err(e) => {
                if self.state()?.state != RepoMode::Normal {
                    return Err(CoreError::new(ErrorCode::Conflicts, "有冲突需要解决").with_detail(e.detail.unwrap_or_default()));
                }
                Err(worktree_error(e))
            }
        }
    }
}

fn not_found() -> CoreError {
    CoreError::new(ErrorCode::NotFound, "提交不存在，日志可能已经变化")
}

/// Give a readable explanation when worktree changes would be overwritten
fn worktree_error(e: CoreError) -> CoreError {
    let text = e.detail.as_ref().map(|d| d.to_string()).unwrap_or_default();
    if text.contains("would be overwritten") || text.contains("Your local changes") || text.contains("uncommitted changes") {
        return CoreError::new(ErrorCode::WorktreeConflict, "工作区里有会被覆盖的改动，先提交或贮藏").with_detail(e.detail.unwrap_or_default());
    }
    e
}

/// Build the URL of a commit page on the hosting service from the remote URL (spec §5.6 "View in browser").
/// Understands https, ssh and scp forms; only GitHub, GitLab, Bitbucket, Gitee, Codeberg and hosts containing gitea are recognized, others return empty.
pub fn commit_web_url(remote: &str, id: &str) -> Option<String> {
    let u = remote.trim();
    let (host, path) = if let Some(rest) = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")) {
        let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
        rest.split_once('/')?
    } else if let Some(rest) = u.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (hp, path) = rest.split_once('/')?;
        (hp.split(':').next()?, path)
    } else if !u.contains("://") && u.contains(':') {
        // scp form: git@host:owner/repo.git
        let rest = u.split_once('@').map(|(_, r)| r).unwrap_or(u);
        rest.split_once(':')?
    } else {
        return None;
    };
    let host = host.split(':').next()?.to_lowercase();
    let path = path.trim_matches('/').trim_end_matches(".git");
    if host.is_empty() || path.is_empty() || !path.contains('/') {
        return None;
    }
    let tail = if host.contains("gitlab") {
        format!("/-/commit/{id}")
    } else if host.contains("bitbucket") {
        format!("/commits/{id}")
    } else if ["github", "gitee", "codeberg", "gitea"].iter().any(|k| host.contains(k)) {
        format!("/commit/{id}")
    } else {
        return None;
    };
    Some(format!("https://{host}/{path}{tail}"))
}

#[cfg(test)]
mod web_url_tests {
    use super::commit_web_url as w;

    #[test]
    fn hosts_and_forms() {
        assert_eq!(w("https://github.com/a/b.git", "abc").as_deref(), Some("https://github.com/a/b/commit/abc"));
        assert_eq!(w("git@github.com:a/b.git", "abc").as_deref(), Some("https://github.com/a/b/commit/abc"));
        assert_eq!(w("ssh://git@gitlab.example.com:2222/g/sub/b.git", "abc").as_deref(), Some("https://gitlab.example.com/g/sub/b/-/commit/abc"));
        assert_eq!(w("https://user:token@bitbucket.org/a/b", "abc").as_deref(), Some("https://bitbucket.org/a/b/commits/abc"));
        assert_eq!(w("https://gitee.com/a/b/", "abc").as_deref(), Some("https://gitee.com/a/b/commit/abc"));
        assert_eq!(w("/srv/git/b.git", "abc"), None);
        assert_eq!(w("https://example.com/a/b.git", "abc"), None);
        assert_eq!(w("file:///tmp/x", "abc"), None);
        assert_eq!(w("git@github.com:b.git", "abc"), None);
    }
}
