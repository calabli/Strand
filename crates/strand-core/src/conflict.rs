//! 冲突解决（说明书第 8 节）。
//!
//! 核心层负责：读出有冲突的文件，按“原始 / 你的 / 对方的”三个版本切成上下文和修改块；
//! 按前端给的标记生成结果写回文件；完成、跳过、中止。
//! 标记本身由前端保存（含撤销、重做和“稍后继续”），核心层不保存标记状态，
//! 应用文件时由前端把这个文件的全部标记一次传进来。
//!
//! “你的”和“对方的”已按说明书 8.1 转换：变基时 git 的 ours 是目标分支，theirs 才是你的提交。

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::RepoMode;
use crate::{git_cli, Session};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    /// 取回贮藏或暂存架
    Unstash,
}

#[derive(Debug, Clone, Serialize)]
pub struct SideInfo {
    /// 分支名，或“你的提交”之类的说明
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RebaseStep {
    pub index: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    /// 文本文件，可以逐块处理
    Text,
    /// 一边修改、一边删除
    ModifyDelete,
    Binary,
    /// 锁文件：只能整文件选，建议用对方的
    Lock,
    /// 两边把同一个文件重命名成了不同的名字：只能选用哪一边的名字（和内容）
    Rename,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SideChange {
    Modified,
    Deleted,
    Added,
    Renamed,
}

/// 引入一个修改块的提交（说明书 8.10 的 Block.origin）：这一侧这几行最近一次是哪个提交改的
#[derive(Debug, Clone, Serialize)]
pub struct Origin {
    pub commit: String,
    pub author: String,
    /// Unix 秒
    pub time: i64,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
// 一个文件的修改块不多，不值得为了省内存把 Change 装进 Box
#[allow(clippy::large_enum_variant)]
pub enum Segment {
    /// 三方相同（或两边做了完全相同的修改）的内容
    Context { lines: Vec<String> },
    Change(Change),
}

#[derive(Debug, Clone, Serialize)]
pub struct Change {
    /// 文件内的编号，如 `c3`。文件的三个版本不变时编号稳定
    pub id: String,
    /// 原始内容（双方修改之前）
    pub base: Vec<String>,
    /// 这一侧改成的内容；为空表示这一侧没有改动
    pub mine: Option<Vec<String>>,
    pub theirs: Option<Vec<String>>,
    /// 引入这一侧这段内容的提交；这一侧没改动、只是删掉了几行、或没有提交（工作区）时为空
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mine_origin: Option<Origin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theirs_origin: Option<Origin>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictFile {
    pub path: String,
    pub kind: FileKind,
    pub mine_change: SideChange,
    pub theirs_change: SideChange,
    /// 只有文本文件有
    pub segments: Vec<Segment>,
    /// 已经解决（这次操作里有过冲突、现在没有了）：segments 为空
    pub resolved: bool,
    /// 重命名冲突：两边各自的新名字（path 是原来的名字）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mine_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theirs_path: Option<String>,
}

impl MergeSession {
    /// 还没解决的文件
    pub fn unresolved(&self) -> impl Iterator<Item = &ConflictFile> {
        self.files.iter().filter(|f| !f.resolved)
    }
}

/// 这次操作里出现过冲突的文件（`.git/strand/conflicts.json`），用来在列表里显示“已解决”的文件
#[derive(Debug, Default, Serialize, Deserialize)]
struct ConflictRecord {
    key: String,
    files: Vec<RecordedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecordedFile {
    path: String,
    kind: FileKind,
    mine_change: SideChange,
    theirs_change: SideChange,
    #[serde(default)]
    mine_path: Option<String>,
    #[serde(default)]
    theirs_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeSession {
    pub kind: SessionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<RebaseStep>,
    pub mine: SideInfo,
    pub theirs: SideInfo,
    /// 这次操作里有冲突的文件：还没解决的在前（按路径），已经解决的在后（resolved 为真）
    pub files: Vec<ConflictFile>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Mine,
    Theirs,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Mark {
    #[default]
    None,
    Accept,
    Discard,
}

/// 一处的标记。`custom` 是手动编辑的结果，有它时两侧都视为已处理。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChangeMark {
    #[serde(default)]
    pub mine: Mark,
    #[serde(default)]
    pub theirs: Mark,
    #[serde(default)]
    pub custom: Option<Vec<String>>,
}

/// `merge_finish` 和 `merge_skip` 的结果：要么整个操作完成，要么变基停在下一个有冲突的提交。
#[derive(Debug, Clone, Serialize)]
pub struct FinishResult {
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<MergeSession>,
}

const LOCK_FILES: &[&str] = &[
    "Cargo.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Gemfile.lock", "poetry.lock",
    "composer.lock", "go.sum", "Podfile.lock", "Package.resolved", "bun.lockb", "uv.lock",
];

impl Session {
    /// 当前的冲突会话；不在合并、变基、拣选、还原中时返回 `None`。
    pub fn merge_session(&self) -> Result<Option<MergeSession>> {
        let kind = match self.state()?.state {
            RepoMode::Normal => return Ok(None),
            RepoMode::Merging => SessionKind::Merge,
            RepoMode::Rebasing => SessionKind::Rebase,
            RepoMode::CherryPicking => SessionKind::CherryPick,
            RepoMode::Reverting => SessionKind::Revert,
            RepoMode::Unstashing => SessionKind::Unstash,
        };
        let repo = self.git2()?;
        let git_dir = repo.path().to_path_buf();
        let (mine, mut theirs, step) = sides(self.path(), &git_dir, kind);
        if kind == SessionKind::Unstash
            && let Some(u) = self.unstash()
        {
            theirs.label = u.label;
        }
        let swap = kind == SessionKind::Rebase;

        let index = repo.index().map_err(|e| CoreError::git("读取索引失败", e))?;
        let mut files = Vec::new();
        // 只有一个版本的条目：两边重命名成不同名字时，git 把原名（只有原始版本）、你的新名、对方的新名分成三条
        let mut lone: Vec<(usize, char, Vec<u8>)> = Vec::new();
        for c in index.conflicts().map_err(|e| CoreError::git("读取冲突失败", e))? {
            let Ok(c) = c else { continue };
            let (git_ours, git_theirs) = (c.our, c.their);
            let (m, t) = if swap { (git_theirs, git_ours) } else { (git_ours, git_theirs) };
            let path_bytes = m.as_ref().or(t.as_ref()).or(c.ancestor.as_ref()).map(|e| e.path.clone()).unwrap_or_default();
            let path = String::from_utf8_lossy(&path_bytes).into_owned();
            let blob = |e: &Option<git2::IndexEntry>| -> Option<Vec<u8>> {
                e.as_ref().and_then(|e| repo.find_blob(e.id).ok()).map(|b| b.content().to_vec())
            };
            let (base, mine_b, theirs_b) = (blob(&c.ancestor), blob(&m), blob(&t));
            let change = |side: &Option<Vec<u8>>| match (side, &base) {
                (None, _) => SideChange::Deleted,
                (Some(_), None) => SideChange::Added,
                (Some(_), Some(_)) => SideChange::Modified,
            };
            let (mine_change, theirs_change) = (change(&mine_b), change(&theirs_b));
            let name = path.rsplit('/').next().unwrap_or(&path);
            let kind = match (&mine_b, &theirs_b) {
                (None, _) | (_, None) => FileKind::ModifyDelete,
                (Some(a), Some(b)) if is_binary(a) || is_binary(b) => FileKind::Binary,
                _ if LOCK_FILES.contains(&name) => FileKind::Lock,
                _ => FileKind::Text,
            };
            let segments = if kind == FileKind::Text {
                let to_lines = |b: &Option<Vec<u8>>| lines_of(b.as_deref().unwrap_or(&[]));
                segments(&to_lines(&base), &to_lines(&mine_b), &to_lines(&theirs_b))
            } else {
                Vec::new()
            };
            match (&base, &mine_b, &theirs_b) {
                (Some(b), None, None) => lone.push((files.len(), 'b', b.clone())),
                (None, Some(m), None) => lone.push((files.len(), 'm', m.clone())),
                (None, None, Some(t)) => lone.push((files.len(), 't', t.clone())),
                _ => {}
            }
            files.push(ConflictFile { path, kind, mine_change, theirs_change, segments, resolved: false, mine_path: None, theirs_path: None });
        }
        let mut files = pair_renames(files, &lone);
        files.sort_by(|a, b| a.path.cmp(&b.path));
        // 每个修改块是哪个提交引入的（说明书 8.10 的 Block.origin）：在这一侧的提交上 blame
        let mine_rev = (kind != SessionKind::Unstash).then(|| mine.commit.clone()).flatten();
        let theirs_rev = matches!(kind, SessionKind::Merge | SessionKind::Rebase | SessionKind::CherryPick).then(|| theirs.commit.clone()).flatten();
        for f in files.iter_mut().filter(|f| f.kind == FileKind::Text) {
            self.fill_origins(f, mine_rev.as_deref(), theirs_rev.as_deref());
        }
        // 已经解决的文件：这次操作里记下过、现在没有冲突了
        let key = format!(
            "{:?}:{}:{}:{}",
            kind,
            mine.commit.as_deref().unwrap_or(""),
            theirs.commit.as_deref().unwrap_or(""),
            if kind == SessionKind::Unstash { self.unstash().map(|u| u.id).unwrap_or_default() } else { String::new() }
        );
        let resolved = self.record_conflicts(&key, &files);
        files.extend(resolved);
        Ok(Some(MergeSession { kind, step, mine, theirs, files }))
    }

    fn conflict_record_file(&self) -> Result<std::path::PathBuf> {
        Ok(self.strand_dir()?.join("conflicts.json"))
    }

    /// 把这次的冲突文件并进记录，返回记录里有、现在已经没有冲突的文件（标记为已解决）
    fn record_conflicts(&self, key: &str, current: &[ConflictFile]) -> Vec<ConflictFile> {
        let Ok(path) = self.conflict_record_file() else { return Vec::new() };
        let mut rec: ConflictRecord = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if rec.key != key {
            rec = ConflictRecord { key: key.to_string(), files: Vec::new() };
        }
        for f in current {
            if !rec.files.iter().any(|r| r.path == f.path) {
                rec.files.push(RecordedFile {
                    path: f.path.clone(),
                    kind: f.kind,
                    mine_change: f.mine_change,
                    theirs_change: f.theirs_change,
                    mine_path: f.mine_path.clone(),
                    theirs_path: f.theirs_path.clone(),
                });
            }
        }
        // git 在 MERGE_MSG 里记着这次一开始有冲突的文件（“# Conflicts:”下面）：Strand 打开之前就在命令行里解决了的也算上
        if !key.starts_with("Unstash")
            && let Ok(git_dir) = self.git2().map(|r| r.path().to_path_buf())
            && let Ok(msg) = std::fs::read_to_string(git_dir.join("MERGE_MSG"))
        {
            let listed: Vec<String> = msg
                .lines()
                .skip_while(|l| !l.starts_with("# Conflicts:"))
                .skip(1)
                .map_while(|l| l.strip_prefix("#\t").map(str::to_string))
                .collect();
            for p in listed {
                let known = rec.files.iter().any(|r| r.path == p || r.mine_path.as_deref() == Some(&p) || r.theirs_path.as_deref() == Some(&p));
                if !known {
                    rec.files.push(RecordedFile { path: p, kind: FileKind::Text, mine_change: SideChange::Modified, theirs_change: SideChange::Modified, mine_path: None, theirs_path: None });
                }
            }
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, serde_json::to_vec(&rec).unwrap_or_default());
        let mut done: Vec<ConflictFile> = rec
            .files
            .iter()
            .filter(|r| !current.iter().any(|f| f.path == r.path))
            .map(|r| ConflictFile {
                path: r.path.clone(),
                kind: r.kind,
                mine_change: r.mine_change,
                theirs_change: r.theirs_change,
                segments: Vec::new(),
                resolved: true,
                mine_path: r.mine_path.clone(),
                theirs_path: r.theirs_path.clone(),
            })
            .collect();
        done.sort_by(|a, b| a.path.cmp(&b.path));
        done
    }

    /// 操作结束（完成或中止）：清掉冲突记录
    pub(crate) fn clear_conflict_record(&self) {
        if let Ok(p) = self.conflict_record_file() {
            let _ = std::fs::remove_file(p);
        }
    }

    /// 在两边的提交上 blame 这个文件，给每个修改块找出引入它的提交（取这几行里最新的那个）
    fn fill_origins(&self, f: &mut ConflictFile, mine_rev: Option<&str>, theirs_rev: Option<&str>) {
        let blame = |rev: Option<&str>| -> Option<Vec<String>> {
            let rev = rev?;
            let out = git_cli::run(self.path(), &["blame", "--porcelain", rev, "--", &f.path], None).ok()?;
            let (lines, ids) = crate::blame::parse(&out);
            Some(lines.iter().map(|l| ids[l.commit as usize].clone()).collect())
        };
        let (mb, tb) = (blame(mine_rev), blame(theirs_rev));
        if mb.is_none() && tb.is_none() {
            return;
        }
        let repo = match self.git2() {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut cache: HashMap<String, Option<Origin>> = HashMap::new();
        let mut info = |id: &str| -> Option<Origin> {
            cache
                .entry(id.to_string())
                .or_insert_with(|| {
                    let c = repo.find_commit(git2::Oid::from_str(id).ok()?).ok()?;
                    Some(Origin {
                        commit: id.to_string(),
                        author: String::from_utf8_lossy(c.author().name_bytes()).into_owned(),
                        time: c.time().seconds(),
                        title: String::from_utf8_lossy(c.summary_bytes().unwrap_or_default()).into_owned(),
                    })
                })
                .clone()
        };
        // 一段行里最新的那个提交
        let mut newest = |by_line: &Option<Vec<String>>, from: usize, len: usize| -> Option<Origin> {
            let by_line = by_line.as_ref()?;
            let ids: Vec<String> = by_line.get(from..(from + len).min(by_line.len()))?.to_vec();
            ids.iter().filter_map(|id| info(id)).max_by_key(|o| o.time)
        };
        let (mut mi, mut ti) = (0usize, 0usize);
        for seg in &mut f.segments {
            match seg {
                Segment::Context { lines } => {
                    mi += lines.len();
                    ti += lines.len();
                }
                Segment::Change(c) => {
                    let mlen = c.mine.as_ref().map_or(c.base.len(), Vec::len);
                    let tlen = c.theirs.as_ref().map_or(c.base.len(), Vec::len);
                    if c.mine.as_ref().is_some_and(|v| !v.is_empty()) {
                        c.mine_origin = newest(&mb, mi, mlen);
                    }
                    if c.theirs.as_ref().is_some_and(|v| !v.is_empty()) {
                        c.theirs_origin = newest(&tb, ti, tlen);
                    }
                    mi += mlen;
                    ti += tlen;
                }
            }
        }
    }

    /// 按标记生成一个文本文件的结果，写回工作区并标记为已解决。
    /// 有修改块没标记时返回 `UNMARKED_BLOCKS`，`detail.ids` 是没标记完的那几处。
    pub fn merge_apply_file(&self, path: &str, marks: &HashMap<String, ChangeMark>) -> Result<()> {
        let session = self.merge_session()?.ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "现在没有要解决的冲突"))?;
        let file = session
            .unresolved()
            .find(|f| f.path == path)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("{path} 没有冲突，或已经解决")))?;
        if file.kind != FileKind::Text {
            return Err(CoreError::new(ErrorCode::InvalidRange, "这个文件只能整个接受一边"));
        }
        let mut out: Vec<String> = Vec::new();
        let mut unmarked = Vec::new();
        for seg in &file.segments {
            match seg {
                Segment::Context { lines } => out.extend(lines.iter().cloned()),
                Segment::Change(c) => {
                    let m = marks.get(&c.id).cloned().unwrap_or_default();
                    if let Some(custom) = m.custom {
                        out.extend(custom);
                        continue;
                    }
                    let mine_ok = c.mine.is_none() || m.mine != Mark::None;
                    let theirs_ok = c.theirs.is_none() || m.theirs != Mark::None;
                    if !mine_ok || !theirs_ok {
                        unmarked.push(c.id.clone());
                        continue;
                    }
                    out.extend(resolve(c, &m));
                }
            }
        }
        if !unmarked.is_empty() {
            return Err(CoreError::new(
                ErrorCode::UnmarkedBlocks,
                format!("这个文件还有 {} 处修改块没有标记，不能应用", unmarked.len()),
            )
            .with_detail(serde_json::json!({ "ids": unmarked })));
        }
        let mut text = out.join("\n");
        if !out.is_empty() && ends_with_newline(self.path(), path) {
            text.push('\n');
        }
        std::fs::write(self.path().join(path), text).map_err(|e| CoreError::git("写入文件失败", e))?;
        git_cli::run(self.path(), &["add", "--", path], None)?;
        Ok(())
    }

    /// 整个文件接受一边（说明书 8.7）。这一边删除了文件时，结果就是删除。
    pub fn merge_take_file(&self, path: &str, side: Side) -> Result<()> {
        let session = self.merge_session()?.ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "现在没有要解决的冲突"))?;
        let file = session
            .unresolved()
            .find(|f| f.path == path)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("{path} 没有冲突，或已经解决")))?;
        // 重命名冲突：留下选中那一边的新名字，另一个新名字和原名都去掉
        if file.kind == FileKind::Rename {
            let (keep, other) = match side {
                Side::Mine => (&file.mine_path, &file.theirs_path),
                Side::Theirs => (&file.theirs_path, &file.mine_path),
            };
            let (Some(keep), Some(other)) = (keep, other) else {
                return Err(CoreError::new(ErrorCode::InvalidRange, "重命名冲突缺少新名字"));
            };
            git_cli::run(self.path(), &["rm", "-q", "-f", "--ignore-unmatch", "--", other], None)?;
            git_cli::run(self.path(), &["rm", "-q", "--cached", "--ignore-unmatch", "--", path], None)?;
            let _ = std::fs::remove_file(self.path().join(path));
            git_cli::run(self.path(), &["add", "--", keep], None)?;
            return Ok(());
        }
        let deleted = match side {
            Side::Mine => file.mine_change == SideChange::Deleted,
            Side::Theirs => file.theirs_change == SideChange::Deleted,
        };
        if deleted {
            git_cli::run(self.path(), &["rm", "--quiet", "--", path], None)?;
            return Ok(());
        }
        // 变基时“你的”是 git 的 theirs
        let git_side = match (side, session.kind == SessionKind::Rebase) {
            (Side::Mine, false) | (Side::Theirs, true) => "--ours",
            _ => "--theirs",
        };
        git_cli::run(self.path(), &["checkout", git_side, "--", path], None)?;
        git_cli::run(self.path(), &["add", "--", path], None)?;
        Ok(())
    }

    /// 完成：所有文件都解决后提交（合并、拣选、还原）或继续变基。
    /// 变基停在下一个有冲突的提交时返回下一步的会话。
    pub fn merge_finish(&self) -> Result<FinishResult> {
        let session = self.merge_session()?.ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "现在没有要解决的冲突"))?;
        let open: Vec<&ConflictFile> = session.unresolved().collect();
        if !open.is_empty() {
            let blocks: usize = open
                .iter()
                .map(|f| f.segments.iter().filter(|s| matches!(s, Segment::Change(_))).count().max(1))
                .sum();
            return Err(CoreError::new(
                ErrorCode::UnmarkedBlocks,
                format!("还有 {} 个文件、{} 处修改块没有处理，不能完成", open.len(), blocks),
            )
            .with_detail(serde_json::json!({ "files": open.iter().map(|f| &f.path).collect::<Vec<_>>() })));
        }
        // 结果里不能残留冲突标记（说明书 8.8）
        if let Err(e) = git_cli::run(self.path(), &["diff", "--cached", "--check"], None) {
            let out = e.detail.as_ref().and_then(|d| d.get("stdout")).and_then(|s| s.as_str()).unwrap_or("").to_string();
            let hits: Vec<String> = out.lines().filter(|l| l.contains("conflict marker")).map(|l| l.split(": ").next().unwrap_or(l).to_string()).collect();
            if !hits.is_empty() {
                return Err(CoreError::new(ErrorCode::ConflictMarkers, format!("结果里还有冲突标记：{}", hits.join("、")))
                    .with_detail(serde_json::json!({ "places": hits })));
            }
        }
        let args: &[&str] = match session.kind {
            SessionKind::Unstash => {
                // 取回没有要继续的 git 命令：冲突都解决了就结束，按需删除条目
                self.unstash_finish()?;
                self.clear_conflict_record();
                return Ok(FinishResult { done: true, next: None });
            }
            // 压缩合并：结果提交成一个普通提交，不记成合并（说明书 6.7）
            SessionKind::Merge if self.squash_pending().is_some() => {
                self.squash_commit()?;
                self.clear_conflict_record();
                return Ok(FinishResult { done: true, next: None });
            }
            SessionKind::Merge => &["merge", "--continue"],
            SessionKind::CherryPick => &["cherry-pick", "--continue"],
            SessionKind::Revert => &["revert", "--continue"],
            SessionKind::Rebase => &["rebase", "--continue"],
        };
        self.continue_or_next(args)
    }

    /// 跳过当前这个提交（只用于变基）。
    pub fn merge_skip(&self) -> Result<FinishResult> {
        if self.state()?.state != RepoMode::Rebasing {
            return Err(CoreError::new(ErrorCode::InvalidRange, "只有变基时可以跳过提交"));
        }
        self.continue_or_next(&["rebase", "--skip"])
    }

    fn continue_or_next(&self, args: &[&str]) -> Result<FinishResult> {
        let r = git_cli::run(self.path(), args, None);
        // 变基继续后可能又停在冲突上：此时 git 返回失败，但这是正常的下一步
        let next = self.merge_session()?;
        match (r, next) {
            (_, Some(s)) if s.unresolved().next().is_some() => Ok(FinishResult { done: false, next: Some(s) }),
            (Ok(_), None) => {
                self.clear_conflict_record();
                Ok(FinishResult { done: true, next: None })
            }
            (Ok(_), Some(s)) => Ok(FinishResult { done: false, next: Some(s) }),
            (Err(e), _) => Err(e),
        }
    }
}

