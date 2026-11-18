//! Remote operations: fetch, pull, push (spec §7).
//!
//! Everything calls system git; authentication is left to the user's existing SSH keys, credential helpers and system keychain.
//! These functions only need the repository path and don't hold a `Session`, so the UI can still read the log and view diffs during network operations.
//! Multiple remotes are supported: by default the current branch's upstream remote, otherwise origin, otherwise the first one; fetch fetches all remotes.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;

pub const REMOTE: &str = "origin";

/// How long a network operation may go without any output before it times out (spec §7.5: 60 seconds by default).
/// Timed on "no output" rather than total duration, so normal downloads of large repositories aren't misjudged.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Cancellation token. Set when the frontend calls `task_cancel`; the running git process is ended.
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Progress: a line of git output (e.g. "Receiving objects:  45% (450/1000)") and the parsed percentage.
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PullMode {
    Merge,
    Rebase,
}

#[derive(Debug, Clone, Serialize)]
pub struct FetchResult {
    /// After fetching, how many commits the current branch is behind its upstream; 0 without an upstream
    /// 0 when local history rewrote pushed commits (needs a force push)
    pub behind: u32,
    /// Commits newly arrived in this fetch that the current branch doesn't have (difference in behind count before and after)
    pub incoming: u32,
    /// The fetch changed refs (remote branches, tags): the UI uses this to decide whether to re-read the log
    pub refs_changed: bool,
    /// Other remotes that couldn't be fetched (the main one was): name and Git's first error line
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub failed: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PullOutcome {
    /// No new commits on the remote
    #[default]
    UpToDate,
    FastForward,
    Merged,
    Rebased,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PullResult {
    pub outcome: PullOutcome,
    /// Number of commits pulled
    pub incoming: u32,
    /// Where they came from, e.g. origin/main
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// HEAD before and after (for "view the pulled commits")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// What the pull changed in the worktree: files, lines added and deleted
    pub files: u32,
    pub added: u64,
    pub deleted: u64,
}

/// `git diff --shortstat a b` → (files, insertions, deletions)
fn diff_stat(dir: &Path, a: &str, b: &str) -> (u32, u64, u64) {
    let out = git_cli::run(dir, &["diff", "--shortstat", a, b], None).unwrap_or_default();
    let mut r = (0, 0, 0);
    for part in out.split(',') {
        let n: u64 = part.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0);
        if part.contains("file") {
            r.0 = n as u32;
        } else if part.contains("insertion") {
            r.1 = n;
        } else if part.contains("deletion") {
            r.2 = n;
        }
    }
    r
}

fn head_id(dir: &Path) -> Option<String> {
    git_cli::run(dir, &["rev-parse", "HEAD"], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, Serialize)]
pub struct PushCommit {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PushPreview {
    pub branch: String,
    /// Push target, e.g. `origin/main`; when there's no upstream yet, the remote branch about to be created
    pub target: String,
    /// The remote doesn't have this branch yet; pushing creates it and sets it as upstream
    pub new_branch: bool,
    /// Commits to push, newest first
    pub commits: Vec<PushCommit>,
    /// Commits on the remote that we don't have (as of the last fetch)
    pub behind: u32,
    /// All those remote commits have same-content versions locally: local history rewrote pushed commits and needs a force push
    pub needs_force: bool,
    /// Which remote to push to (the upstream's remote when there is one, otherwise the chosen or default one)
    pub remote: String,
    /// All remotes in the repository (with several, a branch without an upstream can choose where to push)
    pub remotes: Vec<String>,
    /// Push only up to this commit (spec §5.6); `commits` contains only it and those before it; commits after it stay unpushed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// When pushing up to a commit, the number of commits after it that stay local
    pub left: u32,
    /// Local tags not yet pushed to origin (based on the remote tags recorded at the last fetch)
    pub unpushed_tags: Vec<String>,
    /// Remote tags were never recorded (never fetched): we don't know which tags are pushed, so `unpushed_tags` is empty
    pub tags_unknown: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PushOptions {
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub tags: bool,
    /// Push only up to this commit (full hash or a resolvable revision)
    #[serde(default)]
    pub to: Option<String>,
    /// Which remote to push to when there's no upstream yet; empty uses the default (origin, or the first one without origin)
    #[serde(default)]
    pub remote: Option<String>,
}

/// Fetch all remotes (just the one if there's only one).
pub fn fetch(dir: &Path, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<FetchResult> {
    fetch_with(dir, false, cancel, progress)
}

/// [`fetch`]; with `main_only`, only the current branch's upstream remote (or origin) — what a pull needs, so another
/// remote being unreachable doesn't stop it. Fetching all remotes goes one by one: when only other remotes fail,
/// the result lists them in `failed`; when the main remote fails, that's the error.
pub fn fetch_with(dir: &Path, main_only: bool, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<FetchResult> {
    let main = default_remote(dir)?;
    let before = behind_upstream(dir);
    let refs_before = ref_list(dir);
    let mut failed = Vec::new();
    run_net(dir, &["fetch", "--progress", "--prune", &main], cancel, progress)?;
    if !main_only {
        for r in remotes(dir).into_iter().filter(|r| *r != main) {
            match run_net(dir, &["fetch", "--progress", "--prune", &r], cancel, progress) {
                Ok(_) => {}
                Err(e) if e.code == ErrorCode::Cancelled => return Err(e),
                Err(e) => failed.push((r, e.message.clone())),
            }
        }
    }
    let refs_changed = ref_list(dir) != refs_before;
    // Also record which tags the remote has (spec §6.5: unpushed tags are marked); failure doesn't affect the fetch result
    if let Ok(out) = run_net(dir, &["ls-remote", "--tags", "--refs", &main], cancel, progress) {
        let tags = out
            .lines()
            .filter_map(|l| l.split_once('\t'))
            .filter_map(|(id, r)| r.strip_prefix("refs/tags/").map(|n| (n.to_string(), id.to_string())))
            .collect();
        save_remote_tags(dir, &tags);
    }
    // When local history rewrote pushed commits, the old remote versions don't count as "new commits to pull" (spec §6.3: behind count shows 0)
    let after = behind_upstream(dir);
    let after = if after > 0 && rewritten(dir, "HEAD", "@{upstream}") { 0 } else { after };
    Ok(FetchResult { behind: after, incoming: after.saturating_sub(before), refs_changed, failed })
}

/// All refs and the commits they point to (to compare before and after fetching)
fn ref_list(dir: &Path) -> String {
    git_cli::run(dir, &["for-each-ref", "--format=%(objectname) %(refname)"], None).unwrap_or_default()
}

/// Clone a remote repository into `dest` (listed as out of scope for 1.0 in spec §17 originally, now added).
/// `dest` doesn't exist or is an empty folder; its parent folder must exist. Half-cloned content is deleted on failure or cancel.
pub fn clone(url: &str, dest: &Path, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    clone_with(url, dest, false, cancel, progress)
}

/// [`clone`]; with `sparse`, a clone for huge repositories: file contents are downloaded when needed
/// (`--filter=blob:none`) and only the files in the root are checked out (`--sparse`), so folders can be chosen afterwards
pub fn clone_with(url: &str, dest: &Path, sparse: bool, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') || url.contains('\n') {
        return Err(CoreError::new(ErrorCode::InvalidName, "请填写仓库地址"));
    }
    if !dest.is_absolute() {
        return Err(CoreError::new(ErrorCode::InvalidName, "请选择一个完整的文件夹路径"));
    }
    let parent = dest.parent().filter(|p| p.is_dir()).ok_or_else(|| CoreError::new(ErrorCode::NotFound, "要放进去的文件夹不存在"))?;
    let existed = dest.exists();
    if existed && std::fs::read_dir(dest).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(CoreError::new(ErrorCode::InvalidName, format!("{} 已经存在而且不是空文件夹", dest.display())));
    }
    let d = dest.to_string_lossy().to_string();
    let mut args = vec!["clone", "--progress"];
    if sparse {
        args.extend(["--filter=blob:none", "--sparse"]);
    }
    args.extend(["--", url, &d]);
    let r = run_net(parent, &args, cancel, progress);
    if r.is_err() {
        if existed {
            if let Ok(rd) = std::fs::read_dir(dest) {
                for e in rd.flatten() {
                    let p = e.path();
                    let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
                }
            }
        } else {
            let _ = std::fs::remove_dir_all(dest);
        }
    } else if let Ok(out) = git_cli::run(dest, &["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)", "refs/tags"], None) {
        // Tags just cloned are all on the remote
        save_remote_tags(dest, &out.lines().filter_map(|l| l.split_once('\0')).map(|(n, id)| (n.to_string(), id.to_string())).collect());
    }
    r.map(|_| ()).map_err(|e| {
        let t = detail_text(&e);
        if e.code == ErrorCode::GitFailed && (t.contains("does not exist") || t.contains("not found") || t.contains("not appear to be a git repository")) {
            CoreError::new(ErrorCode::NotFound, "这个地址没有 Git 仓库，或者没有访问权限").with_detail(e.detail.unwrap_or_default())
        } else {
            e
        }
    })
}

/// Pull the current branch's upstream. Fetch first; do nothing else when the remote has no new commits.
/// Before calling, the UI shelves worktree changes with `Session::pull_shelve` (spec §7.2) and restores them with `pull_unshelve` afterwards;
/// when called directly with worktree changes, git's `--autostash` is the fallback.
/// On conflicts returns `CONFLICTS`, the repository stays in the merge or rebase state, and `detail.files` lists the conflicted files.
pub fn pull(dir: &Path, mode: PullMode, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<PullResult> {
    pull_with(dir, mode, true, cancel, progress)
}

/// Same as [`pull`]; with `fetch` false, skip fetching and merge or rebase onto the upstream as of the last fetch (after confirming in the pull summary panel, spec §7.2)
pub fn pull_with(dir: &Path, mode: PullMode, fetch: bool, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<PullResult> {
    default_remote(dir)?;
    require_normal(dir)?;
    let branch = current_branch(dir)?.ok_or_else(|| {
        CoreError::new(ErrorCode::InvalidRange, "现在不在任何分支上，先切换到一个分支再拉取")
    })?;
    if upstream(dir).is_none() {
        return Err(CoreError::new(ErrorCode::InvalidRange, format!("分支 {branch} 没有跟踪的远程分支，没有可拉取的内容")));
    }
    if fetch {
        let r = upstream_remote(dir).map(Ok).unwrap_or_else(|| default_remote(dir))?;
        run_net(dir, &["fetch", "--progress", "--prune", &r], cancel, progress)?;
    }
    let incoming = behind_upstream(dir);
    if incoming == 0 {
        return Ok(PullResult { outcome: PullOutcome::UpToDate, upstream: upstream(dir), ..Default::default() });
    }
    let before = head_id(dir);
    let ahead = ahead_upstream(dir);
    // Already fetched, so merge/rebase here is local. Use the upstream's name (e.g. origin/main),
    // not @{upstream}: otherwise the merge message and "theirs" in conflicts would say origin/HEAD
    let up_name = upstream(dir).unwrap_or_else(|| "@{upstream}".to_string());
    let upstream_ref = up_name.as_str();
    let args: Vec<&str> = match mode {
        PullMode::Merge => vec!["merge", "--no-edit", "--autostash", upstream_ref],
        PullMode::Rebase => vec!["rebase", "--autostash", upstream_ref],
    };
    match git_cli::run(dir, &args, None) {
        Ok(_) => {
            let outcome = if ahead == 0 {
                PullOutcome::FastForward
            } else if mode == PullMode::Merge {
                PullOutcome::Merged
            } else {
                PullOutcome::Rebased
            };
            let after = head_id(dir);
            let (files, added, deleted) = match (&before, &after) {
                (Some(a), Some(b)) => diff_stat(dir, a, b),
                _ => (0, 0, 0),
            };
            Ok(PullResult { outcome, incoming, upstream: Some(up_name.clone()), from: before, to: after, files, added, deleted })
        }
        Err(e) => {
            let files = conflicted_files(dir);
            if in_progress(dir) && !files.is_empty() {
                Err(CoreError::new(ErrorCode::Conflicts, format!("拉取时有 {} 个文件冲突", files.len()))
                    .with_detail(serde_json::json!({ "files": files, "incoming": incoming, "mode": mode })))
            } else {
                Err(e)
            }
        }
    }
}

/// One conflicted file in the pull summary panel (spec §7.2)
#[derive(Debug, Clone, Serialize)]
pub struct PreviewConflict {
    pub path: String,
    pub kind: crate::conflict::FileKind,
    /// Number of places in a text file where both sides changed the same section; 0 for other kinds
    pub blocks: u32,
    /// Rebase mode: which local commit (title) the first conflict appears in
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// A pull dry run (spec §7.2): merge or rebase in memory using the last fetch's result, without changing the repository.
#[derive(Debug, Clone, Serialize)]
pub struct PullPreview {
    pub branch: String,
    /// The tracked remote branch, e.g. `origin/main`
    pub upstream: String,
    pub mode: PullMode,
    /// Number of commits to pull
    pub incoming: u32,
    /// Number of local-only commits; 0 means a fast-forward with no conflicts
    pub ahead: u32,
    /// Files changed on both sides that merge automatically
    pub auto_merged: u32,
    pub conflicts: Vec<PreviewConflict>,
    /// Number of changes to tracked worktree files (shelved first); filled in by the caller
    pub dirty: u32,
}

/// Dry-run a pull: reads local data only, no network, no repository changes. Remote state is as of the last fetch (the UI fetches first, then calls this).
pub fn pull_preview(dir: &Path, mode: PullMode) -> Result<PullPreview> {
    default_remote(dir)?;
    require_normal(dir)?;
    let branch = current_branch(dir)?.ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "现在不在任何分支上，先切换到一个分支再拉取"))?;
    let up = upstream(dir).ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, format!("分支 {branch} 没有跟踪的远程分支，没有可拉取的内容")))?;
    let (incoming, ahead) = (behind_upstream(dir), ahead_upstream(dir));
    let mut p = PullPreview { branch, upstream: up.clone(), mode, incoming, ahead, auto_merged: 0, conflicts: Vec::new(), dirty: 0 };
    if incoming == 0 || ahead == 0 {
        return Ok(p);
    }
    let g = |e: git2::Error| CoreError::git("预演拉取失败", e);
    let repo = git2::Repository::open(dir).map_err(g)?;
    let head = repo.head().and_then(|h| h.peel_to_commit()).map_err(g)?;
    let theirs = repo.revparse_single(&up).and_then(|o| o.peel_to_commit()).map_err(g)?;
    let base = repo.find_commit(repo.merge_base(head.id(), theirs.id()).map_err(g)?).map_err(g)?;

