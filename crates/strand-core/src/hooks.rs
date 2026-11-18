//! Git hooks: the scripts Git runs around commits, merges, checkouts and pushes. List them with what each is for,
//! read and edit one, switch one off or on, try one now, and explain a commit that a hook stopped.
//!
//! The hooks folder is where Git looks (`git rev-parse --git-path hooks`, which follows core.hooksPath, so husky and
//! lefthook setups are shown as they are). A hook is switched off by renaming it to `<name>.disabled` (works on every
//! system; Git only runs files named exactly after the hook); Git's own `<name>.sample` files can be switched on,
//! which copies them to `<name>`. Edited and enabled hooks are made executable on macOS and Linux.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{CoreError, ErrorCode};
use crate::git_cli;
use crate::Result;

/// Client-side hooks, in the order they come up, with what they're for
pub const HOOKS: &[(&str, &str)] = &[
    ("pre-commit", "提交前运行，常用来跑格式检查、lint 和测试；失败就不提交"),
    ("prepare-commit-msg", "打开提交说明之前运行，可以预先填好说明（比如加上分支名或任务号）"),
    ("commit-msg", "检查提交说明的格式；失败就不提交"),
    ("post-commit", "提交完成后运行，常用来发通知"),
    ("pre-merge-commit", "合并生成合并提交之前运行；失败就不合并"),
    ("pre-rebase", "变基之前运行；失败就不变基"),
    ("post-checkout", "切换分支或检出文件之后运行"),
    ("post-merge", "合并（包括拉取）完成之后运行，常用来重新安装依赖"),
    ("post-rewrite", "修订、变基改写了提交之后运行"),
    ("pre-push", "推送之前运行，常用来跑测试；失败就不推送"),
    ("pre-auto-gc", "自动清理仓库之前运行"),
    ("applypatch-msg", "应用邮件补丁时检查说明"),
    ("pre-applypatch", "应用邮件补丁之后、提交之前运行"),
    ("post-applypatch", "应用邮件补丁并提交之后运行"),
    ("reference-transaction", "任何引用（分支、标签）更新时运行"),
];

/// Hooks that run inside `git commit` and can stop it
const COMMIT_HOOKS: &[&str] = &["pre-commit", "prepare-commit-msg", "commit-msg"];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookState {
    /// Git runs it
    Active,
    /// Switched off (`<name>.disabled`)
    Disabled,
    /// Only Git's sample (`<name>.sample`)
    Sample,
    /// No file
    Missing,
}

