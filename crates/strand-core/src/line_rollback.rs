//! Roll back one worktree line against HEAD without touching the index.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::{
    Session, diff,
    file_history::{MAX_PREVIEW_BYTES, check_rel_path},
    model::{LineKind, RepoMode},
};

#[derive(Debug, Serialize)]
pub struct LineRollback {
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    /// A deleted line is restored before this worktree line (one past the last line at EOF).
    pub before: u32,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LineRollbackPlan {
    pub stamp: String,
    pub lines: Vec<LineRollback>,
}

struct Input {
    path: PathBuf,
    head: Vec<u8>,
    worktree: Vec<u8>,
    plan: LineRollbackPlan,
}

impl Session {
    pub fn line_rollbacks(&self, path: &str) -> Result<Option<LineRollbackPlan>> {
        Ok(self.line_rollback_input(path)?.map(|input| input.plan))
    }

    pub fn rollback_line(&self, path: &str, stamp: &str, index: usize) -> Result<String> {
        let input = self.line_rollback_input(path)?.ok_or_else(stale)?;
        if input.plan.stamp != stamp {
            return Err(stale());
        }
        let action = input.plan.lines.get(index).ok_or_else(stale)?;
        let rows: Vec<_> = input.worktree.split_inclusive(|b| *b == b'\n').collect();
        let line = (action.new_no.unwrap_or(action.before) - 1) as usize;
        let from = rows.iter().take(line).map(|row| row.len()).sum();
        let to = from
            + if action.new_no.is_some() {
                rows.get(line).ok_or_else(stale)?.len()
            } else {
                0
            };
        let nearby = rows
            .get(line)
            .filter(|row| row.ends_with(b"\n"))
            .or_else(|| {
                rows.iter()
                    .take(line)
                    .rev()
                    .find(|row| row.ends_with(b"\n"))
            });
        let eol: &[u8] = if nearby.map_or_else(
            || input.head.windows(2).any(|pair| pair == b"\r\n"),
            |row| row.ends_with(b"\r\n"),
        ) {
            b"\r\n"
        } else {
            b"\n"
        };
        let mut updated = input.worktree[..from].to_vec();
        if let Some(old) = action.old_no {
            let line = input
                .head
                .split_inclusive(|b| *b == b'\n')
                .nth((old - 1) as usize)
                .ok_or_else(stale)?;
            if !updated.is_empty() && !updated.ends_with(b"\n") {
                updated.extend_from_slice(eol);
            }
            if let Some(body) = line.strip_suffix(b"\n") {
                updated.extend_from_slice(body.strip_suffix(b"\r").unwrap_or(body));
                updated.extend_from_slice(eol);
            } else {
                updated.extend_from_slice(line);
                if to < input.worktree.len() {
                    updated.extend_from_slice(eol);
                }
            }
        }
        updated.extend_from_slice(&input.worktree[to..]);
        replace_worktree_file(&input.path, &input.worktree, &updated)?;
        if let Ok(mut cache) = self.status_cache.lock() {
            *cache = None;
        }
        String::from_utf8(updated).map_err(|_| stale())
    }

    fn line_rollback_input(&self, path: &str) -> Result<Option<Input>> {
        check_rel_path(path)?;
        let state = self.state()?;
        if state.state != RepoMode::Normal || state.bisecting {
            return Ok(None);
        }
        let repo = self.git2()?;
        let Ok(tree) = repo.head().and_then(|head| head.peel_to_tree()) else {
            return Ok(None);
        };
        let Ok(entry) = tree.get_path(Path::new(path)) else {
            return Ok(None);
        };
        if !matches!(entry.filemode(), 0o100644 | 0o100755) {
            return Ok(None);
        }
        let Ok(blob) = repo.find_blob(entry.id()) else {
            return Ok(None);
        };
        let Ok(root) = self.path().canonicalize() else {
            return Ok(None);
        };
        let file = root.join(path);
        let Ok(meta) = file.symlink_metadata() else {
            return Ok(None);
        };
        if !meta.is_file()
            || meta.len() > MAX_PREVIEW_BYTES as u64
            || blob.size() > MAX_PREVIEW_BYTES
        {
            return Ok(None);
        }
        let Ok(file) = file.canonicalize() else {
            return Ok(None);
        };
        if !file.strip_prefix(&root).is_ok_and(|p| {
            !p.components()
                .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
        }) {
            return Ok(None);
        }
        let worktree = fs::read(&file).map_err(|e| CoreError::git("读取文件失败", e))?;
        let head = blob.content().to_vec();
        if [&head, &worktree].iter().any(|b| {
            b.contains(&0)
                || std::str::from_utf8(b).is_err()
                || crate::lfs::parse_pointer(b).is_some()
        }) {
            return Ok(None);
        }
        let diff = diff::buffers_diff(&normalized(&head), &normalized(&worktree), path, 0)?;
        if diff.binary || diff.truncated || diff.hunks.is_empty() {
            return Ok(None);
        }
        let mut lines = Vec::new();
        for hunk in diff.hunks {
            let deleted: Vec<_> = hunk
                .lines
                .iter()
                .filter(|l| l.kind == LineKind::Del)
                .collect();
            let added: Vec<_> = hunk
                .lines
                .iter()
                .filter(|l| l.kind == LineKind::Add)
                .collect();
            // With zero context, additions and deletions in each hunk are one contiguous edit.
            let end = added
                .last()
                .and_then(|l| l.new_no)
                .unwrap_or(hunk.new_start)
                + 1;
            for i in 0..deleted.len().max(added.len()) {
                let old = deleted.get(i);
                let new = added.get(i);
                lines.push(LineRollback {
                    old_no: old.and_then(|l| l.old_no),
                    new_no: new.and_then(|l| l.new_no),
                    before: new.and_then(|l| l.new_no).unwrap_or(end),
                    old_text: old.map(|l| l.text.clone()),
                    new_text: new.map(|l| l.text.clone()),
                });
            }
        }
        let hash = git2::Oid::hash_object(git2::ObjectType::Blob, &worktree)
            .map_err(|e| CoreError::git("读取文件失败", e))?;
        let stamp = format!("{}:{hash}", entry.id());
        Ok(Some(Input {
            path: file,
            head,
            worktree,
            plan: LineRollbackPlan { stamp, lines },
        }))
    }
}

fn replace_worktree_file(path: &Path, expected: &[u8], text: &[u8]) -> Result<()> {
    let error = |e| CoreError::git("回退这一行失败", e);
    let metadata = path.symlink_metadata().map_err(error)?;
    if !metadata.is_file() || metadata.permissions().readonly() {
        return Err(stale());
    }
    let mut staged = tempfile::Builder::new()
        .prefix(".strand-line-")
        .tempfile_in(path.parent().ok_or_else(stale)?)
        .map_err(error)?;
    staged.write_all(text).map_err(error)?;
    staged
        .as_file()
        .set_permissions(metadata.permissions())
        .map_err(error)?;
    // Check again immediately before replacing the file. A failed write leaves the old file intact.
    if !path.symlink_metadata().is_ok_and(|meta| meta.is_file())
        || fs::read(path).ok().as_deref() != Some(expected)
    {
        return Err(stale());
    }
    staged.persist(path).map_err(|e| error(e.error))?;
    Ok(())
}

fn normalized(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        if let Some(body) = line.strip_suffix(b"\r\n") {
            out.extend_from_slice(body);
            out.push(b'\n');
        } else {
            out.extend_from_slice(line);
        }
    }
    out
}

fn stale() -> CoreError {
    CoreError::new(ErrorCode::StateDiverged, "文件内容已变化，请重新查看这一行")
}
