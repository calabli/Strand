// Sample data for the browser preview. Only used when running without Tauri.

import { authorRule } from "./authorRule";
import type { RebasePlan, CheckKind, CheckRun, ChecksConfig, ChecksInfo, Commit, GitInfo, GraphRow, LogAuthor, LogFilter, LogPage, LogSort, OpInfo, OpKind, OpList, RepoState, Submodule, MergedBranch, Hosting, PullRequest, Checks, Contributions, RepoSize } from "./types";

const delay = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));

export const gitCheck = () => delay<GitInfo>({ found: true, version: "2.55.0", ok: true, min_version: "2.30" });

/** Add ?conflict to the URL in the browser preview to see the conflict resolution view */
const conflictDemo = typeof location !== "undefined" && location.search.includes("conflict");

const state: RepoState = {
  path: "/示例/strand-app",
  name: "strand-app",
  head: { kind: "branch", branch: "feature/commit-graph", commit: "a41f9c2".padEnd(40, "0") },
  state: conflictDemo ? "merging" : "normal",
  lfs: true,
  submodules: true,
};

export const repoOpen = (_path: string) => delay(state);
export const repoState = () => delay(state);

const titles = [
  "图谱：泳道计算移到后台线程",
  "图谱：虚拟滚动支持 10 万条提交",
  "合并分支 fix/diff-ime",
  "修复：diff 视图中输入法候选框错位",
  "图谱：读取 commit-graph 文件加速首屏",
  "修复：行级暂存丢失换行符",
  "发布 0.4.0",
  "侧边栏：仓库分组与搜索",
  "状态监听改为增量刷新",
  "暂存架：支持命名和预览",
];
const authors = ["林夏", "周屿", "陈默"];
const emails = ["linxia@example.com", "zhouyu@example.com", "chenmo@example.com"];
const TOTAL = 2000;
const now = Math.floor(Date.now() / 1000);

function commitAt(i: number): Commit {
  const id = (i * 2654435761 >>> 0).toString(16).padStart(8, "0").repeat(5);
  const refs: Commit["refs"] = [];
  if (i === 0) refs.push({ kind: "branch", name: "feature/commit-graph" });
  if (i === 2) refs.push({ kind: "branch", name: "main" }, { kind: "remote", name: "origin/main" });
  if (i === 6) refs.push({ kind: "tag", name: "v0.4.0" });
  return {
    id,
    parents: [],
    title: titles[i % titles.length],
    body: "",
    author: { name: authors[i % 3], email: emails[i % 3] },
    time: now - i * 3600 * 5,
    refs,
    is_merge: i % titles.length === 2,
    unpushed: i < 3,
  };
}

// A simple graph alternating two lanes: rows 3 and 4 of every 10 are in lane 1.
// Also, every 40 rows there's a collapsed long edge in lane 2: starts at row 5, capped at row 9, rejoins at row 30, merges into lane 0 at row 34
function graphAt(i: number): GraphRow {
  const g = baseGraph(i);
  const k = i % 40;
  if (i >= TOTAL - 40) return g;
  if (k === 5) return { lane: 2, edges: [...g.edges, { from_lane: 2, to_lane: 2, kind: "straight" }] };
  if (k > 5 && k < 9) g.edges.push({ from_lane: 2, to_lane: 2, kind: "straight" });
  if (k === 9) g.edges.push({ from_lane: 2, to_lane: 2, kind: "cut_out", target: i + 26 });
  if (k === 30) g.edges.push({ from_lane: 2, to_lane: 2, kind: "cut_in", target: i - 25 });
  if (k > 30 && k < 34) g.edges.push({ from_lane: 2, to_lane: 2, kind: "straight" });
  if (k === 34) g.edges.push({ from_lane: 2, to_lane: 0, kind: "fork" });
  return g;
}

function baseGraph(i: number): GraphRow {
  const k = i % 10;
  if (k === 2) return { lane: 0, edges: [{ from_lane: 0, to_lane: 0, kind: "straight" }, { from_lane: 0, to_lane: 1, kind: "merge" }] };
  if (k === 3) return { lane: 1, edges: [{ from_lane: 0, to_lane: 0, kind: "straight" }, { from_lane: 1, to_lane: 1, kind: "straight" }] };
  if (k === 4) return { lane: 1, edges: [{ from_lane: 0, to_lane: 0, kind: "straight" }, { from_lane: 1, to_lane: 0, kind: "fork" }] };
  return { lane: 0, edges: i === TOTAL - 1 ? [] : [{ from_lane: 0, to_lane: 0, kind: "straight" }] };
}

const isEmpty = (f: LogFilter) => !f.text && !f.branch && !f.author && !f.authors?.length && !f.author_match?.text.trim() && f.since == null && f.until == null && !f.path && !f.first_parent && !f.no_merges;


/** Filtering on sample data: branches approximated as "from this row down", paths as changed every 3 commits */
function filtered(f: LogFilter, sort: LogSort): number[] | null {
  if (isEmpty(f) && sort === "topo") return null;
  let re: RegExp | null = null;
  if (f.text) {
    try {
      re = new RegExp(f.regex ? f.text : f.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), f.case_sensitive ? "" : "i");
    } catch {
      throw { code: "INVALID_REGEX", message: "正则表达式写得不对" };
    }
  }
  const rule = authorRule(f.author_match);
  const picked = new Set([...(f.authors ?? []), ...(f.author ? [f.author] : [])].map((e) => e.toLowerCase()));
  const byAuthor = picked.size > 0 || !!rule;
  const tip = f.branch ? branchRow(f.branch) : 0;
  const out: number[] = [];
  if (tip == null) return out;
  for (let i = tip; i < TOTAL; i++) {
    const c = commitAt(i);
    if (byAuthor && !picked.has(c.author.email.toLowerCase()) && !rule?.(c.author.name, c.author.email)) continue;
    if (f.since != null && c.time < f.since) continue;
    if (f.no_merges && c.parents.length > 1) continue;
    if (f.first_parent && i % 10 >= 3 && i % 10 <= 4) continue;
    if (f.until != null && c.time >= f.until) continue;
    if (f.path && i % 3 !== 0) continue;
    // Sample data has no file contents: when searching changes, pretend every 6th commit changed the text
    if (re && f.search_in === "changes") {
      if (i % 6 !== 0) continue;
    } else if (re && !re.test(c.title) && !(f.text!.length >= 4 && !f.regex && c.id.startsWith(f.text!.toLowerCase()))) continue;
    out.push(i);
  }
  return out;
}

function branchRow(name: string): number | null {
  if (name === "feature/commit-graph" || name === "HEAD") return 0;
  if (name === "main" || name === "origin/main") return 2;
  return null;
}

export function logQuery(offset: number, limit: number, filter: LogFilter = {}, sort: LogSort = "topo"): Promise<LogPage> {
  let rows: number[] | null;
  try {
    rows = filtered(filter, sort);
  } catch (e) {
    return new Promise((_, rej) => setTimeout(() => rej(e), 60));
  }
  if (!rows) {
    const end = Math.min(TOTAL, offset + Math.min(limit, 500));
    const idx = Array.from({ length: Math.max(0, end - offset) }, (_, j) => offset + j);
    // Collapsing linear branches: in the sample, 2 commits are folded under the 3rd of every 10
    return delay({ offset, rows: idx.map(commitAt), graph: idx.map(graphAt), total: TOTAL, lanes: 3, folded: filter.collapse_linear ? idx.map((i) => (i % 10 === 2 ? 2 : 0)) : undefined });
  }
  // On a real repository path filtering is fed by a background git rev-list as it runs (spec §15): the sample returns only part for the first 3 seconds, marked partial
  let partial = false;
  if (filter.path) {
    const key = `${filter.path}|${filter.case_sensitive ?? false}`;
    if (pathStarted.key !== key) pathStarted = { key, at: Date.now() };
    const share = Math.min(1, (Date.now() - pathStarted.at) / 3000);
    if (share < 1) {
      partial = true;
      rows = rows.slice(0, Math.floor(rows.length * share));
    }
  }
  const page = rows.slice(offset, offset + Math.min(limit, 500));
  const total = rows.length;
  return delay({ offset, rows: page.map(commitAt), graph: [], total, lanes: 0, partial });
}
let pathStarted = { key: "", at: 0 };

export const logAuthors = () =>
  delay<LogAuthor[]>(authors.map((name, i) => ({ name, email: emails[i], count: Math.ceil((TOTAL - i) / 3) })));

// ---------- Sample data for the worktree and diffs ----------

import type { BlamePage, CommitCaps, CommitCreated, CommitDetail, FileChange, FileDiff, RebaseRange, RebaseResult, RebaseStep, Selection, ShelfEntry, StashEntry, WorktreeStatus } from "./types";

