//! 测试用的 askpass 程序（说明书 7.5）。客户端本身在 main 开头调用同一个 `client_main`，不需要这个文件。
fn main() {
    std::process::exit(strand_core::askpass::client_main().unwrap_or(1));
}
