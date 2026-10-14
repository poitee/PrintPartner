use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::OpenOptionsExt,
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
    directory: PathBuf,
    file: File,
    day: u64,
    bytes: u64,
}

impl Logs {
    pub(crate) fn open(directory: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&directory)?;
        let path = directory.join("desktop.jsonl");
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(path)?;
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
                for index in (1..=6).rev() {
                    let source = if index == 1 {
                        log.directory.join("desktop.jsonl")
                    } else {
                        log.directory.join(format!("desktop.{}.jsonl", index - 1))
                    };
                    let target = log.directory.join(format!("desktop.{index}.jsonl"));
                    if source.exists() {
                        std::fs::rename(source, target)?;
                    }
                }
                log.file = OpenOptions::new()
                    .append(true)
                    .create(true)
                    .mode(0o600)
                    .open(log.directory.join("desktop.jsonl"))?;
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
}
