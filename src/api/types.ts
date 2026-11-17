// Data structures shared by frontend and backend; must match crates/strand-core/src/model.rs and error.rs.
// Corresponds to spec §13 and §14.

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
  /** Bisect in progress */
  bisecting?: boolean;
  /** Uses Git LFS (filter=lfs in .gitattributes) */
  lfs?: boolean;
  /** Has submodules (.gitmodules) */
  submodules?: boolean;
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
  /** Unix seconds */
  time: number;
  refs: Ref[];
  is_merge: boolean;
  /** Reachable from the current branch but not in its upstream */
  unpushed: boolean;
}

/** cut_out: a long edge collapses here, a short segment down then a down arrow; cut_in: a collapsed long edge rejoins from an arrow at the top of this row, then continues to the next row */
export type EdgeKind = "straight" | "fork" | "merge" | "cut_out" | "cut_in";

/** A segment from this row to the next */
export interface Edge {
  from_lane: number;
  to_lane: number;
  kind: EdgeKind;
  /** The row at the other end of a collapsed edge (cut_out points to the parent, cut_in to the child it started from); clicking the arrow jumps there */
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
  /** With linear branches collapsed: matches rows, how many commits are folded under this row */
  folded?: number[];
  total: number;
  lanes: number;
  /** Filter results not complete yet: total is the count so far, querying again later gives more (spec §15) */
  partial?: boolean;
}

/** Log filter conditions (spec §5.1); omitted ones don't filter */
export type MatchKind = "contains" | "prefix" | "suffix" | "regex";
export interface AuthorMatch {
  kind: MatchKind;
  text: string;
}

export interface LogFilter {
  text?: string;
  regex?: boolean;
  case_sensitive?: boolean;
  /** Only commits reachable from this branch */
  branch?: string | null;
  /** Author email (old single-author form) */
  author?: string | null;
  /** Selected author emails (multiple) */
  authors?: string[];
  /** Match authors by rule (name or email), OR-ed with the selected authors */
  author_match?: AuthorMatch | null;
  /** Author time not earlier than (Unix seconds) */
  since?: number | null;
  /** Author time earlier than (Unix seconds, exclusive) */
  until?: number | null;
  /** Where the search text searches: commit messages (default) or changes (git log -S / -G) */
  search_in?: "message" | "changes";
  /** First parent only */
  first_parent?: boolean;
  /** Hide merge commits */
  no_merges?: boolean;
  /** Collapse linear branches (without other filters, in graph order) */
  collapse_linear?: boolean;
  /** Path substring */
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
  | "INVALID_REGEX"
  | "PARTIAL_CLONE";

export interface CoreError {
  code: ErrorCode;
  message: string;
  detail?: unknown;
}

// ---------- Worktree, diffs, commit details ----------

/** T is a type change (e.g. a regular file became a symlink), shown as M in the UI */
export type FileStatus = "M" | "A" | "D" | "R" | "T";

export interface FileChange {
  path: string;
  old_path?: string;
  status: FileStatus;
  added: number;
  deleted: number;
  binary: boolean;
  /** In a partial clone the file content isn't local and couldn't be downloaded: line counts unavailable */
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
  /** A Git LFS file shown with its real content: committed whole only, no line checks */
  lfs?: boolean;
}

export interface CommitDetail {
  commit: Commit;
  files: FileChange[];
  caps: CommitCaps;
}

/** Whether an operation is available; the reason when it isn't (spec §5.6) */
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
  /** Rebase from here (spec §9.2) */
  rebase_from: Cap;
  /** Fixup / Squash Into (also requires checked files in the commit panel) */
  fixup: Cap;
  /** Compare with local (spec §10.3) */
  compare_local: Cap;
  /** Push up to here (spec §5.6) */
  push_to: Cap;
  parent?: string;
  child?: string;
  /** This commit's page on the hosting service */
  web_url?: string;
}

export type ResetMode = "soft" | "mixed" | "hard";

/** One page of blame (spec §10.2) */
export interface BlamePage {
  total: number;
  offset: number;
  /** orig: the line's number in its commit's version of the file */
  lines: { no: number; text: string; commit: number; orig: number }[];
  /** previous / previous_path: the revision before this commit for this file and its path there (absent when the commit added the file) */
  commits: { id: string; title: string; body: string; author: string; email: string; time: number; in_log: boolean; uncommitted: boolean; previous?: string; previous_path?: string }[];
}

/** Comparison result (spec §10.3) */
export interface Comparison {
  from: string;
  to: string;
  /** Commits only on the start side, newest first */
  only_from: Commit[];
  /** Commits only on the end side */
  only_to: Commit[];
  truncated: boolean;
  files: FileChange[];
}

// ---------- Rebasing commits (spec §9) ----------

