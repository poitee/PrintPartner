use super::{Scratch, recorded_pids, release_spec, startup_process_state, startup_wait};
use crate::{Bundle, Status, Supervisor};
use serde_json::{Value, json};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Output, Stdio},
    time::{Duration, Instant},
};

const CLEANUP_LIMIT: Duration = Duration::from_secs(5);
const REEXEC_LIMIT: Duration = Duration::from_secs(180);
const OUTPUT_LIMIT: u64 = 64 * 1024;

fn wait_child(child: &mut Child, deadline: Instant) -> std::io::Result<Option<ExitStatus>> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

// Arm before exec, then check for death between fork and prctl. These children
// have their own groups; killing the reexec's group cannot contain them.
fn die_with_parent(command: &mut Command) -> &mut Command {
    let parent = std::process::id() as libc::pid_t;
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                libc::_exit(1);
            }
            Ok(())
        });
    }
    command
}

struct CapturedReexec {
    child: Child,
    scratch: Scratch,
}

impl CapturedReexec {
    fn spawn(command: &mut Command) -> Self {
        let scratch = Scratch::new("built-reexec");
        let child = command
            .stdin(Stdio::null())
            .stdout(File::create(scratch.root.join("stdout")).unwrap())
            .stderr(File::create(scratch.root.join("stderr")).unwrap())
            .spawn()
            .unwrap();
        Self { child, scratch }
    }

    fn output(&mut self, limit: Duration) -> Output {
        let status = wait_child(&mut self.child, Instant::now() + limit)
            .unwrap()
            .unwrap_or_else(|| {
                let _ = self.child.kill();
                wait_child(&mut self.child, Instant::now() + CLEANUP_LIMIT)
                    .unwrap()
                    .expect("built startup reexec did not exit after SIGKILL")
            });
        let read = |name| {
            let mut file = File::open(self.scratch.root.join(name)).unwrap();
            let len = file.metadata().unwrap().len();
            file.seek(SeekFrom::Start(len.saturating_sub(OUTPUT_LIMIT)))
                .unwrap();
            let mut bytes = Vec::new();
            file.take(len.min(OUTPUT_LIMIT))
                .read_to_end(&mut bytes)
                .unwrap();
            bytes
        };
        Output {
            status,
            stdout: read("stdout"),
            stderr: read("stderr"),
        }
    }
}

impl Drop for CapturedReexec {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            if !matches!(
                wait_child(&mut self.child, Instant::now() + CLEANUP_LIMIT),
                Ok(Some(_))
            ) {
                eprintln!(
                    "built startup reexec cleanup could not reap child {}",
                    self.child.id()
                );
            }
        }
    }
}

fn reexec_output(command: &mut Command) -> Output {
    CapturedReexec::spawn(command).output(REEXEC_LIMIT)
}