/// 一处的结果（说明书 8.6）。
fn resolve(c: &Change, m: &ChangeMark) -> Vec<String> {
    let take_m = c.mine.is_some() && m.mine == Mark::Accept;
    let take_t = c.theirs.is_some() && m.theirs == Mark::Accept;
    match (take_m, take_t) {
        (false, false) => c.base.clone(),
        (true, false) => c.mine.clone().unwrap_or_default(),
        (false, true) => c.theirs.clone().unwrap_or_default(),
        (true, true) => {
            let mut v = c.mine.clone().unwrap_or_default();
            v.extend(c.theirs.clone().unwrap_or_default());
            v
        }
    }
}

/// 三方合并：按原始内容的行把两边的改动对齐，重叠或相邻的改动合成一处。
fn segments(base: &[String], mine: &[String], theirs: &[String]) -> Vec<Segment> {
    // 每一侧的改动：原始内容里被替换的范围 [start, end)，以及替换成的行
    struct Edit<'a> {
        start: usize,
        end: usize,
        side: Side,
        lines: &'a [String],
    }
    let mut edits: Vec<Edit> = Vec::new();
    for (side, new) in [(Side::Mine, mine), (Side::Theirs, theirs)] {
        let ops = similar::capture_diff_slices(similar::Algorithm::Myers, base, new);
        for op in ops {
            if matches!(op.tag(), similar::DiffTag::Equal) {
                continue;
            }
            let (orng, nrng) = (op.old_range(), op.new_range());
            edits.push(Edit { start: orng.start, end: orng.end, side, lines: &new[nrng] });
        }
    }
    edits.sort_by_key(|e| (e.start, e.end));

    let mut out = Vec::new();
    let mut pos = 0usize;
    let mut i = 0usize;
    let mut n = 0usize;
    while i < edits.len() {
        // 合并重叠或相邻的改动（和 git 一样，紧挨着的两处改动也算一处）
        let start = edits[i].start;
        let mut end = edits[i].end;
        let mut j = i + 1;
        while j < edits.len() && edits[j].start <= end {
            end = end.max(edits[j].end);
            j += 1;
        }
        if start > pos {
            out.push(Segment::Context { lines: base[pos..start].to_vec() });
        }
        let group = &edits[i..j];
        // 某一侧在 [start, end) 范围里改成了什么
        let side_text = |side: Side| -> Option<Vec<String>> {
            let es: Vec<&Edit> = group.iter().filter(|e| e.side == side).collect();
            if es.is_empty() {
                return None;
            }
            let mut v = Vec::new();
            let mut p = start;
            for e in es {
                v.extend(base[p..e.start].iter().cloned());
                v.extend(e.lines.iter().cloned());
                p = e.end;
            }
            v.extend(base[p..end].iter().cloned());
            Some(v)
        };
        let (m, t) = (side_text(Side::Mine), side_text(Side::Theirs));
        if m.is_some() && m == t {
            // 两边做了一样的修改：不算冲突
            out.push(Segment::Context { lines: m.unwrap_or_default() });
        } else {
            n += 1;
            out.push(Segment::Change(Change { id: format!("c{n}"), base: base[start..end].to_vec(), mine: m, theirs: t, mine_origin: None, theirs_origin: None }));
        }
        pos = end;
        i = j;
    }
    if pos < base.len() {
        out.push(Segment::Context { lines: base[pos..].to_vec() });
    }
    // 相邻的上下文合并成一段
    let mut merged: Vec<Segment> = Vec::new();
    for s in out {
        match (merged.last_mut(), s) {
            (Some(Segment::Context { lines: a }), Segment::Context { lines: b }) => a.extend(b),
            (_, s) => merged.push(s),
        }
    }
    merged
}

