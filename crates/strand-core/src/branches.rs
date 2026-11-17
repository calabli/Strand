//! Branches and tags (spec §6).
//!
//! Reads use git2; all writes call system git, so hooks, config and behavior match the command line exactly.

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::{Branch, MergeMode, MergeResult, MergedBranch, RebaseOutcome, RebasePlan, RefsList, RemoteBranch, RepoMode, Tag};
use crate::{git_cli, Session};

impl Session {
    /// Local branches, remote branches, tags and HEAD.
    pub fn refs_list(&self) -> Result<RefsList> {
        let repo = self.git2()?;
        let head_oid = repo.head().ok().and_then(|h| h.target());
        let current = repo
            .head()
            .ok()
            .filter(|h| h.is_branch())
            .and_then(|h| h.shorthand().ok().map(str::to_string));

        let favs = self.favorites();
        // Merged-or-not and can-rebase are computed on the in-memory commit graph (spec §15): libgit2's ancestry check on 100k commits
        // walks far for every branch, taking 1.7 s for 21 branches; in memory, the set reachable from HEAD is computed once
        let head_row = self.head_row();
        let head_reach = head_row.map(|r| self.reach(vec![r]));
        let row_of = |o: git2::Oid| gix::ObjectId::from_hex(o.to_string().as_bytes()).ok().and_then(|g| self.index.get(&g).copied());
        let mut branches = Vec::new();
        for b in repo.branches(Some(git2::BranchType::Local)).map_err(|e| CoreError::git("读取分支失败", e))? {
            let Ok((b, _)) = b else { continue };
            let Some(name) = b.name().ok().flatten().map(str::to_string) else { continue };
            let Some(oid) = b.get().target() else { continue };
            let up = b.upstream().ok();
            let upstream = up.as_ref().and_then(|u| u.name().ok().flatten().map(str::to_string));
            let (ahead, behind) = match up.as_ref().and_then(|u| u.get().target()) {
                Some(u) => repo.graph_ahead_behind(oid, u).unwrap_or((0, 0)),
                None => (0, 0),
            };
            // Every remote-only commit has a rewritten version locally: local history rewrote already-pushed commits (spec §6.3, §10.3)
            let needs_force = behind > 0
                && upstream.as_deref().is_some_and(|u| {
                    crate::remote::rewritten(self.path(), &format!("refs/heads/{name}"), &format!("refs/remotes/{u}"))
                });
            let merged = match (head_oid, &head_reach, row_of(oid)) {
                (Some(h), _, _) if h == oid => true,
                (Some(_), Some(reach), Some(r)) => reach[r as usize],
                (Some(h), _, _) => repo.graph_descendant_of(h, oid).unwrap_or(false),
                (None, _, _) => false,
            };
            let favorite = favs.contains(&name);
            branches.push(Branch {
                is_current: current.as_deref() == Some(&name),
                name,
                head: oid.to_string(),
                upstream,
                ahead: ahead as u32,
                behind: behind as u32,
                merged,
                worktree: None,
                needs_force,
                rebase_block: None,
                favorite,
            });
        }
        branches.sort_by(|a, b| a.name.cmp(&b.name));

        let mut remotes = Vec::new();
        for b in repo.branches(Some(git2::BranchType::Remote)).map_err(|e| CoreError::git("读取远程分支失败", e))? {
            let Ok((b, _)) = b else { continue };
            let Some(name) = b.name().ok().flatten().map(str::to_string) else { continue };
            if name.ends_with("/HEAD") {
                continue;
            }
            let Some(oid) = b.get().target() else { continue };
            let remote = name.split('/').next().unwrap_or("").to_string();
            remotes.push(RemoteBranch { name, remote, head: oid.to_string(), rebase_block: None });
        }
        remotes.sort_by(|a, b| a.name.cmp(&b.name));

        let mut tags = Vec::new();
        if let Ok(names) = repo.tag_names(None) {
            for n in names.iter().flatten().flatten() {
                let Ok(r) = repo.find_reference(&format!("refs/tags/{n}")) else { continue };
                let Ok(c) = r.peel_to_commit() else { continue };
                let message = r.peel_to_tag().ok().and_then(|t| t.message().ok().flatten().map(|m| m.trim().to_string()));
                tags.push(Tag { name: n.to_string(), at: c.id().to_string(), unpushed: false, message });
            }
        }
        tags.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(unpushed) = crate::remote::unpushed_tags(self.path()) {
            for t in &mut tags {
                t.unpushed = unpushed.binary_search(&t.name).is_ok();
            }
        }

        // Rebase availability is computed up front so the menu can grey it out (spec §6.3); matches the checks in branch_rebase
        if let (Some(cur), Some(h)) = (current.as_deref(), head_oid) {
            let block = |head: &str, name: &str| -> Option<String> {
                let o = git2::Oid::from_str(head).ok()?;
                match (&head_reach, row_of(o)) {
                    (Some(reach), Some(r)) => self.rebase_block_rows(reach, r, cur, name),
                    _ => rebase_block(&repo, h, o, cur, name),
                }
            };
            for b in branches.iter_mut().filter(|b| b.name != cur) {
                b.rebase_block = block(&b.head, &b.name);
            }
            for r in &mut remotes {
                r.rebase_block = block(&r.head, &r.name);
            }
        }

        // Failing to read the worktree list (e.g. git too old) doesn't affect anything else
        let worktrees = self.worktree_list().unwrap_or_default();
        for b in &mut branches {
            b.worktree = worktrees.iter().find(|w| !w.is_current && w.branch.as_deref() == Some(&b.name)).map(|w| w.path.clone());
        }
        Ok(RefsList { branches, remotes, tags, head: self.state()?.head, worktrees })
    }