    match mode {
        PullMode::Merge => {
            let idx = repo.merge_commits(&head, &theirs, None).map_err(g)?;
            collect_conflicts(&repo, &idx, None, &mut p.conflicts);
        }
        PullMode::Rebase => {
            // Same as git rebase: skip merge commits and commits whose changes the remote already has, attaching the rest after the remote commits in order
            let list = git_cli::run(dir, &["rev-list", "--reverse", "--no-merges", "--right-only", "--cherry-pick", &format!("{up}...HEAD")], None)?;
            let mut cur = theirs.tree().map_err(g)?;
            for id in list.lines() {
                let c = repo.find_commit(git2::Oid::from_str(id.trim()).map_err(g)?).map_err(g)?;
                let parent = c.parent(0).and_then(|p| p.tree()).map_err(g)?;
                let mut idx = repo.merge_trees(&parent, &cur, &c.tree().map_err(g)?, None).map_err(g)?;
                if idx.has_conflicts() {
                    let title = String::from_utf8_lossy(c.summary_bytes().unwrap_or_default()).into_owned();
                    collect_conflicts(&repo, &idx, Some(&title), &mut p.conflicts);
                    take_theirs(&mut idx).map_err(g)?;
                }
                cur = repo.find_tree(idx.write_tree_to(&repo).map_err(g)?).map_err(g)?;
            }
        }
    }
    // Files changed on both sides without conflicts
    let changed = |to: &git2::Commit| -> std::collections::HashSet<String> {
        let (Ok(a), Ok(b)) = (base.tree(), to.tree()) else { return Default::default() };
        repo.diff_tree_to_tree(Some(&a), Some(&b), None)
            .map(|d| d.deltas().filter_map(|x| x.new_file().path().or(x.old_file().path()).map(|p| p.to_string_lossy().into_owned())).collect())
            .unwrap_or_default()
    };
    let (mine, other) = (changed(&head), changed(&theirs));
    p.auto_merged = mine.intersection(&other).filter(|f| !p.conflicts.iter().any(|c| &c.path == *f)).count() as u32;
    p.conflicts.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(p)
}

/// Record conflicted files from the in-memory merge result (only the first time for each file)
fn collect_conflicts(repo: &git2::Repository, idx: &git2::Index, commit: Option<&str>, out: &mut Vec<PreviewConflict>) {
    let Ok(cs) = idx.conflicts() else { return };
    let blob = |e: &Option<git2::IndexEntry>| e.as_ref().and_then(|e| repo.find_blob(e.id).ok()).map(|b| b.content().to_vec());
    for c in cs.flatten() {
        let path = [&c.our, &c.their, &c.ancestor].iter().find_map(|e| e.as_ref()).map(|e| String::from_utf8_lossy(&e.path).into_owned()).unwrap_or_default();
        if out.iter().any(|x| x.path == path) {
            continue;
        }
        let (base, ours, theirs) = (blob(&c.ancestor), blob(&c.our), blob(&c.their));
        let (kind, blocks) = crate::conflict::classify(&path, base.as_deref(), ours.as_deref(), theirs.as_deref());
        out.push(PreviewConflict { path, kind, blocks, commit: commit.map(str::to_string) });
    }
}

/// Keep going in the rebase dry run: resolve conflicted files with the local commit's version (only to compute later commits)
fn take_theirs(idx: &mut git2::Index) -> std::result::Result<(), git2::Error> {
    let cs: Vec<git2::IndexConflict> = idx.conflicts()?.flatten().collect();
    for c in cs {
        let Some(path) = [&c.our, &c.their, &c.ancestor].iter().find_map(|e| e.as_ref()).map(|e| e.path.clone()) else { continue };
        idx.conflict_remove(std::path::Path::new(&*String::from_utf8_lossy(&path)))?;
        if let Some(mut t) = c.their {
            t.flags &= !0x3000; // Strip conflict stage markers
            idx.add(&t)?;
        }
    }
    Ok(())
}

/// What the push dialog needs. Reads local data only (remote state as of the last fetch), no network.
/// With `to` set it's "push up to here": only it and the commits before it that need pushing are listed; it must be an unpushed commit.
pub fn push_preview(dir: &Path, to: Option<&str>) -> Result<PushPreview> {
    push_preview_on(dir, to, None)
}

/// Same as [`push_preview`]; `remote` is where to push when there's no upstream yet (empty uses the default)
pub fn push_preview_on(dir: &Path, to: Option<&str>, remote: Option<&str>) -> Result<PushPreview> {
    let mut p = push_preview_all(dir, remote)?;
    let Some(to) = to else { return Ok(p) };
    let full = git_cli::run(dir, &["rev-parse", "--verify", "--quiet", &format!("{to}^{{commit}}")], None)
        .map_err(|_| CoreError::new(ErrorCode::NotFound, format!("找不到 {to}")))?
        .trim()
        .to_string();
    // Of the commits to push (newest first), only those from it onward are pushed
    let k = p
        .commits
        .iter()
        .position(|c| c.id == full)
        .ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "这个提交已经推送，或者不在当前分支上"))?;
    // The list is time-ordered and may contain more than its ancestors: filter again by ancestry
    let ancestors: std::collections::HashSet<String> =
        git_cli::run(dir, &["rev-list", &full], None)?.lines().map(str::to_string).collect();
    let total = p.commits.len();
    p.commits = p.commits.split_off(k).into_iter().filter(|c| ancestors.contains(&c.id)).collect();
    p.left = (total - p.commits.len()) as u32;
    p.to = Some(full);
    Ok(p)
}

