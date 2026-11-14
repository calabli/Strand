//! The Strand core layer.
//!
//! This layer doesn't depend on Tauri: all Git logic is implemented and tested here, and `src-tauri` only registers it as commands.
//! Spec §2 sets the division of work: the frontend doesn't infer Git state; all state is computed here and returned.

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
pub mod gitconfig;
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
