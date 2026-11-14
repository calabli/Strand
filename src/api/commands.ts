// 核心层命令的类型化封装。界面代码只通过这里和核心层通信，不直接调用 invoke。
//
// 在浏览器里单独运行前端（pnpm dev，不经过 Tauri）时，自动改用 mock.ts 里的示例数据，
// 方便只改界面时不用编译 Rust。

import { invoke } from "@tauri-apps/api/core";
import type {
  ChangeMatch,
  ProjectSearch,
  FileHistory,
  FileText,
  ChangeMark,
  ChangeScope,
  FinishResult,
  MergeSession,
  Side,
  CommitCreated,
  ConsoleEntry,
  BlamePage,
  CommitCaps,
  Comparison,
  CommitDetail,
  CoreError,
  FetchResult,
  FileDiff,
  GitInfo,
  LogAuthor,
  LogFilter,
  LogPage,
  LogSort,
  OpInfo,
  OpList,
  MergeResult,
  MergeMode,
  PullMode,
  PullResult,
  PullPreview,
  PushPreview,
  RefsList,
  RepoState,
  ResetMode,
  RebaseRange,
  RebaseResult,
  RebaseStep,
  ShelfEntry,
  StashEntry,
  FileChange,
  RebaseOutcome,
  RebasePlan,
  CheckKind,
  CheckRun,
  ChecksConfig,
  ChecksInfo,
  Selection,
  TaskProgress,
  WorktreeStatus,
  Written,
} from "./types";
import * as mock from "./mock";
import { t } from "../i18n";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 调用失败时抛出的错误，带说明书第 14 节的错误码 */
export class ApiError extends Error {
  readonly code: CoreError["code"];
  readonly detail?: unknown;
  constructor(e: CoreError) {
    super(e.message);
    this.code = e.code;
    this.detail = e.detail;
  }
}

function isCoreError(e: unknown): e is CoreError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

/** 把任何异常转成 ApiError（示例数据抛出的是普通对象） */
export function errOf(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (isCoreError(e)) return new ApiError(e);
  return new ApiError({ code: "GIT_FAILED", message: String(e) });
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (isCoreError(e)) throw new ApiError(e);
    throw new ApiError({ code: "GIT_FAILED", message: String(e) });
  }
}

