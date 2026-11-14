//! 桌面外壳：把核心层注册成 Tauri 命令。
//!
//! 命令名和说明书一致。所有读操作放到后台线程执行，不阻塞界面线程（说明书 15 节）。
//! 新增命令时：在核心层实现并测试 → 在这里加一个薄包装 → 在 `generate_handler!` 注册
//! → 在前端 `src/api/commands.ts` 加对应函数和类型。

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
    /// 当前仓库的文件监听；换仓库时替换，旧的随之停止
    watcher: Mutex<Option<strand_core::watch::Watcher>>,
    /// 进行中的长任务，按前端给的 task_id 记录取消令牌
    tasks: Mutex<HashMap<String, Cancel>>,
    /// 同一时间只跑一个网络操作
    net_busy: AtomicBool,
}

/// 核心层推给前端的 `repo_changed` 事件（说明书 2.2）
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

/// 在后台线程里对当前仓库执行 `f`。
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

/// 检测系统 Git。安装包不附带 Git，找不到时前端提示用户安装。
#[tauri::command]
async fn git_check() -> GitInfo {
    tauri::async_runtime::spawn_blocking(strand_core::git_cli::check)
        .await
        .unwrap_or_else(|_| strand_core::git_cli::check())
}

/// 启动参数里的仓库路径：`strand /path/to/repo` 直接打开这个仓库。没有就返回空。
#[tauri::command]
fn launch_path() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir())
}

/// 打开仓库：读取日志并算好图谱，返回仓库状态。
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
    // 监听失败不影响使用，只是不会自动刷新
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

/// 重新读取日志（外部修改仓库后调用；之后由文件监听自动触发）。
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
    /// 引用或 HEAD 变了、重新读取了日志；为假时界面不用重新取日志
    changed: bool,
}

/// 文件监听触发的刷新：引用和 HEAD 没变就不重新读取日志（Strand 自己的写操作已经读过）
#[tauri::command]
async fn repo_refresh(state: State<'_, AppState>) -> CmdResult<Refreshed> {
    with_repo(&state, |s| {
        let changed = s.reload_if_changed()?;
        Ok(Refreshed { state: s.state()?, changed })
    })
    .await
}

/// 日志分页，可带过滤和排序（说明书 5.1）。
///
/// 路径过滤要在全部历史上跑一次 `git rev-list`，大仓库要几秒；这一步在仓库锁外面做，
/// 不挡住其他命令，算好后放进核心层的缓存。
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
    // 路径过滤在核心层的后台线程里跑，没算完时返回目前的结果并标记 partial（说明书 15）
    with_repo(&state, move |s| s.log_query(&f, sort, offset, limit)).await
}

/// 作者过滤的选项（说明书 5.1）
#[tauri::command]
async fn log_authors(state: State<'_, AppState>) -> CmdResult<Vec<LogAuthor>> {
    with_repo(&state, |s| s.log_authors()).await
}

/// 工作区改动和未跟踪的文件（说明书 4.10）
#[tauri::command]
async fn status_get(state: State<'_, AppState>) -> CmdResult<WorktreeStatus> {
    with_repo(&state, |s| s.status()).await
}

#[tauri::command]
async fn diff_worktree(state: State<'_, AppState>, path: String, ignore_ws: Option<bool>, context: Option<u32>) -> CmdResult<FileDiff> {
    with_repo(&state, move |s| s.diff_worktree(&path, ignore_ws.unwrap_or(false), context.unwrap_or(3))).await
}

/// 按勾选的文件提交，提交后刷新日志。返回新提交的版本号和仓库状态。
#[tauri::command]
async fn commit_create(state: State<'_, AppState>, message: String, selection: Selection, sign_off: Option<bool>) -> CmdResult<CommitCreated> {
    with_repo(&state, move |s| {
        let title = message.lines().next().unwrap_or("").trim().to_string();
        let r = s.run_op_reload(&format!("提交“{}”", short(&title)), OpKind::Commit, |s| s.commit_create(&message, &selection, sign_off.unwrap_or(false)));
        let (id, op) = r?;
        Ok(CommitCreated { id, state: s.state()?, op })
    })
    .await
}

