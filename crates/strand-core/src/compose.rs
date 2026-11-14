//! 写提交说明用到的东西：说明历史（自己在这个仓库里写过的说明）、Git 的提交说明模板（commit.template）、
//! 当前的提交身份；以及变更列表（把改动分成几组分别提交，对照 JetBrains 的 changelist）。
//!
//! 变更列表只是 Strand 自己的分组，存在 `.git/strand/changelists.json`（每个工作目录一份），Git 不知道它。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, ErrorCode, Result};
use crate::git_cli;
use crate::repo::Session;

#[derive(Debug, Clone, Serialize, Default)]
pub struct ComposeInfo {
    /// 提交说明模板（去掉 # 开头的注释行）；没配置或读不到时为空
    pub template: Option<String>,
    /// 模板文件的路径（提示用）
    pub template_path: Option<String>,
    /// 自己最近在这个仓库里写过的说明，新的在前，去重，最多 30 条
    pub history: Vec<String>,
    /// 当前提交身份 "名字 <邮箱>"；没配置时为空
    pub me: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Changelist {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Changelists {
    /// 第一个是默认列表（id 为 "default"，不能删）
    pub lists: Vec<Changelist>,
    /// 新出现的改动放进哪个列表
    pub active: String,
    /// 路径 → 列表 id；不在这里的路径属于活动列表
    #[serde(default)]
    pub files: BTreeMap<String, String>,
}

impl Default for Changelists {
    fn default() -> Self {
        Changelists { lists: vec![Changelist { id: "default".into(), name: String::new() }], active: "default".into(), files: BTreeMap::new() }
    }
}

/// 检查 "名字 <邮箱>" 的格式
pub fn check_ident(s: &str) -> Result<()> {
    let s = s.trim();
    let ok = match (s.find('<'), s.rfind('>')) {
        (Some(a), Some(b)) => a > 0 && b == s.len() - 1 && b > a + 1 && !s[..a].trim().is_empty() && !s[a + 1..b].contains(['<', '>']),
        _ => false,
    };
    if ok { Ok(()) } else { Err(CoreError::new(ErrorCode::InvalidName, "作者要写成“名字 <邮箱>”")) }
}

impl Session {
    pub fn compose_info(&self) -> Result<ComposeInfo> {
        let dir = self.path();
        let cfg = |k: &str| git_cli::run(dir, &["config", "--get", k], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let name = cfg("user.name");
        let email = cfg("user.email");
        let me = match (&name, &email) {
            (Some(n), Some(e)) => Some(format!("{n} <{e}>")),
            _ => None,
        };

        let mut info = ComposeInfo { me, ..Default::default() };
        if let Some(p) = git_cli::run(dir, &["config", "--path", "--get", "commit.template"], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            let path = std::path::Path::new(&p);
            let full = if path.is_absolute() { path.to_path_buf() } else { dir.join(path) };
            if let Ok(text) = std::fs::read_to_string(&full) {
                let body: Vec<&str> = text.lines().filter(|l| !l.starts_with('#')).collect();
                let body = body.join("\n").trim_end().to_string();
                if !body.trim().is_empty() {
                    info.template = Some(body);
                }
            }
            info.template_path = Some(p);
        }

        // 自己写过的说明：按邮箱找；没配置邮箱时用全部提交
        let mut args = vec!["log", "-n", "300", "--no-merges", "--format=%B%x1e"];
        let filter;
        if let Some(e) = &email {
            filter = format!("--author=<{e}>");
            args.push(&filter);
        }
        if let Ok(out) = git_cli::run(dir, &args, None) {
            for m in out.split('\u{1e}') {
                let m = m.trim();
                if m.is_empty() || info.history.iter().any(|x| x == m) {
                    continue;
                }
                info.history.push(m.to_string());
                if info.history.len() >= 30 {
                    break;
                }
            }
        }
        Ok(info)
    }

    fn changelists_file(&self) -> Result<std::path::PathBuf> {
        Ok(self.git2()?.path().join("strand").join("changelists.json"))
    }

    pub fn changelists_get(&self) -> Result<Changelists> {
        let f = self.changelists_file()?;
        let Ok(text) = std::fs::read_to_string(&f) else { return Ok(Changelists::default()) };
        Ok(serde_json::from_str::<Changelists>(&text).map(normalize).unwrap_or_default())
    }

    pub fn changelists_set(&self, c: Changelists) -> Result<Changelists> {
        let mut seen = std::collections::HashSet::new();
        for l in &c.lists {
            if l.id.is_empty() || !seen.insert(l.id.clone()) {
                return Err(CoreError::new(ErrorCode::InvalidName, "变更列表的编号重复"));
            }
            if l.id != "default" && l.name.trim().is_empty() {
                return Err(CoreError::new(ErrorCode::InvalidName, "变更列表要有名字"));
            }
        }
        let names: Vec<String> = c.lists.iter().map(|l| l.name.trim().to_lowercase()).filter(|n| !n.is_empty()).collect();
        if names.iter().enumerate().any(|(i, n)| names[..i].contains(n)) {
            return Err(CoreError::new(ErrorCode::InvalidName, "已经有同名的变更列表"));
        }
        let c = normalize(c);
        let f = self.changelists_file()?;
        if let Some(d) = f.parent() {
            std::fs::create_dir_all(d).map_err(|e| CoreError::git("保存变更列表失败", e))?;
        }
        let text = serde_json::to_string_pretty(&c).map_err(|e| CoreError::git("保存变更列表失败", e))?;
        std::fs::write(&f, text).map_err(|e| CoreError::git("保存变更列表失败", e))?;
        Ok(c)
    }
}

/// 默认列表一定在第一个；活动列表和文件指向的列表一定存在
fn normalize(mut c: Changelists) -> Changelists {
    match c.lists.iter().position(|l| l.id == "default") {
        Some(0) => {}
        Some(i) => {
            let d = c.lists.remove(i);
            c.lists.insert(0, d);
        }
        None => c.lists.insert(0, Changelist { id: "default".into(), name: String::new() }),
    }
    if !c.lists.iter().any(|l| l.id == c.active) {
        c.active = "default".into();
    }
    let ids: std::collections::HashSet<String> = c.lists.iter().map(|l| l.id.clone()).collect();
    c.files.retain(|_, v| ids.contains(v));
    c
}
