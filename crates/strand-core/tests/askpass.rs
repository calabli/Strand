//! Ask the user for credentials when needed (spec §7.5): git hands the prompt to the UI via askpass, and the answer only goes to this git process.

use std::sync::{Arc, Mutex};

use strand_core::askpass::{self, AuthRequest};
use strand_core::remote::{self, Cancel};
use strand_core::ErrorCode;

#[test]
fn asks_the_user_and_handles_cancel() {
    let dir = tempfile::tempdir().unwrap();
    askpass::set_program(env!("CARGO_BIN_EXE_strand-askpass").into());
    let seen: Arc<Mutex<Vec<AuthRequest>>> = Arc::default();
    let mode = Arc::new(Mutex::new("answer"));
    let (seen2, mode2) = (seen.clone(), mode.clone());
    askpass::set_asker(Arc::new(move |req: &AuthRequest, cancel: &Cancel| {
        seen2.lock().unwrap().push(req.clone());
        match *mode2.lock().unwrap() {
            "answer" => Some(if req.secret { "s3cret 密码".to_string() } else { "linxia".to_string() }),
            "wait" => {
                // The user doesn't type and presses stop meanwhile
                while !cancel.is_cancelled() {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                None
            }
            _ => None,
        }
    }));

    // 1. Ask the user for both username and password, hand the answers to git
    let out = remote::credential_probe(dir.path(), "https://example.invalid/repo.git", &Cancel::default()).unwrap();
    assert!(out.contains("username=linxia"), "{out}");
    assert!(out.contains("password=s3cret 密码"), "{out}");
    let asked = seen.lock().unwrap().clone();
    assert_eq!(asked.len(), 2);
    assert!(asked[0].prompt.starts_with("Username for 'https://example.invalid'") && !asked[0].secret, "{asked:?}");
    assert!(asked[1].prompt.starts_with("Password for") && asked[1].secret, "{asked:?}");

    // 2. The user cancels: treated as cancel, no further password prompt
    seen.lock().unwrap().clear();
    *mode.lock().unwrap() = "cancel";
    let e = remote::credential_probe(dir.path(), "https://example.invalid/repo.git", &Cancel::default()).unwrap_err();
    assert_eq!(e.code, ErrorCode::Cancelled, "{e:?}");
    assert_eq!(seen.lock().unwrap().len(), 1);

    // 3. Stop pressed while waiting for input: the input box closes and the operation is cancelled
    *mode.lock().unwrap() = "wait";
    let cancel = Cancel::default();
    let c2 = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        c2.cancel();
    });
    let e = remote::credential_probe(dir.path(), "https://example.invalid/repo.git", &cancel).unwrap_err();
    assert_eq!(e.code, ErrorCode::Cancelled);

    // 4. Background operations don't ask: fail directly when input is needed, no dialog
    *mode.lock().unwrap() = "answer";
    seen.lock().unwrap().clear();
    let e = askpass::without_prompt(|| remote::credential_probe(dir.path(), "https://example.invalid/repo.git", &Cancel::default())).unwrap_err();
    assert_ne!(e.code, ErrorCode::Cancelled);
    assert!(seen.lock().unwrap().is_empty());
}

/// client_main doesn't take over when not started in askpass mode
#[test]
fn client_main_is_inert_normally() {
    assert_eq!(askpass::client_main(), None);
}