fn reexec_failure(output: &Output, test: &str) -> Option<String> {
    crate::tests::validate_subreaper_fixture(output, test)
        .err()
        .map(|reason| {
            format!(
                "{reason}; status: {}\nstdout:\n{}\nstderr:\n{}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        })
}

fn assert_reexec_passed(output: &Output, test: &str) {
    if let Some(message) = reexec_failure(output, test) {
        panic!("{message}");
    }
}

#[test]
fn built_startup_reexec_sigkill_returns_with_live_output_peer() {
    let mut fixture = CapturedReexec::spawn(Command::new("/bin/sh").args([
        "-c",
        "printf '%s\\n' 'built startup group outlived force-killed owner' >&2; exec /bin/sleep 600",
    ]));
    let mut peer = CapturedReexec::spawn(
        Command::new("/bin/sh")
            .args([
                "-c",
                "exec >>\"$1/stdout\" 2>>\"$1/stderr\"; : >\"$1/peer-ready\"; exec /bin/sleep 600",
                "peer",
            ])
            .arg(&fixture.scratch.root),
    );
    startup_wait(
        CLEANUP_LIMIT,
        "disposable output peer never became ready",
        || {
            fixture.scratch.root.join("peer-ready").exists()
                && std::fs::metadata(fixture.scratch.root.join("stderr"))
                    .unwrap()
                    .len()
                    > 0
        },
    );
    fixture.child.kill().unwrap();
    let started = Instant::now();
    let output = fixture.output(Duration::from_secs(1));
    assert!(started.elapsed() < CLEANUP_LIMIT);
    assert_eq!(output.status.signal(), Some(libc::SIGKILL));
    assert!(peer.child.try_wait().unwrap().is_none());
    let message = reexec_failure(&output, BUILT_TEST).unwrap();
    assert_eq!(
        message
            .matches("built startup group outlived force-killed owner")
            .count(),
        1
    );
    assert!(message.contains("isolated subreaper fixture failed"));
    peer.child.kill().unwrap();
    assert_eq!(
        wait_child(&mut peer.child, Instant::now() + CLEANUP_LIMIT)
            .unwrap()
            .unwrap()
            .signal(),
        Some(libc::SIGKILL)
    );
}

#[test]
fn built_startup_reexec_timeout_kills_and_reaps_child() {
    let mut fixture = CapturedReexec::spawn(Command::new("/bin/sleep").arg("600"));
    let started = Instant::now();
    let output = fixture.output(Duration::from_millis(50));
    assert!(started.elapsed() < CLEANUP_LIMIT);
    assert_eq!(output.status.signal(), Some(libc::SIGKILL));
    assert!(!Path::new(&format!("/proc/{}", fixture.child.id())).exists());
}

#[test]
fn built_startup_reexec_bounds_diagnostics_and_preserves_failure_tail() {
    let mut fixture = CapturedReexec::spawn(Command::new("/bin/sh").args([
        "-c",
        "i=0; while [ \"$i\" -lt 2000 ]; do printf '%064d\\n' 0 >&2; i=$((i+1)); done; printf '%s\\n' 'built startup group outlived force-killed owner' >&2; exit 1",
    ]));
    let output = fixture.output(CLEANUP_LIMIT);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(output.stderr.len(), OUTPUT_LIMIT as usize);
    let message = reexec_failure(&output, BUILT_TEST).unwrap();
    assert_eq!(
        message
            .matches("built startup group outlived force-killed owner")
            .count(),
        1
    );
    assert!(!message.contains("Output {"));
}

#[test]
fn built_startup_cleanup_failure_preserves_unwinding_panic() {
    let scratch = Scratch::new("built-cleanup-unwind");
    let evidence = scratch.root.join("missing-evidence-directory");
    let owner = Command::new("/bin/sleep").arg("600").spawn().unwrap();
    let mut fixture = BuiltStartupFixture {
        owner,
        peer: None,
        backend: None,
        adopted: Vec::new(),
        scratch,
        evidence,
        verified: false,
    };
    fixture.peer = Some(Command::new("/bin/sleep").arg("600").spawn().unwrap());
    let owner = fixture.owner.id();
    let peer = fixture.peer.as_ref().unwrap().id();
    let started = Instant::now();
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _fixture = fixture;
        panic!("built startup group outlived force-killed owner");
    }))
    .unwrap_err();
    assert!(started.elapsed() < CLEANUP_LIMIT + Duration::from_secs(1));
    assert_eq!(
        panic.downcast_ref::<&str>(),
        Some(&"built startup group outlived force-killed owner")
    );
    for pid in [owner, peer] {
        assert!(!Path::new(&format!("/proc/{pid}")).exists());
    }
}

const LIFETIME_MODE: &str = "PP_COMPAT_BUILT_STARTUP_LIFETIME_MODE";
const LIFETIME_ROOT: &str = "PP_COMPAT_BUILT_STARTUP_LIFETIME_ROOT";
const LIFETIME_TEST: &str = "ticket_t_2::built_startup::built_startup_reexec_contains_descendants";

fn lifetime_command(mode: &str, root: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", LIFETIME_TEST, "--format=pretty", "--color=never"])
        .env(LIFETIME_MODE, mode)
        .env(LIFETIME_ROOT, root);
    command
}

