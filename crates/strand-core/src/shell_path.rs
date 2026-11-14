//! 从访达、程序坞启动时，应用拿到的 PATH 只有系统默认的几项（/usr/bin:/bin:/usr/sbin:/sbin），
//! 用的是系统自带的 git，而不是用户在终端里用的那个（如 Homebrew 的）。两个 git 的配置、版本、
//! 凭据辅助程序都可能不同：钥匙串里存的凭据是终端那个 git 存的，换一个程序去读，macOS 会弹窗要登录密码。
//!
//! 所以启动时（只在不是从终端启动的时候）跑一次用户的登录 shell，读出它的 PATH，排在现有 PATH 前面。
//! 之后核心层调用的 git 和提交前检查的命令都和终端里一致。shell 最多等 3 秒，超时或失败就保持原样。

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const START: &str = "__STRAND_PATH_START__";
const END: &str = "__STRAND_PATH_END__";

/// 从 shell 的输出里取出 PATH（登录脚本可能打印别的东西，所以用前后标记包住）
pub fn parse(out: &str) -> Option<String> {
    let rest = &out[out.rfind(START)? + START.len()..];
    let path = &rest[..rest.find(END)?];
    (!path.trim().is_empty()).then(|| path.to_string())
}

/// 合并：shell 的在前，原来有而 shell 没有的接在后面，去掉重复和空项
pub fn merge(shell: &str, current: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for p in shell.split(':').chain(current.split(':')) {
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    out.join(":")
}

/// 跑用户的登录 shell（读 .zprofile、.zshrc 等），取它的 PATH。失败或超过 `timeout` 返回 `None`。
pub fn login_path(timeout: Duration) -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    // -i：很多人把 brew shellenv、nvm 之类写在 .zshrc 里，只有交互式 shell 才读
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

/// 不是从终端启动时（父进程是 launchd），把登录 shell 的 PATH 并进本进程的 PATH。
/// 要在启动任何线程之前调用（会改环境变量）。返回用了多少毫秒，没做时返回 `None`。
#[cfg(unix)]
pub fn adopt_login_path() -> Option<u128> {
    if std::os::unix::process::parent_id() != 1 || std::env::var_os("STRAND_KEEP_PATH").is_some() {
        return None;
    }
    let t = Instant::now();
    let shell = login_path(Duration::from_secs(3))?;
    let merged = merge(&shell, &std::env::var("PATH").unwrap_or_default());
    // SAFETY: 在 main 一开始、还没有别的线程时调用
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
