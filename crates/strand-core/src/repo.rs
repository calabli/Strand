//! Opening the repository and reading state and the log (read-only, with gix).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::error::{CoreError, ErrorCode, Result};
use crate::{git_cli, graph};
use crate::model::{
    Author, Commit, GraphRow, Head, HeadKind, LogPage, Ref, RefKind, RepoMode, RepoState,
};

/// Maximum rows returned per page, matching spec §15 "no more than 500 rows per batch".
pub const MAX_PAGE: usize = 500;

/// Generate a commit-graph in the background only at this many commits; small repositories walk fast anyway.
pub const COMMIT_GRAPH_MIN: usize = 2_000;

/// An open repository.
///
/// Opening only reads the log's "skeleton": each commit's id, parents and commit time, from which order and graph are computed.
/// Messages and authors are read per page in `log_page`, so opening a large repository doesn't decode every commit in full.
pub struct Session {
    pub(crate) repo: gix::ThreadSafeRepository,
    path: PathBuf,
    /// Commit ids in display order
    pub(crate) ids: Vec<gix::ObjectId>,
    /// id → position in `ids`
    pub(crate) index: HashMap<gix::ObjectId, u32>,
    /// Each row's parent rows (only parents present in the log)
    pub(crate) parents: Vec<Vec<u32>>,
    /// Each row's commit time (committer time), for sorting by time
    pub(crate) times: Vec<i64>,
    graph: Vec<GraphRow>,
    lanes: u32,
    pub(crate) refs: HashMap<gix::ObjectId, Vec<Ref>>,
    /// The branch and commit HEAD pointed to at the last read (used by `reload_if_changed` to decide whether to re-read; "unpushed" is relative to the current branch)
    loaded_head: (Option<String>, Option<gix::ObjectId>),
    /// Per row: reachable from HEAD
    pub(crate) head_reach: Vec<bool>,
    /// Per row: unpushed (reachable from HEAD but not in the upstream)
    pub(crate) unpushed: Vec<bool>,
    stats: LoadStats,
    /// Caches for filtering (authors, the last filter result, path hits), cleared when the log is re-read
    pub(crate) filter_cache: crate::log_filter::Cache,
    /// The op log (read from `.git/strand/oplog.json` on first use)
    pub(crate) oplog: crate::oplog::OpLog,
    /// Worktree status computed along with a write operation: handed over directly when the UI asks right after (used once, valid for 2 seconds; spec §15)
    pub(crate) status_cache: std::sync::Mutex<Option<(std::time::Instant, crate::model::WorktreeStatus)>>,
}

/// Time spent in each stage of the last log read (ms), for checking the performance targets in spec §15.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct LoadStats {
    pub refs_ms: f64,
    pub walk_ms: f64,
    pub order_ms: f64,
    pub layout_ms: f64,
    pub total_ms: f64,
    pub commits: usize,
    /// The walk used a commit-graph file
    pub commit_graph: bool,
}

