//! Rebasing commits (spec §9): interactive rebase.
//!
//! The core layer writes the rebase todo list itself and hands it to git through `GIT_SEQUENCE_EDITOR`, without an editor.
//! When replay hits conflicts the repository stays in the rebase state and the UI enters conflict resolution (§8); the whole rebase is one step in the op log.
//!
//! The rebaseable range: walk back from the current branch's latest commit along first parents, stopping at a merge commit, the root commit,
//! or a commit another local branch can also reach (another branch points to it, or it's before the fork point).

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::model::{HeadKind, RepoMode, Selection};
use crate::repo::Session;

#[derive(Debug, Clone, Serialize)]
pub struct RangeCommit {
    pub id: String,
    pub title: String,
    pub body: String,
    pub author: String,
    pub time: i64,
    /// Already pushed (a force push is needed after rebasing)
    pub pushed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RebaseRange {
    /// Oldest first
    pub commits: Vec<RangeCommit>,
    pub has_pushed: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepAction {
    /// Keep
    Pick,
    /// Squash into the previous kept commit, appending the message to its body
    Squash,
    /// Fold into the previous kept commit, discarding the message (for Fixup)
    Fixup,
    Drop,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Step {
    pub id: String,
    pub action: StepAction,
    /// Replace with this message (for Squash Into); only for kept commits
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RebaseResult {
    /// Commits before the rebase
    pub before: usize,
    /// Commits after the rebase
    pub after: usize,
}

impl Session {
    /// Rows of the maximum rebaseable range, newest first
    pub(crate) fn rebase_rows(&self) -> Result<Vec<u32>> {
        let st = self.state()?;
        if st.head.kind != HeadKind::Branch {
            return Err(CoreError::new(ErrorCode::InvalidRange, "现在不在任何分支上"));
        }
        let repo = self.git2()?;
        let current = st.head.branch.unwrap_or_default();
        // Commits reachable from other local branches
        let mut tips = Vec::new();
        for (b, _) in repo.branches(Some(git2::BranchType::Local)).map_err(|e| CoreError::git("读取分支失败", e))?.flatten() {
            if b.name().ok().flatten() == Some(current.as_str()) {
                continue;
            }
            if let Some(id) = b.get().target()
                && let Ok(oid) = gix::ObjectId::from_hex(id.to_string().as_bytes())
                && let Some(&r) = self.index.get(&oid)
            {
                tips.push(r);
            }
        }
        let others = self.reach(tips);
        let mut out = Vec::new();
        let mut cur = self.head_row();
        while let Some(r) = cur {
            let ps = &self.parents[r as usize];
            if ps.len() != 1 || others[r as usize] {
                break;
            }
            out.push(r);
            cur = ps.first().copied();
        }
        Ok(out)
    }

    /// The rebaseable range (spec §9.1). With `from`, only the stretch from it to the latest commit.
    pub fn rebase_range(&self, from: Option<&str>) -> Result<RebaseRange> {
        let rows = self.rebase_rows()?;
        let rows: Vec<u32> = match from {
            None => rows,
            Some(id) => {
                let r = self.row_of(id)?;
                let k = rows.iter().position(|&x| x == r).ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "这个提交不在可以整理的范围里"))?;
                rows[..=k].to_vec()
            }
        };
        let commits: Vec<RangeCommit> = self
            .commits_at(rows.iter().rev().copied())?
            .into_iter()
            .map(|c| RangeCommit { pushed: !c.unpushed, id: c.id, title: c.title, body: c.body, author: c.author.name, time: c.time })
            .collect();
        let has_pushed = commits.iter().any(|c| c.pushed);
        Ok(RebaseRange { commits, has_pushed })
    }

    /// Rebase by steps (spec §9.2). `steps` are in the new order, oldest first, and must cover exactly one contiguous stretch from some commit to the latest.
    pub fn rebase_apply(&self, steps: &[Step]) -> Result<RebaseResult> {
        if self.state()?.state != RepoMode::Normal {
            return Err(CoreError::new(ErrorCode::MergeInProgress, "合并或变基还没完成，先完成或中止"));
        }
        let rows = self.rebase_rows()?;
        let ids: Vec<String> = rows.iter().map(|&r| self.ids[r as usize].to_string()).collect();
        let n = steps.len();
        if n == 0 || n > ids.len() {
            return Err(CoreError::new(ErrorCode::InvalidRange, "要整理的提交不在可以整理的范围里"));
        }
        // ids are newest first; the first n are the stretch to rebase
        let mut want: Vec<&str> = ids[..n].iter().map(String::as_str).collect();
        let mut got: Vec<&str> = steps.iter().map(|s| s.id.as_str()).collect();
        want.sort_unstable();
        got.sort_unstable();
        if want != got {
            return Err(CoreError::new(ErrorCode::InvalidRange, "要整理的提交必须是从某个提交到最新提交的连续一段"));
        }
        let base = format!("{}^", ids[n - 1]);
        let after = count_after(steps);

        // Drop everything: the branch goes back to before the range
        if steps.iter().all(|s| s.action == StepAction::Drop) {
            git_cli::run(self.path(), &["rebase", "--autostash", "--onto", &base, "HEAD"], None).map_err(|e| self.stopped(e))?;
            return Ok(RebaseResult { before: n, after: 0 });
        }

        let todo = todo_lines(steps, &self.git2()?.path().join("strand"))?;
        self.run_todo(&base, &todo)?;
        Ok(RebaseResult { before: n, after })
    }

    /// Fixup / Squash Into (spec §9.3): fold selected worktree changes into a commit, keeping the later commits.
    /// With `message`, also replace that commit's message (Squash Into).
    pub fn commit_fixup(&self, id: &str, selection: &Selection, message: Option<&str>) -> Result<()> {
        let range = self.rebase_range(Some(id))?;
        if range.commits.first().is_some_and(|c| c.pushed) || range.has_pushed {
            return Err(CoreError::new(ErrorCode::AlreadyPushed, "这个提交或它之后的提交已经推送，不能并入"));
        }
        if message.is_some_and(|m| m.trim().is_empty()) {
            return Err(CoreError::new(ErrorCode::EmptyMessage, "提交说明不能为空"));
        }
        // First commit the selected changes as a temporary commit, then fold it into the target during the rebase
        let title = range.commits.first().map(|c| c.title.clone()).unwrap_or_default();
        let tmp = self.commit_create(&format!("fixup! {title}"), selection, false, None)?;
        let mut steps: Vec<Step> = Vec::new();
        for c in &range.commits {
            steps.push(Step { id: c.id.clone(), action: StepAction::Pick, message: None });
            if c.id == id {
                steps.push(Step { id: tmp.clone(), action: StepAction::Fixup, message: None });
                if let Some(m) = message {
                    steps.last_mut().expect("刚放进去").message = Some(m.to_string());
                }
            }
        }
        let base = format!("{id}^");
        let todo = todo_lines(&steps, &self.git2()?.path().join("strand"))?;
        match self.run_todo(&base, &todo) {
            Ok(()) => Ok(()),
            Err(e) if e.code == ErrorCode::Conflicts => Err(e),
            Err(e) => {
                // The rebase failed before starting: undo the temporary commit and put the changes back in the worktree
                if self.state()?.state == RepoMode::Normal {
                    let _ = git_cli::run(self.path(), &["reset", "--soft", "HEAD~1"], None);
                }
                Err(e)
            }
        }
    }

    /// Replace the message of an earlier commit (spec §5.6): replay from it, keeping later commits as they are. Availability is checked by the caller first.
    pub(crate) fn reword_earlier(&self, id: &str, message: &str) -> Result<()> {
        let range = self.rebase_range(Some(id))?;
        let full = range.commits.first().map(|c| c.id.clone()).ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "这个提交不在可以整理的范围里"))?;
        let steps: Vec<Step> = range
            .commits
            .iter()
            .map(|c| Step { id: c.id.clone(), action: StepAction::Pick, message: (c.id == full).then(|| message.to_string()) })
            .collect();
        let todo = todo_lines(&steps, &self.git2()?.path().join("strand"))?;
        self.run_todo(&format!("{full}^"), &todo)
    }