let mockStatus: WorktreeStatus = {
  changes: [
    { path: "src/graph/layout.rs", status: "M", added: 10, deleted: 3, binary: false },
    { path: "src/graph/mod.rs", status: "M", added: 2, deleted: 0, binary: false },
    { path: "src/ui/graph_view.rs", status: "M", added: 14, deleted: 6, binary: false },
    { path: "benches/graph_layout.rs", status: "A", added: 41, deleted: 0, binary: false },
  ],
  untracked: ["notes/todo.md", "scratch/tmp.log"],
};

export const statusGet = () => delay(structuredClone(mockStatus));

export function diffFile(path: string, context = 3): Promise<FileDiff> {
  if (/\.(png|jpe?g|gif|webp)$/.test(path)) return delay({ path, binary: true, truncated: false, hunks: [] });
  if (context > 1000) return delay(fullDiff(path));
  return delay({
    path,
    binary: false,
    truncated: false,
    hunks: [
      {
        title: "impl LaneLayout · 第 41 行起",
        old_start: 41,
        new_start: 41,
        lines: [
          { kind: "context", old_no: 41, new_no: 41, text: "    pub fn assign(&mut self, commits: &[Commit]) {" },
          { kind: "del", old_no: 42, text: "        for c in commits {" },
          { kind: "del", old_no: 43, text: "            self.place(c);" },
          { kind: "del", old_no: 44, text: "        }" },
          { kind: "add", new_no: 42, text: "        let batch = commits.to_vec();" },
          { kind: "add", new_no: 43, text: "        let (tx, rx) = channel();" },
          { kind: "add", new_no: 44, text: "        self.pool.spawn(move || tx.send(compute_lanes(&batch)).ok());" },
          { kind: "add", new_no: 45, text: "        self.pending = Some(rx);" },
          { kind: "context", old_no: 45, new_no: 46, text: "    }" },
        ],
      },
      {
        title: "fn place · 第 88 行起",
        old_start: 88,
        new_start: 89,
        lines: [
          { kind: "context", old_no: 88, new_no: 89, text: "    fn place(&mut self, c: &Commit) {" },
          { kind: "add", new_no: 90, text: "        if self.cancelled() { return; }" },
          { kind: "context", old_no: 89, new_no: 91, text: "        let lane = self.free_lane(c);" },
        ],
      },
    ],
  });
}

export function commitCreate(_message: string, sel: Selection): Promise<CommitCreated> {
  const picked = new Set(sel.files.map((f) => f.path));
  mockStatus = { ...mockStatus, changes: mockStatus.changes.filter((c) => !picked.has(c.path)) };
  const title = _message.split("\n")[0];
  return delay({ id: "f".repeat(40), state, op: record(`提交“${title}”`, "commit") });
}

/** Sample availability: the first 3 commits are unpushed, number 0 is the latest; number 5 counts as not in the current branch's history */
function capsAt(i: number): CommitCaps {
  const y = { ok: true };
  const no = (why: string) => ({ ok: false, why });
  const inHistory = i !== 5;
  return {
    cherry_pick: inHistory ? no("这个提交已经在当前分支的历史里") : y,
    checkout: y,
    reset: i === 0 ? no("这就是当前分支的最新提交") : i <= 3 ? y : no("它之后有已经推送的提交"),
    revert: commitAt(i).is_merge ? no("合并提交不能直接还原") : y,
    undo: i === 0 ? y : no("只能对当前分支的最新提交这样做"),
    reword: i < 3 ? y : no("这个提交已经推送"),
    drop: i < 2 ? y : no(i < 3 ? "只能丢弃最近一串未推送、非合并的提交" : "这个提交已经推送"),
    rebase_from: i > 0 && i < 6 ? y : no(i === 0 ? "从这里开始只有它一个提交" : "这个提交不在可以整理的范围里"),
    fixup: i < 3 ? y : no("这个提交或它之后的提交已经推送"),
    compare_local: i === 0 ? no("这就是当前分支的最新提交") : y,
    push_to: i < 2 ? y : no("这个提交已经推送"),
    parent: i + 1 < TOTAL ? H(i + 1) : undefined,
    child: i > 0 ? H(i - 1) : undefined,
    web_url: `https://github.com/example/strand-app/commit/${H(i)}`,
  };
}
const rowOf = (id: string) => {
  for (let i = 0; i < TOTAL; i++) if (H(i) === id) return i;
  return 0;
};
export const commitCaps = (id: string) => delay(capsAt(rowOf(id)));
export const commitOp = (label: string) => ok(null, label, "commit");

export function commitDetail(id: string): Promise<CommitDetail> {
  return logQuery(0, 500).then((p) => ({
    caps: capsAt(rowOf(id)),
    commit: p.rows.find((c) => c.id === id) ?? p.rows[0],
    files: [
      ...(mockStatus.changes.length ? mockStatus.changes.slice(0, 3) : [{ path: "src/lib.rs", status: "M" as const, added: 3, deleted: 1, binary: false }]),
      { path: "docs/images/graph.png", status: "M" as const, added: 0, deleted: 0, binary: true },
    ],
  }));
}

// ---------- Sample data for branches and tags ----------

import type { RefsList, Written } from "./types";

const H = (i: number) => commitAt(i).id;
let refs: RefsList = {
  branches: [
    { name: "feature/commit-graph", head: H(0), upstream: "origin/feature/commit-graph", ahead: 2, behind: 1, is_current: true, merged: true, needs_force: false },
    { name: "fix/diff-ime", head: H(3), upstream: "origin/fix/diff-ime", ahead: 2, behind: 2, is_current: false, merged: true, needs_force: true },
    { name: "main", head: H(2), upstream: "origin/main", ahead: 0, behind: 0, is_current: false, merged: true, needs_force: false, rebase_block: "feature/commit-graph 已经在 main 之上" },
    { name: "spike/gpui", head: H(40), ahead: 0, behind: 0, is_current: false, merged: false, needs_force: false, worktree: "/示例/strand-app-spike-gpui" },
  ],
  remotes: [
    { name: "origin/feature/commit-graph", remote: "origin", head: H(1) },
    { name: "origin/main", remote: "origin", head: H(2), rebase_block: "feature/commit-graph 已经在 origin/main 之上" },
    { name: "origin/release/0.4", remote: "origin", head: H(6) },
  ],
  tags: [{ name: "v0.4.0", at: H(6), unpushed: false }, { name: "v0.5.0-rc1", at: H(1), unpushed: true }],
  head: state.head,
  worktrees: [
    { path: "/示例/strand-app", branch: "feature/commit-graph", head: H(0), is_main: true, is_current: true, locked: false, prunable: false },
    { path: "/示例/strand-app-spike-gpui", branch: "spike/gpui", head: H(40), is_main: false, is_current: false, locked: false, prunable: false },
  ],
};

export function worktreeAdd(path: string, branch: string, created: boolean) {
  if (created) refs = { ...refs, branches: [...refs.branches, { name: branch, head: H(0), ahead: 0, behind: 0, is_current: false, merged: true, needs_force: false }].sort((a, b) => a.name.localeCompare(b.name)) };
  refs = {
    ...refs,
    branches: refs.branches.map((b) => (b.name === branch ? { ...b, worktree: path } : b)),
    worktrees: [...refs.worktrees, { path, branch, head: H(0), is_main: false, is_current: false, locked: false, prunable: false }],
  };
  return ok(null, `新建工作目录 ${path.split("/").pop()}（${branch}）`);
}
export function worktreeRemove(path: string, force: boolean) {
  // Sample: the spike/gpui worktree has changes
  if (!force && path.endsWith("spike-gpui"))
    return Promise.reject({ code: "WORKTREE_CONFLICT", message: "这个工作目录里还有 3 个文件的改动没有提交，移除后会丢失", detail: { files: 3 } });
  refs = { ...refs, worktrees: refs.worktrees.filter((w) => w.path !== path), branches: refs.branches.map((b) => (b.worktree === path ? { ...b, worktree: undefined } : b)) };
  return ok(null, `移除工作目录 ${path.split("/").pop()}`);
}

export const ok = <T,>(result: T, label?: string, kind: OpKind = "branch") =>
  delay<Written<T>>({ result, state: { ...state, head: refs.head }, op: label ? record(label, kind) : undefined });

// ---------- Sample op log data: only recorded; undo and redo don't really change the sample data ----------

let opSeq = 4;
let ops: OpInfo[] = [
  { id: 4, label: "推送 feature/commit-graph", kind: "push", time: now - 600, undoable: false, undone: false },
  { id: 3, label: "提交“图谱：泳道计算移到后台线程”", kind: "commit", time: now - 1200, undoable: true, undone: false },
  { id: 2, label: "切换到 feature/commit-graph", kind: "switch", time: now - 3600, undoable: true, undone: false },
  { id: 1, label: "新建分支 feature/commit-graph", kind: "branch", time: now - 3700, undoable: true, undone: false },
];
let redoStack: number[][] = [];

