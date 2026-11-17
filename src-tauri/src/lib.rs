//! Desktop shell: registers the core layer as Tauri commands.
//!
//! Command names match the spec. All reads run on background threads so the UI thread isn't blocked (spec §15).
//! To add a command: implement and test it in the core layer → add a thin wrapper here → register it in `generate_handler!`
//! → add the matching function and types in the frontend's `src/api/commands.ts`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use strand_core::model::{
    ChangeScope, CommitDetail, FileDiff, GitInfo, LogPage, MergeMode, MergeResult, RefsList, RepoMode, RepoState, Selection, WorktreeStatus,
};
use strand_core::log_filter::{LogAuthor, LogFilter, LogSort};
use strand_core::commits::{CommitCaps, ResetMode};
use strand_core::stash::{ShelfEntry, StashEntry};
use strand_core::rebase::{RebaseRange, RebaseResult, Step};
use strand_core::oplog::{OpInfo, OpKind, OpList, OpScope, Snapshot};
use strand_core::conflict::{ChangeMark, FinishResult, MergeSession, Side};
use strand_core::remote::{self, Cancel, FetchResult, PullMode, PullResult, PushOptions, PushPreview};
use strand_core::{CoreError, ErrorCode, Session};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct AppState {
    repo: Arc<Mutex<Option<Session>>>,
    /// File watching for the current repository; replaced when switching repositories, which stops the old one
    watcher: Mutex<Option<strand_core::watch::Watcher>>,
    /// Long tasks in progress: cancellation tokens by the frontend's task_id
    tasks: Mutex<HashMap<String, Cancel>>,
    /// Only one network operation at a time
    net_busy: AtomicBool,
    /// The update found by the last check, kept for installing
    update: Mutex<Option<tauri_plugin_updater::Update>>,
}

/// The `repo_changed` event the core layer pushes to the frontend (spec §2.2)
#[derive(Clone, Serialize)]
struct RepoChanged {
    scopes: Vec<ChangeScope>,
}

#[derive(Serialize)]
struct CommitCreated {
    id: String,
    state: RepoState,
    #[serde(skip_serializing_if = "Option::is_none")]
    op: Option<OpInfo>,}

type CmdResult<T> = Result<T, CoreError>;

/// Run `f` on the current repository on a background thread.
async fn with_repo<T, F>(state: &AppState, f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Session) -> CmdResult<T> + Send + 'static,
{
    let repo = state.repo.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = repo.lock().map_err(|_| CoreError::new(ErrorCode::RepoBusy, "上一个操作还没完成"))?;
        let s = guard.as_mut().ok_or_else(|| CoreError::new(ErrorCode::NoRepo, "还没有打开仓库"))?;
        f(s)
    })
    .await
    .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// Detect system Git. The installer doesn't bundle Git; the frontend asks the user to install it when missing.
#[tauri::command]
async fn git_check() -> GitInfo {
    tauri::async_runtime::spawn_blocking(strand_core::git_cli::check)
        .await
        .unwrap_or_else(|_| strand_core::git_cli::check())
}

/// The repository path in the launch arguments: `strand /path/to/repo` opens it directly. Empty when absent.
#[tauri::command]
fn launch_path() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir())
}

/// Open a repository: read the log, compute the graph, return the repository state.
#[tauri::command]
async fn repo_open(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<RepoState> {
    let session = tauri::async_runtime::spawn_blocking(move || {
        let s = Session::open(path)?;
        strand_core::console::note(&format!("打开仓库 {}", s.path().display()));
        Ok::<_, CoreError>(s)
    })
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))??;
    let st = session.state()?;
    // A watch failure doesn't stop anything, there's just no automatic refresh
    let watcher = strand_core::watch::watch(session.path(), move |scopes| {
        let _ = app.emit("repo_changed", RepoChanged { scopes });
    })
    .ok();
    if let Ok(mut w) = state.watcher.lock() {
        *w = watcher;
    }
    *state.repo.lock().map_err(|_| CoreError::new(ErrorCode::RepoBusy, "上一个操作还没完成"))? = Some(session);
    Ok(st)
}

#[tauri::command]
async fn repo_state(state: State<'_, AppState>) -> CmdResult<RepoState> {
    with_repo(&state, |s| s.state()).await
}

/// Re-read the log (call after the repository is changed externally; afterwards file watching triggers it).
#[tauri::command]
async fn repo_reload(state: State<'_, AppState>) -> CmdResult<RepoState> {
    with_repo(&state, |s| {
        s.reload()?;
        s.state()
    })
    .await
}

#[derive(Serialize)]
struct Refreshed {
    state: RepoState,
    /// Refs or HEAD changed and the log was re-read; when false the UI doesn't need to fetch the log again
    changed: bool,
}

/// Refresh triggered by file watching: don't re-read the log when refs and HEAD are unchanged (Strand's own writes have already read it)
#[tauri::command]
async fn repo_refresh(state: State<'_, AppState>) -> CmdResult<Refreshed> {
    with_repo(&state, |s| {
        let changed = s.reload_if_changed()?;
        Ok(Refreshed { state: s.state()?, changed })
    })
    .await
}

/// Log paging, optionally with filtering and sorting (spec §5.1).
///
/// Path filtering runs `git rev-list` over the whole history once, which takes seconds on large repositories; it's done outside the repository lock
/// so other commands aren't blocked, and the result goes into the core layer's cache.
#[tauri::command]
async fn log_query(
    state: State<'_, AppState>,
    filter: Option<LogFilter>,
    sort: Option<LogSort>,
    offset: usize,
    limit: usize,
) -> CmdResult<LogPage> {
    let f = filter.unwrap_or_default();
    let sort = sort.unwrap_or_default();
    // Path filtering runs on a core background thread; while unfinished, return the results so far marked partial (spec §15)
    with_repo(&state, move |s| s.log_query(&f, sort, offset, limit)).await
}

/// Options for the author filter (spec §5.1)
#[tauri::command]
async fn log_authors(state: State<'_, AppState>) -> CmdResult<Vec<LogAuthor>> {
    with_repo(&state, |s| s.log_authors()).await
}

/// Worktree changes and untracked files (spec §4.10)
#[tauri::command]
async fn status_get(state: State<'_, AppState>) -> CmdResult<WorktreeStatus> {
    with_repo(&state, |s| s.status()).await
}

#[tauri::command]
async fn diff_worktree(state: State<'_, AppState>, path: String, ignore_ws: Option<bool>, context: Option<u32>) -> CmdResult<FileDiff> {
    with_repo(&state, move |s| s.diff_worktree(&path, ignore_ws.unwrap_or(false), context.unwrap_or(3))).await
}

/// Commit the checked files and refresh the log. Returns the new commit's id and the repository state.
#[tauri::command]
async fn commit_create(state: State<'_, AppState>, message: String, selection: Selection, sign_off: Option<bool>, author: Option<String>) -> CmdResult<CommitCreated> {
    with_repo(&state, move |s| {
        let title = message.lines().next().unwrap_or("").trim().to_string();
        let r = s.run_op_reload(&format!("提交“{}”", short(&title)), OpKind::Commit, |s| s.commit_create(&message, &selection, sign_off.unwrap_or(false), author.as_deref()));
        let (id, op) = r?;
        Ok(CommitCreated { id, state: s.state()?, op })
    })
    .await
}

/// Amend the last commit (spec §4.5): an empty message keeps the original
#[tauri::command]
async fn commit_amend(state: State<'_, AppState>, message: Option<String>, selection: Selection, sign_off: Option<bool>, author: Option<String>) -> CmdResult<CommitCreated> {
    with_repo(&state, move |s| {
        let head = s.state()?.head.commit.unwrap_or_default();
        let label = format!("修订{}", title_of(s, &head));
        let r = s.run_op_reload(&label, OpKind::Commit, |s| s.commit_amend(message.as_deref(), &selection, sign_off.unwrap_or(false), author.as_deref()));
        let (id, op) = r?;
        Ok(CommitCreated { id, state: s.state()?, op })
    })
    .await
}