    /// Create a branch, from the current position when `at` is empty; switch to it after creating when `checkout` is true.
    pub fn branch_create(&self, name: &str, at: Option<&str>, checkout: bool) -> Result<()> {
        self.check_branch_name(name)?;
        if checkout {
            self.require_normal()?;
        }
        let mut args = vec![if checkout { "switch" } else { "branch" }];
        if checkout {
            args.push("--create");
        }
        args.push(name);
        if let Some(at) = at {
            args.push(at);
        }
        self.git(&args)
    }

    /// Switch branches. Returns `WORKTREE_CONFLICT` when worktree changes would be overwritten, with the conflicting files in `detail.files`;
    /// when `stash_first` is true, stash the changes (including untracked files) first and then switch; the stash is not restored automatically.
    pub fn branch_switch(&self, name: &str, stash_first: bool) -> Result<()> {
        self.require_normal()?;
        // A branch checked out in another worktree can't be switched to; say so first instead of stashing for nothing
        if let Some(w) = self.worktree_list().unwrap_or_default().iter().find(|w| !w.is_current && w.branch.as_deref() == Some(name)) {
            return Err(CoreError::new(ErrorCode::InvalidRange, format!("分支 {name} 已经在工作目录 {} 里检出，同一个分支不能同时检出两次", w.path))
                .with_detail(serde_json::json!({ "worktree": w.path })));
        }
        if stash_first {
            let msg = format!("Strand：切换到 {name} 前自动贮藏");
            self.git(&["stash", "push", "--include-untracked", "--message", &msg])?;
        }
        self.git(&["switch", name]).map_err(|e| crate::worktrees::checked_out_elsewhere(worktree_conflict(e, name), name))
    }

    pub fn branch_rename(&self, name: &str, new_name: &str) -> Result<()> {
        if name != new_name {
            self.check_branch_name(new_name)?;
        }
        self.git(&["branch", "--move", name, new_name])?;
        // The favorite follows the new name; the old name stays so it is still a favorite after undoing the rename
        if self.favorites().iter().any(|f| f == name) {
            self.set_favorite(new_name, true)?;
        }
        Ok(())
    }

    // ---------- Favorites (spec §6.1, §6.3) ----------

    /// Favorites live in `<common .git>/strand/favorites`, one branch name per line, shared between worktrees.
    /// Deleting a branch keeps its line (so it is still a favorite after undoing the delete); names of branches that no longer exist have no effect.
    fn favorites_file(&self) -> Result<std::path::PathBuf> {
        Ok(self.git2()?.commondir().join("strand").join("favorites"))
    }

