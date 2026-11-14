//! Format and check before committing (spec §4.4, §4.6).

#![cfg(unix)]

use std::path::Path;
use std::process::Command;

use strand_core::checks::{self, CheckKind, ChecksConfig};
use strand_core::remote::Cancel;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    std::fs::create_dir(p.join("src")).unwrap();
    std::fs::write(p.join("src/a.ts"), "let x = 1\n").unwrap();
    std::fs::write(p.join("b c.txt"), "hi\n").unwrap();
    std::fs::write(p.join("package.json"), r#"{"scripts":{"lint":"eslint .","format":"prettier -w ."}}"#).unwrap();
    std::fs::write(p.join("pnpm-lock.yaml"), "").unwrap();
    d
}

#[test]
fn config_round_trip_and_suggestions() {
    let d = repo();
    let p = d.path();
    let c = checks::config(p);
    assert_eq!(c.config.format_command, "");
    assert!(c.config.check_on_commit, "检查默认开");
    assert!(!c.config.format_on_commit, "格式化默认关");
    assert_eq!(c.suggest_check, vec!["pnpm run lint"]);
    assert_eq!(c.suggest_format, vec!["pnpm run format"]);

    let want = ChecksConfig { format_command: "prettier -w {files}".into(), check_command: "eslint {files}".into(), format_on_commit: true, check_on_commit: false };
    checks::set_config(p, &want).unwrap();
    assert_eq!(checks::config(p).config, want);
    assert_eq!(git(p, &["config", "--local", "strand.checkCommand"]), "eslint {files}");
    // Clearing a command removes the config key
    checks::set_config(p, &ChecksConfig { check_command: " ".into(), ..want.clone() }).unwrap();
    assert_eq!(git(p, &["config", "--local", "--get-all", "strand.checkCommand"]), "");
    assert!(checks::set_config(p, &ChecksConfig { check_command: "a\nb".into(), ..want }).is_err());
}

#[test]
fn check_passes_and_fails_with_issues() {
    let d = repo();
    let p = d.path();
    let files = vec!["src/a.ts".to_string(), "b c.txt".to_string()];
    // {files} becomes quoted paths, STRAND_FILES is newline-separated
    let r = checks::run(p, CheckKind::Check, r#"printf '%s|' {files}; echo; printf '%s' "$STRAND_FILES" | wc -l"#, &files, &Cancel::default()).unwrap();
    assert!(r.ok, "{r:?}");
    assert!(r.output.starts_with("src/a.ts|b c.txt|"), "{}", r.output);
    assert_eq!(r.output.lines().last().unwrap().trim(), "1");

    let script = "echo 'Checking…'; \
        echo 'src/a.ts:1:5: error: Missing semicolon' >&2; \
        echo 'src/a.ts(1,9): error TS2304: Cannot find name y.'; \
        echo 'nope.ts:3:1: not a repo file'; \
        exit 2";
    let r = checks::run(p, CheckKind::Check, script, &files, &Cancel::default()).unwrap();
    assert!(!r.ok);
    assert_eq!(r.code, Some(2));
    assert_eq!(r.issues.len(), 2, "{:?}", r.issues);
    assert_eq!(r.issues[0].path, "src/a.ts");
    assert_eq!((r.issues[0].line, r.issues[0].col), (Some(1), Some(9)), "标准输出先于标准错误");
    assert_eq!(r.issues[1].level, "error");
    assert_eq!(r.issues[1].message, "Missing semicolon");
}

#[test]
fn parses_rustc_and_eslint_styles() {
    let d = repo();
    let p = d.path();
    let out = "\x1b[31merror[E0425]\x1b[0m: cannot find value `y`\n  --> src/a.ts:1:9\n   |\n\
               \n/abs/not/here.ts\n\
               src/a.ts\n   1:5  warning  Unexpected var  no-var\n   2:1  error  Missing semicolon  semi\n\n✖ 2 problems\n";
    let issues = checks::parse_issues(p, out);
    assert_eq!(issues.len(), 3, "{issues:?}");
    assert_eq!(issues[0].level, "error");
    assert_eq!(issues[0].message, "[E0425]: cannot find value `y`");
    assert_eq!(issues[1].message, "Unexpected var  no-var");
    assert_eq!(issues[1].level, "warning");
    assert_eq!(issues[2].line, Some(2));
    // Absolute paths are recognized too and converted to relative ones
    let abs = format!("{}/src/a.ts:4: oops", p.canonicalize().unwrap().display());
    assert_eq!(checks::parse_issues(p, &abs)[0].path, "src/a.ts");
}

#[test]
fn format_reports_changed_files() {
    let d = repo();
    let p = d.path();
    let files = vec!["src/a.ts".to_string(), "b c.txt".to_string()];
    let r = checks::run(p, CheckKind::Format, "for f in {files}; do case \"$f\" in *.ts) printf 'let x = 1;\\n' > \"$f\";; esac; done", &files, &Cancel::default()).unwrap();
    assert!(r.ok);
    assert_eq!(r.changed, vec!["src/a.ts"]);
    assert_eq!(std::fs::read_to_string(p.join("src/a.ts")).unwrap(), "let x = 1;\n");
}

#[test]
fn cancel_stops_a_long_command() {
    let d = repo();
    let p = d.path().to_path_buf();
    let c = Cancel::default();
    let c2 = c.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        c2.cancel();
    });
    let t = std::time::Instant::now();
    let r = checks::run(&p, CheckKind::Check, "sleep 20", &[], &c);
    assert!(r.is_err());
    assert!(t.elapsed().as_secs() < 5);
    assert!(checks::run(&p, CheckKind::Check, "  ", &[], &Cancel::default()).is_err(), "没有命令");
}