export interface RangeCommit {
  id: string;
  title: string;
  body: string;
  author: string;
  time: number;
  pushed: boolean;
}

export interface RebaseRange {
  /** Oldest first */
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
  /** When whole is false only the changed lines in lines are committed: line `line` of block `hunk` in diff_worktree (keep whitespace, 3 lines of context) */
  files: { path: string; old_path?: string; whole: boolean; lines?: { hunk: number; line: number }[] }[];
}

export interface CommitCreated {
  id: string;
  state: RepoState;
  op?: OpInfo;
}

export type ChangeScope = "refs" | "status" | "stash" | "shelf";

// ---------- Branches, remote branches, tags ----------

export interface Branch {
  name: string;
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
  is_current: boolean;
  /** Fully contained in the current branch; deleting loses no commits */
  merged: boolean;
  /** Checked out in another worktree (that directory's path), can't be switched to here */
  worktree?: string;
  /** Local history rewrote pushed commits: pushing needs a force push; behind then counts old versions on the remote and shouldn't be pulled */
  needs_force: boolean;
  /** Why the current branch can't be rebased onto it (Chinese from the core layer, shown via tr()); absent when it can */
  rebase_block?: string;
  /** Favorite (stored in the repository's .git/strand/favorites) */
  favorite?: boolean;
}

/** Worktree (spec §6.6) */
export interface Worktree {
  path: string;
  branch?: string;
  head: string;
  is_main: boolean;
  is_current: boolean;
  locked: boolean;
  /** The folder no longer exists */
  prunable: boolean;
}

export interface RemoteBranch {
  name: string;
  remote: string;
  head: string;
  /** Same as Branch.rebase_block */
  rebase_block?: string;
}

export interface Tag {
  name: string;
  at: string;
  /** The message of an annotated tag; lightweight tags have none */
  message?: string;
  /** Not pushed to origin yet (per the remote tags recorded at the last fetch); false if never fetched */
  unpushed: boolean;
}

export interface RefsList {
  branches: Branch[];
  remotes: RemoteBranch[];
  tags: Tag[];
  head: Head;
  /** The first one is the main worktree */
  worktrees: Worktree[];
}

export type MergeResult = "up_to_date" | "fast_forward" | "merged" | "squashed";
/** Merge mode (spec §6.7): fast-forward when possible / always create a merge commit / squash into one commit */
export type MergeMode = "auto" | "no_ff" | "squash";

/** Pre-rebase check (spec §6.3) */
export interface RebasePlan {
  branch: string;
  onto: string;
  /** Commits only on the current branch */
  own: number;
  /** How many of them are pushed */
  pushed: number;
  /** Commits on the target branch the current branch doesn't have */
  incoming: number;
  has_merge: boolean;
}

export type RebaseOutcome = "up_to_date" | "fast_forward" | "rebased";

/** What write operations return: the operation result and the latest repository state */
export interface Written<T> {
  result: T;
  state: RepoState;
  /** The op log entry this operation wrote (spec §11); omitted when nothing was logged */
  op?: OpInfo;
  /** Extra notes for the user, e.g. auto-shelved changes couldn't be restored after a pull (spec §7.2) */
  note?: string;
}

// ---------- Stash and shelf (spec §4.9) ----------

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

// ---------- Undo, redo and the op timeline ----------

export type OpKind = "commit" | "branch" | "switch" | "merge" | "checkout" | "tag" | "pull" | "push" | "stash" | "shelf" | "other";

export interface OpInfo {
  id: number;
  label: string;
  kind: OpKind;
  time: number;
  undoable: boolean;
  /** Undone, waiting for redo */
  undone: boolean;
  /** Why it can't be undone */
  reason?: string;
}

export interface OpList {
  /** Newest first */
  entries: OpInfo[];
  can_undo: boolean;
  can_redo: boolean;
}

// ---------- Remote operations ----------

export interface FetchResult {
  /** The fetch changed refs (remote branches, tags); when not, the UI doesn't re-read the log */
  refs_changed?: boolean;
  /** After fetching, how many commits the current branch is behind its upstream */
  behind: number;
  /** Commits newly arrived this time */
  incoming: number;
}

export type PullMode = "merge" | "rebase";
export type PullOutcome = "up_to_date" | "fast_forward" | "merged" | "rebased";

export interface PullResult {
  outcome: PullOutcome;
  incoming: number;
}

/** One conflicted file in the pull summary panel (spec §7.2) */
export interface PreviewConflict {
  path: string;
  kind: "text" | "modify_delete" | "binary" | "lock";
  /** Number of places in a text file where both sides changed the same section */
  blocks: number;
  /** Rebase mode: which local commit (title) the first conflict appears in */
  commit?: string;
}

