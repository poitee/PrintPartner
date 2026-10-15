use fs2::FileExt;
use pp_storage::lease::{LeaseRelease, StorageLease};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

#[path = "common/process.rs"]
mod child_process;

const OWNER_PROBE: &str = "PP_T7_EXTERNAL_LEASE_OWNER";
const STEP: &str = "external lease owner: ";
const RETAINED: (bool, bool, bool, bool) = (true, true, false, true);
const RELEASED: (bool, bool, bool, bool) = (true, true, true, false);

#[derive(Clone, Copy)]
enum External {
    Removed,
    Relocated,
}

impl External {
    fn parse(name: &str) -> Self {
        match name {
            "removed" => Self::Removed,
            "relocated" => Self::Relocated,
            other => panic!("unknown scenario {other}"),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Removed => "removed",
            Self::Relocated => "relocated",
        }
    }
}

fn flags(release: LeaseRelease) -> (bool, bool, bool, bool) {
    (
        release.marker_removed,
        release.runtime_removed,
        release.lock_released,
        release.ownership_retained,
    )
}

fn names(path: &Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-t7-external-lease-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::DirBuilder::new()
            .recursive(true)
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

struct Owner {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    deadline: Instant,
}

impl Owner {
    fn spawn(external: External, path: &Path) -> Self {
        let mut child = child_process::command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ticket_t_7_writer_external_lease_owner_subprocess",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(
                OWNER_PROBE,
                format!("{}:{}", external.name(), path.display()),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let (sender, lines) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in stdout.lines() {
                if sender.send(line.unwrap()).is_err() {
                    return;
                }
            }
        });
        Self {
            child,
            stdin,
            lines,
            deadline: Instant::now() + Duration::from_secs(120),
        }
    }

    fn next_line(&self) -> Result<String, RecvTimeoutError> {
        self.lines
            .recv_timeout(self.deadline.saturating_duration_since(Instant::now()))
    }

    /// libtest prints `test <name> ... ` without a newline before the body runs.
    fn expect(&mut self, wanted: &str) {
        let marker = format!("{STEP}{wanted}");
        while !self
            .next_line()
            .unwrap_or_else(|error| panic!("owner never reported {wanted}: {error}"))
            .ends_with(&marker)
        {}
    }

    fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    fn reap(mut self) {
        drop(self.stdin.take());
        let mut rest = Vec::new();
        loop {
            match self.next_line() {
                Ok(line) => rest.push(line),
                Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => panic!("owner kept stdout open\n{rest:#?}"),
            }
        }
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < self.deadline,
                "owner did not exit\n{rest:#?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success(), "owner failed: {status}\n{rest:#?}");
        assert!(
            rest.iter()
                .any(|line| line.starts_with("test result: ok. 1 passed; 0 failed;")),
            "{rest:#?}"
        );
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[derive(Debug, PartialEq)]
struct Original {
    bytes: Vec<u8>,
    directory: (u64, u64),
    owner: (u64, u64),
}

impl Original {
    fn read(lease: &Path) -> Self {
        let directory = std::fs::metadata(lease).unwrap();
        let owner = std::fs::metadata(lease.join("owner.json")).unwrap();
        Self {
            bytes: std::fs::read(lease.join("owner.json")).unwrap(),
            directory: (directory.dev(), directory.ino()),
            owner: (owner.dev(), owner.ino()),
        }
    }
}

fn assert_contender_refused(path: &Path) {
    let error = StorageLease::acquire(path)
        .err()
        .expect("contender admitted");
    assert_eq!(error.to_string(), "Data directory already owned");
    let lock = std::fs::File::open(path.join(".desktop.lock")).unwrap();
    assert_eq!(
        lock.try_lock_exclusive().unwrap_err().raw_os_error(),
        Some(libc::EWOULDBLOCK)
    );
}

fn assert_ordinary_admission(path: &Path) {
    let owner = StorageLease::acquire(path).unwrap();
    assert_eq!(
        names(path),
        [".desktop-lease", ".desktop-owner.json", ".desktop.lock"]
    );
    assert_eq!(flags(owner.release()), RELEASED);
    assert_eq!(names(path), [".desktop.lock"]);
}

#[test]
fn ticket_t_7_writer_removed_lease_retains_failure_until_owner_exits() {
    let fixture = Fixture::new();
    let mut owner = Owner::spawn(External::Removed, &fixture.0);
    owner.expect("retained");
    assert_eq!(names(&fixture.0), [".desktop.lock"]);
    assert_contender_refused(&fixture.0);
    assert_eq!(names(&fixture.0), [".desktop.lock"]);
    owner.reap();
    assert_ordinary_admission(&fixture.0);
}

#[test]
fn ticket_t_7_writer_relocated_lease_keeps_owner_bytes_until_restored() {
    let fixture = Fixture::new();
    let mut owner = Owner::spawn(External::Relocated, &fixture.0);
    owner.expect("retained");
    assert_eq!(names(&fixture.0), [".desktop.lock", "relocated-lease"]);
    assert_contender_refused(&fixture.0);
    std::fs::rename(
        fixture.0.join("relocated-lease"),
        fixture.0.join(".desktop-lease"),
    )
    .unwrap();
    owner.send("restored");
    owner.expect("released");
    assert_eq!(names(&fixture.0), [".desktop.lock"]);
    owner.reap();
    assert_ordinary_admission(&fixture.0);
}

#[test]
fn ticket_t_7_writer_external_lease_owner_subprocess() {
    let Some(probe) = std::env::var_os(OWNER_PROBE) else {
        return;
    };
    let probe = probe.into_string().unwrap();
    let (external, path) = probe.split_once(':').unwrap();
    let (external, path) = (External::parse(external), Path::new(path));
    let owner = StorageLease::acquire(path).unwrap();
    let shared = path.join(".desktop-lease");
    let relocated = path.join("relocated-lease");
    let original = Original::read(&shared);
    match external {
        External::Removed => std::fs::remove_dir_all(&shared).unwrap(),
        External::Relocated => std::fs::rename(&shared, &relocated).unwrap(),
    }
    let assert_retained = || match external {
        External::Removed => assert_eq!(names(path), [".desktop.lock"]),
        External::Relocated => {
            assert_eq!(names(path), [".desktop.lock", "relocated-lease"]);
            assert_eq!(names(&relocated), ["owner.json"]);
            assert_eq!(Original::read(&relocated), original);
        }
    };

    assert_eq!(flags(owner.release()), RETAINED);
    assert_retained();
    for _ in 0..2 {
        assert_eq!(
            StorageLease::acquire(path).err().unwrap().to_string(),
            "Data directory already owned"
        );
        assert_eq!(
            flags(StorageLease::retry_failed_release(path).unwrap()),
            RETAINED
        );
        assert_retained();
    }
    println!("{STEP}retained");

    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).unwrap();
    if let External::Relocated = external {
        assert_eq!(line.trim_end(), "restored");
        assert_eq!(
            flags(StorageLease::retry_failed_release(path).unwrap()),
            RELEASED
        );
        assert_eq!(names(path), [".desktop.lock"]);
        assert_eq!(
            StorageLease::retry_failed_release(path)
                .err()
                .unwrap()
                .to_string(),
            "No retained failed release for this directory"
        );
        println!("{STEP}released");
        std::io::stdin().lock().read_line(&mut line).unwrap();
    }
}
