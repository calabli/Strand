//! Store pasted image assets beside a Markdown document in the working tree.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;

use crate::error::{CoreError, ErrorCode, Result};
use crate::{
    Session,
    file_history::{MAX_PREVIEW_BYTES, check_rel_path},
};

impl Session {
    /// Create a new image file and return a link relative to `document`.
    pub fn paste_markdown_image(&self, document: &str, bytes: &[u8]) -> Result<String> {
        check_rel_path(document)?;
        if bytes.len() > MAX_PREVIEW_BYTES {
            return Err(CoreError::new(ErrorCode::InvalidRange, "图片超过 30 MB"));
        }
        let ext = image_extension(bytes)
            .ok_or_else(|| CoreError::new(ErrorCode::InvalidName, "不支持此图片格式"))?;
        let relative = Path::new(document);
        if !relative
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "md" | "markdown" | "mdown" | "mkd"
                )
            })
        {
            return Err(CoreError::new(
                ErrorCode::InvalidName,
                "只能在 Markdown 文件中粘贴图片",
            ));
        }
        let root = self
            .path()
            .canonicalize()
            .map_err(|e| CoreError::git("找不到仓库文件夹", e))?;
        let parent = root
            .join(relative.parent().unwrap_or(Path::new("")))
            .canonicalize()
            .map_err(|e| CoreError::git("找不到文档文件夹", e))?;
        if !parent.strip_prefix(&root).is_ok_and(|path| {
            !path
                .components()
                .any(|part| part.as_os_str().eq_ignore_ascii_case(".git"))
        }) {
            return Err(invalid_asset_directory());
        }
        let file = parent.join(relative.file_name().expect("validated Markdown path"));
        if !file.symlink_metadata().is_ok_and(|meta| meta.is_file()) {
            return Err(CoreError::new(
                ErrorCode::NotFound,
                format!("工作区里没有这个文件：{document}"),
            ));
        }
        let stem = relative
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or_else(invalid_asset_directory)?;
        let folder = format!("{stem}.assets");
        let dir = parent.join(&folder);
        let created = match fs::create_dir(&dir) {
            Ok(()) => true,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => false,
            Err(e) => return Err(CoreError::git("创建图片资源文件夹失败", e)),
        };
        if !dir.symlink_metadata().is_ok_and(|m| m.is_dir())
            || !dir
                .canonicalize()
                .is_ok_and(|p| p.parent() == Some(&parent))
        {
            return Err(invalid_asset_directory());
        }

        match write_image(&dir, ext, bytes) {
            Ok(name) => Ok(format!("{folder}/{name}")),
            Err(e) => {
                if created {
                    let _ = fs::remove_dir(&dir);
                }
                Err(e)
            }
        }
    }
}

fn invalid_asset_directory() -> CoreError {
    CoreError::new(
        ErrorCode::InvalidName,
        "图片资源路径必须是仓库内的普通文件夹",
    )
}

fn write_image(dir: &Path, ext: &str, bytes: &[u8]) -> Result<String> {
    for count in 1..=10_000 {
        let name = if count == 1 {
            format!("image.{ext}")
        } else {
            format!("image-{count}.{ext}")
        };
        let path = dir.join(&name);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(CoreError::git("保存粘贴的图片失败", e)),
        };
        if let Err(e) = file.write_all(bytes) {
            drop(file);
            let _ = fs::remove_file(path);
            return Err(CoreError::git("保存粘贴的图片失败", e));
        }
        return Ok(name);
    }
    Err(CoreError::new(
        ErrorCode::InvalidName,
        "图片资源文件名已用完",
    ))
}

fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR") {
        Some("png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if bytes.len() >= 13 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        Some("gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if bytes.len() >= 26 && bytes.starts_with(b"BM") {
        Some("bmp")
    } else if bytes
        .get(4..12)
        .is_some_and(|tag| matches!(tag, b"ftypavif" | b"ftypavis"))
    {
        Some("avif")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\x02\x00\x00\x00\x0bIDATx\xdac\xfc\xff\x1f\x00\x03\x03\x02\x00\xef\xbf\x94\xad\x00\x00\x00\x00IEND\xaeB`\x82";

    #[test]
    fn pasted_images_use_document_relative_links_and_never_replace_a_file() {
        let d = tempfile::tempdir().unwrap();
        git2::Repository::init(d.path()).unwrap();
        let docs = d.path().join("docs");
        fs::create_dir(&docs).unwrap();
        fs::write(docs.join("写作 (草稿).MD"), "# Markdown\n").unwrap();
        let session = Session::open(d.path()).unwrap();
        let doc = "docs/写作 (草稿).MD";

        let a = session.paste_markdown_image(doc, PNG).unwrap();
        let b = session.paste_markdown_image(doc, PNG).unwrap();
        assert_eq!(a, "写作 (草稿).assets/image.png");
        assert_eq!(b, "写作 (草稿).assets/image-2.png");
        assert_eq!(fs::read(docs.join(&a)).unwrap(), PNG);
        assert_eq!(session.file_bytes(&format!("docs/{b}"), None).unwrap(), PNG);
        assert!(
            session
                .status()
                .unwrap()
                .untracked
                .contains(&format!("docs/{a}"))
        );
        assert!(session.paste_markdown_image(doc, b"plain text").is_err());
        assert!(
            session
                .paste_markdown_image("../elsewhere.md", PNG)
                .is_err()
        );
        assert!(session.paste_markdown_image("not-found.md", PNG).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn image_import_refuses_a_symlinked_resource_folder() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        git2::Repository::init(d.path()).unwrap();
        fs::write(d.path().join("README.md"), "# Markdown\n").unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("README.assets")).unwrap();
        let session = Session::open(d.path()).unwrap();
        assert!(session.paste_markdown_image("README.md", PNG).is_err());
        assert_eq!(outside.path().read_dir().unwrap().count(), 0);
    }
}