/** Pull dry run: merge once in memory using the last fetch's result, without changing the repository */
export interface PullPreview {
  branch: string;
  upstream: string;
  mode: PullMode;
  incoming: number;
  ahead: number;
  auto_merged: number;
  conflicts: PreviewConflict[];
  /** Number of changes to tracked worktree files (shelved first) */
  dirty: number;
}

export interface PushPreview {
  branch: string;
  target: string;
  new_branch: boolean;
  commits: { id: string; title: string }[];
  behind: number;
  needs_force: boolean;
  /** Which remote to push to */
  remote: string;
  /** All remotes in the repository */
  remotes: string[];
  /** Push up to this commit (spec §5.6): commits contains only it and those before it */
  to?: string;
  /** When pushing up to a commit, the number of commits after it that stay local */
  left: number;
  /** Local tags not pushed yet */
  unpushed_tags: string[];
  /** Never fetched, so the remote's tags are unknown */
  tags_unknown: boolean;
}

export interface TaskProgress {
  task_id: string;
  text: string;
  percent?: number;
}

// ---------- Conflict resolution (spec §8.10) ----------

export type SessionKind = "merge" | "rebase" | "cherry_pick" | "revert" | "unstash";
export type FileKind = "text" | "modify_delete" | "binary" | "lock" | "rename";
export type SideChange = "modified" | "deleted" | "added" | "renamed";

/** The commit that introduced a change block (Block.origin in spec §8.10) */
export interface Origin {
  commit: string;
  author: string;
  /** Unix seconds */
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
  /** What this side changed it to; null means this side has no change */
  mine: string[] | null;
  theirs: string[] | null;
  /** The commit that introduced this side's content; when absent, this side's commit is shown */
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
  /** Had conflicts during this operation and is resolved now (including git add on the command line) */
  resolved?: boolean;
  /** Rename conflict: each side's new name (path is the original name) */
  mine_path?: string;
  theirs_path?: string;
}

