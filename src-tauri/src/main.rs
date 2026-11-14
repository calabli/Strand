// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // git 需要输入密码时会以 askpass 方式运行本程序（说明书 7.5）：只转发提示和回答，不启动界面
    if let Some(code) = strand_core::askpass::client_main() {
        std::process::exit(code);
    }
    // 从访达、程序坞启动时用终端里的 PATH，这样用的是同一个 git（凭据、配置一致）
    #[cfg(unix)]
    let adopted = strand_core::shell_path::adopt_login_path();
    #[cfg(not(unix))]
    let adopted: Option<u128> = None;
    strand_lib::run(adopted)
}