// The isolated observer reaps the killed fixture's orphans. Never set
// subreaper state in the shared test runner, where other tests spawn children.
#[test]
fn built_startup_reexec_contains_descendants() {
    use std::os::fd::AsRawFd;

    let Some(mode) = std::env::var_os(LIFETIME_MODE) else {
        let scratch = Scratch::new("built-lifetime");
        let before = subreaper_state();
        let output = reexec_output(&mut lifetime_command("observer", &scratch.root));
        assert_reexec_passed(&output, LIFETIME_TEST);
        assert_eq!(subreaper_state(), before);
        return;
    };
    let root = PathBuf::from(std::env::var_os(LIFETIME_ROOT).unwrap());
    match mode.to_str().unwrap() {
        "owner" => {
            let storage = File::open("/dev/null").unwrap();
            let mut backend = tokio::process::Command::new("/bin/sleep");
            backend.arg("600");
            let (_read, _guard) =
                crate::parent_death::configure_child(&mut backend, storage.as_raw_fd()).unwrap();
            let backend = backend.as_std_mut().spawn().unwrap();
            std::fs::write(root.join("backend.tmp"), backend.id().to_string()).unwrap();
            std::fs::rename(root.join("backend.tmp"), root.join("backend")).unwrap();
            loop {
                std::thread::park();
            }
        }
        "fixture" => {
            assert_eq!(
                unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
                0
            );
            let owner = die_with_parent(&mut lifetime_command("owner", &root))
                .process_group(0)
                .spawn()
                .unwrap();
            startup_wait(CLEANUP_LIMIT, "disposable backend never started", || {
                root.join("backend").exists()
            });
            let backend: u32 = std::fs::read_to_string(root.join("backend"))
                .unwrap()
                .parse()
                .unwrap();
            let peer = die_with_parent(Command::new("/bin/sleep").arg("600"))
                .process_group(backend as i32)
                .spawn()
                .unwrap();
            unsafe {
                assert_eq!(libc::getpgid(owner.id() as i32), owner.id() as i32);
                assert_eq!(libc::getpgid(backend as i32), backend as i32);
                assert_eq!(libc::getpgid(peer.id() as i32), backend as i32);
                assert_eq!(libc::kill(backend as i32, libc::SIGSTOP), 0);
            }
            assert_ne!(owner.id(), backend);
            let mut pids = children_of(owner.id());
            pids.extend([owner.id(), peer.id()]);
            write_json(&root.join("ready.tmp"), &json!(pids));
            std::fs::rename(root.join("ready.tmp"), root.join("ready")).unwrap();
            loop {
                std::thread::park();
            }
        }
        "observer" => {
            assert_eq!(
                unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
                0
            );
            let mut survivors = Vec::new();
            for external_sigkill in [false, true] {
                let scratch = Scratch::new("built-lifetime-cycle");
                let mut fixture = CapturedReexec::spawn(die_with_parent(&mut lifetime_command(
                    "fixture",
                    &scratch.root,
                )));
                startup_wait(CLEANUP_LIMIT, "disposable fixture never armed", || {
                    scratch.root.join("ready").exists()
                });
                let pids: Vec<u32> =
                    serde_json::from_slice(&std::fs::read(scratch.root.join("ready")).unwrap())
                        .unwrap();
                // Owner, backend, production watcher, and peer must all exist.
                assert_eq!(pids.len(), 4);
                let started = Instant::now();
                if external_sigkill {
                    fixture.child.kill().unwrap();
                }
                let output = fixture.output(Duration::from_millis(50));
                assert!(started.elapsed() < CLEANUP_LIMIT);
                assert_eq!(output.status.signal(), Some(libc::SIGKILL));
                let deadline = Instant::now() + CLEANUP_LIMIT;
                let absent = loop {
                    for pid in &pids {
                        unsafe {
                            libc::waitpid(*pid as i32, std::ptr::null_mut(), libc::WNOHANG);
                        }
                    }
                    if pids.iter().all(|pid| startup_process_state(*pid).is_none()) {
                        break true;
                    }
                    if Instant::now() >= deadline {
                        break false;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                };
                // A containment failure must not leak this observer's children.
                if !absent {
                    survivors.push(external_sigkill);
                    for pid in &pids {
                        unsafe {
                            libc::kill(*pid as i32, libc::SIGKILL);
                        }
                    }
                }
                startup_wait(CLEANUP_LIMIT, "disposable cleanup left children", || {
                    for pid in &pids {
                        unsafe {
                            libc::waitpid(*pid as i32, std::ptr::null_mut(), libc::WNOHANG);
                        }
                    }
                    pids.iter().all(|pid| startup_process_state(*pid).is_none())
                });
            }
            assert!(
                survivors.is_empty(),
                "reexec death left descendants; external SIGKILL cases: {survivors:?}"
            );
        }
        mode => panic!("unknown lifetime mode: {mode}"),
    }
}

const STAGE: &str = "PP_COMPAT_BUILT_STARTUP_STAGE";
const OWNER_ROOT: &str = "PP_COMPAT_BUILT_STARTUP_OWNER";
const EVIDENCE: &str = "PP_COMPAT_BUILT_STARTUP_EVIDENCE";
const REEXEC: &str = "PP_COMPAT_BUILT_STARTUP_REEXEC";
const PROBE: &str = "PP_COMPAT_BUILT_STARTUP_SUBREAPER_PROBE";
const PARENT_STATE: &str = "PP_COMPAT_BUILT_STARTUP_PARENT_STATE";
const BUILT_TEST: &str =
    "ticket_t_2::built_startup::ticket_t_3_drain_built_release_startup_parent_death";
const STATE_TEST: &str =
    "ticket_t_2::built_startup::built_startup_reexec_keeps_parent_subreaper_unchanged";
const OWNER_TEST: &str = "ticket_t_2::built_startup::built_startup_owner_fixture";

fn write_json(path: &Path, value: &Value) {
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn bundle() -> Bundle {
    let stage = PathBuf::from(std::env::var_os(STAGE).expect("built startup stage required"));
    let manifest: Value = serde_json::from_slice(include_bytes!(concat!(
        env!("OUT_DIR"),
        "/bundle-manifest.json"
    )))
    .unwrap();
    Bundle {
        node: stage.join("node"),
        entry: stage.join("web/apps/server/dist/current/desktop.js"),
        web_root: stage.join("web"),
        runtime_version: manifest["runtime_version"].as_str().unwrap().into(),
        commit: manifest["commit"].as_str().unwrap().into(),
    }
}

fn identity(pid: u32) -> Value {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let fields: Vec<_> = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .collect();
    json!({"pid": pid, "pgid": fields[2].parse::<u32>().unwrap(),
        "start_ticks": fields[19], "boot_id": std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim(),
        "state": fields[0]})
}

fn events() -> Vec<Value> {
    let path = bundle().web_root.join("startup-events.jsonl");
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn before_setup(data: &Path, pid: u32) -> anyhow::Result<()> {
    let root = data.parent().unwrap();
    crate::record_test_pid(&root.join("pids"), pid)?;
    startup_wait(
        Duration::from_secs(30),
        "built entry did not register setup reader",
        || startup_process_state(pid) == Some('T') && !events().is_empty(),
    );
    let observed = events();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0]["event"], "setup_reader_registered");
    assert_eq!(observed[0]["pid"], pid);
    assert_eq!(observed[0]["listener_registered"], true);
    assert_eq!(observed[0]["stdin_readable_length"], 0);
    assert!(
        observed[0]["stack"]
            .as_str()
            .unwrap()
            .contains("setupFromParent")
    );
    write_json(&root.join("milestone.json"), &observed[0]);
    Ok(())
}

#[tokio::test]
async fn built_startup_owner_fixture() {
    let Some(root) = std::env::var_os(OWNER_ROOT) else {
        return;
    };
    let scratch = Scratch { root: root.into() };
    let bundle = bundle();
    let assets = bundle.web_root.join("apps/web/dist");
    let spec = crate::SpawnSpec {
        bundle: crate::release::verify_bundle(bundle, &assets).unwrap(),
        before_setup: Box::new(before_setup),
        setup_padding: "x".repeat(1024 * 1024),
        ..release_spec(&scratch)
    };
    let supervisor = Supervisor::start(spec).unwrap();
    startup_wait_async(&scratch.pidfile()).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let pids = recorded_pids(&scratch.pidfile());
    assert_eq!(pids.len(), 1);
    assert_eq!(startup_process_state(pids[0]), Some('T'));
    assert!(matches!(
        *supervisor.handle.status.borrow(),
        Status::Starting
    ));
    assert!(supervisor.handle.endpoint().is_none());
    assert_eq!(*supervisor.health_probes_completed.borrow(), 0);
    assert_eq!(
        std::fs::read_dir(scratch.root.join("runtime"))
            .unwrap()
            .count(),
        0
    );
    let ready = json!({"owner": identity(std::process::id()), "backend": identity(pids[0]),
        "status": "Starting", "endpoint": null, "health_probes_completed": 0,
        "setup_bytes_minimum": 1024 * 1024, "setup_pending": true, "socket_count": 0,
        "spawn_count": pids.len(), "stopped_observation_ms": 100,
        "milestone": serde_json::from_slice::<Value>(&std::fs::read(scratch.root.join("milestone.json")).unwrap()).unwrap()});
    write_json(&scratch.root.join("owner-ready.tmp"), &ready);
    std::fs::rename(
        scratch.root.join("owner-ready.tmp"),
        scratch.root.join("owner-ready.json"),
    )
    .unwrap();
    std::future::pending::<()>().await;
    drop(supervisor);
}

async fn startup_wait_async(pids: &Path) {
    let deadline = Instant::now() + Duration::from_secs(40);
    while recorded_pids(pids).is_empty() {
        assert!(
            Instant::now() < deadline,
            "built spawn never recorded child"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn group_members(pgid: u32) -> Vec<Value> {
    std::fs::read_dir("/proc")
        .unwrap()
        .filter_map(|entry| {
            let pid = entry.ok()?.file_name().to_str()?.parse::<u32>().ok()?;
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let fields: Vec<_> = stat.rsplit_once(')')?.1.split_whitespace().collect();
            (fields[2].parse::<u32>().ok()? == pgid)
                .then(|| json!({"pid": pid, "state": fields[0]}))
        })
        .collect()
}

fn children_of(pid: u32) -> Vec<u32> {
    let mut children = std::collections::BTreeSet::new();
    if let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) {
        for task in tasks.flatten() {
            if let Ok(list) = std::fs::read_to_string(task.path().join("children")) {
                children.extend(
                    list.split_whitespace()
                        .map(|pid| pid.parse::<u32>().unwrap()),
                );
            }
        }
    }
    children.into_iter().collect()
}

struct BuiltStartupFixture {
    owner: Child,
    peer: Option<Child>,
    backend: Option<u32>,
    adopted: Vec<u32>,
    scratch: Scratch,
    evidence: PathBuf,
    verified: bool,
}

impl BuiltStartupFixture {
    fn reap_adopted(&self) {
        for pid in &self.adopted {
            unsafe {
                libc::waitpid(*pid as i32, std::ptr::null_mut(), libc::WNOHANG);
            }
        }
    }

    fn cleanup(&mut self) {
        let mut external = false;
        self.adopted.extend(children_of(self.owner.id()));
        self.adopted.extend(recorded_pids(&self.scratch.pidfile()));
        self.adopted.sort_unstable();
        self.adopted.dedup();
        if !matches!(self.owner.try_wait(), Ok(Some(_))) {
            external = true;
            let _ = self.owner.kill();
        }
        for pid in recorded_pids(&self.scratch.pidfile()) {
            if !crate::drain::process_group_absent(pid) {
                external = true;
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
        if let Some(peer) = &mut self.peer {
            let _ = peer.kill();
        }
        let deadline = Instant::now() + CLEANUP_LIMIT;
        let reaped = loop {
            self.reap_adopted();
            let owner_reaped = matches!(self.owner.try_wait(), Ok(Some(_)));
            let peer_reaped = self
                .peer
                .as_mut()
                .is_none_or(|peer| matches!(peer.try_wait(), Ok(Some(_))));
            if owner_reaped
                && peer_reaped
                && self
                    .adopted
                    .iter()
                    .all(|pid| !Path::new(&format!("/proc/{pid}")).exists())
            {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let groups_absent = self.backend.is_none_or(crate::drain::process_group_absent);
        let evidence = File::create(self.evidence.join("guard-cleanup.json")).unwrap();
        serde_json::to_writer_pretty(
            evidence,
            &json!({
                "external_sigkill": external, "positive_verified_before_cleanup": self.verified,
                "owner_absent": !Path::new(&format!("/proc/{}", self.owner.id())).exists(),
                "adopted_pids_absent": self.adopted,
                "backend_group_absent": groups_absent, "events": events(),
            }),
        )
        .unwrap();
        assert!(reaped, "cleanup failed to reap fixture children");
        assert!(groups_absent, "cleanup left built backend group");
    }
}

impl Drop for BuiltStartupFixture {
    fn drop(&mut self) {
        let unwinding = std::thread::panicking();
        if let Err(error) =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.cleanup()))
        {
            if unwinding {
                eprintln!("built startup fixture cleanup failed during unwinding");
            } else {
                std::panic::resume_unwind(error);
            }
        }
    }
}

fn built_startup_command() -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", BUILT_TEST, "--format=pretty", "--color=never"])
        .env(REEXEC, "1");
    command
}

fn subreaper_state() -> i32 {
    let mut state = 0;
    assert_eq!(
        unsafe { libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &mut state, 0, 0, 0) },
        0
    );
    state
}

#[test]
fn built_startup_reexec_keeps_parent_subreaper_unchanged() {
    let Some(state) = std::env::var_os(PARENT_STATE) else {
        for state in ["0", "1"] {
            let scratch = Scratch::new("built-subreaper");
            let output = reexec_output(
                Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", STATE_TEST, "--format=pretty", "--color=never"])
                    .env(PARENT_STATE, state)
                    .env_remove(REEXEC)
                    .env(PROBE, scratch.root.join("probe.json")),
            );
            assert_reexec_passed(&output, STATE_TEST);
        }
        return;
    };
    let state: i32 = state.to_str().unwrap().parse().unwrap();
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, state, 0, 0, 0) },
        0
    );
    assert_eq!(subreaper_state(), state);
    let probe = PathBuf::from(std::env::var_os(PROBE).unwrap());
    let skipped = reexec_output(&mut built_startup_command());
    assert!(skipped.status.success());
    assert_eq!(
        crate::tests::validate_subreaper_fixture(&skipped, BUILT_TEST),
        Err("isolated subreaper fixture did not pass exactly once")
    );
    assert!(!probe.exists(), "ignored fixture unexpectedly ran");
    ticket_t_3_drain_built_release_startup_parent_death();
    assert_eq!(
        subreaper_state(),
        state,
        "built fixture changed parent subreaper"
    );
    let observed: Value = serde_json::from_slice(&std::fs::read(probe).unwrap()).unwrap();
    assert_eq!(observed["subreaper"], 1);
    assert_ne!(observed["pid"], std::process::id());
}