    /// Favorite branch names
    pub fn favorites(&self) -> Vec<String> {
        self.favorites_file()
            .ok()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .map(|t| t.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
            .unwrap_or_default()
    }

    /// Add or remove a local branch from favorites. Not recorded in the op log (it only affects display order).
    pub fn set_favorite(&self, name: &str, favorite: bool) -> Result<()> {
        let mut list = self.favorites();
        let had = list.iter().any(|f| f == name);
        if favorite == had {
            return Ok(());
        }
        if favorite {
            if self.git2()?.find_branch(name, git2::BranchType::Local).is_err() {
                return Err(CoreError::new(ErrorCode::NotFound, format!("分支 {name} 不存在")));
            }
            list.push(name.to_string());
        } else {
            list.retain(|f| f != name);
        }
        let file = self.favorites_file()?;
        std::fs::create_dir_all(file.parent().expect("有上级目录")).map_err(|e| CoreError::git("保存收藏失败", e))?;
        let text: String = list.iter().map(|f| format!("{f}\n")).collect();
        std::fs::write(file, text).map_err(|e| CoreError::git("保存收藏失败", e))
    }

    /// Delete a local branch. The current branch can't be deleted; a branch with unmerged commits needs `force`.
    pub fn branch_delete(&self, name: &str, force: bool) -> Result<()> {
        let refs = self.refs_list()?;
        let Some(b) = refs.branches.iter().find(|b| b.name == name) else {
            return Err(CoreError::new(ErrorCode::NotFound, format!("分支 {name} 不存在")));
        };
        if b.is_current {
            return Err(CoreError::new(ErrorCode::InvalidName, "不能删除当前分支"));
        }
        if !b.merged && !force {
            return Err(CoreError::new(ErrorCode::InvalidName, format!("分支 {name} 上有还没合并的提交"))
                .with_detail(serde_json::json!({ "unmerged": true })));
        }
        self.git(&["branch", "--delete", "--force", name])
    }

    /// Set the remote branch a local branch tracks (`git branch --set-upstream-to`), or stop tracking when `upstream` is None.
    /// It's branch configuration, not a change to commits or refs, so it isn't an undo step.
    pub fn branch_set_upstream(&self, branch: &str, upstream: Option<&str>) -> Result<()> {
        let refs = self.refs_list()?;
        if !refs.branches.iter().any(|b| b.name == branch) {
            return Err(CoreError::new(ErrorCode::NotFound, format!("分支 {branch} 不存在")));
        }
        match upstream {
            Some(up) => {
                if !refs.remotes.iter().any(|r| r.name == up) {
                    return Err(CoreError::new(ErrorCode::NotFound, format!("远程分支 {up} 不存在，先抓取一下")));
                }
                self.git(&["branch", &format!("--set-upstream-to={up}"), branch])
            }
            None => {
                if refs.branches.iter().any(|b| b.name == branch && b.upstream.is_none()) {
                    return Ok(());
                }
                self.git(&["branch", "--unset-upstream", branch])
            }
        }
    }

    /// Local branches whose commits are all in `into` (a branch name or revision): candidates for "clean up merged
    /// branches". Leaves out the current branch, `into` itself and branches checked out in another worktree.
    pub fn merged_branches(&self, into: &str) -> Result<Vec<MergedBranch>> {
        let repo = self.git2()?;
        let target = repo
            .revparse_single(into)
            .and_then(|o| o.peel_to_commit())
            .map_err(|_| CoreError::new(ErrorCode::NotFound, format!("找不到 {into}")))?
            .id();
        let mut out = Vec::new();
        for b in self.refs_list()?.branches {
            if b.is_current || b.name == into || b.worktree.is_some() {
                continue;
            }
            let Ok(tip) = git2::Oid::from_str(&b.head) else { continue };
            let merged = tip == target || repo.graph_descendant_of(target, tip).unwrap_or(false);
            if !merged {
                continue;
            }
            let c = repo.find_commit(tip).ok();
            out.push(MergedBranch {
                name: b.name.clone(),
                head: b.head.clone(),
                title: c.as_ref().and_then(|c| c.summary().ok().flatten().map(str::to_string)).unwrap_or_default(),
                time: c.as_ref().map_or(0, |c| c.time().seconds()),
                upstream: b.upstream.clone(),
                favorite: b.favorite,
            });
        }
        out.sort_by_key(|b| std::cmp::Reverse(b.time));
        Ok(out)
    }

    /// Delete several local branches at once (cleaning up merged branches). The current branch and branches checked out
    /// in another worktree are refused before anything is deleted. Returns how many were deleted.
    pub fn branches_delete(&self, names: &[String]) -> Result<usize> {
        if names.is_empty() {
            return Err(CoreError::new(ErrorCode::NothingSelected, "没有选择要删除的分支"));
        }
        let refs = self.refs_list()?;
        for n in names {
            let Some(b) = refs.branches.iter().find(|b| &b.name == n) else {
                return Err(CoreError::new(ErrorCode::NotFound, format!("分支 {n} 不存在")));
            };
            if b.is_current {
                return Err(CoreError::new(ErrorCode::InvalidName, "不能删除当前分支"));
            }
            if let Some(w) = &b.worktree {
                return Err(CoreError::new(ErrorCode::InvalidName, format!("分支 {n} 在工作目录 {w} 里检出，不能删除")));
            }
        }
        let mut args = vec!["branch", "--delete", "--force"];
        args.extend(names.iter().map(String::as_str));
        self.git(&args)?;
        Ok(names.len())
    }

    /// Merge `source` (a local branch, remote branch, tag or commit) into the current branch.
    /// Does nothing when already contained; fast-forwards when possible; otherwise creates a merge commit. On conflicts returns `CONFLICTS` and the repository stays in the merge state.
    pub fn branch_merge(&self, source: &str) -> Result<MergeResult> {
        self.branch_merge_mode(source, MergeMode::Auto)
    }

    /// Merge into the current branch with the given mode (spec §6.3, §6.7).
    /// - `NoFf`: create a merge commit even when a fast-forward is possible.
    /// - `Squash`: first merge like a normal merge (`--no-ff --no-commit`), entering conflict resolution on conflicts as usual;
    ///   the merged result is committed as a normal commit with one parent, with the message "Squash merge X" plus the titles of the merged commits.
    ///   On conflicts the message is saved in `.git/strand/squash` and committed this way when conflict resolution finishes (`merge_finish`).
    pub fn branch_merge_mode(&self, source: &str, mode: MergeMode) -> Result<MergeResult> {
        self.branch_merge_with(source, mode, None)
    }

    /// Default squash-merge message: "Squash merge X", with the titles of the commits being merged in the body (at most 50).
    /// With `into` empty it is computed against the current branch; when drag-merging into another branch, against that branch.
    pub fn squash_message(&self, source: &str, into: Option<&str>) -> Result<String> {
        let base = into.unwrap_or("HEAD");
        let titles = git_cli::run(self.path(), &["log", "--no-merges", "--format=* %s", "-n", "50", &format!("{base}..{source}")], None).unwrap_or_default();
        Ok(format!("压缩合并 {source}\n\n{}", titles.trim_end()).trim_end().to_string())
    }

    /// Same as [`Session::branch_merge_mode`]; for a squash merge, use `message` as the message (when empty, [`Session::squash_message`])
    pub fn branch_merge_with(&self, source: &str, mode: MergeMode, message: Option<&str>) -> Result<MergeResult> {
        self.require_normal()?;
        let repo = self.git2()?;
        let src = repo
            .revparse_single(source)
            .and_then(|o| o.peel_to_commit())
            .map_err(|_| CoreError::new(ErrorCode::NotFound, format!("找不到 {source}")))?
            .id();
        let head = repo.head().ok().and_then(|h| h.target());
        if let Some(h) = head {
            if h == src || repo.graph_descendant_of(h, src).unwrap_or(false) {
                return Ok(MergeResult::UpToDate);
            }
            if mode == MergeMode::Auto && repo.graph_descendant_of(src, h).unwrap_or(false) {
                self.git(&["merge", "--ff-only", source]).map_err(|e| worktree_conflict(e, source))?;
                return Ok(MergeResult::FastForward);
            }
        }
        let squash = mode == MergeMode::Squash;
        // Discard a squash-merge record left from before (e.g. aborted on the command line)
        let _ = std::fs::remove_file(self.squash_file()?);
        if squash {
            let message = match message.map(str::trim).filter(|m| !m.is_empty()) {
                Some(m) => m.to_string(),
                None => self.squash_message(source, None)?,
            };
            std::fs::create_dir_all(self.strand_dir()?).ok();
            let head = head.map(|h| h.to_string()).unwrap_or_default();
            let marker = serde_json::json!({ "head": head, "merge_head": src.to_string(), "message": message.trim_end() });
            std::fs::write(self.squash_file()?, marker.to_string()).map_err(|e| CoreError::git("保存合并说明失败", e))?;
        }
        let args: &[&str] = match mode {
            MergeMode::Auto => &["merge", "--no-edit", source],
            MergeMode::NoFf => &["merge", "--no-ff", "--no-edit", source],
            MergeMode::Squash => &["merge", "--no-ff", "--no-commit", source],
        };
        match self.git(args) {
            Ok(()) if squash => self.squash_commit().map(|made| if made { MergeResult::Squashed } else { MergeResult::UpToDate }),
            Ok(()) => Ok(MergeResult::Merged),
            Err(e) => {
                if squash && self.state()?.state != RepoMode::Merging {
                    let _ = std::fs::remove_file(self.squash_file()?);
                }
                if self.state()?.state == RepoMode::Merging {
                    let files = self.conflicted_files().unwrap_or_default();
                    Err(CoreError::new(ErrorCode::Conflicts, format!("合并 {source} 时有 {} 个文件冲突", files.len()))
                        .with_detail(serde_json::json!({ "files": files })))
                } else {
                    Err(worktree_conflict(e, source))
                }
            }
        }
    }

    fn squash_file(&self) -> Result<std::path::PathBuf> {
        Ok(self.strand_dir()?.join("squash"))
    }

    /// The message of the squash merge in progress: only valid while the recorded commit is still this merge's MERGE_HEAD (invalid if aborted elsewhere)
    pub(crate) fn squash_pending(&self) -> Option<String> {
        let text = std::fs::read_to_string(self.squash_file().ok()?).ok()?;
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        let at = |r: &str| git_cli::run(self.path(), &["rev-parse", "-q", "--verify", r], None).ok().map(|s| s.trim().to_string());
        let same = v["merge_head"].as_str()? == at("MERGE_HEAD")? && v["head"].as_str()? == at("HEAD")?;
        same.then(|| v["message"].as_str().unwrap_or_default().to_string())
    }

    /// Commit the merged result as a normal commit (last step of a squash merge). Removes MERGE_HEAD so the commit has one parent.
    /// Doesn't commit and returns false when the result is identical to the current branch (the changes were already in it).
    pub(crate) fn squash_commit(&self) -> Result<bool> {
        let message = self.squash_pending().ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "现在没有进行中的压缩合并"))?;
        let git_dir = self.git2()?.path().to_path_buf();
        for f in ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"] {
            let _ = std::fs::remove_file(git_dir.join(f));
        }
        let _ = std::fs::remove_file(self.squash_file()?);
        if git_cli::run(self.path(), &["diff", "--cached", "--quiet"], None).is_ok() {
            return Ok(false);
        }
        git_cli::run(self.path(), &["commit", "-q", "-F", "-"], Some(&message))?;
        Ok(true)
    }

    /// Merge `source` into `target` (drag-merge in spec §6.1): switch to `target` first when it isn't the current branch.
    /// Changes nothing when the switch fails (worktree changes would be overwritten, checked out in another worktree); on merge conflicts it stops in the merge state on `target`.
    pub fn branch_merge_into(&self, source: &str, target: &str) -> Result<MergeResult> {
        self.branch_merge_into_mode(source, target, MergeMode::Auto)
    }

    /// Same as [`Self::branch_merge_into`], merging with the given mode
    pub fn branch_merge_into_mode(&self, source: &str, target: &str, mode: MergeMode) -> Result<MergeResult> {
        self.branch_merge_into_with(source, target, mode, None)
    }

    /// Same as [`Session::branch_merge_into_mode`], with an optional message for squash merges
    pub fn branch_merge_into_with(&self, source: &str, target: &str, mode: MergeMode, message: Option<&str>) -> Result<MergeResult> {
        self.require_normal()?;
        if source == target {
            return Err(CoreError::new(ErrorCode::InvalidRange, "不能把分支合并到它自己"));
        }
        if self.git2()?.find_branch(target, git2::BranchType::Local).is_err() {
            return Err(CoreError::new(ErrorCode::NotFound, format!("分支 {target} 不存在")));
        }
        if self.state()?.head.branch.as_deref() != Some(target) {
            self.branch_switch(target, false)?;
        }
        self.branch_merge_with(source, mode, message)
    }

    /// Checks before rebasing the current branch onto `onto` (spec §6.3).
    pub fn branch_rebase_plan(&self, onto: &str) -> Result<RebasePlan> {
        let st = self.state()?;
        let branch = st.head.branch.clone().ok_or_else(|| CoreError::new(ErrorCode::InvalidRange, "现在不在任何分支上，先切换到一个分支再变基"))?;
        git_cli::run(self.path(), &["rev-parse", "--verify", "--quiet", &format!("{onto}^{{commit}}")], None)
            .map_err(|_| CoreError::new(ErrorCode::NotFound, format!("找不到 {onto}")))?;
        let count = |args: &[&str]| -> Result<u32> {
            let mut a = vec!["rev-list", "--count"];
            a.extend_from_slice(args);
            Ok(git_cli::run(self.path(), &a, None)?.trim().parse().unwrap_or(0))
        };
        let range = format!("{onto}..HEAD");
        let own = count(&[&range])?;
        let unpushed = count(&[&range, "--not", "--remotes"])?;
        let incoming = count(&[&format!("HEAD..{onto}")])?;
        let has_merge = count(&["--min-parents=2", &range])? > 0;
        Ok(RebasePlan { branch, onto: onto.to_string(), own, pushed: own.saturating_sub(unpushed), incoming, has_merge })
    }

    /// Rewrite the current branch's own commits on top of the latest commit of `onto`. With worktree changes, git's `--autostash` puts them aside and back afterwards.
    /// On conflicts returns `CONFLICTS`, the repository stays in the rebase state, and the conflict resolution flow takes over (§8).
    pub fn branch_rebase(&self, onto: &str) -> Result<RebaseOutcome> {
        self.require_normal()?;
        let plan = self.branch_rebase_plan(onto)?;
        if plan.branch == onto {
            return Err(CoreError::new(ErrorCode::InvalidRange, "不能变基到自己之上"));
        }
        if plan.has_merge {
            return Err(CoreError::new(ErrorCode::InvalidRange, format!("{} 独有的提交里有合并提交，不能变基；可以改用合并", plan.branch)));
        }
        if plan.incoming == 0 {
            return Ok(RebaseOutcome::UpToDate);
        }
        if plan.own == 0 {
            self.git(&["merge", "--ff-only", onto]).map_err(|e| worktree_conflict(e, onto))?;
            return Ok(RebaseOutcome::FastForward);
        }
        match self.git(&["rebase", "--autostash", onto]) {
            Ok(()) => Ok(RebaseOutcome::Rebased),
            Err(e) => {
                if self.state()?.state == RepoMode::Rebasing {
                    let files = self.conflicted_files().unwrap_or_default();
                    Err(CoreError::new(ErrorCode::Conflicts, format!("变基到 {onto} 时有 {} 个文件冲突", files.len()))
                        .with_detail(serde_json::json!({ "files": files })))
                } else {
                    Err(worktree_conflict(e, onto))
                }
            }
        }
    }

    /// Abandon the merge, rebase, cherry-pick or revert in progress and go back to before it. Changes auto-stashed by a pull are restored too.
    pub fn merge_abort(&self) -> Result<()> {
        self.clear_conflict_record();
        match self.state()?.state {
            RepoMode::Normal => Ok(()),
            RepoMode::Merging => {
                let _ = std::fs::remove_file(self.squash_file()?);
                self.git(&["merge", "--abort"])
            }
            RepoMode::Rebasing => self.git(&["rebase", "--abort"]),
            RepoMode::CherryPicking => self.git(&["cherry-pick", "--abort"]),
            RepoMode::Reverting => self.git(&["revert", "--abort"]),
            RepoMode::Unstashing => self.unstash_abort(),
        }
    }

    /// Check out a remote branch: switch to the same-named local branch if it exists, otherwise create it with tracking. Returns the local branch name.
    pub fn branch_checkout_remote(&self, remote_branch: &str) -> Result<String> {
        self.require_normal()?;
        let local = remote_branch.split_once('/').map(|(_, b)| b).unwrap_or(remote_branch).to_string();
        let exists = self.refs_list()?.branches.iter().any(|b| b.name == local);
        if exists {
            self.branch_switch(&local, false)?;
        } else {
            self.git(&["switch", "--create", &local, "--track", remote_branch])
                .map_err(|e| worktree_conflict(e, remote_branch))?;
        }
        Ok(local)
    }

    /// Check out a tag or a revision (hash prefix), entering detached HEAD.
    pub fn checkout_detached(&self, rev: &str) -> Result<()> {
        self.require_normal()?;
        let repo = self.git2()?;
        if repo.revparse_single(rev).and_then(|o| o.peel_to_commit()).is_err() {
            return Err(CoreError::new(ErrorCode::NotFound, format!("找不到标签或版本 {rev}")));
        }
        self.git(&["switch", "--detach", rev]).map_err(|e| worktree_conflict(e, rev))
    }

    /// Create a tag. A non-empty `message` makes an annotated tag (git tag -a); `sign` true signs it (git tag -s, using the tag name as the message when none was given).
    pub fn tag_create(&self, name: &str, at: &str, message: Option<&str>, sign: bool) -> Result<()> {
        let n = name.trim();
        if n.is_empty() || n.contains(char::is_whitespace) {
            return Err(CoreError::new(ErrorCode::InvalidName, "标签名不能为空，也不能有空格"));
        }
        if git_cli::run(self.path(), &["check-ref-format", &format!("refs/tags/{n}")], None).is_err() {
            return Err(CoreError::new(ErrorCode::InvalidName, "标签名不符合 Git 的命名规则"));
        }
        if self.refs_list()?.tags.iter().any(|t| t.name == n) {
            return Err(CoreError::new(ErrorCode::InvalidName, format!("已经有叫 {n} 的标签了")));
        }
        let msg = message.map(str::trim).filter(|m| !m.is_empty());
        match (msg, sign) {
            (None, false) => self.git(&["tag", "--no-sign", n, at]),
            (Some(m), false) => self.git(&["tag", "-a", "--no-sign", n, "-m", m, at]),
            (m, true) => self.git(&["tag", "-s", n, "-m", m.unwrap_or(n), at]).map_err(sign_error),
        }
    }

    pub fn tag_delete(&self, name: &str) -> Result<()> {
        self.git(&["tag", "--delete", name])
    }

    // ---------- Internal ----------

    fn git(&self, args: &[&str]) -> Result<()> {
        git_cli::run(self.path(), args, None).map(|_| ())
    }

    fn require_normal(&self) -> Result<()> {
        if self.state()?.state != RepoMode::Normal {
            return Err(CoreError::new(ErrorCode::MergeInProgress, "合并还没完成，先解决冲突或中止合并"));
        }
        Ok(())
    }

    /// Name validation when creating or renaming branches (spec §6.3).
    pub(crate) fn check_branch_name(&self, name: &str) -> Result<()> {
        let n = name.trim();
        if n.is_empty() {
            return Err(CoreError::new(ErrorCode::InvalidName, "分支名不能为空"));
        }
        if n.contains(char::is_whitespace) {
            return Err(CoreError::new(ErrorCode::InvalidName, "分支名不能有空格"));
        }
        if git_cli::run(self.path(), &["check-ref-format", "--branch", n], None).is_err() {
            return Err(CoreError::new(ErrorCode::InvalidName, "分支名不符合 Git 的命名规则"));
        }
        for b in self.refs_list()?.branches {
            if b.name == n {
                return Err(CoreError::new(ErrorCode::InvalidName, format!("已经有叫 {n} 的分支了")));
            }
            // Git branches are file paths under refs/heads: if feature exists, feature/x can't, and vice versa
            if n.starts_with(&format!("{}/", b.name)) || b.name.starts_with(&format!("{n}/")) {
                return Err(CoreError::new(
                    ErrorCode::InvalidName,
                    format!("已经有分支 {}，不能再建 {n}（Git 不允许一个分支名是另一个的上级目录）", b.name),
                ));
            }
        }
        Ok(())
    }

    fn conflicted_files(&self) -> Result<Vec<String>> {
        let out = git_cli::run(self.path(), &["diff", "--name-only", "--diff-filter=U"], None)?;
        Ok(out.lines().map(str::to_string).collect())
    }
}

