//! File watching: tells the shell which areas to refresh after the repository changes (`repo_changed` in spec §2.2).
//!
//! - HEAD, refs, merge or rebase state files in `.git` changed → `Refs`
//! - `.git/index` or worktree files changed → `Status`
//! - Stash (`refs/stash`) changed → `Stash`; shelf (`.git/strand/shelf/`) changed → `Shelf`
//! - Files ignored by `.gitignore` (e.g. `target/`, `node_modules/`) don't trigger
//!
//! Events are coalesced within 100 ms so operations like `git checkout` don't trigger hundreds of refreshes
//! (spec §15 requires file changes to show in the commit panel within 300 ms, so coalescing can't take too long).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};

use crate::error::{CoreError, Result};
use crate::model::ChangeScope;

pub const DEBOUNCE: Duration = Duration::from_millis(100);

/// Watching continues while this is held and stops when dropped.
pub struct Watcher {
    _inner: Debouncer<notify::RecommendedWatcher>,
}

/// Start watching `root` (the repository's worktree root). `on_change` is called on a background thread.
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
    // On macOS watched paths may carry a /private prefix; normalize before comparing
    let path = canonical(path);
    let git_dir = canonical(git_dir);
    if let Ok(rel) = path.strip_prefix(&git_dir) {
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel.ends_with(".lock") {
            return None;
        }
        return match rel.as_str() {
            "index" => Some(ChangeScope::Status),
            // ORIG_HEAD isn't in the log (git reset and git stash both change it); no refresh needed
            "HEAD" | "packed-refs" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" => {
                Some(ChangeScope::Refs)
            }
            // Op log snapshot refs; they don't affect the log
            r if r.starts_with("refs/strand/") => None,
            // Stashes aren't in the log; only refresh the stash list
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
    // canonicalize fails for deleted files; normalize the parent directory instead
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => canonical(parent).join(name),
        _ => p.to_path_buf(),
    }
}