function record(label: string, kind: OpKind): OpInfo {
  ops = ops.filter((o) => !o.undone);
  redoStack = [];
  const op = { id: ++opSeq, label, kind, time: Math.floor(Date.now() / 1000), undoable: true, undone: false };
  ops = [op, ...ops];
  return op;
}

export const oplogList = (limit: number) => {
  const live = ops.filter((o) => !o.undone && o.kind !== "push");
  return delay<OpList>({ entries: ops.slice(0, limit), can_undo: !!live[0]?.undoable, can_redo: redoStack.length > 0 });
};

export function oplogUndo(toId: number | null, confirmPushed: boolean): Promise<Written<OpInfo[]>> {
  const live = ops.filter((o) => !o.undone);
  const steps = toId == null ? live.filter((o) => o.kind !== "push").slice(0, 1) : live.filter((o) => o.id >= toId && o.kind !== "push");
  const last = steps[steps.length - 1];
  if (!last) return Promise.reject({ code: "NOT_FOUND", message: "没有可以撤销的操作" });
  const push = live.find((o) => o.id > last.id && o.kind === "push");
  if (push && !confirmPushed) return Promise.reject({ code: "ALREADY_PUSHED", message: "这一步已经推送，撤销后需要强制推送才能让远程一致", detail: { push: push.label } });
  steps.forEach((o) => (o.undone = true));
  redoStack.push(steps.map((o) => o.id));
  return delay({ result: steps.map((o) => ({ ...o })), state: { ...state, head: refs.head } });
}

export function oplogRedo(): Promise<Written<OpInfo[]>> {
  const g = redoStack.pop();
  if (!g) return Promise.reject({ code: "NOT_FOUND", message: "没有可以重做的操作" });
  const done = ops.filter((o) => g.includes(o.id)).reverse();
  done.forEach((o) => (o.undone = false));
  return delay({ result: done.map((o) => ({ ...o })), state: { ...state, head: refs.head } });
}
export const refsList = () => delay(structuredClone(refs));
export function logLocate(rev: string, filter: LogFilter = {}, sort: LogSort = "topo") {
  const b = refs.branches.find((x) => x.name === rev) ?? refs.remotes.find((x) => x.name === rev);
  const t = refs.tags.find((x) => x.name === rev);
  const id = rev === "HEAD" ? H(0) : b?.head ?? t?.at ?? rev;
  let row: number | null = null;
  for (let i = 0; i < 2000; i++) if (H(i).startsWith(id)) { row = i; break; }
  if (row == null) return delay<number | null>(null);
  let rows: number[] | null = null;
  try {
    rows = filtered(filter, sort);
  } catch {
    return delay<number | null>(null);
  }
  if (!rows) return delay<number | null>(row);
  const k = rows.indexOf(row);
  return delay<number | null>(k < 0 ? null : k);
}
function setCurrent(name: string) {
  refs = { ...refs, branches: refs.branches.map((b) => ({ ...b, is_current: b.name === name })), head: { kind: "branch", branch: name, commit: refs.branches.find((b) => b.name === name)?.head } };
}
export function branchCreate(name: string, checkout: boolean) {
  if (refs.branches.some((b) => b.name === name)) return Promise.reject({ code: "INVALID_NAME", message: `已经有叫 ${name} 的分支了` });
  refs = { ...refs, branches: [...refs.branches, { name, head: H(0), ahead: 0, behind: 0, is_current: false, merged: true, needs_force: false }].sort((a, b) => a.name.localeCompare(b.name)) };
  if (checkout) setCurrent(name);
  return ok(null, `新建分支 ${name}`, "branch");
}
export function branchSwitch(name: string) {
  setCurrent(name);
  return ok(null, `切换到 ${name}`, "switch");
}
export function branchRename(name: string, newName: string) {
  refs = { ...refs, branches: refs.branches.map((b) => (b.name === name ? { ...b, name: newName } : b)) };
  if (refs.head.branch === name) refs.head = { ...refs.head, branch: newName };
  return ok(null, `把 ${name} 重命名为 ${newName}`, "branch");
}
export function branchDelete(name: string, force: boolean) {
  const b = refs.branches.find((x) => x.name === name);
  if (b && !b.merged && !force) return Promise.reject({ code: "INVALID_NAME", message: `分支 ${name} 上有还没合并的提交`, detail: { unmerged: true } });
  refs = { ...refs, branches: refs.branches.filter((x) => x.name !== name) };
  return ok(null, `删除分支 ${name}`, "branch");
}
export function branchCheckoutRemote(rb: string) {
  const local = rb.split("/").slice(1).join("/");
  if (!refs.branches.some((b) => b.name === local)) {
    refs = { ...refs, branches: [...refs.branches, { name: local, head: H(6), upstream: rb, ahead: 0, behind: 0, is_current: false, merged: true, needs_force: false }] };
  }
  setCurrent(local);
  return ok(local, `检出 ${rb}`, "checkout");
}
export function tagCreate(name: string, at: string) {
  refs = { ...refs, tags: [...refs.tags, { name, at, unpushed: true }] };
  return ok(null, `新建标签 ${name}`, "tag");
}
export function tagDelete(name: string) {
  refs = { ...refs, tags: refs.tags.filter((t) => t.name !== name) };
  return ok(null, `删除标签 ${name}`, "tag");
}

// ---------- Sample data for remote operations ----------

import type { PushPreview } from "./types";

/** Simulate a network operation that takes a while */
export const slow = <T,>(result: T) =>
  new Promise<Written<T>>((r) => setTimeout(() => r({ result, state: { ...state, head: refs.head } }), 1200));

export const pushPreview = (to: string | null = null, remote: string | null = null) =>
  delay<PushPreview>({
    branch: "feature/commit-graph",
    // Sample: with two or more remotes, treat it as a new branch never pushed, so a remote can be chosen
    target: `${remote ?? "origin"}/feature/commit-graph`,
    new_branch: mockRemotes.length > 1,
    remote: remote ?? "origin",
    remotes: mockRemotes.map((r) => r.name),
    commits: (to === H(1) ? [1] : [0, 1]).map((i) => ({ id: H(i), title: commitAt(i).title })),
    behind: to || mockRemotes.length > 1 ? 0 : 1,
    needs_force: false,
    to: to ?? undefined,
    left: to === H(1) ? 1 : 0,
    unpushed_tags: refs.tags.filter((t) => t.unpushed).map((t) => t.name),
    tags_unknown: false,
  });

export const tagPush = (name: string) => {
  refs = { ...refs, tags: refs.tags.map((t) => (t.name === name ? { ...t, unpushed: false } : t)) };
  return slow(null);
};

// ---------- Sample data for conflict resolution ----------

import type { ChangeMark, ConflictFile, FinishResult, MergeSession } from "./types";

const ctx = (...lines: string[]) => ({ type: "context" as const, lines });
let conflictFiles: ConflictFile[] = [
  {
    path: "src/graph/layout.rs",
    kind: "text",
    mine_change: "modified",
    theirs_change: "modified",
    segments: [
      ctx("use crate::model::Commit;", "", "pub struct LaneLayout {", "    rows: Vec<Row>,", "}", "", "impl LaneLayout {"),
      {
        type: "change",
        id: "c1",
        base: ["    pub fn assign(&mut self, commits: &[Commit]) {", "        for c in commits { self.place(c); }", "    }"],
        mine: [
          "    pub fn assign(&mut self, commits: &[Commit]) {",
          "        let batch = commits.to_vec();",
          "        self.pool.spawn(move || compute_lanes(&batch));",
          "    }",
        ],
        theirs: ["    pub fn assign(&mut self, commits: &[Commit]) {", "        for c in commits.iter().rev() { self.place(c); }", "    }"],
        mine_origin: { commit: H(3), author: "林夏", time: Math.floor(Date.now() / 1000) - 7200, title: "图谱：泳道计算移到后台线程" },
        theirs_origin: { commit: H(1), author: "周舟", time: Math.floor(Date.now() / 1000) - 86400, title: "图谱：按提交倒序分配泳道" },
      },
      ctx("", "    fn place(&mut self, c: &Commit) {", "        let lane = self.free_lane(c);"),
      { type: "change", id: "c2", base: [], mine: null, theirs: ["        if self.cancelled() { return; }"] },
      ctx("        self.rows.push(Row::new(c.id, lane));", "    }", "}"),
      { type: "change", id: "c3", base: ["// 旧注释"], mine: ["// 布局在后台线程计算"], theirs: null },
    ],
  },
  { path: "Cargo.lock", kind: "lock", mine_change: "modified", theirs_change: "modified", segments: [] },
  { path: "src/sync/old_log.rs", kind: "modify_delete", mine_change: "modified", theirs_change: "deleted", segments: [] },
  { path: "src/ui/panel.tsx", kind: "rename", mine_change: "renamed", theirs_change: "renamed", segments: [], mine_path: "src/ui/side_panel.tsx", theirs_path: "src/ui/commit_panel.tsx" },
  { path: "README.md", kind: "text", mine_change: "modified", theirs_change: "modified", segments: [], resolved: true },
];

