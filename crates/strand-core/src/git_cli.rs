//! Detecting system Git.
//!
//! The installer doesn't bundle Git; users install it themselves (spec §2.3, §15).
//! Detected at startup; the frontend shows a notice when it's missing or older than 2.30.

use std::process::Command;

use crate::model::GitInfo;

pub const MIN_GIT_VERSION: (u32, u32) = (2, 30);

pub fn check() -> GitInfo {
    let min_version = format!("{}.{}", MIN_GIT_VERSION.0, MIN_GIT_VERSION.1);
    let mut cmd = Command::new("git");
    cmd.arg("--version");
    hide_console(&mut cmd);
    let Ok(out) = cmd.output() else {
        return GitInfo { found: false, version: None, ok: false, min_version };
    };
    if !out.status.success() {
        return GitInfo { found: false, version: None, ok: false, min_version };
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let version = parse_version(&text);
    let ok = version
        .as_deref()
        .and_then(major_minor)
        .is_some_and(|v| v >= MIN_GIT_VERSION);
    GitInfo { found: true, version, ok, min_version }
}

/// `git version 2.45.1.windows.1` → `2.45.1.windows.1`
fn parse_version(text: &str) -> Option<String> {
    text.trim().strip_prefix("git version ").map(|s| s.split_whitespace().next().unwrap_or(s).to_string())
}

fn major_minor(v: &str) -> Option<(u32, u32)> {
    let mut it = v.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}

/// Don't pop up a black console window when running command-line programs on Windows.
#[cfg(windows)]
pub(crate) fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn hide_console(_cmd: &mut Command) {}

/// Run system git in the repository directory and return stdout. On failure returns `GIT_FAILED` with stderr in `detail.stderr`.
pub fn run(dir: &std::path::Path, args: &[&str], stdin: Option<&str>) -> crate::Result<String> {
    run_env(dir, args, stdin, &[])
}

/// Same as [`run`], also setting some environment variables (e.g. `GIT_SEQUENCE_EDITOR` for interactive rebase).
pub fn run_env(dir: &std::path::Path, args: &[&str], stdin: Option<&str>, envs: &[(&str, &str)]) -> crate::Result<String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Never open an editor or credential prompt; interactive steps are handled by the UI
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    hide_console(&mut cmd);
    let timer = crate::console::Timer::start();
    let mut child = cmd.spawn().map_err(|e| {
        crate::CoreError::new(crate::ErrorCode::GitMissing, "没有找到 Git，请先安装")
            .with_detail(serde_json::json!({ "source": e.to_string() }))
    })?;
    if let Some(input) = stdin
        && let Some(mut s) = child.stdin.take()
    {
        s.write_all(input.as_bytes()).map_err(|e| crate::CoreError::git("向 git 传递输入失败", e))?;
    }
    let out = child.wait_with_output().map_err(|e| crate::CoreError::git("等待 git 结束失败", e))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    timer.done(args, &stdout, &String::from_utf8_lossy(&out.stderr), out.status.success());
    if out.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let first = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("git 命令失败").to_string();
        Err(crate::CoreError::new(crate::ErrorCode::GitFailed, first).with_detail(serde_json::json!({
            "args": args,
            "stderr": stderr,
            "stdout": stdout,
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("git version 2.55.0\n").as_deref(), Some("2.55.0"));
        assert_eq!(parse_version("git version 2.39.3 (Apple Git-146)").as_deref(), Some("2.39.3"));
        assert_eq!(parse_version("git version 2.45.1.windows.1").as_deref(), Some("2.45.1.windows.1"));
        assert_eq!(major_minor("2.45.1.windows.1"), Some((2, 45)));
        assert!(major_minor("2.29.0").unwrap() < MIN_GIT_VERSION);
        assert!(major_minor("3.0").unwrap() >= MIN_GIT_VERSION);
    }
}