/// Common Git settings (identity, proxy, line endings, default branch) in global and this repository's scope; works without an open repository
#[tauri::command]
async fn git_config_get(state: State<'_, AppState>) -> CmdResult<Vec<strand_core::gitconfig::ConfigValue>> {
    let repo = repo_path(&state).ok();
    tauri::async_runtime::spawn_blocking(move || strand_core::gitconfig::config_read(repo.as_deref()))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// Set one setting; an empty value removes it from that scope. Not recorded in the op log (config isn't undoable)
#[tauri::command]
async fn git_config_set(state: State<'_, AppState>, scope: strand_core::gitconfig::ConfigScope, key: String, value: Option<String>) -> CmdResult<Vec<strand_core::gitconfig::ConfigValue>> {
    let repo = repo_path(&state).ok();
    tauri::async_runtime::spawn_blocking(move || {
        strand_core::gitconfig::config_write(repo.as_deref(), scope, &key, value.as_deref())?;
        strand_core::gitconfig::config_read(repo.as_deref())
    })
    .await
    .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// Turn the proxy on or off in a scope; off keeps the address (in strand.httpProxy / strand.httpsProxy)
#[tauri::command]
async fn git_proxy_enable(state: State<'_, AppState>, scope: strand_core::gitconfig::ConfigScope, on: bool) -> CmdResult<Vec<strand_core::gitconfig::ConfigValue>> {
    let repo = repo_path(&state).ok();
    tauri::async_runtime::spawn_blocking(move || {
        strand_core::gitconfig::proxy_enable(repo.as_deref(), scope, on)?;
        strand_core::gitconfig::config_read(repo.as_deref())
    })
    .await
    .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// For writing messages: message history, commit template, current identity
#[tauri::command]
async fn compose_info(state: State<'_, AppState>) -> CmdResult<strand_core::compose::ComposeInfo> {
    with_repo(&state, |s| s.compose_info()).await
}

/// Changelists (Strand's own grouping, stored in .git/strand/changelists.json)
#[tauri::command]
async fn changelists_get(state: State<'_, AppState>) -> CmdResult<strand_core::compose::Changelists> {
    with_repo(&state, |s| s.changelists_get()).await
}

#[tauri::command]
async fn changelists_set(state: State<'_, AppState>, lists: strand_core::compose::Changelists) -> CmdResult<strand_core::compose::Changelists> {
    with_repo(&state, move |s| s.changelists_set(lists)).await
}

#[tauri::command]
async fn commit_detail(state: State<'_, AppState>, id: String) -> CmdResult<CommitDetail> {
    with_repo(&state, move |s| s.commit_detail(&id)).await
}

#[tauri::command]
async fn diff_commit(state: State<'_, AppState>, id: String, path: String, context: Option<u32>) -> CmdResult<FileDiff> {
    with_repo(&state, move |s| s.diff_commit_ctx(&id, &path, context.unwrap_or(3))).await
}

// ---------- Branches and tags (spec §6) ----------
// Re-read the log after write operations and return the latest repository state.

/// Run a write operation, then refresh the log, returning the operation result and repository state.
async fn write_op<T, F>(state: &AppState, f: F) -> CmdResult<Written<T>>
where
    T: Send + Serialize + 'static,
    F: FnOnce(&mut Session) -> CmdResult<T> + Send + 'static,
{
    with_repo(state, move |s| {
        let result = f(s);
        // A failed operation may still have changed the repository (e.g. a merge stopped on conflicts), so refresh anyway
        s.reload()?;
        Ok(Written { result: result?, state: s.state()?, op: None, note: None })
    })
    .await
}

/// Write operations recorded in the op log (spec §11): the return value carries `op`, which the frontend uses for a toast with an undo icon
async fn logged_op<T, F>(state: &AppState, label: String, kind: OpKind, f: F) -> CmdResult<Written<T>>
where
    T: Send + Serialize + 'static,
    F: FnOnce(&mut Session) -> CmdResult<T> + Send + 'static,
{
    with_repo(state, move |s| {
        // The after snapshot and the log re-read run at the same time (spec §15)
        let r = s.run_op_reload(&label, kind, f);
        let (result, op) = r?;
        Ok(Written { result, state: s.state()?, op, note: None })
    })
    .await
}

/// Same as `logged_op`, also recording untracked files or worktrees per `scope` (snapshots only cover tracked files) so these operations can be undone too
async fn logged_op_scoped<T, F>(state: &AppState, label: String, kind: OpKind, scope: OpScope, f: F) -> CmdResult<Written<T>>
where
    T: Send + Serialize + 'static,
    F: FnOnce(&mut Session) -> CmdResult<T> + Send + 'static,
{
    with_repo(state, move |s| {
        let r = s.run_op_scoped(&label, kind, &scope, f);
        s.reload()?;
        let (result, op) = r?;
        Ok(Written { result, state: s.state()?, op, note: None })
    })
    .await
}

/// Same as `logged_op`, but the log label needs a repository read first (e.g. to use a commit title)
async fn logged_op_by<T, L, F>(state: &AppState, kind: OpKind, label: L, f: F) -> CmdResult<Written<T>>
where
    T: Send + Serialize + 'static,
    L: FnOnce(&Session) -> String + Send + 'static,
    F: FnOnce(&mut Session) -> CmdResult<T> + Send + 'static,
{
    with_repo(state, move |s| {
        let label = label(s);
        // The after snapshot and the log re-read run at the same time (spec §15)
        let r = s.run_op_reload(&label, kind, f);
        let (result, op) = r?;
        Ok(Written { result, state: s.state()?, op, note: None })
    })
    .await
}

/// A commit's title, used in op log labels
fn title_of(s: &Session, id: &str) -> String {
    s.commit_title(id).map(|t| format!("“{}”", short(&t))).unwrap_or_else(|| id.chars().take(7).collect())
}

/// A commit title shown in toasts, truncated when too long
fn short(t: &str) -> String {
    if t.chars().count() > 40 { format!("{}…", t.chars().take(40).collect::<String>()) } else { t.to_string() }
}

#[derive(Serialize)]
struct Written<T> {
    result: T,
    state: RepoState,
    /// The op log entry written by this operation; omitted when nothing was logged (no change, unresolved conflicts, read-only)
    #[serde(skip_serializing_if = "Option::is_none")]
    op: Option<OpInfo>,
    /// Extra notes for the user, e.g. auto-shelved changes couldn't be restored after a pull (spec §7.2)
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

#[tauri::command]
async fn refs_list(state: State<'_, AppState>) -> CmdResult<RefsList> {
    with_repo(&state, |s| s.refs_list()).await
}

#[tauri::command]
async fn log_locate(state: State<'_, AppState>, rev: String, filter: Option<LogFilter>, sort: Option<LogSort>) -> CmdResult<Option<usize>> {
    let f = filter.unwrap_or_default();
    // While filter results are incomplete, search what's there so far (null when not found)
    with_repo(&state, move |s| s.log_locate_in(&rev, &f, sort.unwrap_or_default())).await
}

#[tauri::command]
async fn branch_create(state: State<'_, AppState>, name: String, at: Option<String>, checkout: bool) -> CmdResult<Written<()>> {
    logged_op(&state, format!("新建分支 {name}"), OpKind::Branch, move |s| s.branch_create(&name, at.as_deref(), checkout)).await
}

#[tauri::command]
async fn branch_switch(state: State<'_, AppState>, name: String, stash_first: Option<bool>) -> CmdResult<Written<()>> {
    logged_op(&state, format!("切换到 {name}"), OpKind::Switch, move |s| s.branch_switch(&name, stash_first.unwrap_or(false))).await
}

#[tauri::command]
async fn branch_rename(state: State<'_, AppState>, name: String, new_name: String) -> CmdResult<Written<()>> {
    logged_op(&state, format!("把 {name} 重命名为 {new_name}"), OpKind::Branch, move |s| s.branch_rename(&name, &new_name)).await
}

#[tauri::command]
async fn branch_delete(state: State<'_, AppState>, name: String, force: Option<bool>) -> CmdResult<Written<()>> {
    logged_op(&state, format!("删除分支 {name}"), OpKind::Branch, move |s| s.branch_delete(&name, force.unwrap_or(false))).await
}

#[tauri::command]
async fn branch_merge(state: State<'_, AppState>, source: String, mode: Option<MergeMode>, message: Option<String>) -> CmdResult<Written<MergeResult>> {
    let mode = mode.unwrap_or_default();
    let label = if mode == MergeMode::Squash { format!("压缩合并 {source}") } else { format!("合并 {source}") };
    logged_op(&state, label, OpKind::Merge, move |s| s.branch_merge_with(&source, mode, message.as_deref())).await
}

/// Add or remove a local branch from favorites (spec §6.1, §6.3): stored in the repository's .git/strand/favorites, shared between worktrees
#[tauri::command]
async fn prefs_set_favorite(state: State<'_, AppState>, name: String, favorite: bool) -> CmdResult<()> {
    with_repo(&state, move |s| s.set_favorite(&name, favorite)).await
}

/// Drag merge (spec §6.1): merge source into target, switching first when target isn't current; recorded as one step.
#[tauri::command]
async fn branch_merge_into(state: State<'_, AppState>, source: String, target: String, mode: Option<MergeMode>, message: Option<String>) -> CmdResult<Written<MergeResult>> {
    let mode = mode.unwrap_or_default();
    let label = if mode == MergeMode::Squash { format!("把 {source} 压缩合并到 {target}") } else { format!("把 {source} 合并到 {target}") };
    logged_op(&state, label, OpKind::Merge, move |s| s.branch_merge_into_with(&source, &target, mode, message.as_deref())).await
}

/// Default squash-merge message, prefilled in the dialog (spec §6.7). With `target` empty, computed against the current branch.
#[tauri::command]
async fn branch_squash_message(state: State<'_, AppState>, source: String, target: Option<String>) -> CmdResult<String> {
    with_repo(&state, move |s| s.squash_message(&source, target.as_deref())).await
}

/// Pre-rebase check: own commits, pushed commits, new commits on the target, any merge commits (spec §6.3).
#[tauri::command]
async fn branch_rebase_plan(state: State<'_, AppState>, onto: String) -> CmdResult<strand_core::model::RebasePlan> {
    with_repo(&state, move |s| s.branch_rebase_plan(&onto)).await
}

/// Rebase the current branch onto onto. Stops in the rebase state on conflicts; the whole process is one step after conflict resolution finishes.
#[tauri::command]
async fn branch_rebase(state: State<'_, AppState>, onto: String) -> CmdResult<Written<strand_core::model::RebaseOutcome>> {
    logged_op(&state, format!("变基到 {onto} 之上"), OpKind::Merge, move |s| s.branch_rebase(&onto)).await
}

#[tauri::command]
async fn merge_abort(state: State<'_, AppState>, marks: Option<serde_json::Value>) -> CmdResult<Written<()>> {
    with_repo(&state, move |s| {
        // The abort is written as one entry, and undoing it returns to the conflicts and marks before the abort (spec §8.9); aborting a pull restores the changes auto-shelved before it
        let label = match s.state()?.state {
            RepoMode::Rebasing => "中止变基",
            RepoMode::CherryPicking => "中止拣选",
            RepoMode::Reverting => "中止还原",
            RepoMode::Unstashing => "中止取回",
            _ => "中止合并",
        };
        let (note, op) = s.merge_abort_logged(label, marks)?;
        s.reload()?;
        Ok(Written { result: (), state: s.state()?, op, note })
    })
    .await
}

#[tauri::command]
async fn branch_checkout_remote(state: State<'_, AppState>, remote_branch: String) -> CmdResult<Written<String>> {
    logged_op(&state, format!("检出 {remote_branch}"), OpKind::Checkout, move |s| s.branch_checkout_remote(&remote_branch)).await
}

#[tauri::command]
async fn checkout_detached(state: State<'_, AppState>, rev: String) -> CmdResult<Written<()>> {
    logged_op(&state, format!("检出 {rev}"), OpKind::Checkout, move |s| s.checkout_detached(&rev)).await
}

#[tauri::command]
async fn tag_create(state: State<'_, AppState>, name: String, at: String, message: Option<String>, sign: Option<bool>) -> CmdResult<Written<()>> {
    logged_op(&state, format!("新建标签 {name}"), OpKind::Tag, move |s| s.tag_create(&name, &at, message.as_deref(), sign.unwrap_or(false))).await
}

#[tauri::command]
async fn tag_delete(state: State<'_, AppState>, name: String) -> CmdResult<Written<()>> {
    logged_op(&state, format!("删除标签 {name}"), OpKind::Tag, move |s| s.tag_delete(&name)).await
}

// ---------- Remote operations (spec §7) ----------
// Network operations don't hold the repository lock: take the path first so the UI can still read the log and diffs while they run; refresh the log afterwards.
// The frontend generates a task_id per operation; progress is pushed via task_progress events and task_cancel cancels it.

#[derive(Clone, Serialize)]
struct TaskProgress {
    task_id: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<u8>,
}

fn repo_path(state: &AppState) -> CmdResult<std::path::PathBuf> {
    let g = state.repo.lock().map_err(|_| CoreError::new(ErrorCode::RepoBusy, "上一个操作还没完成"))?;
    g.as_ref()
        .map(|s| s.path().to_path_buf())
        .ok_or_else(|| CoreError::new(ErrorCode::NoRepo, "还没有打开仓库"))
}

/// Run a network task: register the cancellation token, forward progress (at most every 100 ms), refresh the log at the end.
/// How network operations are written to the op log
enum NetLog {
    None,
    /// Pull: the before snapshot; when stopped on conflicts, write after conflict resolution finishes
    Pull(String, Box<Snapshot>),
    /// Push: only shown on the timeline
    Push(String),
}

async fn net_task<T, F>(app: AppHandle, state: &AppState, task_id: String, log: NetLog, f: F) -> CmdResult<Written<T>>
where
    T: Send + Serialize + 'static,
    F: FnOnce(&std::path::Path, &Cancel, &dyn Fn(remote::Progress)) -> CmdResult<T> + Send + 'static,
{
    if state.net_busy.swap(true, Ordering::SeqCst) {
        return Err(CoreError::new(ErrorCode::RepoBusy, "上一个网络操作还没完成"));
    }
    let cancel = Cancel::default();
    if let Ok(mut t) = state.tasks.lock() {
        t.insert(task_id.clone(), cancel.clone());
    }
    let path = repo_path(state);
    let tid = task_id.clone();
    let result = match path {
        Err(e) => Err(e),
        Ok(path) => tauri::async_runtime::spawn_blocking(move || {
            let last = Mutex::new(Instant::now() - Duration::from_secs(1));
            let progress = |p: remote::Progress| {
                let mut l = last.lock().unwrap();
                if l.elapsed() >= Duration::from_millis(100) {
                    *l = Instant::now();
                    let _ = app.emit("task_progress", TaskProgress { task_id: tid.clone(), text: p.text, percent: p.percent });
                }
            };
            f(&path, &cancel, &progress)
        })
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))
        .and_then(|r| r),
    };
    if let Ok(mut t) = state.tasks.lock() {
        t.remove(&task_id);
    }
    state.net_busy.store(false, Ordering::SeqCst);
    // Refresh once on success or failure: a pull may stop in a conflict, a fetch updates remote branches
    let ok = result.is_ok();
    let (st, op, note) = with_repo(state, move |s| {
        // When the pull ends (not stopped in a conflict), restore the changes auto-shelved before it, then write the op log (spec §7.2)
        let note = if matches!(log, NetLog::Pull(..)) { s.pull_unshelve()? } else { None };
        let op = match log {
            NetLog::Pull(label, before) => s.op_end(&label, OpKind::Pull, *before)?,
            NetLog::Push(label) if ok => Some(s.op_note(&label, OpKind::Push)?),
            _ => None,
        };
        s.reload()?;
        Ok((s.state()?, op, note))
    })
    .await?;
    Ok(Written { result: result?, state: st, op, note })
}

/// The default menu, minus "Close Window" (⌘W): the page handles ⌘W, closing the open file tab first, like an IDE's
/// editor tabs, and the window (window_close) only when no file tab is shown
fn setup_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItemKind};
    let menu = Menu::default(app)?;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(sub) = item {
            for it in sub.items()? {
                if let MenuItemKind::Predefined(p) = &it
                    && p.text().is_ok_and(|t| t == "Close Window")
                {
                    sub.remove(p)?;
                }
            }
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

/// The window title: the repository and branch, so windows can be told apart in the Dock, the taskbar and window lists
#[tauri::command]
fn window_set_title(window: tauri::Window, title: String) -> CmdResult<()> {
    window.set_title(&title).map_err(|e| CoreError::git("设置窗口标题失败", e))
}

/// A system notification (a long operation finished while the window was in the background)
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> CmdResult<()> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(title).body(body).show().map_err(|e| CoreError::git("发送通知失败", e))
}

/// Open a repository in a new window: another Strand process started with the folder, so each window has its own
/// repository, watcher and undo history (on macOS it shows as a second Strand in the Dock)
#[tauri::command]
fn open_new_window(path: String) -> CmdResult<()> {
    if !std::path::Path::new(&path).is_dir() {
        return Err(CoreError::new(ErrorCode::NotFound, format!("找不到文件夹 {path}")));
    }
    let exe = std::env::current_exe().map_err(|e| CoreError::git("打开新窗口失败", e))?;
    std::process::Command::new(exe).arg(&path).spawn().map_err(|e| CoreError::git("打开新窗口失败", e))?;
    Ok(())
}

/// Close the main window (⌘W with no file tab shown)
#[tauri::command]
fn window_close(window: tauri::Window) -> CmdResult<()> {
    window.close().map_err(|e| CoreError::git("关闭窗口失败", e))
}

// ---------- Files and the terminal ----------

/// Reveal a worktree file in the system file manager
#[tauri::command]
async fn file_reveal(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let full = with_repo(&state, move |s| s.worktree_file(&path)).await?;
    tauri_plugin_opener::reveal_item_in_dir(&full).map_err(|e| CoreError::git("在文件管理器中显示失败", e))
}

/// Open a worktree file with its default application. Apps, scripts and installers are revealed in the file manager
/// instead, so opening never runs anything; returns false in that case
#[tauri::command]
async fn file_open(state: State<'_, AppState>, path: String) -> CmdResult<bool> {
    let rel = path.clone();
    let full = with_repo(&state, move |s| s.worktree_file(&path)).await?;
    if strand_core::file_history::runs_when_opened(&rel) {
        tauri_plugin_opener::reveal_item_in_dir(&full).map_err(|e| CoreError::git("在文件管理器中显示失败", e))?;
        return Ok(false);
    }
    tauri_plugin_opener::open_path(&full, None::<&str>).map_err(|e| CoreError::git("打开文件失败", e))?;
    Ok(true)
}

/// Open a terminal in the repository folder: Terminal on macOS, Windows Terminal (or Command Prompt) on Windows,
/// the system's default terminal on Linux
#[tauri::command]
fn repo_terminal(state: State<'_, AppState>) -> CmdResult<()> {
    let dir = repo_path(&state)?;
    let fail = |e: std::io::Error| CoreError::git("打开终端失败", e);
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg("-a").arg("Terminal").arg(&dir).spawn().map_err(fail)?;
    #[cfg(target_os = "windows")]
    {
        if std::process::Command::new("wt").args(["-d", "."]).current_dir(&dir).spawn().is_err() {
            std::process::Command::new("cmd").args(["/C", "start", "cmd"]).current_dir(&dir).spawn().map_err(fail)?;
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("x-terminal-emulator").current_dir(&dir).spawn().map_err(fail)?;
    Ok(())
}

/// Local branches whose commits are all in `into` (clean up merged branches)
#[tauri::command]
async fn merged_branches(state: State<'_, AppState>, into: String) -> CmdResult<Vec<strand_core::model::MergedBranch>> {
    with_repo(&state, move |s| s.merged_branches(&into)).await
}

/// Delete several local branches in one step (undo brings them all back)
#[tauri::command]
async fn branches_delete(state: State<'_, AppState>, names: Vec<String>) -> CmdResult<Written<usize>> {
    let label = if names.len() == 1 { format!("删除分支 {}", names[0]) } else { format!("删除 {} 个已合并的分支", names.len()) };
    logged_op(&state, label, OpKind::Branch, move |s| s.branches_delete(&names)).await
}

/// Contribution statistics of the current branch since a time (Unix seconds; None = all history); runs without holding the repository
#[tauri::command]
async fn contributions(state: State<'_, AppState>, since: Option<i64>) -> CmdResult<strand_core::stats::Contributions> {
    let path = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || strand_core::stats::contributions(&path, since))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

// ---------- Pull / merge requests (GitHub, GitLab) ----------

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| CoreError::git("后台任务异常结束", e))?
}

fn hosting_or_err(path: &std::path::Path) -> CmdResult<strand_core::hosting::Hosting> {
    strand_core::hosting::hosting_at(path).ok_or_else(|| CoreError::new(ErrorCode::NotFound, "远程仓库不在 GitHub 或 GitLab 上"))
}

/// Where origin is hosted (null when it isn't GitHub or GitLab)
#[tauri::command]
async fn hosting_info(state: State<'_, AppState>) -> CmdResult<Option<strand_core::hosting::Hosting>> {
    let path = repo_path(&state)?;
    blocking(move || Ok(strand_core::hosting::hosting_at(&path))).await
}

/// Hand an access token to Git's credential helper for origin's host
#[tauri::command]
async fn hosting_set_token(state: State<'_, AppState>, token: String) -> CmdResult<()> {
    let path = repo_path(&state)?;
    blocking(move || {
        let h = hosting_or_err(&path)?;
        strand_core::hosting::save_token(&path, &h, &token)
    })
    .await
}

#[tauri::command]
async fn pr_list(state: State<'_, AppState>) -> CmdResult<Vec<strand_core::hosting::PullRequest>> {
    let path = repo_path(&state)?;
    blocking(move || {
        let h = hosting_or_err(&path)?;
        strand_core::hosting::list(&path, &h)
    })
    .await
}

#[tauri::command]
async fn pr_checks(state: State<'_, AppState>, number: u64, head_sha: String) -> CmdResult<strand_core::hosting::Checks> {
    let path = repo_path(&state)?;
    blocking(move || {
        let h = hosting_or_err(&path)?;
        strand_core::hosting::checks(&path, &h, number, &head_sha)
    })
    .await
}

#[tauri::command]
async fn pr_create(state: State<'_, AppState>, title: String, body: String, head: String, base: String, draft: bool) -> CmdResult<strand_core::hosting::PullRequest> {
    let path = repo_path(&state)?;
    blocking(move || {
        let h = hosting_or_err(&path)?;
        strand_core::hosting::create(&path, &h, &title, &body, &head, &base, draft)
    })
    .await
}

// ---------- Submodules and Git LFS ----------

#[tauri::command]
async fn submodule_list(state: State<'_, AppState>) -> CmdResult<Vec<strand_core::submodules::Submodule>> {
    let path = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || strand_core::submodules::list(&path))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// Check out the recorded commits (initializing and cloning when needed); all submodules when `paths` is empty. Network operation, can be canceled
#[tauri::command]
async fn submodule_update(app: AppHandle, state: State<'_, AppState>, task_id: String, paths: Vec<String>) -> CmdResult<Written<()>> {
    net_task(app, &state, task_id, NetLog::None, move |p, c, pr| strand_core::submodules::update(p, &paths, c, pr)).await
}

/// Whether the git-lfs program is installed
#[tauri::command]
async fn lfs_installed(state: State<'_, AppState>) -> CmdResult<bool> {
    let path = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || strand_core::lfs::installed(&path))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))
}

