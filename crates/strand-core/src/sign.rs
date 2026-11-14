//! 签名：提交的签名状态（GPG 或 SSH，交给 git 验证），以及这个仓库提交时要不要签名。
//! Strand 的提交、合并、变基都走系统 git，所以 commit.gpgSign 打开后这些操作自动签名；口令由 gpg-agent 的弹窗输入。

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::repo::Session;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SigStatus {
    /// 签名有效
    Good,
    /// 签名有效，但密钥的可信度未知
    Untrusted,
    /// 签名无效（内容被改过或签名坏了）
    Bad,
    /// 签名过期
    Expired,
    /// 密钥过期
    ExpiredKey,
    /// 密钥已吊销
    Revoked,
    /// 有签名，但本机验证不了（没有公钥、没装 gpg）
    Unknown,
    /// 没有签名
    None,
}

#[derive(Debug, Clone, Serialize)]
pub struct Signature {
    pub status: SigStatus,
    /// 签名人（gpg 的用户名或 ssh 的主体）
    pub signer: String,
    /// 密钥
    pub key: String,
}

/// 这个仓库的签名设置（按 git config 的生效值）
#[derive(Debug, Clone, Serialize)]
pub struct SigningConfig {
    /// commit.gpgSign
    pub commit: bool,
    /// tag.gpgSign
    pub tag: bool,
    /// user.signingKey
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// gpg.format：openpgp、ssh 或 x509
    pub format: String,
}

impl Session {
    /// 一个提交的签名状态
    pub fn commit_signature(&self, id: &str) -> Result<Signature> {
        if id.len() < 4 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CoreError::new(ErrorCode::NotFound, "提交不存在"));
        }
        let out = git_cli::run(self.path(), &["log", "-1", "--no-walk", "--format=%G?%x1f%GS%x1f%GK", id], None)?;
        let mut it = out.trim_end_matches('\n').split('\x1f');
        let status = match it.next().unwrap_or("N") {
            "G" => SigStatus::Good,
            "U" => SigStatus::Untrusted,
            "B" => SigStatus::Bad,
            "X" => SigStatus::Expired,
            "Y" => SigStatus::ExpiredKey,
            "R" => SigStatus::Revoked,
            "E" => SigStatus::Unknown,
            _ => SigStatus::None,
        };
        Ok(Signature { status, signer: it.next().unwrap_or("").to_string(), key: it.next().unwrap_or("").to_string() })
    }

    pub fn signing_config(&self) -> Result<SigningConfig> {
        let get = |k: &str| git_cli::run(self.path(), &["config", "--get", k], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let on = |k: &str| get(k).is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "true" | "yes" | "on" | "1"));
        Ok(SigningConfig { commit: on("commit.gpgsign"), tag: on("tag.gpgsign"), key: get("user.signingkey"), format: get("gpg.format").unwrap_or_else(|| "openpgp".into()) })
    }

    /// 打开或关闭这个仓库的提交签名（写在仓库自己的配置里，不动全局配置）
    pub fn signing_set(&self, commit: bool) -> Result<SigningConfig> {
        git_cli::run(self.path(), &["config", "--local", "commit.gpgsign", if commit { "true" } else { "false" }], None)?;
        self.signing_config()
    }
}