fn push_preview_all(dir: &Path, want: Option<&str>) -> Result<PushPreview> {
    let all = remotes(dir);
    let def = default_remote(dir)?;
    let branch = current_branch(dir)?
        .ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "现在不在任何分支上，先切换到一个分支再推送"))?;
    let up = upstream(dir);
    let remote = match (&up, want) {
        (Some(_), _) => upstream_remote(dir).unwrap_or(def),
        (None, Some(w)) if all.iter().any(|r| r == w) => w.to_string(),
        (None, Some(w)) => return Err(CoreError::new(ErrorCode::NotFound, format!("没有叫 {w} 的远程"))),
        (None, None) => def,
    };
    let (target, new_branch, range) = match &up {
        Some(u) => (u.clone(), false, format!("{u}..HEAD")),
        None => (format!("{remote}/{branch}"), true, String::new()),
    };
    let log_args: Vec<&str> = if new_branch {
        // The remote doesn't have this branch yet: push the commits not on any remote branch
        vec!["log", "--format=%H%x00%s", "HEAD", "--not", "--remotes"]
    } else {
        vec!["log", "--format=%H%x00%s", &range]
    };
    let out = git_cli::run(dir, &log_args, None)?;
    let commits = out
        .lines()
        .filter_map(|l| l.split_once('\0'))
        .map(|(id, t)| PushCommit { id: id.to_string(), title: t.to_string() })
        .collect();
    let behind = if new_branch { 0 } else { behind_upstream(dir) };
    // Every remote-only commit has an equivalent local version (git cherry marks "-"): local history rewrote these commits
    let needs_force = behind > 0 && rewritten(dir, "HEAD", "@{upstream}");
    let (unpushed_tags, tags_unknown) = match unpushed_tags(dir) {
        Some(v) => (v, false),
        None => (Vec::new(), true),
    };
    Ok(PushPreview { branch, target, new_branch, commits, behind, needs_force, remote, remotes: all, to: None, left: 0, unpushed_tags, tags_unknown })
}

