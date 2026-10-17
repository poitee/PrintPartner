use serde::{Deserialize, Serialize};
use std::{
    ffi::CString,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FailureReason {
    SpawnFailed,
    ReadinessTimeout,
    ChildExit,
    HealthLost,
    CleanupFailed,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub(crate) enum Termination {
    ExitCode(i32),
    Signal(i32),
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub(crate) enum Event {
    #[serde(rename = "compat_starting")]
    Starting,
    #[serde(rename = "compat_ready")]
    Ready,
    #[serde(rename = "compat_reaped")]
    Reaped,
    #[serde(rename = "compat_crash_guard")]
    CrashGuard,
    #[serde(rename = "compat_start_failed")]
    StartFailed,
    #[serde(rename = "compat_output")]
    Output,
    #[serde(rename = "compat_failure")]
    Failure {
        reason: FailureReason,
        termination: Option<Termination>,
    },
}

#[derive(Serialize, Deserialize)]
struct Record {
    time: u64,
    level: u64,
    #[serde(flatten)]
    event: Event,
}

pub fn recent_diagnostics(data: &Path) -> std::io::Result<String> {
    const TAIL_BYTES: u64 = 64 * 1024;
    const ROW_BYTES: usize = 2048;
    const RECORDS: usize = 100;
    let directory = data.join("logs");
    if std::fs::symlink_metadata(&directory)?
        .file_type()
        .is_symlink()
    {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    let mut records = std::collections::VecDeque::new();
    let mut incomplete = false;
    for index in (0..=6).rev() {
        let name = if index == 0 {
            "desktop.jsonl".to_owned()
        } else {
            format!("desktop.{index}.jsonl")
        };
        let mut file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(directory.join(name))
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                incomplete = true;
                continue;
            }
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            incomplete = true;
            continue;
        }
        let offset = metadata.len().saturating_sub(TAIL_BYTES);
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        file.take(TAIL_BYTES).read_to_end(&mut bytes)?;
        incomplete |= offset != 0;
        let mut start = offset == 0;
        for row in bytes.split_inclusive(|byte| *byte == b'\n') {
            if !start {
                start = true;
                continue;
            }
            if row.len() > ROW_BYTES || row.last() != Some(&b'\n') {
                incomplete = true;
                continue;
            }
            let Ok(record) = serde_json::from_slice::<Record>(row) else {
                incomplete = true;
                continue;
            };
            if ![10, 20, 30, 40, 50, 60].contains(&record.level) {
                incomplete = true;
                continue;
            }
            if records.len() == RECORDS {
                records.pop_front();
                incomplete = true;
            }
            records.push_back(record);
        }
    }
    let mut text = String::new();
    if incomplete {
        text.push_str("Showing recent safe records. Older or invalid records were omitted.\n\n");
    }
    if records.is_empty() {
        text.push_str("No diagnostic events recorded.\n");
    }
    for record in records {
        text.push_str(&serde_json::to_string(&record)?);
        text.push('\n');
    }
    Ok(text)
}

#[derive(Clone)]
pub(crate) struct Logs(Arc<Mutex<LogFile>>);
struct LogFile {
    directory: File,
    file: File,
    day: u64,
    bytes: u64,
}

fn set_mode(file: &File, mode: libc::mode_t) -> std::io::Result<()> {
    if unsafe { libc::fchmod(file.as_raw_fd(), mode) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn secure_log(file: &File) -> std::io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.nlink() != 1
    {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    set_mode(file, 0o600)
}

fn secure_directory(directory: &File) -> std::io::Result<()> {
    let metadata = directory.metadata()?;
    if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    set_mode(directory, 0o700)
}

fn secure_archives(directory: &File) -> std::io::Result<()> {
    for index in 1..=6 {
        let name = CString::new(format!("desktop.{index}.jsonl"))?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                continue;
            }
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
                if unsafe {
                    libc::fstatat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        metadata.as_mut_ptr(),
                        libc::AT_SYMLINK_NOFOLLOW,
                    )
                } != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                let metadata = unsafe { metadata.assume_init() };
                if metadata.st_mode & libc::S_IFMT == libc::S_IFREG
                    && metadata.st_uid == unsafe { libc::geteuid() }
                    && metadata.st_nlink == 1
                    && metadata.st_mode & 0o7777 & !0o600 == 0
                {
                    continue;
                }
            }
            return Err(error);
        }
        let file = unsafe { File::from_raw_fd(fd) };
        secure_log(&file)?;
    }
    Ok(())
}

