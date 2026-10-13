use pp_storage::{
    Limits, Setting, SettingCommand, SettingSnapshot, WriterOwner,
    lease::{StorageLease, record_child},
};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

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
        let output = Command::new(&path)
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

fn read_event_line<R: BufRead + Send + 'static>(mut stdout: R) -> (String, R) {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let result = stdout.read_line(&mut line);
        let _ = tx.send((result.map(|_| ()), line, stdout));
    });
    let (result, line, stdout) = rx
        .recv_timeout(Duration::from_secs(30))
        .expect("node probe event timed out");
    result.expect("node probe stdout");
    (line, stdout)
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
    let mut child = Command::new(bin)
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
    let mut child = Command::new(bin)
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
        let node_child = Command::new(&node)
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

const NODE_PROBE: &str = r#"
import { readFileSync, writeSync } from "node:fs";
import Database from "better-sqlite3";
import { SqliteDatabase } from CLIENT_SPECIFIER;

const mode = process.argv[2];
const dataDir = process.argv[3];
const dbPath = dataDir + "/print-partner.db";

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\n");
}

function fingerprint() {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const versionRow = db.prepare(
      "SELECT value FROM app_settings WHERE tenant_id = 'default' AND key = 'schema_version'",
    ).get();
    const sequences = db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all();
    const counts = {
      printer_profiles: db.prepare("SELECT COUNT(*) AS n FROM printer_profiles").get().n,
      process_profiles: db.prepare("SELECT COUNT(*) AS n FROM process_profiles").get().n,
      filament_profiles: db.prepare("SELECT COUNT(*) AS n FROM filament_profiles").get().n,
    };
    return {
      version: versionRow && typeof versionRow.value === "string" ? versionRow.value : null,
      sequences,
      counts,
    };
  } finally {
    db.close();
  }
}

if (mode === "child" || mode === "bootstrap" || mode === "orphan") {
  emit({ event: "ready", pid: process.pid });
  readFileSync(0);
}

if (mode === "unsupported") {
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const changed = db.prepare(
      "UPDATE app_settings SET value = '33' WHERE tenant_id = 'default' AND key = 'schema_version'",
    ).run();
    if (changed.changes !== 1) {
      throw new Error("schema stamp update changed " + changed.changes + " rows");
    }
  } catch (error) {
    emit({ event: "setup-failed", message: error instanceof Error ? error.message : String(error) });
    process.exit(3);
  } finally {
    db.close();
  }
}

const before = mode === "bootstrap" ? null : fingerprint();
const database = new SqliteDatabase(dataDir);
try {
  database.connect();
  const after = fingerprint();
  database.close();
  emit({ event: "connected", before, after });
} catch (error) {
  let after = null;
  try { after = fingerprint(); } catch { after = null; }
  emit({
    event: "refused",
    message: error instanceof Error ? error.message : String(error),
    before,
    after,
  });
  process.exitCode = 2;
}
"#;

fn web_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../web")
}

fn server_node(web: &Path) -> PathBuf {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("PP_SCHEMA_PARITY_NODE") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(path) = std::env::var("PP_PRODUCTION_NODE") {
        candidates.push(PathBuf::from(path));
    }
    candidates.push(PathBuf::from(
        "/var/lib/agent-fleet-runtime-owner/runtime-root/releases/node-project-22.23.3-bb2b080fb03ea1f2/bin/node",
    ));
    candidates.push(PathBuf::from(
        "/opt/agent-fleet/artifacts/.local/share/mise/installs/node/24.21.0/bin/node",
    ));
    candidates.push(PathBuf::from("node"));
    let mut errors = Vec::new();
    for candidate in candidates {
        let output = Command::new(&candidate)
            .args([
                "--input-type=module",
                "-e",
                "import Database from 'better-sqlite3'; if (typeof Database !== 'function') process.exit(1);",
            ])
            .current_dir(web)
            .env("NODE_PATH", web.join("node_modules"))
            .output();
        match output {
            Ok(output) if output.status.success() => return candidate,
            Ok(output) => errors.push(format!(
                "{}: {}",
                candidate.display(),
                String::from_utf8_lossy(&output.stderr)
            )),
            Err(error) => errors.push(format!("{}: {error}", candidate.display())),
        }
    }
    panic!(
        "no Node can load better-sqlite3 from {}: {}",
        web.display(),
        errors.join(" | ")
    );
}

fn write_probe(web: &Path) -> PathBuf {
    let probe_dir = temp_dir("node-probe");
    std::os::unix::fs::symlink(web.join("node_modules"), probe_dir.join("node_modules")).unwrap();
    let probe = probe_dir.join("probe.mts");
    let client = serde_json::to_string(&web.join("apps/server/src/db/client.ts")).unwrap();
    std::fs::write(&probe, NODE_PROBE.replace("CLIENT_SPECIFIER", &client)).unwrap();
    probe
}

