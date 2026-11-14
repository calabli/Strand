//! 二分查找（git bisect）：标出一个“坏”的提交（有问题）和一个“好”的提交（没问题），
//! Git 每次检出中间的一个提交让你测试，标好或坏，几步之后找到第一个出问题的提交。
//! 状态都在 Git 自己的文件里（refs/bisect/*、BISECT_START），命令行里开始的也能接着做。

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::repo::Session;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BisectMark {
    Good,
    Bad,
    Skip,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct BisectStatus {
    pub active: bool,
    /// 开始前在哪个分支（或提交）上，结束时回到这里
    pub start: String,
    pub bad: Option<String>,
    pub good: Vec<String>,
    pub skipped: Vec<String>,
    /// 现在检出的、等着测试的提交
    pub current: Option<String>,
    /// 测完这个之后还剩多少个提交可能是第一个坏的
    pub remaining: Option<u32>,
    /// 大约还要几步
    pub steps: Option<u32>,
    /// 找到了：第一个坏提交
    pub first_bad: Option<String>,
    pub first_bad_title: Option<String>,
}

impl Session {
    pub fn bisect_status(&self) -> Result<BisectStatus> {
        let repo = self.git2()?;
        let start_file = repo.path().join("BISECT_START");
        if !start_file.exists() {
            return Ok(BisectStatus::default());
        }
        let start = std::fs::read_to_string(&start_file).unwrap_or_default().trim().to_string();
        let mut st = BisectStatus { active: true, start, ..Default::default() };
        let refs = git_cli::run(self.path(), &["for-each-ref", "--format=%(refname) %(objectname)", "refs/bisect/"], None)?;
        for l in refs.lines() {
            let Some((name, id)) = l.split_once(' ') else { continue };
            let id = id.to_string();
            match name.strip_prefix("refs/bisect/") {
                Some("bad") => st.bad = Some(id),
                Some(n) if n.starts_with("good-") => st.good.push(id),
                Some(n) if n.starts_with("skip-") => st.skipped.push(id),
                _ => {}
            }
        }
        st.current = repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string());
        if let (Some(bad), false) = (&st.bad, st.good.is_empty()) {
            let mut args = vec!["rev-list".to_string(), "--bisect-vars".into(), bad.clone(), "--not".into()];
            args.extend(st.good.iter().cloned());
            let a: Vec<&str> = args.iter().map(String::as_str).collect();
            if let Ok(out) = git_cli::run(self.path(), &a, None) {
                let var = |k: &str| out.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).map(|v| v.trim_matches('\'').to_string());
                st.remaining = var("bisect_nr").and_then(|v| v.parse().ok());
                st.steps = var("bisect_steps").and_then(|v| v.parse().ok());
                // 只剩坏的那一个：它就是第一个坏提交
                if var("bisect_all").and_then(|v| v.parse::<u32>().ok()) == Some(1) {
                    st.first_bad = Some(bad.clone());
                    st.first_bad_title = repo.find_commit(git2::Oid::from_str(bad).map_err(|e| CoreError::git("读取提交失败", e))?).ok().and_then(|c| c.summary().ok().flatten().map(str::to_string));
                    st.remaining = Some(0);
                    st.steps = Some(0);
                }
            }
        }
        Ok(st)
    }

    /// 标记一个提交（不给就是现在检出的那个）。还没开始时先开始二分查找。
    pub fn bisect_mark(&self, mark: BisectMark, rev: Option<&str>) -> Result<BisectStatus> {
        let repo = self.git2()?;
        if let Some(r) = rev {
            if repo.revparse_single(r).and_then(|o| o.peel_to_commit()).is_err() {
                return Err(CoreError::new(ErrorCode::NotFound, format!("找不到提交 {r}")));
            }
        }
        let active = repo.path().join("BISECT_START").exists();
        if !active {
            if mark == BisectMark::Skip {
                return Err(CoreError::new(ErrorCode::InvalidRange, "还没开始二分查找"));
            }
            if repo.state() != git2::RepositoryState::Clean {
                return Err(CoreError::new(ErrorCode::MergeInProgress, "合并或变基还没完成，先解决冲突或中止"));
            }
            git_cli::run(self.path(), &["bisect", "start"], None)?;
        }
        let word = match mark {
            BisectMark::Good => "good",
            BisectMark::Bad => "bad",
            BisectMark::Skip => "skip",
        };
        let mut args = vec!["bisect", word];
        if let Some(r) = rev {
            args.push(r);
        }
        git_cli::run(self.path(), &args, None).map_err(|e| {
            let text = e.detail.as_ref().map(|d| d.to_string()).unwrap_or_default();
            if text.contains("would be overwritten") {
                CoreError::new(ErrorCode::WorktreeConflict, "工作区里有改动会被下一个要测试的提交覆盖，先提交、搁置或贮藏").with_detail(e.detail.unwrap_or_default())
            } else if text.contains("was both") || text.contains("merge base") && text.contains("bad") {
                CoreError::new(ErrorCode::InvalidRange, "标成好的提交必须在坏的提交之前（是它的祖先）").with_detail(e.detail.unwrap_or_default())
            } else {
                e
            }
        })?;
        self.bisect_status()
    }

    /// 结束二分查找，回到开始前的分支
    pub fn bisect_reset(&self) -> Result<()> {
        git_cli::run(self.path(), &["bisect", "reset"], None).map(|_| ())
    }
}