export const mergeSession = () =>
  delay<MergeSession | null>(
    inMerge
      ? {
          kind: "merge",
          mine: { label: "feature/commit-graph", commit: H(0), title: commitAt(0).title },
          theirs: { label: "origin/feature/commit-graph", commit: H(1), title: "图谱：按范围取行" },
          files: structuredClone(conflictFiles),
        }
      : null,
  );
let inMerge = conflictDemo;
export function mergeApplyFile(path: string, marks: Record<string, ChangeMark>) {
  const f = conflictFiles.find((x) => x.path === path)!;
  const left = f.segments.filter(
    (s) => s.type === "change" && !marks[s.id]?.custom && ((s.mine && (marks[s.id]?.mine ?? "none") === "none") || (s.theirs && (marks[s.id]?.theirs ?? "none") === "none")),
  );
  if (left.length) return Promise.reject({ code: "UNMARKED_BLOCKS", message: `这个文件还有 ${left.length} 处修改块没有标记，不能应用` });
  conflictFiles = conflictFiles.filter((x) => x.path !== path);
  return ok(null);
}
export function mergeTakeFile(path: string) {
  conflictFiles = conflictFiles.filter((x) => x.path !== path);
  return ok(null);
}
export function mergeFinish() {
  const open = conflictFiles.filter((f) => !f.resolved);
  if (open.length) return Promise.reject({ code: "UNMARKED_BLOCKS", message: `还有 ${open.length} 个文件没有处理，不能完成` });
  inMerge = false;
  state.state = "normal";
  return ok<FinishResult>({ done: true });
}

// ---------- Sample data for stash and shelf ----------

let stashes: StashEntry[] = [
  { index: 0, id: "c".repeat(40), message: "WIP on feature/commit-graph: a41f9c2 图谱：泳道计算移到后台线程", time: now - 1800 },
  { index: 1, id: "d".repeat(40), message: "On main: 试验性的缓存", time: now - 86400 * 2 },
];
let shelves: ShelfEntry[] = [
  { id: 2, name: "调试日志", time: now - 3600, base: "", files: [{ path: "src/graph/debug.rs", status: "M" }, { path: "src/main.rs", status: "M" }] },
  { id: 1, name: "改动 · 1", time: now - 86400, base: "", files: [{ path: "README.md", status: "M" }] },
];
const reindex = () => (stashes = stashes.map((s, i) => ({ ...s, index: i })));

export const stashList = () => delay(structuredClone(stashes));
export const stashFiles = (_index: number) =>
  delay<FileChange[]>([
    { path: "src/graph/layout.rs", status: "M", added: 12, deleted: 3, binary: false },
    { path: "src/graph/cache.rs", status: "A", added: 40, deleted: 0, binary: false },
  ]);
export function stashPush() {
  if (!mockStatus.changes.length) return Promise.reject({ code: "NOTHING_SELECTED", message: "没有可以贮藏的改动" });
  stashes = [{ index: 0, id: Math.random().toString(16).slice(2).padEnd(40, "0"), message: `WIP on ${refs.head.branch}: 改动`, time: Math.floor(Date.now() / 1000) }, ...stashes];
  reindex();
  mockStatus = { ...mockStatus, changes: [] };
  return ok(null, "贮藏改动", "stash");
}
export function stashApply(index: number, drop: boolean) {
  const s = stashes.find((x) => x.index === index);
  if (drop) stashes = stashes.filter((x) => x.index !== index);
  reindex();
  return ok(null, `${drop ? "取回" : "应用"}贮藏“${s?.message ?? ""}”`, "stash");
}
export function stashDrop(index: number) {
  stashes = stashes.filter((x) => x.index !== index);
  reindex();
  return ok(null, "丢弃贮藏", "stash");
}
export const shelfList = () => delay(structuredClone(shelves));
export const shelfFiles = (id: number) =>
  delay<FileChange[]>((shelves.find((e) => e.id === id)?.files ?? []).map((f) => ({ ...f, added: 6, deleted: 2, binary: false })));
let shelfSeq = 2;
export function shelfSave(name: string, paths: string[]) {
  if (!paths.length) return Promise.reject({ code: "NOTHING_SELECTED", message: "至少勾选一个文件" });
  const id = ++shelfSeq;
  const files = mockStatus.changes.filter((c) => paths.includes(c.path)).map((c) => ({ path: c.path, status: c.status }));
  const e: ShelfEntry = { id, name: name.trim() || `改动 · ${id}`, time: Math.floor(Date.now() / 1000), base: "", files };
  shelves = [e, ...shelves];
  mockStatus = { ...mockStatus, changes: mockStatus.changes.filter((c) => !paths.includes(c.path)) };
  return ok(e, `搁置“${e.name}”`, "shelf");
}
export function shelfRestore(id: number, paths: string[] | null = null) {
  const e = shelves.find((x) => x.id === id);
  if (paths && e && paths.length < e.files.length) {
    shelves = shelves.map((x) => (x.id === id ? { ...x, id: ++shelfSeq, files: x.files.filter((f) => !paths.includes(f.path)) } : x));
    return ok(null, `从搁置“${e.name}”取回 ${paths.length} 个文件`, "shelf");
  }
  shelves = shelves.filter((x) => x.id !== id);
  return ok(null, `取回搁置“${e?.name ?? ""}”`, "shelf");
}
export function shelfDelete(id: number) {
  shelves = shelves.filter((x) => x.id !== id);
  return ok(null, "删除搁置", "shelf");
}
export function shelfRename(id: number, name: string) {
  shelves = shelves.map((x) => (x.id === id ? { ...x, name } : x));
  return delay(null);
}

// ---------- Sample data for rebasing: the first 6 commits can be rebased, the last 3 are pushed ----------

export function rebaseRange(from: string | null) {
  const n = from ? rowOf(from) + 1 : 6;
  const commits = Array.from({ length: Math.min(n, 6) }, (_, k) => {
    const c = commitAt(k);
    return { id: c.id, title: c.title, body: c.body, author: c.author.name, time: c.time, pushed: k >= 3 };
  }).reverse();
  return delay<RebaseRange>({ commits, has_pushed: commits.some((c) => c.pushed) });
}
export function rebaseApply(steps: RebaseStep[]) {
  let after = 0;
  for (const s of steps) if (s.action === "pick" || (after === 0 && s.action !== "drop")) after++;
  return ok<RebaseResult>({ before: steps.length, after }, `整理 ${steps.length} 个提交`, "commit");
}

// ---------- Discarding changes, untracked files ----------

export function changesDiscard(paths: string[]) {
  mockStatus = { ...mockStatus, changes: mockStatus.changes.filter((c) => !paths.includes(c.path)) };
  return ok(null, paths.length === 1 ? `丢弃 ${paths[0]} 的改动` : `丢弃 ${paths.length} 个文件的改动`, "other");
}
export function untracked(kind: "add" | "ignore" | "delete", path: string) {
  mockStatus = { ...mockStatus, untracked: mockStatus.untracked.filter((u) => u !== path) };
  if (kind === "add") {
    mockStatus = { ...mockStatus, changes: [...mockStatus.changes, { path, status: "A", added: 3, deleted: 0, binary: false }] };
    return ok(null, `把 ${path} 加入版本控制`, "other");
  }
  if (kind === "ignore" && !mockStatus.untracked.includes(".gitignore") && !mockStatus.changes.some((c) => c.path === ".gitignore"))
    mockStatus = { ...mockStatus, untracked: [...mockStatus.untracked, ".gitignore"] };
  return ok(null);
}

// ---------- Compare, patches, files at a revision ----------

