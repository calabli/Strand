//! 需要输入凭据时向用户要（说明书 7.5）：git 通过 askpass 把提示交给界面，回答只给这一次 git 进程。

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
                // 用户迟迟不输入，期间点了停止
                while !cancel.is_cancelled() {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                None
            }
            _ => None,
        }
    }));

    // 1. 用户名和密码都向用户要，回答交给 git
    let out = remote::credential_probe(dir.path(), "https://example.invalid/repo.git", &Cancel::default()).unwrap();
    assert!(out.contains("username=linxia"), "{out}");
    assert!(out.contains("password=s3cret 密码"), "{out}");
    let asked = seen.lock().unwrap().clone();
    assert_eq!(asked.len(), 2);
    assert!(asked[0].prompt.starts_with("Username for 'https://example.invalid'") && !asked[0].secret, "{asked:?}");
    assert!(asked[1].prompt.starts_with("Password for") && asked[1].secret, "{asked:?}");

    // 2. 用户取消：按取消处理，不再追问密码
    seen.lock().unwrap().clear();
    *mode.lock().unwrap() = "cancel";
    let e = remote::credential_probe(dir.path(), "https://example.invalid/repo.git", &Cancel::default()).unwrap_err();
    assert_eq!(e.code, ErrorCode::Cancelled, "{e:?}");
    assert_eq!(seen.lock().unwrap().len(), 1);

    // 3. 等输入时点了停止：输入框收回，操作取消
    *mode.lock().unwrap() = "wait";
    let cancel = Cancel::default();
    let c2 = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        c2.cancel();
    });
    let e = remote::credential_probe(dir.path(), "https://example.invalid/repo.git", &cancel).unwrap_err();
    assert_eq!(e.code, ErrorCode::Cancelled);

    // 4. 后台操作不问：需要输入时直接失败，界面不弹框
    *mode.lock().unwrap() = "answer";
    seen.lock().unwrap().clear();
    let e = askpass::without_prompt(|| remote::credential_probe(dir.path(), "https://example.invalid/repo.git", &Cancel::default())).unwrap_err();
    assert_ne!(e.code, ErrorCode::Cancelled);
    assert!(seen.lock().unwrap().is_empty());
}

/// 不是以 askpass 方式启动时，client_main 不接管
#[test]
fn client_main_is_inert_normally() {
    assert_eq!(askpass::client_main(), None);
}