/// Download the LFS contents of the current checkout (git lfs pull)
#[tauri::command]
async fn lfs_pull(app: AppHandle, state: State<'_, AppState>, task_id: String) -> CmdResult<Written<()>> {
    net_task(app, &state, task_id, NetLog::None, strand_core::lfs::pull).await
}

#[tauri::command]
fn task_cancel(state: State<'_, AppState>, task_id: String) {
    if let Some(c) = state.tasks.lock().ok().and_then(|t| t.get(&task_id).cloned()) {
        c.cancel();
    }
}

// ---------- Worktrees (spec §6.6) and cloning ----------

/// Create a worktree. Undoable: undo removes it (not undoable when it has uncommitted changes), along with the new branch.
#[tauri::command]
async fn worktree_add(state: State<'_, AppState>, path: String, branch: String, new_branch: bool, base: Option<String>) -> CmdResult<Written<()>> {
    let label = format!("新建工作目录 {}（{branch}）", short_path(&path));
    let scope = OpScope { worktrees: true, ..Default::default() };
    logged_op_scoped(&state, label, OpKind::Branch, scope, move |s| s.worktree_add(&path, &branch, new_branch, base.as_deref())).await
}

/// Remove a worktree. With uncommitted changes returns WORKTREE_CONFLICT unless force.
#[tauri::command]
async fn worktree_remove(state: State<'_, AppState>, path: String, force: bool) -> CmdResult<Written<()>> {
    // Undo re-creates the original branch's checkout at the original location (changes lost to a forced removal don't come back)
    let label = format!("移除工作目录 {}", short_path(&path));
    let scope = OpScope { worktrees: true, ..Default::default() };
    logged_op_scoped(&state, label, OpKind::Branch, scope, move |s| s.worktree_remove(&path, force)).await
}