impl Session {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let repo = gix::discover(path).map_err(|e| {
            CoreError::new(ErrorCode::NotARepo, "这个文件夹不是 Git 仓库")
                .with_detail(serde_json::json!({ "path": path.display().to_string(), "source": e.to_string() }))
        })?;
        let root = repo.workdir().unwrap_or_else(|| repo.git_dir()).to_path_buf();
        let mut s = Session {
            repo: repo.into_sync(),
            path: root,
            ids: Vec::new(),
            index: HashMap::new(),
            parents: Vec::new(),
            times: Vec::new(),
            graph: Vec::new(),
            lanes: 0,
            refs: HashMap::new(),
            head_reach: Vec::new(),
            unpushed: Vec::new(),
            stats: LoadStats::default(),
            filter_cache: Default::default(),
            oplog: Default::default(),
            status_cache: Default::default(),
            loaded_head: (None, None),
        };
        s.reload()?;
        if s.stats.commits >= COMMIT_GRAPH_MIN && (!s.stats.commit_graph || !has_changed_paths(s.repo.to_thread_local().objects.store_ref().path())) {
            s.write_commit_graph_in_background();
        }
        Ok(s)
    }

    /// When the repository has no commit-graph file, or has one without changed-path filters, generate one in the background with system git,
    /// making the next log read much faster (86k commits: the walk goes from about 800 ms to about 35 ms).
    /// With `--changed-paths`, path filtering and blame can skip commits that didn't touch the file
    /// (100k commits: path filtering from 6.5 s to 0.3 s, blame first screen from 650 ms to 270 ms).
    /// git keeps these filters when it rewrites the commit-graph itself later (fetch, gc).
    ///
    /// The commit-graph is only an acceleration cache that `git fetch` and `git gc` also generate;
    /// not generated when the repository sets `core.commitGraph = false`. Does nothing on failure.
    fn write_commit_graph_in_background(&self) {
        let repo = self.repo.to_thread_local();
        if repo.config_snapshot().boolean("core.commitGraph") == Some(false) {
            return;
        }
        let path = self.path.clone();
        std::thread::spawn(move || {
            let _ = git_cli::run(&path, &["commit-graph", "write", "--reachable", "--changed-paths"], None);
        });
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load_stats(&self) -> LoadStats {
        self.stats
    }

    /// Open a git2 handle on the same repository (for worktree status and diffs). Opening is cheap, so each call opens a new one.
    pub(crate) fn git2(&self) -> Result<git2::Repository> {
        git2::Repository::open(&self.path).map_err(|e| CoreError::git("打开仓库失败", e))
    }

    /// Read one commit in the log; `NOT_FOUND` when it isn't in the log (e.g. just rewritten by an external tool).
    pub(crate) fn find_logged(&self, id: &str) -> Result<Commit> {
        let not_found = || CoreError::new(ErrorCode::NotFound, "提交不存在，日志可能已经变化");
        let oid = gix::ObjectId::from_hex(id.as_bytes()).map_err(|_| not_found())?;
        if !self.index.contains_key(&oid) {
            return Err(not_found());
        }
        let repo = self.repo.to_thread_local();
        let c = repo.find_commit(oid).map_err(|_| not_found())?;
        let mut commit = to_commit(&c, self.refs.get(&oid))?;
        commit.unpushed = self.unpushed.get(self.index[&oid] as usize).copied().unwrap_or(false);
        Ok(commit)
    }

    /// Re-read the log and graph. Call after the repository changes (`refs` in `repo_changed`).
    /// Does nothing and returns false when refs and HEAD are the same as last time; otherwise re-reads and returns true.
    /// Used by refreshes triggered by file watching: Strand's own writes have already re-read, so the watcher's follow-up doesn't read again (saves hundreds of ms on repositories with tens of thousands of commits).
    pub fn reload_if_changed(&mut self) -> Result<bool> {
        let repo = self.repo.to_thread_local();
        let refs = collect_refs(&repo)?;
        if refs == self.refs && head_of(&repo) == self.loaded_head {
            return Ok(false);
        }
        self.reload()?;
        Ok(true)
    }

    pub fn reload(&mut self) -> Result<()> {
        let t0 = Instant::now();
        let mut repo = self.repo.to_thread_local();
        // The walk decompresses the same delta objects repeatedly; give it a cache
        repo.object_cache_size_if_unset(32 * 1024 * 1024);
        let refs = collect_refs(&repo)?;
        let mut tips: Vec<gix::ObjectId> = refs.keys().copied().collect();
        // The ref table is a HashMap with a different order each time; sort it so commits with the same time come out in a consistent order
        // (otherwise unchanged commits would look changed, and the filter cache and background path queries would restart for nothing)
        tips.sort_unstable();
        // Put HEAD first so the current branch wins among commits with the same time
        if let Ok(id) = repo.head_id() {
            tips.retain(|t| *t != id.detach());
            tips.insert(0, id.detach());
        }
        let refs_ms = ms(t0);

        // 1. Walk: only ids, parents and commit times
        let t1 = Instant::now();
        let mut walk_ids: Vec<gix::ObjectId> = Vec::new();
        let mut walk_parents: Vec<Vec<gix::ObjectId>> = Vec::new();
        let mut times: Vec<i64> = Vec::new();
        let commit_graph = repo.commit_graph_if_enabled().ok().flatten().is_some();
        if !tips.is_empty() {
            let walk = repo
                .rev_walk(tips)
                .sorting(gix::revision::walk::Sorting::ByCommitTime(
                    gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
                ))
                .use_commit_graph(true)
                .all()
                .map_err(|e| CoreError::git("读取提交历史失败", e))?;
            for info in walk {
                let info = info.map_err(|e| CoreError::git("读取提交历史失败", e))?;
                times.push(info.commit_time.unwrap_or(0));
                walk_parents.push(info.parent_ids.to_vec());
                walk_ids.push(info.id);
            }
        }
        let walk_ms = ms(t1);

        // 2. Sort: children before parents, the rest by time
        let t2 = Instant::now();
        let walk_index: HashMap<gix::ObjectId, u32> =
            walk_ids.iter().enumerate().map(|(i, id)| (*id, i as u32)).collect();
        let parents: Vec<Vec<u32>> = walk_parents
            .iter()
            .map(|ps| ps.iter().filter_map(|p| walk_index.get(p).copied()).collect())
            .collect();
        let order = date_order(&parents, &times);
        let mut pos = vec![0u32; order.len()];
        for (row, &i) in order.iter().enumerate() {
            pos[i as usize] = row as u32;
        }
        let ids: Vec<gix::ObjectId> = order.iter().map(|&i| walk_ids[i as usize]).collect();
        let row_parents: Vec<Vec<u32>> =
            order.iter().map(|&i| parents[i as usize].iter().map(|&p| pos[p as usize]).collect()).collect();
        let index: HashMap<gix::ObjectId, u32> = ids.iter().enumerate().map(|(i, id)| (*id, i as u32)).collect();
        let order_ms = ms(t2);

        // 3. Graph
        let t3 = Instant::now();
        let layout = graph::layout(&row_parents);
        let layout_ms = ms(t3);

        self.stats = LoadStats {
            refs_ms,
            walk_ms,
            order_ms,
            layout_ms,
            total_ms: ms(t0),
            commits: ids.len(),
            commit_graph,
        };
        // When commits are unchanged (e.g. a fetch with nothing new), keep the filter cache and don't restart background path filtering;
        // when only refs changed, filter results must be recomputed (branch filters depend on refs), but author info and path queries are still valid
        let same_commits = ids == self.ids;
        let same_refs = same_commits && refs == self.refs;
        self.times = order.iter().map(|&i| times[i as usize]).collect();
        self.parents = row_parents;
        self.ids = ids;
        self.index = index;
        if !same_commits {
            self.filter_cache = Default::default();
        } else if !same_refs {
            self.filter_cache.forget_results();
        }
        self.graph = layout.rows;
        self.lanes = layout.lanes;
        self.refs = refs;
        self.loaded_head = head_of(&repo);
        self.compute_reach();
        Ok(())
    }

    pub fn state(&self) -> Result<RepoState> {
        let repo = self.repo.to_thread_local();
        let head = repo.head().map_err(|e| CoreError::git("读取 HEAD 失败", e))?;
        let commit = head.id().map(|id| id.to_string());
        let head = if head.is_detached() {
            Head { kind: HeadKind::Detached, branch: None, commit }
        } else {
            let branch = head.referent_name().map(|n| n.shorten().to_string());
            let kind = if commit.is_some() { HeadKind::Branch } else { HeadKind::Unborn };
            Head { kind, branch, commit }
        };
        let in_progress = repo.state();
        let bisecting = matches!(in_progress, Some(gix::state::InProgress::Bisect)) || repo.git_dir().join("BISECT_START").exists();
        let state = match in_progress {
            None | Some(gix::state::InProgress::Bisect) if self.unstash_in_progress() => RepoMode::Unstashing,
            None | Some(gix::state::InProgress::Bisect) => RepoMode::Normal,
            Some(s) => {
                use gix::state::InProgress as P;
                match s {
                    P::Merge => RepoMode::Merging,
                    P::CherryPick | P::CherryPickSequence => RepoMode::CherryPicking,
                    P::Revert | P::RevertSequence => RepoMode::Reverting,
                    _ => RepoMode::Rebasing,
                }
            }
        };
        let name = self
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.path.display().to_string());
        let lfs = crate::lfs::uses_lfs(&self.path);
        let submodules = self.path.join(".gitmodules").is_file();
        Ok(RepoState { path: self.path.display().to_string(), name, head, state, bisecting, lfs, submodules })
    }

    /// The row of a commit (full hash, hash prefix, branch name or tag name) in the log, for jumping and locating.
    pub fn log_locate(&self, rev: &str) -> Option<usize> {
        let repo = self.repo.to_thread_local();
        let id = repo.rev_parse_single(rev).ok()?.object().ok()?.peel_to_commit().ok()?.id;
        self.index.get(&id).map(|&i| i as usize)
    }

    /// One page of the log (unfiltered, graph order). Commit contents for the page are only read and decoded here.
    pub fn log_page(&self, offset: usize, limit: usize) -> Result<LogPage> {
        let total = self.ids.len();
        let start = offset.min(total);
        let end = (start + limit.min(MAX_PAGE)).min(total);
        let rows = self.commits_at((start..end).map(|r| r as u32))?;
        Ok(LogPage { offset: start, rows, graph: self.graph[start..end].to_vec(), total, lanes: self.lanes, partial: false, folded: Vec::new() })
    }

    /// Read and decode the commit contents of some rows
    pub(crate) fn commits_at(&self, rows: impl Iterator<Item = u32>) -> Result<Vec<Commit>> {
        let repo = self.repo.to_thread_local();
        rows.map(|r| {
            let id = &self.ids[r as usize];
            let c = repo.find_commit(*id).map_err(|e| CoreError::git("读取提交失败", e))?;
            let mut commit = to_commit(&c, self.refs.get(id))?;
            commit.unpushed = self.unpushed.get(r as usize).copied().unwrap_or(false);
            Ok(commit)
        })
        .collect()
    }
}

