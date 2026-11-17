//! Repository maintenance: how big the repository is (objects, packs, what could be cleaned, Git LFS files, Strand's
//! own data), cleaning it up with `git gc`, and remembering conflict resolutions (`rerere`).
//!
//! gc keeps everything reachable from refs, the reflogs and Strand's undo snapshots (refs/strand/ops/*), and only
//! drops unreachable objects older than gc.pruneExpire (two weeks by default), so it can't lose work the user can
//! still get back. rerere is switched on per repository together with rerere.autoUpdate: a file Git resolves with a
//! recorded resolution is then staged, and Strand's conflict list shows it as resolved (still before completing).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{CoreError, ErrorCode};
use crate::git_cli;
use crate::remote::{Cancel, Progress};
use crate::Result;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct RepoSize {
    /// The whole .git directory (the common one for worktrees)
    pub git_dir: u64,
    pub loose_count: u64,
    pub loose_bytes: u64,
    pub packed_count: u64,
    pub pack_bytes: u64,
    pub packs: u64,
    /// Loose objects already in a pack (prune-packable) plus garbage files: what gc removes for sure
    pub cleanable_bytes: u64,
    pub lfs_bytes: u64,
    /// .git/strand: shelf patches, undo bookkeeping, remote tag cache
    pub strand_bytes: u64,
    /// Whether a cleanup is worth it (many loose objects or packs)
    pub suggest_gc: bool,
}

fn common_dir(dir: &Path) -> Result<PathBuf> {
    let out = git_cli::run(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"], None)?;
    Ok(PathBuf::from(out.trim()))
}

/// Total size of the files under a directory (symlinks not followed); 0 when missing
pub fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// Parse `git count-objects -v` (sizes are in KiB)
pub fn parse_count_objects(out: &str) -> RepoSize {
    let get = |k: &str| -> u64 {
        out.lines().find_map(|l| l.strip_prefix(k).and_then(|r| r.strip_prefix(": ")).and_then(|v| v.trim().parse().ok())).unwrap_or(0)
    };
    let loose_count = get("count");
    let packs = get("packs");
    RepoSize {
        loose_count,
        loose_bytes: get("size") * 1024,
        packed_count: get("in-pack"),
        pack_bytes: get("size-pack") * 1024,
        packs,
        // prune-packable is a count; at the loose objects' average size
        cleanable_bytes: get("size-garbage") * 1024 + (get("prune-packable") * get("size") * 1024).checked_div(loose_count).unwrap_or(0),
        // The same thresholds `git gc --auto` uses (gc.auto 6700 loose objects, gc.autoPackLimit 50 packs), a bit lower
        suggest_gc: loose_count > 2000 || packs > 20 || get("prune-packable") > 500,
        ..Default::default()
    }
}

pub fn size(dir: &Path) -> Result<RepoSize> {
    let out = git_cli::run(dir, &["count-objects", "-v"], None)?;
    let mut s = parse_count_objects(&out);
    let git = common_dir(dir)?;
    s.git_dir = dir_size(&git);
    s.lfs_bytes = dir_size(&git.join("lfs"));
    s.strand_bytes = dir_size(&git.join("strand"));
    Ok(s)
}

/// `git gc` (optionally --aggressive: recompresses everything, much slower). Can be canceled; an interrupted gc
/// leaves the repository as it was (temporary packs are cleaned by the next one).
pub fn gc(dir: &Path, aggressive: bool, cancel: &Cancel, progress: &dyn Fn(Progress)) -> Result<()> {
    progress(Progress { text: "正在清理仓库…".into(), percent: None });
    let mut args = vec!["gc"];
    if aggressive {
        args.push("--aggressive");
    }
    crate::remote::run_net(dir, &args, cancel, progress)?;
    Ok(())
}

/// Whether rerere is on for this repository (its own config or a global one)
pub fn rerere(dir: &Path) -> bool {
    git_cli::run(dir, &["config", "--type=bool", "--get", "rerere.enabled"], None).is_ok_and(|v| v.trim() == "true")
}

/// Switch rerere on or off in this repository's config (on also turns on rerere.autoUpdate)
pub fn set_rerere(dir: &Path, on: bool) -> Result<()> {
    let v = if on { "true" } else { "false" };
    git_cli::run(dir, &["config", "--local", "rerere.enabled", v], None)?;
    if on {
        git_cli::run(dir, &["config", "--local", "rerere.autoUpdate", "true"], None)?;
    } else {
        // Leave nothing behind that only made sense with rerere on
        let _ = git_cli::run(dir, &["config", "--local", "--unset", "rerere.autoUpdate"], None);
    }
    if rerere(dir) != on {
        return Err(CoreError::new(ErrorCode::GitFailed, "全局 Git 配置里的 rerere.enabled 覆盖不了，请检查配置"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(p: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(p)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr)
    }

    #[test]
    fn parses_count_objects() {
        let s = parse_count_objects("count: 120\nsize: 480\nin-pack: 5000\npacks: 3\nsize-pack: 2048\nprune-packable: 30\ngarbage: 1\nsize-garbage: 4\n");
        assert_eq!((s.loose_count, s.loose_bytes, s.packed_count, s.pack_bytes, s.packs), (120, 480 * 1024, 5000, 2048 * 1024, 3));
        assert_eq!(s.cleanable_bytes, 4 * 1024 + 30 * 480 * 1024 / 120);
        assert!(!s.suggest_gc);
        assert!(parse_count_objects("count: 3000\nsize: 1\n").suggest_gc);
    }

    #[test]
    fn size_gc_and_rerere() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.name", "A"]);
        git(p, &["config", "user.email", "a@example.com"]);
        for i in 0..5 {
            std::fs::write(p.join(format!("f{i}.txt")), format!("{i}\n").repeat(50)).unwrap();
            git(p, &["add", "."]);
            git(p, &["commit", "-qm", &format!("c{i}")]);
        }
        let before = size(p).unwrap();
        assert!(before.loose_count >= 15 && before.packs == 0 && before.git_dir > 0, "{before:?}");
        gc(p, false, &Cancel::default(), &|_| {}).unwrap();
        let after = size(p).unwrap();
        assert_eq!((after.loose_count, after.packs), (0, 1), "{after:?}");
        assert_eq!(after.packed_count, before.loose_count);

        // rerere: a resolution recorded once is reused and staged (the library's own calls read this machine's global
        // config, which is only read here, never written)
        set_rerere(p, true).unwrap();
        assert!(rerere(p));
        std::fs::write(p.join("c.txt"), "base\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-qm", "base"]);
        git(p, &["switch", "-qc", "other"]);
        std::fs::write(p.join("c.txt"), "theirs\n").unwrap();
        git(p, &["commit", "-qam", "theirs"]);
        git(p, &["switch", "-q", "main"]);
        std::fs::write(p.join("c.txt"), "ours\n").unwrap();
        git(p, &["commit", "-qam", "ours"]);
        git(p, &["merge", "other"]);
        std::fs::write(p.join("c.txt"), "both\n").unwrap();
        git(p, &["add", "c.txt"]);
        git(p, &["commit", "-qm", "merged"]);
        git(p, &["reset", "-q", "--hard", "HEAD~1"]);
        let out = git(p, &["merge", "other"]);
        assert!(out.contains("Resolved") || out.contains("Staged"), "{out}");
        assert_eq!(std::fs::read_to_string(p.join("c.txt")).unwrap(), "both\n");
        assert!(git(p, &["diff", "--name-only", "--diff-filter=U"]).trim().is_empty(), "still unmerged");
        set_rerere(p, false).unwrap();
        assert!(!rerere(p));
    }
}