fn short_path(p: &str) -> String {
    std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string())
}

/// Clone into dest (full path); progress is pushed via task_progress and task_cancel cancels it. No repository needs to be open.
#[tauri::command]
async fn repo_clone(app: AppHandle, state: State<'_, AppState>, task_id: String, url: String, dest: String) -> CmdResult<String> {
    let cancel = Cancel::default();
    if let Ok(mut t) = state.tasks.lock() {
        t.insert(task_id.clone(), cancel.clone());
    }
    let tid = task_id.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let last = Mutex::new(Instant::now() - Duration::from_secs(1));
        let progress = |p: remote::Progress| {
            let mut l = last.lock().unwrap();
            if l.elapsed() >= Duration::from_millis(100) {
                *l = Instant::now();
                let _ = app.emit("task_progress", TaskProgress { task_id: tid.clone(), text: p.text, percent: p.percent });
            }
        };
        let d = std::path::PathBuf::from(&dest);
        remote::clone(&url, &d, &cancel, &progress).map(|_| dest)
    })
    .await
    .map_err(|e| CoreError::git("后台任务异常结束", e))
    .and_then(|r| r);
    if let Ok(mut t) = state.tasks.lock() {
        t.remove(&task_id);
    }
    r
}

// ---------- Format and check before committing (spec §4.4, §4.6) ----------

#[tauri::command]
async fn checks_config_get(state: State<'_, AppState>) -> CmdResult<strand_core::checks::ChecksInfo> {
    let path = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || strand_core::checks::config(&path))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))
}

#[tauri::command]
async fn checks_config_set(state: State<'_, AppState>, config: strand_core::checks::ChecksConfig) -> CmdResult<strand_core::checks::ChecksInfo> {
    let path = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        strand_core::checks::set_config(&path, &config)?;
        Ok(strand_core::checks::config(&path))
    })
    .await
    .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// Run a format or check. Runs outside the repository lock (may take tens of seconds); task_cancel cancels it.
#[tauri::command]
async fn checks_run(
    state: State<'_, AppState>,
    task_id: String,
    kind: strand_core::checks::CheckKind,
    files: Vec<String>,
) -> CmdResult<strand_core::checks::CheckRun> {
    let path = repo_path(&state)?;
    let cancel = Cancel::default();
    if let Ok(mut t) = state.tasks.lock() {
        t.insert(task_id.clone(), cancel.clone());
    }
    let r = tauri::async_runtime::spawn_blocking(move || {
        let c = strand_core::checks::config(&path).config;
        let cmd = match kind {
            strand_core::checks::CheckKind::Format => c.format_command,
            strand_core::checks::CheckKind::Check => c.check_command,
        };
        strand_core::checks::run(&path, kind, &cmd, &files, &cancel)
    })
    .await
    .map_err(|e| CoreError::git("后台任务异常结束", e))
    .and_then(|r| r);
    if let Ok(mut t) = state.tasks.lock() {
        t.remove(&task_id);
    }
    r
}

#[tauri::command]
async fn remote_fetch(app: AppHandle, state: State<'_, AppState>, task_id: String, quiet: Option<bool>) -> CmdResult<Written<FetchResult>> {
    // Background auto-fetch doesn't show a password prompt (spec §7.5): it fails when input is needed, and asks when the user fetches or pulls themselves
    let quiet = quiet.unwrap_or(false);
    net_task(app, &state, task_id, NetLog::None, move |p, c, pr| {
        if quiet {
            strand_core::askpass::without_prompt(|| remote::fetch(p, c, pr))
        } else {
            remote::fetch(p, c, pr)
        }
    })
    .await
}

#[tauri::command]
async fn remote_pull(app: AppHandle, state: State<'_, AppState>, task_id: String, mode: PullMode, fetched: Option<bool>) -> CmdResult<Written<PullResult>> {
    // fetched: the UI just fetched and showed the pull summary panel (spec §7.2), so don't fetch again here
    let fetch = !fetched.unwrap_or(false);
    // Snapshot before auto-shelving: undoing this pull returns worktree changes to how they were before the pull
    let (before, branch) = with_repo(&state, |s| {
        let before = s.snapshot()?;
        s.pull_shelve()?;
        Ok((before, s.state()?.head.branch.unwrap_or_default()))
    })
    .await?;
    let label = if matches!(mode, PullMode::Rebase) { format!("拉取 {branch}（变基）") } else { format!("拉取 {branch}") };
    let log = NetLog::Pull(label, Box::new(before));
    net_task(app, &state, task_id, log, move |p, c, pr| remote::pull_with(p, mode, fetch, c, pr)).await
}

/// Pull dry run (spec §7.2): merge once in memory using the last fetch's result, without changing the repository or using the network
#[tauri::command]
async fn remote_pull_preview(state: State<'_, AppState>, mode: PullMode) -> CmdResult<remote::PullPreview> {
    let dirty = with_repo(&state, |s| Ok(s.status()?.changes.len() as u32)).await?;
    let path = repo_path(&state)?;
    let mut p = tauri::async_runtime::spawn_blocking(move || remote::pull_preview(&path, mode))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))??;
    p.dirty = dirty;
    Ok(p)
}

