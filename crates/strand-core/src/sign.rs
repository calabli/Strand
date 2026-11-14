//! Signing: a commit's signature status (GPG or SSH, verified by git), and whether this repository signs commits.
//! Strand's commits, merges and rebases all go through system git, so with commit.gpgSign on they're signed automatically; the passphrase is entered in gpg-agent's prompt.

use serde::Serialize;

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::repo::Session;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SigStatus {
    /// Valid signature
    Good,
    /// Valid signature, but the key's trust is unknown
    Untrusted,
    /// Bad signature (content altered or signature broken)
    Bad,
    /// Signature expired
    Expired,
    /// Key expired
    ExpiredKey,
    /// Key revoked
    Revoked,
    /// Signed, but can't be verified here (no public key, gpg not installed)
    Unknown,
    /// Not signed
    None,
}

#[derive(Debug, Clone, Serialize)]
pub struct Signature {
    pub status: SigStatus,
    /// Signer (gpg user id or ssh principal)
    pub signer: String,
    /// Key
    pub key: String,
}

/// This repository's signing settings (effective git config values)
#[derive(Debug, Clone, Serialize)]
pub struct SigningConfig {
    /// commit.gpgSign
    pub commit: bool,
    /// tag.gpgSign
    pub tag: bool,
    /// user.signingKey
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// gpg.format: openpgp, ssh or x509
    pub format: String,
}

impl Session {
    /// A commit's signature status
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

    /// Turn commit signing on or off for this repository (written to the repository's own config, global config untouched)
    pub fn signing_set(&self, commit: bool) -> Result<SigningConfig> {
        git_cli::run(self.path(), &["config", "--local", "commit.gpgsign", if commit { "true" } else { "false" }], None)?;
        self.signing_config()
    }
}
