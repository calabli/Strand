//! 整理提交（说明书第 9 节）：交互式变基。
//!
//! 核心层自己写好变基的待办列表，通过 `GIT_SEQUENCE_EDITOR` 交给 git，不弹编辑器。
//! 重放中有冲突时仓库停在变基状态，界面进入冲突解决（第 8 节）；整个整理在操作日志里算一步。
//!
//! 可整理范围：从当前分支最新提交沿第一父提交往回走，遇到合并提交、根提交、
//! 或者另一个本地分支也能到达的提交（另一个分支指向它，或它在分叉点之前）就停。

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
    /// 已经推送（整理后需要强制推送）
    pub pushed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RebaseRange {
    /// 从旧到新
    pub commits: Vec<RangeCommit>,
    pub has_pushed: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepAction {
    /// 保留
    Pick,
    /// 并入上一个被保留的提交，说明追加到它的正文
    Squash,
    /// 并入上一个被保留的提交，说明丢掉（Fixup 用）
    Fixup,
    Drop,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Step {
    pub id: String,
    pub action: StepAction,
    /// 换成这段说明（Squash Into 用）；只对保留的提交有效
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RebaseResult {
    /// 整理前的提交数
    pub before: usize,
    /// 整理后的提交数
    pub after: usize,
}

impl Session {
    /// 最大可整理范围的行号，从新到旧
    pub(crate) fn rebase_rows(&self) -> Result<Vec<u32>> {
        let st = self.state()?;
        if st.head.kind != HeadKind::Branch {
            return Err(CoreError::new(ErrorCode::InvalidRange, "现在不在任何分支上"));
        }
        let repo = self.git2()?;
        let current = st.head.branch.unwrap_or_default();
        // 其他本地分支能到达的提交
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

    /// 可整理范围（说明书 9.1）。`from` 给出时只返回从它到最新提交的一段。
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

    /// 按步骤整理（说明书 9.2）。`steps` 按新的顺序从旧到新排列，必须恰好覆盖从某个提交到最新提交的连续一段。
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
        // ids 从新到旧，前 n 个就是要整理的一段
        let mut want: Vec<&str> = ids[..n].iter().map(String::as_str).collect();
        let mut got: Vec<&str> = steps.iter().map(|s| s.id.as_str()).collect();
        want.sort_unstable();
        got.sort_unstable();
        if want != got {
            return Err(CoreError::new(ErrorCode::InvalidRange, "要整理的提交必须是从某个提交到最新提交的连续一段"));
        }
        let base = format!("{}^", ids[n - 1]);
        let after = count_after(steps);

        // 全部丢弃：分支退回到范围之前
        if steps.iter().all(|s| s.action == StepAction::Drop) {
            git_cli::run(self.path(), &["rebase", "--autostash", "--onto", &base, "HEAD"], None).map_err(|e| self.stopped(e))?;
            return Ok(RebaseResult { before: n, after: 0 });
        }

        let todo = todo_lines(steps, &self.git2()?.path().join("strand"))?;
        self.run_todo(&base, &todo)?;
        Ok(RebaseResult { before: n, after })
    }

    /// Fixup / Squash Into（说明书 9.3）：把工作区里选中的改动并入某个提交，之后的提交保留。
    /// `message` 给出时同时把那个提交的说明换掉（Squash Into）。
    pub fn commit_fixup(&self, id: &str, selection: &Selection, message: Option<&str>) -> Result<()> {
        let range = self.rebase_range(Some(id))?;
        if range.commits.first().is_some_and(|c| c.pushed) || range.has_pushed {
            return Err(CoreError::new(ErrorCode::AlreadyPushed, "这个提交或它之后的提交已经推送，不能并入"));
        }
        if message.is_some_and(|m| m.trim().is_empty()) {
            return Err(CoreError::new(ErrorCode::EmptyMessage, "提交说明不能为空"));
        }
        // 先把选中的改动提交成一个临时提交，再在整理时并到目标提交里
        let title = range.commits.first().map(|c| c.title.clone()).unwrap_or_default();
        let tmp = self.commit_create(&format!("fixup! {title}"), selection, false)?;
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
                // 整理没开始就失败了：把临时提交撤掉，改动放回工作区
                if self.state()?.state == RepoMode::Normal {
                    let _ = git_cli::run(self.path(), &["reset", "--soft", "HEAD~1"], None);
                }
                Err(e)
            }
        }
    }

    /// 换掉一个更早的提交的说明（说明书 5.6）：从它开始重放，它之后的提交原样保留。可用条件由调用方先检查。
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
        // git 用 sh 运行编辑器命令并把待办文件路径接在后面；Windows 上 Git for Windows 也带 sh 和 cp
        let path = file.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
        let editor = format!("cp '{path}'");
        let r = git_cli::run_env(
            self.path(),
            &["-c", "rebase.abbreviateCommands=false", "rebase", "-i", "--autostash", "--keep-empty", base],
            None,
            &[("GIT_SEQUENCE_EDITOR", &editor)],
        );
        let _ = std::fs::remove_file(&file);
        // 换说明用的临时文件：停在冲突时变基还要用，完成后再清掉
        if r.is_ok()
            && let Ok(list) = std::fs::read_dir(&dir)
        {
            for f in list.flatten().filter(|f| f.file_name().to_string_lossy().starts_with("rebase-msg-")) {
                let _ = std::fs::remove_file(f.path());
            }
        }
        r.map(|_| ()).map_err(|e| self.stopped(e))
    }

    /// 变基停下来了：有冲突时返回 `CONFLICTS`，界面进入冲突解决
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

/// 整理后剩下几个提交：保留的算一个，第一行的“并入”按保留算
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

/// 变基待办列表。第一个不是丢弃的步骤如果是“并入”，按保留处理。
/// 要换的说明写进 `dir` 下的文件，由 `exec git commit --amend -F` 读取。
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
            // 换说明：写进文件交给 git commit --amend（待办列表一行一条，放不下多行说明）
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