#[tauri::command]
async fn remote_push_preview(state: State<'_, AppState>, to: Option<String>, remote: Option<String>) -> CmdResult<PushPreview> {
    let path = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || remote::push_preview_on(&path, to.as_deref(), remote.as_deref()))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

#[tauri::command]
async fn remote_push(app: AppHandle, state: State<'_, AppState>, task_id: String, force: bool, tags: bool, to: Option<String>, remote: Option<String>) -> CmdResult<Written<()>> {
    let branch = with_repo(&state, |s| Ok(s.state()?.head.branch.unwrap_or_default())).await?;
    let log = NetLog::Push(match &to {
        Some(id) => format!("推送 {branch} 到 {} 为止", &id[..id.len().min(7)]),
        None if force => format!("强制推送 {branch}"),
        None => format!("推送 {branch}"),
    });
    net_task(app, &state, task_id, log, move |p, c, pr| remote::push(p, &PushOptions { force, tags, to, remote }, c, pr)).await
}

/// Push one tag (spec §6.5, §7.4)
#[tauri::command]
async fn tag_push(app: AppHandle, state: State<'_, AppState>, task_id: String, name: String) -> CmdResult<Written<()>> {
    let log = NetLog::Push(format!("推送标签 {name}"));
    net_task(app, &state, task_id, log, move |p, c, pr| remote::tag_push(p, &name, c, pr)).await
}

/// Delete a branch on the remote (e.g. origin/feature); recorded on the timeline, can't be undone
#[tauri::command]
async fn remote_branch_delete(app: AppHandle, state: State<'_, AppState>, task_id: String, name: String) -> CmdResult<Written<()>> {
    let log = NetLog::Push(format!("删除远程分支 {name}"));
    net_task(app, &state, task_id, log, move |p, c, pr| remote::remote_branch_delete(p, &name, c, pr)).await
}

/// Delete a tag on the remote; the local tag stays
#[tauri::command]
async fn remote_tag_delete(app: AppHandle, state: State<'_, AppState>, task_id: String, name: String) -> CmdResult<Written<()>> {
    let log = NetLog::Push(format!("删除远程标签 {name}"));
    net_task(app, &state, task_id, log, move |p, c, pr| remote::remote_tag_delete(p, &name, c, pr)).await
}

/// Set (or clear, with upstream empty) the remote branch a local branch tracks
#[tauri::command]
async fn branch_set_upstream(state: State<'_, AppState>, branch: String, upstream: Option<String>) -> CmdResult<RepoState> {
    with_repo(&state, move |s| {
        s.branch_set_upstream(&branch, upstream.as_deref())?;
        s.reload()?;
        s.state()
    })
    .await
}

// ---------- Managing remotes ----------

#[tauri::command]
async fn remote_list(state: State<'_, AppState>) -> CmdResult<Vec<remote::RemoteInfo>> {
    let path = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || remote::remote_list(&path)).await.map_err(|e| CoreError::git("后台任务异常结束", e))?
}

#[tauri::command]
async fn remote_add(state: State<'_, AppState>, name: String, url: String) -> CmdResult<Written<()>> {
    write_op(&state, move |s| remote::remote_add(s.path(), &name, &url)).await
}

#[tauri::command]
async fn remote_remove(state: State<'_, AppState>, name: String) -> CmdResult<Written<()>> {
    write_op(&state, move |s| remote::remote_remove(s.path(), &name)).await
}

#[tauri::command]
async fn remote_rename(state: State<'_, AppState>, name: String, new_name: String) -> CmdResult<Written<()>> {
    write_op(&state, move |s| remote::remote_rename(s.path(), &name, &new_name)).await
}

#[tauri::command]
async fn remote_set_url(state: State<'_, AppState>, name: String, url: String) -> CmdResult<Written<()>> {
    write_op(&state, move |s| remote::remote_set_url(s.path(), &name, &url)).await
}

// ---------- Conflict resolution (spec §8) ----------
// Marks are kept in the frontend; applying a file passes all of that file's marks.

#[tauri::command]
async fn merge_session(state: State<'_, AppState>) -> CmdResult<Option<MergeSession>> {
    with_repo(&state, |s| s.merge_session()).await
}

#[tauri::command]
async fn merge_apply_file(state: State<'_, AppState>, path: String, marks: HashMap<String, ChangeMark>) -> CmdResult<Written<()>> {
    write_op(&state, move |s| s.merge_apply_file(&path, &marks)).await
}

#[tauri::command]
async fn merge_take_file(state: State<'_, AppState>, path: String, side: Side) -> CmdResult<Written<()>> {
    write_op(&state, move |s| s.merge_take_file(&path, side)).await
}

#[tauri::command]
async fn merge_finish(state: State<'_, AppState>) -> CmdResult<Written<FinishResult>> {
    finish_op(&state, |s| s.merge_finish()).await
}

#[tauri::command]
async fn merge_skip(state: State<'_, AppState>) -> CmdResult<Written<FinishResult>> {
    finish_op(&state, |s| s.merge_skip()).await
}

/// Finish or skip one step of conflict resolution. When the whole merge (or pull, rebase) ends, write it as one op log entry.
async fn finish_op<F>(state: &AppState, f: F) -> CmdResult<Written<FinishResult>>
where
    F: FnOnce(&mut Session) -> CmdResult<FinishResult> + Send + 'static,
{
    with_repo(state, move |s| {
        let r = f(s);
        // The pull's conflict resolution finished: restore the changes auto-shelved before the pull (pull_unshelve does nothing while unfinished)
        let note = if r.is_ok() { s.pull_unshelve()? } else { None };
        let op = if r.is_ok() { s.op_finish_pending()? } else { None };
        s.reload()?;
        Ok(Written { result: r?, state: s.state()?, op, note })
    })
    .await
}

// ---------- Commit operations (spec §5.6, §5.7) ----------

#[tauri::command]
async fn commit_caps(state: State<'_, AppState>, id: String) -> CmdResult<CommitCaps> {
    with_repo(&state, move |s| s.commit_caps(&id)).await
}

#[tauri::command]
async fn commit_cherry_pick(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<Written<()>> {
    let first = ids.first().cloned().unwrap_or_default();
    let n = ids.len();
    logged_op_by(&state, OpKind::Commit, move |s| if n == 1 { format!("拣选{}", title_of(s, &first)) } else { format!("拣选 {n} 个提交") }, move |s| {
        s.commit_cherry_pick(&ids)
    })
    .await
}

#[tauri::command]
async fn commit_revert(state: State<'_, AppState>, id: String) -> CmdResult<Written<()>> {
    let i = id.clone();
    logged_op_by(&state, OpKind::Commit, move |s| format!("还原{}", title_of(s, &i)), move |s| s.commit_revert(&id)).await
}

#[tauri::command]
async fn commit_reset(state: State<'_, AppState>, id: String, mode: ResetMode) -> CmdResult<Written<()>> {
    let how = match mode {
        ResetMode::Soft => "软",
        ResetMode::Mixed => "混合",
        ResetMode::Hard => "硬",
    };
    let label = format!("{how}重置到 {}", id.chars().take(7).collect::<String>());
    logged_op(&state, label, OpKind::Commit, move |s| s.commit_reset(&id, mode)).await
}

#[tauri::command]
async fn commit_undo(state: State<'_, AppState>) -> CmdResult<Written<()>> {
    logged_op_by(&state, OpKind::Commit, |s| format!("撤销提交{}", s.state().ok().and_then(|st| st.head.commit).map(|h| title_of(s, &h)).unwrap_or_default()), |s| {
        s.commit_undo()
    })
    .await
}

#[tauri::command]
async fn commit_reword(state: State<'_, AppState>, id: String, message: String) -> CmdResult<Written<()>> {
    let i = id.clone();
    logged_op_by(&state, OpKind::Commit, move |s| format!("修改说明{}", title_of(s, &i)), move |s| s.commit_reword(&id, &message)).await
}

#[tauri::command]
async fn commit_drop(state: State<'_, AppState>, id: String) -> CmdResult<Written<()>> {
    let i = id.clone();
    logged_op_by(&state, OpKind::Commit, move |s| format!("丢弃提交{}", title_of(s, &i)), move |s| s.commit_drop(&id)).await
}

// ---------- Blame (spec §10.2) ----------

/// Blame `limit` lines starting at line offset+1; rev empty means the file in the worktree
#[tauri::command]
async fn blame_file(state: State<'_, AppState>, path: String, rev: Option<String>, offset: u32, limit: u32) -> CmdResult<strand_core::blame::BlamePage> {
    with_repo(&state, move |s| s.blame_file(&path, rev.as_deref(), offset, limit)).await
}

// ---------- Compare, patches, browsing a revision (spec §10.3–10.5) ----------

#[tauri::command]
async fn compare(state: State<'_, AppState>, from: String, to: String) -> CmdResult<strand_core::compare::Comparison> {
    with_repo(&state, move |s| s.compare(&from, &to)).await
}

#[tauri::command]
async fn diff_compare(state: State<'_, AppState>, from: String, to: String, path: String, context: Option<u32>) -> CmdResult<FileDiff> {
    with_repo(&state, move |s| s.diff_compare_ctx(&from, &to, &path, context.unwrap_or(3))).await
}

#[tauri::command]
async fn patch_commit(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    with_repo(&state, move |s| s.patch_commit(&id)).await
}

#[tauri::command]
async fn patch_worktree(state: State<'_, AppState>, selection: Selection) -> CmdResult<String> {
    with_repo(&state, move |s| s.patch_worktree(&selection)).await
}

#[tauri::command]
async fn commit_tree(state: State<'_, AppState>, id: String) -> CmdResult<Vec<String>> {
    with_repo(&state, move |s| s.commit_tree(&id)).await
}

/// Project files (the file tree on the left): tracked files and untracked files that aren't ignored. Runs in the background without holding the repository
#[tauri::command]
async fn project_files(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let path = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || strand_core::Session::open(&path)?.project_files())
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// File content: from the worktree when rev is empty
#[tauri::command]
async fn file_text(state: State<'_, AppState>, path: String, rev: Option<String>) -> CmdResult<strand_core::file_history::FileText> {
    with_repo(&state, move |s| s.file_text(&path, rev.as_deref())).await
}

/// Text on the system clipboard (used when the web clipboard API can't read it in the desktop app)
#[tauri::command]
async fn clipboard_text() -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        let out = std::process::Command::new("pbpaste").output();
        #[cfg(target_os = "windows")]
        let out = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"])
                .creation_flags(0x0800_0000)
                .output()
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let out: std::io::Result<std::process::Output> = Err(std::io::Error::other("不支持"));
        match out {
            Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).into_owned()),
            _ => Err(CoreError::new(strand_core::ErrorCode::GitFailed, "读不到剪贴板")),
        }
    })
    .await
    .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// Whole-file diff of two texts (compare any two files, compare with clipboard)