/// Push the current branch. Force pushes always use `--force-with-lease` (spec §7.3).
/// When rejected returns `PUSH_REJECTED` with `detail.reason` set to `behind`, `needs_force`, `lease_stale`, `protected` or `tag_exists`.
/// With `to` set, push only up to this commit (spec §5.6): can't be combined with a force push, nor used when the remote has new commits.
pub fn push(dir: &Path, opts: &PushOptions, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    if let Some(to) = opts.to.as_deref() {
        return push_to(dir, to, opts.remote.as_deref(), cancel, progress);
    }
    let p = push_preview_on(dir, None, opts.remote.as_deref())?;
    if !opts.force && p.behind > 0 {
        let reason = if p.needs_force { "needs_force" } else { "behind" };
        return Err(rejected(reason));
    }
    let refspec = format!("HEAD:refs/heads/{}", p.target.strip_prefix(&format!("{}/", p.remote)).unwrap_or(&p.branch));
    let mut args = vec!["push", "--progress", "--porcelain"];
    if opts.force {
        args.push("--force-with-lease");
    }
    if p.new_branch {
        args.push("--set-upstream");
    }
    args.push(&p.remote);
    args.push(&refspec);
    run_net(dir, &args, cancel, progress).map_err(classify_push_error)?;
    if opts.tags {
        // Push only tags not yet pushed; push all when we don't know which the remote has (spec §7.3)
        let names: Vec<String> = if p.tags_unknown { local_tags(dir).into_keys().collect() } else { p.unpushed_tags.clone() };
        push_tags(dir, &names, cancel, progress)?;
    }
    Ok(())
}

