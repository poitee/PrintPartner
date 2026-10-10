use pp_contracts::autosave::PositiveId;
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    catalog::{CreateSource, Credentials, Request as CatalogRequest},
    checkoff_progress::Request as ProgressRequest,
    jobs::{self, Payload, UserOperation},
    read_model::Credential,
    required_units::ReconciliationCommand,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
const WAIT: Duration = Duration::from_secs(5);
fn secret() -> Secret {
    Secret::new("required-unit-fixture-secret".into())
}
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("pp-progress-family-{}", rand::random::<u64>()));
        let repos = root.join("repos/1/revisions/fixture");
        std::fs::create_dir_all(&repos).unwrap();
        std::fs::write(
            root.join("print-partner.db"),
            include_bytes!("fixtures/required-units/shrink.db"),
        )
        .unwrap();
        for (name, bytes) in [
            ("bracket", "solid bracket"),
            ("gear", "solid gear"),
            ("excluded", "solid excluded"),
        ] {
            std::fs::write(repos.join(format!("{name}.stl")), bytes).unwrap();
        }
        Self(root)
    }
    fn sql(&self) -> Connection {
        Connection::open(self.0.join("print-partner.db")).unwrap()
    }
    fn graph(&self) -> BTreeMap<String, Vec<String>> {
        let c = Connection::open_with_flags(
            self.0.join("print-partner.db"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let names = c
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        names
            .into_iter()
            .map(|name| {
                let mut statement = c
                    .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
                    .unwrap();
                let count = statement.column_count();
                let values = statement
                    .query_map([], |r| {
                        Ok((0..count)
                            .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
                            .collect::<Vec<_>>()
                            .join("|"))
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                (name, values)
            })
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn policy(strict: bool) -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        first_user: auth::FirstUserTenant::NewUser,
        session_tenant: if strict {
            auth::SessionTenantPolicy::SingleAccountDefault
        } else {
            auth::SessionTenantPolicy::AccountTenant
        },
    }
}
fn reconciliation(credential: Credential) -> ReconciliationCommand {
    let case: Value =
        serde_json::from_str(include_str!("fixtures/required-units/shrink.json")).unwrap();
    ReconciliationCommand::new(
        PositiveId::new(1).unwrap(),
        PositiveId::new(2).unwrap(),
        serde_json::from_value(case["request"].clone()).unwrap(),
        "composed".into(),
        credential,
    )
    .unwrap()
}
fn completion() -> ProgressRequest {
    ProgressRequest::CompletionCoordinate {
        part_id: 1,
        body: json!({"unit_index":1,"completed":true}),
    }
}
#[test]
fn public_progress_selection_claim_and_reopen_preserve_identity() {
    let f = Fixture::new();
    let request = f.0.join("request.json");
    let case: Value =
        serde_json::from_str(include_str!("fixtures/required-units/shrink.json")).unwrap();
    std::fs::write(&request, case["request"].to_string()).unwrap();
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_progress-family-fixture"))
        .args([f.0.as_os_str(), request.as_os_str()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let result: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(result["schema"], 42);
    assert_eq!(result["restart"], true);
    assert_eq!(result["handler_calls"], 0);
    assert_eq!(result["selection_basis"][0]["completed"], true);
    assert_eq!(
        result["graph_before"]["accepted_plates"],
        result["graph_after"]["accepted_plates"]
    );
}
#[test]
fn auth_key_rollback_and_policy_isolation_span_all_operation_families() {
    let f = Fixture::new();
    WriterOwner::open(&f.0, Limits::default())
        .unwrap()
        .0
        .shutdown()
        .unwrap();
    f.sql().execute_batch("CREATE TRIGGER jobs_refusal BEFORE INSERT ON durable_jobs WHEN NEW.resource='source:1' BEGIN SELECT RAISE(ABORT,'composed Jobs refusal'); END;").unwrap();
    f.sql().execute_batch("BEGIN; PRAGMA defer_foreign_keys=ON; UPDATE users SET id='account-uuid'; UPDATE sessions SET user_id='account-uuid'; COMMIT; CREATE TRIGGER selection_refusal BEFORE UPDATE OF current_required_unit_reconciliation_id ON plan_drafts BEGIN SELECT RAISE(ABORT,'composed selection refusal'); END; CREATE TRIGGER progress_refusal BEFORE UPDATE ON print_progress WHEN NEW.unit_index=1 BEGIN SELECT RAISE(ABORT,'composed progress refusal'); END; CREATE TRIGGER catalog_refusal BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'composed catalog refusal'); END;").unwrap();
    let owner = WriterOwner::open(&f.0, Limits::default()).unwrap().0;
    let strict_progress = owner.checkoff_progress_with_policy(policy(true)).unwrap();
    let strict_required = owner.required_units_with_policy(policy(true)).unwrap();
    let strict_jobs = owner.jobs(policy(true)).unwrap();
    let neutral_progress = owner.checkoff_progress();
    let neutral_required = owner.required_units();
    let before = f.graph();
    assert_eq!(
        neutral_progress
            .apply(
                Credentials::Session(secret()),
                completion(),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap()
            .status,
        404
    );
    assert_eq!(
        serde_json::to_value(
            neutral_required
                .reconcile(
                    reconciliation(Credential::Session(secret())),
                    &AtomicBool::new(false),
                    WAIT
                )
                .unwrap()
        )
        .unwrap(),
        json!({"kind":"profile_not_found"})
    );
    assert_eq!(
        strict_progress
            .apply(
                Credentials::Session(secret()),
                completion(),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap()
            .status,
        500
    );
    assert!(
        strict_required
            .reconcile(
                reconciliation(Credential::Session(secret())),
                &AtomicBool::new(false),
                WAIT
            )
            .is_err()
    );
    assert_eq!(f.graph(), before);
    let auth = owner.auth_with_policy(policy(true)).unwrap();
    let call = |r| {
        auth.submit(r, Arc::new(AtomicBool::new(false)), WAIT)
            .unwrap()
            .recv()
            .unwrap()
            .unwrap()
    };
    let auth::Outcome::KeyCreated { key, info } =
        call(auth::Request::CreateKey { session: secret() })
    else {
        panic!("No key")
    };
    let raw = key.expose().to_owned();
    let catalog_key = |tenant: &str| Credentials::Key {
        tenant_id: tenant.into(),
        key: Secret::new(raw.clone()),
    };
    let read_key = |tenant: &str| Credential::ApiKey {
        routed_tenant: tenant.into(),
        secret: Secret::new(raw.clone()),
    };
    let job_key = |tenant: &str| jobs::Credential::RoutedKey {
        tenant: tenant.into(),
        key: Secret::new(raw.clone()),
    };
    let before = f.graph();
    for tenant in ["foreign", "default"] {
        let result = strict_progress.apply(
            catalog_key(tenant),
            completion(),
            &AtomicBool::new(false),
            WAIT,
        );
        if tenant == "default" {
            assert_eq!(result.unwrap().status, 500);
        } else {
            assert!(result.is_err());
        }
        assert_eq!(f.graph(), before);
        assert!(
            strict_required
                .reconcile(
                    reconciliation(read_key(tenant)),
                    &AtomicBool::new(false),
                    WAIT
                )
                .is_err()
        );
        assert_eq!(f.graph(), before);
        assert!(
            owner
                .source_catalog(catalog_key(tenant))
                .execute(CatalogRequest::Create {
                    source: CreateSource {
                        name: "refused".into(),
                        ..Default::default()
                    }
                })
                .is_err()
        );
        assert_eq!(f.graph(), before);
        let result = strict_jobs.submit(
            job_key(tenant),
            UserOperation::Enqueue {
                key: "refused-job".into(),
                payload_version: 1,
                payload: Payload::ImportScan { project_id: 1 },
            },
            &AtomicBool::new(false),
            WAIT,
        );
        assert!(result.and_then(|r| r.receive()).is_err());
        assert_eq!(f.graph(), before);
    }
    let batch = owner
        .accepted_reads()
        .read(read_key("default"), &[1], &AtomicBool::new(false), WAIT)
        .unwrap();
    assert_eq!(batch.builds.len(), 1);
    assert_eq!(f.graph(), before);
    let result = strict_jobs
        .submit(
            job_key("default"),
            UserOperation::Enqueue {
                key: "auth-composed".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap()
        .receive()
        .unwrap();
    assert!(matches!(result, jobs::Outcome::Job(_, _)));
    assert_ne!(f.graph()["app_settings"], before["app_settings"]);
    call(auth::Request::RevokeKey {
        session: secret(),
        key_id: info.id,
    });
    let before = f.graph();
    assert!(
        strict_progress
            .apply(
                catalog_key("default"),
                completion(),
                &AtomicBool::new(false),
                WAIT
            )
            .is_err()
    );
    assert!(
        strict_required
            .reconcile(
                reconciliation(read_key("default")),
                &AtomicBool::new(false),
                WAIT
            )
            .is_err()
    );
    assert!(
        strict_jobs
            .submit(
                job_key("default"),
                UserOperation::Enqueue {
                    key: "revoked-job".into(),
                    payload_version: 1,
                    payload: Payload::CheckSourceUpdates {}
                },
                &AtomicBool::new(false),
                WAIT
            )
            .and_then(|r| r.receive())
            .is_err()
    );
    assert!(
        owner
            .source_catalog(catalog_key("default"))
            .execute(CatalogRequest::List {})
            .is_err()
    );
    assert!(
        owner
            .accepted_reads()
            .read(read_key("default"), &[1], &AtomicBool::new(false), WAIT)
            .is_err()
    );
    assert_eq!(f.graph(), before);
    owner.shutdown().unwrap();
}