/// Sort by the rules of `git log --date-order`: children always before parents, the rest by commit time, newest first.
/// Input is each commit's parent positions and time in walk order; returns the display order (a permutation of walk positions).
///
/// Sorting by time alone can put a parent before a child for commits within the same second (scripted commits, rebases), garbling the graph.
fn date_order(parents: &[Vec<u32>], times: &[i64]) -> Vec<u32> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    let n = parents.len();
    let mut children = vec![0u32; n];
    for ps in parents {
        for &p in ps {
            children[p as usize] += 1;
        }
    }
    // The heap top is the newest; ties go by walk order
    let mut heap: BinaryHeap<(i64, Reverse<u32>)> =
        (0..n as u32).filter(|&i| children[i as usize] == 0).map(|i| (times[i as usize], Reverse(i))).collect();
    let mut order = Vec::with_capacity(n);
    while let Some((_, Reverse(i))) = heap.pop() {
        order.push(i);
        for &p in &parents[i as usize] {
            children[p as usize] -= 1;
            if children[p as usize] == 0 {
                heap.push((times[p as usize], Reverse(p)));
            }
        }
    }
    order
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

/// Which refs sit on each commit (HEAD, local branches, remote branches, tags).
/// The branch HEAD points to (empty when detached) and the commit
fn head_of(repo: &gix::Repository) -> (Option<String>, Option<gix::ObjectId>) {
    let name = repo.head_name().ok().flatten().map(|n| n.as_bstr().to_string());
    (name, repo.head_id().ok().map(|i| i.detach()))
}

