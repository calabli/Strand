//! Data structures passed between frontend and backend, matching spec §13.
//!
//! Field names are snake_case, times are Unix seconds, hashes are full 40-character strings.
//! The frontend's `src/api/types.ts` must stay in sync with this file.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HeadKind {
    Branch,
    Detached,
    /// A new repository with no commits yet
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
    /// Restoring a stash or shelf entry hit conflicts that aren't resolved yet (spec §4.9, §8.1)
    Unstashing,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoState {
    pub path: String,
    pub name: String,
    pub head: Head,
    pub state: RepoMode,
    /// Bisect in progress (git bisect); HEAD sits on the commit to test, other operations work as usual
    #[serde(default)]
    pub bisecting: bool,
    /// The repository uses Git LFS (`filter=lfs` in .gitattributes)
    #[serde(default)]
    pub lfs: bool,
    /// The repository has submodules (a .gitmodules file)
    #[serde(default)]
    pub submodules: bool,
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
    /// Short name, e.g. `main`, `origin/main`, `v0.4.0`
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
    /// Reachable from the current branch but not in its upstream (without an upstream: not in any remote branch)
    pub unpushed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    /// The same lane continues down
    Straight,
    /// Branches off from this row to another lane (the first parent is in another lane, or a branch start)
    Fork,
    /// The second and later parents of a merge commit
    Merge,
    /// A long edge collapses here: a short segment down from this row ending in a down arrow, not connected to the next row (the lane is given to other edges)
    CutOut,
    /// A collapsed long edge rejoins here: a down arrow at the top of this row, then drawn from this row to the next
    CutIn,
}

/// One segment from this row to the next.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Edge {
    pub from_lane: u32,
    pub to_lane: u32,
    pub kind: EdgeKind,
    /// The row at the other end of a collapsed edge (`CutOut`, `CutIn`): the cap points to the parent, the rejoin to the child the edge started from.
    /// Clicking the arrow jumps there. Empty when the parent isn't in the list
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<u32>,
}

/// One row of the graph, matching `LogPage.rows` one to one.
///
/// `edges` are all segments drawn from this row to the next, including lanes that only pass through,
/// so the frontend draws row by row without knowing which row a parent is on.
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
    /// The most lanes used anywhere in the log; the frontend sizes the graph column from it
    pub lanes: u32,
    /// Filter results aren't complete yet (spec §15 "first results return first, the rest are appended in batches"): total is the count so far, querying again later gives more
    pub partial: bool,
    /// With linear branches collapsed: matches rows one to one, the number of commits folded under that row (0 means none); empty when not collapsed
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub folded: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitInfo {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Version not lower than `MIN_GIT_VERSION`
    pub ok: bool,
    pub min_version: String,
}

// ---------- Worktree, diffs, commit details (spec §4, §5.5, §10) ----------