/// Push one tag (spec §6.5, §7.4). Returns `PUSH_REJECTED` (reason `tag_exists`) when the remote already has a same-named tag pointing elsewhere.
pub fn tag_push(dir: &Path, name: &str, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    default_remote(dir)?;
    if !local_tags(dir).contains_key(name) {
        return Err(CoreError::new(ErrorCode::NotFound, format!("找不到标签 {name}")));
    }
    push_tags(dir, &[name.to_string()], cancel, progress)
}

/// Delete a branch on a remote (`git push <remote> --delete <branch>`); `name` is the remote branch as shown, e.g. `origin/feature`.
/// The remote-tracking branch goes away with it. Local branches tracking it are left alone (their upstream is then gone).
pub fn remote_branch_delete(dir: &Path, name: &str, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    let (remote, branch) = split_remote_branch(dir, name)?;
    if branch == "HEAD" {
        return Err(CoreError::new(ErrorCode::InvalidName, "不能删除远程的 HEAD"));
    }
    run_net(dir, &["push", &remote, "--delete", &branch], cancel, progress).map(|_| ())
}

/// Split `origin/feature/x` into its remote and branch, matching the longest configured remote name
fn split_remote_branch(dir: &Path, name: &str) -> Result<(String, String)> {
    let mut rs = remotes(dir);
    rs.sort_by_key(|r| std::cmp::Reverse(r.len()));
    rs.into_iter()
        .find_map(|r| name.strip_prefix(&format!("{r}/")).map(|b| (r.clone(), b.to_string())))
        .filter(|(_, b)| !b.is_empty())
        .ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("{name} 不是远程分支")))
}

/// Delete a tag on the default remote (`git push <remote> --delete refs/tags/<name>`); the local tag stays
pub fn remote_tag_delete(dir: &Path, name: &str, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    let remote = default_remote(dir)?;
    run_net(dir, &["push", &remote, "--delete", &format!("refs/tags/{name}")], cancel, progress)?;
    // Forget it in the remembered list of remote tags, so it shows as not pushed right away
    if let Some(mut tags) = remote_tags(dir) {
        tags.remove(name);
        save_remote_tags(dir, &tags);
    }
    Ok(())
}

fn push_tags(dir: &Path, names: &[String], cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    if names.is_empty() {
        return Ok(());
    }
    let specs: Vec<String> = names.iter().map(|n| format!("refs/tags/{n}:refs/tags/{n}")).collect();
    let main = default_remote(dir)?;
    let mut args = vec!["push", "--progress", "--porcelain", &main];
    args.extend(specs.iter().map(String::as_str));
    run_net(dir, &args, cancel, progress).map_err(|e| {
        if e.code == ErrorCode::GitFailed && detail_text(&e).contains("already exists") {
            rejected("tag_exists")
        } else {
            classify_push_error(e)
        }
    })?;
    // Record successfully pushed ones as on the remote
    let local = local_tags(dir);
    let mut known = match remote_tags(dir) {
        Some(k) => k,
        // We don't know the remote's tags yet: only certain once everything was pushed, so don't record otherwise
        None if names.len() == local.len() => Default::default(),
        None => return Ok(()),
    };
    for n in names {
        if let Some(id) = local.get(n) {
            known.insert(n.clone(), id.clone());
        }
    }
    save_remote_tags(dir, &known);
    Ok(())
}

/// Local tags not yet pushed (compared by name), sorted by name; `None` when remote tags were never recorded.
pub fn unpushed_tags(dir: &Path) -> Option<Vec<String>> {
    let known = remote_tags(dir)?;
    let mut v: Vec<String> = local_tags(dir).into_keys().filter(|n| !known.contains_key(n)).collect();
    v.sort();
    Some(v)
}

