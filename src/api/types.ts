// 前后端之间的数据结构，必须和 crates/strand-core/src/model.rs、error.rs 保持一致。
// 对应说明书第 13、14 节。

export type HeadKind = "branch" | "detached" | "unborn";
export type RepoMode = "normal" | "merging" | "rebasing" | "cherry_picking" | "reverting" | "unstashing";

export interface Head {
  kind: HeadKind;
  branch?: string;
  commit?: string;
}

export interface RepoState {
  path: string;
  name: string;
  head: Head;
  state: RepoMode;
}

export type RefKind = "head" | "branch" | "remote" | "tag";

export interface Ref {
  kind: RefKind;
  name: string;
}

export interface Commit {
  id: string;
  parents: string[];
  title: string;
  body: string;
  author: { name: string; email: string };
  /** Unix 秒 */
  time: number;
  refs: Ref[];
  is_merge: boolean;
  /** 从当前分支能到达、但不在它的跟踪分支里 */
  unpushed: boolean;
}

/** cut_out：长连线在这里折叠，往下一小段后是向下的箭头；cut_in：折叠的长连线从这一行顶部的箭头接回来，再画到下一行 */
export type EdgeKind = "straight" | "fork" | "merge" | "cut_out" | "cut_in";

/** 从本行画到下一行的一段线 */
export interface Edge {
  from_lane: number;
  to_lane: number;
  kind: EdgeKind;
  /** 折叠的线另一头所在的行（cut_out 指向父提交，cut_in 指向出发的子提交），点箭头跳过去 */
  target?: number;
}

export interface GraphRow {
  lane: number;
  edges: Edge[];
}

export interface LogPage {
  offset: number;
  rows: Commit[];
  graph: GraphRow[];
  total: number;
  lanes: number;
  /** 过滤结果还没算完：total 是目前找到的数目，过一会儿再查会更多（说明书 15） */
  partial?: boolean;
}

/** 日志过滤条件（说明书 5.1），省略的项不过滤 */
export type MatchKind = "contains" | "prefix" | "suffix" | "regex";
export interface AuthorMatch {
  kind: MatchKind;
  text: string;
}

export interface LogFilter {
  text?: string;
  regex?: boolean;
  case_sensitive?: boolean;
  /** 只看从这个分支能到达的提交 */
  branch?: string | null;
  /** 作者邮箱（只选一个时的旧写法） */
  author?: string | null;
  /** 选中的作者邮箱（多选） */
  authors?: string[];
  /** 按规则匹配作者（名字或邮箱），和选中的作者是“或” */
  author_match?: AuthorMatch | null;
  /** 作者时间不早于（Unix 秒） */
  since?: number | null;
  /** 作者时间早于（Unix 秒，不含） */
  until?: number | null;
  /** 路径子串 */
  path?: string | null;
}

export type LogSort = "topo" | "date";

export interface LogAuthor {
  name: string;
  email: string;
  count: number;
}

export interface GitInfo {
  found: boolean;
  version?: string;
  ok: boolean;
  min_version: string;
}

export type ErrorCode =
  | "REPO_BUSY"
  | "MERGE_IN_PROGRESS"
  | "NOTHING_SELECTED"
  | "EMPTY_MESSAGE"
  | "ALREADY_PUSHED"
  | "INVALID_NAME"
  | "INVALID_RANGE"
  | "WORKTREE_CONFLICT"
  | "CONFLICTS"
  | "UNMARKED_BLOCKS"
  | "CONFLICT_MARKERS"
  | "PUSH_REJECTED"
  | "AUTH_FAILED"
  | "NETWORK"
  | "STATE_DIVERGED"
  | "NOT_FOUND"
  | "CANCELLED"
  | "GIT_FAILED"
  | "NOT_A_REPO"
  | "NO_REPO"
  | "GIT_MISSING"
  | "INVALID_REGEX";

export interface CoreError {
  code: ErrorCode;
  message: string;
  detail?: unknown;
}

// ---------- 工作区、差异、提交详情 ----------

/** T 是类型变化（如普通文件变成符号链接），界面按 M 显示 */
export type FileStatus = "M" | "A" | "D" | "R" | "T";

