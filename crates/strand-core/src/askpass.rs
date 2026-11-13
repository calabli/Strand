//! 需要输入凭据时向用户要（说明书 7.5）。
//!
//! git（以及 ssh）需要用户名、密码或密钥口令时，会运行 `GIT_ASKPASS` / `SSH_ASKPASS` 指定的程序，
//! 把提示作为参数传进去、读它的标准输出当作回答。这里让这个程序就是客户端自己（或测试用的 `strand-askpass`）：
//! 它以 askpass 方式启动时（环境变量里有端口和口令）只做一件事——连回发起这次网络操作的进程，
//! 把提示发过去、把回答打印出来。
//!
//! 发起方在 `127.0.0.1` 上临时开一个端口，只接受带这次随机口令的连接；收到提示后调用界面设置的 `Asker`
//! （界面弹出输入框），把回答只交给这一次 git 进程。回答不写日志、不保存。

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::remote::Cancel;

const ENV_PORT: &str = "STRAND_ASKPASS_PORT";
const ENV_TOKEN: &str = "STRAND_ASKPASS_TOKEN";

/// 一次输入请求
#[derive(Debug, Clone, Serialize)]
pub struct AuthRequest {
    /// git 或 ssh 给的提示原文，如 `Password for 'https://linxia@github.com': `
    pub prompt: String,
    /// 是密码、口令或令牌（输入框要遮住）
    pub secret: bool,
}

/// 界面提供的“向用户要输入”：返回 `None` 表示用户取消。等待期间应当留意 `Cancel`（用户点了停止）。
pub type Asker = Arc<dyn Fn(&AuthRequest, &Cancel) -> Option<String> + Send + Sync>;

static ASKER: RwLock<Option<Asker>> = RwLock::new(None);
static PROGRAM: RwLock<Option<PathBuf>> = RwLock::new(None);

/// 设置向用户要输入的方式。没设置时不接管，git 照旧（需要输入时直接失败）。
pub fn set_asker(a: Asker) {
    *ASKER.write().unwrap() = Some(a);
}

thread_local! {
    static QUIET: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 在 `f` 里运行的网络操作不向用户要输入（如后台自动抓取）：需要输入时直接失败。
pub fn without_prompt<T>(f: impl FnOnce() -> T) -> T {
    QUIET.with(|q| q.set(true));
    let r = f();
    QUIET.with(|q| q.set(false));
    r
}

/// 设置当作 askpass 运行的程序（通常就是客户端自己的可执行文件，它的 main 开头调用 `client_main`）。
pub fn set_program(p: PathBuf) {
    *PROGRAM.write().unwrap() = Some(p);
}

/// askpass 客户端。以 askpass 方式启动时（环境变量里有端口和口令）把提示发回发起方、打印回答，
/// 返回进程应当使用的退出码；不是 askpass 方式时返回 `None`，调用方照常启动。
pub fn client_main() -> Option<i32> {
    let port = std::env::var(ENV_PORT).ok()?;
    let token = std::env::var(ENV_TOKEN).ok()?;
    let prompt = std::env::args().nth(1).unwrap_or_default().replace(['\r', '\n'], " ");
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port.parse::<u16>().ok()?)) else { return Some(1) };
    if writeln!(s, "{token}\n{prompt}").is_err() {
        return Some(1);
    }
    let mut r = BufReader::new(s);
    let mut status = String::new();
    if r.read_line(&mut status).is_err() || status.trim() != "ok" {
        return Some(1);
    }
    let mut answer = String::new();
    let _ = r.read_line(&mut answer);
    println!("{}", answer.trim_end_matches(['\r', '\n']));
    Some(0)
}

/// 一次网络操作期间的 askpass 服务。drop 时停止。
pub(crate) struct Server {
    stop: Arc<AtomicBool>,
    /// 正在等用户输入：这段时间不算“远程没有响应”
    pub waiting: Arc<AtomicBool>,
    /// 用户取消了输入
    pub refused: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// 给 `cmd` 配上 askpass。界面没设置 `Asker` 或程序时返回 `None`（不接管）。
/// `last` 是“最后一次有输出的时间”：用户输入完后重置，免得刚输完就判超时。
pub(crate) fn serve(cmd: &mut Command, cancel: &Cancel, last: Arc<Mutex<Instant>>) -> Option<Server> {
    if QUIET.with(|q| q.get()) {
        return None;
    }
    let asker = ASKER.read().ok()?.clone()?;
    let program = PROGRAM.read().ok()?.clone()?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
    listener.set_nonblocking(true).ok()?;
    let port = listener.local_addr().ok()?.port();
    let token = random_token();
    cmd.env("GIT_ASKPASS", &program)
        .env("SSH_ASKPASS", &program)
        // OpenSSH 8.4 起：没有终端也用 SSH_ASKPASS
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(ENV_PORT, port.to_string())
        .env(ENV_TOKEN, &token);
    if std::env::var_os("DISPLAY").is_none() {
        // 旧版 ssh 只在有 DISPLAY 时才用 SSH_ASKPASS
        cmd.env("DISPLAY", ":0");
    }

    let stop = Arc::new(AtomicBool::new(false));
    let waiting = Arc::new(AtomicBool::new(false));
    let refused = Arc::new(AtomicBool::new(false));
    let (stop2, waiting2, refused2, cancel2) = (stop.clone(), waiting.clone(), refused.clone(), cancel.clone());
    let thread = std::thread::spawn(move || {
        while !stop2.load(Ordering::SeqCst) {
            let Ok((conn, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(30));
                continue;
            };
            let _ = conn.set_nonblocking(false);
            let _ = conn.set_read_timeout(Some(Duration::from_secs(5)));
            let mut r = BufReader::new(match conn.try_clone() {
                Ok(c) => c,
                Err(_) => continue,
            });
            let (mut t, mut prompt) = (String::new(), String::new());
            if r.read_line(&mut t).is_err() || t.trim_end() != token || r.read_line(&mut prompt).is_err() {
                continue;
            }
            let prompt = prompt.trim_end().to_string();
            let lower = prompt.to_lowercase();
            let secret = ["password", "passphrase", "token", "pin"].iter().any(|k| lower.contains(k));
            waiting2.store(true, Ordering::SeqCst);
            let answer = if refused2.load(Ordering::SeqCst) { None } else { asker(&AuthRequest { prompt, secret }, &cancel2) };
            *last.lock().unwrap() = Instant::now();
            waiting2.store(false, Ordering::SeqCst);
            let mut w = conn;
            match answer {
                Some(a) => {
                    let _ = write!(w, "ok\n{}\n", a.replace(['\r', '\n'], ""));
                }
                None => {
                    refused2.store(true, Ordering::SeqCst);
                    let _ = w.write_all(b"no\n");
                }
            }
        }
    });
    Some(Server { stop, waiting, refused, thread: Some(thread) })
}

/// 128 位随机口令：用标准库按进程随机初始化的哈希种子，混入时间和计数
fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let part = |salt: u64| {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(salt);
        h.write_u64(n);
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.finish()
    };
    format!("{:016x}{:016x}", part(1), part(2))
}