/// 一个冲突文件的类型和冲突处数（拉取摘要面板用，说明书 7.2）。`None` 表示这一边没有这个文件。
/// 冲突处数只对文本文件有意义：两边都改了同一段的地方；其余类型为 0。
pub(crate) fn classify(path: &str, base: Option<&[u8]>, mine: Option<&[u8]>, theirs: Option<&[u8]>) -> (FileKind, u32) {
    let name = path.rsplit('/').next().unwrap_or(path);
    let kind = match (mine, theirs) {
        (None, _) | (_, None) => FileKind::ModifyDelete,
        (Some(a), Some(b)) if is_binary(a) || is_binary(b) => FileKind::Binary,
        _ if LOCK_FILES.contains(&name) => FileKind::Lock,
        _ => FileKind::Text,
    };
    if kind != FileKind::Text {
        return (kind, 0);
    }
    let n = segments(&lines_of(base.unwrap_or(&[])), &lines_of(mine.unwrap_or(&[])), &lines_of(theirs.unwrap_or(&[])))
        .iter()
        .filter(|s| matches!(s, Segment::Change(c) if c.mine.is_some() && c.theirs.is_some()))
        .count();
    (kind, n as u32)
}

fn lines_of(b: &[u8]) -> Vec<String> {
    let s = String::from_utf8_lossy(b);
    let s = s.strip_suffix('\n').unwrap_or(&s);
    if s.is_empty() && b.is_empty() {
        return Vec::new();
    }
    s.split('\n').map(str::to_string).collect()
}

