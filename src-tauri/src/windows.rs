//! Which repositories are open in Strand windows, so the next launch can bring them all back, and quitting that asks
//! about unsaved edits first.
//!
//! Every window is its own process (see `open_new_window`). Each one keeps a small file in the app data folder,
//! `windows/<pid>.json` = { path, seen, focused }, rewritten every few seconds while it runs ("seen"). A file whose
//! "seen" is old belongs to a window that is no longer running: it's what the last session left open.
//! - Quitting (⌘Q, the Dock, logging out) keeps the file, so the window comes back.
//! - Closing a window while other Strand windows are open removes it (that repository was put away).
//! - Closing the last window keeps it (on Windows and Linux that is how the app is quit).
//!
//! A plain launch (no folder in the arguments) takes the files left behind: the most recently focused repository
//! opens in this window, every other one in a new window.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// How often a running window rewrites its file, and when a file counts as left behind
const BEAT: Duration = Duration::from_secs(3);
const STALE_SECS: u64 = 10;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Entry {
    path: String,
    /// Unix seconds: last heartbeat
    seen: u64,
    /// Unix seconds: last time the window had focus
    focused: u64,
}

#[derive(Default)]
pub struct WindowSession {
    entry: Mutex<Option<Entry>>,
    /// Quitting: windows closing now are kept for the next launch
    pub quitting: AtomicBool,
    /// This window is gone (or put away): stop the heartbeat
    stopped: AtomicBool,
    restored: AtomicBool,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn dir(app: &AppHandle) -> Option<PathBuf> {
    let d = app.path().app_data_dir().ok()?.join("windows");
    std::fs::create_dir_all(&d).ok()?;
    Some(d)
}

fn own_file(app: &AppHandle) -> Option<PathBuf> {
    Some(dir(app)?.join(format!("{}.json", std::process::id())))
}

fn write(app: &AppHandle, e: &Entry) {
    if let Some(f) = own_file(app) {
        // Write then rename, so a reader never sees half a file
        let tmp = f.with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec(e).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &f);
        }
    }
}

/// All window files except this process's own: (file, entry)
fn others(app: &AppHandle) -> Vec<(PathBuf, Entry)> {
    let Some(d) = dir(app) else { return Vec::new() };
    let own = format!("{}.json", std::process::id());
    std::fs::read_dir(d)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|f| f.file_name().to_string_lossy().ends_with(".json") && f.file_name().to_string_lossy() != own)
        .filter_map(|f| {
            let e: Entry = serde_json::from_slice(&std::fs::read(f.path()).ok()?).ok()?;
            Some((f.path(), e))
        })
        .collect()
}

fn live(e: &Entry) -> bool {
    now().saturating_sub(e.seen) < STALE_SECS
}

impl WindowSession {
    /// Start the heartbeat; call once at startup
    pub fn start(app: &AppHandle) {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(BEAT);
            let s = app.state::<WindowSession>();
            if s.stopped.load(Ordering::SeqCst) {
                break;
            }
            let mut g = s.entry.lock().unwrap();
            if let Some(e) = g.as_mut() {
                e.seen = now();
                write(&app, e);
            }
        });
    }

    /// The window opened a repository (or switched to another one)
    pub fn register(&self, app: &AppHandle, path: String) {
        let e = Entry { path, seen: now(), focused: now() };
        write(app, &e);
        *self.entry.lock().unwrap() = Some(e);
    }

    pub fn focused(&self, app: &AppHandle) {
        let mut g = self.entry.lock().unwrap();
        if let Some(e) = g.as_mut() {
            e.focused = now();
            e.seen = now();
            write(app, e);
        }
    }

    /// The window is going away. Kept for the next launch when quitting or when it's the last Strand window.
    pub fn leave(&self, app: &AppHandle) {
        self.stopped.store(true, Ordering::SeqCst);
        let keep = self.quitting.load(Ordering::SeqCst) || !others(app).iter().any(|(_, e)| live(e));
        if !keep && let Some(f) = own_file(app) {
            let _ = std::fs::remove_file(f);
        }
    }

    /// At startup (once): the repositories the last session left open. Returns the one for this window and opens the
    /// rest in new windows; with `reopen` false only forgets them. Left-behind files are removed either way (the
    /// windows opened now register again).
    pub fn restore(&self, app: &AppHandle, reopen: bool) -> Option<String> {
        if self.restored.swap(true, Ordering::SeqCst) {
            return None;
        }
        let all = others(app);
        let open_now: Vec<String> = all.iter().filter(|(_, e)| live(e)).map(|(_, e)| e.path.clone()).collect();
        let mut left: Vec<Entry> = Vec::new();
        for (f, e) in all.into_iter().filter(|(_, e)| !live(e)) {
            let _ = std::fs::remove_file(f);
            // Once per repository, skipping ones already open in a running window and folders that are gone
            if !open_now.contains(&e.path) && !left.iter().any(|l| l.path == e.path) && std::path::Path::new(&e.path).is_dir() {
                left.push(e);
            }
        }
        if !reopen || left.is_empty() {
            return None;
        }
        left.sort_by_key(|e| std::cmp::Reverse(e.focused));
        if let Ok(exe) = std::env::current_exe() {
            for e in &left[1..] {
                let _ = std::process::Command::new(&exe).arg(&e.path).spawn();
            }
        }
        Some(left[0].path.clone())
    }
}

/// Ask the window to quit: it checks for unsaved edits first, then calls `app_quit`
pub fn request_quit(app: &AppHandle) {
    let _ = app.emit("quit_requested", ());
}
