//! File preview helpers:
//! - textconv: a binary file the repository's `.gitattributes` gives a diff driver with `diff.<driver>.textconv`
//!   (for example `*.docx diff=word` and `textconv = docx2txt`) is shown as the text that command makes, the same
//!   text `git diff` and `git log -p` show;
//! - preview plugins: folders under the app's `plugins` directory, each with a `manifest.json` naming the file
//!   extensions it shows and an HTML page that draws them. The page runs in a sandboxed frame and is only sent the
//!   file's bytes; it can't reach Strand, the repository or the network.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode};
use crate::git_cli;
use crate::Result;

/// Read at most this much converted text
const MAX_TEXT: usize = 4 << 20;
/// A textconv command that runs longer is stopped
const TEXTCONV_TIMEOUT: Duration = Duration::from_secs(20);

/// The diff driver with a textconv command for this path, if any
pub fn textconv_driver(dir: &Path, path: &str) -> Option<String> {
    let out = git_cli::run(dir, &["check-attr", "-z", "diff", "--", path], None).ok()?;
    // path \0 attribute \0 value \0
    let value = out.split('\0').nth(2)?.trim().to_string();
    if matches!(value.as_str(), "" | "unspecified" | "unset" | "set") {
        return None;
    }
    let key = format!("diff.{value}.textconv");
    let cmd = git_cli::run(dir, &["config", "--get", &key], None).ok()?;
    (!cmd.trim().is_empty()).then_some(value)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Textconv {
    pub text: String,
    /// The command that made it (`diff.<driver>.textconv`)
    pub command: String,
    pub truncated: bool,
}

/// The file as text through its textconv command: at a revision (`git cat-file --textconv`) or in the worktree
/// (the command run on the file, the way Git runs it)
pub fn textconv(dir: &Path, path: &str, rev: Option<&str>) -> Result<Textconv> {
    crate::file_history::check_rel_path(path)?;
    let driver = textconv_driver(dir, path).ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("{path} 没有设置 textconv 转换命令")))?;
    let command = git_cli::run(dir, &["config", "--get", &format!("diff.{driver}.textconv")], None)?.trim().to_string();
    let mut text = match rev {
        Some(rev) => {
            if rev.is_empty() || rev.starts_with('-') {
                return Err(CoreError::new(ErrorCode::InvalidName, format!("版本名不对：{rev}")));
            }
            git_cli::run(dir, &["cat-file", "--textconv", &format!("{rev}:{path}")], None)?
        }
        None => {
            let full = crate::file_history::inside_worktree_existing(dir, path)?
                .filter(|p| p.is_file())
                .ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("工作区里没有这个文件：{path}")))?;
            run_textconv(dir, &command, &full)?
        }
    };
    let truncated = text.len() > MAX_TEXT;
    if truncated {
        let mut end = MAX_TEXT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    Ok(Textconv { text, command, truncated })
}

/// A shell like the one Git uses for textconv: `sh`, on Windows the one that comes with Git for Windows
fn shell() -> Command {
    #[cfg(windows)]
    {
        if let Ok(exec) = git_cli::run(Path::new("."), &["--exec-path"], None) {
            // <root>/mingw64/libexec/git-core → <root>/usr/bin/sh.exe or <root>/bin/sh.exe
            let exec = PathBuf::from(exec.trim());
            if let Some(root) = exec.ancestors().nth(3) {
                for sh in [root.join("usr").join("bin").join("sh.exe"), root.join("bin").join("sh.exe")] {
                    if sh.is_file() {
                        return Command::new(sh);
                    }
                }
            }
        }
    }
    Command::new("sh")
}