export const api = {
  gitCheck: (): Promise<GitInfo> => (inTauri ? call("git_check") : mock.gitCheck()),
  launchPath: (): Promise<string | null> => (inTauri ? call("launch_path") : Promise.resolve(null)),
  repoOpen: (path: string): Promise<RepoState> => (inTauri ? call("repo_open", { path }) : mock.repoOpen(path)),
  repoState: (): Promise<RepoState> => (inTauri ? call("repo_state") : mock.repoState()),
  repoReload: (): Promise<RepoState> => (inTauri ? call("repo_reload") : mock.repoState()),
  /** 文件监听触发的刷新：引用和 HEAD 没变时不重新读取日志，changed 为假 */
  repoRefresh: (): Promise<{ state: RepoState; changed: boolean }> =>
    inTauri ? call("repo_refresh") : mock.repoState().then((state) => ({ state, changed: true })),
  logQuery: (offset: number, limit: number, filter: LogFilter = {}, sort: LogSort = "topo"): Promise<LogPage> =>
    inTauri ? call("log_query", { filter, sort, offset, limit }) : mock.logQuery(offset, limit, filter, sort),
  logAuthors: (): Promise<LogAuthor[]> => (inTauri ? call("log_authors") : mock.logAuthors()),
  statusGet: (): Promise<WorktreeStatus> => (inTauri ? call("status_get") : mock.statusGet()),
  diffWorktree: (path: string, ignoreWs = false): Promise<FileDiff> =>
    inTauri ? call("diff_worktree", { path, ignoreWs }) : mock.diffFile(path),
  commitCreate: (message: string, selection: Selection, signOff = false): Promise<CommitCreated> =>
    inTauri ? call("commit_create", { message, selection, signOff }) : mock.commitCreate(message, selection),
  /** 修订上一次提交；message 为空时保留原说明 */
  commitAmend: (message: string | null, selection: Selection, signOff = false): Promise<CommitCreated> =>
    inTauri ? call("commit_amend", { message, selection, signOff }) : mock.commitAmend(message),
  commitDetail: (id: string): Promise<CommitDetail> => (inTauri ? call("commit_detail", { id }) : mock.commitDetail(id)),
  commitCaps: (id: string): Promise<CommitCaps> => (inTauri ? call("commit_caps", { id }) : mock.commitCaps(id)),
  /** 拣选：按从旧到新的顺序依次拣选；有冲突时返回 CONFLICTS，仓库停在拣选状态 */
  commitCherryPick: (ids: string[]): Promise<Written<null>> => (inTauri ? call("commit_cherry_pick", { ids }) : mock.commitOp(t("拣选 {0} 个提交", ids.length))),
  commitRevert: (id: string): Promise<Written<null>> => (inTauri ? call("commit_revert", { id }) : mock.commitOp(t("还原提交"))),
  commitReset: (id: string, mode: ResetMode): Promise<Written<null>> =>
    inTauri ? call("commit_reset", { id, mode }) : mock.commitOp(t("重置到 {0}", id.slice(0, 7))),
  commitUndo: (): Promise<Written<null>> => (inTauri ? call("commit_undo") : mock.commitOp(t("撤销提交"))),
  commitReword: (id: string, message: string): Promise<Written<null>> =>
    inTauri ? call("commit_reword", { id, message }) : mock.commitOp(t("修改说明")),
  commitDrop: (id: string): Promise<Written<null>> => (inTauri ? call("commit_drop", { id }) : mock.commitOp(t("丢弃提交"))),
  diffCommit: (id: string, path: string): Promise<FileDiff> =>
    inTauri ? call("diff_commit", { id, path }) : mock.diffFile(path),

  // 分支和标签（说明书第 6 节）
  refsList: (): Promise<RefsList> => (inTauri ? call("refs_list") : mock.refsList()),
  /** 收藏或取消收藏一个本地分支（说明书 6.1） */
  prefsSetFavorite: (name: string, favorite: boolean): Promise<null> =>
    inTauri ? call("prefs_set_favorite", { name, favorite }) : mock.setFavorite(name, favorite),
  /** 提交、分支或标签在日志里的行号 */
  /** 提交在（过滤后的）日志里的行号；不在结果里返回 null */
  logLocate: (rev: string, filter: LogFilter = {}, sort: LogSort = "topo"): Promise<number | null> =>
    inTauri ? call("log_locate", { rev, filter, sort }) : mock.logLocate(rev, filter, sort),
  branchCreate: (name: string, at: string | null, checkout: boolean): Promise<Written<null>> =>
    inTauri ? call("branch_create", { name, at, checkout }) : mock.branchCreate(name, checkout),
  branchSwitch: (name: string, stashFirst = false): Promise<Written<null>> =>
    inTauri ? call("branch_switch", { name, stashFirst }) : mock.branchSwitch(name),
  branchRename: (name: string, newName: string): Promise<Written<null>> =>
    inTauri ? call("branch_rename", { name, newName }) : mock.branchRename(name, newName),
  branchDelete: (name: string, force = false): Promise<Written<null>> =>
    inTauri ? call("branch_delete", { name, force }) : mock.branchDelete(name, force),
  /** message：压缩合并时的说明，为空用默认的 */
  branchMerge: (source: string, mode: MergeMode = "auto", message: string | null = null): Promise<Written<MergeResult>> =>
    inTauri ? call("branch_merge", { source, mode, message }) : mock.ok<MergeResult>(mode === "squash" ? "squashed" : "merged"),
  /** 拖拽合并：把 source 合并到 target，target 不是当前分支时先切换过去（说明书 6.1） */
  branchMergeInto: (source: string, target: string, mode: MergeMode = "auto", message: string | null = null): Promise<Written<MergeResult>> =>
    inTauri ? call("branch_merge_into", { source, target, mode, message }) : mock.ok<MergeResult>(mode === "squash" ? "squashed" : "merged"),
  /** 压缩合并的默认说明（target 为空时按当前分支算） */
  branchSquashMessage: (source: string, target: string | null = null): Promise<string> =>
    inTauri ? call("branch_squash_message", { source, target }) : Promise.resolve(`压缩合并 ${source}\n\n* ${source} 上的提交`),
  /** 变基前的检查：独有提交数、已推送数、有没有合并提交 */
  branchRebasePlan: (onto: string): Promise<RebasePlan> => (inTauri ? call("branch_rebase_plan", { onto }) : mock.rebasePlan(onto)),
  /** 把当前分支变基到 onto 之上；有冲突时返回 CONFLICTS，停在变基状态 */
  branchRebase: (onto: string): Promise<Written<RebaseOutcome>> =>
    inTauri ? call("branch_rebase", { onto }) : mock.ok<RebaseOutcome>("rebased", `变基到 ${onto} 之上`, "merge"),
  /** marks：这个仓库的冲突标记（localStorage 条目），核心层存进中止这一步，撤销中止时还回来（说明书 8.9） */
  mergeAbort: (marks?: Record<string, unknown>): Promise<Written<null>> => (inTauri ? call("merge_abort", { marks }) : mock.ok(null)),
  branchCheckoutRemote: (remoteBranch: string): Promise<Written<string>> =>
    inTauri ? call("branch_checkout_remote", { remoteBranch }) : mock.branchCheckoutRemote(remoteBranch),
  checkoutDetached: (rev: string): Promise<Written<null>> =>
    inTauri ? call("checkout_detached", { rev }) : mock.ok(null),
  tagCreate: (name: string, at: string): Promise<Written<null>> =>
    inTauri ? call("tag_create", { name, at }) : mock.tagCreate(name, at),
  tagDelete: (name: string): Promise<Written<null>> => (inTauri ? call("tag_delete", { name }) : mock.tagDelete(name)),

  // 远程操作（说明书第 7 节）。taskId 由前端生成，用于进度事件和取消
  /** quiet：后台自动抓取，需要输入密码时不弹框、直接失败（说明书 7.5） */
  remoteFetch: (taskId: string, quiet = false): Promise<Written<FetchResult>> =>
    inTauri ? call("remote_fetch", { taskId, quiet }) : mock.slow({ behind: 1, incoming: 1 }),
  /** fetched：刚抓取过并看过拉取摘要面板，不再抓取（说明书 7.2） */
  remotePull: (taskId: string, mode: PullMode, fetched = false): Promise<Written<PullResult>> =>
    inTauri ? call("remote_pull", { taskId, mode, fetched }) : mock.slow<PullResult>({ outcome: "fast_forward", incoming: 1 }),
  remotePullPreview: (mode: PullMode): Promise<PullPreview> => (inTauri ? call("remote_pull_preview", { mode }) : mock.pullPreview(mode)),
  /** to 不为空时是“推送到这里为止”的预览 */
  tagPush: (taskId: string, name: string): Promise<Written<null>> => (inTauri ? call("tag_push", { taskId, name }) : mock.tagPush(name)),
  /** 回答 auth_required；secret 为 null 表示取消 */
  consoleTail: (limit?: number): Promise<ConsoleEntry[]> => (inTauri ? call("console_tail", { limit }) : mock.consoleTail()),
  consoleClear: (): Promise<null> => (inTauri ? call("console_clear") : mock.consoleClear()),
  authReply: (requestId: string, secret: string | null): Promise<null> => (inTauri ? call("auth_reply", { requestId, secret }) : Promise.resolve(null)),
  remotePushPreview: (to: string | null = null): Promise<PushPreview> => (inTauri ? call("remote_push_preview", { to }) : mock.pushPreview(to)),
  remotePush: (taskId: string, force: boolean, tags: boolean, to: string | null = null): Promise<Written<null>> =>
    inTauri ? call("remote_push", { taskId, force, tags, to }) : mock.slow(null),
  // 工作目录（说明书 6.6）和克隆
  worktreeAdd: (path: string, branch: string, newBranch: boolean, base: string | null): Promise<Written<null>> =>
    inTauri ? call("worktree_add", { path, branch, newBranch, base }) : mock.worktreeAdd(path, branch, newBranch),
  /** 有未提交的改动时不加 force 返回 WORKTREE_CONFLICT */
  worktreeRemove: (path: string, force: boolean): Promise<Written<null>> =>
    inTauri ? call("worktree_remove", { path, force }) : mock.worktreeRemove(path, force),
  /** 克隆到 dest（完整路径），进度走 task_progress */
  repoClone: (taskId: string, url: string, dest: string): Promise<string> => (inTauri ? call("repo_clone", { taskId, url, dest }) : mock.slow(dest).then((w) => w.result)),
  taskCancel: (taskId: string): Promise<void> => (inTauri ? call("task_cancel", { taskId }) : Promise.resolve()),

  // 提交前格式化和检查（说明书 4.4、4.6）。配置存在仓库的 Git 配置里
  checksConfig: (): Promise<ChecksInfo> => (inTauri ? call("checks_config_get") : mock.checksConfig()),
  checksConfigSet: (config: ChecksConfig): Promise<ChecksInfo> => (inTauri ? call("checks_config_set", { config }) : mock.checksConfigSet(config)),
  /** 运行格式化或检查；files 是要提交的文件。可以用 taskCancel 取消 */
  checksRun: (taskId: string, kind: CheckKind, files: string[]): Promise<CheckRun> =>
    inTauri ? call("checks_run", { taskId, kind, files }) : mock.checksRun(kind, files),

  // 冲突解决（说明书第 8 节）。标记保存在前端，应用文件时一次传入
  mergeSession: (): Promise<MergeSession | null> => (inTauri ? call("merge_session") : mock.mergeSession()),
  mergeApplyFile: (path: string, marks: Record<string, ChangeMark>): Promise<Written<null>> =>
    inTauri ? call("merge_apply_file", { path, marks }) : mock.mergeApplyFile(path, marks),
  mergeTakeFile: (path: string, side: Side): Promise<Written<null>> =>
    inTauri ? call("merge_take_file", { path, side }) : mock.mergeTakeFile(path),
  /** 可整理范围；from 为空时返回最大范围 */
  rebaseRange: (from: string | null = null): Promise<RebaseRange> => (inTauri ? call("rebase_range", { from }) : mock.rebaseRange(from)),
  /** steps 按新顺序从旧到新，必须覆盖从某个提交到最新提交的连续一段 */
  rebaseApply: (steps: RebaseStep[]): Promise<Written<RebaseResult>> => (inTauri ? call("rebase_apply", { steps }) : mock.rebaseApply(steps)),
  /** Fixup（message 为空）或 Squash Into：把勾选的改动并入这个提交 */
  commitFixup: (id: string, selection: Selection, message: string | null = null): Promise<Written<null>> =>
    inTauri ? call("commit_fixup", { id, selection, message }) : mock.commitOp(message ? "Squash Into" : "Fixup"),
  /** 丢弃这些文件的改动（新增的文件会被删除），可以撤销 */
  changesDiscard: (paths: string[]): Promise<Written<null>> => (inTauri ? call("changes_discard", { paths }) : mock.changesDiscard(paths)),
  untrackedAdd: (path: string): Promise<Written<null>> => (inTauri ? call("untracked_add", { path }) : mock.untracked("add", path)),
  untrackedIgnore: (path: string): Promise<Written<null>> => (inTauri ? call("untracked_ignore", { path }) : mock.untracked("ignore", path)),
  /** 移到系统废纸篓 */
  untrackedDelete: (path: string): Promise<Written<null>> => (inTauri ? call("untracked_delete", { path }) : mock.untracked("delete", path)),
  /** 逐行追溯第 offset+1 行起的 limit 行；rev 为空表示工作区里的文件 */
  blameFile: (path: string, rev: string | null, offset: number, limit: number): Promise<BlamePage> =>
    inTauri ? call("blame_file", { path, rev, offset, limit }) : mock.blameFile(path, offset, limit),
  /** 比较两个提交（说明书 10.3） */
  compare: (from: string, to: string): Promise<Comparison> => (inTauri ? call("compare", { from, to }) : mock.compare(from, to)),
  diffCompare: (from: string, to: string, path: string): Promise<FileDiff> =>
    inTauri ? call("diff_compare", { from, to, path }) : mock.diffFile(path),
  patchCommit: (id: string): Promise<string> => (inTauri ? call("patch_commit", { id }) : mock.patchCommit(id)),
  patchWorktree: (selection: Selection): Promise<string> => (inTauri ? call("patch_worktree", { selection }) : mock.patchWorktree(selection)),
  /** 把文字写到保存对话框选的路径 */
  fileSave: (path: string, text: string): Promise<null> => (inTauri ? call("file_save", { path, text }) : Promise.resolve(null)),
  commitTree: (id: string): Promise<string[]> => (inTauri ? call("commit_tree", { id }) : mock.commitTree()),
  // 项目文件和文件修改链
  projectFiles: (): Promise<string[]> => (inTauri ? call("project_files") : mock.projectFiles()),
  /** rev 为空时是工作区里的内容 */
  fileText: (path: string, rev: string | null = null): Promise<FileText> => (inTauri ? call("file_text", { path, rev }) : mock.fileText(path, rev)),
  fileHistory: (path: string): Promise<FileHistory> => (inTauri ? call("file_history", { path }) : mock.fileHistory(path)),
  /** 按改动内容搜索时，这个提交里改动行有匹配的文件 */
  commitChangeMatches: (id: string, text: string, regex: boolean, caseSensitive: boolean): Promise<ChangeMatch[]> =>
    inTauri ? call("commit_change_matches", { id, text, regex, caseSensitive }) : mock.commitChangeMatches(),
  /** 项目文件全文搜；rev 为空是工作区 */
  projectSearch: (text: string, regex: boolean, caseSensitive: boolean, rev: string | null): Promise<ProjectSearch> =>
    inTauri ? call("project_search", { text, regex, caseSensitive, rev }) : mock.projectSearch(text, regex, caseSensitive, rev),
  /** from 为空是新增（旧的一边没有），to 为空是工作区 */
  fileDiffVersions: (from: string | null, fromPath: string, to: string | null, toPath: string): Promise<FileDiff> =>
    inTauri ? call("file_diff_versions", { from, fromPath, to, toPath }) : mock.fileDiffVersions(from, fromPath, to, toPath),
  stashList: (): Promise<StashEntry[]> => (inTauri ? call("stash_list") : mock.stashList()),
  stashFiles: (index: number): Promise<FileChange[]> => (inTauri ? call("stash_files", { index }) : mock.stashFiles(index)),
  stashPush: (message: string | null = null): Promise<Written<null>> => (inTauri ? call("stash_push", { message }) : mock.stashPush()),
  /** 取回贮藏：drop 为真是取回并删除，否则取回但保留；冲突时返回 CONFLICTS，仓库进入“取回进行中” */
  stashApply: (index: number, drop: boolean): Promise<Written<null>> =>
    inTauri ? call("stash_apply", { index, drop }) : mock.stashApply(index, drop),
  stashDrop: (index: number): Promise<Written<null>> => (inTauri ? call("stash_drop", { index }) : mock.stashDrop(index)),
  shelfList: (): Promise<ShelfEntry[]> => (inTauri ? call("shelf_list") : mock.shelfList()),
  shelfSave: (name: string, paths: string[]): Promise<Written<ShelfEntry>> =>
    inTauri ? call("shelf_save", { name, paths }) : mock.shelfSave(name, paths),
  /** 取回暂存架条目；paths 不为空时只取回这些文件，剩下的留在暂存架（说明书 4.9） */
  shelfRestore: (id: number, paths: string[] | null = null): Promise<Written<null>> =>
    inTauri ? call("shelf_restore", { id, paths }) : mock.shelfRestore(id, paths),
  shelfDelete: (id: number): Promise<Written<null>> => (inTauri ? call("shelf_delete", { id }) : mock.shelfDelete(id)),
  /** 暂存架条目里的文件和改动行数（从保存的补丁里读） */
  shelfFiles: (id: number): Promise<FileChange[]> => (inTauri ? call("shelf_files", { id }) : mock.shelfFiles(id)),
  /** 暂存架条目里一个文件的差异 */
  shelfDiff: (id: number, path: string): Promise<FileDiff> => (inTauri ? call("shelf_diff", { id, path }) : mock.diffFile(path)),
  shelfRename: (id: number, name: string): Promise<null> => (inTauri ? call("shelf_rename", { id, name }) : mock.shelfRename(id, name)),
  oplogList: (limit = 50): Promise<OpList> => (inTauri ? call("oplog_list", { limit }) : mock.oplogList(limit)),
  /** 撤销最近一步，或撤销到 toId（含）为止；越过已推送的步骤要 confirmPushed */
  oplogUndo: (toId: number | null = null, confirmPushed = false): Promise<Written<OpInfo[]>> =>
    inTauri ? call("oplog_undo", { toId, confirmPushed }) : mock.oplogUndo(toId, confirmPushed),
  oplogRedo: (): Promise<Written<OpInfo[]>> => (inTauri ? call("oplog_redo") : mock.oplogRedo()),
  mergeFinish: (): Promise<Written<FinishResult>> => (inTauri ? call("merge_finish") : mock.mergeFinish()),
  mergeSkip: (): Promise<Written<FinishResult>> => (inTauri ? call("merge_skip") : mock.mergeFinish()),
};

