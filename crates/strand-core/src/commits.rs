//! 提交上的操作和它们的可用条件（说明书 5.6、5.7）：拣选、还原、重置、撤销提交、修改说明、丢弃提交。
//!
//! 可用条件在这里算好随提交详情返回（`caps`），前端只负责置灰和显示原因。
//! “未推送”指从当前分支能到达、但不在它的跟踪分支里；没有跟踪分支时，不在任何远程分支里。
//! “未推送段”指从当前分支最新提交沿第一父提交往回走，连续的、未推送的、非合并的提交。

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::model::{HeadKind, RepoMode};
use crate::repo::Session;

/// 一个操作能不能用；不能用时给出原因
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
    /// 从这里开始整理（说明书 9.2）
    pub rebase_from: Cap,
    /// Fixup / Squash Into：把工作区里勾选的改动并入这个提交（还要求提交面板有勾选，前端判断）
    pub fixup: Cap,
    /// 和本地比较（说明书 10.3）：起点是这个提交，终点是当前的 HEAD
    pub compare_local: Cap,
    /// 推送到这里为止（说明书 5.6）：在未推送段里，远程没有新提交（按上次抓取）
    pub push_to: Cap,
    /// 第一父提交（在日志里时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// 子提交：优先取以它为第一父提交的那个
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child: Option<String>,
    /// 托管平台上这个提交的页面（origin 的地址能认出平台时才有）
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
    /// 重新读取日志后：算出哪些行从 HEAD 能到达、哪些未推送
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

    /// 当前分支的跟踪分支；没有时取所有远程分支
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

    /// 未推送段：从 HEAD 沿第一父提交往回，连续的、未推送的、非合并的提交
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

    /// 说明书 5.6 的可用条件
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
            // 它之后的提交（从 HEAD 能到达、从它到达不了的）必须全部未推送
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
        // 最新提交直接 amend；更早的提交用变基换说明（说明书 5.6）：它和它之后的提交都要在可整理的范围里、都未推送
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

    /// 推送到某个提交为止的远程条件：有 origin；有跟踪分支时远程不能有本地没有的提交（按上次抓取）
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

    /// 子提交：日志里排在它前面、父提交含它的；优先以它为第一父提交的，其次离它最近的
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

    /// 日志里某个提交的标题（操作日志的说明用）
    pub fn commit_title(&self, id: &str) -> Option<String> {
        self.find_logged(id).ok().map(|c| c.title)
    }

    fn require(&self, c: Cap) -> Result<()> {
        if c.ok { Ok(()) } else { Err(CoreError::new(ErrorCode::InvalidRange, c.why.unwrap_or_default())) }
    }

    fn git_run(&self, args: &[&str], stdin: Option<&str>) -> Result<String> {
        git_cli::run(self.path(), args, stdin).map_err(worktree_error)
    }

    /// 拣选：按从旧到新的顺序依次拣选。有冲突时停在拣选状态，返回 `CONFLICTS`。
    pub fn commit_cherry_pick(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "没有选中提交"));
        }
        let mut rows = Vec::new();
        for id in ids {
            self.require(self.commit_caps(id)?.cherry_pick)?;
            rows.push(self.row_of(id)?);
        }
        // 日志里行号大的更旧
        rows.sort_unstable_by(|a, b| b.cmp(a));
        let hex: Vec<String> = rows.iter().map(|&r| self.ids[r as usize].to_string()).collect();
        // --allow-empty：原本就是空提交的也拣选过来
        let mut args = vec!["cherry-pick", "--allow-empty"];
        args.extend(hex.iter().map(String::as_str));
        let mut r = self.with_conflicts(&args);
        // 改动已经在当前分支里、拣选后成了空提交时 git 会停下来等待；这种没有冲突的停顿直接跳过
        while matches!(&r, Err(e) if e.code == ErrorCode::Conflicts) && self.stopped_empty() {
            r = self.with_conflicts(&["cherry-pick", "--skip"]);
        }
        r
    }

    /// 停在拣选中，但没有冲突文件、也没有要提交的改动（拣选结果为空）
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

    /// 还原：新建一个提交撤掉它的改动，说明为“还原“原说明””
    pub fn commit_revert(&self, id: &str) -> Result<()> {
        self.require(self.commit_caps(id)?.revert)?;
        let c = self.find_logged(id)?;
        let msg = format!("还原“{}”\n\n这个提交撤掉了 {} 的改动。\n", c.title, c.id);
        match self.with_conflicts(&["revert", "--no-edit", id]) {
            Ok(()) => {
                // 刚生成的提交，只改说明；钩子在 revert 时已经运行过
                self.git_run(&["commit", "--amend", "--only", "--no-verify", "--file=-"], Some(&msg)).map(|_| ())
            }
            Err(e) if e.code == ErrorCode::Conflicts => {
                // 冲突解决完成时 git 用 MERGE_MSG 作为说明
                if let Ok(repo) = self.git2() {
                    let _ = std::fs::write(repo.path().join("MERGE_MSG"), &msg);
                }
                Err(e)
            }
            Err(e) => Err(e),
        }
    }

    /// 把当前分支重置到这个提交（说明书 5.7）
    pub fn commit_reset(&self, id: &str, mode: ResetMode) -> Result<()> {
        self.require(self.commit_caps(id)?.reset)?;
        let flag = match mode {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        };
        self.git_run(&["reset", "--quiet", flag, id], None).map(|_| ())
    }

    /// 撤销最新提交：等同于软重置到父提交，改动留在工作区
    pub fn commit_undo(&self) -> Result<()> {
        let head = self.head_row().ok_or_else(not_found)?;
        let id = self.ids[head as usize].to_string();
        self.require(self.commit_caps(&id)?.undo)?;
        self.git_run(&["reset", "--quiet", "--soft", "HEAD~1"], None).map(|_| ())
    }

    /// 修改最新提交的说明（不带入工作区的改动）
    pub fn commit_reword(&self, id: &str, message: &str) -> Result<()> {
        self.require(self.commit_caps(id)?.reword)?;
        if message.trim().is_empty() {
            return Err(CoreError::new(ErrorCode::EmptyMessage, "提交说明不能为空"));
        }
        if self.head_row() == Some(self.row_of(id)?) {
            return self.git_run(&["commit", "--amend", "--only", "--quiet", "--allow-empty", "--file=-"], Some(message)).map(|_| ());
        }
        // 更早的提交：从它开始变基，只换它的说明，之后的提交原样接上（改动不变，不会冲突）
        self.reword_earlier(id, message)
    }

    /// 丢弃未推送段里的一个提交和它的改动。之后的提交接到它的父提交上；有冲突时停在变基状态。
    pub fn commit_drop(&self, id: &str) -> Result<()> {
        self.require(self.commit_caps(id)?.drop)?;
        let parent = format!("{id}^");
        self.with_conflicts(&["rebase", "--autostash", "--onto", &parent, id])
    }

    /// 运行可能停在冲突的命令：停住时返回 `CONFLICTS`，界面随后进入冲突解决
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

/// 工作区里有会被覆盖的改动时，给出能看懂的说明
fn worktree_error(e: CoreError) -> CoreError {
    let text = e.detail.as_ref().map(|d| d.to_string()).unwrap_or_default();
    if text.contains("would be overwritten") || text.contains("Your local changes") || text.contains("uncommitted changes") {
        return CoreError::new(ErrorCode::WorktreeConflict, "工作区里有会被覆盖的改动，先提交或贮藏").with_detail(e.detail.unwrap_or_default());
    }
    e
}

/// 按远程地址拼出托管平台上提交页面的地址（说明书 5.6“在浏览器中查看”）。
/// 认 https、ssh、scp 三种写法；只认 GitHub、GitLab、Bitbucket、Gitee、Codeberg 和带 gitea 的主机，其他返回空。
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
        // scp 写法：git@host:owner/repo.git
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