/// Convert git's "local changes would be overwritten" into `WORKTREE_CONFLICT`; other errors are returned as is.
fn worktree_conflict(e: CoreError, target: &str) -> CoreError {
    let stderr = e.detail.as_ref().and_then(|d| d.get("stderr")).and_then(|s| s.as_str()).unwrap_or("");
    if !stderr.contains("would be overwritten") && !stderr.contains("会被覆盖") {
        return e;
    }
    // git's output: after the message line comes a list of file paths starting with a tab
    let files: Vec<String> = stderr
        .lines()
        .filter(|l| l.starts_with('\t'))
        .map(|l| l.trim().to_string())
        .collect();
    CoreError::new(ErrorCode::WorktreeConflict, format!("切换到 {target} 会覆盖工作区里 {} 个文件的改动", files.len()))
        .with_detail(serde_json::json!({ "files": files }))
}

/// Whether the current branch (`cur`, pointing at `head`) can be rebased onto `onto`; the reason when it can't.
/// It can't when it is already on top, or its own commits include a merge commit. With too many own commits (over 2000) we don't count and leave it to the check after the click.
impl Session {
    /// Same as [`rebase_block`], using the in-memory commit graph: `head_reach` is the rows reachable from HEAD, `onto` is the target's row
    fn rebase_block_rows(&self, head_reach: &[bool], onto: u32, cur: &str, name: &str) -> Option<String> {
        if head_reach[onto as usize] {
            return Some(format!("{cur} 已经在 {name} 之上"));
        }
        let onto_reach = self.reach(vec![onto]);
        // The current branch's own commits (reachable from HEAD, not from the target), the newest 2000
        let own = (0..self.ids.len()).filter(|&r| head_reach[r] && !onto_reach[r]);
        for (i, r) in own.enumerate() {
            if i >= 2000 {
                return None;
            }
            if self.parents[r].len() > 1 {
                return Some(format!("{cur} 独有的提交里有合并提交，可以改用合并"));
            }
        }
        None
    }
}

