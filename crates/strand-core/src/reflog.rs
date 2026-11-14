//! 操作记录（reflog）：HEAD 或某个本地分支指向过哪些提交，从新到旧。
//! 用来找回误删的分支、重置或变基前的提交；Strand 自己的撤销覆盖不到的（命令行里做的、超过 200 步的）也能在这里找到。

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::repo::Session;

/// 最多读这么多条
pub const MAX_ENTRIES: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct ReflogEntry {
    /// HEAD@{n} 里的 n
    pub index: usize,
    /// 这一步之后指向的提交
    pub id: String,
    /// 这一步之前指向的提交（第一步是全 0）
    pub old_id: String,
    /// 动作，如 commit、checkout、reset、merge origin/main、rebase (finish)
    pub action: String,
    /// 冒号后面的说明，如 moving from main to dev
    pub message: String,
    pub time: i64,
    /// 提交的标题；提交已经不在仓库里时为空
    pub title: String,
    /// 提交还在仓库里（没被清理掉）
    pub exists: bool,
    /// 提交在日志里（能在日志里定位）
    pub in_log: bool,
}

impl Session {
    /// 有操作记录的引用：HEAD 在前，然后是本地分支（按名字）
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

    /// 某个引用的操作记录，从新到旧。`name` 是 HEAD 或本地分支名。
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
