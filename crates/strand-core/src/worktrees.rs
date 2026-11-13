//! 工作目录（git worktree，说明书 6.6）：同一个仓库在另一个文件夹里同时检出另一个分支。
//!
//! 列表来自 `git worktree list --porcelain`，新建和移除调用系统 git。
//! 新建、移除只记在操作时间线里，不能撤销（工作目录不是引用，快照恢复不了）。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::Session;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Worktree {
    pub path: String,
    /// 检出的分支；分离头指针时为空
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// 当前提交（空仓库时为空）
    pub head: String,
    /// 仓库的主工作目录（不能移除）
    pub is_main: bool,
    /// 就是现在打开的这个
    pub is_current: bool,
    pub locked: bool,
    /// 文件夹已经不在了（可以清理）
    pub prunable: bool,
}

/// 规范化路径（macOS 上 /var 是 /private/var 的链接）；文件夹已经不在时规范化它的上级再接上名字
fn norm(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    match (p.parent().and_then(|d| d.canonicalize().ok()), p.file_name()) {
        (Some(d), Some(n)) => d.join(n),
        _ => p.to_path_buf(),
    }
}

/// 解析 `git worktree list --porcelain`
pub fn parse_list(text: &str, current: &Path) -> Vec<Worktree> {
    let cur = norm(current);
    let mut out = Vec::new();
    for block in text.split("\n\n") {
        let mut w = Worktree { path: String::new(), branch: None, head: String::new(), is_main: out.is_empty(), is_current: false, locked: false, prunable: false };
        let mut bare = false;
        for line in block.lines() {
            let (k, v) = line.split_once(' ').unwrap_or((line, ""));
            match k {
                "worktree" => w.path = v.to_string(),
                "HEAD" => w.head = v.to_string(),
                "branch" => w.branch = Some(v.strip_prefix("refs/heads/").unwrap_or(v).to_string()),
                "locked" => w.locked = true,
                "prunable" => w.prunable = true,
                "bare" => bare = true,
                _ => {}
            }
        }
        if w.path.is_empty() || bare {
            continue;
        }
        w.is_current = norm(Path::new(&w.path)) == cur;
        out.push(w);
    }
    out
}

impl Session {
    pub fn worktree_list(&self) -> Result<Vec<Worktree>> {
        let text = git_cli::run(self.path(), &["worktree", "list", "--porcelain"], None)?;
        Ok(parse_list(&text, self.path()))
    }

    /// 新建工作目录。`new_branch` 为真时以 `base`（为空则当前位置）新建分支 `branch` 再检出。
    pub fn worktree_add(&self, path: &str, branch: &str, new_branch: bool, base: Option<&str>) -> Result<()> {
        let p = Path::new(path.trim());
        if !p.is_absolute() {
            return Err(CoreError::new(ErrorCode::InvalidName, "请选择一个完整的文件夹路径"));
        }
        if p.exists() && std::fs::read_dir(p).map(|mut d| d.next().is_some()).unwrap_or(true) {
            return Err(CoreError::new(ErrorCode::InvalidName, format!("{} 已经存在而且不是空文件夹", p.display())));
        }
        let ps = p.to_string_lossy().to_string();
        let r = if new_branch {
            if branch.trim().is_empty() || git_cli::run(self.path(), &["check-ref-format", "--branch", branch], None).is_err() {
                return Err(CoreError::new(ErrorCode::InvalidName, format!("“{branch}”不能作为分支名")));
            }
            let mut args = vec!["worktree", "add", "-b", branch, ps.as_str()];
            if let Some(b) = base.filter(|b| !b.is_empty()) {
                args.push(b);
            }
            git_cli::run(self.path(), &args, None)
        } else {
            git_cli::run(self.path(), &["worktree", "add", ps.as_str(), branch], None)
        };
        r.map(|_| ()).map_err(|e| checked_out_elsewhere(e, branch))
    }

    /// 移除工作目录。里面有未提交的改动（包括未跟踪文件）时不加 `force` 返回 `WORKTREE_CONFLICT`，
    /// `detail.files` 是改动的文件数。文件夹已经不在时只清理记录。
    pub fn worktree_remove(&self, path: &str, force: bool) -> Result<()> {
        let list = self.worktree_list()?;
        let target = norm(Path::new(path));
        let w = list
            .iter()
            .find(|w| norm(Path::new(&w.path)) == target)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "没有找到这个工作目录"))?;
        if w.is_main {
            return Err(CoreError::new(ErrorCode::InvalidRange, "主工作目录不能移除"));
        }
        if w.is_current {
            return Err(CoreError::new(ErrorCode::InvalidRange, "不能移除现在打开的工作目录，先打开主仓库"));
        }
        if !Path::new(&w.path).exists() {
            git_cli::run(self.path(), &["worktree", "prune"], None)?;
            return Ok(());
        }
        if !force {
            let st = git_cli::run(Path::new(&w.path), &["status", "--porcelain"], None).unwrap_or_default();
            let n = st.lines().filter(|l| !l.is_empty()).count();
            if n > 0 {
                return Err(CoreError::new(ErrorCode::WorktreeConflict, format!("这个工作目录里还有 {n} 个文件的改动没有提交，移除后会丢失"))
                    .with_detail(serde_json::json!({ "files": n })));
            }
        }
        let mut args = vec!["worktree", "remove"];
        if force {
            // 两次 --force 连锁定的也移除
            args.extend(["--force", "--force"]);
        }
        args.push(&w.path);
        git_cli::run(self.path(), &args, None).map(|_| ())
    }
}

/// git 报“分支已经在别的工作目录检出”时换成好懂的说明
pub(crate) fn checked_out_elsewhere(e: CoreError, branch: &str) -> CoreError {
    let stderr = e.detail.as_ref().and_then(|d| d.get("stderr")).and_then(|s| s.as_str()).unwrap_or("").to_string();
    // git 2.40 以后：“'x' is already used by worktree at '/p'”；更早：“'x' is already checked out at '/p'”
    for key in ["is already used by worktree at '", "is already checked out at '"] {
        if let Some(i) = stderr.find(key) {
            let rest = &stderr[i + key.len()..];
            let at = rest.split('\'').next().unwrap_or("");
            return CoreError::new(ErrorCode::InvalidRange, format!("分支 {branch} 已经在工作目录 {at} 里检出，同一个分支不能同时检出两次"))
                .with_detail(serde_json::json!({ "worktree": at }));
        }
    }
    if stderr.contains("a branch named") && stderr.contains("already exists") {
        return CoreError::new(ErrorCode::InvalidName, format!("分支 {branch} 已经存在"));
    }
    if stderr.contains("invalid reference") {
        return CoreError::new(ErrorCode::NotFound, format!("没有找到分支 {branch}"));
    }
    e
}
