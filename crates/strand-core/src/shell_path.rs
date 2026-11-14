//! When launched from Finder or the Dock, the app's PATH has only the system defaults (/usr/bin:/bin:/usr/sbin:/sbin),
//! so it uses the system git rather than the one the user runs in the terminal (e.g. Homebrew's). The two gits may differ in config, version
//! and credential helper: keychain credentials were stored by the terminal's git, and when another program reads them macOS prompts for the login password.
//!
//! So at startup (only when not launched from a terminal) run the user's login shell once, read its PATH, and put it in front of the existing PATH.
//! From then on the git called by the core layer and pre-commit check commands match the terminal. Waits for the shell at most 3 seconds; on timeout or failure nothing changes.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const START: &str = "__STRAND_PATH_START__";
const END: &str = "__STRAND_PATH_END__";

/// Extract PATH from the shell's output (login scripts may print other things, so it's wrapped in markers)
pub fn parse(out: &str) -> Option<String> {
    let rest = &out[out.rfind(START)? + START.len()..];
    let path = &rest[..rest.find(END)?];
    (!path.trim().is_empty()).then(|| path.to_string())
}

/// Merge: the shell's entries first, then existing ones the shell lacks, removing duplicates and empty entries
pub fn merge(shell: &str, current: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for p in shell.split(':').chain(current.split(':')) {
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    out.join(":")
}

/// Run the user's login shell (reading .zprofile, .zshrc, etc.) and take its PATH. Returns `None` on failure or after `timeout`.
pub fn login_path(timeout: Duration) -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    // -i: many people put brew shellenv, nvm and the like in .zshrc, which only interactive shells read
    let script = format!("printf '%s%s%s' '{START}' \"$PATH\" '{END}'");
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    parse(&out)
}

/// When not launched from a terminal (parent is launchd), merge the login shell's PATH into this process's PATH.
/// Call before starting any threads (it changes environment variables). Returns how many ms it took, or `None` when skipped.
#[cfg(unix)]
pub fn adopt_login_path() -> Option<u128> {
    if std::os::unix::process::parent_id() != 1 || std::env::var_os("STRAND_KEEP_PATH").is_some() {
        return None;
    }
    let t = Instant::now();
    let shell = login_path(Duration::from_secs(3))?;
    let merged = merge(&shell, &std::env::var("PATH").unwrap_or_default());
    // SAFETY: called at the very start of main, before any other threads exist
    unsafe { std::env::set_var("PATH", merged) };
    Some(t.elapsed().as_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_skips_noise_from_login_scripts() {
        let out = format!("Last login: today\nwelcome!\n{START}/opt/homebrew/bin:/usr/bin{END}");
        assert_eq!(parse(&out).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(parse("nothing"), None);
        assert_eq!(parse(&format!("{START}{END}")), None);
    }

    #[test]
    fn merge_puts_shell_first_and_dedups() {
        assert_eq!(merge("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin::/usr/sbin"), "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin");
    }

    #[cfg(unix)]
    #[test]
    fn reads_a_real_login_shell() {
        let p = login_path(Duration::from_secs(5)).expect("登录 shell 应该能给出 PATH");
        assert!(p.split(':').any(|d| d == "/usr/bin" || d == "/bin"), "{p}");
    }
}