/// 修订上一次提交（说明书 4.5）：message 为空时保留原说明
#[tauri::command]
async fn commit_amend(state: State<'_, AppState>, message: Option<String>, selection: Selection, sign_off: Option<bool>) -> CmdResult<CommitCreated> {
    with_repo(&state, move |s| {
        let head = s.state()?.head.commit.unwrap_or_default();
        let label = format!("修订{}", title_of(s, &head));
        let r = s.run_op_reload(&label, OpKind::Commit, |s| s.commit_amend(message.as_deref(), &selection, sign_off.unwrap_or(false)));
        let (id, op) = r?;
        Ok(CommitCreated { id, state: s.state()?, op })
    })
    .await
}

#[tauri::command]
async fn commit_detail(state: State<'_, AppState>, id: String) -> CmdResult<CommitDetail> {
    with_repo(&state, move |s| s.commit_detail(&id)).await
}

#[tauri::command]
async fn diff_commit(state: State<'_, AppState>, id: String, path: String, context: Option<u32>) -> CmdResult<FileDiff> {
    with_repo(&state, move |s| s.diff_commit_ctx(&id, &path, context.unwrap_or(3))).await
}

// ---------- 分支和标签（说明书第 6 节） ----------
// 写操作完成后重新读取日志，返回最新的仓库状态。

/// 执行一个写操作，然后刷新日志，返回操作结果和仓库状态。
async fn write_op<T, F>(state: &AppState, f: F) -> CmdResult<Written<T>>
where
    T: Send + Serialize + 'static,
    F: FnOnce(&mut Session) -> CmdResult<T> + Send + 'static,
{
    with_repo(state, move |s| {
        let result = f(s);
        // 操作失败也可能已经改了仓库（比如合并停在冲突），照样刷新
        s.reload()?;
        Ok(Written { result: result?, state: s.state()?, op: None, note: None })
    })
    .await
}

/// 记入操作日志的写操作（说明书第 11 节）：返回值带 `op`，前端用它显示带撤销图标的提示
async fn logged_op<T, F>(state: &AppState, label: String, kind: OpKind, f: F) -> CmdResult<Written<T>>
where
    T: Send + Serialize + 'static,
    F: FnOnce(&mut Session) -> CmdResult<T> + Send + 'static,
{
    with_repo(state, move |s| {
        // 操作后的快照和重新读取日志同时进行（说明书 15）
        let r = s.run_op_reload(&label, kind, f);
        let (result, op) = r?;
        Ok(Written { result, state: s.state()?, op, note: None })
    })
    .await
}

/// 同 `logged_op`，另外按 `scope` 记下未跟踪文件或工作目录（快照只管已跟踪文件），让这些操作也能撤销
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

/// 同 `logged_op`，但日志的说明要先读仓库才能写出来（比如用提交的标题）
async fn logged_op_by<T, L, F>(state: &AppState, kind: OpKind, label: L, f: F) -> CmdResult<Written<T>>
where
    T: Send + Serialize + 'static,
    L: FnOnce(&Session) -> String + Send + 'static,
    F: FnOnce(&mut Session) -> CmdResult<T> + Send + 'static,
{
    with_repo(state, move |s| {
        let label = label(s);
        // 操作后的快照和重新读取日志同时进行（说明书 15）
        let r = s.run_op_reload(&label, kind, f);
        let (result, op) = r?;
        Ok(Written { result, state: s.state()?, op, note: None })
    })
    .await
}

/// 提交的标题，用在操作日志的说明里
fn title_of(s: &Session, id: &str) -> String {
    s.commit_title(id).map(|t| format!("“{}”", short(&t))).unwrap_or_else(|| id.chars().take(7).collect())
}

/// 提示里显示的提交标题，太长时截断
fn short(t: &str) -> String {
    if t.chars().count() > 40 { format!("{}…", t.chars().take(40).collect::<String>()) } else { t.to_string() }
}

