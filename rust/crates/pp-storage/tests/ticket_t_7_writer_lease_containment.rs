use pp_storage::lease::StorageLease;
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Stdio},
    sync::mpsc::{Receiver, RecvTimeoutError},
    time::{Duration, Instant},
};

#[path = "common/process.rs"]
mod child_process;

const ROLE: &str = "PP_LEASE_CONTAINMENT_ROLE";
const AMBIGUOUS: &str =
    "Storage lease namespace ownership is ambiguous; ownership retained until process exit";
type Snapshot = Vec<(PathBuf, u64, u64, Vec<u8>)>;

fn snapshot(root: &Path) -> Snapshot {
    fn visit(root: &Path, path: &Path, entries: &mut Snapshot) {
        let metadata = std::fs::symlink_metadata(path).unwrap();
        entries.push((
            path.strip_prefix(root).unwrap().to_path_buf(),
            metadata.dev(),
            metadata.ino(),
            if metadata.is_file() {
                std::fs::read(path).unwrap()
            } else {
                Vec::new()
            },
        ));
        if metadata.is_dir() {
            let mut children: Vec<_> = std::fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            children.sort();
            for child in children {
                visit(root, &child, entries);
            }
        }
    }
    let mut entries = Vec::new();
    visit(root, root, &mut entries);
    entries
}

fn unchanged(root: &Path, expected: &Snapshot, operation: &str) {
    let actual = snapshot(root);
    println!(
        "snapshot {operation} {}",
        serde_json::to_string(&actual).unwrap()
    );
    assert_eq!(&actual, expected, "namespace changed after {operation}");
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-lease-containment-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

struct Process {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    deadline: Instant,
}
impl Process {
    fn spawn(mut child: Child, deadline: Instant) -> Self {
        println!("spawned {}", child.id());
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let (sender, lines) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in stdout.lines() {
                if sender.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin,
            lines,
            deadline,
        }
    }
    fn rust(role: &str, root: &Path) -> Self {
        let deadline = Instant::now() + Duration::from_secs(120);
        let child = child_process::command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ticket_t_7_writer_containment_subprocess",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(ROLE, role)
            .env("PP_LEASE_CONTAINMENT_PATH", root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        Self::spawn(child, deadline)
    }
    fn next_line(&self) -> Result<String, RecvTimeoutError> {
        let now = Instant::now();
        if now >= self.deadline {
            return Err(RecvTimeoutError::Timeout);
        }
        let line = self.lines.recv_timeout(self.deadline.duration_since(now));
        if Instant::now() >= self.deadline {
            return Err(RecvTimeoutError::Timeout);
        }
        line
    }
    fn expect(&mut self, suffix: &str) {
        loop {
            let line = self.next_line().unwrap_or_else(|error| {
                panic!("child {} never reported {suffix}: {error}", self.child.id())
            });
            println!("child {} {line}", self.child.id());
            if line.ends_with(suffix) {
                break;
            }
        }
    }
    fn send(&mut self, line: &str) {
        writeln!(self.stdin.as_mut().unwrap(), "{line}").unwrap();
        self.stdin.as_mut().unwrap().flush().unwrap();
    }
    fn live(&mut self) {
        assert!(self.child.try_wait().unwrap().is_none());
        assert_eq!(unsafe { libc::kill(self.child.id() as i32, 0) }, 0);
    }
    fn reap(mut self, rust_test: bool) {
        drop(self.stdin.take());
        let mut test_completed = false;
        loop {
            match self.next_line() {
                Ok(line) => {
                    println!("child {} {line}", self.child.id());
                    test_completed |= line.starts_with("test result: ok. 1 passed; 0 failed;");
                }
                Err(RecvTimeoutError::Disconnected) => break,
                Err(error) => panic!("child {} stdout: {error}", self.child.id()),
            }
        }
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "child {} exited {status}",
                    self.child.id()
                );
                assert!(
                    !rust_test || test_completed,
                    "helper scenario did not complete"
                );
                println!("reaped {}", self.child.id());
                break;
            }
            assert!(Instant::now() < self.deadline, "child did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn node(root: &Path) -> Process {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let actual_source = repository.join("web/apps/server/src/storage-lease.ts");
    let source = std::env::var_os("PP_CONTAINMENT_NODE_SOURCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| actual_source.clone());
    let hash = Sha256::digest(std::fs::read(&actual_source).unwrap());
    assert_eq!(
        Sha256::digest(std::fs::read(&source).unwrap()),
        hash,
        "Node fixture must execute unchanged production source"
    );
    let node = std::env::var_os("PP_TEST_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"));
    println!("Node source sha256 {}", hex::encode(hash));
    let deadline = Instant::now() + Duration::from_secs(120);
    let child = child_process::command(node)
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lease-containment.mjs"))
        .arg(source)
        .arg(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    Process::spawn(child, deadline)
}

fn scenario(relocate: bool, automatic_drop: bool) {
    let fixture = Fixture::new();
    let root = &fixture.0;
    let role = format!(
        "owner:{}:{}",
        if relocate { "relocated" } else { "removed" },
        automatic_drop
    );
    let mut old = Process::rust(&role, root);
    old.expect("containment retained");
    let original = snapshot(root);
    let mut successor = node(root);
    let ready = successor.next_line().expect("Node publication handshake");
    println!("Node {ready}");
    assert!(ready.starts_with(&format!("containment ready {} ", successor.child.id())));
    successor.live();
    let owner: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join(".desktop-lease/owner.json")).unwrap())
            .unwrap();
    assert_eq!(owner["pid"], successor.child.id());
    let published = snapshot(root);
    assert_eq!(published.len(), original.len() + 2);
    let preserved: Snapshot = published
        .iter()
        .filter(|(path, _, _, _)| !path.starts_with(".desktop-lease"))
        .cloned()
        .collect();
    assert_eq!(
        preserved, original,
        "Node publication changed the original resources"
    );
    for operation in 0..5 {
        successor.send("ping");
        successor.expect(&format!("containment alive {}", successor.child.id()));
        successor.live();
        unchanged(root, &published, "Node handshake");
        old.send("retry");
        old.expect("containment retry refused");
        successor.live();
        unchanged(root, &published, &format!("Rust retry {operation}"));
    }
    let mut contender = Process::rust("contender", root);
    contender.expect("containment contender refused");
    contender.reap(true);
    successor.live();
    unchanged(
        root,
        &published,
        "separate Rust contender before owner exit",
    );
    old.send("retry");
    old.expect("containment retry refused");
    successor.live();
    unchanged(root, &published, "final Rust retry");
    old.reap(true);
    unchanged(root, &published, "old owner exit");
    successor.send("ping");
    successor.expect(&format!("containment alive {}", successor.child.id()));
    successor.live();
    let mut contender = Process::rust("contender", root);
    contender.expect("containment contender refused");
    contender.reap(true);
    unchanged(root, &published, "separate Rust contender after owner exit");
    assert!(!std::fs::read_dir(root).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".desktop-lease-release-")
    }));
    successor.reap(false);
    unchanged(root, &preserved, "Node orderly release");
}