export interface MergeSession {
  kind: SessionKind;
  step?: { index: number; total: number };
  mine: SideInfo;
  theirs: SideInfo;
  /** Files with conflicts in this operation; those with resolved true are resolved */
  files: ConflictFile[];
  /** Marks restored after undoing "abort merge": the localStorage entries (key → content) handed to the core layer when aborting */
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

// ---------- Format and check before committing (spec §4.4, §4.6) ----------

export interface ChecksConfig {
  format_command: string;
  check_command: string;
  format_on_commit: boolean;
  check_on_commit: boolean;
}

/** Settings, plus suggested commands guessed from the repository's files */
export interface ChecksInfo extends ChecksConfig {
  suggest_format: string[];
  suggest_check: string[];
}

export type CheckKind = "format" | "check";

export interface CheckIssue {
  path: string;
  line?: number | null;
  col?: number | null;
  /** error, warning or empty */
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
  /** Files the formatter changed */
  changed: string[];
}

/** One console entry (spec §5.8): `$` is a git command that ran, `#` is the client's own operation */
export interface ConsoleEntry {
  seq: number;
  /** Timestamp in milliseconds */
  time: number;
  kind: "command" | "note";
  /** The command (without `$`) or operation description (without `#`), credentials masked */
  text: string;
  /** The command's output, credentials masked, at most 12 lines */
  output: string[];
  /** Number of output lines cut off */
  more?: number;
  ok: boolean;
  /** Duration (ms) */
  ms?: number;
}

// ---------- Project files and file change chains ----------

export interface FileText {
  path: string;
  /** Text content; absent for binary or missing files */
  text?: string;
  binary: boolean;
  /** The file doesn't exist at this revision (or in the worktree) */
  missing: boolean;
  size: number;
  truncated: boolean;
  /** A Git LFS file whose content hasn't been downloaded (text is the pointer) */
  lfs_missing?: { oid: string; size: number };
}

export interface FileVersion {
  commit: Commit;
  /** The file's path in this commit */
  path: string;
  /** The path this commit renamed the file from */
  old_path?: string;
  status: FileChange["status"];
  added: number;
  deleted: number;
  binary: boolean;
}

export interface FileHistory {
  /** Newest first */
  versions: FileVersion[];
  truncated: boolean;
}

// ---------- Searching by content ----------

export interface ChangeMatch {
  path: string;
  /** Number of matching changed lines */
  lines: number;
}

export interface SearchHit {
  line: number;
  text: string;
}

export interface SearchFile {
  path: string;
  hits: SearchHit[];
  more: boolean;
}

export interface ProjectSearch {
  files: SearchFile[];
  total: number;
  truncated: boolean;
}

/** Applying patches: a file in the patch */
export interface PatchFile {
  path: string;
  old_path?: string;
  status: FileStatus;
  added: number;
  deleted: number;
  binary: boolean;
}
/** Whether the patch applies: cleanly, needs a three-way apply (may conflict), or not at all */
export type PatchFit = "clean" | "three_way" | "fails";
export interface PatchPreview {
  files: PatchFile[];
  /** Commits in mailbox format (git format-patch) */
  commits: { title: string; author: string }[];
  fit: PatchFit;
  reason?: string;
}

/** One reflog entry, newest first */
export interface ReflogEntry {
  index: number;
  id: string;
  old_id: string;
  /** E.g. commit, checkout, reset, merge origin/main */
  action: string;
  message: string;
  time: number;
  title: string;
  /** The commit still exists in the repository */
  exists: boolean;
  /** The commit is in the log */
  in_log: boolean;
}

/** A commit's signature status */
export type SigStatus = "good" | "untrusted" | "bad" | "expired" | "expired_key" | "revoked" | "unknown" | "none";
export interface Signature {
  status: SigStatus;
  signer: string;
  key: string;
}
/** This repository's signing settings (effective git config values) */
export interface SigningConfig {
  commit: boolean;
  tag: boolean;
  key?: string;
  format: string;
}

/** A remote */
export interface RemoteInfo {
  name: string;
  url: string;
  push_url?: string;
}

/** A bisect mark */
export type BisectMark = "good" | "bad" | "skip";
/** Bisect state */
export interface BisectStatus {
  active: boolean;
  /** The branch before starting; we return here at the end */
  start: string;
  bad?: string | null;
  good: string[];
  skipped: string[];
  /** The commit currently checked out, waiting to be tested */
  current?: string | null;
  /** How many candidates remain after testing this one */
  remaining?: number | null;
  /** Roughly how many steps are left */
  steps?: number | null;
  first_bad?: string | null;
  first_bad_title?: string | null;
}

/** For writing messages: the template (comment lines removed), your past messages (newest first), the current identity */
export interface ComposeInfo {
  template?: string | null;
  template_path?: string | null;
  history: string[];
  me?: string | null;
}

/** Changelists: the first is the default list (id "default"; shown as "Changes" when name is empty) */
export interface Changelist {
  id: string;
  name: string;
}
export interface Changelists {
  lists: Changelist[];
  /** Which list new changes go into */
  active: string;
  /** path → list id; paths not listed belong to the active list */
  files: Record<string, string>;
}

/** Git settings scope: global (~/.gitconfig) or this repository (.git/config) */
export type ConfigScope = "global" | "local";
/** One editable Git setting: its value in each scope and the value git actually uses */
export interface ConfigValue {
  key: string;
  global?: string | null;
  local?: string | null;
  effective?: string | null;
}

/** A newer version found by the update check */
export interface UpdateInfo {
  version: string;
  current: string;
  notes?: string | null;
  /** RFC 3339 */
  date?: string | null;
}
export interface UpdateProgress {
  downloaded: number;
  total?: number | null;
}

// ---------- Submodules ----------

export type SubmoduleState = "uninitialized" | "clean" | "moved" | "dirty" | "conflict";

export interface Submodule {
  /** Relative to the superproject root */
  path: string;
  name: string;
  url?: string;
  /** The commit the superproject records */
  recorded?: string;
  /** The commit checked out inside; absent when not initialized */
  current?: string;
  state: SubmoduleState;
  /** Uncommitted or untracked changes inside */
  dirty: boolean;
}

/** A local branch whose commits are all in another branch (clean up merged branches) */
export interface MergedBranch {
  name: string;
  head: string;
  /** Title of its latest commit */
  title: string;
  time: number;
  upstream?: string;
  favorite: boolean;
}

/** Where origin is hosted (pull / merge requests) */
export interface Hosting {
  kind: "github" | "gitlab";
  host: string;
  /** owner/repo, or GitLab's group/…/project */
  path: string;
  web_url: string;
}

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  head: string;
  head_sha: string;
  base: string;
  draft: boolean;
  url: string;
  /** Unix seconds */
  updated: number;
}

export interface Checks {
  total: number;
  success: number;
  failed: number;
  pending: number;
}

export interface AuthorStats {
  name: string;
  email: string;
  commits: number;
  added: number;
  deleted: number;
  first: number;
  last: number;
}

export interface MonthStats {
  /** "2026-11" */
  month: string;
  commits: number;
  added: number;
  deleted: number;
}

/** Contribution statistics of the current branch */
export interface Contributions {
  authors: AuthorStats[];
  months: MonthStats[];
  /** Commits by weekday (0 = Monday) × hour, in the author's time zone */
  heat: number[][];
  commits: number;
  added: number;
  deleted: number;
  /** Lines weren't counted (partial clone) */
  no_lines: boolean;
}
