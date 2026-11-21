//! Common Git settings: identity (user.name, user.email), proxy (http.proxy, https.proxy),
//! line endings (core.autocrlf) and the default branch name for new repositories (init.defaultBranch).
//!
//! Each key has two scopes the user edits: global (`~/.gitconfig`, every repository) and local (this repository's
//! `.git/config`, overriding global). Reads also report the effective value, which may come from the system config.
//! Everything goes through system git, so Strand and the command line always agree; the network operations Strand
//! runs (fetch, pull, push, clone) pick up the proxy automatically.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;

/// The keys Strand lets users edit
pub const KEYS: &[&str] = &["user.name", "user.email", "http.proxy", "https.proxy", "core.autocrlf", "init.defaultBranch"];

/// Proxy keys git uses, paired with Strand's own keys that remember the address while the proxy is off.
/// The proxy is on in a scope when git's key is set there; turning it off removes git's key and keeps the address.
pub const PROXY_KEYS: &[(&str, &str)] = &[("http.proxy", "strand.httpProxy"), ("https.proxy", "strand.httpsProxy")];

/// Everything `config_read` reports: the editable keys plus the remembered proxy addresses
fn read_keys() -> impl Iterator<Item = &'static str> {
    KEYS.iter().copied().chain(PROXY_KEYS.iter().map(|(_, saved)| *saved))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigScope {
    Global,
    Local,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct ConfigValue {
    pub key: String,
    /// In `~/.gitconfig`
    pub global: Option<String>,
    /// In this repository's config; always empty when no repository is given
    pub local: Option<String>,
    /// The value git actually uses here (local over global over system)
    pub effective: Option<String>,
}

/// Read every editable key. `repo` is the open repository, if any.
pub fn config_read(repo: Option<&Path>) -> Result<Vec<ConfigValue>> {
    let dir = work_dir(repo);
    // One `git config --list` per scope instead of one call per key and scope (that was 24 processes, about half a
    // second before the settings window could show the Git section). A missing file or no repository lists nothing.
    let list = |scope: Option<&str>| -> Vec<(String, String)> {
        let mut a = vec!["config", "--null", "--list"];
        if let Some(s) = scope {
            a.insert(1, s);
        }
        git_cli::run(&dir, &a, None).map(|out| parse_list(&out)).unwrap_or_default()
    };
    let global = list(Some("--global"));
    let local = if repo.is_some() { list(Some("--local")) } else { Vec::new() };
    let all = list(None);
    // Like `git config --get`: the last occurrence wins. Section and key names are case-insensitive.
    let last = |entries: &[(String, String)], key: &str| -> Option<String> {
        entries.iter().rev().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.clone()).filter(|v| !v.is_empty())
    };
    Ok(read_keys()
        .map(|k| ConfigValue { key: k.to_string(), global: last(&global, k), local: last(&local, k), effective: last(&all, k) })
        .collect())
}

/// Parse `git config --null --list`: entries end with NUL, the key and value are split by the first newline
/// (a key with no value has no newline).
fn parse_list(out: &str) -> Vec<(String, String)> {
    out.split('\0')
        .filter(|e| !e.is_empty())
        .map(|e| match e.split_once('\n') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (e.to_string(), String::new()),
        })
        .collect()
}

/// Set a key in a scope; `value` empty or `None` removes it from that scope.
pub fn config_write(repo: Option<&Path>, scope: ConfigScope, key: &str, value: Option<&str>) -> Result<()> {
    if !KEYS.contains(&key) {
        return Err(CoreError::new(ErrorCode::InvalidName, format!("不能在这里修改 {key}")));
    }
    if scope == ConfigScope::Local && repo.is_none() {
        return Err(CoreError::new(ErrorCode::NoRepo, "还没有打开仓库"));
    }
    let dir = work_dir(repo);
    let flag = if scope == ConfigScope::Global { "--global" } else { "--local" };
    let value = value.map(str::trim).filter(|v| !v.is_empty());
    // Proxy address: always remembered in Strand's key; git's key only changes while the proxy is on
    if let Some((real, saved)) = PROXY_KEYS.iter().find(|(r, _)| *r == key) {
        if let Some(v) = value {
            validate(&dir, key, v)?;
        }
        set_raw(&dir, flag, saved, value)?;
        if get_raw(&dir, flag, real).is_some() || (value.is_some() && proxy_on(&dir, flag)) {
            set_raw(&dir, flag, real, value)?;
        }
        return Ok(());
    }
    match value {
        None => {
            // --unset-all exits with 5 and no message when the key isn't set; that's fine
            if let Err(e) = git_cli::run(&dir, &["config", flag, "--unset-all", key], None) {
                let stderr = e.detail.as_ref().and_then(|d| d.get("stderr")).and_then(|v| v.as_str()).unwrap_or("");
                if !stderr.is_empty() {
                    return Err(e);
                }
            }
            Ok(())
        }
        Some(v) => {
            validate(&dir, key, v)?;
            git_cli::run(&dir, &["config", flag, key, v], None).map(|_| ())
        }
    }
}

