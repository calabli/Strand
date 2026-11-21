//! Bisect (git bisect): mark one "bad" commit (has the problem) and one "good" commit (doesn't),
//! Git checks out a commit in between each time for you to test and mark good or bad, and after a few steps finds the first bad commit.
//! All state lives in Git's own files (refs/bisect/*, BISECT_START), so a bisect started on the command line can be continued here.

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
    /// The branch (or commit) before starting; we return here at the end
    pub start: String,
    pub bad: Option<String>,
    pub good: Vec<String>,
    pub skipped: Vec<String>,
    /// The commit currently checked out, waiting to be tested
    pub current: Option<String>,
    /// How many commits could still be the first bad one after testing this one
    pub remaining: Option<u32>,
    /// Roughly how many steps are left
    pub steps: Option<u32>,
    /// Found: the first bad commit
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
                // Only the bad one is left: it is the first bad commit
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

    /// Mark a commit (the currently checked-out one if not given). Starts the bisect first if it hasn't started.
    pub fn bisect_mark(&self, mark: BisectMark, rev: Option<&str>) -> Result<BisectStatus> {
        let repo = self.git2()?;
        if let Some(r) = rev
            && repo.revparse_single(r).and_then(|o| o.peel_to_commit()).is_err()
        {
            return Err(CoreError::new(ErrorCode::NotFound, format!("找不到提交 {r}")));
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

    /// End the bisect and return to the branch from before it started
    pub fn bisect_reset(&self) -> Result<()> {
        git_cli::run(self.path(), &["bisect", "reset"], None).map(|_| ())
    }
}
