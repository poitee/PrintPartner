use super::{Scratch, recorded_pids, release_spec, startup_process_state, startup_wait};
use crate::{Bundle, Status, Supervisor};
use serde_json::{Value, json};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command},
    time::{Duration, Instant},
};

const STAGE: &str = "PP_COMPAT_BUILT_STARTUP_STAGE";
const OWNER_ROOT: &str = "PP_COMPAT_BUILT_STARTUP_OWNER";
const EVIDENCE: &str = "PP_COMPAT_BUILT_STARTUP_EVIDENCE";
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
    let spec = crate::SpawnSpec {
        bundle: bundle(),
        before_setup: Box::new(before_setup),
        setup_padding: "x".repeat(1024 * 1024),
        ..release_spec(&scratch)
    };
    let verified =
        crate::release::verify_bundle(&spec.bundle, &spec.bundle.web_root.join("apps/web/dist"))
            .unwrap();
    let supervisor =
        Supervisor::start_verified(verified, spec, crate::SupervisorConfig::default()).unwrap();
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
}

impl Drop for BuiltStartupFixture {
    fn drop(&mut self) {
        let mut external = false;
        self.adopted.extend(children_of(self.owner.id()));
        self.adopted.extend(recorded_pids(&self.scratch.pidfile()));
        self.adopted.sort_unstable();
        self.adopted.dedup();
        if self.owner.try_wait().unwrap().is_none() {
            external = true;
            let _ = self.owner.kill();
        }
        let _ = self.owner.wait();
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
            let _ = peer.wait();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            self.reap_adopted();
            if self
                .adopted
                .iter()
                .all(|pid| !Path::new(&format!("/proc/{pid}")).exists())
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "cleanup failed to reap adopted children"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let groups_absent = self.backend.is_none_or(crate::drain::process_group_absent);
        write_json(
            &self.evidence.join("guard-cleanup.json"),
            &json!({
                "external_sigkill": external, "positive_verified_before_cleanup": self.verified,
                "owner_absent": !Path::new(&format!("/proc/{}", self.owner.id())).exists(),
                "adopted_pids_absent": self.adopted,
                "backend_group_absent": groups_absent, "events": events(),
            }),
        );
        assert!(groups_absent, "cleanup left built backend group");
    }
}

#[test]
#[ignore = "requires full built desktop assets and proof driver manifest"]
fn ticket_t_3_drain_built_release_startup_parent_death() {
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
        0
    );
    let evidence = PathBuf::from(std::env::var_os(EVIDENCE).expect("evidence required"));
    let bundle = bundle();
    crate::release::verify_bundle(&bundle, &bundle.web_root.join("apps/web/dist")).unwrap();
    for cycle in 0..2 {
        let output = evidence.join(format!("cycle-{cycle}"));
        std::fs::create_dir_all(&output).unwrap();
        let _ = std::fs::remove_file(bundle.web_root.join("startup-events.jsonl"));
        let scratch = Scratch::new("built-startup");
        let stdout = std::fs::File::create(output.join("owner.log")).unwrap();
        let owner = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", OWNER_TEST, "--nocapture"])
            .env(OWNER_ROOT, &scratch.root)
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
            Command::new("/bin/sleep")
                .arg("600")
                .process_group(pid as i32)
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