fn remove_probe(probe: &Path) {
    let dir = probe.parent().unwrap();
    std::fs::remove_file(probe).unwrap();
    std::fs::remove_file(dir.join("node_modules")).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

fn parse_event(line: &str, stderr: &str) -> serde_json::Value {
    let line = line.trim();
    serde_json::from_str(line).unwrap_or_else(|error| {
        panic!("node probe did not return an event ({error}): {line}\n{stderr}")
    })
}

fn run_node_probe(
    mode: &str,
    dir: &Path,
    web: &Path,
    node: &Path,
    probe: &Path,
) -> serde_json::Value {
    let tsx = web.join("node_modules/tsx/dist/cli.mjs");
    let mut child = Command::new(node)
        .arg(&tsx)
        .arg(probe)
        .arg(mode)
        .arg(dir)
        .current_dir(web)
        .env("NODE_PATH", web.join("node_modules"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stderr_thread = thread::spawn(move || {
        let mut buffer = String::new();
        let mut stderr = stderr;
        stderr.read_to_string(&mut buffer).unwrap();
        buffer
    });
    let mut process = StopProcess(Some(child));
    let mut stdin = process.0.as_mut().unwrap().stdin.take().unwrap();
    let (first, stdout) = read_event_line(BufReader::new(stdout));
    if first.is_empty() {
        let status = process.0.as_mut().unwrap().wait().unwrap();
        process.0.take();
        let stderr = stderr_thread.join().unwrap();
        panic!("node probe exited {status} before an event:\n{stderr}");
    }
    let event_line = if mode == "child" || mode == "bootstrap" || mode == "orphan" {
        let ready = parse_event(&first, "");
        assert_eq!(ready["event"], "ready", "{ready}");
        let pid = u32::try_from(ready["pid"].as_u64().unwrap()).unwrap();
        if mode == "orphan" {
            write_orphan_marker(dir, pid, &linux_process_identity(pid));
        } else {
            record_child(dir, pid).unwrap();
        }
        writeln!(stdin, "go").unwrap();
        drop(stdin);
        let (line, _) = read_event_line(stdout);
        line
    } else {
        drop(stdin);
        first
    };
    let status = process.0.as_mut().unwrap().wait().unwrap();
    process.0.take();
    let stderr = stderr_thread.join().unwrap();
    let event = parse_event(&event_line, &stderr);
    if event["event"] == "connected" {
        assert!(status.success(), "{status} {event} {stderr}");
    } else if event["event"] == "refused" {
        assert_eq!(status.code(), Some(2), "{status} {event} {stderr}");
    }
    event
}

fn assert_stable_fingerprint(event: &serde_json::Value) {
    assert_eq!(event["before"], event["after"], "{event}");
    let names: Vec<&str> = event["before"]["sequences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    for name in ["printer_profiles", "process_profiles", "filament_profiles"] {
        assert!(names.contains(&name), "{names:?}");
    }
}

fn linux_process_identity(pid: u32) -> String {
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap();
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let start = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .nth(19)
        .unwrap();
    format!("{}:{start}", boot.trim())
}

fn exited_pid() -> u32 {
    let mut child = Command::new("sh").arg("-c").arg("exit 0").spawn().unwrap();
    let pid = child.id();
    let status = child.wait().unwrap();
    assert!(status.success());
    pid
}

fn write_orphan_marker(dir: &Path, child_pid: u32, child_identity: &str) {
    let marker = serde_json::json!({
        "storage_protocol_version": 1,
        "pid": exited_pid(),
        "process_identity": "prior",
        "child_pid": child_pid,
        "child_process_identity": child_identity,
    });
    std::fs::write(dir.join(".desktop-owner.json"), marker.to_string()).unwrap();
}

fn release_database(dir: &Path, owner: WriterOwner) {
    let runtime = std::fs::read(dir.join(".desktop-owner.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|marker| marker["runtime_dir"].as_str().map(PathBuf::from));
    owner.shutdown().unwrap();
    if let Some(runtime) = runtime {
        let _ = std::fs::remove_dir_all(runtime);
    }
    assert!(dir.join("print-partner.db").exists());
    assert!(!dir.join(".desktop-owner.json").exists());
}

fn sequence_of(event: &serde_json::Value, side: &str, name: &str) -> i64 {
    event[side]["sequences"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == name)
        .unwrap()["seq"]
        .as_i64()
        .unwrap()
}

fn release_owner(dir: &Path, owner: WriterOwner) {
    let runtime = std::fs::read(dir.join(".desktop-owner.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|marker| marker["runtime_dir"].as_str().map(PathBuf::from));
    owner.shutdown().unwrap();
    if let Some(runtime) = runtime {
        let _ = std::fs::remove_dir_all(runtime);
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn ticket_t_7_writer_node_refuses_migration_and_writes_on_a_rust_owned_copy() {
    let web = web_root();
    let node = server_node(&web);
    let probe = write_probe(&web);
    let dir = temp_dir("node-foreign");
    let (owner, _) = WriterOwner::open(&dir, Limits::default()).unwrap();
    let event = run_node_probe("foreign", &dir, &web, &node, &probe);
    assert_eq!(event["event"], "refused", "{event}");
    assert!(
        event["message"]
            .as_str()
            .unwrap()
            .contains("will not migrate or write"),
        "{event}"
    );
    assert_eq!(event["before"]["version"], "34", "{event}");
    assert_stable_fingerprint(&event);
    owner.shutdown().unwrap();
    let reopened = run_node_probe("unsupported", &dir, &web, &node, &probe);
    assert_eq!(reopened["event"], "connected", "{reopened}");
    assert_eq!(reopened["before"]["version"], "33", "{reopened}");
    assert_eq!(reopened["after"]["version"], "34", "{reopened}");
    std::fs::remove_dir_all(&dir).unwrap();
    remove_probe(&probe);
}

#[test]
fn ticket_t_7_writer_node_refuses_to_upgrade_an_unsupported_rust_owned_schema() {
    let web = web_root();
    let node = server_node(&web);
    let probe = write_probe(&web);
    let dir = temp_dir("node-unsupported");
    let (owner, _) = WriterOwner::open(&dir, Limits::default()).unwrap();
    let event = run_node_probe("unsupported", &dir, &web, &node, &probe);
    assert_eq!(event["event"], "refused", "{event}");
    assert!(
        event["message"]
            .as_str()
            .unwrap()
            .contains("not the supported schema"),
        "{event}"
    );
    assert_eq!(event["before"]["version"], "33", "{event}");
    assert_eq!(event["after"]["version"], "33", "{event}");
    assert_stable_fingerprint(&event);
    release_owner(&dir, owner);
    remove_probe(&probe);
}

#[test]
fn ticket_t_7_writer_node_child_asserts_schema_without_migrating() {
    let web = web_root();
    let node = server_node(&web);
    let probe = write_probe(&web);
    let dir = temp_dir("node-child");
    let (owner, _) = WriterOwner::open(&dir, Limits::default()).unwrap();
    let event = run_node_probe("child", &dir, &web, &node, &probe);
    assert_eq!(event["event"], "connected", "{event}");
    assert_eq!(event["before"]["version"], "34", "{event}");
    assert_stable_fingerprint(&event);
    release_owner(&dir, owner);
    remove_probe(&probe);
}

#[test]
fn ticket_t_7_writer_node_child_bootstraps_a_lease_without_a_database() {
    let web = web_root();
    let node = server_node(&web);
    let probe = write_probe(&web);
    let dir = temp_dir("node-bootstrap");
    let lease = StorageLease::acquire(&dir).unwrap();
    assert!(!dir.join("print-partner.db").exists());
    let event = run_node_probe("bootstrap", &dir, &web, &node, &probe);
    assert_eq!(event["event"], "connected", "{event}");
    assert!(event["before"].is_null(), "{event}");
    assert_eq!(event["after"]["version"], "34", "{event}");
    let names: Vec<&str> = event["after"]["sequences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    for name in ["printer_profiles", "process_profiles", "filament_profiles"] {
        assert!(names.contains(&name), "{event}");
    }
    lease.release();
    std::fs::remove_dir_all(&dir).unwrap();
    remove_probe(&probe);
}

#[test]
fn ticket_t_7_writer_node_live_child_keeps_a_dead_owner_exclusive() {
    let web = web_root();
    let node = server_node(&web);
    let probe = write_probe(&web);
    let dir = temp_dir("node-orphan");
    let (owner, _) = WriterOwner::open(&dir, Limits::default()).unwrap();
    release_database(&dir, owner);
    let event = run_node_probe("orphan", &dir, &web, &node, &probe);
    assert_eq!(event["event"], "connected", "{event}");
    assert_eq!(event["before"]["version"], "34", "{event}");
    assert_stable_fingerprint(&event);

    let mut sleeper = StopProcess(Some(Command::new("sleep").arg("120").spawn().unwrap()));
    let child_pid = sleeper.0.as_ref().unwrap().id();
    write_orphan_marker(&dir, child_pid, &linux_process_identity(child_pid));
    let refused = run_node_probe("foreign", &dir, &web, &node, &probe);
    assert_eq!(refused["event"], "refused", "{refused}");
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .contains("will not migrate or write"),
        "{refused}"
    );
    assert_stable_fingerprint(&refused);
    let mut held = sleeper.0.take().unwrap();
    let _ = held.kill();
    let _ = held.wait();
    let reopened = run_node_probe("foreign", &dir, &web, &node, &probe);
    assert_eq!(reopened["event"], "connected", "{reopened}");
    assert!(
        sequence_of(&reopened, "after", "printer_profiles")
            > sequence_of(&reopened, "before", "printer_profiles"),
        "{reopened}"
    );
    std::fs::remove_dir_all(&dir).unwrap();
    remove_probe(&probe);
}
