//! 打开仓库、读取状态和日志（只读，用 gix）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::error::{CoreError, ErrorCode, Result};
use crate::{git_cli, graph};
use crate::model::{
    Author, Commit, GraphRow, Head, HeadKind, LogPage, Ref, RefKind, RepoMode, RepoState,
};

/// 每次分页最多返回的行数，和说明书第 15 节“单批不超过 500 行”一致。
pub const MAX_PAGE: usize = 500;

/// 提交数达到这个数量才在后台生成 commit-graph；小仓库遍历本来就很快。
pub const COMMIT_GRAPH_MIN: usize = 2_000;

/// 一个打开的仓库。
///
/// 打开时只读日志的“骨架”：每个提交的编号、父提交和提交时间，据此排好顺序、算好图谱。
/// 说明、作者这些内容在 `log_page` 按页读取，所以打开大仓库时不用解码每个提交的全部内容。
pub struct Session {
    pub(crate) repo: gix::ThreadSafeRepository,
    path: PathBuf,
    /// 按显示顺序排好的提交编号
    pub(crate) ids: Vec<gix::ObjectId>,
    /// 编号 → 在 `ids` 里的位置
    pub(crate) index: HashMap<gix::ObjectId, u32>,
    /// 每行的父提交所在行（只含日志里有的父提交）
    pub(crate) parents: Vec<Vec<u32>>,
    /// 每行的提交时间（committer time），按时间排序用
    pub(crate) times: Vec<i64>,
    graph: Vec<GraphRow>,
    lanes: u32,
    pub(crate) refs: HashMap<gix::ObjectId, Vec<Ref>>,
    /// 上次读取时 HEAD 指向的分支和提交（`reload_if_changed` 用来判断要不要重新读；“未推送”按当前分支算）
    loaded_head: (Option<String>, Option<gix::ObjectId>),
    /// 每行：从 HEAD 能到达
    pub(crate) head_reach: Vec<bool>,
    /// 每行：未推送（从 HEAD 能到达，但不在跟踪分支里）
    pub(crate) unpushed: Vec<bool>,
    stats: LoadStats,
    /// 过滤用的缓存（作者、上次的过滤结果、路径命中），日志重新读取时清空
    pub(crate) filter_cache: crate::log_filter::Cache,
    /// 操作日志（第一次用到时从 `.git/strand/oplog.json` 读入）
    pub(crate) oplog: crate::oplog::OpLog,
    /// 写操作结束时顺带算好的工作区状态：界面紧接着来要时直接给（只用一次，2 秒内有效；说明书 15）
    pub(crate) status_cache: std::sync::Mutex<Option<(std::time::Instant, crate::model::WorktreeStatus)>>,
}