fn collect_refs(repo: &gix::Repository) -> Result<HashMap<gix::ObjectId, Vec<Ref>>> {
    let mut map: HashMap<gix::ObjectId, Vec<Ref>> = HashMap::new();
    let platform = repo.references().map_err(|e| CoreError::git("读取引用失败", e))?;
    let all = platform.all().map_err(|e| CoreError::git("读取引用失败", e))?;
    for r in all {
        let Ok(mut r) = r else { continue };
        let kind = match r.name().category() {
            Some(gix::reference::Category::LocalBranch) => RefKind::Branch,
            Some(gix::reference::Category::RemoteBranch) => RefKind::Remote,
            Some(gix::reference::Category::Tag) => RefKind::Tag,
            _ => continue,
        };
        let name = r.name().shorten().to_string();
        // The remote's HEAD symbolic ref (origin/HEAD) isn't shown separately
        if kind == RefKind::Remote && name.ends_with("/HEAD") {
            continue;
        }
        let Ok(commit) = r.peel_to_commit() else { continue };
        map.entry(commit.id).or_default().push(Ref { kind, name });
    }
    if let Ok(id) = repo.head_id() {
        let detached = repo.head().map(|h| h.is_detached()).unwrap_or(false);
        if detached {
            map.entry(id.detach()).or_default().insert(0, Ref { kind: RefKind::Head, name: "HEAD".into() });
        }
    }
    Ok(map)
}