#[tauri::command]
async fn text_diff(left: String, right: String, name: String) -> CmdResult<strand_core::model::FileDiff> {
    tauri::async_runtime::spawn_blocking(move || strand_core::compare::text_diff(&left, &right, &name))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// A file's raw bytes at a revision (image diffs); rev empty means the worktree. Returned as binary directly, not through JSON
#[tauri::command]
async fn file_bytes(state: State<'_, AppState>, path: String, rev: Option<String>) -> CmdResult<tauri::ipc::Response> {
    let b = with_repo(&state, move |s| s.file_bytes(&path, rev.as_deref())).await?;
    Ok(tauri::ipc::Response::new(b))
}

/// Save a worktree file after editing in the diff; expected is the content read when editing started (not overwritten if the file on disk changed)
#[tauri::command]
async fn save_worktree_file(state: State<'_, AppState>, path: String, text: String, expected: String) -> CmdResult<()> {
    with_repo(&state, move |s| s.save_worktree_file(&path, &text, &expected)).await
}

/// File change chain: git log --follow runs in the background (seconds on long histories), refs are filled in afterwards
#[tauri::command]
async fn file_history(state: State<'_, AppState>, path: String) -> CmdResult<strand_core::file_history::FileHistory> {
    let dir = repo_path(&state)?;
    let mut h = tauri::async_runtime::spawn_blocking(move || strand_core::file_history::history_at(&dir, &path))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))??;
    with_repo(&state, move |s| {
        s.fill_versions(&mut h);
        Ok(h)
    })
    .await
}

/// The diff between two versions of the same file: from empty means added, to empty means the worktree
#[tauri::command]
async fn file_diff_versions(state: State<'_, AppState>, from: Option<String>, from_path: String, to: Option<String>, to_path: String, context: Option<u32>) -> CmdResult<FileDiff> {
    with_repo(&state, move |s| s.file_diff_versions_ctx(from.as_deref(), &from_path, to.as_deref(), &to_path, context.unwrap_or(3))).await
}

/// When searching by changes, the files in this commit whose changed lines match
#[tauri::command]
async fn commit_change_matches(state: State<'_, AppState>, id: String, text: String, regex: bool, case_sensitive: bool) -> CmdResult<Vec<strand_core::search::ChangeMatch>> {
    with_repo(&state, move |s| s.commit_change_matches(&id, &text, regex, case_sensitive)).await
}

/// Full-text search of project files (git grep): rev empty means the worktree. Runs in the background without holding the repository
#[tauri::command]
async fn project_search(state: State<'_, AppState>, text: String, regex: bool, case_sensitive: bool, rev: Option<String>) -> CmdResult<strand_core::search::ProjectSearch> {
    let dir = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || strand_core::search::project_search(&dir, &text, regex, case_sensitive, rev.as_deref()))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// Write text to the path the user picked in the system save dialog (for saving patches)
#[tauri::command]
async fn file_save(path: String, text: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, text))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
        .map_err(|e| CoreError::git("保存文件失败", e))
}

/// Read a text file (a chosen patch file, a patch dragged into the window); at most 20 MB
#[tauri::command]
async fn file_read_text(path: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| CoreError::git("读取文件失败", e))?;
        if meta.len() > 20 << 20 {
            return Err(CoreError::new(strand_core::ErrorCode::InvalidRange, "文件太大（超过 20 MB）"));
        }
        let b = std::fs::read(&path).map_err(|e| CoreError::git("读取文件失败", e))?;
        Ok(String::from_utf8_lossy(&b).into_owned())
    })
    .await
    .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

// ---------- Bisect ----------

#[tauri::command]
async fn bisect_status(state: State<'_, AppState>) -> CmdResult<strand_core::bisect::BisectStatus> {
    with_repo(&state, |s| s.bisect_status()).await
}

#[tauri::command]
async fn bisect_mark(state: State<'_, AppState>, mark: strand_core::bisect::BisectMark, rev: Option<String>) -> CmdResult<Written<strand_core::bisect::BisectStatus>> {
    write_op(&state, move |s| s.bisect_mark(mark, rev.as_deref())).await
}

#[tauri::command]
async fn bisect_reset(state: State<'_, AppState>) -> CmdResult<Written<()>> {
    write_op(&state, |s| s.bisect_reset()).await
}

// ---------- Signing ----------

#[tauri::command]
async fn commit_signature(state: State<'_, AppState>, id: String) -> CmdResult<strand_core::sign::Signature> {
    with_repo(&state, move |s| s.commit_signature(&id)).await
}

#[tauri::command]
async fn signing_config(state: State<'_, AppState>) -> CmdResult<strand_core::sign::SigningConfig> {
    with_repo(&state, |s| s.signing_config()).await
}

#[tauri::command]
async fn signing_set(state: State<'_, AppState>, commit: bool) -> CmdResult<strand_core::sign::SigningConfig> {
    with_repo(&state, move |s| s.signing_set(commit)).await
}

// ---------- Reflog ----------

#[tauri::command]
async fn reflog_refs(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    with_repo(&state, |s| s.reflog_refs()).await
}

#[tauri::command]
async fn reflog(state: State<'_, AppState>, name: String) -> CmdResult<Vec<strand_core::reflog::ReflogEntry>> {
    with_repo(&state, move |s| s.reflog(&name)).await
}

// ---------- Applying patches ----------

#[tauri::command]
async fn patch_preview(state: State<'_, AppState>, text: String) -> CmdResult<strand_core::patch::PatchPreview> {
    with_repo(&state, move |s| s.patch_preview(&text)).await
}

/// Apply a patch: with commit true create commits from mailbox format, otherwise apply to the worktree (entering conflict resolution on conflicts)
#[tauri::command]
async fn patch_apply(state: State<'_, AppState>, text: String, commit: bool) -> CmdResult<Written<usize>> {
    let n = strand_core::patch::mail_commits(&text).len();
    let (label, kind) = if commit { (format!("应用补丁（{n} 个提交）"), OpKind::Commit) } else { ("应用补丁到工作区".to_string(), OpKind::Other) };
    logged_op(&state, label, kind, move |s| s.patch_apply(&text, commit)).await
}

/// Cherry-pick or revert only some files of a commit, leaving the result in the worktree (no commit)
#[tauri::command]
async fn commit_files_apply(state: State<'_, AppState>, id: String, paths: Vec<String>, revert: bool) -> CmdResult<Written<()>> {
    let title = with_repo(&state, { let id = id.clone(); move |s| Ok(title_of(s, &id)) }).await?;
    let what = if paths.len() == 1 { paths[0].clone() } else { format!("{} 个文件", paths.len()) };
    let label = if revert { format!("还原{title}里的 {what}") } else { format!("拣选{title}里的 {what}") };
    // Snapshots only cover tracked files: a cherry-pick may create files, so record these paths too so undo can delete them
    let scope = OpScope { files: paths.clone(), ..Default::default() };
    logged_op_scoped(&state, label, OpKind::Other, scope, move |s| s.commit_files_apply(&id, &paths, revert)).await
}

/// Replace a worktree file with its content at a revision
#[tauri::command]
async fn file_restore(state: State<'_, AppState>, id: String, path: String) -> CmdResult<Written<()>> {
    let label = format!("把 {path} 取回到 {}", &id[..id.len().min(7)]);
    let scope = OpScope { files: vec![path.clone()], ..Default::default() };
    logged_op_scoped(&state, label, OpKind::Other, scope, move |s| s.file_restore(&id, &path)).await
}

// ---------- Discarding changes, untracked files (spec §4.7, §4.8) ----------

#[tauri::command]
async fn changes_discard(state: State<'_, AppState>, paths: Vec<String>) -> CmdResult<Written<()>> {
    let label = if paths.len() == 1 { format!("丢弃 {} 的改动", paths[0]) } else { format!("丢弃 {} 个文件的改动", paths.len()) };
    logged_op(&state, label, OpKind::Other, move |s| s.changes_discard(&paths)).await
}

