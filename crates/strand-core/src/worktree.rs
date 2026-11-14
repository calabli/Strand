//! 工作区：状态、工作区差异、创建提交（说明书第 4 节）。

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::{FileDiff, RepoMode, Selection, WorktreeStatus};
use crate::{diff, git_cli, Session};

impl Session {
    /// 已跟踪文件相对 HEAD 的改动，以及未跟踪的文件。
    ///
    /// 大工作区上要快（说明书 15：文件变化后 300 ms 内反映到提交面板）：
    /// 先用系统 `git status` 找出哪些文件变了、哪些没跟踪（多线程，还会顺手把索引里过时的文件状态写回去；
    /// libgit2 不写回，文件的时间戳变了以后每次都要把全部文件读一遍，5 万个文件要 6 秒）；
    /// 再只对变了的这几个文件用 libgit2 算改动行数、识别重命名。`git status` 失败时退回全部用 libgit2。
    pub fn status(&self) -> Result<WorktreeStatus> {
        if let Some((at, st)) = self.status_cache.lock().ok().and_then(|mut c| c.take())
            && at.elapsed() < std::time::Duration::from_secs(2)
        {
            return Ok(st);
        }
        status_at(self.path(), None)
    }

    /// 某个文件的工作区内容相对 HEAD 的差异。未跟踪的文件显示为全部新增。
    pub fn diff_worktree(&self, path: &str, ignore_ws: bool, context: u32) -> Result<FileDiff> {
        let repo = self.git2()?;
        let head = head_tree(&repo);
        let mut opts = git2::DiffOptions::new();
        opts.pathspec(path)
            .disable_pathspec_match(true)
            .include_untracked(true)
            .show_untracked_content(true)
            .recurse_untracked_dirs(true)
            .ignore_whitespace(ignore_ws)
            .context_lines(context);
        let d = repo
            .diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut opts))
            .map_err(|e| CoreError::git("读取差异失败", e))?;
        diff::first_file(&d, path)
    }

    /// 按勾选的文件创建提交，返回新提交的版本号。
    ///
    /// 调用系统 `git commit --only`：只提交这些路径在工作区里的内容，不管暂存区里有什么，
    /// 也会照常运行钩子、签名和换行符转换。提交后需要调用 `reload` 刷新日志。
    pub fn commit_create(&self, message: &str, selection: &Selection, sign_off: bool, author: Option<&str>) -> Result<String> {
        let author = author.map(str::trim).filter(|a| !a.is_empty());
        if let Some(a) = author {
            crate::compose::check_ident(a)?;
        }
        if self.state()?.state != RepoMode::Normal {
            return Err(CoreError::new(ErrorCode::MergeInProgress, "合并还没完成，先解决冲突或中止拉取"));
        }
        if message.lines().next().map(str::trim).unwrap_or("").is_empty() {
            return Err(CoreError::new(ErrorCode::EmptyMessage, "先写一句提交说明"));
        }
        if selection.files.iter().any(|f| !f.whole) {
            return self.commit_partial(Some(message), selection, sign_off, author, false);
        }
        let mut paths: Vec<&str> = Vec::new();
        for f in &selection.files {
            paths.push(&f.path);
            if let Some(old) = &f.old_path {
                paths.push(old);
            }
        }
        if paths.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "至少勾选一个文件"));
        }
        let mut args = vec!["commit", "--only", "--quiet", "--file=-"];
        if sign_off {
            args.push("--signoff");
        }
        let author_arg = author.map(|a| format!("--author={a}"));
        if let Some(a) = &author_arg {
            args.push(a);
        }
        args.push("--");
        args.extend(paths);
        git_cli::run(self.path(), &args, Some(message))?;
        let id = git_cli::run(self.path(), &["rev-parse", "HEAD"], None)?;
        Ok(id.trim().to_string())
    }

    /// 修订上一次提交（说明书 4.5）：勾选的改动并入它；`message` 不为空时替换原说明，为空时保留原说明。
    /// 上一次提交已经推送时返回 `ALREADY_PUSHED`。没勾选文件时只改说明。
    pub fn commit_amend(&self, message: Option<&str>, selection: &Selection, sign_off: bool, author: Option<&str>) -> Result<String> {
        let author = author.map(str::trim).filter(|a| !a.is_empty());
        if let Some(a) = author {
            crate::compose::check_ident(a)?;
        }
        if self.state()?.state != RepoMode::Normal {
            return Err(CoreError::new(ErrorCode::MergeInProgress, "合并还没完成，先解决冲突或中止拉取"));
        }
        let head = self.git2()?.head().ok().and_then(|h| h.target()).ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "还没有提交，不能修订"))?;
        let cap = self.commit_caps(&head.to_string())?.reword;
        if !cap.ok {
            let why = cap.why.unwrap_or_default();
            let code = if why.contains("推送") { ErrorCode::AlreadyPushed } else { ErrorCode::InvalidRange };
            let msg = if code == ErrorCode::AlreadyPushed { "上一次提交已经推送，不能修订".to_string() } else { why };
            return Err(CoreError::new(code, msg));
        }
        let msg = message.filter(|m| !m.lines().next().unwrap_or("").trim().is_empty());
        if selection.files.is_empty() && msg.is_none() && author.is_none() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "勾选要并入的文件，或者写一段新的说明"));
        }
        if selection.files.iter().any(|f| !f.whole) {
            return self.commit_partial(msg, selection, sign_off, author, true);
        }
        let mut args = vec!["commit", "--amend", "--only", "--quiet"];
        args.push(if msg.is_some() { "--file=-" } else { "--no-edit" });
        if sign_off {
            args.push("--signoff");
        }
        let author_arg = author.map(|a| format!("--author={a}"));
        if let Some(a) = &author_arg {
            args.push(a);
        }
        args.push("--");
        for f in &selection.files {
            args.push(&f.path);
            if let Some(old) = &f.old_path {
                args.push(old);
            }
        }
        git_cli::run(self.path(), &args, msg)?;
        let id = git_cli::run(self.path(), &["rev-parse", "HEAD"], None)?;
        Ok(id.trim().to_string())
    }
}