/// 最近一次读取日志各阶段的耗时（毫秒），用来对照说明书第 15 节的性能目标。
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct LoadStats {
    pub refs_ms: f64,
    pub walk_ms: f64,
    pub order_ms: f64,
    pub layout_ms: f64,
    pub total_ms: f64,
    pub commits: usize,
    /// 遍历时用上了 commit-graph 文件
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

    /// 仓库没有 commit-graph 文件、或者有但不带“改过哪些路径”的过滤器时，在后台用系统 git 生成一份，
    /// 下次读取日志就能快很多（8.6 万提交的仓库：遍历从约 800 ms 降到约 35 ms）。
    /// 带上 `--changed-paths`：按路径过滤和逐行追溯能跳过没改过这个文件的提交
    /// （10 万提交的仓库：按路径过滤从 6.5 秒降到 0.3 秒，追溯首屏从 650 ms 降到 270 ms）。
    /// 之后 git 自己重写 commit-graph（抓取、gc）时会保留这些过滤器。
    ///
    /// commit-graph 只是加速用的缓存文件，`git fetch`、`git gc` 也会生成它；
    /// 仓库配置了 `core.commitGraph = false` 时不生成。失败时什么也不做。
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

    /// 打开同一个仓库的 git2 句柄（工作区状态、差异用）。打开很便宜，每次调用新开一个。
    pub(crate) fn git2(&self) -> Result<git2::Repository> {
        git2::Repository::open(&self.path).map_err(|e| CoreError::git("打开仓库失败", e))
    }

    /// 读取日志里的一个提交；不在日志里（比如刚被外部工具改写）返回 `NOT_FOUND`。
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

    /// 重新读取日志和图谱。仓库发生变化（`repo_changed` 的 `refs`）后调用。
    /// 引用和 HEAD 和上次读取时一样就什么都不做，返回假；否则重新读取，返回真。
    /// 文件监听触发的刷新用它：Strand 自己的写操作已经重新读过，监听紧接着又来一次时不用再读一遍（几万提交的仓库上省下几百毫秒）。
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
        // 遍历时会反复解压同一批增量对象，给一块缓存
        repo.object_cache_size_if_unset(32 * 1024 * 1024);
        let refs = collect_refs(&repo)?;
        let mut tips: Vec<gix::ObjectId> = refs.keys().copied().collect();
        // 引用表是 HashMap，顺序每次都不一样；排好序，同一时间的提交每次读出来的顺序才一致
        // （否则提交没变也会被当成变了，过滤缓存和后台的路径查询白白重来）
        tips.sort_unstable();
        // 让 HEAD 排在最前，同一时间的提交里当前分支优先
        if let Ok(id) = repo.head_id() {
            tips.retain(|t| *t != id.detach());
            tips.insert(0, id.detach());
        }
        let refs_ms = ms(t0);

        // 1. 遍历：只取编号、父提交和提交时间
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

        // 2. 排序：子提交在父提交前，其余按时间
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

        // 3. 图谱
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
        // 提交没变（如抓取了但没有新东西）时保留过滤缓存，正在后台跑的路径过滤也不用重来；
        // 只有引用变了时，过滤结果要重算（分支过滤按引用算），作者信息和路径查询还能用
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
        let state = match repo.state() {
            None if self.unstash_in_progress() => RepoMode::Unstashing,
            None => RepoMode::Normal,
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
        Ok(RepoState { path: self.path.display().to_string(), name, head, state })
    }

    /// 某个提交（完整哈希、哈希前缀、分支名或标签名）在日志里的行号，用来跳转和定位。
    pub fn log_locate(&self, rev: &str) -> Option<usize> {
        let repo = self.repo.to_thread_local();
        let id = repo.rev_parse_single(rev).ok()?.object().ok()?.peel_to_commit().ok()?.id;
        self.index.get(&id).map(|&i| i as usize)
    }

    /// 一页日志（不过滤、按图谱顺序）。这一页的提交内容在这里才读取和解码。
    pub fn log_page(&self, offset: usize, limit: usize) -> Result<LogPage> {
        let total = self.ids.len();
        let start = offset.min(total);
        let end = (start + limit.min(MAX_PAGE)).min(total);
        let rows = self.commits_at((start..end).map(|r| r as u32))?;
        Ok(LogPage { offset: start, rows, graph: self.graph[start..end].to_vec(), total, lanes: self.lanes, partial: false, folded: Vec::new() })
    }

    /// 读取并解码若干行的提交内容
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

/// 按 `git log --date-order` 的规则排序：子提交一定排在父提交前面，其余按提交时间从新到旧。
/// 输入是遍历顺序下每个提交的父提交位置和时间，返回显示顺序（遍历位置的排列）。
///
/// 只按时间排序时，同一秒内的提交（脚本批量提交、变基）可能出现父提交排在子提交前面，图谱会画乱。
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
    // 堆顶是时间最新的；时间相同时按遍历的先后
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

/// 每个提交上挂着哪些引用（HEAD、本地分支、远程分支、标签）。
/// HEAD 指向的分支（分离时为空）和提交
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
        // 远程的 HEAD 符号引用（origin/HEAD）不单独显示
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

/// commit-graph 里有没有“改过哪些路径”的过滤器（BIDX 块）。`objects` 是对象目录。
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
    // 分层的 commit-graph：每一层都要有
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
        // 分层的
        std::fs::remove_file(objects.join("info/commit-graph")).unwrap();
        git(p, &["commit-graph", "write", "--reachable", "--split", "--changed-paths"]);
        assert!(has_changed_paths(&objects));
    }
}