/// Local tags: name → id of the tag object (or commit)
fn local_tags(dir: &Path) -> std::collections::HashMap<String, String> {
    git_cli::run(dir, &["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)", "refs/tags"], None)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('\0'))
        .map(|(n, id)| (n.to_string(), id.to_string()))
        .collect()
}

/// Remote tags recorded at the last fetch, stored in `<common .git>/strand/remote-tags` (one "id name" per line),
/// shared between worktrees. No such file means never fetched.
fn remote_tags_file(dir: &Path) -> Option<std::path::PathBuf> {
    let common = git_cli::run(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"], None).ok()?;
    Some(Path::new(common.trim()).join("strand").join("remote-tags"))
}

fn remote_tags(dir: &Path) -> Option<std::collections::HashMap<String, String>> {
    let text = std::fs::read_to_string(remote_tags_file(dir)?).ok()?;
    Some(text.lines().filter_map(|l| l.split_once(' ')).map(|(id, n)| (n.to_string(), id.to_string())).collect())
}

fn save_remote_tags(dir: &Path, tags: &std::collections::HashMap<String, String>) {
    let Some(f) = remote_tags_file(dir) else { return };
    let mut lines: Vec<String> = tags.iter().map(|(n, id)| format!("{id} {n}")).collect();
    lines.sort();
    if let Some(parent) = f.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&f, lines.join("\n") + "\n");
}

fn push_to(dir: &Path, to: &str, remote: Option<&str>, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    let p = push_preview_on(dir, Some(to), remote)?;
    if p.behind > 0 {
        return Err(rejected(if p.needs_force { "needs_force" } else { "behind" }));
    }
    let id = p.to.clone().unwrap_or_default();
    let remote_branch = p.target.strip_prefix(&format!("{}/", p.remote)).unwrap_or(&p.branch).to_string();
    let refspec = format!("{id}:refs/heads/{remote_branch}");
    run_net(dir, &["push", "--progress", "--porcelain", &p.remote, &refspec], cancel, progress).map_err(classify_push_error)?;
    if p.new_branch {
        // Pushing by commit id doesn't set an upstream, so add it after a successful push (the remote-tracking branch is already updated by push)
        let _ = git_cli::run(dir, &["branch", "--set-upstream-to", &format!("{}/{remote_branch}", p.remote), &p.branch], None);
    }
    Ok(())
}

// ---------- Internal ----------

/// Whether every remote-only commit was rewritten locally (a same-content version exists locally; `git cherry` marks "-").
/// Empty commits have no content to compare and any two would count as "the same", so when remote-only commits include an empty one
/// it's always treated as "the remote has new commits": better to suggest pulling first than mislead the user into force-pushing over others' commits.
/// `local` and `up` are the local branch and its upstream (or `HEAD`, `@{upstream}`).
pub(crate) fn rewritten(dir: &Path, local: &str, up: &str) -> bool {
    let cherry = git_cli::run(dir, &["cherry", local, up], None).unwrap_or_default();
    let lines: Vec<&str> = cherry.lines().collect();
    if lines.is_empty() || !lines.iter().all(|l| l.starts_with('-')) {
        return false;
    }
    let range = format!("{local}..{up}");
    let files = git_cli::run(dir, &["log", &range, "--no-merges", "--format=%x00%H", "--name-only"], None)
        .unwrap_or_default();
    files.split('\0').skip(1).all(|chunk| chunk.lines().skip(1).any(|l| !l.trim().is_empty()))
}

fn rejected(reason: &str) -> CoreError {
    let msg = match reason {
        "behind" => "远程有你本地没有的提交，先拉取再推送",
        "needs_force" => "这些提交改写了已经推送过的历史，需要勾选强制推送",
        "lease_stale" => "远程在你上次抓取之后又被更新了，先抓取再决定是否强制推送",
        "tag_exists" => "远程已经有同名的标签，而且指向别的提交",
        _ => "远程拒绝了这次推送（分支可能受保护）",
    };
    CoreError::new(ErrorCode::PushRejected, msg).with_detail(serde_json::json!({ "reason": reason }))
}

fn classify_push_error(e: CoreError) -> CoreError {
    if e.code != ErrorCode::GitFailed {
        return e;
    }
    let text = detail_text(&e);
    if text.contains("stale info") {
        rejected("lease_stale")
    } else if text.contains("fetch first") || text.contains("non-fast-forward") {
        rejected("behind")
    } else if text.contains("protected") || text.contains("pre-receive hook declined") || text.contains("[remote rejected]") {
        rejected("protected")
    } else {
        e
    }
}

fn detail_text(e: &CoreError) -> String {
    let d = e.detail.as_ref();
    let s = |k: &str| d.and_then(|d| d.get(k)).and_then(|v| v.as_str()).unwrap_or("").to_string();
    format!("{}\n{}\n{}", e.message, s("stderr"), s("stdout"))
}

/// Authentication failures and network failures get their own error codes so the frontend can show matching notices.
fn classify_net_error(e: CoreError) -> CoreError {
    if e.code != ErrorCode::GitFailed {
        return e;
    }
    let t = detail_text(&e);
    let auth = ["Authentication failed", "could not read Username", "could not read Password", "Permission denied (publickey", "terminal prompts disabled", "403"];
    let net = ["Could not resolve host", "Connection timed out", "Connection refused", "Network is unreachable", "Operation timed out", "unable to access", "Could not read from remote repository"];
    if auth.iter().any(|k| t.contains(k)) {
        CoreError::new(ErrorCode::AuthFailed, "认证失败：用户名、密码或密钥不对，或者没有访问这个仓库的权限").with_detail(e.detail.unwrap_or_default())
    } else if net.iter().any(|k| t.contains(k)) {
        CoreError::new(ErrorCode::Network, "连不上远程仓库，请检查网络后重试").with_detail(e.detail.unwrap_or_default())
    } else {
        e
    }
}