impl Session {
    /// 有文件只提交一部分行：在一个临时索引里按 HEAD 搭好要提交的内容再提交，
    /// 真正的索引和工作区不动（只把提交过的路径在索引里同步到新 HEAD），没勾的行留在工作区。
    /// `amend` 为真时修订上一次提交；`message` 为空时保留原说明（只用于修订）。
    fn commit_partial(&self, message: Option<&str>, selection: &Selection, sign_off: bool, author: Option<&str>, amend: bool) -> Result<String> {
        let repo = self.git2()?;
        let dir = repo.path().join("strand");
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::git("准备提交失败", e))?;
        let tmp = dir.join("commit-index");
        let _ = std::fs::remove_file(&tmp);
        let r = self.build_partial_index(&repo, &tmp, selection).and_then(|paths| {
            let idx = tmp.to_string_lossy().to_string();
            let mut args = vec!["commit", "--quiet"];
            if amend {
                args.push("--amend");
            }
            args.push(if message.is_some() { "--file=-" } else { "--no-edit" });
            if sign_off {
                args.push("--signoff");
            }
            let author_arg = author.map(|a| format!("--author={a}"));
            if let Some(a) = &author_arg {
                args.push(a);
            }
            git_cli::run_env(self.path(), &args, message, &[("GIT_INDEX_FILE", idx.as_str())])?;
            // 真正的索引里，提交过的路径对齐到新 HEAD；部分提交的文件剩下的改动留在工作区
            let mut reset = vec!["reset", "--quiet", "--"];
            reset.extend(paths.iter().map(String::as_str));
            let _ = git_cli::run(self.path(), &reset, None);
            let id = git_cli::run(self.path(), &["rev-parse", "HEAD"], None)?;
            Ok(id.trim().to_string())
        });
        let _ = std::fs::remove_file(&tmp);
        r
    }

    /// 临时索引：HEAD 的内容 + 整文件勾选的改动 + 部分勾选的行。返回涉及的路径。
    fn build_partial_index(&self, repo: &git2::Repository, tmp: &std::path::Path, selection: &Selection) -> Result<Vec<String>> {
        let err = |e: git2::Error| CoreError::git("准备提交失败", e);
        let handle = git2::Repository::open(repo.path()).map_err(err)?;
        let mut idx = git2::Index::open(tmp).map_err(err)?;
        if let Some(t) = head_tree(repo) {
            idx.read_tree(&t).map_err(err)?;
        }
        handle.set_index(&mut idx).map_err(err)?;
        let mut idx = handle.index().map_err(err)?;
        let mut paths = Vec::new();
        let whole: Vec<String> = selection
            .files
            .iter()
            .filter(|f| f.whole)
            .flat_map(|f| std::iter::once(f.path.clone()).chain(f.old_path.clone()))
            .collect();
        if !whole.is_empty() {
            idx.add_all(whole.iter(), git2::IndexAddOption::DEFAULT, None).map_err(err)?;
            idx.update_all(whole.iter(), None).map_err(err)?;
            paths.extend(whole);
        }
        for f in selection.files.iter().filter(|f| !f.whole) {
            let content = self.partial_content(repo, &f.path, &f.lines)?;
            let mode = idx.get_path(std::path::Path::new(&f.path), 0).map(|e| e.mode).unwrap_or(0o100644);
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: git2::Oid::ZERO_SHA1,
                flags: (f.path.len().min(0xfff)) as u16,
                flags_extended: 0,
                path: f.path.as_bytes().to_vec(),
            };
            idx.add_frombuffer(&entry, &content).map_err(err)?;
            paths.push(f.path.clone());
        }
        if paths.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "至少勾选一个文件"));
        }
        idx.write().map_err(err)?;
        Ok(paths)
    }

    /// 只带上选中改动行的文件内容：从 HEAD 的版本出发，丢掉选中的删除行、加上选中的新增行。
    /// 用原文件的字节拼，保留换行符和文件末尾有没有换行。
    fn partial_content(&self, repo: &git2::Repository, path: &str, picked: &[crate::model::LineRef]) -> Result<Vec<u8>> {
        let diff = self.diff_worktree(path, false, 3)?;
        if diff.binary {
            return Err(CoreError::new(ErrorCode::InvalidRange, format!("{path} 是二进制文件，只能整个文件提交")));
        }
        let changed = |h: usize, l: usize| picked.iter().any(|p| p.hunk as usize == h && p.line as usize == l);
        let any = diff.hunks.iter().enumerate().any(|(h, hk)| {
            hk.lines.iter().enumerate().any(|(l, x)| x.kind != crate::model::LineKind::Context && changed(h, l))
        });
        if !any {
            return Err(CoreError::new(ErrorCode::NothingSelected, format!("{path} 没有勾选任何改动行")));
        }
        let old: Vec<u8> = head_tree(repo)
            .and_then(|t| t.get_path(std::path::Path::new(path)).ok())
            .and_then(|e| repo.find_blob(e.id()).ok())
            .map(|b| b.content().to_vec())
            .ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, format!("{path} 不是已修改的文件，只能整个文件提交")))?;
        let new = std::fs::read(self.path().join(path)).map_err(|e| CoreError::git("读取文件失败", e))?;
        let old_lines: Vec<&[u8]> = old.split_inclusive(|&b| b == b'\n').collect();
        let new_lines: Vec<&[u8]> = new.split_inclusive(|&b| b == b'\n').collect();
        let stale = || CoreError::new(ErrorCode::InvalidRange, format!("{path} 已经变了，请重新勾选要提交的行"));
        let mut out: Vec<u8> = Vec::with_capacity(old.len());
        let mut next = 1usize; // 下一行要复制的 HEAD 行号
        let copy_to = |out: &mut Vec<u8>, next: &mut usize, upto: usize| -> Result<()> {
            while *next < upto {
                out.extend_from_slice(old_lines.get(*next - 1).ok_or_else(stale)?);
                *next += 1;
            }
            Ok(())
        };
        for (h, hunk) in diff.hunks.iter().enumerate() {
            for (l, line) in hunk.lines.iter().enumerate() {
                match line.kind {
                    crate::model::LineKind::Context => {
                        let o = line.old_no.ok_or_else(stale)? as usize;
                        copy_to(&mut out, &mut next, o + 1)?;
                    }
                    crate::model::LineKind::Del => {
                        let o = line.old_no.ok_or_else(stale)? as usize;
                        copy_to(&mut out, &mut next, o)?;
                        if !changed(h, l) {
                            out.extend_from_slice(old_lines.get(o - 1).ok_or_else(stale)?);
                        }
                        next = o + 1;
                    }
                    crate::model::LineKind::Add => {
                        if changed(h, l) {
                            let n = line.new_no.ok_or_else(stale)? as usize;
                            let mut bytes = new_lines.get(n - 1).ok_or_else(stale)?.to_vec();
                            // 新增行放在一行没有换行结尾的旧行后面时，补上换行
                            if out.last().is_some_and(|&b| b != b'\n') {
                                out.push(b'\n');
                            }
                            if !bytes.ends_with(b"\n") && next <= old_lines.len() {
                                bytes.push(b'\n');
                            }
                            out.extend_from_slice(&bytes);
                        }
                    }
                }
            }
        }
        copy_to(&mut out, &mut next, old_lines.len() + 1)?;
        Ok(out)
    }

    /// 丢弃这些文件的改动，回到 HEAD 的样子（说明书 4.7 回滚、4.1 文件行的丢弃图标）。新增的文件会被删除。
    pub fn changes_discard(&self, paths: &[String]) -> Result<()> {
        if self.state()?.state != RepoMode::Normal {
            return Err(CoreError::new(ErrorCode::MergeInProgress, "合并还没完成，先解决冲突或中止"));
        }
        if paths.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "至少勾选一个文件"));
        }
        let mut args = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
        args.extend(paths.iter().map(String::as_str));
        git_cli::run(self.path(), &args, None).map(|_| ())
    }

    /// 未跟踪的文件：加入版本控制
    pub fn untracked_add(&self, path: &str) -> Result<()> {
        git_cli::run(self.path(), &["add", "--", path], None).map(|_| ())
    }

    /// 未跟踪的文件：把路径追加到仓库根目录的 .gitignore
    pub fn untracked_ignore(&self, path: &str) -> Result<()> {
        let f = self.path().join(".gitignore");
        let mut text = std::fs::read_to_string(&f).unwrap_or_default();
        let line = format!("/{}", path.trim_start_matches('/'));
        if text.lines().any(|l| l.trim() == line) {
            return Ok(());
        }
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&line);
        text.push('\n');
        std::fs::write(&f, text).map_err(|e| CoreError::git("写入 .gitignore 失败", e))
    }

    /// 未跟踪的文件：移到系统废纸篓（不直接删除）
    pub fn untracked_delete(&self, path: &str) -> Result<()> {
        let full = self.path().join(path);
        if !full.starts_with(self.path()) || path.contains("..") {
            return Err(CoreError::new(ErrorCode::InvalidRange, "路径不对"));
        }
        trash::delete(&full).map_err(|e| CoreError::git("移到废纸篓失败", e))
    }
}

