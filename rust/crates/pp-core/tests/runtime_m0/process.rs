use std::{
    io::{Read, Seek},
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};

// Fixtures must keep descendants attached until their owner finishes. This does
// not supervise daemons that double-fork or otherwise deliberately detach.
#[cfg(unix)]
mod tree {
    use super::*;
    use std::{collections::BTreeSet, os::unix::process::CommandExt};

    pub struct Guard(pub Child, bool);

    // ps is itself bounded and uses a file, so neither pipe capacity nor a stuck
    // process-table query can hold up teardown indefinitely.
    pub fn snapshot() -> std::io::Result<Vec<(i32, i32, i32, String)>> {
        let mut file = tempfile::tempfile()?;
        let mut child = Command::new("ps")
            .args(["-axo", "pid=,ppid=,pgid=,stat="])
            .stdout(file.try_clone()?)
            .stderr(Stdio::null())
            .spawn()?;
        let deadline = Instant::now() + Duration::from_millis(500);
        let result = loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break Ok(()),
                Ok(Some(_)) => break Err(std::io::Error::other("ps failed")),
                Err(error) => break Err(error),
                Ok(None) if Instant::now() >= deadline => {
                    break Err(std::io::Error::other("ps timed out"));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            }
        };
        let _ = child.kill();
        let _ = child.wait();
        result?;
        file.rewind()?;
        let mut text = String::new();
        file.read_to_string(&mut text)?;
        text.lines()
            .map(|line| {
                let fields: Vec<_> = line.split_whitespace().collect();
                let invalid = || std::io::Error::other("invalid ps row");
                if fields.len() != 4 {
                    return Err(invalid());
                }
                Ok((
                    fields[0].parse().map_err(|_| invalid())?,
                    fields[1].parse().map_err(|_| invalid())?,
                    fields[2].parse().map_err(|_| invalid())?,
                    fields[3].to_owned(),
                ))
            })
            .collect()
    }

    fn signal(pid: i32, signal: i32) {
        // Only positive owned PIDs or negative owned process-group IDs enter here.
        unsafe { libc::kill(pid, signal) };
    }

    impl Guard {
        pub fn spawn(command: &mut Command) -> Self {
            Self(
                command.process_group(0).spawn().expect("spawn fixture"),
                false,
            )
        }

        pub fn cleanup(&mut self) -> bool {
            if self.1 {
                return true;
            }
            self.1 = true;
            let root = self.0.id() as i32;
            let mut owned = BTreeSet::from([root]);
            let mut groups = BTreeSet::from([root]);
            signal(-root, libc::SIGSTOP);
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut complete = true;
            loop {
                let Ok(rows) = snapshot() else {
                    complete = false;
                    break;
                };
                let before = owned.len();
                loop {
                    let count = owned.len();
                    for (pid, parent, group, _) in &rows {
                        if owned.contains(parent) || groups.contains(group) {
                            owned.insert(*pid);
                            if pid == group {
                                groups.insert(*group);
                            }
                        }
                    }
                    if owned.len() == count {
                        break;
                    }
                }
                for group in &groups {
                    signal(-group, libc::SIGSTOP);
                }
                for pid in &owned {
                    signal(*pid, libc::SIGSTOP);
                }
                if owned.len() == before {
                    break;
                }
                if Instant::now() >= deadline {
                    complete = false;
                    break;
                }
            }
            for group in &groups {
                signal(-group, libc::SIGKILL);
            }
            for pid in owned.iter().rev() {
                signal(*pid, libc::SIGKILL);
            }
            let _ = self.0.kill();
            complete &= self.0.wait().is_ok();
            // Grandchildren cannot be waitpid'd by us. Zombies are dead and can
            // no longer write; their OS parent is responsible for reaping them.
            let deadline = Instant::now() + Duration::from_millis(500);
            loop {
                let Ok(rows) = snapshot() else { return false };
                if !rows.iter().any(|(pid, _, group, state)| {
                    (owned.contains(pid) || groups.contains(group)) && !state.starts_with('Z')
                }) {
                    self.1 = complete;
                    return complete;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            if !self.1 {
                self.cleanup();
            }
        }
    }
}

#[cfg(unix)]
pub fn output(command: &mut Command, bound: Duration) -> Output {
    tree::snapshot().expect("fixture cleanup requires ps");
    let mut stdout = tempfile::tempfile().unwrap();
    let mut stderr = tempfile::tempfile().unwrap();
    command
        .stdout(stdout.try_clone().unwrap())
        .stderr(stderr.try_clone().unwrap());
    let mut child = tree::Guard::spawn(command);
    let deadline = Instant::now() + bound;
    let status = loop {
        if let Some(status) = child.0.try_wait().expect("poll fixture") {
            break Some(status);
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let cleaned = child.cleanup();
    drop(child);
    assert!(cleaned, "fixture subprocess tree cleanup failed");
    let status = status.expect("fixture subprocess timed out");
    let mut result = Output {
        status,
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    stdout.rewind().unwrap();
    stderr.rewind().unwrap();
    stdout.read_to_end(&mut result.stdout).unwrap();
    stderr.read_to_end(&mut result.stderr).unwrap();
    result
}

#[cfg(not(unix))]
pub fn output(_: &mut Command, _: Duration) -> Output {
    panic!("runtime fixture process cleanup requires Unix");
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::process::CommandExt};

    fn fixture() -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        let module = module_path!().split_once("::").unwrap().1;
        command.args([
            "--exact",
            &format!("{module}::nested_fixture"),
            "--nocapture",
        ]);
        command
    }

    #[test]
    fn nested_fixture() {
        let Some(root) = std::env::var_os("PP_PROCESS_TREE_FIXTURE") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        if std::env::var_os("PP_PROCESS_TREE_WRITER").is_none() {
            let mut child = fixture()
                .env("PP_PROCESS_TREE_WRITER", "1")
                .process_group(0)
                .spawn()
                .unwrap();
            std::fs::write(
                root.join("pids"),
                format!("{} {}", std::process::id(), child.id()),
            )
            .unwrap();
            child.wait().unwrap();
        } else {
            let mut file = std::fs::File::create(root.join("writes")).unwrap();
            loop {
                file.write_all(b"still alive\n").unwrap();
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    #[test]
    fn timeout_stops_nested_writer_before_scratch_removal() {
        let root = tempfile::tempdir().unwrap();
        let mut command = fixture();
        command.env("PP_PROCESS_TREE_FIXTURE", root.path());
        let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            output(&mut command, Duration::from_secs(5));
        }));
        let message = failure.unwrap_err().downcast::<String>().unwrap();
        assert!(
            message.contains("fixture subprocess timed out"),
            "{message}"
        );
        let pids = std::fs::read_to_string(root.path().join("pids")).unwrap();
        let pids: Vec<i32> = pids
            .split_whitespace()
            .map(|pid| pid.parse().unwrap())
            .collect();
        let rows = tree::snapshot().unwrap();
        assert!(!rows.iter().any(|(pid, _, _, _)| *pid == pids[0]));
        for pid in pids {
            assert!(
                !rows
                    .iter()
                    .any(|(id, _, _, state)| *id == pid && !state.starts_with('Z'))
            );
        }
        let before = std::fs::read(root.path().join("writes")).unwrap();
        assert!(!before.is_empty());
        std::thread::sleep(Duration::from_millis(80));
        assert_eq!(before, std::fs::read(root.path().join("writes")).unwrap());
        root.close().unwrap();
    }
}
