//! Pull requests (GitHub) and merge requests (GitLab) for the repository's origin: list the open ones, look at a
//! request's checks, and create one from a branch.
//!
//! The token is the one Git itself uses for that host over HTTPS: read with `git credential fill`, so whatever
//! credential helper the user has (macOS keychain, Git Credential Manager…) supplies it. When there's none, the user
//! enters a token once and it's handed to `git credential approve`, i.e. stored by that same helper; Strand never
//! keeps it. Credential commands are run directly (not through the logged git runner), so tokens never reach the
//! console or the log file.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;

use crate::error::{CoreError, ErrorCode, Result};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostKind {
    Github,
    Gitlab,
}

/// Where the repository lives and how to reach its API
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Hosting {
    pub kind: HostKind,
    pub host: String,
    /// owner/repo (GitLab: the full group/subgroup/project path)
    pub path: String,
    /// The repository's page
    pub web_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    /// Source branch
    pub head: String,
    /// The source branch's latest commit
    pub head_sha: String,
    /// Target branch
    pub base: String,
    pub draft: bool,
    pub url: String,
    /// Last updated, Unix seconds
    pub updated: i64,
}

/// A request's CI checks, counted
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Checks {
    pub total: u32,
    pub success: u32,
    pub failed: u32,
    pub pending: u32,
}

/// Split a remote URL (https, ssh or scp form) into host and path; `None` when it isn't one
pub fn parse_remote(remote: &str) -> Option<(String, String)> {
    let u = remote.trim();
    let (host, path) = if let Some(rest) = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")) {
        let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
        rest.split_once('/')?
    } else if let Some(rest) = u.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (hp, path) = rest.split_once('/')?;
        (hp.split(':').next()?, path)
    } else if !u.contains("://") && u.contains(':') {
        let rest = u.split_once('@').map(|(_, r)| r).unwrap_or(u);
        rest.split_once(':')?
    } else {
        return None;
    };
    let host = host.split(':').next()?.to_lowercase();
    let path = path.trim_matches('/').trim_end_matches(".git").to_string();
    if host.is_empty() || path.is_empty() || !path.contains('/') {
        return None;
    }
    Some((host, path))
}

/// GitHub (github.com or a GitHub Enterprise host containing "github") or GitLab (a host containing "gitlab")
pub fn hosting_of(remote: &str) -> Option<Hosting> {
    let (host, path) = parse_remote(remote)?;
    let kind = if host.contains("github") {
        HostKind::Github
    } else if host.contains("gitlab") {
        HostKind::Gitlab
    } else {
        return None;
    };
    Some(Hosting { kind, web_url: format!("https://{host}/{path}"), host, path })
}

/// The hosting of the repository's origin (or its first remote)
pub fn hosting_at(dir: &Path) -> Option<Hosting> {
    let remotes = crate::remote::remotes(dir);
    let name = if remotes.iter().any(|r| r == "origin") { "origin".to_string() } else { remotes.first()?.clone() };
    let url = crate::git_cli::run(dir, &["remote", "get-url", &name], None).ok()?;
    hosting_of(url.trim())
}

impl Hosting {
    fn api(&self) -> String {
        match (self.kind, self.host.as_str()) {
            (HostKind::Github, "github.com") => "https://api.github.com".into(),
            (HostKind::Github, h) => format!("https://{h}/api/v3"),
            (HostKind::Gitlab, h) => format!("https://{h}/api/v4"),
        }
    }
    fn project(&self) -> String {
        self.path.replace('/', "%2F")
    }
    /// The user name stored with a token entered in Strand (any name works with tokens over HTTPS)
    fn token_user(&self) -> &'static str {
        match self.kind {
            HostKind::Github => "x-access-token",
            HostKind::Gitlab => "oauth2",
        }
    }
}