/// Where to run git: the repository, or the home directory for global settings without a repository
fn work_dir(repo: Option<&Path>) -> PathBuf {
    repo.map(Path::to_path_buf)
        .or_else(|| std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from))
        .unwrap_or_else(std::env::temp_dir)
}

fn validate(dir: &Path, key: &str, v: &str) -> Result<()> {
    let bad = |m: &str| Err(CoreError::new(ErrorCode::InvalidName, m.to_string()));
    match key {
        "user.name" => {
            if v.contains(['<', '>', '\n']) {
                return bad("用户名里不能有 < > 或换行");
            }
        }
        "user.email" => {
            let ok = v.contains('@') && !v.contains([' ', '<', '>', '\n']) && !v.starts_with('@') && !v.ends_with('@');
            if !ok {
                return bad("邮箱的格式不对，应该像 name@example.com");
            }
        }
        "http.proxy" | "https.proxy" => {
            let Some((scheme, rest)) = v.split_once("://") else {
                return bad("代理地址要带协议，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080");
            };
            let scheme = scheme.to_ascii_lowercase();
            if !["http", "https", "socks4", "socks4a", "socks5", "socks5h"].contains(&scheme.as_str()) {
                return bad("代理只支持 http、https、socks4、socks5 协议");
            }
            let authority = rest.rsplit('@').next().unwrap_or("").split('/').next().unwrap_or("");
            // host[:port], or [ipv6][:port]
            let (host, port) = if let Some(r) = authority.strip_prefix('[') {
                match r.split_once(']') {
                    Some((h, tail)) => (h, tail.strip_prefix(':')),
                    None => ("", None),
                }
            } else {
                match authority.rsplit_once(':') {
                    Some((h, p)) => (h, Some(p)),
                    None => (authority, None),
                }
            };
            if host.is_empty() || (!authority.starts_with('[') && host.contains(':')) || v.contains(char::is_whitespace) {
                return bad("代理地址里没有主机名，应该像 http://127.0.0.1:7890");
            }
            if let Some(p) = port
                && !matches!(p.parse::<u32>(), Ok(1..=65535))
            {
                return bad("代理的端口不对，应该是 1 到 65535 之间的数字");
            }
        }
        "core.autocrlf" => {
            if !["true", "false", "input"].contains(&v) {
                return bad("core.autocrlf 只能是 true、false 或 input");
            }
        }
        "init.defaultBranch" if git_cli::run(dir, &["check-ref-format", "--branch", v], None).is_err() => {
            return bad("这不是一个合法的分支名");
        }
        _ => {}
    }
    Ok(())
}

fn get_raw(dir: &Path, flag: &str, key: &str) -> Option<String> {
    git_cli::run(dir, &["config", flag, "--get", key], None).ok().map(|s| s.trim_end_matches(['\n', '\r']).to_string()).filter(|s| !s.is_empty())
}

/// Set or remove (`None`) one key in a scope
fn set_raw(dir: &Path, flag: &str, key: &str, value: Option<&str>) -> Result<()> {
    match value {
        Some(v) => git_cli::run(dir, &["config", flag, key, v], None).map(|_| ()),
        None => match git_cli::run(dir, &["config", flag, "--unset-all", key], None) {
            Ok(_) => Ok(()),
            Err(e) if e.detail.as_ref().and_then(|d| d.get("stderr")).and_then(|v| v.as_str()).unwrap_or("").is_empty() => Ok(()),
            Err(e) => Err(e),
        },
    }
}

/// The proxy is on in this scope when any of git's proxy keys is set there
fn proxy_on(dir: &Path, flag: &str) -> bool {
    PROXY_KEYS.iter().any(|(real, _)| get_raw(dir, flag, real).is_some())
}

/// Turn the proxy on or off in a scope. Off removes git's proxy keys and keeps the addresses in Strand's keys
/// (an address set from the command line is saved first); on copies the saved addresses back into git's keys.
pub fn proxy_enable(repo: Option<&Path>, scope: ConfigScope, on: bool) -> Result<()> {
    if scope == ConfigScope::Local && repo.is_none() {
        return Err(CoreError::new(ErrorCode::NoRepo, "还没有打开仓库"));
    }
    let dir = work_dir(repo);
    let flag = if scope == ConfigScope::Global { "--global" } else { "--local" };
    if on {
        let mut any = false;
        for (real, saved) in PROXY_KEYS {
            if let Some(addr) = get_raw(&dir, flag, saved).or_else(|| get_raw(&dir, flag, real)) {
                set_raw(&dir, flag, real, Some(&addr))?;
                any = true;
            }
        }
        if !any {
            return Err(CoreError::new(ErrorCode::InvalidName, "先填写代理地址"));
        }
    } else {
        for (real, saved) in PROXY_KEYS {
            if let Some(addr) = get_raw(&dir, flag, real) {
                if get_raw(&dir, flag, saved).is_none() {
                    set_raw(&dir, flag, saved, Some(&addr))?;
                }
                set_raw(&dir, flag, real, None)?;
            }
        }
    }
    Ok(())
}