fn rebase_block(repo: &git2::Repository, head: git2::Oid, onto: git2::Oid, cur: &str, name: &str) -> Option<String> {
    if head == onto || repo.graph_descendant_of(head, onto).unwrap_or(false) {
        return Some(format!("{cur} 已经在 {name} 之上"));
    }
    let mut walk = repo.revwalk().ok()?;
    walk.push(head).ok()?;
    walk.hide(onto).ok()?;
    for (i, id) in walk.enumerate() {
        if i >= 2000 {
            return None;
        }
        let c = repo.find_commit(id.ok()?).ok()?;
        if c.parent_count() > 1 {
            return Some(format!("{cur} 独有的提交里有合并提交，可以改用合并"));
        }
    }
    None
}

/// When signing fails (no key configured, gpg missing, passphrase cancelled), give a readable explanation and keep the original text in detail
pub(crate) fn sign_error(e: CoreError) -> CoreError {
    let text = e.detail.as_ref().map(|d| d.to_string()).unwrap_or_default();
    if text.contains("gpg") || text.contains("sign") || text.contains("secret key") || text.contains("ssh-keygen") {
        return CoreError::new(ErrorCode::GitFailed, "签名失败：检查 Git 的签名设置（user.signingkey、gpg.format）和 gpg 或 ssh-keygen 能不能用").with_detail(e.detail.unwrap_or_default());
    }
    e
}