export interface FileChange {
  path: string;
  old_path?: string;
  status: FileStatus;
  added: number;
  deleted: number;
  binary: boolean;
  /** 部分克隆里文件内容不在本地、也没能下载：行数不可用 */
  no_stats?: boolean;
}

export interface WorktreeStatus {
  changes: FileChange[];
  untracked: string[];
}

export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  old_no?: number;
  new_no?: number;
  text: string;
}

export interface Hunk {
  title: string;
  old_start: number;
  new_start: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  binary: boolean;
  hunks: Hunk[];
  truncated: boolean;
}

export interface CommitDetail {
  commit: Commit;
  files: FileChange[];
  caps: CommitCaps;
}

/** 一个操作能不能用；不能用时给出原因（说明书 5.6） */
export interface Cap {
  ok: boolean;
  why?: string;
}

export interface CommitCaps {
  cherry_pick: Cap;
  checkout: Cap;
  reset: Cap;
  revert: Cap;
  undo: Cap;
  reword: Cap;
  drop: Cap;
  /** 从这里开始整理（说明书 9.2） */
  rebase_from: Cap;
  /** Fixup / Squash Into（还要求提交面板有勾选） */
  fixup: Cap;
  /** 和本地比较（说明书 10.3） */
  compare_local: Cap;
  /** 推送到这里为止（说明书 5.6） */
  push_to: Cap;
  parent?: string;
  child?: string;
  /** 托管平台上这个提交的页面 */
  web_url?: string;
}

export type ResetMode = "soft" | "mixed" | "hard";

/** 逐行追溯的一页（说明书 10.2） */
export interface BlamePage {
  total: number;
  offset: number;
  lines: { no: number; text: string; commit: number }[];
  commits: { id: string; title: string; body: string; author: string; email: string; time: number; in_log: boolean; uncommitted: boolean }[];
}

/** 比较的结果（说明书 10.3） */
export interface Comparison {
  from: string;
  to: string;
  /** 只在起点这边的提交，新的在前 */
  only_from: Commit[];
  /** 只在终点这边的提交 */
  only_to: Commit[];
  truncated: boolean;
  files: FileChange[];
}

// ---------- 整理提交（说明书第 9 节） ----------

export interface RangeCommit {
  id: string;
  title: string;
  body: string;
  author: string;
  time: number;
  pushed: boolean;
}

export interface RebaseRange {
  /** 从旧到新 */
  commits: RangeCommit[];
  has_pushed: boolean;
}

export type StepAction = "pick" | "squash" | "fixup" | "drop";

export interface RebaseStep {
  id: string;
  action: StepAction;
  message?: string;
}

export interface RebaseResult {
  before: number;
  after: number;
}

export interface Selection {
  /** whole 为假时只提交 lines 里的改动行：diff_worktree（不忽略空白、3 行上下文）里第 hunk 块第 line 行 */
  files: { path: string; old_path?: string; whole: boolean; lines?: { hunk: number; line: number }[] }[];
}

export interface CommitCreated {
  id: string;
  state: RepoState;
  op?: OpInfo;
}

export type ChangeScope = "refs" | "status" | "stash" | "shelf";

// ---------- 分支、远程分支、标签 ----------

export interface Branch {
  name: string;
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
  is_current: boolean;
  /** 已完全包含在当前分支里，删除不会丢提交 */
  merged: boolean;
  /** 在另一个工作目录里检出（那个目录的路径），这里切换不过去 */
  worktree?: string;
  /** 本地改写了已经推送的提交：推送需要强制推送；这时 behind 是远程上的旧版本，不该拉取 */
  needs_force: boolean;
  /** 不能把当前分支变基到它之上的原因（核心层的中文，显示时 tr()）；能变基时没有 */
  rebase_block?: string;
  /** 收藏了（存在仓库的 .git/strand/favorites 里） */
  favorite?: boolean;
}

/** 工作目录（说明书 6.6） */
export interface Worktree {
  path: string;
  branch?: string;
  head: string;
  is_main: boolean;
  is_current: boolean;
  locked: boolean;
  /** 文件夹已经不在了 */
  prunable: boolean;
}

export interface RemoteBranch {
  name: string;
  remote: string;
  head: string;
  /** 同 Branch.rebase_block */
  rebase_block?: string;
}

export interface Tag {
  name: string;
  at: string;
  /** 还没推送到 origin（按上次抓取时记下的远程标签）；从没抓取过时为 false */
  unpushed: boolean;
}