/// 工作区状态（见 [`Session::status`]）。不借用会话，写操作结束时可以和别的事同时算。
/// `git status --porcelain=v2 -z --untracked-files=all --no-renames`：工作区状态和操作快照都从它出发（说明书 15）
pub(crate) fn porcelain(path: &std::path::Path) -> Option<String> {
    git_cli::run(path, &["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"], None).ok()
}

pub(crate) fn status_at(path: &std::path::Path, pre: Option<&str>) -> Result<WorktreeStatus> {
    let repo = git2::Repository::open(path).map_err(|e| CoreError::git("打开仓库失败", e))?;
    // 裸仓库没有工作区
    if repo.is_bare() {
        return Ok(WorktreeStatus { changes: Vec::new(), untracked: Vec::new() });
    }
    let quick = match pre {
        Some(out) => Some(parse_porcelain_v2(out)),
        None => porcelain(path).map(|out| parse_porcelain_v2(&out)),
    };
    let head = head_tree(&repo);
    let mut opts = git2::DiffOptions::new();
    opts.include_typechange(true);
    let untracked_from_cli = match &quick {
        Some((changed, untracked)) => {
            if changed.is_empty() {
                let mut untracked = untracked.clone();
                untracked.sort();
                return Ok(WorktreeStatus { changes: Vec::new(), untracked });
            }
            for p in changed {
                opts.pathspec(p);
            }
            opts.disable_pathspec_match(true);
            Some(untracked.clone())
        }
        None => {
            opts.include_untracked(true).recurse_untracked_dirs(true);
            None
        }
    };
    let mut d = repo
        .diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut opts))
        .map_err(|e| CoreError::git("读取工作区状态失败", e))?;
    find_renames(&mut d)?;
    let mut untracked = Vec::new();
    let mut changes = diff::files(&d, &mut untracked)?;
    if let Some(u) = untracked_from_cli {
        untracked = u;
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    untracked.sort();
    Ok(WorktreeStatus { changes, untracked })
    }