fn run_textconv(dir: &Path, command: &str, file: &Path) -> Result<String> {
    let mut cmd = shell();
    // The same form Git uses: the command, then the file as "$@"
    cmd.arg("-c").arg(format!("{command} \"$@\"")).arg(command).arg(file);
    cmd.current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    git_cli::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| CoreError::git("运行 textconv 命令失败", e))?;
    let mut out = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut out).take(MAX_TEXT as u64 + 1).read_to_end(&mut buf);
        // Drain the rest so the command isn't blocked writing
        let _ = std::io::copy(&mut out, &mut std::io::sink());
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() > TEXTCONV_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CoreError::new(ErrorCode::GitFailed, format!("textconv 命令超过 {} 秒没有结束，已停止", TEXTCONV_TIMEOUT.as_secs())));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(CoreError::git("等待 textconv 命令结束失败", e)),
        }
    };
    let buf = reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    if !status.success() {
        let first = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
        return Err(CoreError::new(ErrorCode::GitFailed, format!("textconv 命令失败：{first}")).with_detail(serde_json::json!({ "stderr": stderr })));
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// ---------- Preview plugins ----------

#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    #[serde(rename = "apiVersion")]
    api_version: Option<u32>,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    filenames: Vec<String>,
    entry: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Plugin {
    /// The folder's name
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(rename = "apiVersion")]
    pub api_version: u32,
    /// Lowercase, without the dot; "*" means any file
    pub extensions: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub filenames: Vec<String>,
    /// The page inside the folder
    pub entry: String,
    /// Why it can't be used (bad manifest, missing page); such plugins aren't offered
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && !id.starts_with('.') && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// A relative path inside a plugin: no "..", no absolute parts
fn safe_rel(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('/') && !p.contains('\\') && p.split('/').all(|s| !s.is_empty() && s != ".." && s != "." && !s.contains(':'))
}

/// The plugins in `root`, sorted by name; a folder with a broken manifest is listed with its error
pub fn plugins(root: &Path) -> Vec<Plugin> {
    let Ok(rd) = std::fs::read_dir(root) else { return Vec::new() };
    let mut list: Vec<Plugin> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let id = e.file_name().to_string_lossy().into_owned();
            valid_id(&id).then(|| load(&e.path(), id))
        })
        .collect();
    list.sort_by_key(|p| p.name.to_lowercase());
    list
}

fn load(dir: &Path, id: String) -> Plugin {
    let mut p = Plugin { name: id.clone(), id, version: String::new(), description: String::new(), api_version: 1, extensions: Vec::new(), filenames: Vec::new(), entry: "index.html".into(), error: None };
    let text = match std::fs::read_to_string(dir.join("manifest.json")) {
        Ok(t) => t,
        Err(_) => {
            p.error = Some("没有 manifest.json".into());
            return p;
        }
    };
    let m: Manifest = match serde_json::from_str(&text) {
        Ok(m) => m,
        Err(e) => {
            p.error = Some(format!("manifest.json 格式不对：{e}"));
            return p;
        }
    };
    if let Some(n) = m.name.filter(|n| !n.trim().is_empty()) {
        p.name = n.trim().to_string();
    }
    p.version = m.version.unwrap_or_default();
    p.description = m.description.unwrap_or_default();
    p.api_version = m.api_version.unwrap_or(1);
    p.extensions = m.extensions.iter().map(|e| e.trim().trim_start_matches('.').to_lowercase()).filter(|e| !e.is_empty()).collect();
    p.filenames = m.filenames.iter().map(|name| name.trim().to_lowercase()).filter(|name| !name.is_empty()).collect();
    p.extensions.sort();
    p.extensions.dedup();
    p.filenames.sort();
    p.filenames.dedup();
    if let Some(e) = m.entry {
        p.entry = e.trim().to_string();
    }
    if p.api_version != 1 {
        p.error = Some(format!("不支持预览插件 API 版本 {}", p.api_version));
    } else if p.extensions.is_empty() && p.filenames.is_empty() {
        p.error = Some("manifest.json 里需要 extensions 或 filenames".into());
    } else if p.filenames.iter().any(|s| !safe_rel(s) || s.contains('/') || s.contains('*'))
        || p.extensions.iter().any(|s| s != "*" && s.split('.').any(|part| part.is_empty() || !part.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '+'))))
    {
        p.error = Some("预览插件的扩展名或文件名不对".into());
    } else if !safe_rel(&p.entry) {
        p.error = Some(format!("entry 不对：{}", p.entry));
    } else if asset_in(dir, &p.entry).is_none() {
        p.error = Some(format!("找不到页面 {}", p.entry));
    }
    p
}

/// A file a plugin page asks for (`<id>/<path>`), only inside that plugin's folder
pub fn plugin_file(root: &Path, url_path: &str) -> Option<PathBuf> {
    let url_path = url_path.trim_start_matches('/');
    let (id, rest) = url_path.split_once('/')?;
    if !valid_id(id) || !safe_rel(rest) {
        return None;
    }
    let dir = root.join(id);
    if !dir.symlink_metadata().ok()?.is_dir() {
        return None;
    }
    asset_in(&dir, rest)
}