fn to_commit(c: &gix::Commit<'_>, refs: Option<&Vec<Ref>>) -> Result<Commit> {
    let msg = c.message().map_err(|e| CoreError::git("读取提交说明失败", e))?;
    let title = msg.title.to_string().trim().to_string();
    let body = msg.body.map(|b| b.to_string().trim().to_string()).unwrap_or_default();
    let author = c.author().map_err(|e| CoreError::git("读取作者失败", e))?;
    let time = author.time().map(|t| t.seconds).unwrap_or(0);
    let parents: Vec<String> = c.parent_ids().map(|p| p.to_string()).collect();
    Ok(Commit {
        id: c.id.to_string(),
        is_merge: parents.len() > 1,
        unpushed: false,
        parents,
        title,
        body,
        author: Author { name: author.name.to_string(), email: author.email.to_string() },
        time,
        refs: refs.cloned().unwrap_or_default(),
    })
}

/// Whether the commit-graph has changed-path filters (BIDX chunk). `objects` is the objects directory.
fn has_changed_paths(objects: &Path) -> bool {
    let has = |f: &Path| {
        use std::io::Read;
        let mut head = vec![0u8; 4096];
        std::fs::File::open(f).and_then(|mut h| h.read(&mut head)).map(|n| head[..n].windows(4).any(|w| w == b"BIDX")).unwrap_or(false)
    };
    let single = objects.join("info").join("commit-graph");
    if single.exists() {
        return has(&single);
    }
    // Split commit-graph: every layer must have them
    let dir = objects.join("info").join("commit-graphs");
    let Ok(rd) = std::fs::read_dir(&dir) else { return false };
    let layers: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "graph")).collect();
    !layers.is_empty() && layers.iter().all(|p| has(p))
}

#[cfg(test)]
mod changed_paths_tests {
    use super::has_changed_paths;
    use std::process::Command;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn detects_changed_path_filters() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "--allow-empty", "-m", "x"]);
        let objects = p.join(".git/objects");
        assert!(!has_changed_paths(&objects), "还没有 commit-graph");
        git(p, &["commit-graph", "write", "--reachable"]);
        assert!(!has_changed_paths(&objects), "没带 --changed-paths");
        git(p, &["commit-graph", "write", "--reachable", "--changed-paths"]);
        assert!(has_changed_paths(&objects));
        // Split
        std::fs::remove_file(objects.join("info/commit-graph")).unwrap();
        git(p, &["commit-graph", "write", "--reachable", "--split", "--changed-paths"]);
        assert!(has_changed_paths(&objects));
    }
}
