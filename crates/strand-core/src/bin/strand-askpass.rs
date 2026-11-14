//! The askpass program used in tests (spec §7.5). The client itself calls the same `client_main` at the start of main and doesn't need this file.
fn main() {
    std::process::exit(strand_core::askpass::client_main().unwrap_or(1));
}