/// Run a network-related git command: read progress, support cancel, time out on no-output duration.
pub(crate) fn run_net(dir: &Path, args: &[&str], cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<String> {
    run_git_net(dir, args, None, &[], cancel, progress)
}

/// For tests: run `git credential fill` through the same path to check that the user is asked when input is needed (spec §7.5).
/// Doesn't read global or system config (doesn't touch this machine's credential helpers). Returns git's output (including username=, password=).
#[doc(hidden)]
pub fn credential_probe(dir: &Path, url: &str, cancel: &Cancel) -> Result<String> {
    let input = format!("url={url}\n\n");
    run_git_net(dir, &["credential", "fill"], Some(&input), &[("GIT_CONFIG_NOSYSTEM", "1"), ("GIT_CONFIG_GLOBAL", "/dev/null")], cancel, &|_| {})
}

fn run_git_net(dir: &Path, args: &[&str], input: Option<&str>, envs: &[(&str, &str)], cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Don't ask in a terminal; when input is needed go through askpass (UI dialog), failing directly when unset
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    git_cli::hide_console(&mut cmd);
    let last = Arc::new(Mutex::new(Instant::now()));
    let ask = crate::askpass::serve(&mut cmd, cancel, last.clone());
    let timer = crate::console::Timer::start();
    let mut child = cmd
        .spawn()
        .map_err(|e| CoreError::new(ErrorCode::GitMissing, "没有找到 Git，请先安装").with_detail(serde_json::json!({ "source": e.to_string() })))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        use std::io::Write;
        let _ = stdin.write_all(text.as_bytes());
    }

    // stderr is split into lines on \r and \n on a separate thread, as progress and error messages
    let lines: Arc<Mutex<Vec<String>>> = Arc::default();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut stderr = child.stderr.take().expect("已设置为 piped");
    let last2 = last.clone();
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut cur = Vec::new();
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            *last2.lock().unwrap() = Instant::now();
            for &b in &buf[..n] {
                if b == b'\r' || b == b'\n' {
                    if !cur.is_empty() {
                        let _ = tx.send(String::from_utf8_lossy(&cur).into_owned());
                        cur.clear();
                    }
                } else {
                    cur.push(b);
                }
            }
        }
        if !cur.is_empty() {
            let _ = tx.send(String::from_utf8_lossy(&cur).into_owned());
        }
    });
    let mut stdout = child.stdout.take().expect("已设置为 piped");
    let out_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });

    let status = loop {
        for line in rx.try_iter() {
            progress(parse_progress(&line));
            lines.lock().unwrap().push(line);
        }
        if cancel.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            timer.done(args, "", &(lines.lock().unwrap().join("\n") + "\n（已取消）"), false);
            return Err(CoreError::new(ErrorCode::Cancelled, "已取消"));
        }
        // Waiting for the user's password doesn't count toward the timeout
        let asking = ask.as_ref().is_some_and(|a| a.waiting.load(Ordering::SeqCst));
        if !asking && last.lock().unwrap().elapsed() > IDLE_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            timer.done(args, "", &(lines.lock().unwrap().join("\n") + "\n（超过 60 秒没有响应，已停止）"), false);
            return Err(CoreError::new(ErrorCode::Network, "远程仓库超过 60 秒没有响应，已停止"));
        }
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(CoreError::git("等待 git 结束失败", e)),
        }
    };
    let _ = reader.join();
    for line in rx.try_iter() {
        lines.lock().unwrap().push(line);
    }
    let stdout = out_reader.join().unwrap_or_default();
    timer.done(args, &stdout, &lines.lock().unwrap().join("\n"), status.success());
    if status.success() {
        return Ok(stdout);
    }
    // The user clicked cancel in the input box: treat as cancelled, not an authentication failure
    if ask.as_ref().is_some_and(|a| a.refused.load(Ordering::SeqCst)) {
        return Err(CoreError::new(ErrorCode::Cancelled, "已取消"));
    }
    let stderr = lines.lock().unwrap().join("\n");
    let first = stderr
        .lines()
        .find(|l| l.starts_with("fatal:") || l.starts_with("error:") || l.contains("rejected"))
        .or_else(|| stderr.lines().last())
        .unwrap_or("git 命令失败")
        .to_string();
    Err(classify_net_error(CoreError::new(ErrorCode::GitFailed, first).with_detail(serde_json::json!({
        "args": args,
        "stderr": stderr,
        "stdout": stdout,
    }))))
}

fn parse_progress(line: &str) -> Progress {
    let text = line.trim().trim_start_matches("remote:").trim().to_string();
    let percent = text
        .split_whitespace()
        .find_map(|w| w.strip_suffix('%').and_then(|n| n.parse::<u8>().ok()));
    Progress { text, percent }
}

/// The repository's remotes, in git remote order
pub fn remotes(dir: &Path) -> Vec<String> {
    git_cli::run(dir, &["remote"], None).map(|o| o.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()).unwrap_or_default()
}

/// The remote the current branch tracks
fn upstream_remote(dir: &Path) -> Option<String> {
    let b = current_branch(dir).ok().flatten()?;
    git_cli::run(dir, &["config", "--get", &format!("branch.{b}.remote")], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s != ".")
}

