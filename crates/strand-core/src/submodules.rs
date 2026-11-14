//! Submodules: other repositories checked out inside this one at a commit the superproject records.
//!
//! Listed in the branch tree with their state; "update" (initializing when needed) checks out the recorded commit
//! (`git submodule update --init --recursive`), and a submodule can be opened in Strand like any repository.
//! Updating only changes the submodules' own worktrees, which the op log doesn't snapshot, so it can't be undone.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::remote::{Cancel, Progress};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubmoduleState {
    /// Not checked out yet (`git submodule init` / `update --init` needed)
    Uninitialized,
    /// Checked out at the recorded commit, no changes inside
    Clean,
    /// Checked out at a different commit than the superproject records
    Moved,
    /// Uncommitted or untracked changes inside
    Dirty,
    /// In a merge conflict in the superproject
    Conflict,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Submodule {
    /// Path relative to the superproject root
    pub path: String,
    /// Name in .gitmodules (usually the path)
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The commit the superproject records (in the index)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorded: Option<String>,
    /// The commit checked out in the submodule; empty when not initialized
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    pub state: SubmoduleState,
    /// Uncommitted or untracked changes inside (also when `state` is Moved)
    pub dirty: bool,
}

/// List the submodules (non-recursive); empty without a .gitmodules file
pub fn list(dir: &Path) -> Result<Vec<Submodule>> {
    if !dir.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    // Names and URLs from .gitmodules
    let cfg = git_cli::run(dir, &["config", "--file", ".gitmodules", "--null", "--get-regexp", r"^submodule\..*\.(path|url)$"], None).unwrap_or_default();
    let mut names: HashMap<String, String> = HashMap::new(); // path → name
    let mut urls: HashMap<String, String> = HashMap::new(); // name → url
    for e in cfg.split('\0').filter(|e| !e.is_empty()) {
        let Some((k, v)) = e.split_once('\n') else { continue };
        let Some(rest) = k.strip_prefix("submodule.") else { continue };
        if let Some(name) = rest.strip_suffix(".path") {
            names.insert(v.to_string(), name.to_string());
        } else if let Some(name) = rest.strip_suffix(".url") {
            urls.insert(name.to_string(), v.to_string());
        }
    }
    // Recorded commits: index entries with mode 160000
    let staged = git_cli::run(dir, &["ls-files", "--stage", "-z"], None)?;
    let mut recorded: Vec<(String, String)> = Vec::new();
    for e in staged.split('\0').filter(|e| e.starts_with("160000 ")) {
        let Some((meta, path)) = e.split_once('\t') else { continue };
        let id = meta.split(' ').nth(1).unwrap_or_default().to_string();
        if !recorded.iter().any(|(p, _)| p == path) {
            recorded.push((path.to_string(), id));
        }
    }
    // State per submodule: prefix '-' not initialized, '+' other commit checked out, 'U' conflict
    let status = git_cli::run(dir, &["submodule", "status"], None).unwrap_or_default();
    let mut prefix: HashMap<String, (char, String)> = HashMap::new();
    for line in status.lines() {
        let mut chars = line.chars();
        let Some(c) = chars.next() else { continue };
        let rest: String = chars.collect();
        let mut parts = rest.splitn(2, ' ');
        let id = parts.next().unwrap_or_default().to_string();
        let path = parts.next().unwrap_or_default();
        let path = path.rsplit_once(" (").map_or(path, |(p, _)| p).to_string();
        prefix.insert(path, (c, id));
    }
    // Changes inside: porcelain v2 marks submodules as S<c><m><u>
    let st = git_cli::run(dir, &["status", "--porcelain=v2", "-z", "--ignore-submodules=none", "--untracked-files=no"], None).unwrap_or_default();
    let mut dirty: HashMap<String, bool> = HashMap::new();
    for e in st.split('\0') {
        let f: Vec<&str> = e.splitn(9, ' ').collect();
        if f.len() == 9 && f[0] == "1" && f[2].starts_with('S') {
            let sub = f[2].as_bytes();
            dirty.insert(f[8].to_string(), sub.get(2) == Some(&b'M') || sub.get(3) == Some(&b'U'));
        }
    }
    // Paths from .gitmodules that aren't in the index (not added yet) are left out
    Ok(recorded
        .into_iter()
        .map(|(path, rec)| {
            let name = names.get(&path).cloned().unwrap_or_else(|| path.clone());
            let url = urls.get(&name).cloned();
            let (c, id) = prefix.get(&path).cloned().unwrap_or((' ', rec.clone()));
            let is_dirty = dirty.get(&path).copied().unwrap_or(false);
            let state = match c {
                '-' => SubmoduleState::Uninitialized,
                'U' => SubmoduleState::Conflict,
                '+' => SubmoduleState::Moved,
                _ if is_dirty => SubmoduleState::Dirty,
                _ => SubmoduleState::Clean,
            };
            let current = (state != SubmoduleState::Uninitialized).then_some(id);
            Submodule { path, name, url, recorded: Some(rec), current, state, dirty: is_dirty }
        })
        .collect())
}

/// Check out the recorded commit in these submodules (all when `paths` is empty), initializing and cloning them when
/// needed, nested submodules too. Uncommitted changes inside a submodule that would be overwritten make it fail.
pub fn update(dir: &Path, paths: &[String], cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    let known = list(dir)?;
    for p in paths {
        if !known.iter().any(|s| &s.path == p) {
            return Err(CoreError::new(ErrorCode::NotFound, format!("没有这个子模块：{p}")));
        }
    }
    let mut args = vec!["submodule", "update", "--init", "--recursive", "--progress", "--"];
    args.extend(paths.iter().map(String::as_str));
    crate::remote::run_net(dir, &args, cancel, progress).map(|_| ())
}
