//! 前后端之间传递的数据结构，对应说明书第 13 节。
//!
//! 字段名用下划线命名，时间用 Unix 秒，哈希用完整的 40 位字符串。
//! 前端的 `src/api/types.ts` 必须和这里保持一致。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HeadKind {
    Branch,
    Detached,
    /// 新建仓库还没有任何提交
    Unborn,
}

#[derive(Debug, Clone, Serialize)]
pub struct Head {
    pub kind: HeadKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepoMode {
    Normal,
    Merging,
    Rebasing,
    CherryPicking,
    Reverting,
    /// 取回贮藏或暂存架时有冲突，还没处理完（说明书 4.9、8.1）
    Unstashing,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoState {
    pub path: String,
    pub name: String,
    pub head: Head,
    pub state: RepoMode,
    /// 二分查找进行中（git bisect）；这时 HEAD 停在要测试的提交上，其余操作照常
    #[serde(default)]
    pub bisecting: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RefKind {
    Head,
    Branch,
    Remote,
    Tag,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Ref {
    pub kind: RefKind,
    /// 短名，如 `main`、`origin/main`、`v0.4.0`
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Author {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Commit {
    pub id: String,
    pub parents: Vec<String>,
    pub title: String,
    pub body: String,
    pub author: Author,
    pub time: i64,
    pub refs: Vec<Ref>,
    pub is_merge: bool,
    /// 从当前分支能到达、但不在它的跟踪分支里（没有跟踪分支时：不在任何远程分支里）
    pub unpushed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    /// 同一条泳道继续往下
    Straight,
    /// 从这一行分出去到别的泳道（第一个父提交在别的泳道，或分支起点）
    Fork,
    /// 合并提交的第二个及以后的父提交
    Merge,
    /// 长连线在这里折叠：从本行往下画一小段，末端是向下的箭头，不连到下一行（这条泳道让给别的线）
    CutOut,
    /// 折叠的长连线在这里接回来：本行顶部是向下的箭头，再从本行一直画到下一行
    CutIn,
}

/// 从本行到下一行的一段连线。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Edge {
    pub from_lane: u32,
    pub to_lane: u32,
    pub kind: EdgeKind,
    /// 折叠的线（`CutOut`、`CutIn`）另一头所在的行：收住处指向父提交，接回处指向这条线出发的子提交。
    /// 点箭头跳过去。父提交不在列表里时为空
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<u32>,
}

/// 图谱的一行，和 `LogPage.rows` 一一对应。
///
/// `edges` 是从本行画到下一行的所有线段，包括只是从这一行经过的泳道，
/// 前端逐行画线即可，不需要知道父提交在哪一行。
#[derive(Debug, Clone, Serialize)]
pub struct GraphRow {
    pub lane: u32,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogPage {
    pub offset: usize,
    pub rows: Vec<Commit>,
    pub graph: Vec<GraphRow>,
    pub total: usize,
    /// 整个日志最多用到几条泳道，前端据此定图谱列宽
    pub lanes: u32,
    /// 过滤结果还没算完（说明书 15“首批结果先返回，其余分批追加”）：total 是目前找到的数目，过一会儿再查会更多
    pub partial: bool,
    /// 折叠线性分支时：和 rows 一一对应，这一行下面折叠起来的提交数（0 是没有折叠）；没折叠时为空
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub folded: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitInfo {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 版本不低于 `MIN_GIT_VERSION`
    pub ok: bool,
    pub min_version: String,
}

// ---------- 工作区、差异、提交详情（说明书 4、5.5、10 节） ----------

#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize, PartialEq, Eq)]
pub enum FileStatus {
    M,
    A,
    D,
    R,
    /// 类型变化（如普通文件变成符号链接），界面按 M 显示
    T,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileChange {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub added: u32,
    pub deleted: u32,
    pub binary: bool,
    /// 部分克隆里文件内容不在本地、也没能下载：added / deleted 不可用
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub no_stats: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeStatus {
    /// 已跟踪文件相对 HEAD 的改动（不区分是否已暂存，提交面板不使用暂存区概念）
    pub changes: Vec<FileChange>,
    pub untracked: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffLine {
    pub kind: LineKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_no: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_no: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hunk {
    /// 函数或结构名 + 起始行，如 `fn place · 第 88 行起`
    pub title: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub binary: bool,
    pub hunks: Vec<Hunk>,
    /// 行数超过上限被截断
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitDetail {
    pub commit: Commit,
    /// 相对第一个父提交的改动；根提交相对空树
    pub files: Vec<FileChange>,
    /// 说明书 5.6 各操作是否可用
    pub caps: crate::commits::CommitCaps,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SelectedFile {
    pub path: String,
    /// 重命名时一起提交旧路径的删除
    #[serde(default)]
    pub old_path: Option<String>,
    /// 整个文件；为假时只提交 `lines` 里的改动行（说明书 4.3）
    #[serde(default = "yes")]
    pub whole: bool,
    /// 要提交的改动行：`diff_worktree(path, 不忽略空白, 3 行上下文)` 里第 hunk 块第 line 行
    #[serde(default)]
    pub lines: Vec<LineRef>,
}

#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq, Eq)]
pub struct LineRef {
    pub hunk: u32,
    pub line: u32,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct Selection {
    pub files: Vec<SelectedFile>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ChangeScope {
    /// 分支、标签、HEAD 变了：日志和分支要刷新
    Refs,
    /// 工作区或索引变了：提交面板要刷新
    Status,
    /// 贮藏变了（如在命令行里 git stash）：贮藏列表要刷新，日志不用
    Stash,
    /// 暂存架变了：暂存架列表要刷新
    Shelf,
}

// ---------- 分支、远程分支、标签（说明书第 6 节） ----------

#[derive(Debug, Clone, Serialize)]
pub struct Branch {
    pub name: String,
    pub head: String,
    /// 跟踪的远程分支，如 `origin/main`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// 相对跟踪分支领先、落后的提交数；没有跟踪分支时都是 0
    pub ahead: u32,
    pub behind: u32,
    pub is_current: bool,
    /// 已经完全包含在当前分支里，删除时不会丢提交
    pub merged: bool,
    /// 在另一个工作目录里检出（那个目录的路径）；这时不能在这里切换到它
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// 本地改写了已经推送的提交（远程独有的提交在本地都有内容相同的版本）：推送需要强制推送
    pub needs_force: bool,
    /// 不能把当前分支变基到它之上的原因（说明书 6.3）；能变基或不确定时为空。当前分支自己、不在分支上时也为空
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebase_block: Option<String>,
    /// 收藏了（说明书 6.1）：在分支树和分支弹窗里排在前面
    pub favorite: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteBranch {
    /// 如 `origin/main`
    pub name: String,
    pub remote: String,
    pub head: String,
    /// 不能把当前分支变基到它之上的原因，同 `Branch::rebase_block`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebase_block: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Tag {
    pub name: String,
    /// 标签指向的提交
    pub at: String,
    /// 还没推送到 origin（按上次抓取时记下的远程标签）；从没抓取过时为 false
    pub unpushed: bool,
    /// 带说明的标签（git tag -a）的说明；轻量标签没有
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefsList {
    pub branches: Vec<Branch>,
    pub remotes: Vec<RemoteBranch>,
    pub tags: Vec<Tag>,
    pub head: Head,
    /// 工作目录（说明书 6.6），第一个是主工作目录
    pub worktrees: Vec<crate::worktrees::Worktree>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MergeResult {
    /// 当前分支已经包含了它，什么也没做
    UpToDate,
    FastForward,
    Merged,
    /// 压缩合并：它的改动合成一个普通提交（只有一个父提交）
    Squashed,
}

/// 合并方式（说明书 6.7 的 `mode`）
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MergeMode {
    /// 能快进就快进，否则生成合并提交
    #[default]
    Auto,
    /// 总是生成合并提交（`--no-ff`）
    NoFf,
    /// 把它的改动压缩成一个提交（不记它是合并来的）
    Squash,
}

/// 变基前的检查结果（说明书 6.3“变基到某分支之上”），界面据此弹确认框
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RebasePlan {
    pub branch: String,
    pub onto: String,
    /// 当前分支独有的提交数（要被改写的）
    pub own: u32,
    /// 其中已经推送过的（在任意远程分支里）；大于 0 时变基后需要强制推送
    pub pushed: u32,
    /// 目标分支上当前分支还没有的提交数
    pub incoming: u32,
    /// 独有提交里有合并提交：不能变基
    pub has_merge: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RebaseOutcome {
    /// 已经在目标分支之上，什么也没做
    UpToDate,
    /// 当前分支没有独有提交，直接快进到目标
    FastForward,
    Rebased,
}
