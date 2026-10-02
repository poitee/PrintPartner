use std::{
    fs::{File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncBufReadExt, BufReader};

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
    pub(crate) fn event(&self, event: &'static str, level: u64) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let Ok(mut log) = self.0.lock() else { return };
        let row = format!(
            "{}\n",
            serde_json::json!({"time":now,"event":event,"level":level})
        );
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
                return;
            }
            for byte in bytes {
                if *byte == b'\n' {
                    let value: serde_json::Value =
                        serde_json::from_slice(&line).unwrap_or(serde_json::Value::Null);
                    let level = value["level"]
                        .as_u64()
                        .filter(|n| [10, 20, 30, 40, 50, 60].contains(n))
                        .unwrap_or(30);
                    let event = match value["event"].as_str() {
                        Some("desktop_start_failed") => "compat_start_failed",
                        _ => "compat_output",
                    };
                    self.event(event, level);
                    line.clear();
                } else if line.len() < 8192 {
                    line.push(*byte);
                }
            }
            let consumed = bytes.len();
            reader.consume(consumed);
        }
    }
}
