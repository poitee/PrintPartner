use pp_storage::{Limits, WriterOwner, lease::StorageLease};
use std::{
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::DirBuilderExt, process::ExitStatusExt},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ExitStatus, Stdio},
    sync::mpsc::{Receiver, channel},
    time::{Duration, Instant},
};

#[path = "common/process.rs"]
mod child_process;

const MODE: &str = "PP_GRE_636_MODE";
const DATA: &str = "PP_GRE_636_DATA";
const STEP: &str = "gre636 ";
const REFUSAL: &str = "refused Data directory already owned; stop the other Print Partner process before starting another instance";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-gre636-{}",
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
    input: ChildStdin,
    events: Receiver<String>,
    deadline: Instant,
}

impl Process {
    fn spawn(path: &Path, mode: &str) -> Self {
        let mut child = child_process::command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "gre_636_lock_subprocess",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(MODE, mode)
            .env(DATA, path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, events) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let line = line.unwrap();
                if let Some((_, event)) = line.split_once(STEP)
                    && sender.send(event.to_owned()).is_err()
                {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            events,
            deadline: Instant::now() + Duration::from_secs(60),
        }
    }

    fn event(&self) -> String {
        self.events
            .recv_timeout(self.deadline.saturating_duration_since(Instant::now()))
            .expect("child did not report its lock result")
    }

    fn send(&mut self, command: &str) {
        writeln!(self.input, "{command}").unwrap();
        self.input.flush().unwrap();
    }

    fn wait(&mut self) -> ExitStatus {
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < self.deadline, "child did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn start(&mut self) {
        assert_eq!(self.event(), "ready");
        self.send("start");
    }

    fn stop(&mut self) {
        self.send("stop");
        assert!(self.wait().success());
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            self.child.kill().unwrap();
            self.child.wait().unwrap();
        }
    }
}

fn report(event: &str) {
    println!("{STEP}{event}");
    std::io::stdout().flush().unwrap();
}

fn instruction(expected: &str) {
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
    assert_eq!(input.trim(), expected);
}

#[test]
fn gre_636_lock_subprocess() {
    let Ok(mode) = std::env::var(MODE) else {
        return;
    };
    let data = PathBuf::from(std::env::var_os(DATA).unwrap());
    report("ready");
    instruction("start");
    match mode.as_str() {
        "writer" => match WriterOwner::open(&data, Limits::default()) {
            Ok((owner, _)) => {
                report("owned");
                instruction("stop");
                owner.shutdown().unwrap();
            }
            Err(error) => report(&format!("refused {error}")),
        },
        "lease" => {
            let owner = StorageLease::acquire(&data).unwrap();
            report("owned");
            instruction("stop");
            assert!(owner.release().lock_released);
        }
        "advisory" => {
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(data.join("printpartner.lock"))
                .unwrap();
            fs4::FileExt::try_lock(&lock).unwrap();
            report("owned");
            instruction("stop");
            drop(lock);
        }
        _ => panic!("unknown child mode"),
    }
}

#[test]
fn gre_636_two_processes_admit_exactly_one_writer() {
    let fixture = Fixture::new();
    let mut first = Process::spawn(&fixture.0, "writer");
    let mut second = Process::spawn(&fixture.0, "writer");
    assert_eq!(first.event(), "ready");
    assert_eq!(second.event(), "ready");
    first.send("start");
    second.send("start");
    let results = [first.event(), second.event()];
    assert_eq!(results.iter().filter(|event| *event == "owned").count(), 1);
    assert_eq!(
        results.iter().filter(|event| *event == REFUSAL).count(),
        1,
        "{results:?}"
    );
    let (owner, refused) = if results[0] == "owned" {
        (&mut first, &mut second)
    } else {
        (&mut second, &mut first)
    };
    assert!(refused.wait().success());
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.0.join("printpartner.lock"))
        .unwrap();
    assert!(matches!(
        fs4::FileExt::try_lock(&lock),
        Err(fs4::TryLockError::WouldBlock)
    ));
    owner.stop();
    fs4::FileExt::try_lock(&lock).unwrap();
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn gre_636_sigkill_releases_lock_without_manual_cleanup() {
    let fixture = Fixture::new();
    let mut owner = Process::spawn(&fixture.0, "writer");
    owner.start();
    assert_eq!(owner.event(), "owned");
    assert!(
        child_process::command("kill")
            .args(["-9", &owner.child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(owner.wait().signal(), Some(9));
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.0.join("printpartner.lock"))
        .unwrap();
    fs4::FileExt::try_lock(&lock).unwrap();
    drop(lock);
    let mut successor = Process::spawn(&fixture.0, "writer");
    successor.start();
    assert_eq!(successor.event(), "owned");
    successor.stop();
}

#[test]
fn gre_636_lock_refusal_precedes_database_preflight() {
    let fixture = Fixture::new();
    let database = fixture.0.join("print-partner.db");
    std::fs::write(&database, b"invalid SQLite bytes").unwrap();
    let mut owner = Process::spawn(&fixture.0, "advisory");
    owner.start();
    assert_eq!(owner.event(), "owned");
    let mut contender = Process::spawn(&fixture.0, "writer");
    contender.start();
    assert_eq!(contender.event(), REFUSAL);
    assert!(contender.wait().success());
    assert_eq!(std::fs::read(&database).unwrap(), b"invalid SQLite bytes");
    assert!(!fixture.0.join(".desktop.lock").exists());
    assert!(!fixture.0.join(".desktop-lease").exists());
    assert!(!fixture.0.join(".desktop-owner.json").exists());
    owner.stop();
    let mut uncontended = Process::spawn(&fixture.0, "writer");
    uncontended.start();
    assert_eq!(uncontended.event(), "refused file is not a database");
    assert!(uncontended.wait().success());
}

#[test]
fn gre_636_runtime_and_standalone_writer_share_the_advisory_lock() {
    let fixture = Fixture::new();
    let mut runtime = Process::spawn(&fixture.0, "lease");
    runtime.start();
    assert_eq!(runtime.event(), "owned");
    let mut writer = Process::spawn(&fixture.0, "writer");
    writer.start();
    assert_eq!(writer.event(), REFUSAL);
    assert!(writer.wait().success());
    runtime.stop();
    let mut successor = Process::spawn(&fixture.0, "writer");
    successor.start();
    assert_eq!(successor.event(), "owned");
    successor.stop();
}