export function compare(from: string, to: string) {
  const a = rowOf(from);
  const b = rowOf(to);
  const range = (x: number, y: number) => Array.from({ length: Math.max(0, y - x) }, (_, k) => commitAt(x + k));
  return delay({
    from,
    to,
    only_from: a < b ? range(a, b) : [],
    only_to: b < a ? range(b, a) : [],
    truncated: false,
    files: [
      { path: "src/graph/layout.rs", status: "M" as const, added: 24, deleted: 9, binary: false },
      { path: "src/graph/cache.rs", status: "A" as const, added: 40, deleted: 0, binary: false },
    ],
  });
}
export const patchCommit = (id: string) => {
  const c = commitAt(rowOf(id));
  return delay(
    `From ${c.id} Mon Sep 17 00:00:00 2001\nFrom: ${c.author.name} <${c.author.email}>\nSubject: [PATCH] ${c.title}\n\n---\n src/graph/layout.rs | 4 +++-\n\ndiff --git a/src/graph/layout.rs b/src/graph/layout.rs\n--- a/src/graph/layout.rs\n+++ b/src/graph/layout.rs\n@@ -41,3 +41,4 @@\n     pub fn assign(&mut self) {\n-        self.place();\n+        let batch = self.batch();\n+        self.spawn(batch);\n     }\n`,
  );
};
export const patchWorktree = (sel: Selection) =>
  delay(sel.files.map((f) => `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1,2 +1,2 @@\n-旧的一行\n+新的一行\n 不变的一行\n`).join(""));
export const commitTree = () => delay(["Cargo.toml", "README.md", "src/graph/cache.rs", "src/graph/layout.rs", "src/graph/mod.rs", "src/lib.rs", "src/main.rs", "src/ui/graph_view.rs"]);

// ---------- Sample blame data: 200 lines, a new commit every 7 lines ----------

export function blameFile(_path: string, offset: number, limit: number) {
  const total = 200;
  const lines: BlamePage["lines"] = [];
  const used = new Map<number, number>();
  const commits: BlamePage["commits"] = [];
  for (let n = offset; n < Math.min(total, offset + limit); n++) {
    const k = Math.floor(n / 7) % 9;
    if (!used.has(k)) {
      used.set(k, commits.length);
      const c = commitAt(k * 3);
      commits.push({ id: c.id, title: c.title, body: c.body, author: c.author.name, email: c.author.email, time: c.time, in_log: k !== 8, uncommitted: false, previous: k < 8 ? commitAt(k * 3 + 1).id : undefined, previous_path: k < 8 ? _path : undefined });
    }
    lines.push({ no: n + 1, text: n % 7 === 0 ? `fn step_${n}() {` : n % 7 === 6 ? "}" : `    let v${n} = compute(${n});`, commit: used.get(k)!, orig: Math.max(1, n + 1 - k) });
  }
  return new Promise<BlamePage>((r) => setTimeout(() => r({ total, offset, lines, commits }), offset ? 400 : 80));
}

export function commitAmend(message: string | null): Promise<CommitCreated> {
  return delay({ id: "f".repeat(40), state, op: record(`修订“${message?.split("\n")[0] || "图谱：泳道计算移到后台线程"}”`, "commit") });
}

// ---------- Pre-commit checks: the sample repository has a check command configured, and src/ui/graph_view.rs reports two issues ----------
let mockChecks: ChecksInfo = {
  format_command: "",
  check_command: "cargo clippy --quiet",
  format_on_commit: false,
  check_on_commit: true,
  suggest_format: ["cargo fmt"],
  suggest_check: ["cargo clippy --quiet"],
};
export const checksConfig = () => delay(structuredClone(mockChecks));
export function checksConfigSet(c: ChecksConfig) {
  mockChecks = { ...mockChecks, ...c };
  return delay(structuredClone(mockChecks));
}
export function checksRun(kind: CheckKind, files: string[]): Promise<CheckRun> {
  const bad = kind === "check" && files.includes("src/ui/graph_view.rs");
  const output = bad
    ? "warning: unused variable: `w`\n  --> src/ui/graph_view.rs:42:9\n\nerror[E0308]: mismatched types\n  --> src/ui/graph_view.rs:57:20\n\nerror: could not compile `strand-app` due to 1 previous error\n"
    : "";
  return new Promise((r) =>
    setTimeout(
      () =>
        r({
          kind,
          command: kind === "check" ? mockChecks.check_command : mockChecks.format_command,
          ok: !bad,
          code: bad ? 101 : 0,
          output,
          truncated: false,
          timed_out: false,
          issues: bad
            ? [
                { path: "src/ui/graph_view.rs", line: 42, col: 9, level: "warning", message: "unused variable: `w`" },
                { path: "src/ui/graph_view.rs", line: 57, col: 20, level: "error", message: "[E0308]: mismatched types" },
              ]
            : [],
          ms: 1200,
          changed: [],
        }),
      1200,
    ),
  );
}

/** Sample: spike/gpui contains a merge commit; only the part the current branch tracks is pushed */
export const rebasePlan = (onto: string) =>
  delay<RebasePlan>({ branch: state.head.branch ?? "", onto, own: 2, pushed: onto === "main" ? 0 : 1, incoming: 3, has_merge: false });

// ---------- Console (spec §5.8) ----------

const t0 = Date.now() - 5 * 60_000;
let consoleLog: import("./types").ConsoleEntry[] = [
  { seq: 1, time: t0, kind: "note", text: "打开仓库 /Users/linxia/code/strand", output: [], ok: true },
  { seq: 2, time: t0 + 1200, kind: "command", text: "git fetch --prune --progress origin", output: ["From https://linxia:***@github.com/linxia/strand", "   3f2a9c1..8d04e7b  main       -> origin/main", "Receiving objects: 100% (12/12), 4.10 KiB | 4.10 MiB/s, done."], ok: true, ms: 842 },
  { seq: 3, time: t0 + 60_000, kind: "note", text: "提交“修复日志滚动时跳动”", output: [], ok: true },
  { seq: 4, time: t0 + 60_100, kind: "command", text: "git commit -F - --cleanup=strip", output: ["[main 5c1e0aa] 修复日志滚动时跳动", " 2 files changed, 14 insertions(+), 3 deletions(-)"], ok: true, ms: 118 },
  { seq: 5, time: t0 + 120_000, kind: "command", text: "git push --porcelain origin main:refs/heads/main", output: ["To https://github.com/linxia/strand", "! refs/heads/main:refs/heads/main [rejected] (fetch first)", "error: failed to push some refs to 'https://github.com/linxia/strand'"], ok: false, ms: 1310 },
  { seq: 6, time: t0 + 180_000, kind: "note", text: "撤销：提交“修复日志滚动时跳动”", output: [], ok: true },
];
const consoleSubs = new Set<(e: import("./types").ConsoleEntry) => void>();
export const consoleTail = async () => consoleLog.slice();
export const consoleClear = async () => {
  consoleLog = [];
  return null;
};
export function onConsoleLine(cb: (e: import("./types").ConsoleEntry) => void) {
  consoleSubs.add(cb);
  // During development, simulate an entry from the browser console with __strandConsole("text")
  if (import.meta.env.DEV)
    (window as unknown as { __strandConsole?: (text: string, ok?: boolean) => void }).__strandConsole = (text, ok = true) => {
      const e = { seq: (consoleLog[consoleLog.length - 1]?.seq ?? 0) + 1, time: Date.now(), kind: "command" as const, text, output: ok ? [] : ["fatal: 模拟的错误"], ok, ms: 12 };
      consoleLog.push(e);
      consoleSubs.forEach((f) => f(e));
    };
  return () => {
    consoleSubs.delete(cb);
  };
}

// ---------- Pull summary panel (spec §7.2) ----------

export const pullPreview = (mode: import("./types").PullMode) =>
  delay<import("./types").PullPreview>({
    branch: "feature/commit-graph",
    upstream: "origin/feature/commit-graph",
    mode,
    incoming: 3,
    ahead: 2,
    auto_merged: 4,
    conflicts:
      mode === "merge"
        ? [
            { path: "src/graph/layout.ts", kind: "text", blocks: 2 },
            { path: "src/graph/lanes.ts", kind: "modify_delete", blocks: 0 },
            { path: "pnpm-lock.yaml", kind: "lock", blocks: 0 },
          ]
        : [
            { path: "src/graph/layout.ts", kind: "text", blocks: 3, commit: "图谱：合并相邻泳道" },
            { path: "pnpm-lock.yaml", kind: "lock", blocks: 0, commit: "升级依赖" },
          ],
    dirty: 2,
  });

export const setFavorite = (name: string, favorite: boolean) => {
  refs = { ...refs, branches: refs.branches.map((b) => (b.name === name ? { ...b, favorite } : b)) };
  return delay(null);
};

// ---------- Project files and file change chains ----------

const PROJECT = [
  ".gitignore", "Cargo.lock", "Cargo.toml", "README.md",
  "benches/graph_layout.rs",
  "docs/design.md", "docs/images/graph.png",
  "src/graph/cache.rs", "src/graph/layout.rs", "src/graph/mod.rs",
  "src/lib.rs", "src/main.rs",
  "src/sync/fetch.rs", "src/sync/old_log.rs",
  "src/ui/commit_panel.tsx", "src/ui/graph_view.rs", "src/ui/panel.tsx",
  "notes/todo.md", "scratch/tmp.log",
];
export const projectFiles = () => delay(PROJECT);