/// 解析 `git status --porcelain=v2 -z --no-renames`：返回（已跟踪且有变化的路径，未跟踪的路径）。
/// 条目之间用 NUL 分隔；普通条目“1 XY sub mH mI mW hH hI 路径”，冲突条目“u XY sub m1 m2 m3 mW h1 h2 h3 路径”，未跟踪“? 路径”。
fn parse_porcelain_v2(out: &str) -> (Vec<String>, Vec<String>) {
    let (mut changed, mut untracked) = (Vec::new(), Vec::new());
    for e in out.split('\0').filter(|e| !e.is_empty()) {
    match e.as_bytes()[0] {
        b'1' => {
            if let Some(p) = e.splitn(9, ' ').nth(8) {
                changed.push(p.to_string());
            }
        }
        b'u' => {
            if let Some(p) = e.splitn(11, ' ').nth(10) {
                changed.push(p.to_string());
            }
        }
        b'?' => untracked.push(e[2..].to_string()),
        _ => {}
    }
    }
    (changed, untracked)
}

fn head_tree(repo: &git2::Repository) -> Option<git2::Tree<'_>> {
    repo.head().ok().and_then(|h| h.peel_to_tree().ok())
}

pub(crate) fn find_renames(d: &mut git2::Diff<'_>) -> Result<()> {
    let mut fo = git2::DiffFindOptions::new();
    fo.renames(true);
    d.find_similar(Some(&mut fo)).map_err(|e| CoreError::git("识别重命名失败", e))
}
