// Typed wrappers for core layer commands. UI code talks to the core layer only through here and never calls invoke directly.
//
// When the frontend runs alone in a browser (pnpm dev, without Tauri), the sample data in mock.ts is used automatically,
// so UI-only changes don't need a Rust build.

import { invoke } from "@tauri-apps/api/core";
import type {
  Contributions,
  DirEntry,
  SparseState,
  Textconv,
  LineRollbackPlan,
  PreviewPlugin,
  HookRun,
  Hooks,
  RepoSize,
  Hosting,
  PullRequest,
  Checks,
  MergedBranch,
  Submodule,
  UpdateInfo,
  UpdateProgress,
  ConfigScope,
  ConfigValue,
  Changelists,
  ComposeInfo,
  PatchPreview,
  BisectMark,
  BisectStatus,
  RemoteInfo,
  Signature,
  SigningConfig,
  ReflogEntry,
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

/** The error thrown when a call fails, with an error code from spec §14 */
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

/** Turn any exception into an ApiError (sample data throws plain objects) */
export function errOf(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (isCoreError(e)) return new ApiError(e);
  return new ApiError({ code: "GIT_FAILED", message: String(e) });
}

async function call<T>(cmd: string, args?: Parameters<typeof invoke>[1], options?: Parameters<typeof invoke>[2]): Promise<T> {
  try {
    return await invoke<T>(cmd, args, options);
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
  /** Refresh triggered by file watching: changed is false and the log isn't re-read when refs and HEAD are unchanged */
  repoRefresh: (): Promise<{ state: RepoState; changed: boolean }> =>
    inTauri ? call("repo_refresh") : mock.repoState().then((state) => ({ state, changed: true })),
  logQuery: (offset: number, limit: number, filter: LogFilter = {}, sort: LogSort = "topo"): Promise<LogPage> =>
    inTauri ? call("log_query", { filter, sort, offset, limit }) : mock.logQuery(offset, limit, filter, sort),
  logAuthors: (): Promise<LogAuthor[]> => (inTauri ? call("log_authors") : mock.logAuthors()),
  statusGet: (): Promise<WorktreeStatus> => (inTauri ? call("status_get") : mock.statusGet()),
  /** context: number of context lines (FULL is the whole file); line checks are recorded per block with 3 lines of context */
  diffWorktree: (path: string, ignoreWs = false, context = 3): Promise<FileDiff> =>
    inTauri ? call("diff_worktree", { path, ignoreWs, context }) : mock.diffFile(path, context),
  /** author: "Name <email>"; empty uses the identity from Git config */
  /** noVerify: skip the pre-commit and commit-msg hooks; a hook stopping the commit gives HOOK_FAILED with its output */
  commitCreate: (message: string, selection: Selection, signOff = false, author: string | null = null, noVerify = false): Promise<CommitCreated> =>
    inTauri ? call("commit_create", { message, selection, signOff, author, noVerify }) : mock.commitCreate(message, selection, noVerify),
  /** Amend the last commit; an empty message keeps the original */
  commitAmend: (message: string | null, selection: Selection, signOff = false, author: string | null = null, noVerify = false): Promise<CommitCreated> =>
    inTauri ? call("commit_amend", { message, selection, signOff, author, noVerify }) : mock.commitAmend(message),
  hooksList: (): Promise<Hooks> => (inTauri ? call("hooks_list") : mock.hooksList()),
  hookRead: (name: string): Promise<string> => (inTauri ? call("hook_read", { name }) : mock.hookRead(name)),
  hookWrite: (name: string, text: string): Promise<void> => (inTauri ? call("hook_write", { name, text }) : mock.hookWrite(name, text)),
  hookEnable: (name: string, on: boolean): Promise<void> => (inTauri ? call("hook_enable", { name, on }) : mock.hookEnable(name, on)),
  /** Run a hook now without committing */
  hookTry: (name: string): Promise<HookRun> => (inTauri ? call("hook_try", { name }) : mock.hookTry(name)),
  /** Cherry-pick or revert only some files of a commit, leaving the result in the worktree; returns CONFLICTS on conflicts */
  commitFilesApply: (id: string, paths: string[], revert: boolean): Promise<Written<null>> =>
    inTauri ? call("commit_files_apply", { id, paths, revert }) : mock.commitOp(revert ? t("还原部分文件") : t("拣选部分文件")),
  /** Replace a worktree file with its content at a revision */
  fileRestore: (id: string, path: string): Promise<Written<null>> => (inTauri ? call("file_restore", { id, path }) : mock.commitOp(t("取回 {0}", path))),
  /** A file's raw bytes at a revision; rev empty means the worktree */
  fileBytes: (path: string, rev: string | null): Promise<ArrayBuffer> => (inTauri ? call("file_bytes", { path, rev }) : mock.fileBytes(path, rev)),
  /** Common Git settings (identity, proxy, line endings, default branch); works without an open repository */
  gitConfigGet: (): Promise<ConfigValue[]> => (inTauri ? call("git_config_get") : mock.gitConfigGet()),
  /** Set a setting in a scope; empty or null removes it from that scope. Returns all settings again */
  gitConfigSet: (scope: ConfigScope, key: string, value: string | null): Promise<ConfigValue[]> =>
    inTauri ? call("git_config_set", { scope, key, value }) : mock.gitConfigSet(scope, key, value),
  /** Turn the proxy on or off in a scope; off keeps the address (strand.httpProxy / strand.httpsProxy) */
  gitProxyEnable: (scope: ConfigScope, on: boolean): Promise<ConfigValue[]> => (inTauri ? call("git_proxy_enable", { scope, on }) : mock.gitProxyEnable(scope, on)),
  /** Check for a newer version; null when up to date */
  updateCheck: (): Promise<UpdateInfo | null> => (inTauri ? call("update_check") : mock.updateCheck()),
  /** Download and install the update found by the last check, then restart (progress via onUpdateProgress) */
  updateInstall: (): Promise<void> => (inTauri ? call("update_install") : mock.updateInstall()),
  /** The app's version */
  appVersion: (): Promise<string> => (inTauri ? import("@tauri-apps/api/app").then((m) => m.getVersion()) : Promise.resolve("0.1.0")),
  composeInfo: (): Promise<ComposeInfo> => (inTauri ? call("compose_info") : mock.composeInfo()),
  changelistsGet: (): Promise<Changelists> => (inTauri ? call("changelists_get") : mock.changelistsGet()),
  changelistsSet: (lists: Changelists): Promise<Changelists> => (inTauri ? call("changelists_set", { lists }) : mock.changelistsSet(lists)),
  commitDetail: (id: string): Promise<CommitDetail> => (inTauri ? call("commit_detail", { id }) : mock.commitDetail(id)),
  commitCaps: (id: string): Promise<CommitCaps> => (inTauri ? call("commit_caps", { id }) : mock.commitCaps(id)),
  /** Cherry-pick: pick one by one from oldest to newest; on conflicts returns CONFLICTS and the repository stays in the cherry-pick state */
  commitCherryPick: (ids: string[]): Promise<Written<null>> => (inTauri ? call("commit_cherry_pick", { ids }) : mock.commitOp(t("拣选 {0} 个提交", ids.length))),
  commitRevert: (id: string): Promise<Written<null>> => (inTauri ? call("commit_revert", { id }) : mock.commitOp(t("还原提交"))),
  commitReset: (id: string, mode: ResetMode): Promise<Written<null>> =>
    inTauri ? call("commit_reset", { id, mode }) : mock.commitOp(t("重置到 {0}", id.slice(0, 7))),
  commitUndo: (): Promise<Written<null>> => (inTauri ? call("commit_undo") : mock.commitOp(t("撤销提交"))),
  commitReword: (id: string, message: string): Promise<Written<null>> =>
    inTauri ? call("commit_reword", { id, message }) : mock.commitOp(t("修改说明")),
  commitDrop: (id: string): Promise<Written<null>> => (inTauri ? call("commit_drop", { id }) : mock.commitOp(t("丢弃提交"))),
  /** context: number of context lines, FULL is the whole file */
  diffCommit: (id: string, path: string, context = 3): Promise<FileDiff> =>
    inTauri ? call("diff_commit", { id, path, context }) : mock.diffFile(path, context),

  // Branches and tags (spec §6)
  refsList: (): Promise<RefsList> => (inTauri ? call("refs_list") : mock.refsList()),
  /** Add or remove a local branch from favorites (spec §6.1) */
  prefsSetFavorite: (name: string, favorite: boolean): Promise<null> =>
    inTauri ? call("prefs_set_favorite", { name, favorite }) : mock.setFavorite(name, favorite),
  /** The row of a commit, branch or tag in the log */
  /** The row of a commit in the (filtered) log; null when not in the results */
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
  /** message: the squash-merge message; empty uses the default */
  branchMerge: (source: string, mode: MergeMode = "auto", message: string | null = null): Promise<Written<MergeResult>> =>
    inTauri ? call("branch_merge", { source, mode, message }) : mock.ok<MergeResult>(mode === "squash" ? "squashed" : "merged"),
  /** Drag merge: merge source into target, switching first when target isn't current (spec §6.1) */
  branchMergeInto: (source: string, target: string, mode: MergeMode = "auto", message: string | null = null): Promise<Written<MergeResult>> =>
    inTauri ? call("branch_merge_into", { source, target, mode, message }) : mock.ok<MergeResult>(mode === "squash" ? "squashed" : "merged"),
  /** Default squash-merge message (with target empty, against the current branch) */
  branchSquashMessage: (source: string, target: string | null = null): Promise<string> =>
    inTauri ? call("branch_squash_message", { source, target }) : Promise.resolve(`压缩合并 ${source}\n\n* ${source} 上的提交`),
  /** Pre-rebase check: own commits, pushed commits, any merge commits */
  branchRebasePlan: (onto: string): Promise<RebasePlan> => (inTauri ? call("branch_rebase_plan", { onto }) : mock.rebasePlan(onto)),
  /** Rebase the current branch onto onto; on conflicts returns CONFLICTS and stays in the rebase state */
  branchRebase: (onto: string): Promise<Written<RebaseOutcome>> =>
    inTauri ? call("branch_rebase", { onto }) : mock.ok<RebaseOutcome>("rebased", `变基到 ${onto} 之上`, "merge"),
  /** marks: this repository's conflict marks (localStorage entry); the core layer stores them with the abort step and returns them when the abort is undone (spec §8.9) */
  mergeAbort: (marks?: Record<string, unknown>): Promise<Written<null>> => (inTauri ? call("merge_abort", { marks }) : mock.ok(null)),
  branchCheckoutRemote: (remoteBranch: string): Promise<Written<string>> =>
    inTauri ? call("branch_checkout_remote", { remoteBranch }) : mock.branchCheckoutRemote(remoteBranch),
  checkoutDetached: (rev: string): Promise<Written<null>> =>
    inTauri ? call("checkout_detached", { rev }) : mock.ok(null),
  tagCreate: (name: string, at: string, message: string | null = null, sign = false): Promise<Written<null>> =>
    inTauri ? call("tag_create", { name, at, message, sign }) : mock.tagCreate(name, at),
  commitSignature: (id: string): Promise<Signature> => (inTauri ? call("commit_signature", { id }) : mock.commitSignature(id)),
  signingConfig: (): Promise<SigningConfig> => (inTauri ? call("signing_config") : Promise.resolve({ ...mock.signing })),
  signingSet: (commit: boolean): Promise<SigningConfig> => (inTauri ? call("signing_set", { commit }) : Promise.resolve(Object.assign(mock.signing, { commit }))),
  tagDelete: (name: string): Promise<Written<null>> => (inTauri ? call("tag_delete", { name }) : mock.tagDelete(name)),

  /** Delete a branch on the remote (network task) */
  remoteBranchDelete: (taskId: string, name: string): Promise<Written<null>> => (inTauri ? call("remote_branch_delete", { taskId, name }) : mock.slow(null)),
  /** Delete a tag on the remote; the local tag stays (network task) */
  remoteTagDelete: (taskId: string, name: string): Promise<Written<null>> => (inTauri ? call("remote_tag_delete", { taskId, name }) : mock.slow(null)),
  /** Set the remote branch a local branch tracks; null stops tracking */
  branchSetUpstream: (branch: string, upstream: string | null): Promise<RepoState> => (inTauri ? call("branch_set_upstream", { branch, upstream }) : mock.repoState()),
  // Files in the system, the terminal, cleaning up merged branches
  /** Reveal a worktree file in the file manager */
  fileReveal: (path: string): Promise<void> => (inTauri ? call("file_reveal", { path }) : Promise.resolve()),
  /** Open a worktree file with its default application; false when it was revealed instead (apps and scripts aren't opened) */
  fileOpen: (path: string): Promise<boolean> => (inTauri ? call("file_open", { path }) : Promise.resolve(!/\.(sh|exe|bat|command|app)$/i.test(path))),
  /** Open a terminal in the repository folder */
  repoTerminal: (): Promise<void> => (inTauri ? call("repo_terminal") : Promise.resolve()),
  mergedBranches: (into: string): Promise<MergedBranch[]> => (inTauri ? call("merged_branches", { into }) : mock.mergedBranches(into)),
  /** Record the repository open in this window, for restoring windows on the next launch */
  sessionRegister: (path: string): Promise<void> => (inTauri ? call("session_register", { path }) : Promise.resolve()),
  /** At startup: the repository the last session left open in this window (the others open in new windows) */
  sessionRestore: (reopen: boolean): Promise<string | null> => (inTauri ? call("session_restore", { reopen }) : Promise.resolve(null)),
  /** Quit the app (after unsaved edits were dealt with); this window comes back on the next launch */
  appQuit: (): Promise<void> => (inTauri ? call("app_quit") : Promise.resolve()),
  repoSize: (): Promise<RepoSize> => (inTauri ? call("repo_size") : mock.repoSize()),
  /** git gc; taskCancel stops it */
  repoGc: (taskId: string, aggressive: boolean): Promise<Written<null>> => (inTauri ? call("repo_gc", { taskId, aggressive }) : mock.repoGc()),
  rerereGet: (): Promise<boolean> => (inTauri ? call("rerere_get") : mock.rerereGet()),
  rerereSet: (on: boolean): Promise<void> => (inTauri ? call("rerere_set", { on }) : mock.rerereSet(on)),
  contributions: (since: number | null): Promise<Contributions> => (inTauri ? call("contributions", { since }) : mock.contributions(since)),
  /** Where origin is hosted; null when it isn't GitHub or GitLab */
  hostingInfo: (): Promise<Hosting | null> => (inTauri ? call("hosting_info") : mock.hostingInfo()),
  hostingSetToken: (token: string): Promise<void> => (inTauri ? call("hosting_set_token", { token }) : mock.hostingSetToken(token)),
  prList: (): Promise<PullRequest[]> => (inTauri ? call("pr_list") : mock.prList()),
  prChecks: (number: number, headSha: string): Promise<Checks> => (inTauri ? call("pr_checks", { number, headSha }) : mock.prChecks(number)),
  prCreate: (title: string, body: string, head: string, base: string, draft: boolean): Promise<PullRequest> =>
    inTauri ? call("pr_create", { title, body, head, base, draft }) : mock.prCreate(title, head, base, draft),
  /** Delete several local branches in one undoable step */
  branchesDelete: (names: string[]): Promise<Written<number>> => (inTauri ? call("branches_delete", { names }) : mock.slow(names.length)),

  // Submodules and Git LFS
  submoduleList: (): Promise<Submodule[]> => (inTauri ? call("submodule_list") : mock.submoduleList()),
  /** Check out the recorded commits (initializing when needed); all when paths is empty. Network operation: taskId for progress and cancelling */
  submoduleUpdate: (taskId: string, paths: string[]): Promise<Written<null>> => (inTauri ? call("submodule_update", { taskId, paths }) : mock.slow(null)),
  lfsInstalled: (): Promise<boolean> => (inTauri ? call("lfs_installed") : Promise.resolve(false)),
  /** Download the LFS contents of the current checkout (git lfs pull) */
  lfsPull: (taskId: string): Promise<Written<null>> => (inTauri ? call("lfs_pull", { taskId }) : mock.slow(null)),
  /** The window title (repository and branch) */
  windowSetTitle: (title: string): Promise<void> => (inTauri ? call("window_set_title", { title }) : Promise.resolve()),
  /** A system notification */
  notify: (title: string, body: string): Promise<void> => (inTauri ? call("notify", { title, body }) : Promise.resolve()),
  /** Move every untracked file to the trash (undoable) */
  untrackedDeleteAll: (): Promise<Written<string[]>> => (inTauri ? call("untracked_delete_all") : mock.slow([])),
  /** Create a branch where a stash was made and bring the stash back there */
  stashBranch: (index: number, name: string): Promise<Written<null>> => (inTauri ? call("stash_branch", { index, name }) : mock.slow(null)),
  /** Open a repository in a new window (a separate Strand process) */
  openNewWindow: (path: string): Promise<void> => (inTauri ? call("open_new_window", { path }) : Promise.resolve(void window.open(location.href, "_blank"))),
  /** Close the window (⌘W with no file tab shown) */
  windowClose: (): Promise<void> => (inTauri ? call("window_close") : Promise.resolve()),

  // Remote operations (spec §7). taskId is generated by the frontend for progress events and cancelling
  /** quiet: background auto-fetch; when a password is needed it fails without a prompt (spec §7.5) */
  /** mainOnly: only the current branch's upstream remote (before a pull) */
  remoteFetch: (taskId: string, quiet = false, mainOnly = false): Promise<Written<FetchResult>> =>
    inTauri ? call("remote_fetch", { taskId, quiet, mainOnly }) : mock.slow({ behind: 1, incoming: 1 }),
  /** fetched: just fetched and showed the pull summary panel, so don't fetch again (spec §7.2) */
  remotePull: (taskId: string, mode: PullMode, fetched = false): Promise<Written<PullResult>> =>
    inTauri ? call("remote_pull", { taskId, mode, fetched }) : mock.slow<PullResult>({ outcome: "fast_forward", incoming: 3, upstream: "origin/feature/commit-graph", to: "e1b07c4".padEnd(40, "0"), files: 5, added: 120, deleted: 31 }),
  remotePullPreview: (mode: PullMode): Promise<PullPreview> => (inTauri ? call("remote_pull_preview", { mode }) : mock.pullPreview(mode)),
  /** With to set, a "push up to here" preview */
  tagPush: (taskId: string, name: string): Promise<Written<null>> => (inTauri ? call("tag_push", { taskId, name }) : mock.tagPush(name)),
  /** Answer auth_required; secret null means cancel */
  consoleTail: (limit?: number): Promise<ConsoleEntry[]> => (inTauri ? call("console_tail", { limit }) : mock.consoleTail()),
  consoleClear: (): Promise<null> => (inTauri ? call("console_clear") : mock.consoleClear()),
  authReply: (requestId: string, secret: string | null): Promise<null> => (inTauri ? call("auth_reply", { requestId, secret }) : Promise.resolve(null)),
  remotePushPreview: (to: string | null = null, remote: string | null = null): Promise<PushPreview> =>
    inTauri ? call("remote_push_preview", { to, remote }) : mock.pushPreview(to, remote),
  remoteList: (): Promise<RemoteInfo[]> => (inTauri ? call("remote_list") : mock.remoteList()),
  remoteAdd: (name: string, url: string): Promise<Written<null>> => (inTauri ? call("remote_add", { name, url }) : mock.remoteEdit(() => mock.remoteAddMock(name, url))),
  remoteRemove: (name: string): Promise<Written<null>> => (inTauri ? call("remote_remove", { name }) : mock.remoteEdit(() => mock.remoteRemoveMock(name))),
  remoteRename: (name: string, newName: string): Promise<Written<null>> =>
    inTauri ? call("remote_rename", { name, newName }) : mock.remoteEdit(() => mock.remoteRenameMock(name, newName)),
  remoteSetUrl: (name: string, url: string): Promise<Written<null>> => (inTauri ? call("remote_set_url", { name, url }) : mock.remoteEdit(() => mock.remoteSetUrlMock(name, url))),
  remotePush: (taskId: string, force: boolean, tags: boolean, to: string | null = null, remote: string | null = null): Promise<Written<null>> =>
    inTauri ? call("remote_push", { taskId, force, tags, to, remote }) : mock.slow(null),
  // Worktrees (spec §6.6) and cloning
  worktreeAdd: (path: string, branch: string, newBranch: boolean, base: string | null): Promise<Written<null>> =>
    inTauri ? call("worktree_add", { path, branch, newBranch, base }) : mock.worktreeAdd(path, branch, newBranch),
  /** With uncommitted changes returns WORKTREE_CONFLICT unless force */
  worktreeRemove: (path: string, force: boolean): Promise<Written<null>> =>
    inTauri ? call("worktree_remove", { path, force }) : mock.worktreeRemove(path, force),
  /** Clone into dest (full path); progress goes through task_progress */
  /** sparse: download contents when needed and check out only the root's files (folders chosen afterwards) */
  repoClone: (taskId: string, url: string, dest: string, sparse = false): Promise<string> =>
    inTauri ? call("repo_clone", { taskId, url, dest, sparse }) : mock.slow(dest).then((w) => w.result),
  fileTextconv: (path: string, rev: string | null): Promise<Textconv> => (inTauri ? call("file_textconv", { path, rev }) : mock.fileTextconv(path, rev)),
  previewPlugins: (): Promise<PreviewPlugin[]> => (inTauri ? call("preview_plugins") : mock.previewPlugins()),
  previewPluginSample: (): Promise<PreviewPlugin> => (inTauri ? call("preview_plugin_sample") : mock.previewPluginSample()),
  previewPluginsOpen: (): Promise<void> => (inTauri ? call("preview_plugins_open") : mock.previewPluginsOpen()),
  sparseState: (): Promise<SparseState> => (inTauri ? call("sparse_state") : mock.sparseState()),
  sparseDirs: (): Promise<DirEntry[]> => (inTauri ? call("sparse_dirs") : mock.sparseDirs()),
  /** Check out only these folders; an empty list checks out everything again. WORKTREE_CONFLICT lists changed files left out */
  sparseSet: (dirs: string[]): Promise<SparseState> => (inTauri ? call("sparse_set", { dirs }) : mock.sparseSet(dirs)),
  taskCancel: (taskId: string): Promise<void> => (inTauri ? call("task_cancel", { taskId }) : Promise.resolve()),

  // Format and check before committing (spec §4.4, §4.6). Settings live in the repository's Git config
  checksConfig: (): Promise<ChecksInfo> => (inTauri ? call("checks_config_get") : mock.checksConfig()),
  checksConfigSet: (config: ChecksConfig): Promise<ChecksInfo> => (inTauri ? call("checks_config_set", { config }) : mock.checksConfigSet(config)),
  /** Run a format or check; files are the files being committed. taskCancel cancels it */
  checksRun: (taskId: string, kind: CheckKind, files: string[]): Promise<CheckRun> =>
    inTauri ? call("checks_run", { taskId, kind, files }) : mock.checksRun(kind, files),

  // Conflict resolution (spec §8). Marks are kept in the frontend and passed in all at once when applying a file
  mergeSession: (): Promise<MergeSession | null> => (inTauri ? call("merge_session") : mock.mergeSession()),
  mergeApplyFile: (path: string, marks: Record<string, ChangeMark>): Promise<Written<null>> =>
    inTauri ? call("merge_apply_file", { path, marks }) : mock.mergeApplyFile(path, marks),
  mergeTakeFile: (path: string, side: Side): Promise<Written<null>> =>
    inTauri ? call("merge_take_file", { path, side }) : mock.mergeTakeFile(path),
  /** The rebaseable range; the maximum range when from is empty */
  rebaseRange: (from: string | null = null): Promise<RebaseRange> => (inTauri ? call("rebase_range", { from }) : mock.rebaseRange(from)),
  /** steps are in the new order, oldest first, covering one contiguous stretch from some commit to the latest */
  rebaseApply: (steps: RebaseStep[]): Promise<Written<RebaseResult>> => (inTauri ? call("rebase_apply", { steps }) : mock.rebaseApply(steps)),
  /** Fixup (empty message) or Squash Into: fold the checked changes into this commit */
  commitFixup: (id: string, selection: Selection, message: string | null = null): Promise<Written<null>> =>
    inTauri ? call("commit_fixup", { id, selection, message }) : mock.commitOp(message ? "Squash Into" : "Fixup"),
  /** Discard these files' changes (added files are deleted); can be undone */
  changesDiscard: (paths: string[]): Promise<Written<null>> => (inTauri ? call("changes_discard", { paths }) : mock.changesDiscard(paths)),
  lineRollbacks: (path: string): Promise<LineRollbackPlan | null> => (inTauri ? call("line_rollbacks", { path }) : Promise.resolve(null)),
  rollbackLine: (repo: string, path: string, stamp: string, index: number): Promise<Written<string>> => call("rollback_line", { repo, path, stamp, index }),
  untrackedAdd: (path: string): Promise<Written<null>> => (inTauri ? call("untracked_add", { path }) : mock.untracked("add", path)),
  untrackedIgnore: (path: string): Promise<Written<null>> => (inTauri ? call("untracked_ignore", { path }) : mock.untracked("ignore", path)),
  /** Move to the system Trash */
  untrackedDelete: (path: string): Promise<Written<null>> => (inTauri ? call("untracked_delete", { path }) : mock.untracked("delete", path)),
  /** Blame `limit` lines starting at line offset+1; rev empty means the file in the worktree */
  blameFile: (path: string, rev: string | null, offset: number, limit: number): Promise<BlamePage> =>
    inTauri ? call("blame_file", { path, rev, offset, limit }) : mock.blameFile(path, offset, limit),
  /** Compare two commits (spec §10.3) */
  compare: (from: string, to: string): Promise<Comparison> => (inTauri ? call("compare", { from, to }) : mock.compare(from, to)),
  diffCompare: (from: string, to: string, path: string, context = 3): Promise<FileDiff> =>
    inTauri ? call("diff_compare", { from, to, path, context }) : mock.diffFile(path, context),
  patchCommit: (id: string): Promise<string> => (inTauri ? call("patch_commit", { id }) : mock.patchCommit(id)),
  patchWorktree: (selection: Selection): Promise<string> => (inTauri ? call("patch_worktree", { selection }) : mock.patchWorktree(selection)),
  /** Write text to the path chosen in the save dialog */
  fileReadText: (path: string): Promise<string> => (inTauri ? call("file_read_text", { path }) : Promise.resolve(mock.SAMPLE_PATCH)),
  bisectStatus: (): Promise<BisectStatus> => (inTauri ? call("bisect_status") : mock.bisectStatus()),
  bisectMark: (mark: BisectMark, rev: string | null = null): Promise<Written<BisectStatus>> => (inTauri ? call("bisect_mark", { mark, rev }) : mock.bisectMark(mark, rev)),
  bisectReset: (): Promise<Written<null>> => (inTauri ? call("bisect_reset") : mock.bisectReset()),
  reflogRefs: (): Promise<string[]> => (inTauri ? call("reflog_refs") : Promise.resolve(["HEAD", "main", "feature/commit-graph"])),
  reflog: (name: string): Promise<ReflogEntry[]> => (inTauri ? call("reflog", { name }) : mock.reflog(name)),
  patchPreview: (text: string): Promise<PatchPreview> => (inTauri ? call("patch_preview", { text }) : mock.patchPreview(text)),
  patchApply: (text: string, commit: boolean): Promise<Written<number>> =>
    inTauri ? call("patch_apply", { text, commit }) : mock.patchApply(text, commit),
  fileSave: (path: string, text: string): Promise<null> => (inTauri ? call("file_save", { path, text }) : Promise.resolve(null)),
  commitTree: (id: string): Promise<string[]> => (inTauri ? call("commit_tree", { id }) : mock.commitTree()),
  // Project files and file change chains
  projectFiles: (): Promise<string[]> => (inTauri ? call("project_files") : mock.projectFiles()),
  /** Worktree content when rev is empty */
  saveWorktreeFile: (path: string, text: string, expected: string): Promise<null> =>
    inTauri ? call("save_worktree_file", { path, text, expected }) : mock.saveWorktreeFile(path, text, expected),
  pasteMarkdownImage: (repo: string, document: string, bytes: ArrayBuffer, mime: string): Promise<string> =>
    inTauri ? call("paste_markdown_image", bytes, {
      headers: { "x-strand-repo": encodeURIComponent(repo), "x-strand-document": encodeURIComponent(document) },
    }) : mock.pasteMarkdownImage(document, bytes, mime),
  fileText: (path: string, rev: string | null = null): Promise<FileText> => (inTauri ? call("file_text", { path, rev }) : mock.fileText(path, rev)),
  fileHistory: (path: string): Promise<FileHistory> => (inTauri ? call("file_history", { path }) : mock.fileHistory(path)),
  /** When searching by changes, the files in this commit whose changed lines match */
  commitChangeMatches: (id: string, text: string, regex: boolean, caseSensitive: boolean): Promise<ChangeMatch[]> =>
    inTauri ? call("commit_change_matches", { id, text, regex, caseSensitive }) : mock.commitChangeMatches(),
  /** Full-text search of project files; rev empty means the worktree */
  projectSearch: (text: string, regex: boolean, caseSensitive: boolean, rev: string | null): Promise<ProjectSearch> =>
    inTauri ? call("project_search", { text, regex, caseSensitive, rev }) : mock.projectSearch(text, regex, caseSensitive, rev),
  /** from empty means added (the old side doesn't have it), to empty means the worktree */
  fileDiffVersions: (from: string | null, fromPath: string, to: string | null, toPath: string, context = 3): Promise<FileDiff> =>
    inTauri ? call("file_diff_versions", { from, fromPath, to, toPath, context }) : mock.fileDiffVersions(from, fromPath, to, toPath),
  stashList: (): Promise<StashEntry[]> => (inTauri ? call("stash_list") : mock.stashList()),
  stashFiles: (index: number): Promise<FileChange[]> => (inTauri ? call("stash_files", { index }) : mock.stashFiles(index)),
  /** includeUntracked: also stash untracked files (git stash -u) */
  stashPush: (message: string | null = null, includeUntracked = false): Promise<Written<null>> =>
    inTauri ? call("stash_push", { message, includeUntracked }) : mock.stashPush(),
  /** Restore a stash: drop true restores and deletes, otherwise restores and keeps; returns CONFLICTS on conflicts and the repository enters "restore in progress" */
  stashApply: (index: number, drop: boolean): Promise<Written<null>> =>
    inTauri ? call("stash_apply", { index, drop }) : mock.stashApply(index, drop),
  stashDrop: (index: number): Promise<Written<null>> => (inTauri ? call("stash_drop", { index }) : mock.stashDrop(index)),
  shelfList: (): Promise<ShelfEntry[]> => (inTauri ? call("shelf_list") : mock.shelfList()),
  shelfSave: (name: string, paths: string[]): Promise<Written<ShelfEntry>> =>
    inTauri ? call("shelf_save", { name, paths }) : mock.shelfSave(name, paths),
  /** Restore a shelf entry; with paths, only these files are restored and the rest stay on the shelf (spec §4.9) */
  shelfRestore: (id: number, paths: string[] | null = null): Promise<Written<null>> =>
    inTauri ? call("shelf_restore", { id, paths }) : mock.shelfRestore(id, paths),
  shelfDelete: (id: number): Promise<Written<null>> => (inTauri ? call("shelf_delete", { id }) : mock.shelfDelete(id)),
  /** Files and changed line counts in a shelf entry (read from the saved patch) */
  shelfFiles: (id: number): Promise<FileChange[]> => (inTauri ? call("shelf_files", { id }) : mock.shelfFiles(id)),
  /** A file's diff in a shelf entry */
  /** With context, show the whole file (original content taken from the commit at shelve time) */
  shelfDiff: (id: number, path: string, context?: number): Promise<FileDiff> => (inTauri ? call("shelf_diff", { id, path, context }) : mock.diffFile(path, context)),
  /** Text on the system clipboard (read by the shell in the desktop app) */
  clipboardText: (): Promise<string> => (inTauri ? call("clipboard_text") : navigator.clipboard.readText()),
  /** Whole-file diff of two texts (compare any two files, compare with clipboard); name is used to detect the language */
  textDiff: (left: string, right: string, name: string): Promise<FileDiff> => (inTauri ? call("text_diff", { left, right, name }) : mock.textDiff(left, right, name)),
  shelfRename: (id: number, name: string): Promise<null> => (inTauri ? call("shelf_rename", { id, name }) : mock.shelfRename(id, name)),
  oplogList: (limit = 50): Promise<OpList> => (inTauri ? call("oplog_list", { limit }) : mock.oplogList(limit)),
  /** Undo the latest step, or up to and including toId; crossing pushed steps needs confirmPushed */
  oplogUndo: (toId: number | null = null, confirmPushed = false): Promise<Written<OpInfo[]>> =>
    inTauri ? call("oplog_undo", { toId, confirmPushed }) : mock.oplogUndo(toId, confirmPushed),
  oplogRedo: (): Promise<Written<OpInfo[]>> => (inTauri ? call("oplog_redo") : mock.oplogRedo()),
  mergeFinish: (): Promise<Written<FinishResult>> => (inTauri ? call("merge_finish") : mock.mergeFinish()),
  mergeSkip: (): Promise<Written<FinishResult>> => (inTauri ? call("merge_skip") : mock.mergeFinish()),
};

/** Subscribe to update download progress */
export function onUpdateProgress(cb: (p: UpdateProgress) => void): () => void {
  if (!inTauri) return mock.onUpdateProgress(cb);
  let off: (() => void) | null = null;
  let cancelled = false;
  import("@tauri-apps/api/event").then(({ listen }) =>
    listen<UpdateProgress>("update_progress", (e) => cb(e.payload)).then((u) => {
      if (cancelled) u();
      else off = u;
    }),
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

/** Subscribe to progress events of long tasks */
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

/** Credentials needed (spec §7.5) */
export interface AuthRequest {
  request_id: string;
  /** The prompt text from git or ssh */
  prompt: string;
  /** Is a password or passphrase (the input box masks it) */
  secret: boolean;
}

/** Subscribe to auth_required (input needed) and auth_closed (operation stopped, close the input box) */
export function onAuthEvents(onAsk: (r: AuthRequest) => void, onClosed: (id: string) => void): () => void {
  if (!inTauri) {
    // Browser preview: during development, simulate a request from the console with __strandAuth({...})
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

/** Subscribe to new console entries (spec §5.8) */
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

/** Open a URL in the system browser */
export async function openUrl(url: string) {
  if (!inTauri) return void window.open(url, "_blank", "noopener");
  const { openUrl: open } = await import("@tauri-apps/plugin-opener");
  await open(url);
}

/** Reveal this folder in the system file manager */
export async function revealPath(path: string) {
  if (!inTauri) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** Subscribe to the core layer's repo_changed event; returns an unsubscribe function (spec §2.2) */
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

/** Show the system folder picker and return the path; null when cancelled */
export async function pickFolder(title?: string): Promise<string | null> {
  if (!inTauri) return title ? "/示例" : "/示例/strand-app";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: false, title: title ?? t("打开仓库") });
  return typeof r === "string" ? r : null;
}

/** This many diff context lines means the whole file */
export const FULL = 1_000_000;

/** Ask for a whole-file diff; when the file is too big and truncated, fall back to 3 lines around changes (spec §10.1) */
export function wholeFile(fetch: (context: number) => Promise<FileDiff>): Promise<FileDiff> {
  return fetch(FULL).then((d) => (d.truncated ? fetch(3) : d));
}