#[derive(Debug, Clone, Serialize)]
pub struct HookInfo {
    pub name: String,
    pub state: HookState,
    pub description: String,
    /// The script's interpreter from its first line (#!/bin/sh → sh), when there is a file
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interpreter: Option<String>,
    /// Active but not executable (macOS / Linux): Git skips it with a warning
    pub not_executable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hooks {
    /// The folder Git runs hooks from (absolute)
    pub dir: String,
    /// Set by core.hooksPath (shared or tool-managed hooks)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hooks_path: Option<String>,
    /// husky, lefthook, pre-commit (the Python tool), simple-git-hooks… when one seems to manage them
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager: Option<String>,
    pub hooks: Vec<HookInfo>,
}

fn check_name(name: &str) -> Result<()> {
    if HOOKS.iter().any(|(n, _)| *n == name) {
        Ok(())
    } else {
        Err(CoreError::new(ErrorCode::InvalidName, format!("{name} 不是 Git 钩子")))
    }
}

/// The folder Git runs hooks from
pub fn hooks_dir(dir: &Path) -> Result<PathBuf> {
    let out = git_cli::run(dir, &["rev-parse", "--path-format=absolute", "--git-path", "hooks"], None)?;
    Ok(PathBuf::from(out.trim()))
}

fn state_of(d: &Path, name: &str) -> (HookState, Option<PathBuf>) {
    let active = d.join(name);
    if active.is_file() {
        return (HookState::Active, Some(active));
    }
    let off = d.join(format!("{name}.disabled"));
    if off.is_file() {
        return (HookState::Disabled, Some(off));
    }
    let sample = d.join(format!("{name}.sample"));
    if sample.is_file() {
        return (HookState::Sample, Some(sample));
    }
    (HookState::Missing, None)
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}
#[cfg(not(unix))]
fn is_executable(_p: &Path) -> bool {
    true
}

#[cfg(unix)]
fn make_executable(p: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perm = std::fs::metadata(p).map_err(|e| CoreError::git("读取钩子文件失败", e))?.permissions();
    perm.set_mode(perm.mode() | 0o755);
    std::fs::set_permissions(p, perm).map_err(|e| CoreError::git("设置钩子可执行失败", e))
}
#[cfg(not(unix))]
fn make_executable(_p: &Path) -> Result<()> {
    Ok(())
}

pub fn list(dir: &Path) -> Result<Hooks> {
    let d = hooks_dir(dir)?;
    let hooks_path = git_cli::run(dir, &["config", "--get", "core.hooksPath"], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mut hooks = Vec::new();
    let mut texts = String::new();
    for (name, desc) in HOOKS {
        let (state, file) = state_of(&d, name);
        let first = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok());
        if state == HookState::Active {
            texts.push_str(first.as_deref().unwrap_or(""));
        }
        let interpreter = first
            .as_deref()
            .and_then(|t| t.lines().next())
            .and_then(|l| l.strip_prefix("#!"))
            .map(|l| {
                let parts: Vec<&str> = l.split_whitespace().collect();
                // "#!/usr/bin/env node" → node; "#!/bin/sh" → sh
                let prog = if parts.first().is_some_and(|p| p.ends_with("/env")) { parts.get(1).copied().unwrap_or("") } else { parts.first().copied().unwrap_or("") };
                prog.rsplit('/').next().unwrap_or(prog).to_string()
            })
            .filter(|s| !s.is_empty());
        let not_executable = state == HookState::Active && file.as_deref().is_some_and(|f| !is_executable(f));
        hooks.push(HookInfo { name: name.to_string(), state, description: desc.to_string(), interpreter, not_executable });
    }
    let hp = hooks_path.as_deref().unwrap_or("");
    let manager = if hp.contains(".husky") || texts.contains("husky") {
        Some("husky")
    } else if texts.contains("lefthook") {
        Some("lefthook")
    } else if texts.contains("pre-commit.com") || texts.contains("pre_commit") {
        Some("pre-commit")
    } else if texts.contains("simple-git-hooks") {
        Some("simple-git-hooks")
    } else {
        None
    };
    Ok(Hooks { dir: d.to_string_lossy().into_owned(), hooks_path, manager: manager.map(str::to_string), hooks })
}

/// The hook's script (the active, switched-off or sample file); empty when there is none
pub fn read(dir: &Path, name: &str) -> Result<String> {
    check_name(name)?;
    let (_, file) = state_of(&hooks_dir(dir)?, name);
    match file {
        Some(f) => std::fs::read_to_string(&f).map_err(|e| CoreError::git("读取钩子失败", e)),
        None => Ok(String::new()),
    }
}

/// Save a hook's script. A switched-off hook stays off; a sample or missing one becomes an active hook.
pub fn write(dir: &Path, name: &str, text: &str) -> Result<()> {
    check_name(name)?;
    let d = hooks_dir(dir)?;
    std::fs::create_dir_all(&d).map_err(|e| CoreError::git("创建钩子目录失败", e))?;
    let (state, _) = state_of(&d, name);
    let target = if state == HookState::Disabled { d.join(format!("{name}.disabled")) } else { d.join(name) };
    // Scripts run by sh need LF line endings even when written on Windows
    let body = text.replace("\r\n", "\n");
    std::fs::write(&target, body).map_err(|e| CoreError::git("保存钩子失败", e))?;
    make_executable(&target)
}

/// Switch a hook on or off. On: rename `<name>.disabled` back (or copy Git's sample); off: rename to `<name>.disabled`.
pub fn set_enabled(dir: &Path, name: &str, on: bool) -> Result<()> {
    check_name(name)?;
    let d = hooks_dir(dir)?;
    let active = d.join(name);
    let off = d.join(format!("{name}.disabled"));
    let sample = d.join(format!("{name}.sample"));
    let fail = |e| CoreError::git("修改钩子失败", e);
    if on {
        if active.is_file() {
            return make_executable(&active);
        }
        if off.is_file() {
            std::fs::rename(&off, &active).map_err(fail)?;
        } else if sample.is_file() {
            std::fs::copy(&sample, &active).map_err(fail)?;
        } else {
            return Err(CoreError::new(ErrorCode::NotFound, format!("还没有 {name} 钩子，先写好内容再保存")));
        }
        make_executable(&active)
    } else {
        if !active.is_file() {
            return Ok(());
        }
        if off.exists() {
            std::fs::remove_file(&off).map_err(fail)?;
        }
        std::fs::rename(&active, &off).map_err(fail)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HookRun {
    pub ok: bool,
    pub output: String,
}

/// Run a hook now, the way Git would (`git hook run`), without committing; for hooks that take no arguments
pub fn try_run(dir: &Path, name: &str) -> Result<HookRun> {
    check_name(name)?;
    if !["pre-commit", "post-commit", "pre-merge-commit", "post-merge", "pre-auto-gc", "pre-applypatch", "post-applypatch"].contains(&name) {
        return Err(CoreError::new(ErrorCode::InvalidRange, format!("{name} 需要 Git 传给它的参数，不能单独试运行")));
    }
    match git_cli::run(dir, &["hook", "run", name], None) {
        Ok(out) => Ok(HookRun { ok: true, output: out }),
        Err(e) if e.code == ErrorCode::GitFailed => {
            let d = e.detail.as_ref();
            let get = |k: &str| d.and_then(|v| v.get(k)).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let output = [get("stdout"), get("stderr")].into_iter().filter(|s| !s.trim().is_empty()).collect::<Vec<_>>().join("\n");
            if output.contains("is not a git command") {
                return Err(CoreError::new(ErrorCode::GitFailed, "试运行需要 Git 2.36 以上"));
            }
            Ok(HookRun { ok: false, output })
        }
        Err(e) => Err(e),
    }
}

/// Active hooks that run inside `git commit`
pub fn commit_hooks(dir: &Path) -> Vec<String> {
    let Ok(d) = hooks_dir(dir) else { return Vec::new() };
    COMMIT_HOOKS.iter().filter(|n| state_of(&d, n).0 == HookState::Active).map(|n| n.to_string()).collect()
}

/// A failed `git commit`: when commit hooks are active and Git's own messages don't explain the failure, it was a
/// hook. Then the error says so (HOOK_FAILED) and carries the hook's whole output, not just its first line.
pub fn explain_commit_error(dir: &Path, e: CoreError) -> CoreError {
    if e.code != ErrorCode::GitFailed {
        return e;
    }
    let hooks = commit_hooks(dir);
    if hooks.is_empty() {
        return e;
    }
    let d = e.detail.clone().unwrap_or_default();
    let get = |k: &str| d.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let (stdout, stderr) = (get("stdout"), get("stderr"));
    // Git's own refusals start like this; a hook's output can be anything
    let git_own = ["fatal:", "error: pathspec", "nothing to commit", "nothing added to commit", "Author identity unknown", "error: gpg failed", "error: cannot"];
    if stderr.lines().next().is_some_and(|l| git_own.iter().any(|g| l.trim_start().starts_with(g))) {
        return e;
    }
    // "nothing to commit" and friends go to stdout, after a status summary
    let both = format!("{stdout}\n{stderr}");
    if ["nothing to commit", "nothing added to commit", "no changes added to commit"].iter().any(|g| both.contains(g)) {
        return e;
    }
    let output = [stdout, stderr].into_iter().filter(|s| !s.trim().is_empty()).collect::<Vec<_>>().join("\n");
    let which = if hooks.len() == 1 { hooks[0].clone() } else { hooks.join(" / ") };
    CoreError::new(ErrorCode::HookFailed, format!("{which} 钩子拦下了这次提交")).with_detail(serde_json::json!({ "hooks": hooks, "output": output }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(p: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").args(args).current_dir(p).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap().status.success();
        assert!(ok, "{args:?}");
    }

    #[test]
    fn list_edit_toggle_and_explain() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.name", "A"]);
        git(p, &["config", "user.email", "a@example.com"]);
        let h = list(p).unwrap();
        assert!(h.hooks.iter().all(|x| x.state != HookState::Active));
        // git init writes samples
        assert_eq!(h.hooks.iter().find(|x| x.name == "pre-commit").unwrap().state, HookState::Sample);
        assert!(write(p, "../../evil", "x").is_err());

        write(p, "pre-commit", "#!/bin/sh\necho 'lint: 2 problems' >&2\necho 'src/a.ts:3 missing semicolon' >&2\nexit 1\n").unwrap();
        let h = list(p).unwrap();
        let pc = h.hooks.iter().find(|x| x.name == "pre-commit").unwrap();
        assert_eq!((pc.state, pc.interpreter.as_deref(), pc.not_executable), (HookState::Active, Some("sh"), false));
        assert_eq!(commit_hooks(p), vec!["pre-commit".to_string()]);

        // A commit the hook stops: HOOK_FAILED with the whole output
        std::fs::write(p.join("a.txt"), "x\n").unwrap();
        git(p, &["add", "a.txt"]);
        let raw = git_cli::run(p, &["commit", "-q", "-m", "x"], None).unwrap_err();
        let e = explain_commit_error(p, raw);
        assert_eq!(e.code, ErrorCode::HookFailed, "{e:?}");
        let out = e.detail.as_ref().unwrap()["output"].as_str().unwrap().to_string();
        assert!(out.contains("lint: 2 problems") && out.contains("missing semicolon"), "{out}");

        // Trying it gives the same output without committing
        if let Ok(r) = try_run(p, "pre-commit") {
            assert!(!r.ok && r.output.contains("missing semicolon"), "{r:?}");
        }

        // Off: renamed, Git commits; on again: back
        set_enabled(p, "pre-commit", false).unwrap();
        assert_eq!(list(p).unwrap().hooks.iter().find(|x| x.name == "pre-commit").unwrap().state, HookState::Disabled);
        assert!(commit_hooks(p).is_empty());
        assert!(read(p, "pre-commit").unwrap().contains("missing semicolon"));
        git(p, &["commit", "-q", "-m", "x"]);
        set_enabled(p, "pre-commit", true).unwrap();
        assert_eq!(list(p).unwrap().hooks.iter().find(|x| x.name == "pre-commit").unwrap().state, HookState::Active);

        // A sample switched on is copied
        set_enabled(p, "pre-push", true).unwrap();
        assert_eq!(list(p).unwrap().hooks.iter().find(|x| x.name == "pre-push").unwrap().state, HookState::Active);
        assert!(set_enabled(p, "post-merge", true).is_err());

        // Git's own errors are left alone
        set_enabled(p, "pre-commit", false).unwrap();
        write(p, "commit-msg", "#!/bin/sh\nexit 0\n").unwrap();
        let raw = git_cli::run(p, &["commit", "-q", "-m", "nothing"], None).unwrap_err();
        assert_eq!(explain_commit_error(p, raw).code, ErrorCode::GitFailed);
    }
}