fn is_binary(b: &[u8]) -> bool {
    b.iter().take(8000).any(|&c| c == 0)
}

/// 结果文件是否以换行结尾：沿用工作区里（带冲突标记的）文件，一般和两边一致。
fn ends_with_newline(root: &Path, path: &str) -> bool {
    std::fs::read(root.join(path)).map(|b| b.last() == Some(&b'\n')).unwrap_or(true)
}

/// 两边的说明，按场景转换（说明书 8.1）。
fn sides(dir: &Path, git_dir: &Path, kind: SessionKind) -> (SideInfo, SideInfo, Option<RebaseStep>) {
    let rev = |r: &str| -> (Option<String>, Option<String>) {
        match git_cli::run(dir, &["log", "-1", "--format=%H%x00%s", r], None) {
            Ok(s) => match s.trim().split_once('\0') {
                Some((h, t)) => (Some(h.to_string()), Some(t.to_string())),
                None => (None, None),
            },
            Err(_) => (None, None),
        }
    };
    let name_of = |r: &str| -> Option<String> {
        // 不用 origin/HEAD 这类符号引用，要真正的分支名
        git_cli::run(dir, &["name-rev", "--name-only", "--no-undefined", "--exclude=tags/*", "--exclude=*/HEAD", r], None)
            .ok()
            .map(|s| s.trim().trim_start_matches("remotes/").to_string())
            .filter(|s| !s.is_empty() && !s.contains('~') && !s.contains('^'))
    };
    let branch = git_cli::run(dir, &["branch", "--show-current"], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let info = |label: String, r: &str| {
        let (commit, title) = rev(r);
        SideInfo { label, commit, title }
    };
    let read = |f: &str| std::fs::read_to_string(git_dir.join(f)).ok().map(|s| s.trim().to_string());
    match kind {
        SessionKind::Merge => (
            info(branch.unwrap_or_else(|| "当前分支".into()), "HEAD"),
            info(name_of("MERGE_HEAD").unwrap_or_else(|| "要合并进来的提交".into()), "MERGE_HEAD"),
            None,
        ),
        SessionKind::CherryPick => (
            info(branch.unwrap_or_else(|| "当前分支".into()), "HEAD"),
            info("要拣选的提交".into(), "CHERRY_PICK_HEAD"),
            None,
        ),
        SessionKind::Revert => (
            info(branch.unwrap_or_else(|| "当前分支".into()), "HEAD"),
            info("要还原的提交".into(), "REVERT_HEAD"),
            None,
        ),
        SessionKind::Unstash => (
            SideInfo { label: "工作区".into(), commit: None, title: None },
            SideInfo { label: "取回的改动".into(), commit: None, title: None },
            None,
        ),
        SessionKind::Rebase => {
            let head_name = read("rebase-merge/head-name").or_else(|| read("rebase-apply/head-name"));
            let onto = read("rebase-merge/onto").or_else(|| read("rebase-apply/onto")).unwrap_or_else(|| "HEAD".into());
            let onto_name = name_of(&onto).unwrap_or_else(|| "目标分支".into());
            let step = match (read("rebase-merge/msgnum"), read("rebase-merge/end")) {
                (Some(i), Some(t)) => Some(RebaseStep { index: i.parse().unwrap_or(1), total: t.parse().unwrap_or(1) }),
                _ => None,
            };
            let mine_label = head_name
                .map(|h| format!("{} 上你的提交", h.trim_start_matches("refs/heads/")))
                .unwrap_or_else(|| "你的提交".into());
            (info(mine_label, "REBASE_HEAD"), info(onto_name, "HEAD"), step)
        }
    }
}

/// 两边把同一个文件重命名成不同名字：git 留下三条只有一个版本的条目（原名只有原始版本、
/// 你的新名只有你的、对方的新名只有对方的）。按内容相近程度配成一组，合成一个“重命名”冲突。
fn pair_renames(files: Vec<ConflictFile>, lone: &[(usize, char, Vec<u8>)]) -> Vec<ConflictFile> {
    let similar_enough = |a: &[u8], b: &[u8]| a == b || similar::TextDiff::from_lines(&*String::from_utf8_lossy(a), &*String::from_utf8_lossy(b)).ratio() >= 0.5;
    let mut used: Vec<usize> = Vec::new();
    let mut merged: Vec<ConflictFile> = Vec::new();
    for (bi, k, bb) in lone.iter().filter(|x| x.1 == 'b') {
        let _ = k;
        let pick = |want: char, used: &Vec<usize>| {
            lone.iter()
                .filter(|(i, c, _)| *c == want && !used.contains(i))
                .find(|(_, _, b)| similar_enough(bb, b))
                .map(|(i, _, _)| *i)
        };
        let (Some(mi), Some(ti)) = (pick('m', &used), pick('t', &used)) else { continue };
        used.extend([*bi, mi, ti]);
        merged.push(ConflictFile {
            path: files[*bi].path.clone(),
            kind: FileKind::Rename,
            mine_change: SideChange::Renamed,
            theirs_change: SideChange::Renamed,
            segments: Vec::new(),
            resolved: false,
            mine_path: Some(files[mi].path.clone()),
            theirs_path: Some(files[ti].path.clone()),
        });
    }
    files.into_iter().enumerate().filter(|(i, _)| !used.contains(i)).map(|(_, f)| f).chain(merged).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Vec<String> {
        if s.is_empty() { Vec::new() } else { s.split(',').map(str::to_string).collect() }
    }

    fn kinds(segs: &[Segment]) -> Vec<String> {
        segs.iter()
            .map(|s| match s {
                Segment::Context { lines } => format!("ctx{}", lines.len()),
                Segment::Change(c) => format!("{}{}", if c.mine.is_some() { "m" } else { "" }, if c.theirs.is_some() { "t" } else { "" }),
            })
            .collect()
    }

    #[test]
    fn splits_into_conflicts_and_one_sided_changes() {
        let base = v("a,b,c,d,e,f,g");
        let mine = v("a,B1,c,d,e,f,g2");
        let theirs = v("a,B2,c,d,E,f,g");
        let s = segments(&base, &mine, &theirs);
        // b 两边都改了（冲突）；e 只有对方改；g 只有你改
        assert_eq!(kinds(&s), vec!["ctx1", "mt", "ctx2", "t", "ctx1", "m"]);
        let Segment::Change(c) = &s[1] else { panic!() };
        assert_eq!((c.base.clone(), c.mine.clone().unwrap(), c.theirs.clone().unwrap()), (v("b"), v("B1"), v("B2")));
    }

    #[test]
    fn same_change_on_both_sides_is_context() {
        let s = segments(&v("a,b,c"), &v("a,X,c"), &v("a,X,c"));
        assert_eq!(kinds(&s), vec!["ctx3"]);
    }

    #[test]
    fn adjacent_edits_form_one_conflict() {
        // 你改了 b，对方改了紧挨着的 c：算一处冲突
        let s = segments(&v("a,b,c,d"), &v("a,B,c,d"), &v("a,b,C,d"));
        assert_eq!(kinds(&s), vec!["ctx1", "mt", "ctx1"]);
        let Segment::Change(c) = &s[1] else { panic!() };
        assert_eq!((c.mine.clone().unwrap(), c.theirs.clone().unwrap()), (v("B,c"), v("b,C")));
    }

    #[test]
    fn insertions_and_resolution() {
        let s = segments(&v("a,b"), &v("a,m1,b"), &v("a,t1,b"));
        let Segment::Change(c) = &s[1] else { panic!("{:?}", kinds(&s)) };
        assert!(c.base.is_empty());
        let mk = |m, t| ChangeMark { mine: m, theirs: t, custom: None };
        assert_eq!(resolve(c, &mk(Mark::Accept, Mark::Accept)), v("m1,t1"));
        assert_eq!(resolve(c, &mk(Mark::Discard, Mark::Accept)), v("t1"));
        assert_eq!(resolve(c, &mk(Mark::Discard, Mark::Discard)), Vec::<String>::new());
    }

    /// 说明书 8.6 结果表的每一行（未标记的两行由 `merge_apply_file` 拒绝，见 tests/conflict.rs）
    #[test]
    fn result_table_rows() {
        let s = segments(&v("a,b,c,d,e"), &v("a,M,c,d,e2"), &v("a,T,c,d,e"));
        let Segment::Change(both) = &s[1] else { panic!("{:?}", kinds(&s)) };
        let Segment::Change(one) = &s[3] else { panic!("{:?}", kinds(&s)) };
        assert!(one.theirs.is_none(), "e 只有你改：无冲突修改");
        let mk = |m, t| ChangeMark { mine: m, theirs: t, custom: None };
        use Mark::{Accept as A, Discard as D, None as N};
        assert_eq!(resolve(both, &mk(A, D)), v("M"), "接受/舍弃 → 你的");
        assert_eq!(resolve(both, &mk(D, A)), v("T"), "舍弃/接受 → 对方的");
        assert_eq!(resolve(both, &mk(A, A)), v("M,T"), "都接受 → 先你的再对方的");
        assert_eq!(resolve(both, &mk(D, D)), v("b"), "都舍弃 → 原始内容");
        assert_eq!(resolve(one, &mk(A, N)), v("e2"), "无冲突修改：接受");
        assert_eq!(resolve(one, &mk(D, N)), v("e"), "无冲突修改：舍弃");
    }
}
