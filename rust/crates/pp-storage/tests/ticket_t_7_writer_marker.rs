use pp_storage::{Limits, WriterOwner, lease::StorageLease};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;

#[path = "common/process.rs"]
mod child_process;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-t7-marker-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&path)
            .unwrap();
        Self(path)
    }

    fn refuses(&self) {
        for _ in 0..2 {
            let error = match StorageLease::acquire(&self.0) {
                Ok(owner) => {
                    owner.release();
                    panic!("ambiguous lease was admitted")
                }
                Err(error) => error,
            };
            assert_eq!(error.to_string(), "storage_lease_marker_invalid");
            let error = match WriterOwner::open(&self.0, Limits::default()) {
                Ok((owner, _)) => {
                    owner.shutdown().unwrap();
                    panic!("writer admitted an ambiguous lease")
                }
                Err(error) => error,
            };
            assert_eq!(error.to_string(), "storage_lease_marker_invalid");
            assert!(!self.0.join("print-partner.db").exists());
            assert!(!self.0.join(".desktop-owner.json").exists());
            assert!(std::fs::read_dir(&self.0).unwrap().all(|entry| {
                let name = entry.unwrap().file_name();
                name == ".desktop-lease" || name == ".desktop.lock"
            }));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn ticket_t_7_writer_marker_missing_lease_record_fails_closed() {
    for nonempty in [false, true] {
        let fixture = Fixture::new();
        let lease = fixture.0.join(".desktop-lease");
        std::fs::create_dir(&lease).unwrap();
        if nonempty {
            std::fs::write(lease.join("previous-marker.json"), b"retained evidence").unwrap();
        }
        fixture.refuses();
        assert!(lease.is_dir());
        assert!(!lease.join("owner.json").exists());
        assert_eq!(
            std::fs::read_dir(&lease).unwrap().count(),
            usize::from(nonempty)
        );
        if nonempty {
            assert_eq!(
                std::fs::read(lease.join("previous-marker.json")).unwrap(),
                b"retained evidence"
            );
        }
    }
}

#[test]
fn ticket_t_7_writer_marker_torn_lease_record_fails_closed() {
    for bytes in [b"".as_slice(), b"{\"pid\":", b"{}", b"null"] {
        let fixture = Fixture::new();
        let lease = fixture.0.join(".desktop-lease");
        std::fs::create_dir(&lease).unwrap();
        std::fs::write(lease.join("owner.json"), bytes).unwrap();
        fixture.refuses();
        assert_eq!(std::fs::read(lease.join("owner.json")).unwrap(), bytes);
    }
}

#[test]
fn ticket_t_7_writer_marker_incomplete_identity_cannot_prove_staleness() {
    let mut child = child_process::command("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let dead_pid = child.id();
    child.wait().unwrap();
    for pid in [std::process::id(), dead_pid] {
        for identity in ["", " \t\n"] {
            let fixture = Fixture::new();
            let lease = fixture.0.join(".desktop-lease");
            std::fs::create_dir(&lease).unwrap();
            let bytes = serde_json::to_vec(&serde_json::json!({
                "pid": pid, "process_identity": identity, "instance": "ab".repeat(16)
            }))
            .unwrap();
            std::fs::write(lease.join("owner.json"), &bytes).unwrap();
            fixture.refuses();
            assert_eq!(std::fs::read(lease.join("owner.json")).unwrap(), bytes);
        }
    }
}

#[test]
fn ticket_t_7_writer_marker_complete_stale_lease_recovers() {
    let fixture = Fixture::new();
    let mut child = child_process::command("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    let lease = fixture.0.join(".desktop-lease");
    std::fs::create_dir(&lease).unwrap();
    let bytes = serde_json::to_vec(&serde_json::json!({
        "pid": pid, "process_identity": "prior-process", "instance": "ab".repeat(16)
    }))
    .unwrap();
    std::fs::write(lease.join("owner.json"), &bytes).unwrap();
    let (owner, _) = WriterOwner::open(&fixture.0, Limits::default()).unwrap();
    assert!(fixture.0.join("print-partner.db").is_file());
    assert_eq!(
        std::fs::read(fixture.0.join(format!(
            ".desktop-lease-retired-{}/owner.json",
            "ab".repeat(16)
        )))
        .unwrap(),
        bytes
    );
    owner.shutdown().unwrap();
    assert!(!lease.exists());
}
