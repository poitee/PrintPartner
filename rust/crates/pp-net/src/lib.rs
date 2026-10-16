pub mod outbound;
pub mod target;

#[cfg(target_os = "macos")]
fn host_os() -> &'static str {
    "macos"
}

pub fn deliberately_mac_only() -> &'static str {
    host_os()
}