fn credential(dir: &Path, op: &str, input: &str) -> Option<String> {
    let mut child = Command::new("git")
        .args(["credential", op])
        .current_dir(dir)
        // Never ask: no terminal prompt and no askpass program, only what the credential helper already has
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(input.as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The token Git has for this host (via the user's credential helper), if any
pub fn token(dir: &Path, h: &Hosting) -> Option<String> {
    let out = credential(dir, "fill", &format!("protocol=https\nhost={}\n\n", h.host))?;
    out.lines().find_map(|l| l.strip_prefix("password=")).map(str::to_string).filter(|t| !t.is_empty())
}

/// Hand a token to the user's credential helper, so Git (and Strand next time) can use it
pub fn save_token(dir: &Path, h: &Hosting, token: &str) -> Result<()> {
    let token = token.trim();
    if token.is_empty() || token.contains(['\n', '\r']) {
        return Err(CoreError::new(ErrorCode::InvalidName, "令牌不对"));
    }
    credential(dir, "approve", &format!("protocol=https\nhost={}\nusername={}\npassword={token}\n\n", h.host, h.token_user()))
        .map(|_| ())
        .ok_or_else(|| CoreError::new(ErrorCode::GitFailed, "没能把令牌交给 Git 的凭据助手保存（先配置 credential.helper）"))
}

fn need_token(dir: &Path, h: &Hosting) -> Result<String> {
    token(dir, h).ok_or_else(|| {
        CoreError::new(ErrorCode::AuthFailed, "还没有这个网站的访问令牌").with_detail(serde_json::json!({ "need_token": true, "host": h.host }))
    })
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(20))).http_status_as_error(false).build().into()
}

/// Send a request and read JSON, turning HTTP errors into messages people can act on
fn call(h: &Hosting, token: &str, method: &str, url: &str, body: Option<Value>) -> Result<Value> {
    let a = agent();
    let auth = format!("Bearer {token}");
    let res = match (method, body) {
        ("POST", Some(b)) => a
            .post(url)
            .header("Authorization", &auth)
            .header("Accept", "application/json")
            .header("User-Agent", "Strand")
            .send_json(b),
        _ => a.get(url).header("Authorization", &auth).header("Accept", "application/json").header("User-Agent", "Strand").call(),
    };
    let mut res = res.map_err(|e| CoreError::new(ErrorCode::Network, format!("连不上 {}：{e}", h.host)))?;
    let status = res.status().as_u16();
    let v: Value = res.body_mut().read_json().unwrap_or(Value::Null);
    match status {
        200..=299 => Ok(v),
        401 => Err(CoreError::new(ErrorCode::AuthFailed, "访问令牌无效或已过期").with_detail(serde_json::json!({ "need_token": true, "host": h.host }))),
        403 => Err(CoreError::new(ErrorCode::AuthFailed, format!("没有权限：{}", message_of(&v)))),
        404 => Err(CoreError::new(ErrorCode::NotFound, "找不到这个仓库，或者令牌没有访问它的权限")),
        422 | 409 | 400 => Err(CoreError::new(ErrorCode::InvalidName, format!("网站拒绝了：{}", message_of(&v)))),
        _ => Err(CoreError::new(ErrorCode::Network, format!("{} 返回 {status}：{}", h.host, message_of(&v)))),
    }
}

/// The error message in a GitHub or GitLab error body
fn message_of(v: &Value) -> String {
    let base = v.get("message").map(|m| if let Some(s) = m.as_str() { s.to_string() } else { m.to_string() }).unwrap_or_default();
    let more: Vec<String> = v
        .get("errors")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|e| e.get("message").and_then(Value::as_str).map(str::to_string).or_else(|| e.as_str().map(str::to_string))).collect())
        .unwrap_or_default();
    [base, more.join("；")].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("：")
}

fn unix(s: Option<&str>) -> i64 {
    // ISO 8601 "2026-11-14T08:30:00Z" (GitLab may add milliseconds and an offset); seconds precision is enough here
    let Some(s) = s else { return 0 };
    let d: Vec<i64> = s.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).take(6).filter_map(|p| p.parse().ok()).collect();
    if d.len() < 6 {
        return 0;
    }
    let (y, m, day) = (d[0], d[1], d[2]);
    // Days from civil (Howard Hinnant's algorithm)
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    days * 86400 + d[3] * 3600 + d[4] * 60 + d[5]
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    path.iter().try_fold(v, |v, k| v.get(*k)).and_then(Value::as_str).unwrap_or("")
}

