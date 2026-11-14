//! Strand 核心层。
//!
//! 这一层不依赖 Tauri：所有 Git 逻辑都在这里实现和测试，`src-tauri` 只负责把它注册成命令。
//! 说明书第 2 节规定了分工：前端不推算 Git 状态，所有状态由这里计算后返回。

pub mod askpass;
pub mod bisect;
pub mod blame;
pub mod checks;
mod branches;
pub mod compare;
pub mod compose;
pub mod console;
pub mod commits;
pub mod conflict;
mod diff;
pub mod error;
pub mod file_history;
pub mod git_cli;
pub mod graph;
mod history;
pub mod log_filter;
pub mod model;
pub mod oplog;
pub mod patch;
pub mod reflog;
pub mod rebase;
pub mod remote;
pub mod stash;
pub mod repo;
pub mod search;
pub mod shell_path;
pub mod sign;
pub mod watch;
mod worktree;
pub mod worktrees;

pub use error::{CoreError, ErrorCode, Result};
pub use repo::Session;