#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize, PartialEq, Eq)]
pub enum FileStatus {
    M,
    A,
    D,
    R,
    /// Type change (e.g. a regular file became a symlink); the UI shows it as M
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
    /// In a partial clone the file content isn't local and couldn't be downloaded: added / deleted unavailable
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub no_stats: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeStatus {
    /// Changes to tracked files relative to HEAD (staged or not; the commit panel has no staging area concept)
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
    /// Function or struct name + starting line, e.g. `fn place · from line 88`
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
    /// Truncated for exceeding the line limit
    pub truncated: bool,
    /// A Git LFS file shown with its real content: it can only be committed whole (lines can't be picked)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub lfs: bool,
}

/// A local branch whose commits are all in another branch (a candidate for "clean up merged branches")
#[derive(Debug, Clone, Serialize)]
pub struct MergedBranch {
    pub name: String,
    pub head: String,
    /// Title of its latest commit
    pub title: String,
    pub time: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub favorite: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitDetail {
    pub commit: Commit,
    /// Changes relative to the first parent; a root commit relative to the empty tree
    pub files: Vec<FileChange>,
    /// Availability of each operation in spec §5.6
    pub caps: crate::commits::CommitCaps,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SelectedFile {
    pub path: String,
    /// For renames, also commit the deletion of the old path
    #[serde(default)]
    pub old_path: Option<String>,
    /// Whole file; when false, only commit the changed lines in `lines` (spec §4.3)
    #[serde(default = "yes")]
    pub whole: bool,
    /// A changed line to commit: line `line` of block `hunk` in `diff_worktree(path, keep whitespace, 3 lines of context)`
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
    /// Branches, tags or HEAD changed: refresh the log and branches
    Refs,
    /// Worktree or index changed: refresh the commit panel
    Status,
    /// Stashes changed (e.g. git stash on the command line): refresh the stash list, not the log
    Stash,
    /// The shelf changed: refresh the shelf list
    Shelf,
}

// ---------- Branches, remote branches, tags (spec §6) ----------

#[derive(Debug, Clone, Serialize)]
pub struct Branch {
    pub name: String,
    pub head: String,
    /// The tracked remote branch, e.g. `origin/main`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// Commits ahead of and behind the upstream; both 0 without an upstream
    pub ahead: u32,
    pub behind: u32,
    pub is_current: bool,
    /// Fully contained in the current branch; deleting it loses no commits
    pub merged: bool,
    /// Checked out in another worktree (that directory's path); can't be switched to here
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// Local history rewrote pushed commits (every remote-only commit has a same-content version locally): pushing needs a force push
    pub needs_force: bool,
    /// Why the current branch can't be rebased onto it (spec §6.3); empty when it can or it's unclear. Also empty for the current branch itself and when not on a branch
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebase_block: Option<String>,
    /// Favorite (spec §6.1): listed first in the branch tree and branch popup
    pub favorite: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteBranch {
    /// E.g. `origin/main`
    pub name: String,
    pub remote: String,
    pub head: String,
    /// Why the current branch can't be rebased onto it, same as `Branch::rebase_block`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebase_block: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Tag {
    pub name: String,
    /// The commit the tag points to
    pub at: String,
    /// Not pushed to origin yet (per the remote tags recorded at the last fetch); false if never fetched
    pub unpushed: bool,
    /// The message of an annotated tag (git tag -a); lightweight tags have none
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefsList {
    pub branches: Vec<Branch>,
    pub remotes: Vec<RemoteBranch>,
    pub tags: Vec<Tag>,
    pub head: Head,
    /// Worktrees (spec §6.6); the first is the main worktree
    pub worktrees: Vec<crate::worktrees::Worktree>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MergeResult {
    /// Already contained in the current branch, nothing done
    UpToDate,
    FastForward,
    Merged,
    /// Squash merge: its changes combined into one normal commit (one parent)
    Squashed,
}

/// Merge mode (`mode` in spec §6.7)
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MergeMode {
    /// Fast-forward when possible, otherwise create a merge commit
    #[default]
    Auto,
    /// Always create a merge commit (`--no-ff`)
    NoFf,
    /// Squash its changes into one commit (without recording it as a merge)
    Squash,
}

/// Pre-rebase check result (spec §6.3 "rebase onto a branch"), used by the UI for the confirmation dialog
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RebasePlan {
    pub branch: String,
    pub onto: String,
    /// Number of commits only on the current branch (to be rewritten)
    pub own: u32,
    /// How many of them were already pushed (in any remote branch); a force push is needed after rebasing when greater than 0
    pub pushed: u32,
    /// Commits on the target branch that the current branch doesn't have
    pub incoming: u32,
    /// Own commits include a merge commit: can't rebase
    pub has_merge: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RebaseOutcome {
    /// Already on top of the target branch, nothing done
    UpToDate,
    /// The current branch has no own commits; fast-forward straight to the target
    FastForward,
    Rebased,
}