/// Read a GitHub pull request object
pub fn parse_github(v: &Value) -> PullRequest {
    PullRequest {
        number: v.get("number").and_then(Value::as_u64).unwrap_or(0),
        title: str_at(v, &["title"]).into(),
        author: str_at(v, &["user", "login"]).into(),
        head: str_at(v, &["head", "ref"]).into(),
        head_sha: str_at(v, &["head", "sha"]).into(),
        base: str_at(v, &["base", "ref"]).into(),
        draft: v.get("draft").and_then(Value::as_bool).unwrap_or(false),
        url: str_at(v, &["html_url"]).into(),
        updated: unix(v.get("updated_at").and_then(Value::as_str)),
    }
}

/// Read a GitLab merge request object
pub fn parse_gitlab(v: &Value) -> PullRequest {
    PullRequest {
        number: v.get("iid").and_then(Value::as_u64).unwrap_or(0),
        title: str_at(v, &["title"]).into(),
        author: str_at(v, &["author", "username"]).into(),
        head: str_at(v, &["source_branch"]).into(),
        head_sha: str_at(v, &["sha"]).into(),
        base: str_at(v, &["target_branch"]).into(),
        draft: v.get("draft").and_then(Value::as_bool).or_else(|| v.get("work_in_progress").and_then(Value::as_bool)).unwrap_or(false),
        url: str_at(v, &["web_url"]).into(),
        updated: unix(v.get("updated_at").and_then(Value::as_str)),
    }
}

/// Open pull / merge requests, most recently updated first (at most 50)
pub fn list(dir: &Path, h: &Hosting) -> Result<Vec<PullRequest>> {
    let token = need_token(dir, h)?;
    let (url, parse): (String, fn(&Value) -> PullRequest) = match h.kind {
        HostKind::Github => (format!("{}/repos/{}/pulls?state=open&sort=updated&direction=desc&per_page=50", h.api(), h.path), parse_github),
        HostKind::Gitlab => (format!("{}/projects/{}/merge_requests?state=opened&order_by=updated_at&per_page=50", h.api(), h.project()), parse_gitlab),
    };
    let v = call(h, &token, "GET", &url, None)?;
    Ok(v.as_array().map(|a| a.iter().map(parse).collect()).unwrap_or_default())
}

/// Count GitHub check runs into a summary
pub fn checks_from_github(v: &Value) -> Checks {
    let mut c = Checks::default();
    for r in v.get("check_runs").and_then(Value::as_array).into_iter().flatten() {
        c.total += 1;
        match (str_at(r, &["status"]), str_at(r, &["conclusion"])) {
            ("completed", "success" | "neutral" | "skipped") => c.success += 1,
            ("completed", _) => c.failed += 1,
            _ => c.pending += 1,
        }
    }
    c
}

/// A GitLab pipeline status as a one-item summary
pub fn checks_from_gitlab(status: &str) -> Checks {
    match status {
        "" => Checks::default(),
        "success" | "skipped" | "manual" => Checks { total: 1, success: 1, ..Default::default() },
        "failed" | "canceled" => Checks { total: 1, failed: 1, ..Default::default() },
        _ => Checks { total: 1, pending: 1, ..Default::default() },
    }
}

/// The CI checks of a request's latest commit
pub fn checks(dir: &Path, h: &Hosting, number: u64, head_sha: &str) -> Result<Checks> {
    let token = need_token(dir, h)?;
    match h.kind {
        HostKind::Github => {
            let v = call(h, &token, "GET", &format!("{}/repos/{}/commits/{}/check-runs?per_page=100", h.api(), h.path, head_sha), None)?;
            Ok(checks_from_github(&v))
        }
        HostKind::Gitlab => {
            let v = call(h, &token, "GET", &format!("{}/projects/{}/merge_requests/{}", h.api(), h.project(), number), None)?;
            Ok(checks_from_gitlab(str_at(&v, &["head_pipeline", "status"])))
        }
    }
}

