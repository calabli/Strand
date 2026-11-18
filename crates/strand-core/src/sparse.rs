//! Sparse checkout: in a huge repository, check out only the folders you work on (`git sparse-checkout`, cone mode).
//! Files directly in the repository's root are always checked out; a chosen folder brings everything under it.
//! History, branches and commits are unaffected: leaving files out only changes what's on disk.
//!
//! Before narrowing, files with uncommitted changes that would be left out are reported (Git would keep them on
//! disk with a warning, which is confusing), so they can be committed or stashed first.

use std::path::Path;

use serde::Serialize;

use crate::error::{CoreError, ErrorCode};
use crate::git_cli;
use crate::Result;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SparseState {
    pub enabled: bool,
    /// Cone mode (folders); false means the old pattern mode
    pub cone: bool,
    /// Checked-out folders (cone mode) or the patterns (pattern mode)
    pub dirs: Vec<String>,
    /// Files in the index / checked out on disk (to say how much is left out)
    pub total_files: u32,
    pub checked_out: u32,
}

fn config_bool(dir: &Path, key: &str) -> bool {
    git_cli::run(dir, &["config", "--type=bool", "--get", key], None).is_ok_and(|v| v.trim() == "true")
}

pub fn state(dir: &Path) -> Result<SparseState> {
    let enabled = config_bool(dir, "core.sparseCheckout");
    let cone = enabled && config_bool(dir, "core.sparseCheckoutCone");
    let dirs = if enabled {
        git_cli::run(dir, &["sparse-checkout", "list"], None).unwrap_or_default().lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
    } else {
        Vec::new()
    };
    // ls-files -t: "S " marks files left out (skip-worktree)
    let out = git_cli::run(dir, &["ls-files", "-t", "-z"], None).unwrap_or_default();
    let (mut total, mut out_n) = (0u32, 0u32);
    for e in out.split('\0').filter(|e| !e.is_empty()) {
        total += 1;
        if e.starts_with("S ") {
            out_n += 1;
        }
    }
    Ok(SparseState { enabled, cone, dirs, total_files: total, checked_out: total - out_n })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DirEntry {
    pub path: String,
    /// Files anywhere under it
    pub files: u32,
}

/// Every folder in HEAD with how many files it holds, sorted (for choosing what to check out). Capped at 50 000.
pub fn dirs(dir: &Path) -> Result<Vec<DirEntry>> {
    let out = git_cli::run(dir, &["ls-tree", "-r", "-z", "--name-only", "HEAD"], None).or_else(|e| {
        if git2::Repository::open(dir).is_ok_and(|r| r.head().is_err()) { Ok(String::new()) } else { Err(e) }
    })?;
    let mut counts: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    for f in out.split('\0').filter(|f| !f.is_empty()) {
        let mut p = f;
        while let Some(i) = p.rfind('/') {
            p = &p[..i];
            *counts.entry(p.to_string()).or_insert(0) += 1;
        }
    }
    Ok(counts.into_iter().take(50_000).map(|(path, files)| DirEntry { path, files }).collect())
}

/// Folders as Git wants them: no leading or trailing slashes, no "..", without ones already inside another chosen folder
fn normalize(dirs: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for d in dirs {
        let d = d.trim().trim_matches('/').to_string();
        if d.is_empty() {
            continue;
        }
        if d.split('/').any(|p| p == ".." || p == "." || p.is_empty()) || d.starts_with(".git/") || d == ".git" {
            return Err(CoreError::new(ErrorCode::InvalidName, format!("文件夹 {d} 不对")));
        }
        out.push(d);
    }
    out.sort();
    out.dedup();
    let all = out.clone();
    out.retain(|d| !all.iter().any(|p| p != d && d.starts_with(&format!("{p}/"))));
    Ok(out)
}

/// Files with uncommitted changes that checking out only `dirs` would leave out
pub fn changes_outside(dir: &Path, dirs: &[String]) -> Result<Vec<String>> {
    let dirs = normalize(dirs)?;
    let out = git_cli::run(dir, &["status", "--porcelain", "-z", "--untracked-files=no"], None)?;
    let mut list = Vec::new();
    let mut it = out.split('\0').filter(|e| !e.is_empty());
    while let Some(e) = it.next() {
        if e.len() < 4 {
            continue;
        }
        let (code, path) = (&e[..2], &e[3..]);
        if code.starts_with('R') || code.starts_with('C') {
            it.next();
        }
        // Root files stay; files under a chosen folder stay
        let kept = !path.contains('/') || dirs.iter().any(|d| path.starts_with(&format!("{d}/")));
        if !kept {
            list.push(path.to_string());
        }
    }
    Ok(list)
}

/// Check out only these folders (plus the root's files). Refuses (WORKTREE_CONFLICT, detail.files) when files with
/// uncommitted changes would be left out.
pub fn set(dir: &Path, dirs: &[String]) -> Result<SparseState> {
    let dirs = normalize(dirs)?;
    if dirs.is_empty() {
        return Err(CoreError::new(ErrorCode::NothingSelected, "至少选一个文件夹"));
    }
    let outside = changes_outside(dir, &dirs)?;
    if !outside.is_empty() {
        return Err(CoreError::new(ErrorCode::WorktreeConflict, format!("{} 个有改动的文件不在选的文件夹里，先提交或贮藏", outside.len()))
            .with_detail(serde_json::json!({ "files": outside })));
    }
    let mut args = vec!["sparse-checkout", "set", "--cone", "--"];
    args.extend(dirs.iter().map(String::as_str));
    git_cli::run(dir, &args, None)?;
    state(dir)
}

/// Check out everything again
pub fn disable(dir: &Path) -> Result<SparseState> {
    git_cli::run(dir, &["sparse-checkout", "disable"], None)?;
    state(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(p: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").args(args).current_dir(p).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap().status.success();
        assert!(ok, "{args:?}");
    }

    #[test]
    fn narrow_widen_and_guard() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.name", "A"]);
        git(p, &["config", "user.email", "a@example.com"]);
        for f in ["README.md", "app/web/index.ts", "app/web/ui/button.ts", "app/api/main.go", "docs/guide.md", "tools/build.sh"] {
            let path = p.join(f);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, f).unwrap();
        }
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "init"]);

        let ds = dirs(p).unwrap();
        assert_eq!(ds.iter().find(|x| x.path == "app").unwrap().files, 3);
        assert!(ds.iter().any(|x| x.path == "app/web/ui"));
        assert!(!state(p).unwrap().enabled);

        // Nested and odd input is cleaned up
        assert_eq!(normalize(&["app/web/".into(), "app/web/ui".into(), "/docs".into()]).unwrap(), vec!["app/web", "docs"]);
        assert!(normalize(&["../x".into()]).is_err());
        assert!(set(p, &[]).is_err());

        let s = set(p, &["app/web".into()]).unwrap();
        assert!(s.enabled && s.cone);
        assert_eq!(s.dirs, vec!["app/web"]);
        assert_eq!((s.total_files, s.checked_out), (6, 3));
        assert!(p.join("README.md").exists() && p.join("app/web/ui/button.ts").exists());
        assert!(!p.join("docs/guide.md").exists() && !p.join("app/api/main.go").exists());

        // A change in a folder that would be left out stops the narrowing
        std::fs::write(p.join("app/web/index.ts"), "changed").unwrap();
        let e = set(p, &["docs".into()]).unwrap_err();
        assert_eq!(e.code, ErrorCode::WorktreeConflict);
        assert_eq!(e.detail.unwrap()["files"][0], "app/web/index.ts");
        // Keeping that folder is fine
        let s = set(p, &["app/web".into(), "docs".into()]).unwrap();
        assert!(p.join("docs/guide.md").exists());
        assert_eq!(s.checked_out, 4);

        let s = disable(p).unwrap();
        assert!(!s.enabled);
        assert!(p.join("tools/build.sh").exists() && p.join("app/api/main.go").exists());
    }
}
