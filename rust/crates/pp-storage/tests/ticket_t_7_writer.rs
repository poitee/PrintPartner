use pp_storage::{
    Limits, Setting, SettingCommand, SettingSnapshot, WriterOwner, lease::record_child,
};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

#[path = "common/process.rs"]
mod child_process;

struct StopProcess(Option<Child>);

impl Drop for StopProcess {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("pp-t7-{name}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn json_string(bytes: &[u8], field: &str) -> String {
    let text = std::str::from_utf8(bytes).unwrap();
    let needle = format!("\"{field}\":\"");
    let start = text
        .find(&needle)
        .unwrap_or_else(|| panic!("missing {field}"))
        + needle.len();
    let end = text[start..].find('"').unwrap();
    text[start..start + end].to_string()
}

fn production_node() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("PP_PRODUCTION_NODE") {
        candidates.push(PathBuf::from(path));
    }
    candidates.push(PathBuf::from(
        "/opt/agent-fleet/artifacts/.local/share/mise/installs/node/24.21.0/bin/node",
    ));
    for path in candidates {
        if !path.is_file() {
            continue;
        }
        let mut file = std::fs::File::open(&path).unwrap();
        let mut magic = [0u8; 4];
        std::io::Read::read_exact(&mut file, &mut magic).unwrap();
        assert_eq!(magic, *b"\x7fELF", "{}", path.display());
        let output = child_process::command(&path)
            .arg("-p")
            .arg("process.version + ' ' + process.versions.modules + ' ' + process.execPath")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        let mut parts = text.split_whitespace();
        assert_eq!(parts.next().unwrap(), "v24.21.0");
        assert_eq!(parts.next().unwrap(), "137");
        let exec_path = PathBuf::from(parts.next().unwrap());
        assert_eq!(
            exec_path.canonicalize().unwrap(),
            path.canonicalize().unwrap()
        );
        return Some(path);
    }
    None
}

fn read_ready<R: BufRead + Send + 'static>(mut stdout: R) -> (String, R) {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let result = stdout.read_line(&mut line);
        let _ = tx.send((result.map(|_| ()), line, stdout));
    });
    let (result, line, stdout) = rx
        .recv_timeout(Duration::from_secs(30))
        .expect("storage-fixture ready timed out");
    result.expect("storage-fixture stdout");
    assert!(!line.is_empty(), "storage-fixture exited before ready");
    (line, stdout)
}

fn snapshot(dir: &Path, tenant: &str, key: &str) -> SettingSnapshot {
    let (owner, _) = WriterOwner::open(dir, Limits::default()).unwrap();
    let read = owner.client().reader(Duration::ZERO).unwrap();
    let value = read.snapshot(tenant, key).unwrap();
    drop(read);
    owner.shutdown().unwrap();
    value
}

#[test]
fn ticket_t_7_writer_reopens_after_clean_process_exit() {
    let dir = temp_dir("clean");
    let bin = env!("CARGO_BIN_EXE_storage-fixture");
    let mut child = child_process::command(bin)
        .args([
            "settings",
            dir.to_str().unwrap(),
            "2026-10-02T00:00:00.000Z",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut process = StopProcess(Some(child));
    let (ready, _) = read_ready(BufReader::new(stdout));
    assert!(ready.contains("\"version\""), "{ready}");
    let status = process.0.as_mut().unwrap().wait().unwrap();
    assert!(status.success(), "{status}");
    process.0.take();
    assert_eq!(
        snapshot(&dir, "tenant-a", "discord_notify_on_update"),
        SettingSnapshot::Stored { value: "1".into() }
    );
    assert_eq!(
        snapshot(&dir, "tenant-b", "discord_notify_on_update"),
        SettingSnapshot::Stored { value: "0".into() }
    );
    assert_eq!(
        snapshot(&dir, "tenant-a", "discord_notify_on_sync"),
        SettingSnapshot::Stored { value: "1".into() }
    );
    let _ = std::fs::remove_file(dir.with_extension("backup.db"));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn ticket_t_7_writer_survives_kill_and_live_node_child() {
    let dir = temp_dir("kill");
    let bin = env!("CARGO_BIN_EXE_storage-fixture");
    let mut child = child_process::command(bin)
        .args(["hold", dir.to_str().unwrap(), "2026-10-02T00:00:00.000Z"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut owner_process = StopProcess(Some(child));
    let (ready, stdout) = read_ready(BufReader::new(stdout));
    assert!(ready.starts_with('{'), "{ready}");
    let live = match WriterOwner::open(&dir, Limits::default()) {
        Ok(_) => panic!("second runtime opened the held directory"),
        Err(error) => error.to_string(),
    };
    assert!(live.contains("Data directory already owned"), "{live}");
    let marker_before = std::fs::read(dir.join(".desktop-owner.json")).unwrap();
    let runtime = PathBuf::from(json_string(&marker_before, "runtime_dir"));
    let node = production_node();
    let mut node_process = None;
    if let Some(node) = node {
        let node_child = child_process::command(&node)
            .arg("-e")
            .arg("setInterval(() => {}, 1000000)")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = node_child.id();
        node_process = Some(StopProcess(Some(node_child)));
        let denied = record_child(&dir, pid).unwrap_err().to_string();
        assert!(denied.contains("belongs to another process"), "{denied}");
        assert_eq!(
            std::fs::read(dir.join(".desktop-owner.json")).unwrap(),
            marker_before
        );
        writeln!(
            owner_process.0.as_mut().unwrap().stdin.as_mut().unwrap(),
            "{}",
            serde_json::json!({"command": "record-child", "pid": pid})
        )
        .unwrap();
        let (recorded, _) = read_ready(stdout);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&recorded).unwrap(),
            serde_json::json!({"child_pid": pid})
        );
    }
    owner_process.0.as_mut().unwrap().kill().unwrap();
    let killed = owner_process.0.as_mut().unwrap().wait().unwrap();
    assert!(!killed.success(), "{killed}");
    owner_process.0.take();
    if let Some(node) = node_process.as_mut() {
        let marker_with_child = std::fs::read(dir.join(".desktop-owner.json")).unwrap();
        let denied = match WriterOwner::open(&dir, Limits::default()) {
            Ok((owner, _)) => {
                drop(owner);
                panic!("opened storage while the recorded node child was alive");
            }
            Err(error) => error.to_string(),
        };
        assert!(denied.contains("Data directory already owned"), "{denied}");
        assert_eq!(
            std::fs::read(dir.join(".desktop-owner.json")).unwrap(),
            marker_with_child
        );
        node.0.as_mut().unwrap().kill().unwrap();
        node.0.as_mut().unwrap().wait().unwrap();
        node.0.take();
    }
    assert_eq!(
        snapshot(&dir, "tenant-a", "discord_notify_on_update"),
        SettingSnapshot::Stored { value: "1".into() }
    );
    assert_eq!(
        snapshot(&dir, "tenant-a", "discord_notify_on_sync"),
        SettingSnapshot::Stored { value: "1".into() }
    );
    let (owner, _) = WriterOwner::open(&dir, Limits::default()).unwrap();
    let client = owner.client();
    client
        .submit(
            SettingCommand::Set(Setting {
                tenant: "tenant-a".into(),
                key: "after-restart".into(),
                value: "written".into(),
            }),
            &std::sync::atomic::AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    owner.shutdown().unwrap();
    assert_eq!(
        snapshot(&dir, "tenant-a", "after-restart"),
        SettingSnapshot::Stored {
            value: "written".into()
        }
    );
    std::fs::remove_dir_all(&dir).unwrap();
    let _ = std::fs::remove_dir_all(runtime);
}