/** 订阅长任务的进度事件 */
export function onTaskProgress(cb: (p: TaskProgress) => void): () => void {
  if (!inTauri) return () => {};
  let off: (() => void) | null = null;
  let cancelled = false;
  import("@tauri-apps/api/event").then(({ listen }) =>
    listen<TaskProgress>("task_progress", (e) => cb(e.payload)).then((u) => {
      if (cancelled) u();
      else off = u;
    }),
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

/** 需要输入凭据（说明书 7.5） */
export interface AuthRequest {
  request_id: string;
  /** git 或 ssh 给的提示原文 */
  prompt: string;
  /** 是密码或口令（输入框遮住） */
  secret: boolean;
}

/** 订阅 auth_required（要输入）和 auth_closed（操作被停止，收回输入框） */
export function onAuthEvents(onAsk: (r: AuthRequest) => void, onClosed: (id: string) => void): () => void {
  if (!inTauri) {
    // 浏览器预览：开发时可以在控制台用 __strandAuth({...}) 模拟一次请求
    if (import.meta.env.DEV) (window as unknown as { __strandAuth?: typeof onAsk }).__strandAuth = onAsk;
    return () => {};
  }
  const offs: (() => void)[] = [];
  let cancelled = false;
  import("@tauri-apps/api/event").then(async ({ listen }) => {
    const a = await listen<AuthRequest>("auth_required", (e) => onAsk(e.payload));
    const b = await listen<string>("auth_closed", (e) => onClosed(e.payload));
    if (cancelled) {
      a();
      b();
    } else offs.push(a, b);
  });
  return () => {
    cancelled = true;
    offs.forEach((f) => f());
  };
}

/** 订阅控制台的新条目（说明书 5.8） */
export function onConsoleLine(cb: (e: ConsoleEntry) => void): () => void {
  if (!inTauri) return mock.onConsoleLine(cb);
  let off: (() => void) | null = null;
  let cancelled = false;
  import("@tauri-apps/api/event").then(({ listen }) =>
    listen<ConsoleEntry>("console_line", (e) => cb(e.payload)).then((u) => {
      if (cancelled) u();
      else off = u;
    }),
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

/** 用系统浏览器打开网址 */
export async function openUrl(url: string) {
  if (!inTauri) return void window.open(url, "_blank", "noopener");
  const { openUrl: open } = await import("@tauri-apps/plugin-opener");
  await open(url);
}

/** 在系统文件管理器里显示这个文件夹 */
export async function revealPath(path: string) {
  if (!inTauri) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** 订阅核心层的 repo_changed 事件，返回取消订阅的函数（说明书 2.2） */
export function onRepoChanged(cb: (scopes: ChangeScope[]) => void): () => void {
  if (!inTauri) return () => {};
  let off: (() => void) | null = null;
  let cancelled = false;
  import("@tauri-apps/api/event").then(({ listen }) =>
    listen<{ scopes: ChangeScope[] }>("repo_changed", (e) => cb(e.payload.scopes)).then((u) => {
      if (cancelled) u();
      else off = u;
    }),
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

/** 弹出系统的选择文件夹对话框，返回路径；取消时返回 null */
export async function pickFolder(title?: string): Promise<string | null> {
  if (!inTauri) return title ? "/示例" : "/示例/strand-app";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: false, title: title ?? t("打开仓库") });
  return typeof r === "string" ? r : null;
}