#[tauri::command]
async fn untracked_add(state: State<'_, AppState>, path: String) -> CmdResult<Written<()>> {
    // Snapshots only cover tracked files, so record this file too; otherwise undo would delete it as an added file
    let scope = OpScope { files: vec![path.clone()], ..Default::default() };
    logged_op_scoped(&state, format!("把 {path} 加入版本控制"), OpKind::Other, scope, move |s| s.untracked_add(&path)).await
}

/// Add to ignore rules (writes .gitignore, not recorded in the op log: .gitignore itself shows up in changes and can be discarded)
#[tauri::command]
async fn untracked_ignore(state: State<'_, AppState>, path: String) -> CmdResult<Written<()>> {
    let scope = OpScope { files: vec![".gitignore".into()], ..Default::default() };
    logged_op_scoped(&state, format!("把 {path} 加入忽略规则"), OpKind::Other, scope, move |s| s.untracked_ignore(&path)).await
}

/// Delete an untracked file: moved to the Trash and recoverable from there (not recorded in the op log)
/// Move every untracked file to the trash in one step (undo brings them back)
#[tauri::command]
async fn untracked_delete_all(state: State<'_, AppState>) -> CmdResult<Written<Vec<String>>> {
    let files = with_repo(&state, |s| Ok(s.status()?.untracked)).await?;
    let label = format!("把 {} 个未跟踪的文件移到废纸篓", files.len());
    let scope = OpScope { files, ..Default::default() };
    logged_op_scoped(&state, label, OpKind::Other, scope, |s| s.untracked_delete_all()).await
}

/// Create a branch where a stash was made and bring the stash back there (git stash branch)
#[tauri::command]
async fn stash_branch(state: State<'_, AppState>, index: usize, name: String) -> CmdResult<Written<()>> {
    let (label, files) = with_repo(&state, {
        let name = name.clone();
        move |s| {
            let m = s.stash_list().ok().and_then(|l| l.into_iter().find(|e| e.index == index)).map(|e| short(&e.message)).unwrap_or_default();
            Ok((format!("从贮藏“{m}”新建分支 {name}"), s.stash_untracked_files(index).unwrap_or_default()))
        }
    })
    .await?;
    let scope = OpScope { files, ..Default::default() };
    logged_op_scoped(&state, label, OpKind::Stash, scope, move |s| s.stash_branch(index, &name)).await
}

#[tauri::command]
async fn untracked_delete(state: State<'_, AppState>, path: String) -> CmdResult<Written<()>> {
    let scope = OpScope { files: vec![path.clone()], ..Default::default() };
    logged_op_scoped(&state, format!("把 {path} 移到废纸篓"), OpKind::Other, scope, move |s| s.untracked_delete(&path)).await
}

// ---------- Rebasing commits (spec §9) ----------

#[tauri::command]
async fn rebase_range(state: State<'_, AppState>, from: Option<String>) -> CmdResult<RebaseRange> {
    with_repo(&state, move |s| s.rebase_range(from.as_deref())).await
}

#[tauri::command]
async fn rebase_apply(state: State<'_, AppState>, steps: Vec<Step>) -> CmdResult<Written<RebaseResult>> {
    let label = format!("整理 {} 个提交", steps.len());
    logged_op(&state, label, OpKind::Commit, move |s| s.rebase_apply(&steps)).await
}

/// Fixup (empty message) or Squash Into (with a new message): fold the checked changes into a commit
#[tauri::command]
async fn commit_fixup(state: State<'_, AppState>, id: String, selection: Selection, message: Option<String>) -> CmdResult<Written<()>> {
    let i = id.clone();
    logged_op_by(&state, OpKind::Commit, move |s| format!("把改动并入{}", title_of(s, &i)), move |s| s.commit_fixup(&id, &selection, message.as_deref())).await
}

// ---------- Stash and shelf (spec §4.9) ----------

#[tauri::command]
async fn stash_list(state: State<'_, AppState>) -> CmdResult<Vec<StashEntry>> {
    with_repo(&state, |s| s.stash_list()).await
}

#[tauri::command]
async fn stash_files(state: State<'_, AppState>, index: usize) -> CmdResult<Vec<strand_core::model::FileChange>> {
    with_repo(&state, move |s| s.stash_files(index)).await
}

#[tauri::command]
async fn stash_push(state: State<'_, AppState>, message: Option<String>, include_untracked: Option<bool>) -> CmdResult<Written<()>> {
    let with_untracked = include_untracked.unwrap_or(false);
    // Snapshots only cover tracked files: record the untracked ones too so undo puts them back
    let files = if with_untracked { with_repo(&state, |s| Ok(s.status()?.untracked)).await? } else { Vec::new() };
    let scope = OpScope { files, ..Default::default() };
    let label = if with_untracked { "贮藏改动（含未跟踪的文件）" } else { "贮藏改动" };
    logged_op_scoped(&state, label.into(), OpKind::Stash, scope, move |s| s.stash_push(message.as_deref(), with_untracked)).await
}

/// Restore a stash: `drop` true restores and deletes (pop), otherwise restores and keeps (apply)
#[tauri::command]
async fn stash_apply(state: State<'_, AppState>, index: usize, drop: bool) -> CmdResult<Written<()>> {
    // Untracked files the stash brings back: recorded so undo removes them again
    let (label, files) = with_repo(&state, move |s| {
        let m = s.stash_list().ok().and_then(|l| l.into_iter().find(|e| e.index == index)).map(|e| short(&e.message)).unwrap_or_default();
        Ok((format!("{}贮藏“{m}”", if drop { "取回" } else { "应用" }), s.stash_untracked_files(index).unwrap_or_default()))
    })
    .await?;
    let scope = OpScope { files, ..Default::default() };
    logged_op_scoped(&state, label, OpKind::Stash, scope, move |s| s.stash_apply(index, drop)).await
}

#[tauri::command]
async fn stash_drop(state: State<'_, AppState>, index: usize) -> CmdResult<Written<()>> {
    logged_op_by(
        &state,
        OpKind::Stash,
        move |s| {
            let m = s.stash_list().ok().and_then(|l| l.into_iter().find(|e| e.index == index)).map(|e| short(&e.message)).unwrap_or_default();
            format!("丢弃贮藏“{m}”")
        },
        move |s| s.stash_drop(index),
    )
    .await
}

#[tauri::command]
async fn shelf_list(state: State<'_, AppState>) -> CmdResult<Vec<ShelfEntry>> {
    with_repo(&state, |s| s.shelf_list()).await
}

#[tauri::command]
async fn shelf_save(state: State<'_, AppState>, name: String, paths: Vec<String>) -> CmdResult<Written<ShelfEntry>> {
    let label = if name.trim().is_empty() { "搁置改动".to_string() } else { format!("搁置“{}”", short(name.trim())) };
    // Untracked files being shelved are removed from the worktree: record them so undo brings them back
    let p2 = paths.clone();
    let files = with_repo(&state, move |s| Ok(s.status()?.untracked.into_iter().filter(|u| p2.contains(u)).collect::<Vec<_>>())).await?;
    let scope = OpScope { files, ..Default::default() };
    logged_op_scoped(&state, label, OpKind::Shelf, scope, move |s| s.shelf_save(&name, &paths)).await
}

#[tauri::command]
async fn shelf_restore(state: State<'_, AppState>, id: u64, paths: Option<Vec<String>>) -> CmdResult<Written<()>> {
    let some = paths.as_ref().map(|p| p.len());
    // Added files the entry brings back (including once-untracked ones): recorded so undo removes them again
    let p2 = paths.clone();
    let (label, files) = with_repo(&state, move |s| {
        let entry = s.shelf_list().ok().and_then(|l| l.into_iter().find(|e| e.id == id));
        let n = entry.as_ref().map(|e| e.name.clone()).unwrap_or_default();
        let label = match some {
            // Restore only some files (spec §4.9)
            Some(k) => format!("从搁置“{}”取回 {k} 个文件", short(&n)),
            None => format!("取回搁置“{}”", short(&n)),
        };
        let added = entry
            .map(|e| e.files.into_iter().filter(|f| f.status == strand_core::model::FileStatus::A).map(|f| f.path).filter(|f| p2.as_ref().is_none_or(|p| p.contains(f))).collect())
            .unwrap_or_default();
        Ok((label, added))
    })
    .await?;
    let scope = OpScope { files, ..Default::default() };
    logged_op_scoped(&state, label, OpKind::Shelf, scope, move |s| match &paths {
        Some(p) => s.shelf_restore_files(id, p),
        None => s.shelf_restore(id),
    })
    .await
}

#[tauri::command]
async fn shelf_delete(state: State<'_, AppState>, id: u64) -> CmdResult<Written<()>> {
    logged_op_by(
        &state,
        OpKind::Shelf,
        move |s| {
            let n = s.shelf_list().ok().and_then(|l| l.into_iter().find(|e| e.id == id)).map(|e| e.name).unwrap_or_default();
            format!("删除搁置“{}”", short(&n))
        },
        move |s| s.shelf_delete(id),
    )
    .await
}

#[tauri::command]
async fn shelf_files(state: State<'_, AppState>, id: u64) -> CmdResult<Vec<strand_core::model::FileChange>> {
    with_repo(&state, move |s| s.shelf_files(id)).await
}

#[tauri::command]
async fn shelf_diff(state: State<'_, AppState>, id: u64, path: String, context: Option<u32>) -> CmdResult<strand_core::model::FileDiff> {
    with_repo(&state, move |s| s.shelf_diff(id, &path, context)).await
}

#[tauri::command]
async fn shelf_rename(state: State<'_, AppState>, id: u64, name: String) -> CmdResult<()> {
    with_repo(&state, move |s| s.shelf_rename(id, &name)).await
}

// ---------- Undo, redo and the op timeline (spec §11) ----------

