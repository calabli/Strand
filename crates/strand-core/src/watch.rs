//! 文件监听：仓库变化后告诉外壳该刷新哪些区域（说明书 2.2 的 `repo_changed`）。
//!
//! - `.git` 里的 HEAD、引用、合并或变基状态文件变了 → `Refs`
//! - `.git/index` 或工作区文件变了 → `Status`
//! - 贮藏（`refs/stash`）变了 → `Stash`；暂存架（`.git/strand/shelf/`）变了 → `Shelf`
//! - 被 `.gitignore` 忽略的文件（如 `target/`、`node_modules/`）不触发
//!
//! 事件在 100 ms 内合并成一次，避免 `git checkout` 这类操作触发成百上千次刷新
//! （说明书 15 要求文件变化后 300 ms 内反映到提交面板，合并时间不能占太多）。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};

use crate::error::{CoreError, Result};
use crate::model::ChangeScope;

pub const DEBOUNCE: Duration = Duration::from_millis(100);

/// 持有它就一直在监听，丢掉就停止。
pub struct Watcher {
    _inner: Debouncer<notify::RecommendedWatcher>,
}

/// 开始监听 `root`（仓库工作区根目录）。`on_change` 在后台线程被调用。
pub fn watch(root: &Path, on_change: impl Fn(Vec<ChangeScope>) + Send + 'static) -> Result<Watcher> {
    let root = root.to_path_buf();
    let git_dir = git2::Repository::open(&root)
        .map(|r| r.path().to_path_buf())
        .unwrap_or_else(|_| root.join(".git"));
    let r2 = root.clone();
    let mut deb = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let repo = git2::Repository::open(&r2).ok();
        let mut scopes = BTreeSet::new();
        for e in events {
            if let Some(s) = classify(&r2, &git_dir, &e.path, repo.as_ref()) {
                scopes.insert(s);
            }
        }
        if !scopes.is_empty() {
            on_change(scopes.into_iter().collect());
        }
    })
    .map_err(|e| CoreError::git("启动文件监听失败", e))?;
    deb.watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| CoreError::git("启动文件监听失败", e))?;
    Ok(Watcher { _inner: deb })
}

pub(crate) fn classify(root: &Path, git_dir: &Path, path: &Path, repo: Option<&git2::Repository>) -> Option<ChangeScope> {
    // macOS 上监听到的路径可能带 /private 前缀，统一规范化后再比较
    let path = canonical(path);
    let git_dir = canonical(git_dir);
    if let Ok(rel) = path.strip_prefix(&git_dir) {
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel.ends_with(".lock") {
            return None;
        }
        return match rel.as_str() {
            "index" => Some(ChangeScope::Status),
            // ORIG_HEAD 不在日志里（git reset、git stash 都会改它），不用刷新
            "HEAD" | "packed-refs" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" => {
                Some(ChangeScope::Refs)
            }
            // 操作日志的快照引用，不影响日志
            r if r.starts_with("refs/strand/") => None,
            // 贮藏不在日志里，只刷新贮藏列表
            "refs/stash" | "logs/refs/stash" => Some(ChangeScope::Stash),
            r if r.starts_with("strand/shelf/") => Some(ChangeScope::Shelf),
            r if r.starts_with("refs/") || r.starts_with("rebase-merge") || r.starts_with("rebase-apply") => {
                Some(ChangeScope::Refs)
            }
            _ => None,
        };
    }
    let root = canonical(root);
    let rel = path.strip_prefix(&root).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    if let Some(repo) = repo
        && repo.status_should_ignore(rel).unwrap_or(false)
    {
        return None;
    }
    Some(ChangeScope::Status)
}

fn canonical(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    // 文件已被删除时 canonicalize 会失败，改为规范化它的上级目录
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => canonical(parent).join(name),
        _ => p.to_path_buf(),
    }
}
