#![cfg(feature = "desktop_rebuild")]
//! Durable publish/activate recovery through SourceImports.
use pp_core::uploads::{SourceImports, Through};
use pp_source::{
    SourcePath,
    retained_capture::{FreezeResult, RetainedCaptureId, RetainedCaptureVault},
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    catalog::CreateSource,
    jobs::Credential,
    uploads::{AdmissionLimits, CaptureId, CapturedPayloadV1, File, State, Target},
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

const QUOTA: u64 = 16 * 1024 * 1024 * 1024;
const BYTES: &[u8] = b"solid triangle";

struct Fixture {
    root: PathBuf,
    remove_root: bool,
    owner: Option<WriterOwner>,
    imports: SourceImports,
}

impl Fixture {
    fn open_at(root: PathBuf) -> Self {
        let root = std::fs::canonicalize(root).unwrap();
        let (owner, _) = WriterOwner::open(&root.join("data"), Limits::default()).unwrap();
        let policy = AuthPolicy {
            registration: RegistrationPolicy::Open,
            session_tenant: SessionTenantPolicy::AccountTenant,
            first_user: FirstUserTenant::NewUser,
        };
        let imports = SourceImports::new(&owner, policy, QUOTA).unwrap();
        Self {
            root,
            remove_root: true,
            owner: Some(owner),
            imports,
        }
    }

    fn open() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pp-source-import-recovery-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self::open_at(root)
    }

    fn reopen(mut self) -> Self {
        let root = self.root.clone();
        self.remove_root = false;
        drop(self);
        Self::open_at(root)
    }

    fn credential(&self) -> Credential {
        Credential::PhysicalOwner(self.owner.as_ref().unwrap().job_physical_owner())
    }

    fn repos(&self) -> PathBuf {
        self.root.join("data/repos")
    }

    /// Every file below `repos`, with its bytes, in path order.
    fn repo_files(&self) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(dir: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    out.push((path.clone(), std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.repos(), &mut out);
        out.sort();
        out
    }

    fn observations(&self, key: &str) -> Vec<(i64, String, Option<bool>, String)> {
        let db = Connection::open(self.root.join("data/print-partner.db")).unwrap();
        let mut statement = db
            .prepare(
                "SELECT attempt_generation, attempt_fence, receipt_activated, phase
                 FROM source_revision_observations
                 WHERE operation_key=?1
                 ORDER BY cursor",
            )
            .unwrap();
        statement
            .query_map([key], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get::<_, Option<i64>>(2)?.map(|value| value != 0),
                    row.get(3)?,
                ))
            })
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            let _ = owner.shutdown();
        }
        if self.remove_root {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

fn capture_limits() -> AdmissionLimits {
    AdmissionLimits {
        reserved_bytes: 3_506_438_144,
        max_input_bytes: 268_435_456,
        max_prepared_bytes: 1_073_741_824,
    }
}

fn capture_target(name: &str) -> Target {
    Target::Create {
        metadata: Box::new(CreateSource {
            name: name.into(),
            source_kind: Some("local".into()),
            source_type: Some("local".into()),
            ..Default::default()
        }),
    }
}

/// Admits a captured import of one STL and freezes its retained capture.
/// Returns the retained capture id.
fn stage_frozen(fixture: &Fixture, key: &str) -> String {
    let payload = CapturedPayloadV1::files(vec!["triangle.stl".into()]);
    let preflight = fixture
        .imports
        .preflight_capture(
            fixture.credential(),
            key.into(),
            capture_target(key),
            payload.clone(),
            capture_limits(),
        )
        .unwrap();
    let vault = RetainedCaptureVault::open(&fixture.root.join("data")).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    candidate
        .write_file(
            SourcePath::try_from("triangle.stl".to_owned()).unwrap(),
            BYTES,
            capture_limits().max_input_bytes,
        )
        .unwrap();
    let inventory = vec![File {
        path: "triangle.stl".into(),
        size: BYTES.len() as u64,
        sha256: hex::encode(Sha256::digest(BYTES)),
        kind: "input".into(),
    }];
    let prepared = preflight
        .prepare(
            CaptureId::new(id.clone()).unwrap(),
            key.into(),
            payload,
            capture_limits(),
            inventory,
        )
        .unwrap();
    let manifest = prepared.manifest().to_vec();
    assert!(matches!(
        candidate.freeze_owned(&manifest),
        FreezeResult::Frozen(_)
    ));
    let admitted = fixture.imports.admit_captured(prepared).unwrap();
    assert_eq!(admitted.state, State::Admitted);
    id
}

fn try_open_frozen(
    fixture: &Fixture,
    id: &str,
) -> anyhow::Result<pp_source::retained_capture::FrozenCapture> {
    let vault = RetainedCaptureVault::open(&fixture.root.join("data"))?;
    Ok(vault.open_frozen(&RetainedCaptureId::parse(id.to_owned())?)?)
}

fn open_frozen(fixture: &Fixture, id: &str) -> pp_source::retained_capture::FrozenCapture {
    try_open_frozen(fixture, id).unwrap()
}

fn owned_bytes(repos: &Path, job_id: &str) -> Vec<u8> {
    std::fs::read(repos.join(".pp-imports").join(job_id).join("triangle.stl")).unwrap()
}

#[test]
fn source_import_restart_resumes_recorded_phase() {
    for through in [Through::OwnedInput, Through::Published, Through::Activated] {
        let fixture = Fixture::open();
        let id = stage_frozen(&fixture, &format!("restart-{:?}", through));
        let frozen = open_frozen(&fixture, &id);
        let stopped = fixture
            .imports
            .work_frozen(frozen, through, &AtomicBool::new(false))
            .unwrap()
            .unwrap();
        assert_eq!(
            stopped.state,
            match through {
                Through::OwnedInput => State::OwnedInputReady,
                Through::Published => State::Published,
                Through::Activated => State::Activated,
                Through::Settled => unreachable!(),
            }
        );
        // The retained capture is consumed once owned input is journaled, so a
        // resumed attempt cannot recopy it.
        assert!(try_open_frozen(&fixture, &id).is_err());
        let owned_before = match through {
            Through::OwnedInput => Some(owned_bytes(&fixture.repos(), &stopped.job_id)),
            _ => None,
        };
        let prior = fixture.observations(&stopped.key);
        assert!(!prior.is_empty());
        for (_, fence, _, _) in &prior {
            assert_eq!(fence.len(), 64);
            assert!(
                fence
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            );
        }

        let fixture = fixture.reopen();
        let resumed = fixture
            .imports
            .work_operation(
                &stopped.job_id,
                None,
                Through::Settled,
                &AtomicBool::new(false),
            )
            .unwrap()
            .unwrap();
        assert!(resumed.cleanup_settled);
        assert!(resumed.receipt.as_ref().unwrap().activated);
        if let Some(bytes) = owned_before {
            assert_eq!(bytes, BYTES);
            assert!(
                !fixture
                    .repos()
                    .join(".pp-imports")
                    .join(&stopped.job_id)
                    .exists()
            );
        }
        let after = fixture.observations(&stopped.key);
        assert_eq!(after[..prior.len()], prior);
        assert!(after.iter().any(|row| row.3 == "activated"));
        assert_eq!(after.last().unwrap().3, "cleanup");
    }
}

#[test]
fn source_import_activation_is_fenced_and_idempotent() {
    let fixture = Fixture::open();
    let id = stage_frozen(&fixture, "activate-fence");
    let admitted = fixture
        .imports
        .get(fixture.credential(), "activate-fence".into())
        .unwrap();
    let files = fixture.repo_files();

    // Without its retained capture an admitted captured import is refused and
    // kept for `work_frozen`: no observation, no file, the capture survives.
    let error = fixture
        .imports
        .work_operation(
            &admitted.job_id,
            None,
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Import requires explicitly supplied input"
    );
    assert_eq!(
        fixture
            .imports
            .get(fixture.credential(), admitted.key.clone())
            .unwrap()
            .state,
        State::Admitted
    );
    assert!(fixture.observations(&admitted.key).is_empty());
    assert_eq!(fixture.repo_files(), files);
    assert!(try_open_frozen(&fixture, &id).is_ok());

    let fixture = fixture.reopen();
    let published = fixture
        .imports
        .work_frozen(
            open_frozen(&fixture, &id),
            Through::Published,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(published.state, State::Published);
    assert!(published.receipt.is_none());
    let artifact = published.artifact.clone().unwrap();
    let rows = fixture.observations(&published.key);
    assert_eq!(
        rows.iter().map(|row| row.3.as_str()).collect::<Vec<_>>(),
        ["owned", "published"]
    );
    let files = fixture.repo_files();

    // The stopped attempt still holds the job, so a retry before recovery
    // cannot claim it and changes no row or file.
    assert!(
        fixture
            .imports
            .work_operation(
                &published.job_id,
                None,
                Through::Activated,
                &AtomicBool::new(false),
            )
            .unwrap()
            .is_none()
    );
    assert_eq!(fixture.observations(&published.key), rows);
    assert_eq!(fixture.repo_files(), files);
    assert_eq!(
        fixture
            .imports
            .get(fixture.credential(), published.key.clone())
            .unwrap()
            .state,
        State::Published
    );

    // Recovery requeues the job under a new generation and fence; activation
    // records exactly one observation under that fence.
    let fixture = fixture.reopen();
    let activated = fixture
        .imports
        .work_operation(
            &published.job_id,
            None,
            Through::Activated,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(activated.state, State::Activated);
    let receipt = activated.receipt.clone().unwrap();
    assert!(receipt.activated);
    assert_eq!(receipt.job_id, published.job_id);
    assert_eq!(receipt.artifact, artifact);
    let after = fixture.observations(&published.key);
    assert_eq!(after[..rows.len()], rows);
    let [(generation, fence, _, phase)] = &after[rows.len()..] else {
        panic!("expected one activation observation, got {after:?}");
    };
    assert_eq!(phase, "activated");
    assert!(*generation > rows[1].0);
    assert_ne!(fence, &rows[1].1);
    assert_eq!(fence.len(), 64);

    // An exact retry after another restart adopts the recorded receipt.
    let fixture = fixture.reopen();
    let again = fixture
        .imports
        .work_operation(
            &published.job_id,
            None,
            Through::Activated,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(again.state, State::Activated);
    assert_eq!(again.receipt.as_ref(), Some(&receipt));
    assert_eq!(fixture.observations(&published.key), after);

    let fixture = fixture.reopen();
    let settled = fixture
        .imports
        .work_operation(
            &published.job_id,
            None,
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert!(settled.cleanup_settled);
    assert_eq!(settled.receipt.as_ref(), Some(&receipt));
    let settled_rows = fixture.observations(&published.key);
    assert_eq!(settled_rows[..after.len()], after);
    assert_eq!(
        settled_rows[after.len()..]
            .iter()
            .map(|row| row.3.as_str())
            .collect::<Vec<_>>(),
        ["cleanup"]
    );
    assert!(
        !fixture
            .repos()
            .join(".pp-imports")
            .join(&published.job_id)
            .exists()
    );

    // A settled import is not claimable again; the journal and the published
    // revision are unchanged.
    let files = fixture.repo_files();
    assert!(
        fixture
            .imports
            .work_operation(
                &published.job_id,
                None,
                Through::Settled,
                &AtomicBool::new(false),
            )
            .unwrap()
            .is_none()
    );
    assert_eq!(fixture.observations(&published.key), settled_rows);
    assert_eq!(fixture.repo_files(), files);
    let read = fixture
        .imports
        .get(fixture.credential(), published.key.clone())
        .unwrap();
    assert!(read.cleanup_settled);
    assert_eq!(read.receipt, Some(receipt));
}