#[test]
fn ticket_t_7_writer_removed_lease_preserves_live_node_through_retries_drop_and_exit() {
    for automatic_drop in [false, true] {
        scenario(false, automatic_drop);
    }
}
#[test]
fn ticket_t_7_writer_relocated_lease_preserves_live_node_through_retries_drop_and_exit() {
    for automatic_drop in [false, true] {
        scenario(true, automatic_drop);
    }
}
#[test]
fn ticket_t_7_writer_containment_subprocess() {
    let Ok(role) = std::env::var(ROLE) else {
        return;
    };
    let path = PathBuf::from(std::env::var_os("PP_LEASE_CONTAINMENT_PATH").unwrap());
    if role == "contender" {
        let before = snapshot(&path);
        let error = StorageLease::acquire(&path)
            .err()
            .expect("Rust admitted while Node lives");
        assert_eq!(error.to_string(), "Data directory already owned");
        unchanged(&path, &before, "contender refusal");
        println!("containment contender refused");
        return;
    }
    let parts: Vec<_> = role.split(':').collect();
    assert_eq!(parts.len(), 3);
    let owner = StorageLease::acquire(&path).unwrap();
    let original = snapshot(&path.join(".desktop-lease"));
    if parts[1] == "relocated" {
        std::fs::rename(path.join(".desktop-lease"), path.join("original-lease")).unwrap();
    } else {
        assert_eq!(parts[1], "removed");
        std::fs::remove_dir_all(path.join(".desktop-lease")).unwrap();
    }
    if parts[2] == "true" {
        drop(owner);
    } else {
        let release = owner.release();
        assert_eq!(
            (
                release.marker_removed,
                release.runtime_removed,
                release.lock_released,
                release.ownership_retained
            ),
            (true, true, false, true)
        );
    }
    if parts[1] == "relocated" {
        unchanged(
            &path.join("original-lease"),
            &original,
            "initial ambiguous release or Drop",
        );
    }
    println!("containment retained");
    for command in std::io::stdin().lock().lines() {
        let before = snapshot(&path);
        match command.unwrap().as_str() {
            "retry" => {
                assert_eq!(
                    StorageLease::retry_failed_release(&path)
                        .err()
                        .expect("terminal retry ran release stages")
                        .to_string(),
                    AMBIGUOUS
                );
                unchanged(&path, &before, "terminal retry");
                println!("containment retry refused");
            }
            other => panic!("unknown command {other}"),
        }
    }
}
