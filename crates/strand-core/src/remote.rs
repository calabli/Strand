//! 远程操作：抓取、拉取、推送（说明书第 7 节）。
//!
//! 全部调用系统 git，认证交给用户已有的 SSH 密钥、凭据助手和系统钥匙串。
//! 这些函数只需要仓库路径，不持有 `Session`，所以网络操作进行时界面仍然可以读日志、看差异。
//! 1.0 只处理名为 `origin` 的远程。

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

/// 网络操作多久没有任何输出就算超时（说明书 7.5：默认 60 秒）。
/// 按“没有输出”计时而不是总时长，大仓库的正常下载不会被误判。
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// 取消令牌。前端调用 `task_cancel` 时置位，正在运行的 git 进程会被结束。
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

/// 进度：git 输出的一行（如“Receiving objects:  45% (450/1000)”）和解析出的百分比。
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
    /// 抓取后当前分支落后跟踪分支的提交数；没有跟踪分支时为 0
    /// 本地改写了已推送的提交（需要强制推送）时为 0
    pub behind: u32,
    /// 这次抓取新到的、当前分支还没有的提交数（抓取前后落后数之差）
    pub incoming: u32,
    /// 抓取改动了引用（远程分支、标签）：界面据此决定要不要重新读取日志
    pub refs_changed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PullOutcome {
    /// 远程没有新提交
    UpToDate,
    FastForward,
    Merged,
    Rebased,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullResult {
    pub outcome: PullOutcome,
    /// 拉下来的提交数
    pub incoming: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PushCommit {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PushPreview {
    pub branch: String,
    /// 推送目标，如 `origin/main`；还没有跟踪分支时是将要新建的远程分支
    pub target: String,
    /// 远程还没有这个分支，推送时会新建并设为跟踪分支
    pub new_branch: bool,
    /// 要推送的提交，最新的在前
    pub commits: Vec<PushCommit>,
    /// 远程有、本地没有的提交数（按上次抓取的结果）
    pub behind: u32,
    /// 远程那些提交在本地都有内容相同的版本：本地改写了已推送的历史，需要强制推送
    pub needs_force: bool,
    /// 只推送到这个提交为止（说明书 5.6），`commits` 只含它和它之前的；它之后的提交仍为未推送
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// 推送到某个提交为止时，它之后留在本地的提交数
    pub left: u32,
    /// 还没推送到 origin 的本地标签（按上次抓取时记下的远程标签判断）
    pub unpushed_tags: Vec<String>,
    /// 还没记下过远程有哪些标签（从没抓取过）：这时不知道哪些标签已经推送，`unpushed_tags` 为空
    pub tags_unknown: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PushOptions {
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub tags: bool,
    /// 只推送到这个提交为止（完整哈希或能解析的版本号）
    #[serde(default)]
    pub to: Option<String>,
}

/// 抓取 origin。
pub fn fetch(dir: &Path, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<FetchResult> {
    require_origin(dir)?;
    let before = behind_upstream(dir);
    let refs_before = ref_list(dir);
    run_net(dir, &["fetch", "--progress", REMOTE], cancel, progress)?;
    let refs_changed = ref_list(dir) != refs_before;
    // 顺便记下远程有哪些标签（说明书 6.5：未推送的标签要标出来）；失败不影响抓取结果
    if let Ok(out) = run_net(dir, &["ls-remote", "--tags", "--refs", REMOTE], cancel, progress) {
        let tags = out
            .lines()
            .filter_map(|l| l.split_once('\t'))
            .filter_map(|(id, r)| r.strip_prefix("refs/tags/").map(|n| (n.to_string(), id.to_string())))
            .collect();
        save_remote_tags(dir, &tags);
    }
    // 本地改写了已推送的提交时，远程那些旧版本不算“可以拉取的新提交”（说明书 6.3：落后数显示为 0）
    let after = behind_upstream(dir);
    let after = if after > 0 && rewritten(dir, "HEAD", "@{upstream}") { 0 } else { after };
    Ok(FetchResult { behind: after, incoming: after.saturating_sub(before), refs_changed })
}

/// 所有引用和它们指向的提交（比较抓取前后有没有变化用）
fn ref_list(dir: &Path) -> String {
    git_cli::run(dir, &["for-each-ref", "--format=%(objectname) %(refname)"], None).unwrap_or_default()
}

/// 克隆远程仓库到 `dest`（说明书第 17 节原先列为 1.0 不做，现在补上）。
/// `dest` 不存在或者是空文件夹；它的上级文件夹必须存在。失败或取消时删掉克隆了一半的内容。
pub fn clone(url: &str, dest: &Path, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
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
    let r = run_net(parent, &["clone", "--progress", "--", url, &d], cancel, progress);
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
        // 刚克隆下来的标签都在远程上
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

/// 拉取当前分支的跟踪分支。先抓取；远程没有新提交时不做别的。
/// 界面调用前先用 `Session::pull_shelve` 把工作区改动搁置到暂存架（说明书 7.2），结束后 `pull_unshelve` 放回；
/// 直接调用时工作区若还有改动，用 git 的 `--autostash` 兜底。
/// 有冲突时返回 `CONFLICTS`，仓库停在合并或变基状态，`detail.files` 是冲突文件。
pub fn pull(dir: &Path, mode: PullMode, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<PullResult> {
    pull_with(dir, mode, true, cancel, progress)
}

/// 同 [`pull`]；`fetch` 为假时不再抓取，直接合并或变基到上次抓取的跟踪分支（拉取摘要面板确认之后，说明书 7.2）
pub fn pull_with(dir: &Path, mode: PullMode, fetch: bool, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<PullResult> {
    require_origin(dir)?;
    require_normal(dir)?;
    let branch = current_branch(dir)?.ok_or_else(|| {
        CoreError::new(ErrorCode::InvalidRange, "现在不在任何分支上，先切换到一个分支再拉取")
    })?;
    if upstream(dir).is_none() {
        return Err(CoreError::new(ErrorCode::InvalidRange, format!("分支 {branch} 没有跟踪的远程分支，没有可拉取的内容")));
    }
    if fetch {
        run_net(dir, &["fetch", "--progress", REMOTE], cancel, progress)?;
    }
    let incoming = behind_upstream(dir);
    if incoming == 0 {
        return Ok(PullResult { outcome: PullOutcome::UpToDate, incoming: 0 });
    }
    let ahead = ahead_upstream(dir);
    // 已经抓取过了，这里的 merge/rebase 是本地操作。用跟踪分支的名字（如 origin/main），
    // 不用 @{upstream}：否则合并说明和冲突里“对方的”会写成 origin/HEAD
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
            Ok(PullResult { outcome, incoming })
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

/// 拉取摘要面板里的一个冲突文件（说明书 7.2）
#[derive(Debug, Clone, Serialize)]
pub struct PreviewConflict {
    pub path: String,
    pub kind: crate::conflict::FileKind,
    /// 文本文件里两边改了同一段的处数；其他类型为 0
    pub blocks: u32,
    /// 变基方式：第一次冲突出现在哪个本地提交（标题）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// 拉取的预演（说明书 7.2）：按上次抓取的结果在内存里合并或变基一遍，不改动仓库。
#[derive(Debug, Clone, Serialize)]
pub struct PullPreview {
    pub branch: String,
    /// 跟踪的远程分支，如 `origin/main`
    pub upstream: String,
    pub mode: PullMode,
    /// 要拉下来的提交数
    pub incoming: u32,
    /// 本地独有的提交数；为 0 时是快进，不会有冲突
    pub ahead: u32,
    /// 两边都改了、能自动合并的文件数
    pub auto_merged: u32,
    pub conflicts: Vec<PreviewConflict>,
    /// 工作区里已跟踪文件的改动数（会先搁置到暂存架）；由调用方填
    pub dirty: u32,
}

/// 预演拉取：只读本地数据，不连网、不改仓库。远程状态按上次抓取的结果（界面先抓取再调用）。
pub fn pull_preview(dir: &Path, mode: PullMode) -> Result<PullPreview> {
    require_origin(dir)?;
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
            // 和 git rebase 一样：跳过合并提交和远程已经有同样改动的提交，按顺序接到远程提交之后
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
    // 两边都改了、又没冲突的文件
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

/// 记下内存合并结果里的冲突文件（同一个文件只记第一次）
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

/// 预演变基时继续往下走：冲突的文件先按本地提交的版本处理（只为了算后面的提交）
fn take_theirs(idx: &mut git2::Index) -> std::result::Result<(), git2::Error> {
    let cs: Vec<git2::IndexConflict> = idx.conflicts()?.flatten().collect();
    for c in cs {
        let Some(path) = [&c.our, &c.their, &c.ancestor].iter().find_map(|e| e.as_ref()).map(|e| e.path.clone()) else { continue };
        idx.conflict_remove(std::path::Path::new(&*String::from_utf8_lossy(&path)))?;
        if let Some(mut t) = c.their {
            t.flags &= !0x3000; // 去掉冲突阶段标记
            idx.add(&t)?;
        }
    }
    Ok(())
}

/// 推送对话框需要的信息。只读本地数据（远程状态按上次抓取的结果），不连网。
/// `to` 不为空时是“推送到这里为止”：只列出它和它之前要推送的提交；它必须是还没推送的提交。
pub fn push_preview(dir: &Path, to: Option<&str>) -> Result<PushPreview> {
    let mut p = push_preview_all(dir)?;
    let Some(to) = to else { return Ok(p) };
    let full = git_cli::run(dir, &["rev-parse", "--verify", "--quiet", &format!("{to}^{{commit}}")], None)
        .map_err(|_| CoreError::new(ErrorCode::NotFound, format!("找不到 {to}")))?
        .trim()
        .to_string();
    // 要推送的提交（最新的在前）里，从它开始往后的才推送
    let k = p
        .commits
        .iter()
        .position(|c| c.id == full)
        .ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "这个提交已经推送，或者不在当前分支上"))?;
    // 列表按时间排，不一定只含它的祖先：再用祖先关系筛一遍
    let ancestors: std::collections::HashSet<String> =
        git_cli::run(dir, &["rev-list", &full], None)?.lines().map(str::to_string).collect();
    let total = p.commits.len();
    p.commits = p.commits.split_off(k).into_iter().filter(|c| ancestors.contains(&c.id)).collect();
    p.left = (total - p.commits.len()) as u32;
    p.to = Some(full);
    Ok(p)
}

fn push_preview_all(dir: &Path) -> Result<PushPreview> {
    require_origin(dir)?;
    let branch = current_branch(dir)?
        .ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "现在不在任何分支上，先切换到一个分支再推送"))?;
    let up = upstream(dir);
    let (target, new_branch, range) = match &up {
        Some(u) => (u.clone(), false, format!("{u}..HEAD")),
        None => (format!("{REMOTE}/{branch}"), true, String::new()),
    };
    let log_args: Vec<&str> = if new_branch {
        // 远程还没有这个分支：要推送的是所有远程分支上都没有的提交
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
    // 远程独有的提交在本地都有等价版本（git cherry 标 “-”）：说明本地改写了这些提交
    let needs_force = behind > 0 && rewritten(dir, "HEAD", "@{upstream}");
    let (unpushed_tags, tags_unknown) = match unpushed_tags(dir) {
        Some(v) => (v, false),
        None => (Vec::new(), true),
    };
    Ok(PushPreview { branch, target, new_branch, commits, behind, needs_force, to: None, left: 0, unpushed_tags, tags_unknown })
}

/// 推送当前分支。强制推送一律用 `--force-with-lease`（说明书 7.3）。
/// 被拒绝时返回 `PUSH_REJECTED`，`detail.reason` 为 `behind`、`needs_force`、`lease_stale`、`protected` 或 `tag_exists`。
/// `to` 不为空时只推送到这个提交为止（说明书 5.6）：不能和强制推送一起用，远程有新提交时也不行。
pub fn push(dir: &Path, opts: &PushOptions, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    if let Some(to) = opts.to.as_deref() {
        return push_to(dir, to, cancel, progress);
    }
    let p = push_preview(dir, None)?;
    if !opts.force && p.behind > 0 {
        let reason = if p.needs_force { "needs_force" } else { "behind" };
        return Err(rejected(reason));
    }
    let refspec = format!("HEAD:refs/heads/{}", p.target.strip_prefix(&format!("{REMOTE}/")).unwrap_or(&p.branch));
    let mut args = vec!["push", "--progress", "--porcelain"];
    if opts.force {
        args.push("--force-with-lease");
    }
    if p.new_branch {
        args.push("--set-upstream");
    }
    args.push(REMOTE);
    args.push(&refspec);
    run_net(dir, &args, cancel, progress).map_err(classify_push_error)?;
    if opts.tags {
        // 只推送还没推送的标签；不知道远程有哪些时推送全部（说明书 7.3）
        let names: Vec<String> = if p.tags_unknown { local_tags(dir).into_keys().collect() } else { p.unpushed_tags.clone() };
        push_tags(dir, &names, cancel, progress)?;
    }
    Ok(())
}

/// 推送一个标签（说明书 6.5、7.4）。远程已经有同名标签而且指向别处时返回 `PUSH_REJECTED`（reason `tag_exists`）。
pub fn tag_push(dir: &Path, name: &str, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    require_origin(dir)?;
    if !local_tags(dir).contains_key(name) {
        return Err(CoreError::new(ErrorCode::NotFound, format!("找不到标签 {name}")));
    }
    push_tags(dir, &[name.to_string()], cancel, progress)
}

fn push_tags(dir: &Path, names: &[String], cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    if names.is_empty() {
        return Ok(());
    }
    let specs: Vec<String> = names.iter().map(|n| format!("refs/tags/{n}:refs/tags/{n}")).collect();
    let mut args = vec!["push", "--progress", "--porcelain", REMOTE];
    args.extend(specs.iter().map(String::as_str));
    run_net(dir, &args, cancel, progress).map_err(|e| {
        if e.code == ErrorCode::GitFailed && detail_text(&e).contains("already exists") {
            rejected("tag_exists")
        } else {
            classify_push_error(e)
        }
    })?;
    // 推送成功的记为已在远程上
    let local = local_tags(dir);
    let mut known = match remote_tags(dir) {
        Some(k) => k,
        // 还不知道远程有哪些标签：只有全部推送了才能确定，否则先不记
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

/// 还没推送的本地标签（按名字比较），按名字排序；从没记下过远程标签时返回 `None`。
pub fn unpushed_tags(dir: &Path) -> Option<Vec<String>> {
    let known = remote_tags(dir)?;
    let mut v: Vec<String> = local_tags(dir).into_keys().filter(|n| !known.contains_key(n)).collect();
    v.sort();
    Some(v)
}

/// 本地标签：名字 → 标签对象（或提交）的编号
fn local_tags(dir: &Path) -> std::collections::HashMap<String, String> {
    git_cli::run(dir, &["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)", "refs/tags"], None)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('\0'))
        .map(|(n, id)| (n.to_string(), id.to_string()))
        .collect()
}

/// 上次抓取时记下的远程标签，存在 `<共用的 .git>/strand/remote-tags`（一行一个“编号 名字”），
/// 工作目录之间共用。没有这个文件说明还没抓取过。
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

fn push_to(dir: &Path, to: &str, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    let p = push_preview(dir, Some(to))?;
    if p.behind > 0 {
        return Err(rejected(if p.needs_force { "needs_force" } else { "behind" }));
    }
    let id = p.to.clone().unwrap_or_default();
    let remote_branch = p.target.strip_prefix(&format!("{REMOTE}/")).unwrap_or(&p.branch).to_string();
    let refspec = format!("{id}:refs/heads/{remote_branch}");
    run_net(dir, &["push", "--progress", "--porcelain", REMOTE, &refspec], cancel, progress).map_err(classify_push_error)?;
    if p.new_branch {
        // 用提交号推送不会设跟踪分支，推送成功后补上（远程跟踪分支 push 时已经更新）
        let _ = git_cli::run(dir, &["branch", "--set-upstream-to", &format!("{REMOTE}/{remote_branch}"), &p.branch], None);
    }
    Ok(())
}

// ---------- 内部 ----------

/// 远程独有的提交是不是都被本地改写过（本地有内容相同的版本，`git cherry` 标 “-”）。
/// 空提交没有内容可比，任何两个空提交都会被认为“相同”，所以远程独有提交里有空提交时
/// 一律按“远程有新提交”处理：宁可提示先拉取，也不误导用户强制推送覆盖别人的提交。
/// `local`、`up` 是本地分支和它跟踪的远程分支（也可以是 `HEAD`、`@{upstream}`）。
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

/// 认证失败、网络不通这两类错误单独给错误码，前端据此给出对应提示。
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

/// 运行一个网络相关的 git 命令：读取进度、支持取消、按无输出时长判断超时。
fn run_net(dir: &Path, args: &[&str], cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<String> {
    run_git_net(dir, args, None, &[], cancel, progress)
}

/// 测试用：经同一条路径运行 `git credential fill`，检查需要输入时会不会向用户要（说明书 7.5）。
/// 不读全局和系统配置（不碰本机的凭据助手）。返回 git 的输出（含 username=、password=）。
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
        // 不在终端里问；需要输入时走 askpass（界面弹窗），没设置时直接失败
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

    // 标准错误在单独的线程里按 \r 和 \n 切成行，作为进度和错误信息
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
        // 等用户输入密码时不算超时
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
    // 用户在输入框里点了取消：按取消处理，不报认证失败
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

fn require_origin(dir: &Path) -> Result<()> {
    let remotes = git_cli::run(dir, &["remote"], None)?;
    if remotes.lines().any(|r| r.trim() == REMOTE) {
        Ok(())
    } else {
        Err(CoreError::new(ErrorCode::NotFound, "这个仓库没有名为 origin 的远程"))
    }
}

fn require_normal(dir: &Path) -> Result<()> {
    if in_progress(dir) {
        return Err(CoreError::new(ErrorCode::MergeInProgress, "合并还没完成，先解决冲突或中止"));
    }
    Ok(())
}

/// 仓库处在合并、变基、拣选或还原的过程中。
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