export function fileText(path: string, rev: string | null) {
  const binary = path.endsWith(".png");
  const n = path.endsWith(".md") ? 24 : 80;
  const lines = Array.from({ length: n }, (_, i) =>
    i % 9 === 0 ? `// ${path} 第 ${i + 1} 行${rev ? `（版本 ${rev.slice(0, 7)}）` : ""}` : i % 9 === 4 ? "" : `    let value_${i} = compute(${i}, &state);`,
  );
  return delay({ path, text: binary ? undefined : lines.join("\n") + "\n", binary, missing: false, size: binary ? 48213 : lines.join("\n").length, truncated: false });
}

export function saveWorktreeFile(path: string, text: string, _expected: string) {
  console.info("[mock] 保存", path, text.length);
  return delay(null);
}

export function fileHistory(path: string) {
  // Changed every few commits; renamed once in between (layout.rs used to be lanes.rs)
  const versions = Array.from({ length: 14 }, (_, k) => {
    const c = commitAt(k * 7 + 1);
    const last = k === 13;
    const renamed = path === "src/graph/layout.rs" && k === 8;
    const old = path === "src/graph/layout.rs" && k > 8;
    return {
      commit: c,
      path: old ? "src/graph/lanes.rs" : path,
      old_path: renamed ? "src/graph/lanes.rs" : undefined,
      status: last ? ("A" as const) : renamed ? ("R" as const) : ("M" as const),
      added: last ? 80 : (k * 7) % 23 + 1,
      deleted: last ? 0 : (k * 5) % 11,
      binary: path.endsWith(".png"),
    };
  });
  return delay({ versions, truncated: false });
}

export const fileDiffVersions = (_from: string | null, _fromPath: string, _to: string | null, toPath: string) => diffFile(toPath);

// ---------- Searching by content ----------

export const commitChangeMatches = () => delay([{ path: "src/graph/layout.rs", lines: 3 }, { path: "src/ui/graph_view.rs", lines: 1 }]);

export function projectSearch(text: string, regex: boolean, caseSensitive: boolean, rev: string | null) {
  let re: RegExp;
  try {
    re = new RegExp(regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i");
  } catch {
    return Promise.reject({ code: "INVALID_REGEX", message: "正则表达式写得不对" });
  }
  // Go to definition looks up a pattern listing defining keywords: answer with sample definitions of that name
  const def = regex && text.includes("macro_rules") ? text.match(/\\s\+\)\?([\w$]+)\\b\|/) : null;
  if (def) {
    const name = def[1];
    const defs = [
      { path: "src/graph/layout.rs", hits: [{ line: 12, text: `pub fn ${name}(n: usize, state: &State) -> usize {` }], more: false },
      { path: "src/sync/fetch.rs", hits: [{ line: 30, text: `    fn ${name}(&self) -> usize {` }, { line: 44, text: `    let x = ${name}(1, &s);` }], more: false },
    ];
    return delay({ files: defs, total: 3, truncated: false });
  }
  // Sample: each text file has a few lines "containing" the search text
  const files = PROJECT.filter((p) => !p.endsWith(".png") && !p.endsWith(".lock")).slice(0, rev ? 5 : 8).map((path, k) => ({
    path,
    hits: Array.from({ length: (k % 3) + 1 }, (_, j) => ({ line: 4 + j * 9 + k, text: `    let value = ${text}(state, ${j}); // ${re.source.slice(0, 20)}` })),
    more: false,
  }));
  return delay({ files, total: files.reduce((n, f) => n + f.hits.length, 0), truncated: false });
}

/** Sample whole-file diff: 120 lines, lines 42–44 become 4 lines, one line added after line 89, line 110 deleted */
function fullDiff(path: string): FileDiff {
  const lines: FileDiff["hunks"][number]["lines"] = [];
  let o = 1;
  let n = 1;
  const ctx = (text: string) => lines.push({ kind: "context", old_no: o++, new_no: n++, text });
  const del = (text: string) => lines.push({ kind: "del", old_no: o++, text });
  const add = (text: string) => lines.push({ kind: "add", new_no: n++, text });
  ctx("use crate::model::Commit;");
  while (o < 41) ctx(o % 7 === 0 ? "" : `    // 布局计算的第 ${o} 行`);
  ctx("    pub fn assign(&mut self, commits: &[Commit]) {");
  del("        for c in commits {");
  del("            self.place(c);");
  del("        }");
  add("        let batch = commits.to_vec();");
  add("        let (tx, rx) = channel();");
  add("        self.pool.spawn(move || tx.send(compute_lanes(&batch)).ok());");
  add("        self.pending = Some(rx);");
  while (o < 89) ctx(o % 9 === 0 ? "" : `    let lane_${o} = self.free_lane(${o});`);
  ctx("    fn place(&mut self, c: &Commit) {");
  add("        if self.cancelled() { return; }");
  while (o < 110) ctx(`        self.rows.push(Row::new(c.id, ${o}));`);
  del("        self.debug_dump();");
  while (o <= 120) ctx(o === 120 ? "}" : `    // 结尾第 ${o} 行`);
  return { path, binary: false, truncated: false, hunks: [{ title: "第 1 行起", old_start: 1, new_start: 1, lines }] };
}

// ---------- Sample data for applying patches ----------
import type { PatchPreview } from "./types";

export const SAMPLE_PATCH = `From 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b Mon Sep 17 00:00:00 2001
From: 林夏 <lin@example.com>
Date: Fri, 13 Nov 2026 10:00:00 +0800
Subject: [PATCH] 图谱：长连线折叠后箭头可以点击

---
 src/graph/layout.rs | 4 +++-
 src/graph/arrow.rs  | 12 ++++++++++++
 2 files changed, 15 insertions(+), 1 deletion(-)

diff --git a/src/graph/layout.rs b/src/graph/layout.rs
--- a/src/graph/layout.rs
+++ b/src/graph/layout.rs
@@ -1,3 +1,5 @@
-old
+new
+more
+lines
`;

export function patchPreview(text: string): Promise<PatchPreview> {
  if (!text.includes("diff --git") && !text.includes("\n--- ")) return Promise.reject({ code: "INVALID_RANGE", message: "这不是一个补丁：里面没有找到文件改动（diff）" });
  const commits = [...text.matchAll(/^Subject: (?:\[PATCH[^\]]*\] )?(.*)$/gm)].map((m) => ({ title: m[1], author: "林夏" }));
  const files = [...text.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m, i) => ({ path: m[2], status: (i === 1 ? "A" : "M") as "A" | "M", added: 3 + i, deleted: i ? 0 : 1, binary: false }));
  return delay({ files: files.length ? files : [{ path: "README.md", status: "M" as const, added: 2, deleted: 1, binary: false }], commits, fit: text.includes("conflict") ? "three_way" : "clean" });
}

export const patchApply = (_text: string, commit: boolean) => ok(commit ? 1 : 0, commit ? "应用补丁（1 个提交）" : "应用补丁到工作区", commit ? "commit" : "other");

// ---------- Sample reflog data ----------
import type { ReflogEntry } from "./types";

export function reflog(name: string): Promise<ReflogEntry[]> {
  return logQuery(0, 40).then((page) => {
    const acts: [string, string][] = [
      ["checkout", "moving from main to feature/commit-graph"],
      ["commit", "图谱：泳道折叠"],
      ["reset", "moving to HEAD~1"],
      ["commit (amend)", "修复：差异视图中文换行"],
      ["rebase (finish)", "returning to refs/heads/feature/commit-graph"],
      ["merge origin/main", "Fast-forward"],
      ["pull", "Fast-forward"],
      ["cherry-pick", "统一错误提示"],
      ["commit", "提交面板：目录勾选"],
      ["checkout", "moving from feature/commit-graph to main"],
    ];
    const now = Math.floor(Date.now() / 1000);
    return acts.map(([action, message], i) => {
      const c = page.rows[i * 2];
      const lost = i === 2;
      return {
        index: i,
        id: lost ? "deadbeef" + c.id.slice(8) : c.id,
        old_id: page.rows[i * 2 + 1].id,
        action: name === "HEAD" || !action.startsWith("checkout") ? action : "commit",
        message,
        time: now - i * 3600 * 5,
        title: c.title,
        exists: true,
        in_log: !lost,
      };
    });
  });
}

// ---------- Sample signing data ----------
import type { Signature, SigningConfig } from "./types";

