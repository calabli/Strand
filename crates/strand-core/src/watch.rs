//! File watching: tells the shell which areas to refresh after the repository changes (`repo_changed` in spec §2.2).
//!
//! - HEAD, refs, merge or rebase state files in `.git` changed → `Refs`
//! - `.git/index` or worktree files changed → `Status`
//! - Stash (`refs/stash`) changed → `Stash`; shelf (`.git/strand/shelf/`) changed → `Shelf`
//! - Files ignored by `.gitignore` (e.g. `target/`, `node_modules/`) don't trigger
//!
//! A linked worktree (`git worktree add`) keeps its git data outside its folder: HEAD, index, rebase state and the
//! shelf in its own git dir (`<main>/.git/worktrees/<name>`), branches, tags and stashes in the shared git dir
//! (`<main>/.git`). Both are watched too, or a commit or checkout made in a terminal there would go unnoticed.
//! From the shared dir only refs count: the main worktree's HEAD and index there belong to another checkout.
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

/// The git dirs of the watched worktree, canonical. For the main worktree both are the same.
pub(crate) struct GitDirs {
    /// This worktree's own: HEAD, index, rebase state, shelf
    pub own: PathBuf,
    /// Shared by all worktrees: branches, tags, stashes
    pub common: PathBuf,
}

/// Start watching `root` (the repository's worktree root). `on_change` is called on a background thread.
pub fn watch(root: &Path, on_change: impl Fn(Vec<ChangeScope>) + Send + 'static) -> Result<Watcher> {
    let root = canonical(root);
    let dirs = match git2::Repository::open(&root) {
        Ok(r) => GitDirs { own: canonical(r.path()), common: canonical(r.commondir()) },
        Err(_) => GitDirs { own: root.join(".git"), common: root.join(".git") },
    };
    let failed = |e| CoreError::git("启动文件监听失败", e);
    // What lies outside the worktree folder needs its own watch (a linked worktree's git dirs)
    let own_outside = !dirs.own.starts_with(&root);
    let common_outside = !dirs.common.starts_with(&root);
    let (own, common) = (dirs.own.clone(), dirs.common.clone());
    let r2 = root.clone();
    let mut deb = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let repo = git2::Repository::open(&r2).ok();
        let mut scopes = BTreeSet::new();
        for e in events {
            if let Some(s) = classify(&r2, &dirs, &e.path, repo.as_ref()) {
                scopes.insert(s);
            }
        }
        if !scopes.is_empty() {
            on_change(scopes.into_iter().collect());
        }
    })
    .map_err(failed)?;
    let w = deb.watcher();
    w.watch(&root, RecursiveMode::Recursive).map_err(failed)?;
    if own_outside {
        w.watch(&own, RecursiveMode::Recursive).map_err(failed)?;
    }
    if common_outside {
        // Only refs from here: packed-refs at the top and the refs folder, not objects/ or other worktrees' files
        w.watch(&common, RecursiveMode::NonRecursive).map_err(failed)?;
        w.watch(&common.join("refs"), RecursiveMode::Recursive).map_err(failed)?;
    }
    Ok(Watcher { _inner: deb })
}

pub(crate) fn classify(root: &Path, dirs: &GitDirs, path: &Path, repo: Option<&git2::Repository>) -> Option<ChangeScope> {
    // On macOS watched paths may carry a /private prefix; normalize before comparing
    let path = canonical(path);
    let slash = |rel: &Path| rel.to_string_lossy().replace('\\', "/");
    // A linked worktree's own dir lies inside the shared one, so it's checked first
    if let Ok(rel) = path.strip_prefix(&dirs.own) {
        return git_scope(&slash(rel), true, dirs.own == dirs.common);
    }
    if let Ok(rel) = path.strip_prefix(&dirs.common) {
        return git_scope(&slash(rel), false, true);
    }
    let rel = path.strip_prefix(root).ok()?;
    // A linked worktree's `.git` is a file pointing at its git dir
    if rel.as_os_str().is_empty() || rel == Path::new(".git") {
        return None;
    }
    if let Some(repo) = repo
        && repo.status_should_ignore(rel).unwrap_or(false)
    {
        return None;
    }
    Some(ChangeScope::Status)
}

/// What a change at `rel` inside a git dir means. `own`: the dir is this worktree's own; `shared`: it's the one shared
/// by all worktrees (both for the main worktree).
fn git_scope(rel: &str, own: bool, shared: bool) -> Option<ChangeScope> {
    if rel.ends_with(".lock") {
        return None;
    }
    match rel {
        "index" if own => Some(ChangeScope::Status),
        // ORIG_HEAD isn't in the log (git reset and git stash both change it); no refresh needed
        "HEAD" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" if own => Some(ChangeScope::Refs),
        r if own && (r.starts_with("rebase-merge") || r.starts_with("rebase-apply")) => Some(ChangeScope::Refs),
        r if own && r.starts_with("strand/shelf/") => Some(ChangeScope::Shelf),
        "packed-refs" if shared => Some(ChangeScope::Refs),
        // Stashes aren't in the log; only refresh the stash list
        "refs/stash" | "logs/refs/stash" if shared => Some(ChangeScope::Stash),
        // Op log snapshot refs; they don't affect the log
        r if r.starts_with("refs/strand/") => None,
        // Branches and tags are shared; per-worktree refs (refs/bisect) are in a linked worktree's own dir
        r if r.starts_with("refs/") => Some(ChangeScope::Refs),
        // Everything else, including other worktrees' files under the shared dir's worktrees/
        _ => None,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use ChangeScope::*;

    #[test]
    fn git_dir_scopes() {
        // Main worktree: one dir that is both
        assert_eq!(git_scope("index", true, true), Some(Status));
        assert_eq!(git_scope("HEAD", true, true), Some(Refs));
        assert_eq!(git_scope("refs/heads/main", true, true), Some(Refs));
        assert_eq!(git_scope("refs/heads/main.lock", true, true), None);
        assert_eq!(git_scope("refs/stash", true, true), Some(Stash));
        assert_eq!(git_scope("refs/strand/ops/1", true, true), None);
        assert_eq!(git_scope("strand/shelf/index.json", true, true), Some(Shelf));
        assert_eq!(git_scope("worktrees/wt/HEAD", true, true), None);
        // A linked worktree's own dir
        assert_eq!(git_scope("HEAD", true, false), Some(Refs));
        assert_eq!(git_scope("index", true, false), Some(Status));
        assert_eq!(git_scope("rebase-merge/done", true, false), Some(Refs));
        assert_eq!(git_scope("refs/bisect/bad", true, false), Some(Refs));
        // The shared dir seen from a linked worktree: the main worktree's HEAD and index aren't ours
        assert_eq!(git_scope("HEAD", false, true), None);
        assert_eq!(git_scope("index", false, true), None);
        assert_eq!(git_scope("packed-refs", false, true), Some(Refs));
        assert_eq!(git_scope("refs/heads/side", false, true), Some(Refs));
        assert_eq!(git_scope("refs/stash", false, true), Some(Stash));
    }
}
