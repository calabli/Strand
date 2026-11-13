//! 统一错误结构，对应说明书第 14 节。
//!
//! 所有命令失败时返回 `{ code, message, detail }`。`code` 是固定枚举，前端按它决定提示方式；
//! `message` 是可以直接显示给用户的中文说明；`detail` 是可选的补充数据。

use serde::Serialize;
use serde_json::Value;

/// 错误码。序列化成全大写下划线形式，如 `REPO_BUSY`。
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
    /// 骨架阶段新增：选中的文件夹不是 Git 仓库
    NotARepo,
    /// 骨架阶段新增：还没有打开仓库就调用了需要仓库的命令
    NoRepo,
    /// 骨架阶段新增：系统没有安装 Git 或版本过低
    GitMissing,
    /// 日志过滤：正则表达式写错了
    InvalidRegex,
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

    /// 把底层库的错误包成 `GIT_FAILED`，原始信息放进 `detail.source`。
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