export const signing: SigningConfig = { commit: false, tag: false, key: "~/.ssh/id_ed25519.pub", format: "ssh" };
export function commitSignature(id: string): Promise<Signature> {
  const n = parseInt(id.slice(0, 2), 16) % 4;
  return delay(n === 0 ? { status: "good", signer: "lin@example.com", key: "SHA256:k3J…" } : n === 1 ? { status: "unknown", signer: "", key: "4F2A9C1E" } : { status: "none", signer: "", key: "" });
}

// ---------- Sample remote data ----------
import type { RemoteInfo } from "./types";

let mockRemotes: RemoteInfo[] = [{ name: "origin", url: "git@github.com:example/strand-app.git" }];
export const remoteList = () => delay(mockRemotes.map((r) => ({ ...r })));
const bad = (message: string) => Promise.reject({ code: "INVALID_NAME", message });
export function remoteEdit(f: () => string | void): Promise<Written<null>> {
  const e = f();
  return e ? bad(e) : ok(null);
}
export const remoteAddMock = (name: string, url: string) => {
  if (!name.trim() || /[\s/]/.test(name)) return "远程的名字不能为空，也不能有空格或斜杠";
  if (mockRemotes.some((r) => r.name === name)) return `已经有叫 ${name} 的远程了`;
  if (!url.trim()) return "地址不能为空，也不能有空格";
  mockRemotes = [...mockRemotes, { name, url }];
};
export const remoteRemoveMock = (name: string) => {
  mockRemotes = mockRemotes.filter((r) => r.name !== name);
};
export const remoteRenameMock = (name: string, to: string) => {
  if (mockRemotes.some((r) => r.name === to)) return `已经有叫 ${to} 的远程了`;
  mockRemotes = mockRemotes.map((r) => (r.name === name ? { ...r, name: to } : r));
};
export const remoteSetUrlMock = (name: string, url: string) => {
  if (!url.trim()) return "地址不能为空，也不能有空格";
  mockRemotes = mockRemotes.map((r) => (r.name === name ? { ...r, url } : r));
};

// ---------- Sample bisect data: search the first 16 commits of the sample log; number 5 is the first bad one ----------
import type { BisectMark, BisectStatus } from "./types";

let bis: { bad: number | null; good: number[]; skip: number[]; cur: number | null } | null = null;
function bisectNow(): BisectStatus {
  if (!bis) return { active: false, start: "", good: [], skipped: [] };
  const lo = bis.bad ?? 0;
  const hi = bis.good.length ? Math.min(...bis.good) : null;
  const left = hi === null || bis.bad === null ? null : hi - lo - 1;
  const done = left === 0;
  return {
    active: true,
    start: "feature/commit-graph",
    bad: bis.bad === null ? null : H(bis.bad),
    good: bis.good.map(H),
    skipped: bis.skip.map(H),
    current: bis.cur === null ? null : H(bis.cur),
    remaining: left === null ? null : Math.max(0, left - 1),
    steps: left === null ? null : Math.ceil(Math.log2(left + 1)),
    first_bad: done ? H(lo) : null,
    first_bad_title: done ? commitAt(lo).title : null,
  };
}
export const bisectStatus = () => delay(bisectNow());
export function bisectMark(mark: BisectMark, rev: string | null): Promise<Written<BisectStatus>> {
  bis ??= { bad: null, good: [], skip: [], cur: 0 };
  const i = rev ? Math.max(0, rowOf(rev)) : (bis.cur ?? 0);
  if (mark === "bad") bis.bad = i;
  if (mark === "good") bis.good.push(i);
  if (mark === "skip") bis.skip.push(i);
  const st0 = bisectNow();
  if (bis.bad !== null && bis.good.length && !st0.first_bad) bis.cur = Math.floor((bis.bad + Math.min(...bis.good)) / 2);
  // Sample: number 5 and earlier (newer) are bad
  return delay({ result: bisectNow(), state: { ...state, head: refs.head, bisecting: true } });
}
export function bisectReset(): Promise<Written<null>> {
  bis = null;
  return delay({ result: null, state: { ...state, head: refs.head, bisecting: false } });
}

// ---------- Writing messages and changelists ----------
import type { Changelists, ComposeInfo } from "./types";
export function composeInfo(): Promise<ComposeInfo> {
  return delay({
    template: null,
    template_path: null,
    history: ["图谱：泳道计算移到后台线程\n\n大仓库打开时界面不再卡住", "修复：日志过滤后选中的提交丢失", "提交面板：说明历史"],
    me: `${authors[0]} <${emails[0]}>`,
  });
}
let mockLists: Changelists = { lists: [{ id: "default", name: "" }], active: "default", files: {} };
export function changelistsGet(): Promise<Changelists> {
  return delay(structuredClone(mockLists));
}
export function changelistsSet(c: Changelists): Promise<Changelists> {
  const ids = new Set(c.lists.map((l) => l.id));
  mockLists = { ...c, active: ids.has(c.active) ? c.active : "default", files: Object.fromEntries(Object.entries(c.files).filter(([, v]) => ids.has(v))) };
  return delay(structuredClone(mockLists));
}

/** Sample images: the old version is a blue circle, the new one (worktree or commit) an orange square of a different size; in a parent revision ending with "^" an added image doesn't exist */
export async function fileBytes(path: string, rev: string | null): Promise<ArrayBuffer> {
  const old = !!rev && (rev === "HEAD" || rev.endsWith("^"));
  if (old && path.includes("new")) throw { code: "NOT_FOUND", message: `这个版本里没有 ${path}` };
  const c = document.createElement("canvas");
  c.width = old ? 160 : 200;
  c.height = old ? 120 : 140;
  const g = c.getContext("2d")!;
  g.fillStyle = old ? "#3b82f6" : "#f59e0b";
  if (old) {
    g.beginPath();
    g.arc(80, 60, 44, 0, Math.PI * 2);
    g.fill();
  } else g.fillRect(40, 30, 120, 80);
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
  await delay(null);
  return blob.arrayBuffer();
}

/** Sample: line-by-line comparison (only good enough for the preview: aligned by line number, no longest common subsequence) */
export function textDiff(left: string, right: string, name: string): Promise<FileDiff> {
  const a = left.split("\n");
  const b = right.split("\n");
  const lines: FileDiff["hunks"][number]["lines"] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) lines.push({ kind: "context", old_no: i + 1, new_no: i + 1, text: a[i] });
    else {
      if (a[i] !== undefined) lines.push({ kind: "del", old_no: i + 1, text: a[i] });
      if (b[i] !== undefined) lines.push({ kind: "add", new_no: i + 1, text: b[i] });
    }
  }
  const changed = lines.some((l) => l.kind !== "context");
  return delay({ path: name, binary: false, truncated: false, hunks: changed ? [{ title: "第 1 行起", old_start: 1, new_start: 1, lines }] : [] });
}

// ---------- Git settings ----------
import type { ConfigScope, ConfigValue } from "./types";
const mockConfig: Record<ConfigScope, Record<string, string>> = {
  global: { "user.name": "林夏", "user.email": "linxia@example.com", "core.autocrlf": "input", "init.defaultBranch": "main" },
  local: { "user.email": "linxia@corp.example.com" },
};
const CONFIG_KEYS = ["user.name", "user.email", "http.proxy", "https.proxy", "core.autocrlf", "init.defaultBranch", "strand.httpProxy", "strand.httpsProxy"];
const PROXY_PAIRS: [string, string][] = [
  ["http.proxy", "strand.httpProxy"],
  ["https.proxy", "strand.httpsProxy"],
];
const configNow = (): ConfigValue[] =>
  CONFIG_KEYS.map((key) => ({ key, global: mockConfig.global[key] ?? null, local: mockConfig.local[key] ?? null, effective: mockConfig.local[key] ?? mockConfig.global[key] ?? null }));
export function gitConfigGet(): Promise<ConfigValue[]> {
  return delay(configNow());
}
export function gitConfigSet(scope: ConfigScope, key: string, value: string | null): Promise<ConfigValue[]> {
  const v = value?.trim();
  const c = mockConfig[scope];
  const put = (k: string, x: string | undefined) => (x ? (c[k] = x) : delete c[k]);
  if (key === "user.email" && v && !/^[^@\s<>]+@[^@\s<>]+$/.test(v)) return Promise.reject({ code: "INVALID_NAME", message: "邮箱的格式不对，应该像 name@example.com" });
  const pair = PROXY_PAIRS.find(([r]) => r === key);
  if (pair) {
    if (v && !/^(https?|socks[45]a?h?):\/\/([^@\s/]*@)?([^:\s/@]+|\[[0-9a-fA-F:]+\])(:([1-9]\d{0,4}))?(\/\S*)?$/.test(v)) return Promise.reject({ code: "INVALID_NAME", message: "代理地址要带协议，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" });
    const on = PROXY_PAIRS.some(([r]) => c[r]);
    put(pair[1], v);
    if (c[pair[0]] || (v && on)) put(pair[0], v);
    return delay(configNow());
  }
  put(key, v);
  return delay(configNow());
}
export function gitProxyEnable(scope: ConfigScope, on: boolean): Promise<ConfigValue[]> {
  const c = mockConfig[scope];
  if (on) {
    let any = false;
    for (const [r, saved] of PROXY_PAIRS) {
      const a = c[saved] ?? c[r];
      if (a) {
        c[r] = a;
        any = true;
      }
    }
    if (!any) return Promise.reject({ code: "INVALID_NAME", message: "先填写代理地址" });
  } else {
    for (const [r, saved] of PROXY_PAIRS) {
      if (c[r]) {
        c[saved] ??= c[r];
        delete c[r];
      }
    }
  }
  return delay(configNow());
}

