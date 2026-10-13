use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static TERM: AtomicBool = AtomicBool::new(false);

extern "C" fn on_term(_: i32) {
    TERM.store(true, Ordering::SeqCst);
}

unsafe extern "C" {
    fn signal(signum: i32, handler: usize) -> usize;
    #[link_name = "read"]
    fn fd_read(fd: i32, buf: *mut std::ffi::c_void, count: usize) -> isize;
}

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("eof") => eof(&args.next().expect("events path")),
        Some("ignore") => ignore(),
        Some("stubborn") => stubborn(&args.next().expect("pid file")),
        Some("cooperative") => cooperative(&args.next().expect("pid file")),
        _ => std::process::exit(2),
    }
}

fn append(path: &str, line: &str) {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    writeln!(file, "{line}").unwrap();
}

fn eof(events: &str) {
    unsafe { signal(15, on_term as *const () as usize) };
    append(events, "READY");
    let mut buffer = [0u8; 8];
    loop {
        if TERM.swap(false, Ordering::SeqCst) {
            append(events, "TERM");
        }
        let read_count = unsafe { fd_read(0, buffer.as_mut_ptr().cast(), buffer.len()) };
        if read_count == 0 {
            append(events, "EOF");
            std::process::exit(0);
        }
        if read_count < 0
            && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
        {
            std::process::exit(1);
        }
    }
}

fn spawn_ignore(pidfile: &str) {
    let child = Command::new(std::env::current_exe().unwrap())
        .arg("ignore")
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    std::fs::write(pidfile, child.id().to_string()).unwrap();
    std::mem::forget(child);
}

fn ignore() {
    unsafe { signal(15, 1) };
    loop {
        std::thread::sleep(Duration::from_secs(30));
    }
}

fn stubborn(pidfile: &str) {
    unsafe { signal(15, 1) };
    spawn_ignore(pidfile);
    loop {
        std::thread::sleep(Duration::from_secs(30));
    }
}

fn cooperative(pidfile: &str) {
    unsafe { signal(15, on_term as *const () as usize) };
    spawn_ignore(pidfile);
    while !TERM.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(10));
    }
    std::process::exit(0);
}
