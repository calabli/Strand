//! 分支和标签（说明书第 6 节）。
//!
//! 读取用 git2；所有写操作调用系统 git，这样钩子、配置和命令行的行为完全一致。

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::{Branch, MergeMode, MergeResult, RebaseOutcome, RebasePlan, RefsList, RemoteBranch, RepoMode, Tag};
use crate::{git_cli, Session};

impl Session {
    /// 本地分支、远程分支、标签和 HEAD。
    pub fn refs_list(&self) -> Result<RefsList> {
        let repo = self.git2()?;
        let head_oid = repo.head().ok().and_then(|h| h.target());
        let current = repo
            .head()
            .ok()
            .filter(|h| h.is_branch())
            .and_then(|h| h.shorthand().ok().map(str::to_string));

        let favs = self.favorites();
        // 合并与否、能不能变基都用内存里的提交图来算（说明书 15）：libgit2 的祖先判断在 10 万个提交上
        // 每个分支要走很远，21 个分支就要 1.7 秒；内存里从 HEAD 能到达哪些提交一次就算好了
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
            // 远程独有的提交在本地都有改写后的版本：本地改写了已推送的历史（说明书 6.3、10.3）
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
                tags.push(Tag { name: n.to_string(), at: c.id().to_string(), unpushed: false });
            }
        }
        tags.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(unpushed) = crate::remote::unpushed_tags(self.path()) {
            for t in &mut tags {
                t.unpushed = unpushed.binary_search(&t.name).is_ok();
            }
        }

        // 变基的可用性先算好，菜单里直接置灰（说明书 6.3）；和 branch_rebase 的检查一致
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

        // 读不到工作目录列表（如 git 太旧）不影响其他内容
        let worktrees = self.worktree_list().unwrap_or_default();
        for b in &mut branches {
            b.worktree = worktrees.iter().find(|w| !w.is_current && w.branch.as_deref() == Some(&b.name)).map(|w| w.path.clone());
        }
        Ok(RefsList { branches, remotes, tags, head: self.state()?.head, worktrees })
    }

    /// 新建分支，`at` 为空时从当前位置；`checkout` 为真时创建后切换过去。
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

    /// 切换分支。工作区改动会被覆盖时返回 `WORKTREE_CONFLICT`，`detail.files` 是冲突的文件；
    /// `stash_first` 为真时先把改动（含未跟踪文件）贮藏起来再切换，贮藏不会自动恢复。
    pub fn branch_switch(&self, name: &str, stash_first: bool) -> Result<()> {
        self.require_normal()?;
        // 在别的工作目录检出的分支切换不过去，先说清楚，免得白白贮藏一次
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
        // 收藏跟着新名字走；旧名字留着，撤销重命名后仍是收藏
        if self.favorites().iter().any(|f| f == name) {
            self.set_favorite(new_name, true)?;
        }
        Ok(())
    }

    // ---------- 收藏（说明书 6.1、6.3） ----------

    /// 收藏存在 `<共用的 .git>/strand/favorites`，一行一个分支名，工作目录之间共用。
    /// 删除分支时不删这一行（撤销删除后仍是收藏）；已经不存在的分支名在列表里不起作用。
    fn favorites_file(&self) -> Result<std::path::PathBuf> {
        Ok(self.git2()?.commondir().join("strand").join("favorites"))
    }

    /// 收藏的分支名
    pub fn favorites(&self) -> Vec<String> {
        self.favorites_file()
            .ok()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .map(|t| t.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
            .unwrap_or_default()
    }

    /// 收藏或取消收藏一个本地分支。不记入操作日志（只影响显示顺序）。
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

    /// 删除本地分支。不能删除当前分支；分支有未合并的提交时需要 `force`。
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

    /// 把 `source`（本地分支、远程分支、标签或提交）合并到当前分支。
    /// 已包含时什么也不做；能快进就快进；否则生成合并提交。有冲突时返回 `CONFLICTS`，仓库停在合并状态。
    pub fn branch_merge(&self, source: &str) -> Result<MergeResult> {
        self.branch_merge_mode(source, MergeMode::Auto)
    }

    /// 按指定方式合并到当前分支（说明书 6.3、6.7）。
    /// - `NoFf`：能快进时也生成合并提交。
    /// - `Squash`：先像普通合并一样合并（`--no-ff --no-commit`），冲突时照常进入冲突解决；
    ///   合并好的结果提交成一个只有一个父提交的普通提交，说明是“压缩合并 X”加上合并进来的提交标题。
    ///   有冲突时把说明记在 `.git/strand/squash`，冲突解决完成时（`merge_finish`）再这样提交。
    pub fn branch_merge_mode(&self, source: &str, mode: MergeMode) -> Result<MergeResult> {
        self.branch_merge_with(source, mode, None)
    }

    /// 压缩合并的默认说明：“压缩合并 X”，正文列出要合并进来的提交标题（最多 50 个）。
    /// `into` 为空时按当前分支算；拖拽合并到别的分支时按那个分支算。
    pub fn squash_message(&self, source: &str, into: Option<&str>) -> Result<String> {
        let base = into.unwrap_or("HEAD");
        let titles = git_cli::run(self.path(), &["log", "--no-merges", "--format=* %s", "-n", "50", &format!("{base}..{source}")], None).unwrap_or_default();
        Ok(format!("压缩合并 {source}\n\n{}", titles.trim_end()).trim_end().to_string())
    }

    /// 同 [`Session::branch_merge_mode`]；压缩合并时用 `message` 作为说明（为空时用 [`Session::squash_message`]）
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
        // 以前留下的压缩合并记录（如在命令行里中止过）作废
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

    /// 正在进行的压缩合并的说明：只有记下的提交还是这次合并的 MERGE_HEAD 时才算（别处中止过就作废）
    pub(crate) fn squash_pending(&self) -> Option<String> {
        let text = std::fs::read_to_string(self.squash_file().ok()?).ok()?;
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        let at = |r: &str| git_cli::run(self.path(), &["rev-parse", "-q", "--verify", r], None).ok().map(|s| s.trim().to_string());
        let same = v["merge_head"].as_str()? == at("MERGE_HEAD")? && v["head"].as_str()? == at("HEAD")?;
        same.then(|| v["message"].as_str().unwrap_or_default().to_string())
    }

    /// 把合并好的结果提交成一个普通提交（压缩合并的最后一步）。去掉 MERGE_HEAD，提交就只有一个父提交。
    /// 合并结果和当前分支完全一样（改动早已在里面）时不提交，返回 false。
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

    /// 把 `source` 合并到 `target`（说明书 6.1 的拖拽合并）：`target` 不是当前分支时先切换过去。
    /// 切换不过去（工作区改动会被覆盖、在别的工作目录检出）时什么都不改；合并有冲突时停在 `target` 上的合并状态。
    pub fn branch_merge_into(&self, source: &str, target: &str) -> Result<MergeResult> {
        self.branch_merge_into_mode(source, target, MergeMode::Auto)
    }

    /// 同 [`Self::branch_merge_into`]，按指定方式合并
    pub fn branch_merge_into_mode(&self, source: &str, target: &str, mode: MergeMode) -> Result<MergeResult> {
        self.branch_merge_into_with(source, target, mode, None)
    }

    /// 同 [`Session::branch_merge_into_mode`]，压缩合并时可以指定说明
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

    /// 把当前分支变基到 `onto` 之上之前的检查（说明书 6.3）。
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

    /// 把当前分支的独有提交改写到 `onto` 最新提交之后。工作区有改动时用 git 的 `--autostash` 先收起、完成后放回。
    /// 有冲突时返回 `CONFLICTS`，仓库停在变基状态，走冲突解决流程（第 8 节）。
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

    /// 放弃进行中的合并、变基、拣选或还原，回到操作之前。拉取时自动贮藏的改动会一起放回。
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

    /// 检出远程分支：同名本地分支已存在就切换过去，否则新建并跟踪。返回本地分支名。
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

    /// 检出标签或某个版本（哈希前缀），进入分离 HEAD。
    pub fn checkout_detached(&self, rev: &str) -> Result<()> {
        self.require_normal()?;
        let repo = self.git2()?;
        if repo.revparse_single(rev).and_then(|o| o.peel_to_commit()).is_err() {
            return Err(CoreError::new(ErrorCode::NotFound, format!("找不到标签或版本 {rev}")));
        }
        self.git(&["switch", "--detach", rev]).map_err(|e| worktree_conflict(e, rev))
    }

    pub fn tag_create(&self, name: &str, at: &str) -> Result<()> {
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
        self.git(&["tag", n, at])
    }

    pub fn tag_delete(&self, name: &str) -> Result<()> {
        self.git(&["tag", "--delete", name])
    }

    // ---------- 内部 ----------

    fn git(&self, args: &[&str]) -> Result<()> {
        git_cli::run(self.path(), args, None).map(|_| ())
    }

    fn require_normal(&self) -> Result<()> {
        if self.state()?.state != RepoMode::Normal {
            return Err(CoreError::new(ErrorCode::MergeInProgress, "合并还没完成，先解决冲突或中止合并"));
        }
        Ok(())
    }

    /// 新建、重命名分支时的名字校验（说明书 6.3）。
    fn check_branch_name(&self, name: &str) -> Result<()> {
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
            // Git 的分支是 refs/heads 下的文件路径：有 feature 就不能再有 feature/x，反之亦然
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

/// 把 git 报的“本地改动会被覆盖”转换成 `WORKTREE_CONFLICT`，其他错误原样返回。
fn worktree_conflict(e: CoreError, target: &str) -> CoreError {
    let stderr = e.detail.as_ref().and_then(|d| d.get("stderr")).and_then(|s| s.as_str()).unwrap_or("");
    if !stderr.contains("would be overwritten") && !stderr.contains("会被覆盖") {
        return e;
    }
    // git 的输出：说明行之后是一组以制表符开头的文件路径
    let files: Vec<String> = stderr
        .lines()
        .filter(|l| l.starts_with('\t'))
        .map(|l| l.trim().to_string())
        .collect();
    CoreError::new(ErrorCode::WorktreeConflict, format!("切换到 {target} 会覆盖工作区里 {} 个文件的改动", files.len()))
        .with_detail(serde_json::json!({ "files": files }))
}

/// 当前分支（`cur`，指向 `head`）能不能变基到 `onto` 之上；不能时返回原因。
/// 已经在它之上、独有的提交里有合并提交时不能。独有提交太多（超过 2000 个）时不去数，交给点了之后的检查。
impl Session {
    /// 同 [`rebase_block`]，用内存里的提交图：`head_reach` 是从 HEAD 能到达的行，`onto` 是目标所在的行
    fn rebase_block_rows(&self, head_reach: &[bool], onto: u32, cur: &str, name: &str) -> Option<String> {
        if head_reach[onto as usize] {
            return Some(format!("{cur} 已经在 {name} 之上"));
        }
        let onto_reach = self.reach(vec![onto]);
        // 当前分支独有的提交（从 HEAD 能到达、从目标到达不了），按从新到旧查前 2000 个
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