/// Create a pull / merge request from `head` into `base`. The branch must already be on the remote.
pub fn create(dir: &Path, h: &Hosting, title: &str, body: &str, head: &str, base: &str, draft: bool) -> Result<PullRequest> {
    if title.trim().is_empty() {
        return Err(CoreError::new(ErrorCode::InvalidName, "标题不能为空"));
    }
    if head == base {
        return Err(CoreError::new(ErrorCode::InvalidName, "源分支和目标分支不能相同"));
    }
    let token = need_token(dir, h)?;
    match h.kind {
        HostKind::Github => {
            let v = call(
                h,
                &token,
                "POST",
                &format!("{}/repos/{}/pulls", h.api(), h.path),
                Some(serde_json::json!({ "title": title.trim(), "body": body, "head": head, "base": base, "draft": draft })),
            )?;
            Ok(parse_github(&v))
        }
        HostKind::Gitlab => {
            // GitLab marks drafts by the title prefix
            let title = if draft { format!("Draft: {}", title.trim()) } else { title.trim().to_string() };
            let v = call(
                h,
                &token,
                "POST",
                &format!("{}/projects/{}/merge_requests", h.api(), h.project()),
                Some(serde_json::json!({ "title": title, "description": body, "source_branch": head, "target_branch": base })),
            )?;
            Ok(parse_gitlab(&v))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_paths() {
        let g = hosting_of("git@github.com:calabli/Strand.git").unwrap();
        assert_eq!((g.kind, g.host.as_str(), g.path.as_str(), g.api()), (HostKind::Github, "github.com", "calabli/Strand", "https://api.github.com".to_string()));
        let e = hosting_of("https://github.example.com/team/app").unwrap();
        assert_eq!(e.api(), "https://github.example.com/api/v3");
        let l = hosting_of("ssh://git@gitlab.example.com:2222/group/sub/proj.git").unwrap();
        assert_eq!((l.kind, l.path.as_str(), l.project()), (HostKind::Gitlab, "group/sub/proj", "group%2Fsub%2Fproj".to_string()));
        assert_eq!(l.web_url, "https://gitlab.example.com/group/sub/proj");
        assert!(hosting_of("https://bitbucket.org/a/b.git").is_none());
        assert!(hosting_of("/local/path").is_none());
    }

    #[test]
    fn parses_requests_and_checks() {
        let gh = serde_json::json!({ "number": 12, "title": "加搜索", "user": { "login": "linxia" }, "head": { "ref": "feature/search", "sha": "abc" },
            "base": { "ref": "main" }, "draft": true, "html_url": "https://github.com/a/b/pull/12", "updated_at": "2026-11-14T08:30:00Z" });
        let p = parse_github(&gh);
        assert_eq!((p.number, p.author.as_str(), p.head.as_str(), p.base.as_str(), p.draft), (12, "linxia", "feature/search", "main", true));
        assert_eq!(p.updated, 1_794_645_000);
        let gl = serde_json::json!({ "iid": 7, "title": "Draft: 修复", "author": { "username": "zhou" }, "source_branch": "fix", "target_branch": "main",
            "sha": "def", "draft": true, "web_url": "https://gitlab.com/g/p/-/merge_requests/7", "updated_at": "2026-11-14T08:30:00.123+00:00" });
        let m = parse_gitlab(&gl);
        assert_eq!((m.number, m.author.as_str(), m.head.as_str(), m.head_sha.as_str(), m.draft, m.updated), (7, "zhou", "fix", "def", true, 1_794_645_000));
        let runs = serde_json::json!({ "check_runs": [
            { "status": "completed", "conclusion": "success" }, { "status": "completed", "conclusion": "failure" },
            { "status": "in_progress", "conclusion": null }, { "status": "completed", "conclusion": "skipped" } ] });
        assert_eq!(checks_from_github(&runs), Checks { total: 4, success: 2, failed: 1, pending: 1 });
        assert_eq!(checks_from_gitlab("running"), Checks { total: 1, pending: 1, ..Default::default() });
        assert_eq!(message_of(&serde_json::json!({ "message": "Validation Failed", "errors": [{ "message": "A pull request already exists" }] })), "Validation Failed：A pull request already exists");
    }
}