// ---------- App updates (browser preview: a pretend 0.2.0) ----------
import type { UpdateInfo, UpdateProgress } from "./types";
const updateListeners = new Set<(p: UpdateProgress) => void>();
export function onUpdateProgress(cb: (p: UpdateProgress) => void): () => void {
  updateListeners.add(cb);
  return () => updateListeners.delete(cb);
}
export function updateCheck(): Promise<UpdateInfo | null> {
  return delay({ version: "0.2.0", current: "0.1.0", notes: "- Git settings: user name, email, proxy\n- Automatic updates", date: "2026-11-15T08:00:00Z" });
}
export async function updateInstall(): Promise<void> {
  const total = 5_300_000;
  for (let d = 0; d <= total; d += 530_000) {
    updateListeners.forEach((cb) => cb({ downloaded: d, total }));
    await new Promise((r) => setTimeout(r, 200));
  }
  // The real app restarts here; the preview just stays
}

export const submoduleList = () =>
  delay<Submodule[]>([
    { path: "vendor/libgit", name: "vendor/libgit", url: "https://example.com/libgit.git", recorded: "3f2a9c1".padEnd(40, "0"), current: "3f2a9c1".padEnd(40, "0"), state: "clean", dirty: false },
    { path: "vendor/theme", name: "vendor/theme", url: "https://example.com/theme.git", recorded: "b81d044".padEnd(40, "0"), current: "c90e113".padEnd(40, "0"), state: "moved", dirty: false },
    { path: "docs/site", name: "docs/site", url: "https://example.com/site.git", recorded: "77ad0e2".padEnd(40, "0"), state: "uninitialized", dirty: false },
  ]);

export const mergedBranches = (into: string) =>
  delay<MergedBranch[]>(
    into === "main"
      ? [
          { name: "fix/diff-ime", head: "e1b07c4".padEnd(40, "0"), title: "修复：diff 视图中输入法候选框错位", time: Math.floor(Date.now() / 1000) - 3 * 86400, upstream: "origin/fix/diff-ime", favorite: false },
          { name: "spike/gpui", head: "9a3f2d1".padEnd(40, "0"), title: "试验：用 GPUI 画图谱", time: Math.floor(Date.now() / 1000) - 12 * 86400, favorite: false },
        ]
      : [],
  );

// Pull requests: sample data only (the browser preview never calls GitHub or GitLab)
let mockToken = false;
const nowS = () => Math.floor(Date.now() / 1000);
const mockPrs: PullRequest[] = [
  { number: 42, title: "日志支持按作者着色", author: "linxia", head: "feature/author-colors", head_sha: "a1".padEnd(40, "0"), base: "main", draft: false, url: "https://github.com/strand-demo/strand/pull/42", updated: nowS() - 3600 },
  { number: 39, title: "修复：diff 视图中输入法候选框错位", author: "zhou", head: "fix/diff-ime", head_sha: "e1b07c4".padEnd(40, "0"), base: "main", draft: false, url: "https://github.com/strand-demo/strand/pull/39", updated: nowS() - 2 * 86400 },
  { number: 37, title: "试验：用 GPUI 画图谱", author: "mei", head: "spike/gpui", head_sha: "9a3f2d1".padEnd(40, "0"), base: "main", draft: true, url: "https://github.com/strand-demo/strand/pull/37", updated: nowS() - 9 * 86400 },
];
export const hostingInfo = () => delay<Hosting | null>({ kind: "github", host: "github.com", path: "strand-demo/strand", web_url: "https://github.com/strand-demo/strand" });
export const hostingSetToken = (token: string) =>
  token.length < 8 ? Promise.reject({ code: "INVALID_NAME", message: "令牌不对" }) : delay(void (mockToken = true));
const needToken = () => Promise.reject({ code: "AUTH_FAILED", message: "还没有这个网站的访问令牌", detail: { need_token: true, host: "github.com" } });
export const prList = () => (mockToken ? delay([...mockPrs]) : needToken());
export const prChecks = (n: number) =>
  delay<Checks>(n === 42 ? { total: 4, success: 3, failed: 0, pending: 1 } : n === 39 ? { total: 3, success: 2, failed: 1, pending: 0 } : { total: 0, success: 0, failed: 0, pending: 0 });
export const prCreate = (title: string, head: string, base: string, draft: boolean) => {
  if (!mockToken) return needToken();
  const p: PullRequest = { number: 43, title, author: "you", head, head_sha: "f".repeat(40), base, draft, url: "https://github.com/strand-demo/strand/pull/43", updated: nowS() };
  mockPrs.unshift(p);
  return delay(p);
};

// Contribution statistics: generated sample data (a few authors over two years, working hours heavier)
export const contributions = (since: number | null) => {
  const people = [
    { name: "林夏", email: "linxia@example.com", w: 9 },
    { name: "周远", email: "zhou@example.com", w: 6 },
    { name: "Mei Chen", email: "mei@example.com", w: 3 },
    { name: "Alex Park", email: "alex@example.com", w: 1.5 },
    { name: "dependabot[bot]", email: "bot@example.com", w: 0.6 },
  ];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const now = Math.floor(Date.now() / 1000);
  const from = since ?? now - 730 * 86400;
  const authors = people.map((p) => ({ name: p.name, email: p.email, commits: 0, added: 0, deleted: 0, first: now, last: from }));
  const months = new Map<string, { month: string; commits: number; added: number; deleted: number }>();
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  const total = people.reduce((a, p) => a + p.w, 0);
  for (let t = from; t < now; t += 3600 * (2 + rnd() * 10)) {
    const d = new Date(t * 1000);
    const wd = (d.getDay() + 6) % 7;
    const h = d.getHours();
    const busy = (wd < 5 ? 1 : 0.25) * (h >= 9 && h <= 19 ? 1 : h >= 21 || h < 7 ? 0.08 : 0.4);
    if (rnd() > busy) continue;
    let r = rnd() * total;
    const i = people.findIndex((p) => (r -= p.w) < 0);
    const a = authors[i < 0 ? 0 : i];
    const add = Math.floor(rnd() ** 3 * 400) + 1;
    const del = Math.floor(rnd() ** 3 * 200);
    a.commits++;
    a.added += add;
    a.deleted += del;
    a.first = Math.min(a.first, t);
    a.last = Math.max(a.last, t);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const m = months.get(k) ?? { month: k, commits: 0, added: 0, deleted: 0 };
    m.commits++;
    m.added += add;
    m.deleted += del;
    months.set(k, m);
    heat[wd][h]++;
  }
  const list = authors.filter((a) => a.commits).sort((a, b) => b.commits - a.commits);
  return delay<Contributions>({
    authors: list,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    heat,
    commits: list.reduce((n, a) => n + a.commits, 0),
    added: list.reduce((n, a) => n + a.added, 0),
    deleted: list.reduce((n, a) => n + a.deleted, 0),
    no_lines: false,
  });
};

// Repository maintenance: sizes shrink after a (pretend) cleanup
let mockGcDone = false;
let mockRerere = false;
const MB = 1 << 20;
export const repoSize = () =>
  delay<RepoSize>(
    mockGcDone
      ? { git_dir: 182 * MB, loose_count: 0, loose_bytes: 0, packed_count: 412_880, pack_bytes: 168 * MB, packs: 1, cleanable_bytes: 0, lfs_bytes: 12 * MB, strand_bytes: 340 * 1024, suggest_gc: false }
      : { git_dir: 236 * MB, loose_count: 8_412, loose_bytes: 41 * MB, packed_count: 404_468, pack_bytes: 171 * MB, packs: 27, cleanable_bytes: 9 * MB, lfs_bytes: 12 * MB, strand_bytes: 340 * 1024, suggest_gc: true },
  );
export const repoGc = () => slow(null).then((w) => ((mockGcDone = true), w));
export const rerereGet = () => delay(mockRerere);
export const rerereSet = (on: boolean) => delay(void (mockRerere = on));