/// The default remote: the current branch's upstream remote, otherwise origin, otherwise the first; NOT_FOUND when there are no remotes
pub fn default_remote(dir: &Path) -> Result<String> {
    let all = remotes(dir);
    if let Some(u) = upstream_remote(dir).filter(|u| all.contains(u)) {
        return Ok(u);
    }
    if all.iter().any(|r| r == REMOTE) {
        return Ok(REMOTE.to_string());
    }
    all.into_iter().next().ok_or_else(|| CoreError::new(ErrorCode::NotFound, "这个仓库还没有远程，先添加一个"))
}

fn require_normal(dir: &Path) -> Result<()> {
    if in_progress(dir) {
        return Err(CoreError::new(ErrorCode::MergeInProgress, "合并还没完成，先解决冲突或中止"));
    }
    Ok(())
}

/// The repository is in the middle of a merge, rebase, cherry-pick or revert.
fn in_progress(dir: &Path) -> bool {
    let Ok(git_dir) = git_cli::run(dir, &["rev-parse", "--absolute-git-dir"], None) else { return false };
    let g = Path::new(git_dir.trim());
    ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].iter().any(|f| g.join(f).exists())
}

fn current_branch(dir: &Path) -> Result<Option<String>> {
    let b = git_cli::run(dir, &["branch", "--show-current"], None)?;
    let b = b.trim();
    Ok((!b.is_empty()).then(|| b.to_string()))
}

fn upstream(dir: &Path) -> Option<String> {
    git_cli::run(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], None)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn count(dir: &Path, range: &str) -> u32 {
    git_cli::run(dir, &["rev-list", "--count", range], None)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn behind_upstream(dir: &Path) -> u32 {
    if upstream(dir).is_none() {
        return 0;
    }
    count(dir, "HEAD..@{upstream}")
}

fn ahead_upstream(dir: &Path) -> u32 {
    if upstream(dir).is_none() {
        return 0;
    }
    count(dir, "@{upstream}..HEAD")
}

fn conflicted_files(dir: &Path) -> Vec<String> {
    git_cli::run(dir, &["diff", "--name-only", "--diff-filter=U"], None)
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

// ---------- Managing remotes ----------

#[derive(Debug, Clone, Serialize)]
pub struct RemoteInfo {
    pub name: String,
    /// Fetch URL
    pub url: String,
    /// Separately configured push URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push_url: Option<String>,
}

pub fn remote_list(dir: &Path) -> Result<Vec<RemoteInfo>> {
    Ok(remotes(dir)
        .into_iter()
        .map(|name| {
            let get = |k: &str| git_cli::run(dir, &["config", "--get", &format!("remote.{name}.{k}")], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            RemoteInfo { url: get("url").unwrap_or_default(), push_url: get("pushurl"), name }
        })
        .collect())
}

fn check_remote_name(dir: &Path, name: &str) -> Result<()> {
    if name.is_empty() || name.contains(char::is_whitespace) || name.contains('/') {
        return Err(CoreError::new(ErrorCode::InvalidName, "远程的名字不能为空，也不能有空格或斜杠"));
    }
    if git_cli::run(dir, &["check-ref-format", &format!("refs/remotes/{name}/x")], None).is_err() {
        return Err(CoreError::new(ErrorCode::InvalidName, "远程的名字不符合 Git 的命名规则"));
    }
    if remotes(dir).iter().any(|r| r == name) {
        return Err(CoreError::new(ErrorCode::InvalidName, format!("已经有叫 {name} 的远程了")));
    }
    Ok(())
}

fn check_url(url: &str) -> Result<()> {
    if url.trim().is_empty() || url.contains(char::is_whitespace) {
        return Err(CoreError::new(ErrorCode::InvalidName, "地址不能为空，也不能有空格"));
    }
    Ok(())
}

fn require_remote(dir: &Path, name: &str) -> Result<()> {
    if remotes(dir).iter().any(|r| r == name) {
        Ok(())
    } else {
        Err(CoreError::new(ErrorCode::NotFound, format!("没有叫 {name} 的远程")))
    }
}

/// Add a remote (no automatic fetch)
pub fn remote_add(dir: &Path, name: &str, url: &str) -> Result<()> {
    let name = name.trim();
    check_remote_name(dir, name)?;
    check_url(url)?;
    git_cli::run(dir, &["remote", "add", name, url.trim()], None).map(|_| ())
}

/// Remove a remote: its remote branches are removed locally too, and local branches tracking it lose their upstream
pub fn remote_remove(dir: &Path, name: &str) -> Result<()> {
    require_remote(dir, name)?;
    git_cli::run(dir, &["remote", "remove", name], None).map(|_| ())
}

/// Rename a remote: remote branches and tracking follow the new name
pub fn remote_rename(dir: &Path, old: &str, new: &str) -> Result<()> {
    require_remote(dir, old)?;
    let new = new.trim();
    if new == old {
        return Ok(());
    }
    check_remote_name(dir, new)?;
    git_cli::run(dir, &["remote", "rename", old, new], None).map(|_| ())
}

/// Change a remote's URL (used for fetch and push; a separately set push URL is replaced too)
pub fn remote_set_url(dir: &Path, name: &str, url: &str) -> Result<()> {
    require_remote(dir, name)?;
    check_url(url)?;
    git_cli::run(dir, &["remote", "set-url", name, url.trim()], None)?;
    let _ = git_cli::run(dir, &["config", "--unset-all", &format!("remote.{name}.pushurl")], None);
    Ok(())
}