    fn run_todo(&self, base: &str, todo: &str) -> Result<()> {
        let dir = self.git2()?.path().join("strand");
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::git("准备整理失败", e))?;
        let file = dir.join("rebase-todo");
        std::fs::write(&file, todo).map_err(|e| CoreError::git("准备整理失败", e))?;
        // git runs the editor command with sh and appends the todo file path; on Windows, Git for Windows ships sh and cp too
        let path = file.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
        let editor = format!("cp '{path}'");
        let r = git_cli::run_env(
            self.path(),
            &["-c", "rebase.abbreviateCommands=false", "rebase", "-i", "--autostash", "--keep-empty", base],
            None,
            &[("GIT_SEQUENCE_EDITOR", &editor)],
        );
        let _ = std::fs::remove_file(&file);
        // Temporary file for the new message: the rebase still needs it if it stops on conflicts; cleaned up when finished
        if r.is_ok()
            && let Ok(list) = std::fs::read_dir(&dir)
        {
            for f in list.flatten().filter(|f| f.file_name().to_string_lossy().starts_with("rebase-msg-")) {
                let _ = std::fs::remove_file(f.path());
            }
        }
        r.map(|_| ()).map_err(|e| self.stopped(e))
    }

    /// The rebase stopped: returns `CONFLICTS` on conflicts and the UI enters conflict resolution
    fn stopped(&self, e: CoreError) -> CoreError {
        if self.state().map(|s| s.state != RepoMode::Normal).unwrap_or(false) {
            return CoreError::new(ErrorCode::Conflicts, "整理时有冲突需要解决").with_detail(e.detail.unwrap_or_default());
        }
        let text = e.detail.as_ref().map(|d| d.to_string()).unwrap_or_default();
        if text.contains("would be overwritten") {
            return CoreError::new(ErrorCode::WorktreeConflict, "工作区里有会被覆盖的改动，先提交或贮藏").with_detail(e.detail.unwrap_or_default());
        }
        e
    }
}