export interface RefsList {
  branches: Branch[];
  remotes: RemoteBranch[];
  tags: Tag[];
  head: Head;
  /** 第一个是主工作目录 */
  worktrees: Worktree[];
}

export type MergeResult = "up_to_date" | "fast_forward" | "merged" | "squashed";
/** 合并方式（说明书 6.7）：能快进就快进 / 总是生成合并提交 / 压缩成一个提交 */
export type MergeMode = "auto" | "no_ff" | "squash";

/** 变基前的检查（说明书 6.3） */
export interface RebasePlan {
  branch: string;
  onto: string;
  /** 当前分支独有的提交数 */
  own: number;
  /** 其中已经推送过的 */
  pushed: number;
  /** 目标分支上当前分支还没有的提交数 */
  incoming: number;
  has_merge: boolean;
}

export type RebaseOutcome = "up_to_date" | "fast_forward" | "rebased";

/** 写操作的返回：操作结果和最新的仓库状态 */
export interface Written<T> {
  result: T;
  state: RepoState;
  /** 这次操作写进操作日志的那一条（说明书第 11 节）；没有记日志时省略 */
  op?: OpInfo;
  /** 给用户的补充说明，如拉取后自动搁置的改动没能放回（说明书 7.2） */
  note?: string;
}

// ---------- 贮藏和暂存架（说明书 4.9） ----------

export interface StashEntry {
  /** stash@{index} */
  index: number;
  id: string;
  message: string;
  time: number;
}

export interface ShelfEntry {
  id: number;
  name: string;
  time: number;
  files: { path: string; status: FileChange["status"] }[];
  base: string;
}

// ---------- 撤销、重做和操作时间线 ----------

export type OpKind = "commit" | "branch" | "switch" | "merge" | "checkout" | "tag" | "pull" | "push" | "stash" | "shelf" | "other";

export interface OpInfo {
  id: number;
  label: string;
  kind: OpKind;
  time: number;
  undoable: boolean;
  /** 已撤销，等待重做 */
  undone: boolean;
  /** 不能撤销的原因 */
  reason?: string;
}

export interface OpList {
  /** 新的在前 */
  entries: OpInfo[];
  can_undo: boolean;
  can_redo: boolean;
}

// ---------- 远程操作 ----------

export interface FetchResult {
  /** 抓取改动了引用（远程分支、标签）；没改时界面不重新读取日志 */
  refs_changed?: boolean;
  /** 抓取后当前分支落后跟踪分支的提交数 */
  behind: number;
  /** 这次新到的提交数 */
  incoming: number;
}

export type PullMode = "merge" | "rebase";
export type PullOutcome = "up_to_date" | "fast_forward" | "merged" | "rebased";

export interface PullResult {
  outcome: PullOutcome;
  incoming: number;
}

/** 拉取摘要面板里的一个冲突文件（说明书 7.2） */
export interface PreviewConflict {
  path: string;
  kind: "text" | "modify_delete" | "binary" | "lock";
  /** 文本文件里两边改了同一段的处数 */
  blocks: number;
  /** 变基方式：第一次冲突出现在哪个本地提交（标题） */
  commit?: string;
}

/** 拉取的预演：按上次抓取的结果在内存里合并一遍，不改仓库 */
export interface PullPreview {
  branch: string;
  upstream: string;
  mode: PullMode;
  incoming: number;
  ahead: number;
  auto_merged: number;
  conflicts: PreviewConflict[];
  /** 工作区里已跟踪文件的改动数（会先搁置到暂存架） */
  dirty: number;
}

export interface PushPreview {
  branch: string;
  target: string;
  new_branch: boolean;
  commits: { id: string; title: string }[];
  behind: number;
  needs_force: boolean;
  /** 推送到这个提交为止（说明书 5.6）：commits 只含它和它之前的 */
  to?: string;
  /** 推送到某个提交为止时，它之后留在本地的提交数 */
  left: number;
  /** 还没推送的本地标签 */
  unpushed_tags: string[];
  /** 还没抓取过，不知道远程有哪些标签 */
  tags_unknown: boolean;
}

export interface TaskProgress {
  task_id: string;
  text: string;
  percent?: number;
}

// ---------- 冲突解决（说明书 8.10） ----------

