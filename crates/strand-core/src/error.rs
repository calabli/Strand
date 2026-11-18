//! Unified error structure, matching spec §14.
//!
//! Every failing command returns `{ code, message, detail }`. `code` is a fixed enum the frontend uses to decide how to show it;
//! `message` is a Chinese explanation that can be shown to the user directly; `detail` is optional extra data.

use serde::Serialize;
use serde_json::Value;

/// Error codes. Serialized as upper snake case, e.g. `REPO_BUSY`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    RepoBusy,
    MergeInProgress,
    NothingSelected,
    EmptyMessage,
    AlreadyPushed,
    InvalidName,
    InvalidRange,
    WorktreeConflict,
    Conflicts,
    UnmarkedBlocks,
    ConflictMarkers,
    PushRejected,
    AuthFailed,
    Network,
    StateDiverged,
    NotFound,
    Cancelled,
    GitFailed,
    /// A Git hook (pre-commit, commit-msg…) stopped the operation; detail has the hook names and their output
    HookFailed,
    /// Added in the skeleton stage: the chosen folder isn't a Git repository
    NotARepo,
    /// Added in the skeleton stage: a command that needs a repository was called before one was opened
    NoRepo,
    /// Added in the skeleton stage: Git isn't installed or is too old
    GitMissing,
    /// Log filter: the regular expression is invalid
    InvalidRegex,
    /// Partial clone: the task needs to download file contents for the whole history (e.g. searching historical changes)
    PartialClone,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct CoreError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

impl CoreError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), detail: None }
    }

    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }

    /// Wrap an underlying library error as `GIT_FAILED`, with the original message in `detail.source`.
    pub fn git(message: impl Into<String>, source: impl std::fmt::Display) -> Self {
        Self::new(ErrorCode::GitFailed, message)
            .with_detail(serde_json::json!({ "source": source.to_string() }))
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_like_the_spec() {
        let e = CoreError::new(ErrorCode::RepoBusy, "上一个操作还没完成");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v, serde_json::json!({ "code": "REPO_BUSY", "message": "上一个操作还没完成" }));
    }
}