#[tauri::command]
async fn oplog_list(state: State<'_, AppState>, limit: Option<usize>) -> CmdResult<OpList> {
    with_repo(&state, move |s| s.oplog_list(limit.unwrap_or(50))).await
}

/// Undo the latest step, or undo up to and including `to_id`. Crossing pushed steps needs `confirm_pushed`.
#[tauri::command]
async fn oplog_undo(state: State<'_, AppState>, to_id: Option<u64>, confirm_pushed: Option<bool>) -> CmdResult<Written<Vec<OpInfo>>> {
    write_op(&state, move |s| s.oplog_undo(to_id, confirm_pushed.unwrap_or(false))).await
}

#[tauri::command]
async fn oplog_redo(state: State<'_, AppState>) -> CmdResult<Written<Vec<OpInfo>>> {
    write_op(&state, |s| s.oplog_redo()).await
}

// ---------- When credentials are needed (spec §7.5) ----------

/// Requests waiting for the user's answer: id → channel handing the answer back to askpass
static AUTH_WAIT: Mutex<Option<HashMap<String, std::sync::mpsc::Sender<Option<String>>>>> = Mutex::new(None);

#[derive(Serialize, Clone)]
struct AuthEvent {
    request_id: String,
    prompt: String,
    secret: bool,
}

/// When git needs input, ask the UI through askpass: emit `auth_required` and wait for `auth_reply`;
/// when the user presses stop (task cancelled), close the input box (`auth_closed`) and treat it as cancelled.
fn setup_askpass(app: AppHandle) {
    if let Ok(exe) = std::env::current_exe() {
        strand_core::askpass::set_program(exe);
    }
    let seq = std::sync::atomic::AtomicU64::new(0);
    strand_core::askpass::set_asker(Arc::new(move |req, cancel| {
        let id = format!("auth-{}", seq.fetch_add(1, Ordering::SeqCst) + 1);
        let (tx, rx) = std::sync::mpsc::channel();
        AUTH_WAIT.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), tx);
        let _ = app.emit("auth_required", AuthEvent { request_id: id.clone(), prompt: req.prompt.clone(), secret: req.secret });
        let answer = loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(a) => break a,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) if !cancel.is_cancelled() => continue,
                _ => {
                    let _ = app.emit("auth_closed", id.clone());
                    break None;
                }
            }
        };
        if let Some(m) = AUTH_WAIT.lock().unwrap().as_mut() {
            m.remove(&id);
        }
        answer
    }));
}

/// Answer `auth_required`; an empty `secret` means cancel. Answers aren't logged and only go to the git process that asked.
#[tauri::command]
fn auth_reply(request_id: String, secret: Option<String>) {
    let tx = AUTH_WAIT.lock().unwrap().as_mut().and_then(|m| m.remove(&request_id));
    if let Some(tx) = tx {
        let _ = tx.send(secret);
    }
}

/// Console (spec §5.8): new entries emit a `console_line` event; the same content is written to the app log directory (kept 7 days)
fn setup_console(app: AppHandle) {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_log_dir() {
        strand_core::console::set_log_dir(dir);
    }
    strand_core::console::set_sink(Arc::new(move |e| {
        let _ = app.emit("console_line", e);
    }));
}

/// Latest console entries (oldest to newest)
#[tauri::command]
fn console_tail(limit: Option<usize>) -> Vec<strand_core::console::Entry> {
    strand_core::console::tail(limit.unwrap_or(strand_core::console::MAX_LINES))
}

/// Clear the console (log files untouched)
#[tauri::command]
fn console_clear() {
    strand_core::console::clear();
}

// ---------- App updates ----------
// Releases on GitHub carry latest.json and signed update packages; the updater checks it, verifies the signature
// with the public key in tauri.conf.json, installs, and restarts. STRAND_UPDATE_ENDPOINT overrides the endpoint (for testing).

#[derive(Clone, Serialize)]
struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
    /// RFC 3339
    date: Option<String>,
}

#[derive(Clone, Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

fn updater(app: &AppHandle) -> CmdResult<tauri_plugin_updater::Updater> {
    use tauri_plugin_updater::UpdaterExt;
    let err = |e: tauri_plugin_updater::Error| CoreError::new(ErrorCode::Network, "检查更新失败").with_detail(serde_json::json!({ "source": e.to_string() }));
    let mut b = app.updater_builder().timeout(Duration::from_secs(30));
    if let Some(u) = std::env::var("STRAND_UPDATE_ENDPOINT").ok().and_then(|u| u.parse().ok()) {
        b = b.endpoints(vec![u]).map_err(err)?;
    }
    b.build().map_err(err)
}

/// Check for a newer version; None when up to date
#[tauri::command]
async fn update_check(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<UpdateInfo>> {
    let found = updater(&app)?
        .check()
        .await
        .map_err(|e| CoreError::new(ErrorCode::Network, "检查更新失败，可能是网络不通").with_detail(serde_json::json!({ "source": e.to_string() })))?;
    let info = found.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.raw_json.get("pub_date").and_then(|v| v.as_str()).map(String::from),
    });
    *state.update.lock().map_err(|_| CoreError::new(ErrorCode::RepoBusy, "更新状态不可用"))? = found;
    Ok(info)
}

/// Download and install the update found by the last check, reporting `update_progress`, then restart
#[tauri::command]
async fn update_install(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let update = state
        .update
        .lock()
        .map_err(|_| CoreError::new(ErrorCode::RepoBusy, "更新状态不可用"))?
        .take()
        .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "没有可以安装的更新，先检查更新"))?;
    let mut downloaded: u64 = 0;
    let mut last = Instant::now() - Duration::from_secs(1);
    let a = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                if last.elapsed() >= Duration::from_millis(100) || total == Some(downloaded) {
                    last = Instant::now();
                    let _ = a.emit("update_progress", UpdateProgress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| {
            let source = e.to_string();
            let msg = if source.to_lowercase().contains("signature") { "更新包的签名对不上，没有安装（可能被替换过）" } else { "下载或安装更新失败" };
            CoreError::new(ErrorCode::Network, msg).with_detail(serde_json::json!({ "source": source }))
        })?;
    strand_core::console::note("已安装更新，重新启动");
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// `adopted`: the login shell's PATH was merged in at startup, and how many ms it took (written to the console and log to help tell which git is used)
pub fn run(adopted: Option<u128>) {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Remember the window's size, position and maximized state between launches
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .setup(move |app| {
            setup_askpass(app.handle().clone());
            setup_console(app.handle().clone());
            setup_menu(app.handle())?;
            if let Some(ms) = adopted {
                strand_core::console::note(&format!("从访达启动：使用登录 shell 的 PATH（读取用了 {ms} ms）"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            git_check,
            launch_path,
            console_tail,
            console_clear,
            repo_open,
            repo_state,
            repo_reload,
            repo_refresh,
            branch_squash_message,
            log_query,
            commit_amend,
            blame_file,
            compare,
            diff_compare,
            patch_commit,
            patch_worktree,
            commit_tree,
            project_files,
            file_text,
            file_read_text,
            patch_preview,
            reflog_refs,
            bisect_status,
            bisect_mark,
            bisect_reset,
            remote_list,
            remote_add,
            remote_remove,
            remote_rename,
            remote_set_url,
            commit_signature,
            signing_config,
            signing_set,
            reflog,
            patch_apply,
            save_worktree_file,
            file_bytes,
            text_diff,
            clipboard_text,
            file_history,
            file_diff_versions,
            commit_change_matches,
            project_search,
            file_save,
            changes_discard,
            commit_files_apply,
            file_restore,
            untracked_add,
            untracked_ignore,
            untracked_delete,
            rebase_range,
            rebase_apply,
            commit_fixup,
            stash_list,
            stash_files,
            stash_push,
            stash_apply,
            stash_drop,
            shelf_list,
            shelf_files,
            shelf_diff,
            shelf_save,
            shelf_restore,
            shelf_delete,
            shelf_rename,
            commit_caps,
            commit_cherry_pick,
            commit_revert,
            commit_reset,
            commit_undo,
            commit_reword,
            commit_drop,
            oplog_list,
            oplog_undo,
            oplog_redo,
            log_authors,
            status_get,
            diff_worktree,
            commit_create,
            commit_detail,
            compose_info,
            git_config_get,
            git_config_set,
            git_proxy_enable,
            update_check,
            update_install,
            changelists_get,
            changelists_set,
            diff_commit,
            refs_list,
            log_locate,
            branch_create,
            branch_switch,
            branch_rename,
            branch_delete,
            branch_merge,
            branch_merge_into,
            prefs_set_favorite,
            branch_rebase_plan,
            branch_rebase,
            merge_abort,
            branch_checkout_remote,
            checkout_detached,
            tag_create,
            tag_delete,
            task_cancel,
            checks_config_get,
            worktree_add,
            worktree_remove,
            repo_clone,
            checks_config_set,
            checks_run,
            remote_fetch,
            submodule_list,
            submodule_update,
            lfs_installed,
            lfs_pull,
            window_close,
            open_new_window,
            notify,
            untracked_delete_all,
            stash_branch,
            window_set_title,
            remote_branch_delete,
            remote_tag_delete,
            branch_set_upstream,
            file_reveal,
            file_open,
            repo_terminal,
            merged_branches,
            contributions,
            hosting_info,
            hosting_set_token,
            pr_list,
            pr_checks,
            pr_create,
            branches_delete,
            remote_pull,
            remote_pull_preview,
            remote_push_preview,
            remote_push,
            tag_push,
            merge_session,
            merge_apply_file,
            merge_take_file,
            merge_finish,
            merge_skip,
            auth_reply,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Strand 失败");
}