export type SessionKind = "merge" | "rebase" | "cherry_pick" | "revert" | "unstash";
export type FileKind = "text" | "modify_delete" | "binary" | "lock" | "rename";
export type SideChange = "modified" | "deleted" | "added" | "renamed";

/** 引入一个修改块的提交（说明书 8.10 的 Block.origin） */
export interface Origin {
  commit: string;
  author: string;
  /** Unix 秒 */
  time: number;
  title: string;
}
export type Side = "mine" | "theirs";
export type Mark = "none" | "accept" | "discard";

export interface SideInfo {
  label: string;
  commit?: string;
  title?: string;
}

export interface Change {
  id: string;
  base: string[];
  /** 这一侧改成的内容；null 表示这一侧没有改动 */
  mine: string[] | null;
  theirs: string[] | null;
  /** 引入这一侧这段内容的提交；没有时显示这一侧的提交 */
  mine_origin?: Origin;
  theirs_origin?: Origin;
}

export type Segment = { type: "context"; lines: string[] } | ({ type: "change" } & Change);

export interface ConflictFile {
  path: string;
  kind: FileKind;
  mine_change: SideChange;
  theirs_change: SideChange;
  segments: Segment[];
  /** 这次操作里有过冲突、现在已经解决（含在命令行里 git add 的） */
  resolved?: boolean;
  /** 重命名冲突：两边各自的新名字（path 是原来的名字） */
  mine_path?: string;
  theirs_path?: string;
}

export interface MergeSession {
  kind: SessionKind;
  step?: { index: number; total: number };
  mine: SideInfo;
  theirs: SideInfo;
  /** 这次操作里有冲突的文件；resolved 为真的是已经解决的 */
  files: ConflictFile[];
  /** 撤销“中止合并”后放回来的标记：中止时交给核心层的 localStorage 条目（键 → 内容） */
  saved_marks?: Record<string, unknown>;
}

export interface ChangeMark {
  mine: Mark;
  theirs: Mark;
  custom?: string[] | null;
}

export interface FinishResult {
  done: boolean;
  next?: MergeSession;
}

// ---------- 提交前格式化和检查（说明书 4.4、4.6） ----------

export interface ChecksConfig {
  format_command: string;
  check_command: string;
  format_on_commit: boolean;
  check_on_commit: boolean;
}

/** 配置和按仓库文件推测的建议命令 */
export interface ChecksInfo extends ChecksConfig {
  suggest_format: string[];
  suggest_check: string[];
}

export type CheckKind = "format" | "check";

export interface CheckIssue {
  path: string;
  line?: number | null;
  col?: number | null;
  /** error、warning 或空 */
  level: string;
  message: string;
}

export interface CheckRun {
  kind: CheckKind;
  command: string;
  ok: boolean;
  code?: number | null;
  output: string;
  truncated: boolean;
  timed_out: boolean;
  issues: CheckIssue[];
  ms: number;
  /** 格式化改动了的文件 */
  changed: string[];
}

/** 控制台里的一条（说明书 5.8）：`$` 是执行的 git 命令，`#` 是客户端自己的操作 */
export interface ConsoleEntry {
  seq: number;
  /** 毫秒时间戳 */
  time: number;
  kind: "command" | "note";
  /** 命令（不含 `$`）或操作说明（不含 `#`），凭据已打码 */
  text: string;
  /** 命令的输出，凭据已打码，最多 12 行 */
  output: string[];
  /** 截掉的输出行数 */
  more?: number;
  ok: boolean;
  /** 用时（毫秒） */
  ms?: number;
}

// ---------- 项目文件和文件修改链 ----------

export interface FileText {
  path: string;
  /** 文字内容；二进制或不存在时没有 */
  text?: string;
  binary: boolean;
  /** 这个版本（或工作区）里没有这个文件 */
  missing: boolean;
  size: number;
  truncated: boolean;
}

export interface FileVersion {
  commit: Commit;
  /** 这个提交里文件的路径 */
  path: string;
  /** 这个提交把文件从哪个路径改名过来 */
  old_path?: string;
  status: FileChange["status"];
  added: number;
  deleted: number;
  binary: boolean;
}

export interface FileHistory {
  /** 从新到旧 */
  versions: FileVersion[];
  truncated: boolean;
}
