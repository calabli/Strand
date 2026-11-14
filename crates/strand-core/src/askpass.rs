//! Ask the user for credentials when needed (spec §7.5).
//!
//! When git (and ssh) needs a username, password or key passphrase, it runs the program named by `GIT_ASKPASS` / `SSH_ASKPASS`,
//! passing the prompt as an argument and reading its stdout as the answer. Here that program is the client itself (or `strand-askpass` in tests):
//! when started in askpass mode (port and token in the environment) it does one thing: connect back to the process that started this network operation,
//! send the prompt over and print the answer.
//!
//! The initiator opens a temporary port on `127.0.0.1` and accepts only connections carrying this run's random token; on a prompt it calls the UI's `Asker`
//! (the UI shows an input box) and hands the answer to this one git process only. Answers are never logged or stored.

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

/// One input request
#[derive(Debug, Clone, Serialize)]
pub struct AuthRequest {
    /// The prompt text from git or ssh, e.g. `Password for 'https://linxia@github.com': `
    pub prompt: String,
    /// Is a password, passphrase or token (the input box should mask it)
    pub secret: bool,
}

/// The UI's "ask the user for input": returns `None` when the user cancels. While waiting it should watch `Cancel` (the user pressed stop).
pub type Asker = Arc<dyn Fn(&AuthRequest, &Cancel) -> Option<String> + Send + Sync>;

static ASKER: RwLock<Option<Asker>> = RwLock::new(None);
static PROGRAM: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Set how to ask the user for input. When unset we don't take over and git behaves as usual (fails when input is needed).
pub fn set_asker(a: Asker) {
    *ASKER.write().unwrap() = Some(a);
}

thread_local! {
    static QUIET: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Network operations run inside `f` don't ask the user (e.g. background auto-fetch): they fail when input is needed.
pub fn without_prompt<T>(f: impl FnOnce() -> T) -> T {
    QUIET.with(|q| q.set(true));
    let r = f();
    QUIET.with(|q| q.set(false));
    r
}

/// Set the program to run as askpass (usually the client's own executable, whose main calls `client_main` first).
pub fn set_program(p: PathBuf) {
    *PROGRAM.write().unwrap() = Some(p);
}

/// The askpass client. When started in askpass mode (port and token in the environment) it sends the prompt back to the initiator and prints the answer,
/// returning the exit code the process should use; returns `None` when not in askpass mode, and the caller starts normally.
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

/// The askpass service for one network operation. Stops on drop.
pub(crate) struct Server {
    stop: Arc<AtomicBool>,
    /// Waiting for user input: this time doesn't count as "remote not responding"
    pub waiting: Arc<AtomicBool>,
    /// The user cancelled input
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

/// Set up askpass for `cmd`. Returns `None` (no takeover) when the UI hasn't set an `Asker` or a program.
/// `last` is "the last time there was output": reset after the user answers so we don't time out right after they type.
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
        // OpenSSH 8.4+: use SSH_ASKPASS even without a terminal
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(ENV_PORT, port.to_string())
        .env(ENV_TOKEN, &token);
    if std::env::var_os("DISPLAY").is_none() {
        // Older ssh only uses SSH_ASKPASS when DISPLAY is set
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

/// 128-bit random token: the std per-process random hash seed, mixed with time and a counter
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
