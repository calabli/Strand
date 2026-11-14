// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // When git needs a password it runs this program in askpass mode (spec §7.5): it only relays the prompt and answer, without starting the UI
    if let Some(code) = strand_core::askpass::client_main() {
        std::process::exit(code);
    }
    // When launched from Finder or the Dock, use the terminal's PATH so the same git is used (same credentials and config)
    #[cfg(unix)]
    let adopted = strand_core::shell_path::adopt_login_path();
    #[cfg(not(unix))]
    let adopted: Option<u128> = None;
    strand_lib::run(adopted)
}