#[derive(Serialize)]
struct Written<T> {
    result: T,
    state: RepoState,
    /// 这次操作写进操作日志的那一条；没有记日志（无变化、冲突未解决、只读操作）时省略
    #[serde(skip_serializing_if = "Option::is_none")]
    op: Option<OpInfo>,
    /// 给用户的补充说明，如拉取后自动搁置的改动没能放回（说明书 7.2）
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
    // 过滤结果还没算完时按目前的结果找（找不到返回 null）
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

/// 收藏或取消收藏一个本地分支（说明书 6.1、6.3）：存在仓库的 .git/strand/favorites 里，工作目录之间共用
#[tauri::command]
async fn prefs_set_favorite(state: State<'_, AppState>, name: String, favorite: bool) -> CmdResult<()> {
    with_repo(&state, move |s| s.set_favorite(&name, favorite)).await
}

/// 拖拽合并（说明书 6.1）：把 source 合并到 target，target 不是当前分支时先切换过去；整个记成一步。
#[tauri::command]
async fn branch_merge_into(state: State<'_, AppState>, source: String, target: String, mode: Option<MergeMode>, message: Option<String>) -> CmdResult<Written<MergeResult>> {
    let mode = mode.unwrap_or_default();
    let label = if mode == MergeMode::Squash { format!("把 {source} 压缩合并到 {target}") } else { format!("把 {source} 合并到 {target}") };
    logged_op(&state, label, OpKind::Merge, move |s| s.branch_merge_into_with(&source, &target, mode, message.as_deref())).await
}

/// 压缩合并的默认说明，弹框里预填（说明书 6.7）。`target` 为空时按当前分支算。
#[tauri::command]
async fn branch_squash_message(state: State<'_, AppState>, source: String, target: Option<String>) -> CmdResult<String> {
    with_repo(&state, move |s| s.squash_message(&source, target.as_deref())).await
}

/// 变基前的检查：独有提交数、已推送数、目标上的新提交数、有没有合并提交（说明书 6.3）。
#[tauri::command]
async fn branch_rebase_plan(state: State<'_, AppState>, onto: String) -> CmdResult<strand_core::model::RebasePlan> {
    with_repo(&state, move |s| s.branch_rebase_plan(&onto)).await
}

/// 把当前分支变基到 onto 之上。有冲突时停在变基状态，冲突解决完成后整个过程记成一步。
#[tauri::command]
async fn branch_rebase(state: State<'_, AppState>, onto: String) -> CmdResult<Written<strand_core::model::RebaseOutcome>> {
    logged_op(&state, format!("变基到 {onto} 之上"), OpKind::Merge, move |s| s.branch_rebase(&onto)).await
}

#[tauri::command]
async fn merge_abort(state: State<'_, AppState>, marks: Option<serde_json::Value>) -> CmdResult<Written<()>> {
    with_repo(&state, move |s| {
        // 中止写成一条日志，撤销它回到中止前的冲突和标记（说明书 8.9）；中止拉取时放回拉取前自动搁置的改动
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
async fn tag_create(state: State<'_, AppState>, name: String, at: String) -> CmdResult<Written<()>> {
    logged_op(&state, format!("新建标签 {name}"), OpKind::Tag, move |s| s.tag_create(&name, &at)).await
}

#[tauri::command]
async fn tag_delete(state: State<'_, AppState>, name: String) -> CmdResult<Written<()>> {
    logged_op(&state, format!("删除标签 {name}"), OpKind::Tag, move |s| s.tag_delete(&name)).await
}

// ---------- 远程操作（说明书第 7 节） ----------
// 网络操作不持有仓库锁：先取出路径，运行期间界面仍可读日志和差异；结束后再刷新日志。
// 前端为每次操作生成 task_id，进度通过 task_progress 事件推送，可以用 task_cancel 取消。

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

/// 运行一个网络任务：登记取消令牌、转发进度（最多每 100 ms 一次）、结束后刷新日志。
/// 网络操作写进操作日志的方式
enum NetLog {
    None,
    /// 拉取：开始前的快照；停在冲突时等冲突解决完成再写
    Pull(String, Box<Snapshot>),
    /// 推送：只在时间线里显示
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
    // 成功或失败都刷新一次：拉取可能停在冲突状态，抓取更新了远程分支
    let ok = result.is_ok();
    let (st, op, note) = with_repo(state, move |s| {
        // 拉取结束（没停在冲突里）时放回拉取前自动搁置的改动，再写操作日志（说明书 7.2）
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

#[tauri::command]
fn task_cancel(state: State<'_, AppState>, task_id: String) {
    if let Some(c) = state.tasks.lock().ok().and_then(|t| t.get(&task_id).cloned()) {
        c.cancel();
    }
}

// ---------- 工作目录（说明书 6.6）和克隆 ----------

/// 新建工作目录。可以撤销：撤销时移除它（里面有没提交的改动时不能撤销），新建的分支一起去掉。
#[tauri::command]
async fn worktree_add(state: State<'_, AppState>, path: String, branch: String, new_branch: bool, base: Option<String>) -> CmdResult<Written<()>> {
    let label = format!("新建工作目录 {}（{branch}）", short_path(&path));
    let scope = OpScope { worktrees: true, ..Default::default() };
    logged_op_scoped(&state, label, OpKind::Branch, scope, move |s| s.worktree_add(&path, &branch, new_branch, base.as_deref())).await
}

/// 移除工作目录。有未提交的改动时不加 force 返回 WORKTREE_CONFLICT。
#[tauri::command]
async fn worktree_remove(state: State<'_, AppState>, path: String, force: bool) -> CmdResult<Written<()>> {
    // 撤销时在原来的位置重新检出原来的分支（强制移除时丢掉的改动回不来）
    let label = format!("移除工作目录 {}", short_path(&path));
    let scope = OpScope { worktrees: true, ..Default::default() };
    logged_op_scoped(&state, label, OpKind::Branch, scope, move |s| s.worktree_remove(&path, force)).await
}

fn short_path(p: &str) -> String {
    std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string())
}

/// 克隆到 dest（完整路径），进度通过 task_progress 推送，可以用 task_cancel 取消。不需要先打开仓库。
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

// ---------- 提交前格式化和检查（说明书 4.4、4.6） ----------

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

/// 运行格式化或检查。在仓库锁外面跑（可能要几十秒），可以用 task_cancel 取消。
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
    // 后台自动抓取不弹密码框（说明书 7.5）：需要输入时直接失败，等用户自己抓取、拉取时再问
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
    // fetched：界面刚抓取过并看过拉取摘要面板（说明书 7.2），这里不再抓取
    let fetch = !fetched.unwrap_or(false);
    // 先拍快照再自动搁置：撤销这次拉取时，工作区的改动回到拉取之前的样子
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

/// 拉取的预演（说明书 7.2）：按上次抓取的结果在内存里合并一遍，不改仓库、不连网
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
async fn remote_push_preview(state: State<'_, AppState>, to: Option<String>) -> CmdResult<PushPreview> {
    let path = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || remote::push_preview(&path, to.as_deref()))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

#[tauri::command]
async fn remote_push(app: AppHandle, state: State<'_, AppState>, task_id: String, force: bool, tags: bool, to: Option<String>) -> CmdResult<Written<()>> {
    let branch = with_repo(&state, |s| Ok(s.state()?.head.branch.unwrap_or_default())).await?;
    let log = NetLog::Push(match &to {
        Some(id) => format!("推送 {branch} 到 {} 为止", &id[..id.len().min(7)]),
        None if force => format!("强制推送 {branch}"),
        None => format!("推送 {branch}"),
    });
    net_task(app, &state, task_id, log, move |p, c, pr| remote::push(p, &PushOptions { force, tags, to }, c, pr)).await
}

/// 推送一个标签（说明书 6.5、7.4）
#[tauri::command]
async fn tag_push(app: AppHandle, state: State<'_, AppState>, task_id: String, name: String) -> CmdResult<Written<()>> {
    let log = NetLog::Push(format!("推送标签 {name}"));
    net_task(app, &state, task_id, log, move |p, c, pr| remote::tag_push(p, &name, c, pr)).await
}

// ---------- 冲突解决（说明书第 8 节） ----------
// 标记保存在前端；应用一个文件时把这个文件的全部标记传进来。

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

/// 完成或跳过冲突解决的一步。整个合并（或拉取、变基）结束时，把它写成一条操作日志。
async fn finish_op<F>(state: &AppState, f: F) -> CmdResult<Written<FinishResult>>
where
    F: FnOnce(&mut Session) -> CmdResult<FinishResult> + Send + 'static,
{
    with_repo(state, move |s| {
        let r = f(s);
        // 拉取的冲突解决完成：放回拉取前自动搁置的改动（还没完成时 pull_unshelve 什么都不做）
        let note = if r.is_ok() { s.pull_unshelve()? } else { None };
        let op = if r.is_ok() { s.op_finish_pending()? } else { None };
        s.reload()?;
        Ok(Written { result: r?, state: s.state()?, op, note })
    })
    .await
}

// ---------- 提交操作（说明书 5.6、5.7） ----------

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

// ---------- 逐行追溯（说明书 10.2） ----------

/// 追溯第 offset+1 行起的 limit 行；rev 为空表示工作区里的文件
#[tauri::command]
async fn blame_file(state: State<'_, AppState>, path: String, rev: Option<String>, offset: u32, limit: u32) -> CmdResult<strand_core::blame::BlamePage> {
    with_repo(&state, move |s| s.blame_file(&path, rev.as_deref(), offset, limit)).await
}

// ---------- 比较、补丁、查看某个版本的仓库（说明书 10.3–10.5） ----------

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

/// 项目文件（左侧的文件目录树）：已跟踪的和没被忽略的未跟踪文件。在后台跑，不占着仓库
#[tauri::command]
async fn project_files(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let path = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || strand_core::Session::open(&path)?.project_files())
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// 文件内容：rev 为空时是工作区里的
#[tauri::command]
async fn file_text(state: State<'_, AppState>, path: String, rev: Option<String>) -> CmdResult<strand_core::file_history::FileText> {
    with_repo(&state, move |s| s.file_text(&path, rev.as_deref())).await
}

/// 在差异里编辑后保存工作区文件；expected 是开始编辑时读到的内容（磁盘上的变了就不覆盖）
#[tauri::command]
async fn save_worktree_file(state: State<'_, AppState>, path: String, text: String, expected: String) -> CmdResult<()> {
    with_repo(&state, move |s| s.save_worktree_file(&path, &text, &expected)).await
}

/// 文件修改链：git log --follow 在后台跑（长历史上要几秒），跑完再补上引用
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

/// 同一个文件两个版本之间的差异：from 为空是新增，to 为空是工作区
#[tauri::command]
async fn file_diff_versions(state: State<'_, AppState>, from: Option<String>, from_path: String, to: Option<String>, to_path: String, context: Option<u32>) -> CmdResult<FileDiff> {
    with_repo(&state, move |s| s.file_diff_versions_ctx(from.as_deref(), &from_path, to.as_deref(), &to_path, context.unwrap_or(3))).await
}

/// 按改动内容搜索时，这个提交里改动行有匹配的文件
#[tauri::command]
async fn commit_change_matches(state: State<'_, AppState>, id: String, text: String, regex: bool, case_sensitive: bool) -> CmdResult<Vec<strand_core::search::ChangeMatch>> {
    with_repo(&state, move |s| s.commit_change_matches(&id, &text, regex, case_sensitive)).await
}

/// 项目文件全文搜（git grep）：rev 为空是工作区。在后台跑，不占着仓库
#[tauri::command]
async fn project_search(state: State<'_, AppState>, text: String, regex: bool, case_sensitive: bool, rev: Option<String>) -> CmdResult<strand_core::search::ProjectSearch> {
    let dir = repo_path(&state)?;
    tauri::async_runtime::spawn_blocking(move || strand_core::search::project_search(&dir, &text, regex, case_sensitive, rev.as_deref()))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
}

/// 把文字写到用户在系统保存对话框里选的路径（保存补丁用）
#[tauri::command]
async fn file_save(path: String, text: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, text))
        .await
        .map_err(|e| CoreError::git("后台任务异常结束", e))?
        .map_err(|e| CoreError::git("保存文件失败", e))
}

// ---------- 丢弃改动、未跟踪的文件（说明书 4.7、4.8） ----------

#[tauri::command]
async fn changes_discard(state: State<'_, AppState>, paths: Vec<String>) -> CmdResult<Written<()>> {
    let label = if paths.len() == 1 { format!("丢弃 {} 的改动", paths[0]) } else { format!("丢弃 {} 个文件的改动", paths.len()) };
    logged_op(&state, label, OpKind::Other, move |s| s.changes_discard(&paths)).await
}

#[tauri::command]
async fn untracked_add(state: State<'_, AppState>, path: String) -> CmdResult<Written<()>> {
    // 快照只管已跟踪文件，要额外记下这个文件，否则撤销时会把它当成新增的文件删掉
    let scope = OpScope { files: vec![path.clone()], ..Default::default() };
    logged_op_scoped(&state, format!("把 {path} 加入版本控制"), OpKind::Other, scope, move |s| s.untracked_add(&path)).await
}

/// 加入忽略规则（写 .gitignore，不记入操作日志：.gitignore 本身会出现在改动里，可以丢弃）
#[tauri::command]
async fn untracked_ignore(state: State<'_, AppState>, path: String) -> CmdResult<Written<()>> {
    let scope = OpScope { files: vec![".gitignore".into()], ..Default::default() };
    logged_op_scoped(&state, format!("把 {path} 加入忽略规则"), OpKind::Other, scope, move |s| s.untracked_ignore(&path)).await
}

/// 删除未跟踪的文件：移到废纸篓，可以从废纸篓找回（不记入操作日志）
#[tauri::command]
async fn untracked_delete(state: State<'_, AppState>, path: String) -> CmdResult<Written<()>> {
    let scope = OpScope { files: vec![path.clone()], ..Default::default() };
    logged_op_scoped(&state, format!("把 {path} 移到废纸篓"), OpKind::Other, scope, move |s| s.untracked_delete(&path)).await
}

// ---------- 整理提交（说明书第 9 节） ----------

#[tauri::command]
async fn rebase_range(state: State<'_, AppState>, from: Option<String>) -> CmdResult<RebaseRange> {
    with_repo(&state, move |s| s.rebase_range(from.as_deref())).await
}

#[tauri::command]
async fn rebase_apply(state: State<'_, AppState>, steps: Vec<Step>) -> CmdResult<Written<RebaseResult>> {
    let label = format!("整理 {} 个提交", steps.len());
    logged_op(&state, label, OpKind::Commit, move |s| s.rebase_apply(&steps)).await
}

/// Fixup（message 为空）或 Squash Into（带新说明）：把勾选的改动并入某个提交
#[tauri::command]
async fn commit_fixup(state: State<'_, AppState>, id: String, selection: Selection, message: Option<String>) -> CmdResult<Written<()>> {
    let i = id.clone();
    logged_op_by(&state, OpKind::Commit, move |s| format!("把改动并入{}", title_of(s, &i)), move |s| s.commit_fixup(&id, &selection, message.as_deref())).await
}

// ---------- 贮藏和暂存架（说明书 4.9） ----------

#[tauri::command]
async fn stash_list(state: State<'_, AppState>) -> CmdResult<Vec<StashEntry>> {
    with_repo(&state, |s| s.stash_list()).await
}

#[tauri::command]
async fn stash_files(state: State<'_, AppState>, index: usize) -> CmdResult<Vec<strand_core::model::FileChange>> {
    with_repo(&state, move |s| s.stash_files(index)).await
}

#[tauri::command]
async fn stash_push(state: State<'_, AppState>, message: Option<String>) -> CmdResult<Written<()>> {
    logged_op(&state, "贮藏改动".into(), OpKind::Stash, move |s| s.stash_push(message.as_deref())).await
}

/// 取回贮藏：`drop` 为真是取回并删除（pop），否则取回但保留（apply）
#[tauri::command]
async fn stash_apply(state: State<'_, AppState>, index: usize, drop: bool) -> CmdResult<Written<()>> {
    logged_op_by(
        &state,
        OpKind::Stash,
        move |s| {
            let m = s.stash_list().ok().and_then(|l| l.into_iter().find(|e| e.index == index)).map(|e| short(&e.message)).unwrap_or_default();
            format!("{}贮藏“{m}”", if drop { "取回" } else { "应用" })
        },
        move |s| s.stash_apply(index, drop),
    )
    .await
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
    logged_op(&state, label, OpKind::Shelf, move |s| s.shelf_save(&name, &paths)).await
}

#[tauri::command]
async fn shelf_restore(state: State<'_, AppState>, id: u64, paths: Option<Vec<String>>) -> CmdResult<Written<()>> {
    let some = paths.as_ref().map(|p| p.len());
    logged_op_by(
        &state,
        OpKind::Shelf,
        move |s| {
            let n = s.shelf_list().ok().and_then(|l| l.into_iter().find(|e| e.id == id)).map(|e| e.name).unwrap_or_default();
            match some {
                // 只取回部分文件（说明书 4.9）
                Some(k) => format!("从搁置“{}”取回 {k} 个文件", short(&n)),
                None => format!("取回搁置“{}”", short(&n)),
            }
        },
        move |s| match &paths {
            Some(p) => s.shelf_restore_files(id, p),
            None => s.shelf_restore(id),
        },
    )
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
async fn shelf_diff(state: State<'_, AppState>, id: u64, path: String) -> CmdResult<strand_core::model::FileDiff> {
    with_repo(&state, move |s| s.shelf_diff(id, &path)).await
}

#[tauri::command]
async fn shelf_rename(state: State<'_, AppState>, id: u64, name: String) -> CmdResult<()> {
    with_repo(&state, move |s| s.shelf_rename(id, &name)).await
}

// ---------- 撤销、重做和操作时间线（说明书第 11 节） ----------

#[tauri::command]
async fn oplog_list(state: State<'_, AppState>, limit: Option<usize>) -> CmdResult<OpList> {
    with_repo(&state, move |s| s.oplog_list(limit.unwrap_or(50))).await
}

/// 撤销最近一步，或撤销到 `to_id`（含）为止。越过已推送的步骤需要 `confirm_pushed`。
#[tauri::command]
async fn oplog_undo(state: State<'_, AppState>, to_id: Option<u64>, confirm_pushed: Option<bool>) -> CmdResult<Written<Vec<OpInfo>>> {
    write_op(&state, move |s| s.oplog_undo(to_id, confirm_pushed.unwrap_or(false))).await
}

#[tauri::command]
async fn oplog_redo(state: State<'_, AppState>) -> CmdResult<Written<Vec<OpInfo>>> {
    write_op(&state, |s| s.oplog_redo()).await
}

// ---------- 需要输入凭据时（说明书 7.5） ----------

/// 等用户回答的请求：编号 → 把回答交回 askpass 的通道
static AUTH_WAIT: Mutex<Option<HashMap<String, std::sync::mpsc::Sender<Option<String>>>>> = Mutex::new(None);

#[derive(Serialize, Clone)]
struct AuthEvent {
    request_id: String,
    prompt: String,
    secret: bool,
}

/// 让 git 需要输入时通过 askpass 问界面：发 `auth_required` 事件，等 `auth_reply`；
/// 用户点了停止（任务取消）时收回输入框（`auth_closed`）并按取消处理。
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

/// 回答 `auth_required`；`secret` 为空表示取消。回答不写日志，只交给发起请求的那一次 git 进程。
#[tauri::command]
fn auth_reply(request_id: String, secret: Option<String>) {
    let tx = AUTH_WAIT.lock().unwrap().as_mut().and_then(|m| m.remove(&request_id));
    if let Some(tx) = tx {
        let _ = tx.send(secret);
    }
}

/// 控制台（说明书 5.8）：新条目发 `console_line` 事件；同样的内容写进应用日志目录（保留 7 天）
fn setup_console(app: AppHandle) {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_log_dir() {
        strand_core::console::set_log_dir(dir);
    }
    strand_core::console::set_sink(Arc::new(move |e| {
        let _ = app.emit("console_line", e);
    }));
}

/// 控制台最近的条目（从旧到新）
#[tauri::command]
fn console_tail(limit: Option<usize>) -> Vec<strand_core::console::Entry> {
    strand_core::console::tail(limit.unwrap_or(strand_core::console::MAX_LINES))
}

/// 清空控制台（日志文件不动）
#[tauri::command]
fn console_clear() {
    strand_core::console::clear();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// `adopted`：启动时并入了登录 shell 的 PATH，用了多少毫秒（写进控制台和日志，方便排查用的是哪个 git）
pub fn run(adopted: Option<u128>) {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(move |app| {
            setup_askpass(app.handle().clone());
            setup_console(app.handle().clone());
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
            save_worktree_file,
            file_history,
            file_diff_versions,
            commit_change_matches,
            project_search,
            file_save,
            changes_discard,
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