fn asset_in(dir: &Path, rest: &str) -> Option<PathBuf> {
    let dir = dir.canonicalize().ok()?;
    let file = dir.join(rest).canonicalize().ok()?;
    (file.starts_with(&dir) && file.is_file()).then_some(file)
}

/// The content type for a plugin file
pub fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

const SAMPLE_ID: &str = "hex-viewer";
const SAMPLE_MANIFEST: &str = r#"{
  "name": "十六进制查看器",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "示例插件：按十六进制和 ASCII 显示任何文件的字节。照着它写自己的插件。",
  "extensions": ["*"],
  "entry": "index.html"
}
"#;
const SAMPLE_PAGE: &str = r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* Strand sends the theme; follow it with two sets of colors */
  body { margin: 0; font: 12px/1.6 ui-monospace, Menlo, Consolas, monospace; background: #fff; color: #222; }
  body.dark { background: #1e1f22; color: #ccc; }
  header { position: sticky; top: 0; padding: 6px 12px; background: inherit; border-bottom: 1px solid #8884; font-family: system-ui, sans-serif; }
  pre { margin: 0; padding: 8px 12px; }
  .off { color: #888; }
  .asc { color: #3a7; }
</style>
</head>
<body>
<header id="head">等待文件…</header>
<pre id="out"></pre>
<script src="main.js"></script>
</body>
</html>
"#;
const SAMPLE_SCRIPT: &str = r#"// Strand's preview plugin protocol:
// 1. When the page is ready, tell Strand:  parent.postMessage({ type: "strand:ready" }, "*")
// 2. Strand sends the file:  { type: "strand:file", apiVersion: 1, name, path, ext, rev, size, bytes: ArrayBuffer, theme: "light" | "dark", lang: "zh" | "en" }
// 3. When the app's theme changes:  { type: "strand:theme", theme }
// The page runs in a sandbox: no network, no access to Strand or the repository.

const MAX = 64 * 1024;
const hex = (n, w) => n.toString(16).padStart(w, "0");

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || typeof m !== "object") return;
  if (m.type === "strand:theme" || m.type === "strand:file") document.body.classList.toggle("dark", m.theme === "dark");
  if (m.type !== "strand:file") return;
  const bytes = new Uint8Array(m.bytes);
  const shown = Math.min(bytes.length, MAX);
  document.getElementById("head").textContent =
    `${m.name} · ${bytes.length.toLocaleString()} bytes` + (shown < bytes.length ? ` · first ${shown.toLocaleString()} shown` : "");
  const out = document.getElementById("out");
  out.textContent = "";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < shown; i += 16) {
    const row = bytes.subarray(i, Math.min(i + 16, shown));
    const off = document.createElement("span");
    off.className = "off";
    off.textContent = hex(i, 8) + "  ";
    const asc = document.createElement("span");
    asc.className = "asc";
    asc.textContent = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    frag.append(off, Array.from(row, (b) => hex(b, 2)).join(" ").padEnd(49), asc, "\n");
  }
  out.append(frag);
});

parent.postMessage({ type: "strand:ready" }, "*");
"#;

/// Write the sample plugin (a hex viewer) into `root`, replacing an earlier copy of it
pub fn write_sample(root: &Path) -> Result<Plugin> {
    let dir = root.join(SAMPLE_ID);
    std::fs::create_dir_all(&dir).map_err(|e| CoreError::git("创建插件文件夹失败", e))?;
    for (name, body) in [("manifest.json", SAMPLE_MANIFEST), ("index.html", SAMPLE_PAGE), ("main.js", SAMPLE_SCRIPT)] {
        std::fs::write(dir.join(name), body).map_err(|e| CoreError::git("写入示例插件失败", e))?;
    }
    Ok(load(&dir, SAMPLE_ID.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(p: &Path, args: &[&str]) {
        let ok = Command::new("git").args(args).current_dir(p).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap().status.success();
        assert!(ok, "{args:?}");
    }

    #[test]
    fn textconv_worktree_and_revision() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.name", "A"]);
        git(p, &["config", "user.email", "a@example.com"]);
        std::fs::write(p.join(".gitattributes"), "*.bin diff=upper\n").unwrap();
        std::fs::write(p.join("a.bin"), b"hello\0world\n").unwrap();
        std::fs::write(p.join("plain.txt"), "x\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "init"]);
        assert_eq!(textconv_driver(p, "a.bin"), None, "no command configured yet");
        // The converter turns NULs into spaces and uppercases; paths with spaces must work too
        git(p, &["config", "diff.upper.textconv", "tr '\\000a-z' ' A-Z' <"]);
        assert_eq!(textconv_driver(p, "a.bin").as_deref(), Some("upper"));
        assert_eq!(textconv_driver(p, "plain.txt"), None);

        let t = textconv(p, "a.bin", Some("HEAD")).unwrap();
        assert_eq!(t.text, "HELLO WORLD\n");
        std::fs::write(p.join("a.bin"), b"changed\0now\n").unwrap();
        let t = textconv(p, "a.bin", None).unwrap();
        assert_eq!(t.text, "CHANGED NOW\n");
        assert!(!t.truncated);

        std::fs::write(p.join("my file.bin"), b"sp\0ace\n").unwrap();
        assert_eq!(textconv(p, "my file.bin", None).unwrap().text, "SP ACE\n");

        // A failing command reports its error
        git(p, &["config", "diff.upper.textconv", "false"]);
        assert!(textconv(p, "a.bin", None).is_err());
        assert!(textconv(p, "plain.txt", None).is_err());
        // Path traversal and flag-like revisions are rejected
        assert_eq!(textconv(p, "../a.bin", None).unwrap_err().code, ErrorCode::InvalidName);
        assert_eq!(textconv(p, "a.bin", Some("--batch")).unwrap_err().code, ErrorCode::InvalidName);
    }

    #[test]
    fn plugins_list_sample_and_files() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        assert!(plugins(&root.join("missing")).is_empty());

        let s = write_sample(root).unwrap();
        assert_eq!(s.id, "hex-viewer");
        assert_eq!(s.api_version, 1);
        assert_eq!(s.extensions, vec!["*"]);
        assert!(s.error.is_none(), "{:?}", s.error);

        // A plugin with a broken manifest is listed with why
        std::fs::create_dir_all(root.join("broken")).unwrap();
        std::fs::write(root.join("broken/manifest.json"), "{ nope").unwrap();
        // One with no page
        std::fs::create_dir_all(root.join("nopage")).unwrap();
        std::fs::write(root.join("nopage/manifest.json"), r#"{"name":"No page","extensions":[".IPYNB"]}"#).unwrap();
        // Folders with odd names are skipped
        std::fs::create_dir_all(root.join(".hidden")).unwrap();

        let list = plugins(root);
        assert_eq!(list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec!["broken", "nopage", "hex-viewer"]);
        assert!(list[0].error.as_deref().unwrap().contains("格式不对"));
        assert_eq!(list[1].extensions, vec!["ipynb"]);
        assert!(list[1].error.as_deref().unwrap().contains("index.html"));

        // Files are served only from inside the plugin's folder
        assert!(plugin_file(root, "hex-viewer/index.html").is_some());
        assert!(plugin_file(root, "/hex-viewer/main.js").is_some());
        assert!(plugin_file(root, "hex-viewer/../broken/manifest.json").is_none());
        assert!(plugin_file(root, "hex-viewer/nothing.js").is_none());
        assert!(plugin_file(root, "../etc/passwd").is_none());
        assert!(plugin_file(root, "hex-viewer").is_none());
        assert_eq!(mime_of(Path::new("a/b.JS")), "text/javascript; charset=utf-8");
    }

    #[test]
    fn preview_manifest_accepts_new_formats_and_checks_api_compatibility() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("custom-format");
        std::fs::create_dir(&plugin).unwrap();
        std::fs::write(plugin.join("index.html"), "<!doctype html>").unwrap();
        let manifest = plugin.join("manifest.json");
        std::fs::write(&manifest, r#"{"extensions":[".JSONL","NDJSON","jsonl","data.gz"],"filenames":["Dockerfile"],"apiVersion":1}"#).unwrap();
        let p = plugins(dir.path()).pop().unwrap();
        assert!(p.error.is_none());
        assert_eq!(p.extensions, ["data.gz", "jsonl", "ndjson"]);
        assert_eq!(p.filenames, ["dockerfile"]);
        assert_eq!(serde_json::to_value(p).unwrap()["apiVersion"], 1);

        std::fs::write(&manifest, r#"{"filenames":["Makefile"]}"#).unwrap();
        let p = plugins(dir.path()).pop().unwrap();
        assert_eq!(p.api_version, 1);
        assert!(p.error.is_none());

        std::fs::write(&manifest, r#"{"extensions":["jsonl"],"apiVersion":2}"#).unwrap();
        assert!(plugins(dir.path())[0].error.as_deref().unwrap().contains("API 版本 2"));
    }
}
