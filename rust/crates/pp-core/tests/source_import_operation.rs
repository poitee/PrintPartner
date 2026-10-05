use pp_core::uploads::{SourceImports, Through};
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    catalog::{self, CreateSource, SourcePatch},
    jobs::{self, Credential, JobKind, WorkerAdmission},
    uploads::{Admission, Input, Phase, Postprocessing, State, Target},
};
use rusqlite::{Connection, OpenFlags};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}
fn temp() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "source-import-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}
fn fixture() -> (PathBuf, PathBuf, WriterOwner) {
    let root = temp();
    let files = root.join("supplied");
    std::fs::create_dir(&files).unwrap();
    std::fs::write(
        files.join("triangle.stl"),
        include_bytes!("fixtures/source-import/triangle.stl"),
    )
    .unwrap();
    std::fs::write(files.join("README.md"), "# Ordinary Source\n").unwrap();
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.version, 36);
    (root, files, owner)
}
fn request(key: &str, target: Target) -> Admission {
    Admission {
        key: key.into(),
        target,
        input: Input::Files {
            paths: vec!["triangle.stl".into(), "README.md".into()],
        },
        reserved_bytes: 20 * 1024 * 1024,
        max_input_bytes: 65536,
        max_prepared_bytes: 65536,
    }
}
fn create(name: &str) -> Target {
    Target::Create {
        metadata: Box::new(CreateSource {
            name: name.into(),
            source_kind: Some("local".into()),
            source_type: Some("local".into()),
            ..Default::default()
        }),
    }
}
fn credential(owner: &WriterOwner) -> Credential {
    Credential::PhysicalOwner(owner.job_physical_owner())
}
fn service(owner: &WriterOwner) -> SourceImports {
    SourceImports::new(owner, policy(), 128 * 1024 * 1024).unwrap()
}
fn read(root: &Path) -> Connection {
    Connection::open_with_flags(
        root.join("print-partner.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}
fn count(root: &Path, table: &str) -> i64 {
    read(root)
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn cancel(owner: &WriterOwner, id: String) {
    owner
        .jobs(policy())
        .unwrap()
        .submit(
            credential(owner),
            jobs::UserOperation::Cancel { job_id: id },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
}
fn durable_job(owner: &WriterOwner, id: &str) -> jobs::JobRecord {
    match owner
        .jobs(policy())
        .unwrap()
        .submit(
            credential(owner),
            jobs::UserOperation::Get { job_id: id.into() },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    {
        jobs::Outcome::Job(job, _) => job,
        _ => panic!("job result required"),
    }
}
#[test]
fn create_update_exact_retry_never_repoints_and_preserves_originals() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("one", create("One")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(admitted.state, State::Admitted);
    let first = svc
        .work_next(Some(&files), Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert!(first.receipt.as_ref().unwrap().activated);
    assert!(first.cleanup_settled);
    assert_eq!(
        first.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::DocumentMetadataIndexed
    );
    assert_eq!(count(&root, "source_docs"), 1);
    assert_eq!(count(&root, "source_revisions"), 1);
    let old = first.artifact.as_ref().unwrap();
    let old_bytes =
        std::fs::read(root.join("repos").join(&old.locator).join("triangle.stl")).unwrap();
    assert_eq!(
        old_bytes,
        include_bytes!("fixtures/source-import/triangle.stl")
    );
    let retry = svc
        .admit(
            credential(&owner),
            request("one", create("One")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(retry, first);
    svc.admit(
        credential(&owner),
        request(
            "unchanged",
            Target::Existing {
                source_id: first.source_id,
            },
        ),
        &files,
        &AtomicBool::new(false),
    )
    .unwrap();
    let unchanged = svc
        .work_next(Some(&files), Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(
        unchanged.receipt.as_ref().unwrap().revision_id,
        first.receipt.as_ref().unwrap().revision_id
    );
    assert_eq!(count(&root, "source_revisions"), 1);
    std::fs::write(
        files.join("triangle.stl"),
        String::from_utf8(old_bytes.clone())
            .unwrap()
            .replace("vertex 1 0 0", "vertex 2 0 0"),
    )
    .unwrap();
    svc.admit(
        credential(&owner),
        request(
            "two",
            Target::Existing {
                source_id: first.source_id,
            },
        ),
        &files,
        &AtomicBool::new(false),
    )
    .unwrap();
    let second = svc
        .work_next(Some(&files), Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_ne!(
        second.artifact.as_ref().unwrap().upstream_key,
        old.upstream_key
    );
    assert_eq!(count(&root, "source_revisions"), 2);
    assert_eq!(svc.get(credential(&owner), "one".into()).unwrap(), first);
    let current: i64 = read(&root)
        .query_row(
            "SELECT current_source_revision_id FROM projects WHERE id=?1",
            [first.source_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(current, second.receipt.unwrap().revision_id);
    assert_eq!(
        std::fs::read(root.join("repos").join(&old.locator).join("triangle.stl")).unwrap(),
        old_bytes
    );
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete {
                id: first.source_id
            })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::RetainedHistory)
    ));
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn restart_each_durable_fact_and_exact_activation_acknowledgement() {
    for through in [
        None,
        Some(Through::OwnedInput),
        Some(Through::Published),
        Some(Through::Activated),
    ] {
        let (root, files, owner) = fixture();
        let svc = service(&owner);
        let admitted = svc
            .admit(
                credential(&owner),
                request("restart", create("Restart")),
                &files,
                &AtomicBool::new(false),
            )
            .unwrap();
        let before = through.map(|t| {
            svc.work_next(Some(&files), t, &AtomicBool::new(false))
                .unwrap()
                .unwrap()
        });
        assert!(matches!(
            owner
                .local_source_catalog()
                .execute(catalog::Request::Delete {
                    id: admitted.source_id
                })
                .unwrap(),
            catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
        ));
        drop(svc);
        owner.shutdown().unwrap();
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        let svc = service(&owner);
        assert!(matches!(
            owner
                .local_source_catalog()
                .execute(catalog::Request::Delete {
                    id: admitted.source_id
                })
                .unwrap(),
            catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
        ));
        let resumed = svc
            .work_next(
                if through.is_none() {
                    Some(&files)
                } else {
                    None
                },
                Through::Settled,
                &AtomicBool::new(false),
            )
            .unwrap()
            .unwrap();
        assert_eq!(resumed.source_id, admitted.source_id);
        assert!(resumed.cleanup_settled);
        if let Some(receipt) = before.and_then(|o| o.receipt) {
            assert_eq!(resumed.receipt.unwrap(), receipt);
        }
        assert_eq!(count(&root, "source_revisions"), 1);
        assert_eq!(
            read(&root)
                .query_row(
                    "SELECT SUM(reserved_bytes) FROM source_import_quota",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(svc);
        owner.shutdown().unwrap();
    }
}
#[test]
fn metadata_cas_conflict_keeps_inactive_revision() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let op = svc
        .admit(
            credential(&owner),
            request("conflict", create("Conflict")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    svc.work_next(Some(&files), Through::Published, &AtomicBool::new(false))
        .unwrap();
    owner
        .local_source_catalog()
        .execute(catalog::Request::Update {
            id: op.source_id,
            patch: SourcePatch {
                branch: Some("newer".into()),
                ..Default::default()
            },
        })
        .unwrap();
    drop(svc);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    let result = svc
        .work_next(None, Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(result.state, State::Conflict);
    assert!(!result.receipt.as_ref().unwrap().activated);
    assert_eq!(
        result.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::NotActivated
    );
    assert_eq!(count(&root, "source_revisions"), 1);
    let row: (String, Option<i64>) = read(&root)
        .query_row(
            "SELECT branch,current_source_revision_id FROM projects WHERE id=?1",
            [op.source_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("newer".into(), None));
    assert_eq!(count(&root, "source_docs"), 0);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn quota_atomic_admission_missing_duplicate_cancelled_and_unsupported() {
    let (root, files, owner) = fixture();
    let tiny = SourceImports::new(&owner, policy(), 1024).unwrap();
    assert!(
        tiny.admit(
            credential(&owner),
            request("tiny", create("Tiny")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(count(&root, "projects"), 0);
    drop(tiny);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = SourceImports::new(&owner, policy(), 30 * 1024 * 1024).unwrap();
    assert!(
        svc.admit(
            credential(&owner),
            request("missing", Target::Existing { source_id: 999 }),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        svc.admit(
            credential(&owner),
            request("cancelled", create("Cancelled")),
            &files,
            &AtomicBool::new(true)
        )
        .is_err()
    );
    let one = svc
        .admit(
            credential(&owner),
            request("one", create("One")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        svc.admit(
            credential(&owner),
            request("two", create("Two")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let other_token = match auth_call(
        &owner,
        policy(),
        auth::Request::Register {
            email: "other-tenant@example.test".into(),
            display_name: "Other tenant".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { token, .. } => token,
        _ => panic!("session"),
    };
    assert!(
        svc.admit(
            Credential::Session(other_token),
            request("other-tenant", create("Other tenant")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(count(&root, "projects"), 1);
    assert_eq!(count(&root, "source_import_quota"), 1);
    assert_eq!(count(&root, "durable_jobs"), 1);
    let revisions = root
        .join("repos")
        .join(one.source_id.to_string())
        .join("revisions");
    for candidate in [
        ".pp-source-archives/.candidate",
        ".pp-source-media/.candidate",
        ".pp-source-candidate",
    ] {
        let path = revisions.join(candidate);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("ordinary.txt"), "ordinary pending staging").unwrap();
    }
    cancel(&owner, one.job_id);
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete { id: one.source_id })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    let cancelled = svc
        .work_next(None, Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(cancelled.state, State::Cancelled);
    assert!(cancelled.cleanup_settled);
    assert!(cancelled.receipt.is_none());
    for candidate in [
        ".pp-source-archives/.candidate",
        ".pp-source-media/.candidate",
        ".pp-source-candidate",
    ] {
        assert!(!revisions.join(candidate).exists());
    }
    assert!(
        svc.admit(
            credential(&owner),
            request("duplicate", create("One")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    std::fs::write(files.join("notes.txt"), "ordinary unsupported text").unwrap();
    let mut unsupported = request("unsupported", create("Unsupported"));
    unsupported.input = Input::Files {
        paths: vec!["notes.txt".into()],
    };
    let op = svc
        .admit(
            credential(&owner),
            unsupported,
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        svc.work_next(Some(&files), Through::Settled, &AtomicBool::new(false))
            .is_err()
    );
    let failed = svc.get(credential(&owner), op.key).unwrap();
    assert_eq!(failed.state, State::Failed);
    assert!(failed.cleanup_settled);
    assert_eq!(
        std::fs::read_to_string(files.join("notes.txt")).unwrap(),
        "ordinary unsupported text"
    );
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn stale_attempt_cannot_write_import_phases() {
    let (_root, files, owner) = fixture();
    let svc = service(&owner);
    let op = svc
        .admit(
            credential(&owner),
            request("stale", create("Stale")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let worker = owner
        .job_worker(jobs::WorkerAdmission {
            kinds: vec![(jobs::JobKind::SuppliedSourceImport, 1)],
            total: 1,
            per_resource: 1,
            lease_seconds: 3600,
        })
        .unwrap();
    let mut claim = worker.claim().unwrap().unwrap();
    let lease = claim.lease;
    cancel(&owner, op.job_id);
    assert!(worker.import_phase(&lease, Phase::Read).is_err());
    assert!(
        worker
            .begin_source_work(
                &lease,
                None,
                &AtomicBool::new(false),
                Duration::from_secs(5)
            )
            .is_err()
    );
    drop(claim.source_work.take());
    let done = svc
        .work_next(None, Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(done.state, State::Cancelled);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn cancelled_import_cannot_overlap_source_work() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let op = svc
        .admit(
            credential(&owner),
            request("overlap", create("Overlap")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let worker = owner
        .job_worker(jobs::WorkerAdmission {
            kinds: vec![(jobs::JobKind::SuppliedSourceImport, 1)],
            total: 1,
            per_resource: 1,
            lease_seconds: 3600,
        })
        .unwrap();
    let first = worker.claim_import(&op.job_id).unwrap().unwrap();
    let source = first.source_work.unwrap();
    let owned = root.join("repos/.pp-imports").join(&op.job_id);
    std::fs::create_dir_all(&owned).unwrap();
    std::fs::write(owned.join("held.txt"), "held by the fenced attempt").unwrap();
    cancel(&owner, op.job_id.clone());
    let before = durable_job(&owner, &op.job_id);
    let error =
        match svc.work_operation(&op.job_id, None, Through::Settled, &AtomicBool::new(false)) {
            Err(error) => error,
            Ok(_) => panic!("cancelled import reclaimed an active Source"),
        };
    assert!(
        error
            .downcast_ref::<pp_storage::catalog::SourceBusy>()
            .is_some()
    );
    let after = durable_job(&owner, &op.job_id);
    assert_eq!(after.state_version, before.state_version);
    assert_eq!(after.attempt, before.attempt);
    assert_eq!(after.generation, before.generation);
    assert!(owned.join("held.txt").exists());
    drop(source);
    let cancelled = svc
        .work_operation(&op.job_id, None, Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(cancelled.state, State::Cancelled);
    assert!(!owned.exists());
    drop(svc);
    owner.shutdown().unwrap();
}
fn auth_call(owner: &WriterOwner, p: AuthPolicy, r: auth::Request) -> auth::Outcome {
    owner
        .auth_with_policy(p)
        .unwrap()
        .submit(r, Arc::new(AtomicBool::new(false)), Duration::from_secs(5))
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
}
#[test]
fn real_session_policy_key_actor_replay_revocation_and_atomic_audit() {
    let (root, files, owner) = fixture();
    let strict = AuthPolicy {
        registration: RegistrationPolicy::FirstAccountOnly,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
        first_user: FirstUserTenant::NewUser,
    };
    let (user, token) = match auth_call(
        &owner,
        strict,
        auth::Request::Register {
            email: "source@example.test".into(),
            display_name: "Source user".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { user, token } => (user, token.expose().to_owned()),
        _ => panic!("session"),
    };
    let svc = SourceImports::new(&owner, strict, 128 * 1024 * 1024).unwrap();
    let admitted = svc
        .admit(
            Credential::Session(Secret::new(token.clone())),
            request("session", create("Session")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let activated = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(activated.state, State::Activated);
    assert_eq!(admitted.tenant, "default");
    assert_eq!(admitted.actor, format!("user:{}", user.user_id));
    assert!(svc.get(credential(&owner), "session".into()).is_err());
    assert!(
        svc.admit(
            credential(&owner),
            request("session", create("Session")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        svc.admit(
            Credential::Session(Secret::new(token.clone())),
            request("session", create("Different intent")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let neutral = SourceImports::new(&owner, policy(), 128 * 1024 * 1024).unwrap();
    assert!(
        neutral
            .get(
                Credential::Session(Secret::new(token.clone())),
                "session".into()
            )
            .is_err()
    );
    let (key_id, key) = match auth_call(
        &owner,
        strict,
        auth::Request::CreateKey {
            session: Secret::new(token.clone()),
        },
    ) {
        auth::Outcome::KeyCreated { info, key } => (info.id, key.expose().to_owned()),
        _ => panic!("key"),
    };
    let before: Option<String> = read(&root)
        .query_row(
            "SELECT json_extract(value,'$[0].lastUsedAt') FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1' AND ?1 IS NOT NULL",
            [&key_id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        svc.admit(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key.clone())
            },
            request("bad-key-import", Target::Existing { source_id: 999 }),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let after: Option<String> = read(&root)
        .query_row(
            "SELECT json_extract(value,'$[0].lastUsedAt') FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1' AND ?1 IS NOT NULL",
            [&key_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
    assert!(
        svc.admit(
            Credential::RoutedKey {
                tenant: user.user_id.clone(),
                key: Secret::new(key.clone())
            },
            request("wrong-route", create("Wrong")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let keyed = svc
        .admit(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key.clone()),
            },
            request("key", create("Key")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(
        svc.work_operation(
            &keyed.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false)
        )
        .unwrap()
        .unwrap()
        .state,
        State::Activated
    );
    assert_ne!(keyed.actor, admitted.actor);
    assert!(
        svc.get(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key.clone())
            },
            "session".into()
        )
        .is_err()
    );
    auth_call(
        &owner,
        strict,
        auth::Request::RevokeKey {
            session: Secret::new(token.clone()),
            key_id,
        },
    );
    assert!(
        svc.get(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key)
            },
            "key".into()
        )
        .is_err()
    );
    auth_call(
        &owner,
        strict,
        auth::Request::Logout {
            token: Secret::new(token.clone()),
        },
    );
    assert!(
        svc.get(Credential::Session(Secret::new(token)), "session".into())
            .is_err()
    );
    drop(neutral);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn changed_content_replay_and_changed_during_capture_are_refused() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let first = svc
        .admit(
            credential(&owner),
            request("bound", create("Bound")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let original = std::fs::read(files.join("triangle.stl")).unwrap();
    std::fs::write(
        files.join("triangle.stl"),
        String::from_utf8(original.clone())
            .unwrap()
            .replace("vertex 1 0 0", "vertex 3 0 0"),
    )
    .unwrap();
    assert!(
        svc.admit(
            credential(&owner),
            request("bound", create("Bound")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        svc.work_next(Some(&files), Through::Settled, &AtomicBool::new(false))
            .is_err()
    );
    let failed = svc.get(credential(&owner), first.key).unwrap();
    assert_eq!(failed.state, State::Failed);
    assert_eq!(count(&root, "source_revisions"), 0);
    assert!(failed.cleanup_settled);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn schema36_backup_preserves35_and_future_or_corrupt_input_is_unchanged() {
    let (root, _files, owner) = fixture();
    owner.shutdown().unwrap();
    let db = root.join("print-partner.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("DROP TABLE source_import_quota; DROP TABLE source_import_operations; UPDATE app_settings SET value='35' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    drop(conn);
    let before =
        graph(&Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap());
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.previous_version, 35);
    assert_eq!(
        graph(
            &Connection::open_with_flags(ready.backup.unwrap(), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap()
        ),
        before
    );
    owner.shutdown().unwrap();
    Connection::open(&db)
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let future = temp();
    std::fs::copy(&db, future.join("print-partner.db")).unwrap();
    let conn = Connection::open(future.join("print-partner.db")).unwrap();
    conn.execute(
        "UPDATE app_settings SET value='37' WHERE tenant_id='default' AND key='schema_version'",
        [],
    )
    .unwrap();
    drop(conn);
    let bytes = std::fs::read(future.join("print-partner.db")).unwrap();
    assert!(WriterOwner::open(&future, Limits::default()).is_err());
    assert_eq!(
        std::fs::read(future.join("print-partner.db")).unwrap(),
        bytes
    );
    assert!(!future.join(".desktop-owner.json").exists());
    let corrupt = temp();
    std::fs::copy(&db, corrupt.join("print-partner.db")).unwrap();
    let conn = Connection::open(corrupt.join("print-partner.db")).unwrap();
    conn.execute("DROP INDEX source_import_source", []).unwrap();
    drop(conn);
    let bytes = std::fs::read(corrupt.join("print-partner.db")).unwrap();
    assert!(WriterOwner::open(&corrupt, Limits::default()).is_err());
    assert_eq!(
        std::fs::read(corrupt.join("print-partner.db")).unwrap(),
        bytes
    );
    assert!(!corrupt.join(".desktop-owner.json").exists());
}

fn graph(conn: &Connection) -> Vec<(String, Vec<String>)> {
    let tables = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    tables
        .into_iter()
        .map(|table| {
            let mut query = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
            let n = query.column_count();
            let mut rows = query
                .query_map([], |r| {
                    let values = (0..n)
                        .map(|i| r.get::<_, rusqlite::types::Value>(i))
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(format!("{values:?}"))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            rows.sort();
            (table, rows)
        })
        .collect()
}
#[test]
fn settlement_invalidates_stale_physical_usage_observation() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("first", create("First")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let client = owner.imports(policy(), 128 * 1024 * 1024).unwrap();
    let stale = client.accounting_epoch();
    let old_bytes = pp_source::local_selection::stored_bytes(&root.join("repos")).unwrap();
    svc.work_next(Some(&files), Through::Settled, &AtomicBool::new(false))
        .unwrap();
    assert!(
        client
            .admit(
                credential(&owner),
                request("second", create("Second")),
                admitted.requested_files.clone(),
                old_bytes,
                stale,
                &AtomicBool::new(false)
            )
            .is_err()
    );
    assert_eq!(count(&root, "projects"), 1);
    let epoch = client.accounting_epoch();
    let bytes = pp_source::local_selection::stored_bytes(&root.join("repos")).unwrap();
    client
        .admit(
            credential(&owner),
            request("second", create("Second")),
            admitted.requested_files,
            bytes,
            epoch,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(count(&root, "projects"), 2);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn import_reads_do_not_invalidate_physical_usage_observation() {
    let (_root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("read-only", create("Read only")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let client = owner.imports(policy(), 128 * 1024 * 1024).unwrap();
    let observed = client.accounting_epoch();

    svc.get(credential(&owner), admitted.key.clone()).unwrap();
    assert_eq!(client.accounting_epoch(), observed);

    let worker = owner
        .job_worker(WorkerAdmission {
            kinds: vec![(JobKind::SuppliedSourceImport, 1)],
            total: 1,
            per_resource: 1,
            lease_seconds: 3600,
        })
        .unwrap();
    let claim = worker.claim_import(&admitted.job_id).unwrap().unwrap();
    let lease = claim.lease;
    worker.import_phase(&lease, Phase::Read).unwrap();
    assert_eq!(client.accounting_epoch(), observed);

    drop(claim.source_work);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn published_import_resumes_after_repaired_error_and_restart() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("published-retry", create("Published retry")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let published = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Published,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    let artifact = published.artifact.as_ref().unwrap();
    let file = &artifact.files[0];
    let path = root.join("repos").join(&artifact.locator).join(&file.path);
    let contents = std::fs::read(&path).unwrap();
    drop(svc);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    std::fs::write(&path, b"damaged after publication").unwrap();

    assert!(
        svc.work_operation(
            &admitted.job_id,
            None,
            Through::Settled,
            &AtomicBool::new(false),
        )
        .is_err()
    );
    std::fs::write(&path, contents).unwrap();
    let retained = svc.get(credential(&owner), admitted.key.clone()).unwrap();
    assert_eq!(retained.state, State::Published);
    assert!(!retained.cleanup_settled);
    assert_eq!(count(&root, "source_revisions"), 0);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT reserved_bytes FROM source_import_quota WHERE operation_key=?1 AND settled=0",
                [&admitted.key],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        i64::try_from(admitted.reserved_bytes).unwrap()
    );

    drop(svc);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    let resumed = svc
        .work_operation(
            &admitted.job_id,
            None,
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(resumed.state, State::Activated);
    assert!(resumed.cleanup_settled);
    assert_eq!(count(&root, "source_revisions"), 1);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT reserved_bytes FROM source_import_quota WHERE operation_key=?1 AND settled=1",
                [&admitted.key],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn cancellation_after_activation_preserves_receipt_and_settles_cleanup() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    svc.admit(
        credential(&owner),
        request("activated", create("Activated")),
        &files,
        &AtomicBool::new(false),
    )
    .unwrap();
    let activated = svc
        .work_next(Some(&files), Through::Activated, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    cancel(&owner, activated.job_id);
    let settled = svc
        .work_next(None, Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(settled.receipt, activated.receipt);
    assert_eq!(settled.state, State::Activated);
    assert!(settled.cleanup_settled);
    assert_eq!(count(&root, "source_revisions"), 1);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn public_import_selects_its_own_job_and_directory_content() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let other = svc
        .admit(
            credential(&owner),
            request("other", create("Other")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let mut req = request("public", create("Public"));
    req.input = SourceImports::directory_input(&files).unwrap();
    let op = svc
        .import(credential(&owner), req, &files, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(op.key, "public");
    assert_eq!(op.state, State::Activated);
    let pending = svc.get(credential(&owner), other.key).unwrap();
    assert_eq!(pending.state, State::Admitted);
    assert_eq!(count(&root, "source_revisions"), 1);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn index_constraint_keeps_activation_receipt_and_previous_complete_doc_projection() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let first = svc
        .import(
            credential(&owner),
            request("initial", create("Docs")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let old_docs = read(&root)
        .prepare("SELECT id,path,content_hash FROM source_docs")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(svc);
    owner.shutdown().unwrap();
    let conn = Connection::open(root.join("print-partner.db")).unwrap();
    conn.execute_batch("CREATE TRIGGER ordinary_doc_constraint BEFORE INSERT ON source_docs WHEN NEW.path='README.md' BEGIN SELECT RAISE(ABORT,'ordinary document constraint'); END;").unwrap();
    drop(conn);
    std::fs::write(files.join("README.md"), "# Updated document\n").unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    let op = svc
        .import(
            credential(&owner),
            request(
                "update",
                Target::Existing {
                    source_id: first.source_id,
                },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(op.state, State::Activated);
    assert_eq!(
        op.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::IndexError
    );
    let docs = read(&root)
        .prepare("SELECT id,path,content_hash FROM source_docs")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(old_docs, docs);
    assert_eq!(
        svc.get(credential(&owner), op.key.clone()).unwrap().receipt,
        op.receipt
    );
    drop(svc);
    owner.shutdown().unwrap();
}

fn progress_history_fixture() -> (PathBuf, PathBuf, WriterOwner) {
    let root = temp();
    std::fs::write(
        root.join("print-partner.db"),
        include_bytes!("../../pp-storage/tests/fixtures/required-units/shrink.db"),
    )
    .unwrap();
    let repos = root.join("repos/1/revisions/fixture");
    std::fs::create_dir_all(&repos).unwrap();
    for name in ["bracket", "gear", "excluded"] {
        std::fs::write(repos.join(format!("{name}.stl")), format!("solid {name}")).unwrap();
    }
    let files = root.join("supplied");
    std::fs::create_dir(&files).unwrap();
    std::fs::write(
        files.join("triangle.stl"),
        include_bytes!("fixtures/source-import/triangle.stl"),
    )
    .unwrap();
    std::fs::write(files.join("README.md"), "# Changed Source\n").unwrap();
    let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
    (root, files, owner)
}
fn progress_secret() -> Secret {
    Secret::new("required-unit-fixture-secret".into())
}
fn select_progress(owner: &WriterOwner) -> serde_json::Value {
    let case: serde_json::Value = serde_json::from_str(include_str!(
        "../../pp-storage/tests/fixtures/required-units/shrink.json"
    ))
    .unwrap();
    let command = pp_storage::required_units::ReconciliationCommand::new(
        serde_json::from_value(serde_json::json!(1)).unwrap(),
        serde_json::from_value(serde_json::json!(2)).unwrap(),
        serde_json::from_value(case["request"].clone()).unwrap(),
        "source-progress-selection".into(),
        pp_storage::read_model::Credential::Session(progress_secret()),
    )
    .unwrap();
    serde_json::to_value(
        owner
            .required_units()
            .reconcile(command, &AtomicBool::new(false), Duration::from_secs(5))
            .unwrap(),
    )
    .unwrap()
}
fn complete_progress(owner: &WriterOwner) {
    let response = owner
        .checkoff_progress()
        .apply(
            catalog::Credentials::Session(progress_secret()),
            pp_storage::checkoff_progress::Request::CompletionCoordinate {
                part_id: 1,
                body: serde_json::json!({"unit_index":1,"completed":true}),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(response.status, 200);
}
fn pinned_accepted(owner: &WriterOwner) -> serde_json::Value {
    let batch = owner
        .accepted_reads()
        .read(
            pp_storage::read_model::Credential::Session(progress_secret()),
            &[1],
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    let accepted = serde_json::to_value(&batch.builds[0].accepted).unwrap();
    assert_eq!(accepted["kind"], "ready");
    accepted
}
#[test]
fn combined_pending_import_allows_progress_and_selection_then_preserves_pinned_history() {
    let (root, files, owner) = progress_history_fixture();
    let key = match auth_call(
        &owner,
        policy(),
        auth::Request::CreateKey {
            session: progress_secret(),
        },
    ) {
        auth::Outcome::KeyCreated { key, .. } => key.expose().to_owned(),
        _ => panic!("key"),
    };
    let key_credential = || Credential::RoutedKey {
        tenant: "default".into(),
        key: Secret::new(key.clone()),
    };
    let svc = service(&owner);
    let op = svc
        .admit(
            key_credential(),
            request("combined", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(op.actor.starts_with("key:"));
    assert!(!op.cleanup_settled);
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete { id: 1 })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    assert!(
        owner
            .jobs(policy())
            .unwrap()
            .submit(
                credential(&owner),
                jobs::UserOperation::Enqueue {
                    key: "generic-import".into(),
                    payload_version: 1,
                    payload: jobs::Payload::SuppliedSourceImport {
                        project_id: 1,
                        operation_key: "bypass".into(),
                        input_version: 1
                    },
                },
                &AtomicBool::new(false),
                Duration::from_secs(5)
            )
            .is_err()
    );
    complete_progress(&owner);
    let selected = select_progress(&owner);
    assert_eq!(selected["kind"], "ready");
    let accepted = pinned_accepted(&owner);
    let before = graph(&read(&root));
    let old_bytes = std::fs::read(root.join("repos/1/revisions/fixture/bracket.stl")).unwrap();
    let completed = svc
        .work_operation(
            &op.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        completed.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::DocumentMetadataIndexed
    );
    assert!(completed.receipt.as_ref().unwrap().activated && completed.cleanup_settled);
    assert_ne!(completed.receipt.as_ref().unwrap().revision_id, 1);
    assert_eq!(pinned_accepted(&owner), accepted);
    assert_eq!(select_progress(&owner), selected);
    let after = graph(&read(&root));
    for (table, rows) in &before {
        if table.starts_with("plan_")
            || table.starts_with("accepted_")
            || ["parts", "required_units", "print_progress"].contains(&table.as_str())
        {
            assert_eq!(
                &after.iter().find(|(name, _)| name == table).unwrap().1,
                rows,
                "{table}"
            );
        }
    }
    assert_eq!(
        std::fs::read(root.join("repos/1/revisions/fixture/bracket.stl")).unwrap(),
        old_bytes
    );
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT COUNT(*) FROM source_docs WHERE project_id=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert!(read(&root).query_row("SELECT json_extract(value,'$[0].lastUsedAt') FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1'", [], |r| r.get::<_,Option<String>>(0)).unwrap().is_some());
    assert_eq!(
        svc.get(key_credential(), "combined".into()).unwrap(),
        completed
    );
    drop(svc);
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
    assert_eq!(pinned_accepted(&owner), accepted);
    assert_eq!(select_progress(&owner), selected);
    let svc = service(&owner);
    assert_eq!(
        svc.get(key_credential(), "combined".into()).unwrap(),
        completed
    );
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn combined_schema36_backup_preserves_selected_progress_and_jobs35_graph() {
    let (root, _, owner) = progress_history_fixture();
    complete_progress(&owner);
    let selected = select_progress(&owner);
    owner
        .jobs(policy())
        .unwrap()
        .submit(
            credential(&owner),
            jobs::UserOperation::Enqueue {
                key: "prior35".into(),
                payload_version: 1,
                payload: jobs::Payload::ImportScan { project_id: 1 },
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
    owner.shutdown().unwrap();
    let preparation_backup = root.join("fixture-preparation-backup.db");
    std::fs::rename(root.join("backups/pre-schema36.db"), &preparation_backup).unwrap();
    let preparation_bytes = std::fs::read(&preparation_backup).unwrap();
    let db = root.join("print-partner.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("DROP TABLE source_import_quota; DROP TABLE source_import_operations; UPDATE app_settings SET value='35' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let before = graph(&conn);
    drop(conn);
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.previous_version, 35);
    assert_eq!(ready.version, 36);
    let backup_copy = root.join("backup-copy.db");
    std::fs::copy(ready.backup.unwrap(), &backup_copy).unwrap();
    assert_eq!(graph(&Connection::open(backup_copy).unwrap()), before);
    assert_eq!(select_progress(&owner), selected);
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete { id: 1 })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    assert_eq!(count(&root, "source_import_operations"), 0);
    assert_eq!(count(&root, "durable_jobs"), 1);
    owner.shutdown().unwrap();
    assert_eq!(
        std::fs::read(preparation_backup).unwrap(),
        preparation_bytes
    );
}
#[test]
fn combined_obsolete_receipt_refuses_without_changing_progress_history() {
    let (root, files, owner) = progress_history_fixture();
    complete_progress(&owner);
    assert_eq!(select_progress(&owner)["kind"], "ready");
    let svc = service(&owner);
    svc.import(
        credential(&owner),
        request("obsolete", Target::Existing { source_id: 1 }),
        &files,
        &AtomicBool::new(false),
    )
    .unwrap();
    drop(svc);
    owner.shutdown().unwrap();
    let conn = Connection::open(root.join("print-partner.db")).unwrap();
    conn.execute("UPDATE source_import_operations SET document=json_set(document,'$.receipt.postprocessing','complete')", []).unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(conn);
    let before = std::fs::read(root.join("print-partner.db")).unwrap();
    assert!(WriterOwner::open(&root, Limits::default()).is_err());
    assert_eq!(
        std::fs::read(root.join("print-partner.db")).unwrap(),
        before
    );
    assert!(!root.join(".desktop-owner.json").exists());
}

#[test]
fn combined_owner_quota_crosses_tenants_while_local_progress_remains_available() {
    let (root, files, owner) = progress_history_fixture();
    let svc = SourceImports::new(&owner, policy(), 30 * 1024 * 1024).unwrap();
    let token = match auth_call(
        &owner,
        policy(),
        auth::Request::Register {
            email: "shared-capacity@example.test".into(),
            display_name: "Other tenant".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { token, .. } => token.expose().to_owned(),
        _ => panic!("session"),
    };
    let foreign = || Credential::Session(Secret::new(token.clone()));
    let pending = svc
        .admit(
            credential(&owner),
            request("pending-default", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        svc.admit(
            foreign(),
            request("foreign", create("Foreign")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(count(&root, "source_import_quota"), 1);
    complete_progress(&owner);
    let selected = select_progress(&owner);
    assert_eq!(selected["kind"], "ready");
    let first = svc
        .work_operation(
            &pending.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    let reused = svc
        .import(
            credential(&owner),
            request("reuse", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(
        reused.receipt.as_ref().unwrap().revision_id,
        first.receipt.as_ref().unwrap().revision_id
    );
    let other = svc
        .admit(
            foreign(),
            request("foreign", create("Foreign")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_ne!(other.tenant, first.tenant);
    assert_eq!(select_progress(&owner), selected);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT SUM(reserved_bytes) FROM source_import_quota WHERE settled=0",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        20 * 1024 * 1024
    );
    assert!(svc.get(foreign(), "pending-default".into()).is_err());
    svc.work_operation(
        &other.job_id,
        Some(&files),
        Through::Settled,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    assert_eq!(select_progress(&owner), selected);
    drop(svc);
    owner.shutdown().unwrap();
}