fn open_log(directory: &File) -> std::io::Result<File> {
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c"desktop.jsonl".as_ptr(),
            libc::O_WRONLY
                | libc::O_APPEND
                | libc::O_CREAT
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK,
            0o600 as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(fd) };
    secure_log(&file)?;
    Ok(file)
}

impl Logs {
    pub(crate) fn open(directory: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&directory)?;
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(directory)?;
        secure_directory(&directory)?;
        secure_archives(&directory)?;
        let file = open_log(&directory)?;
        let bytes = file.metadata()?.len();
        let day = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            / 86400;
        Ok(Self(Arc::new(Mutex::new(LogFile {
            directory,
            file,
            day,
            bytes,
        }))))
    }
    pub(crate) fn event(&self, event: Event, level: u64) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let Ok(mut log) = self.0.lock() else { return };
        if secure_directory(&log.directory).is_err() {
            return;
        }
        if log
            .file
            .metadata()
            .is_ok_and(|metadata| metadata.nlink() == 0)
        {
            let Ok(file) = open_log(&log.directory) else {
                return;
            };
            let Ok(metadata) = file.metadata() else {
                return;
            };
            log.bytes = metadata.len();
            log.day = now / 86400;
            log.file = file;
        }
        if secure_log(&log.file).is_err() {
            return;
        }
        let Ok(mut row) = serde_json::to_string(&Record {
            time: now,
            event,
            level,
        }) else {
            return;
        };
        row.push('\n');
        if log.day != now / 86400 || log.bytes + row.len() as u64 > 10 * 1024 * 1024 {
            let rotate = (|| -> std::io::Result<()> {
                open_log(&log.directory)?;
                secure_archives(&log.directory)?;
                let directory = log.directory.as_raw_fd();
                for index in (1..=6).rev() {
                    let source = CString::new(if index == 1 {
                        "desktop.jsonl".to_owned()
                    } else {
                        format!("desktop.{}.jsonl", index - 1)
                    })?;
                    let target = CString::new(format!("desktop.{index}.jsonl"))?;
                    if unsafe {
                        libc::renameat(directory, source.as_ptr(), directory, target.as_ptr())
                    } != 0
                    {
                        let error = std::io::Error::last_os_error();
                        if error.kind() != std::io::ErrorKind::NotFound {
                            return Err(error);
                        }
                    }
                }
                log.file = open_log(&log.directory)?;
                log.bytes = 0;
                log.day = now / 86400;
                Ok(())
            })();
            if rotate.is_err() {
                return;
            }
        }
        if log.file.write_all(row.as_bytes()).is_ok() {
            log.bytes += row.len() as u64;
        }
    }
    pub(crate) async fn capture(&self, reader: impl tokio::io::AsyncRead + Unpin) {
        let mut reader = BufReader::with_capacity(4096, reader);
        let mut line = Vec::new();
        loop {
            let Ok(bytes) = reader.fill_buf().await else {
                return;
            };
            if bytes.is_empty() {
                if !line.is_empty() {
                    self.capture_line(&line);
                }
                return;
            }
            for byte in bytes {
                if *byte == b'\n' {
                    self.capture_line(&line);
                    line.clear();
                } else if line.len() < 8192 {
                    line.push(*byte);
                }
            }
            let consumed = bytes.len();
            reader.consume(consumed);
        }
    }

    fn capture_line(&self, line: &[u8]) {
        let value: serde_json::Value =
            serde_json::from_slice(line).unwrap_or(serde_json::Value::Null);
        let level = value["level"]
            .as_u64()
            .filter(|n| [10, 20, 30, 40, 50, 60].contains(n))
            .unwrap_or(30);
        let event = match value["event"].as_str() {
            Some("desktop_start_failed") => Event::StartFailed,
            _ => Event::Output,
        };
        self.event(event, level);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pp-diagnostic-{}-{}",
                std::process::id(),
                rand::random::<u64>()
            ));
            std::fs::create_dir_all(path.join("logs")).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }

    fn chmod(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn force_rotation(logs: &Logs, size: bool) {
        let mut log = logs.0.lock().unwrap();
        if size {
            log.bytes = 10 * 1024 * 1024;
        } else {
            log.day = 0;
        }
    }

    #[test]
    fn ticket_t_2_unlinked_active_log_recovers_without_restart() {
        for rotation in [None, Some(false), Some(true)] {
            let scratch = Scratch::new();
            let directory = scratch.0.join("logs");
            let path = directory.join("desktop.jsonl");
            let logs = Logs::open(directory).unwrap();
            logs.event(Event::Starting, 30);
            std::fs::remove_file(&path).unwrap();
            if let Some(size) = rotation {
                force_rotation(&logs, size);
            }
            logs.event(Event::Ready, 30);
            let row: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(row["event"], "compat_ready");
            assert_eq!(mode(&path), 0o600);
        }
    }

    #[test]
    fn ticket_t_2_unlinked_active_log_refuses_redirected_recovery() {
        for hardlink in [false, true] {
            let scratch = Scratch::new();
            let directory = scratch.0.join("logs");
            let path = directory.join("desktop.jsonl");
            let logs = Logs::open(directory).unwrap();
            std::fs::remove_file(&path).unwrap();
            let target = scratch.0.join("outside");
            std::fs::write(&target, b"private history\n").unwrap();
            chmod(&target, 0o640);
            if hardlink {
                std::fs::hard_link(&target, &path).unwrap();
            } else {
                std::os::unix::fs::symlink(&target, &path).unwrap();
            }
            logs.event(Event::Ready, 30);
            assert_eq!(std::fs::read(&target).unwrap(), b"private history\n");
            assert_eq!(mode(&target), 0o640);
            std::fs::remove_file(&path).unwrap();
            logs.event(Event::Ready, 30);
            let row: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert_eq!(row["event"], "compat_ready");
        }
    }

    #[test]
    fn ticket_t_2_restrictive_archives_allow_startup_and_rotation() {
        for permissions in [0o000, 0o200] {
            for size in [false, true] {
                let scratch = Scratch::new();
                let directory = scratch.0.join("logs");
                let path = directory.join("desktop.1.jsonl");
                std::fs::write(&path, b"history\n").unwrap();
                chmod(&path, permissions);
                let logs = Logs::open(directory.clone()).unwrap();
                logs.event(Event::Starting, 30);
                force_rotation(&logs, size);
                logs.event(Event::Ready, 30);
                let archived = directory.join("desktop.2.jsonl");
                assert_eq!(mode(&archived) & !0o600, 0);
                chmod(&archived, 0o600);
                assert_eq!(std::fs::read(&archived).unwrap(), b"history\n");
                let row: serde_json::Value = serde_json::from_slice(
                    &std::fs::read(directory.join("desktop.jsonl")).unwrap(),
                )
                .unwrap();
                assert_eq!(row["event"], "compat_ready");
            }
        }
    }

    #[test]
    fn ticket_t_2_restrictive_hardlinked_archive_is_still_refused() {
        let scratch = Scratch::new();
        let target = scratch.0.join("outside");
        std::fs::write(&target, b"history\n").unwrap();
        chmod(&target, 0o000);
        std::fs::hard_link(&target, scratch.0.join("logs/desktop.1.jsonl")).unwrap();
        assert!(Logs::open(scratch.0.join("logs")).is_err());
        assert_eq!(mode(&target), 0o000);
        chmod(&target, 0o600);
        assert_eq!(std::fs::read(target).unwrap(), b"history\n");
    }

    #[test]
    fn ticket_t_2_hardlink_active_startup_leaves_target_unchanged() {
        let scratch = Scratch::new();
        let target = scratch.0.join("outside");
        std::fs::write(&target, b"private history\n").unwrap();
        chmod(&target, 0o640);
        std::fs::hard_link(&target, scratch.0.join("logs/desktop.jsonl")).unwrap();
        let result = Logs::open(scratch.0.join("logs"));
        if let Ok(logs) = &result {
            logs.event(Event::Ready, 30);
        }
        assert_eq!(std::fs::read(&target).unwrap(), b"private history\n");
        assert_eq!(mode(&target), 0o640);
        assert!(result.is_err());
    }

    #[test]
    fn ticket_t_2_hardlink_active_after_startup_refuses_append_and_both_rotations() {
        for rotation in [None, Some(false), Some(true)] {
            let scratch = Scratch::new();
            let directory = scratch.0.join("logs");
            let path = directory.join("desktop.jsonl");
            let logs = Logs::open(directory.clone()).unwrap();
            logs.event(Event::Starting, 30);
            let before = std::fs::read(&path).unwrap();
            let target = scratch.0.join("outside");
            std::fs::hard_link(&path, &target).unwrap();
            chmod(&target, 0o640);
            if let Some(size) = rotation {
                force_rotation(&logs, size);
            }
            for _ in 0..2 {
                logs.event(Event::Ready, 30);
            }
            assert_eq!(std::fs::read(&target).unwrap(), before, "{rotation:?}");
            assert_eq!(mode(&target), 0o640);
            assert!(!directory.join("desktop.1.jsonl").exists());
        }
    }

    #[test]
    fn ticket_t_2_hardlink_active_replacement_preserves_history_on_rotation() {
        for size in [false, true] {
            let scratch = Scratch::new();
            let directory = scratch.0.join("logs");
            let path = directory.join("desktop.jsonl");
            let logs = Logs::open(directory.clone()).unwrap();
            logs.event(Event::Starting, 30);
            let original = scratch.0.join("original");
            std::fs::rename(&path, &original).unwrap();
            let before = std::fs::read(&original).unwrap();
            let target = scratch.0.join("outside");
            std::fs::write(&target, b"private history\n").unwrap();
            chmod(&target, 0o640);
            std::fs::hard_link(&target, &path).unwrap();
            std::fs::write(directory.join("desktop.6.jsonl"), b"oldest\n").unwrap();
            force_rotation(&logs, size);
            logs.event(Event::Ready, 30);
            assert_eq!(std::fs::read(&original).unwrap(), before);
            assert_eq!(std::fs::read(&target).unwrap(), b"private history\n");
            assert_eq!(mode(&target), 0o640);
            assert_eq!(
                std::fs::read(directory.join("desktop.6.jsonl")).unwrap(),
                b"oldest\n"
            );
            assert!(!directory.join("desktop.1.jsonl").exists());
        }
    }

    #[test]
    fn ticket_t_2_hardlink_archive_startup_rejects_every_slot_without_creating_active() {
        for slot in 1..=6 {
            let scratch = Scratch::new();
            let directory = scratch.0.join("logs");
            let target = scratch.0.join("outside");
            std::fs::write(&target, b"archive\n").unwrap();
            chmod(&target, 0o644);
            std::fs::hard_link(&target, directory.join(format!("desktop.{slot}.jsonl"))).unwrap();
            assert!(Logs::open(directory.clone()).is_err(), "slot {slot}");
            assert!(!directory.join("desktop.jsonl").exists());
            assert_eq!(std::fs::read(&target).unwrap(), b"archive\n");
            assert_eq!(mode(&target), 0o644);
        }
    }

    #[test]
    fn ticket_t_2_hardlink_archive_rotation_preserves_all_history_for_both_triggers() {
        for size in [false, true] {
            for slot in 1..=6 {
                let scratch = Scratch::new();
                let directory = scratch.0.join("logs");
                let logs = Logs::open(directory.clone()).unwrap();
                logs.event(Event::Starting, 30);
                let active = std::fs::read(directory.join("desktop.jsonl")).unwrap();
                for index in 1..=6 {
                    std::fs::write(
                        directory.join(format!("desktop.{index}.jsonl")),
                        format!("history {index}\n"),
                    )
                    .unwrap();
                }
                let target = scratch.0.join("outside");
                std::fs::hard_link(directory.join(format!("desktop.{slot}.jsonl")), &target)
                    .unwrap();
                chmod(&target, 0o640);
                force_rotation(&logs, size);
                for _ in 0..2 {
                    logs.event(Event::Ready, 30);
                }
                assert_eq!(
                    std::fs::read(directory.join("desktop.jsonl")).unwrap(),
                    active
                );
                for index in 1..=6 {
                    assert_eq!(
                        std::fs::read(directory.join(format!("desktop.{index}.jsonl"))).unwrap(),
                        format!("history {index}\n").as_bytes(),
                        "size={size}, linked slot={slot}, archive={index}"
                    );
                }
                assert_eq!(
                    std::fs::read(&target).unwrap(),
                    format!("history {slot}\n").as_bytes()
                );
                assert_eq!(mode(&target), 0o640);
            }
        }
    }

    #[test]
    fn ticket_t_2_owner_only_existing_modes_are_repaired_without_creating_archives() {
        let scratch = Scratch::new();
        let directory = scratch.0.join("logs");
        chmod(&directory, 0o2775);
        for name in ["desktop.jsonl", "desktop.1.jsonl", "desktop.6.jsonl"] {
            let path = directory.join(name);
            std::fs::write(&path, b"history\n").unwrap();
            chmod(&path, 0o664);
        }
        let _logs = Logs::open(directory.clone()).unwrap();
        assert_eq!(mode(&directory), 0o700);
        for name in ["desktop.jsonl", "desktop.1.jsonl", "desktop.6.jsonl"] {
            assert_eq!(mode(&directory.join(name)), 0o600);
            assert_eq!(std::fs::read(directory.join(name)).unwrap(), b"history\n");
        }
        assert_eq!(std::fs::read_dir(directory).unwrap().count(), 3);
    }

    #[test]
    fn ticket_t_2_owner_only_modes_are_repaired_between_events_and_both_rotations() {
        for rotation in [None, Some(false), Some(true)] {
            let scratch = Scratch::new();
            let directory = scratch.0.join("logs");
            let path = directory.join("desktop.jsonl");
            let logs = Logs::open(directory.clone()).unwrap();
            logs.event(Event::Starting, 30);
            chmod(&directory, 0o755);
            chmod(&path, 0o664);
            if let Some(size) = rotation {
                for index in 1..=6 {
                    let archive = directory.join(format!("desktop.{index}.jsonl"));
                    std::fs::write(&archive, format!("history {index}\n")).unwrap();
                    chmod(&archive, 0o644);
                }
                force_rotation(&logs, size);
            }
            logs.event(Event::Ready, 30);
            assert_eq!(mode(&directory), 0o700);
            assert_eq!(mode(&path), 0o600);
            let bytes = std::fs::read(&path).unwrap();
            assert!(String::from_utf8(bytes).unwrap().contains("compat_ready"));
            if rotation.is_some() {
                for index in 1..=6 {
                    assert_eq!(
                        mode(&directory.join(format!("desktop.{index}.jsonl"))),
                        0o600
                    );
                }
                assert!(
                    std::fs::read_to_string(directory.join("desktop.1.jsonl"))
                        .unwrap()
                        .contains("compat_starting")
                );
                for index in 2..=6 {
                    assert_eq!(
                        std::fs::read_to_string(directory.join(format!("desktop.{index}.jsonl")))
                            .unwrap(),
                        format!("history {}\n", index - 1)
                    );
                }
            }
        }
    }

    fn fifo(path: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    }

    #[test]
    fn ticket_t_2_log_open_rejects_fifo_with_peer() {
        let scratch = Scratch::new();
        let path = scratch.0.join("logs/desktop.jsonl");
        fifo(&path);
        let _peer = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        assert!(Logs::open(scratch.0.join("logs")).is_err());
    }

    #[test]
    fn ticket_t_2_log_open_rejects_readerless_fifo_promptly() {
        const CHILD_PATH: &str = "PP_TEST_READERLESS_LOG_FIFO";
        if let Some(directory) = std::env::var_os(CHILD_PATH) {
            assert!(Logs::open(PathBuf::from(directory)).is_err());
            return;
        }
        let scratch = Scratch::new();
        fifo(&scratch.0.join("logs/desktop.jsonl"));
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "logs::tests::ticket_t_2_log_open_rejects_readerless_fifo_promptly",
                "--nocapture",
            ])
            .env(CHILD_PATH, scratch.0.join("logs"))
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "FIFO admission child failed: {status}");
                break;
            }
            if started.elapsed() >= std::time::Duration::from_secs(2) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("readerless FIFO blocked log admission for 2 seconds");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn ticket_t_2_log_open_rejects_symlink_without_writing_target() {
        let scratch = Scratch::new();
        let target = scratch.0.join("outside");
        std::fs::write(&target, "unchanged\n").unwrap();
        std::os::unix::fs::symlink(&target, scratch.0.join("logs/desktop.jsonl")).unwrap();
        let result = Logs::open(scratch.0.join("logs"));
        if let Ok(logs) = &result {
            logs.event(Event::Ready, 30);
        }
        assert_eq!(std::fs::read_to_string(target).unwrap(), "unchanged\n");
        assert!(result.is_err());
    }

    #[test]
    fn ticket_t_2_log_open_rejects_symlinked_directory_without_writing_target() {
        let scratch = Scratch::new();
        let target = scratch.0.join("outside");
        std::fs::create_dir(&target).unwrap();
        std::fs::remove_dir(scratch.0.join("logs")).unwrap();
        std::os::unix::fs::symlink(&target, scratch.0.join("logs")).unwrap();
        let result = Logs::open(scratch.0.join("logs"));
        if let Ok(logs) = &result {
            logs.event(Event::Ready, 30);
        }
        assert_eq!(std::fs::read_dir(target).unwrap().count(), 0);
        assert!(result.is_err());
    }

    #[test]
    fn ticket_t_2_log_rotation_stays_in_admitted_directory_after_symlink_swap() {
        let scratch = Scratch::new();
        let directory = scratch.0.join("logs");
        let logs = Logs::open(directory.clone()).unwrap();
        logs.event(Event::Starting, 30);
        let admitted = scratch.0.join("admitted");
        std::fs::rename(&directory, &admitted).unwrap();
        let target = scratch.0.join("outside");
        std::fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &directory).unwrap();
        logs.0.lock().unwrap().day = 0;
        logs.event(Event::Ready, 30);
        assert_eq!(std::fs::read_dir(target).unwrap().count(), 0);
        let row = |name: &str| -> serde_json::Value {
            serde_json::from_slice(&std::fs::read(admitted.join(name)).unwrap()).unwrap()
        };
        assert_eq!(row("desktop.1.jsonl")["event"], "compat_starting");
        assert_eq!(row("desktop.jsonl")["event"], "compat_ready");
    }

    #[test]
    fn ticket_t_2_log_rotation_rejects_dangling_symlink_replacement() {
        let scratch = Scratch::new();
        let path = scratch.0.join("logs/desktop.jsonl");
        let logs = Logs::open(scratch.0.join("logs")).unwrap();
        logs.event(Event::Starting, 30);
        let before = std::fs::read(&path).unwrap();
        let original = scratch.0.join("original");
        std::fs::rename(&path, &original).unwrap();
        let target = scratch.0.join("outside");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        logs.0.lock().unwrap().day = 0;
        logs.event(Event::Ready, 30);
        assert!(!target.exists(), "rotation created the symlink target");
        assert_eq!(std::fs::read(original).unwrap(), before);
        assert!(std::fs::symlink_metadata(path).unwrap().is_symlink());
    }

    #[test]
    fn ticket_t_2_log_rotation_preserves_archives_with_dangling_active_symlink() {
        for size_rollover in [false, true] {
            let scratch = Scratch::new();
            let directory = scratch.0.join("logs");
            let path = directory.join("desktop.jsonl");
            let logs = Logs::open(directory.clone()).unwrap();
            logs.event(Event::Starting, 30);
            let before = std::fs::read(&path).unwrap();
            let original = scratch.0.join("original");
            std::fs::rename(&path, &original).unwrap();
            let target = scratch.0.join("outside");
            std::os::unix::fs::symlink(&target, &path).unwrap();
            let archives = ["one\n", "two\n", "three\n", "four\n", "five\n", "six\n"];
            for (index, bytes) in archives.iter().enumerate() {
                std::fs::write(
                    directory.join(format!("desktop.{}.jsonl", index + 1)),
                    bytes,
                )
                .unwrap();
            }
            {
                let mut log = logs.0.lock().unwrap();
                if size_rollover {
                    log.bytes = 10 * 1024 * 1024;
                } else {
                    log.day = 0;
                }
            }
            for _ in 0..3 {
                logs.event(Event::Ready, 30);
            }
            for (index, bytes) in archives.iter().enumerate() {
                assert_eq!(
                    std::fs::read(directory.join(format!("desktop.{}.jsonl", index + 1))).ok(),
                    Some(bytes.as_bytes().to_vec()),
                    "archive {} changed after repeated events, size_rollover={size_rollover}",
                    index + 1
                );
            }
            assert!(!target.exists(), "rotation created the symlink target");
            assert_eq!(std::fs::read(original).unwrap(), before);
            assert!(std::fs::symlink_metadata(path).unwrap().is_symlink());
        }
    }

    #[tokio::test]
    async fn ticket_t_2_log_appends_redacted_records_and_rotates_regular_files() {
        let scratch = Scratch::new();
        let path = scratch.0.join("logs/desktop.jsonl");
        let seed = b"{\"time\":1,\"level\":30,\"event\":\"compat_starting\"}\n";
        std::fs::write(&path, seed).unwrap();
        let logs = Logs::open(scratch.0.join("logs")).unwrap();
        logs.capture(&b"{\"level\":50,\"message\":\"SECRET_TOKEN\"}\n"[..])
            .await;
        let appended = std::fs::read(&path).unwrap();
        assert!(appended.starts_with(seed));
        let row: serde_json::Value = serde_json::from_slice(&appended[seed.len()..]).unwrap();
        assert_eq!(row["event"], "compat_output");
        assert_eq!(row["level"], 50);
        assert_eq!(row.as_object().unwrap().len(), 3);
        logs.0.lock().unwrap().day = 0;
        logs.event(Event::Ready, 30);
        assert_eq!(
            std::fs::read(scratch.0.join("logs/desktop.1.jsonl")).unwrap(),
            appended
        );
        let row: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(row["event"], "compat_ready");
        assert_eq!(row["level"], 30);
        assert_eq!(row.as_object().unwrap().len(), 3);
    }

    #[test]
    fn ticket_t_2_log_view_reprojects_legacy_rows_and_rejects_private_fields() {
        let scratch = Scratch::new();
        std::fs::write(scratch.0.join("logs/desktop.jsonl"), concat!(
            "{\"time\":1,\"level\":30,\"event\":\"compat_ready\",\"message\":\"SECRET_PRIVATE_PATH\"}\n",
            "{\"time\":2,\"level\":50,\"event\":\"SECRET_PRIVATE_EVENT\"}\n",
            "{\"time\":3,\"level\":99,\"event\":\"compat_output\"}\n",
            "{\"time\":4,\"level\":50,\"event\":\"compat_failure\",\"reason\":\"child_exit\",\"termination\":{\"kind\":\"signal\",\"value\":9,\"secret\":\"SECRET_TOKEN\"}}\n",
            "{\"time\":5,\"level\":50,\"event\":\"compat_failure\",\"reason\":\"SECRET_REASON\",\"termination\":null}\n",
        )).unwrap();
        assert_eq!(
            recent_diagnostics(&scratch.0).unwrap(),
            concat!(
                "Showing recent safe records. Older or invalid records were omitted.\n\n",
                "{\"time\":1,\"level\":30,\"event\":\"compat_ready\"}\n",
                "{\"time\":4,\"level\":50,\"event\":\"compat_failure\",\"reason\":\"child_exit\",\"termination\":{\"kind\":\"signal\",\"value\":9}}\n",
            )
        );
    }

    #[test]
    fn ticket_t_2_log_view_bounds_history_and_drops_partial_oversized_rows() {
        let scratch = Scratch::new();
        let mut file = File::create(scratch.0.join("logs/desktop.jsonl")).unwrap();
        file.write_all(&vec![b'x'; 70 * 1024]).unwrap();
        file.write_all(b"\n").unwrap();
        for time in 1..=110 {
            writeln!(
                file,
                "{{\"time\":{time},\"level\":30,\"event\":\"compat_ready\"}}"
            )
            .unwrap();
        }
        file.write_all(b"SECRET_PARTIAL").unwrap();
        let text = recent_diagnostics(&scratch.0).unwrap();
        let rows: Vec<serde_json::Value> = text
            .lines()
            .filter(|row| row.starts_with('{'))
            .map(|row| serde_json::from_str(row).unwrap())
            .collect();
        assert_eq!(rows.len(), 100);
        assert_eq!(rows[0]["time"], 11);
        assert_eq!(rows[99]["time"], 110);
        assert!(!text.contains("SECRET_PARTIAL"));
        assert!(text.len() < 20 * 1024);
    }

    #[test]
    fn ticket_t_2_log_view_rejects_symlinks_and_reads_rotation_chronologically() {
        let scratch = Scratch::new();
        let outside = scratch.0.join("outside");
        std::fs::write(&outside, "{\"time\":1,\"level\":30,\"event\":\"compat_output\",\"message\":\"SECRET_SYMLINK\"}\n").unwrap();
        std::os::unix::fs::symlink(&outside, scratch.0.join("logs/desktop.6.jsonl")).unwrap();
        std::fs::write(
            scratch.0.join("logs/desktop.1.jsonl"),
            "{\"time\":2,\"level\":30,\"event\":\"compat_starting\"}\n",
        )
        .unwrap();
        std::fs::write(
            scratch.0.join("logs/desktop.jsonl"),
            "{\"time\":3,\"level\":30,\"event\":\"compat_ready\"}\n",
        )
        .unwrap();
        let text = recent_diagnostics(&scratch.0).unwrap();
        assert_eq!(
            text,
            concat!(
                "Showing recent safe records. Older or invalid records were omitted.\n\n",
                "{\"time\":2,\"level\":30,\"event\":\"compat_starting\"}\n",
                "{\"time\":3,\"level\":30,\"event\":\"compat_ready\"}\n",
            )
        );
        let linked = scratch.0.join("linked-data");
        std::fs::create_dir(&linked).unwrap();
        std::os::unix::fs::symlink(scratch.0.join("logs"), linked.join("logs")).unwrap();
        assert_eq!(
            recent_diagnostics(&linked).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
    }

    #[tokio::test]
    async fn ticket_t_2_capture_redacts_secrets_even_without_a_final_newline() {
        let scratch = Scratch::new();
        let logs = Logs::open(scratch.0.join("logs")).unwrap();
        logs.capture(
            &b"{\"level\":50,\"event\":\"desktop_start_failed\",\"message\":\"SECRET_TOKEN\"}"[..],
        )
        .await;
        let text = recent_diagnostics(&scratch.0).unwrap();
        let row: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(row["event"], "compat_start_failed");
        assert_eq!(row["level"], 50);
        assert_eq!(row.as_object().unwrap().len(), 3);
        assert!(!text.contains("SECRET_TOKEN"));
    }

    #[test]
    fn gre_696_racing_first_log_opens_share_one_file() {
        let scratch = Scratch::new();
        let path = scratch.0.join("logs/desktop.jsonl");
        let directory = File::open(scratch.0.join("logs")).unwrap();
        let threads = 8;
        for trial in 0..200 {
            let barrier = std::sync::Barrier::new(threads);
            let opened: Vec<_> = std::thread::scope(|scope| {
                let handles: Vec<_> = (0..threads)
                    .map(|_| {
                        scope.spawn(|| {
                            barrier.wait();
                            open_log(&directory)
                                .map(|file| file.metadata().unwrap().ino())
                                .map_err(|error| error.to_string())
                        })
                    })
                    .collect();
                handles.into_iter().map(|h| h.join().unwrap()).collect()
            });
            let inode = std::fs::symlink_metadata(&path).unwrap().ino();
            assert!(
                opened.iter().all(|result| result == &Ok(inode)),
                "trial {trial}: {opened:?}"
            );
            std::fs::remove_file(&path).unwrap();
        }
    }
}