#[test]
#[ignore = "requires full built desktop assets and proof driver manifest"]
fn ticket_t_3_drain_built_release_startup_parent_death() {
    if std::env::var_os(REEXEC).is_none() {
        let output = reexec_output(built_startup_command().arg("--include-ignored"));
        assert_reexec_passed(&output, BUILT_TEST);
        return;
    }
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
        0
    );
    if let Some(probe) = std::env::var_os(PROBE) {
        write_json(
            Path::new(&probe),
            &json!({"pid": std::process::id(), "subreaper": subreaper_state()}),
        );
        return;
    }
    let evidence = PathBuf::from(std::env::var_os(EVIDENCE).expect("evidence required"));
    let bundle = bundle();
    let assets = bundle.web_root.join("apps/web/dist");
    let bundle = crate::release::verify_bundle(bundle, &assets).unwrap();
    for cycle in 0..2 {
        let output = evidence.join(format!("cycle-{cycle}"));
        std::fs::create_dir_all(&output).unwrap();
        let _ = std::fs::remove_file(bundle.web_root.join("startup-events.jsonl"));
        let scratch = Scratch::new("built-startup");
        let stdout = std::fs::File::create(output.join("owner.log")).unwrap();
        let owner = die_with_parent(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", OWNER_TEST, "--nocapture"])
                .env(OWNER_ROOT, &scratch.root),
        )
        .process_group(0)
        .stdout(stdout.try_clone().unwrap())
        .stderr(stdout)
        .spawn()
        .unwrap();
        let mut fixture = BuiltStartupFixture {
            owner,
            peer: None,
            backend: None,
            adopted: Vec::new(),
            scratch,
            evidence: output.clone(),
            verified: false,
        };
        let ready = fixture.scratch.root.join("owner-ready.json");
        startup_wait(
            Duration::from_secs(60),
            "built owner never acknowledged pending setup",
            || {
                assert!(
                    fixture.owner.try_wait().unwrap().is_none(),
                    "built owner exited before startup acknowledgement"
                );
                ready.exists()
            },
        );
        let state: Value = serde_json::from_slice(&std::fs::read(ready).unwrap()).unwrap();
        let pid = state["backend"]["pid"].as_u64().unwrap() as u32;
        fixture.backend = Some(pid);
        fixture.adopted = children_of(fixture.owner.id());
        assert!(fixture.adopted.contains(&pid));
        assert!(
            (1..=2).contains(&fixture.adopted.len()),
            "unexpected owner children"
        );
        assert_eq!(state["owner"]["pgid"], fixture.owner.id());
        assert_eq!(state["backend"]["pgid"], pid);
        assert_ne!(fixture.owner.id(), pid);
        assert_eq!(startup_process_state(pid), Some('T'));
        assert_eq!(
            std::fs::canonicalize(format!("/proc/{pid}/exe")).unwrap(),
            std::fs::canonicalize(&bundle.node).unwrap()
        );
        fixture.peer = Some(
            die_with_parent(Command::new("/bin/sleep").arg("600"))
                .process_group(pid as i32)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let peer = fixture.peer.as_ref().unwrap().id();
        let peer_identity = identity(peer);
        assert_eq!(peer_identity["pgid"], pid);
        let armed = json!({"cycle": cycle, "state": state, "peer": peer_identity,
            "peer_parent": std::process::id(), "owner_children": fixture.adopted, "group_before": group_members(pid)});
        write_json(&output.join("armed.json"), &armed);
        let started = Instant::now();
        assert_eq!(
            unsafe { libc::kill(fixture.owner.id() as i32, libc::SIGKILL) },
            0
        );
        let mut owner_exit = None;
        let mut peer_exit = None;
        startup_wait(
            Duration::from_secs(5),
            "built startup group outlived force-killed owner",
            || {
                if owner_exit.is_none() {
                    owner_exit = fixture.owner.try_wait().unwrap();
                }
                if peer_exit.is_none() {
                    peer_exit = fixture.peer.as_mut().unwrap().try_wait().unwrap();
                }
                fixture.reap_adopted();
                if started.elapsed() >= Duration::from_millis(4900) {
                    write_json(
                        &output.join("invariant-failure.json"),
                        &json!({
                            "elapsed_ms": started.elapsed().as_millis(), "group": group_members(pid),
                            "backend_state": startup_process_state(pid), "peer_state": startup_process_state(peer),
                            "owner_reaped": owner_exit.is_some(), "events": events(),
                            "fallback_cleanup_started": false,
                        }),
                    );
                }
                owner_exit.is_some()
                    && peer_exit.is_some()
                    && crate::drain::process_group_absent(pid)
                    && fixture
                        .adopted
                        .iter()
                        .all(|pid| !Path::new(&format!("/proc/{pid}")).exists())
            },
        );
        assert!(started.elapsed() <= Duration::from_secs(5));
        assert_eq!(owner_exit.unwrap().signal(), Some(libc::SIGKILL));
        assert_eq!(peer_exit.unwrap().signal(), Some(libc::SIGKILL));
        assert!(group_members(pid).is_empty());
        assert_eq!(recorded_pids(&fixture.scratch.pidfile()), vec![pid]);
        assert_eq!(events(), vec![state["milestone"].clone()]);
        assert_eq!(
            std::fs::read_dir(fixture.scratch.root.join("runtime"))
                .unwrap()
                .count(),
            0
        );
        fixture.verified = true;
        let receipt = json!({"case": "built_startup_parent_death", "cycle": cycle, "armed": armed,
            "shutdown_ms": started.elapsed().as_millis(), "owner_signal": "SIGKILL", "peer_signal": "SIGKILL",
            "group_absent": true, "pids_fully_reaped": true, "spawn_count": 1, "restart_count": 0,
            "events": events(), "external_cleanup_required": false});
        write_json(&output.join("receipt.json"), &receipt);
        println!("{receipt}");
    }
}