/// Commits left after the rebase: each kept one counts, and a squash on the first line counts as keep
fn count_after(steps: &[Step]) -> usize {
    let mut n = 0;
    for s in steps {
        match s.action {
            StepAction::Pick => n += 1,
            StepAction::Squash | StepAction::Fixup if n == 0 => n += 1,
            _ => {}
        }
    }
    n
}

/// The rebase todo list. If the first non-drop step is a squash, treat it as keep.
/// Replacement messages are written to files under `dir` and read by `exec git commit --amend -F`.
fn todo_lines(steps: &[Step], dir: &std::path::Path) -> Result<String> {
    let mut out = String::new();
    let mut kept = false;
    for s in steps {
        if !s.id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CoreError::new(ErrorCode::InvalidRange, "提交编号不对"));
        }
        let verb = match s.action {
            StepAction::Drop => "drop",
            StepAction::Pick => "pick",
            StepAction::Squash if kept => "squash",
            StepAction::Fixup if kept => "fixup",
            _ => "pick",
        };
        if verb != "drop" {
            kept = true;
        }
        out.push_str(&format!("{verb} {}\n", s.id));
        if let Some(m) = &s.message
            && verb != "drop"
        {
            // Replace the message: write it to a file for git commit --amend (the todo list is one entry per line and can't hold multi-line messages)
            std::fs::create_dir_all(dir).map_err(|e| CoreError::git("准备整理失败", e))?;
            let f = dir.join(format!("rebase-msg-{}", s.id));
            std::fs::write(&f, m).map_err(|e| CoreError::git("准备整理失败", e))?;
            let path = f.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
            out.push_str(&format!("exec git commit --amend --only --allow-empty --no-verify --quiet -F '{path}'\n"));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(id: &str, a: StepAction) -> Step {
        Step { id: id.into(), action: a, message: None }
    }

    #[test]
    fn todo_and_count() {
        let steps = vec![st("aa", StepAction::Squash), st("bb", StepAction::Pick), st("cc", StepAction::Squash), st("dd", StepAction::Drop)];
        let dir = std::env::temp_dir();
        assert_eq!(todo_lines(&steps, &dir).unwrap(), "pick aa\npick bb\nsquash cc\ndrop dd\n");
        assert_eq!(count_after(&steps), 2);
        assert!(todo_lines(&[st("x;rm", StepAction::Pick)], &dir).is_err());
    }
}
