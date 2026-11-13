// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // git 需要输入密码时会以 askpass 方式运行本程序（说明书 7.5）：只转发提示和回答，不启动界面
    if let Some(code) = strand_core::askpass::client_main() {
        std::process::exit(code);
    }
    strand_lib::run()
}
