use pp_core::{
    source_acquisition::{CaptureRequest, CapturedFile, SourceAcquisitions},
    uploads::SourceImports,
};
use pp_source::SourcePath;
use pp_storage::{
    Limits, Setting, SettingCommand, SettingsClient, WriterOwner,
    auth::{
        AuthClient, AuthPolicy, FirstUserTenant, Outcome as AuthOutcome, RegistrationPolicy,
        Request as AuthRequest, Secret, SessionTenantPolicy,
    },
    catalog::{CreateSource, Deletion, Outcome as CatalogOutcome, Request as CatalogRequest},
    jobs::Credential,
    uploads::{AdmissionLimits, CaptureId, CapturedPayloadV1, File, Target},
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}

struct ControlledFailureReader {
    started: Option<mpsc::Sender<()>>,
    release: mpsc::Receiver<()>,
}

impl Read for ControlledFailureReader {
    fn read(&mut self, _output: &mut [u8]) -> std::io::Result<usize> {
        if let Some(started) = self.started.take() {
            started.send(()).unwrap();
            self.release.recv().unwrap();
        }
        Err(std::io::Error::other("controlled reader failure"))
    }
}

fn temporary_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "pp-source-acquisition-regression-{name}-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn open_owner(root: &Path) -> WriterOwner {
    WriterOwner::open(root, Limits::default()).unwrap().0
}

fn auth_call(client: &AuthClient, request: AuthRequest) -> anyhow::Result<AuthOutcome> {
    client
        .submit(
            request,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )?
        .recv()
        .unwrap()
}

fn register(client: &AuthClient, name: &str) -> (String, String) {
    let AuthOutcome::Session { user, token } = auth_call(
        client,
        AuthRequest::Register {
            email: format!("{name}@example.com"),
            display_name: name.into(),
            password: Secret::new("password-before".into()),
        },
    )
    .unwrap() else {
        panic!("registration did not return a session")
    };
    (user.tenant_id, token.expose().to_owned())
}

fn limits() -> AdmissionLimits {
    AdmissionLimits {
        reserved_bytes: 20 * 1024 * 1024,
        max_input_bytes: 64 * 1024,
        max_prepared_bytes: 64 * 1024,
    }
}

fn create_target(name: &str) -> Target {
    Target::Create {
        metadata: Box::new(CreateSource {
            name: name.into(),
            source_kind: Some("local".into()),
            source_type: Some("local".into()),
            ..Default::default()
        }),
    }
}

fn request(
    credential: Credential,
    key: &str,
    target: Target,
    input: Box<dyn Read + Send>,
) -> CaptureRequest {
    CaptureRequest {
        credential,
        operation_key: key.into(),
        target,
        payload: CapturedPayloadV1::files(vec!["triangle.stl".into()]),
        limits: limits(),
        files: vec![CapturedFile {
            path: SourcePath::try_from("triangle.stl".to_owned()).unwrap(),
            input,
        }],
    }
}

fn retained_capture_count(root: &Path) -> usize {
    std::fs::read_dir(root.join("source-captures")).map_or(0, |entries| entries.count())
}

fn rewrite_owned_key(
    storage: &SettingsClient,
    tenant: &str,
    key_id: &str,
    rewrite: impl FnOnce(&mut Value),
) -> anyhow::Result<()> {
    let reader = storage.reader(Duration::from_secs(5))?;
    let raw = reader
        .get_setting(tenant, "api_keys_v1", None)?
        .ok_or_else(|| anyhow::anyhow!("owned API key collection missing"))?;
    drop(reader);
    let mut collection: Value = serde_json::from_str(&raw)?;
    let keys = collection
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("owned API key collection is not an array"))?;
    let key = keys
        .iter_mut()
        .find(|key| key.get("id").and_then(Value::as_str) == Some(key_id))
        .ok_or_else(|| anyhow::anyhow!("owned API key missing"))?;
    let key_hash = key
        .get("keyHash")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("owned API key hash missing"))?
        .to_owned();
    rewrite(key);
    anyhow::ensure!(
        key.get("keyHash").and_then(Value::as_str) == Some(key_hash.as_str()),
        "owned API key rewrite changed its hash"
    );
    storage
        .submit(
            SettingCommand::Set(Setting {
                tenant: tenant.to_owned(),
                key: "api_keys_v1".into(),
                value: serde_json::to_string(&collection)?,
            }),
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .recv()
        .map_err(|_| anyhow::anyhow!("owned API key rewrite reply dropped"))??;
    Ok(())
}

fn assert_no_durable_import_journal_attempt_fence_or_lease(
    owner: &WriterOwner,
    session: &str,
    operation_key: &str,
) -> anyhow::Result<()> {
    let imports = SourceImports::new(owner, policy(), 128 * 1024 * 1024)?;
    let error = match imports.get(
        Credential::Session(Secret::new(session.to_owned())),
        operation_key.to_owned(),
    ) {
        Ok(_) => panic!("refused capture created a durable import"),
        Err(error) => error,
    };
    anyhow::ensure!(
        format!("{error:#}").contains("Import not found"),
        "unexpected durable-import lookup result"
    );
    Ok(())
}

struct ActionReader {
    bytes: Cursor<Vec<u8>>,
    action: Option<Box<dyn FnOnce() -> anyhow::Result<()> + Send>>,
    observation: Option<Arc<ReadObservation>>,
}

impl ActionReader {
    fn new(action: impl FnOnce() -> anyhow::Result<()> + Send + 'static) -> Self {
        Self {
            bytes: Cursor::new(include_bytes!("fixtures/source-import/triangle.stl").to_vec()),
            action: Some(Box::new(action)),
            observation: None,
        }
    }

    fn observed(
        action: impl FnOnce() -> anyhow::Result<()> + Send + 'static,
        observation: Arc<ReadObservation>,
    ) -> Self {
        Self {
            bytes: Cursor::new(include_bytes!("fixtures/source-import/triangle.stl").to_vec()),
            action: Some(Box::new(action)),
            observation: Some(observation),
        }
    }
}

impl Read for ActionReader {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if let Some(action) = self.action.take() {
            action().map_err(std::io::Error::other)?;
        }
        let read = self.bytes.read(output)?;
        if let Some(observation) = &self.observation {
            observation.calls.fetch_add(1, Ordering::AcqRel);
            observation.bytes.fetch_add(read, Ordering::AcqRel);
        }
        Ok(read)
    }
}

#[derive(Default)]
struct ReadObservation {
    calls: AtomicUsize,
    bytes: AtomicUsize,
}

struct ErrorAfterChunk {
    returned_chunk: bool,
}

impl Read for ErrorAfterChunk {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if self.returned_chunk {
            return Err(std::io::Error::other("ordinary reader failure"));
        }
        self.returned_chunk = true;
        let bytes = b"first chunk";
        output[..bytes.len()].copy_from_slice(bytes);
        Ok(bytes.len())
    }
}

struct CountingReader {
    reads: Arc<AtomicUsize>,
    bytes: Cursor<Vec<u8>>,
}

impl Read for CountingReader {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        self.reads.fetch_add(1, Ordering::AcqRel);
        self.bytes.read(output)
    }
}

fn run_revoked_session_case() -> bool {
    let root = temporary_root("revoked-session");
    let owner = open_owner(&root);
    let auth = owner.auth(FirstUserTenant::NewUser);
    let (_, token) = register(&auth, "revoked-session");
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let revoke_auth = auth.clone();
    let revoke_token = token.clone();
    let reply = acquisitions.acquire(
        request(
            Credential::Session(Secret::new(token)),
            "revoked-session",
            create_target("Revoked session"),
            Box::new(ActionReader::new(move || {
                let outcome = auth_call(
                    &revoke_auth,
                    AuthRequest::Logout {
                        token: Secret::new(revoke_token),
                    },
                )?;
                anyhow::ensure!(matches!(outcome, AuthOutcome::Changed(true)));
                Ok(())
            })),
        ),
        &AtomicBool::new(false),
    );
    let _reply_result = reply.and_then(|reply| reply.wait());
    let AuthOutcome::Session {
        token: replacement, ..
    } = auth_call(
        &auth,
        AuthRequest::Login {
            email: "revoked-session@example.com".into(),
            password: Secret::new("password-before".into()),
        },
    )
    .unwrap()
    else {
        panic!("login did not return a replacement session")
    };
    let imports = SourceImports::new(&owner, policy(), 128 * 1024 * 1024).unwrap();
    let durable = imports
        .get(
            Credential::Session(Secret::new(replacement.expose().to_owned())),
            "revoked-session".into(),
        )
        .is_ok();
    drop(imports);
    let shutdown = acquisitions.shutdown(Duration::from_secs(10));
    drop(acquisitions);
    let owner_shutdown = owner.shutdown();
    std::fs::remove_dir_all(&root).unwrap();
    shutdown.unwrap();
    owner_shutdown.unwrap();
    durable
}

fn run_revoked_key_case() -> (bool, bool, String) {
    let root = temporary_root("revoked-key");
    let owner = open_owner(&root);
    let auth = owner.auth(FirstUserTenant::NewUser);
    let (tenant, token) = register(&auth, "revoked-key");
    let AuthOutcome::KeyCreated { info, key } = auth_call(
        &auth,
        AuthRequest::CreateKey {
            session: Secret::new(token.clone()),
        },
    )
    .unwrap() else {
        panic!("key creation did not return a key")
    };
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let revoke_auth = auth.clone();
    let revoke_session = token.clone();
    let key_id = info.id;
    let reply = acquisitions.acquire(
        request(
            Credential::RoutedKey {
                tenant,
                key: Secret::new(key.expose().to_owned()),
            },
            "revoked-key",
            create_target("Revoked key"),
            Box::new(ActionReader::new(move || {
                let AuthOutcome::Keys { keys, .. } = auth_call(
                    &revoke_auth,
                    AuthRequest::ListKeys {
                        session: Secret::new(revoke_session.clone()),
                    },
                )?
                else {
                    anyhow::bail!("key listing did not return keys")
                };
                anyhow::ensure!(
                    keys.iter()
                        .any(|key| key.id == key_id && key.last_used_at.is_some()),
                    "capture preflight did not update routed-key last_used_at"
                );
                let outcome = auth_call(
                    &revoke_auth,
                    AuthRequest::RevokeKey {
                        session: Secret::new(revoke_session),
                        key_id,
                    },
                )?;
                anyhow::ensure!(matches!(
                    outcome,
                    AuthOutcome::KeyChanged { changed: true, .. }
                ));
                Ok(())
            })),
        ),
        &AtomicBool::new(false),
    );
    let reply_result = reply.and_then(|reply| reply.wait());
    let reply_ok = reply_result.is_ok();
    let reply_error = reply_result
        .err()
        .map_or_else(String::new, |error| format!("{error:#}"));
    let imports = SourceImports::new(&owner, policy(), 128 * 1024 * 1024).unwrap();
    let durable = imports
        .get(
            Credential::Session(Secret::new(token)),
            "revoked-key".into(),
        )
        .is_ok();
    drop(imports);
    let shutdown = acquisitions.shutdown(Duration::from_secs(10));
    drop(acquisitions);
    let owner_shutdown = owner.shutdown();
    std::fs::remove_dir_all(&root).unwrap();
    shutdown.unwrap();
    owner_shutdown.unwrap();
    (durable, reply_ok, reply_error)
}

#[test]
fn revoked_session_and_key_during_read_cannot_admit_durable_work() {
    let session_durable = run_revoked_session_case();
    let (key_visible_to_session, key_reply_ok, key_reply_error) = run_revoked_key_case();
    let key_durable = key_reply_ok;

    assert!(
        !session_durable && !key_durable,
        "revoked authority admitted durable work: session={session_durable}, key={key_durable}; key_visible_to_session={key_visible_to_session}, key_reply_error={key_reply_error}"
    );
}

#[test]
fn routed_key_expired_during_read_is_refused_without_durable_work() {
    let root = temporary_root("key-expired-during-read");
    let owner = open_owner(&root);
    let auth = owner.auth(FirstUserTenant::NewUser);
    let (tenant, session) = register(&auth, "key-expired-during-read");
    let AuthOutcome::KeyCreated { info, key } = auth_call(
        &auth,
        AuthRequest::CreateKey {
            session: Secret::new(session.clone()),
        },
    )
    .unwrap() else {
        panic!("key creation did not return a key")
    };
    let storage = owner.client();
    let mutate_storage = storage.clone();
    let mutate_tenant = tenant.clone();
    let key_id = info.id;
    let observation = Arc::new(ReadObservation::default());
    let observed = observation.clone();
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let reply = acquisitions
        .acquire(
            request(
                Credential::RoutedKey {
                    tenant,
                    key: Secret::new(key.expose().to_owned()),
                },
                "key-expired-during-read",
                create_target("Key expired during read"),
                Box::new(ActionReader::observed(
                    move || {
                        rewrite_owned_key(&mutate_storage, &mutate_tenant, &key_id, |key| {
                            assert!(key["lastUsedAt"].as_str().is_some());
                            key["expiresAt"] = Value::String("2000-01-01T00:00:00Z".into());
                        })
                    },
                    observed,
                )),
            ),
            &AtomicBool::new(false),
        )
        .unwrap();
    let error = reply.wait().unwrap_err();
    let error = format!("{error:#}");
    assert!(
        error.contains("Authentication required"),
        "unexpected expired-key refusal: {error}"
    );
    assert!(observation.calls.load(Ordering::Acquire) >= 2);
    assert_eq!(
        observation.bytes.load(Ordering::Acquire),
        include_bytes!("fixtures/source-import/triangle.stl").len()
    );
    assert_no_durable_import_journal_attempt_fence_or_lease(
        &owner,
        &session,
        "key-expired-during-read",
    )
    .unwrap();
    assert_eq!(retained_capture_count(&root), 0);
    acquisitions.shutdown(Duration::from_secs(10)).unwrap();
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn routed_key_principal_changed_during_read_is_refused_without_durable_work() {
    let root = temporary_root("key-principal-changed");
    let owner = open_owner(&root);
    let auth = owner.auth(FirstUserTenant::NewUser);
    let (tenant, session) = register(&auth, "key-principal-changed");
    let AuthOutcome::KeyCreated { info, key } = auth_call(
        &auth,
        AuthRequest::CreateKey {
            session: Secret::new(session.clone()),
        },
    )
    .unwrap() else {
        panic!("key creation did not return a key")
    };
    let storage = owner.client();
    let mutate_storage = storage.clone();
    let mutate_tenant = tenant.clone();
    let key_id = info.id;
    let observation = Arc::new(ReadObservation::default());
    let observed = observation.clone();
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let reply = acquisitions
        .acquire(
            request(
                Credential::RoutedKey {
                    tenant,
                    key: Secret::new(key.expose().to_owned()),
                },
                "key-principal-changed",
                create_target("Key principal changed"),
                Box::new(ActionReader::observed(
                    move || {
                        rewrite_owned_key(&mutate_storage, &mutate_tenant, &key_id, |key| {
                            assert!(key["lastUsedAt"].as_str().is_some());
                            key["id"] = Value::String("replacement-principal".into());
                        })
                    },
                    observed,
                )),
            ),
            &AtomicBool::new(false),
        )
        .unwrap();
    let error = reply.wait().unwrap_err();
    assert!(format!("{error:#}").contains("Capture authority changed"));
    assert!(observation.calls.load(Ordering::Acquire) >= 2);
    assert_eq!(
        observation.bytes.load(Ordering::Acquire),
        include_bytes!("fixtures/source-import/triangle.stl").len()
    );
    assert_no_durable_import_journal_attempt_fence_or_lease(
        &owner,
        &session,
        "key-principal-changed",
    )
    .unwrap();
    assert_eq!(retained_capture_count(&root), 0);
    acquisitions.shutdown(Duration::from_secs(10)).unwrap();
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn routed_key_already_expired_is_refused_before_read() {
    let root = temporary_root("key-expired-before-read");
    let owner = open_owner(&root);
    let auth = owner.auth(FirstUserTenant::NewUser);
    let (tenant, session) = register(&auth, "key-expired-before-read");
    let AuthOutcome::KeyCreated { info, key } = auth_call(
        &auth,
        AuthRequest::CreateKey {
            session: Secret::new(session.clone()),
        },
    )
    .unwrap() else {
        panic!("key creation did not return a key")
    };
    rewrite_owned_key(&owner.client(), &tenant, &info.id, |key| {
        key["expiresAt"] = Value::String("2000-01-01T00:00:00Z".into());
    })
    .unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let error = match acquisitions.acquire(
        request(
            Credential::RoutedKey {
                tenant,
                key: Secret::new(key.expose().to_owned()),
            },
            "key-expired-before-read",
            create_target("Key expired before read"),
            Box::new(CountingReader {
                reads: reads.clone(),
                bytes: Cursor::new(include_bytes!("fixtures/source-import/triangle.stl").to_vec()),
            }),
        ),
        &AtomicBool::new(false),
    ) {
        Ok(_) => panic!("expired routed key entered acquisition"),
        Err(error) => error,
    };
    assert!(format!("{error:#}").contains("Source acquisition preflight failed"));
    assert_eq!(reads.load(Ordering::Acquire), 0);
    assert_no_durable_import_journal_attempt_fence_or_lease(
        &owner,
        &session,
        "key-expired-before-read",
    )
    .unwrap();
    assert_eq!(retained_capture_count(&root), 0);
    acquisitions.shutdown(Duration::from_secs(10)).unwrap();
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reader_error_cleans_candidate_and_restart_accepts_ingress() {
    let root = temporary_root("reader-error");
    let owner = open_owner(&root);
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let acquire_failed = acquisitions
        .acquire(
            request(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                "reader-error",
                create_target("Reader error"),
                Box::new(ErrorAfterChunk {
                    returned_chunk: false,
                }),
            ),
            &AtomicBool::new(false),
        )
        .is_err();
    let retained_before_shutdown = retained_capture_count(&root);
    let shutdown = acquisitions.shutdown(Duration::from_secs(1));
    drop(acquisitions);
    let first_owner_shutdown = owner.shutdown();

    let reopened = open_owner(&root);
    let reopened_acquisitions =
        SourceAcquisitions::new(&reopened, policy(), 128 * 1024 * 1024, 1).unwrap();
    let restart_refused = reopened_acquisitions.recover_before_accepting().is_err();
    let reopened_shutdown = reopened_acquisitions.shutdown(Duration::from_secs(1));
    drop(reopened_acquisitions);
    let reopened_owner_shutdown = reopened.shutdown();
    std::fs::remove_dir_all(&root).unwrap();

    shutdown.unwrap();
    first_owner_shutdown.unwrap();
    reopened_shutdown.unwrap();
    reopened_owner_shutdown.unwrap();
    assert!(acquire_failed, "ordinary reader error was not returned");
    assert!(
        retained_before_shutdown == 0 && !restart_refused,
        "ordinary reader error retained {retained_before_shutdown} candidate(s); restart_refused={restart_refused}"
    );
}

#[test]
fn cancellation_flipped_during_read_is_observed_before_freeze() {
    let root = temporary_root("mid-read-cancellation");
    let owner = open_owner(&root);
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let reader_cancelled = cancelled.clone();
    let result = acquisitions
        .acquire(
            request(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                "mid-read-cancellation",
                create_target("Mid-read cancellation"),
                Box::new(ActionReader::new(move || {
                    reader_cancelled.store(true, Ordering::Release);
                    Ok(())
                })),
            ),
            cancelled.as_ref(),
        )
        .and_then(|reply| reply.wait());
    let imports = SourceImports::new(&owner, policy(), 128 * 1024 * 1024).unwrap();
    let durable = imports
        .get(
            Credential::PhysicalOwner(owner.job_physical_owner()),
            "mid-read-cancellation".into(),
        )
        .is_ok();
    drop(imports);
    let retained_before_shutdown = retained_capture_count(&root);
    let shutdown = acquisitions.shutdown(Duration::from_secs(10));
    drop(acquisitions);
    let owner_shutdown = owner.shutdown();
    std::fs::remove_dir_all(&root).unwrap();

    shutdown.unwrap();
    owner_shutdown.unwrap();
    assert!(
        result.is_err() && !durable && retained_before_shutdown == 0,
        "mid-read cancellation was ignored: reply_ok={}, durable={durable}, retained={retained_before_shutdown}",
        result.is_ok(),
    );
}

#[test]
fn missing_existing_target_is_rejected_before_first_read() {
    let root = temporary_root("missing-target");
    let owner = open_owner(&root);
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let result = acquisitions
        .acquire(
            request(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                "missing-target",
                Target::Existing { source_id: 999_999 },
                Box::new(CountingReader {
                    reads: reads.clone(),
                    bytes: Cursor::new(
                        include_bytes!("fixtures/source-import/triangle.stl").to_vec(),
                    ),
                }),
            ),
            &AtomicBool::new(false),
        )
        .and_then(|reply| reply.wait());
    let observed_reads = reads.load(Ordering::Acquire);
    let shutdown = acquisitions.shutdown(Duration::from_secs(10));
    drop(acquisitions);
    let owner_shutdown = owner.shutdown();
    std::fs::remove_dir_all(&root).unwrap();

    shutdown.unwrap();
    owner_shutdown.unwrap();
    assert!(result.is_err(), "missing Existing target was admitted");
    assert_eq!(
        observed_reads, 0,
        "missing Existing target invoked its reader before refusal"
    );
}

#[test]
fn unsupported_create_and_foreign_owner_are_rejected_before_first_read() {
    for case in ["unsupported-create", "foreign-owner"] {
        let root = temporary_root(case);
        let foreign_root = temporary_root(&format!("{case}-foreign"));
        let owner = open_owner(&root);
        let foreign = open_owner(&foreign_root);
        let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
        acquisitions.recover_before_accepting().unwrap();
        let reads = Arc::new(AtomicUsize::new(0));
        let (credential, target) = if case == "unsupported-create" {
            (
                Credential::PhysicalOwner(owner.job_physical_owner()),
                Target::Create {
                    metadata: Box::new(CreateSource {
                        name: "Unsupported create".into(),
                        source_kind: Some("printables".into()),
                        ..Default::default()
                    }),
                },
            )
        } else {
            (
                Credential::PhysicalOwner(foreign.job_physical_owner()),
                create_target("Foreign owner"),
            )
        };
        let result = acquisitions.acquire(
            request(
                credential,
                case,
                target,
                Box::new(CountingReader {
                    reads: reads.clone(),
                    bytes: Cursor::new(
                        include_bytes!("fixtures/source-import/triangle.stl").to_vec(),
                    ),
                }),
            ),
            &AtomicBool::new(false),
        );
        assert!(result.is_err());
        assert_eq!(reads.load(Ordering::Acquire), 0);
        acquisitions.shutdown(Duration::from_secs(1)).unwrap();
        drop(acquisitions);
        owner.shutdown().unwrap();
        foreign.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(foreign_root).unwrap();
    }
}

#[test]
fn final_admission_rejects_foreign_physical_owner_after_valid_preflight() {
    let root = temporary_root("final-foreign-owner");
    let foreign_root = temporary_root("final-foreign-owner-target");
    let owner = open_owner(&root);
    let foreign = open_owner(&foreign_root);
    let owner_client = owner.imports(policy(), 128 * 1024 * 1024).unwrap();
    let foreign_client = foreign.imports(policy(), 128 * 1024 * 1024).unwrap();
    let bytes = include_bytes!("fixtures/source-import/triangle.stl");
    let files = vec![File {
        path: "triangle.stl".into(),
        size: bytes.len().try_into().unwrap(),
        sha256: hex::encode(Sha256::digest(bytes)),
        kind: "input".into(),
    }];
    let preflight = owner_client
        .preflight_capture(
            Credential::PhysicalOwner(owner.job_physical_owner()),
            "final-foreign-owner".into(),
            create_target("Final foreign owner"),
            CapturedPayloadV1::files(vec!["triangle.stl".into()]),
            limits(),
        )
        .unwrap();
    let prepared = preflight
        .prepare(
            CaptureId::new("44".repeat(32)).unwrap(),
            "final-foreign-owner".into(),
            CapturedPayloadV1::files(vec!["triangle.stl".into()]),
            limits(),
            files,
        )
        .unwrap();

    assert!(
        foreign_client
            .admit_prepared(prepared, 0, foreign_client.accounting_epoch())
            .is_err()
    );
    assert!(
        foreign_client
            .get(
                Credential::PhysicalOwner(foreign.job_physical_owner()),
                "final-foreign-owner".into(),
            )
            .is_err()
    );
    drop(owner_client);
    drop(foreign_client);
    owner.shutdown().unwrap();
    foreign.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(foreign_root).unwrap();
}

#[test]
fn existing_target_deleted_during_read_is_rejected_by_final_admission() {
    let root = temporary_root("target-deleted");
    let owner = open_owner(&root);
    let catalog = owner.local_source_catalog();
    let CatalogOutcome::Source(Some(source)) = catalog
        .execute(CatalogRequest::CreateCatalogSource {
            source: CreateSource {
                name: "Delete during read".into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("catalog create did not return a Source")
    };
    let source_id = source.id;
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let delete_catalog = owner.local_source_catalog();
    let result = acquisitions
        .acquire(
            request(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                "target-deleted",
                Target::Existing { source_id },
                Box::new(ActionReader::new(move || {
                    anyhow::ensure!(matches!(
                        delete_catalog.execute(CatalogRequest::Delete { id: source_id })?,
                        CatalogOutcome::Deletion(Deletion::Deleted { .. })
                    ));
                    Ok(())
                })),
            ),
            &AtomicBool::new(false),
        )
        .and_then(|reply| reply.wait());
    assert!(result.is_err());
    let imports = SourceImports::new(&owner, policy(), 128 * 1024 * 1024).unwrap();
    assert!(
        imports
            .get(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                "target-deleted".into(),
            )
            .is_err()
    );
    drop(imports);
    acquisitions.shutdown(Duration::from_secs(10)).unwrap();
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn active_recovery_does_not_remove_in_flight_candidate() {
    let root = temporary_root("active-recovery");
    let owner = open_owner(&root);
    let acquisitions =
        Arc::new(SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap());
    acquisitions.recover_before_accepting().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let active = acquisitions.clone();
    let credential = Credential::PhysicalOwner(owner.job_physical_owner());
    let worker = std::thread::spawn(move || {
        active.acquire(
            request(
                credential,
                "active-recovery",
                create_target("Active recovery"),
                Box::new(ControlledFailureReader {
                    started: Some(started_tx),
                    release: release_rx,
                }),
            ),
            &AtomicBool::new(false),
        )
    });
    started_rx.recv().unwrap();
    assert!(acquisitions.reconcile().is_err());
    assert_eq!(retained_capture_count(&root), 1);
    release_tx.send(()).unwrap();
    assert!(worker.join().unwrap().is_err());
    assert_eq!(retained_capture_count(&root), 0);
    acquisitions.recover_before_accepting().unwrap();
    acquisitions.shutdown(Duration::from_secs(1)).unwrap();
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn core_cleans_candidate_after_freeze_reinventory_failure() {
    let root = temporary_root("inventory-cleanup");
    let owner = open_owner(&root);
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let mutate_root = root.clone();
    let observation = Arc::new(ReadObservation::default());
    let observed = observation.clone();
    let result = acquisitions.acquire(
        CaptureRequest {
            credential: Credential::PhysicalOwner(owner.job_physical_owner()),
            operation_key: "inventory-cleanup".into(),
            target: create_target("Inventory cleanup"),
            payload: CapturedPayloadV1::files(vec!["first.stl".into(), "second.stl".into()]),
            limits: limits(),
            files: vec![
                CapturedFile {
                    path: SourcePath::try_from("first.stl".to_owned()).unwrap(),
                    input: Box::new(Cursor::new(b"first".to_vec())),
                },
                CapturedFile {
                    path: SourcePath::try_from("second.stl".to_owned()).unwrap(),
                    input: Box::new(ActionReader::observed(
                        move || {
                            let slot = std::fs::read_dir(mutate_root.join("source-captures"))?
                                .next()
                                .ok_or_else(|| anyhow::anyhow!("candidate slot missing"))??
                                .path();
                            std::fs::write(slot.join("candidate/input/first.stl"), b"changed")?;
                            Ok(())
                        },
                        observed,
                    )),
                },
            ],
        },
        &AtomicBool::new(false),
    );
    let error = match result {
        Ok(_) => panic!("inventory failure unexpectedly admitted a capture"),
        Err(error) => error,
    };
    let error = format!("{error:#}");
    assert!(error.contains("Source acquisition freeze failed"));
    assert!(error.contains("limit"));
    assert!(error.contains("Owned capture candidate removed"));
    assert!(observation.calls.load(Ordering::Acquire) >= 2);
    assert_eq!(
        observation.bytes.load(Ordering::Acquire),
        include_bytes!("fixtures/source-import/triangle.stl").len()
    );
    assert_eq!(retained_capture_count(&root), 0);
    acquisitions.shutdown(Duration::from_secs(1)).unwrap();
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn core_cleans_candidate_after_first_inventory_failure() {
    let root = temporary_root("first-inventory-cleanup");
    let owner = open_owner(&root);
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let mutate_root = root.clone();
    let observation = Arc::new(ReadObservation::default());
    let observed = observation.clone();
    let result = acquisitions.acquire(
        CaptureRequest {
            credential: Credential::PhysicalOwner(owner.job_physical_owner()),
            operation_key: "first-inventory-cleanup".into(),
            target: create_target("First inventory cleanup"),
            payload: CapturedPayloadV1::files(vec!["first.stl".into(), "second.stl".into()]),
            limits: limits(),
            files: vec![
                CapturedFile {
                    path: SourcePath::try_from("first.stl".to_owned()).unwrap(),
                    input: Box::new(Cursor::new(b"first".to_vec())),
                },
                CapturedFile {
                    path: SourcePath::try_from("second.stl".to_owned()).unwrap(),
                    input: Box::new(ActionReader::observed(
                        move || {
                            let slot = std::fs::read_dir(mutate_root.join("source-captures"))?
                                .next()
                                .ok_or_else(|| anyhow::anyhow!("candidate slot missing"))??
                                .path();
                            std::fs::write(
                                slot.join("candidate/input/first.stl"),
                                vec![b'x'; 64 * 1024 + 1],
                            )?;
                            Ok(())
                        },
                        observed,
                    )),
                },
            ],
        },
        &AtomicBool::new(false),
    );
    let error = match result {
        Ok(_) => panic!("first inventory failure unexpectedly admitted a capture"),
        Err(error) => error,
    };
    let error = format!("{error:#}");
    assert!(error.contains("Source acquisition inventory failed"));
    assert!(error.contains("limit"));
    assert!(error.contains("Owned capture candidate removed"));
    assert!(!error.contains("Source acquisition binding failed"));
    assert!(!error.contains("Source acquisition freeze failed"));
    assert!(observation.calls.load(Ordering::Acquire) >= 2);
    assert_eq!(
        observation.bytes.load(Ordering::Acquire),
        include_bytes!("fixtures/source-import/triangle.stl").len()
    );
    assert_eq!(retained_capture_count(&root), 0);

    let imports = SourceImports::new(&owner, policy(), 128 * 1024 * 1024).unwrap();
    let missing = imports.get(
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "first-inventory-cleanup".into(),
    );
    assert!(format!("{:#}", missing.unwrap_err()).contains("Import not found"));
    drop(imports);

    acquisitions
        .acquire(
            request(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                "after-first-inventory-cleanup",
                create_target("After first inventory cleanup"),
                Box::new(Cursor::new(
                    include_bytes!("fixtures/source-import/triangle.stl").to_vec(),
                )),
            ),
            &AtomicBool::new(false),
        )
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(retained_capture_count(&root), 0);
    acquisitions.shutdown(Duration::from_secs(1)).unwrap();
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn core_cleans_candidate_after_early_freeze_limit() {
    let root = temporary_root("early-freeze-cleanup");
    let owner = open_owner(&root);
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let mut metadata = Map::new();
    metadata.insert("large".into(), Value::String("x".repeat(8 * 1024 * 1024)));
    let target = Target::Create {
        metadata: Box::new(CreateSource {
            name: "Early freeze cleanup".into(),
            source_kind: Some("local".into()),
            source_type: Some("local".into()),
            metadata: Some(metadata),
            ..Default::default()
        }),
    };
    let observation = Arc::new(ReadObservation::default());
    let observed = observation.clone();
    let result = acquisitions.acquire(
        request(
            Credential::PhysicalOwner(owner.job_physical_owner()),
            "early-freeze-cleanup",
            target,
            Box::new(ActionReader::observed(|| Ok(()), observed)),
        ),
        &AtomicBool::new(false),
    );
    let error = match result {
        Ok(_) => panic!("freeze limit unexpectedly admitted a capture"),
        Err(error) => error,
    };
    let error = format!("{error:#}");
    assert!(error.contains("Source acquisition freeze failed"));
    assert!(error.contains("limit"));
    assert!(error.contains("Owned capture candidate removed"));
    assert!(observation.calls.load(Ordering::Acquire) >= 2);
    assert_eq!(
        observation.bytes.load(Ordering::Acquire),
        include_bytes!("fixtures/source-import/triangle.stl").len()
    );
    assert_eq!(retained_capture_count(&root), 0);
    acquisitions.shutdown(Duration::from_secs(1)).unwrap();
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_owned_abort_preserves_evidence_and_closes_ingress() {
    let root = temporary_root("failed-abort");
    let owner = open_owner(&root);
    let acquisitions =
        Arc::new(SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap());
    acquisitions.recover_before_accepting().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let active = acquisitions.clone();
    let credential = Credential::PhysicalOwner(owner.job_physical_owner());
    let worker = std::thread::spawn(move || {
        active.acquire(
            request(
                credential,
                "failed-abort",
                create_target("Failed abort"),
                Box::new(ControlledFailureReader {
                    started: Some(started_tx),
                    release: release_rx,
                }),
            ),
            &AtomicBool::new(false),
        )
    });
    started_rx.recv().unwrap();
    let slot = std::fs::read_dir(root.join("source-captures"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::write(slot.join("late-evidence"), b"preserve").unwrap();
    release_tx.send(()).unwrap();
    let error = match worker.join().unwrap() {
        Ok(_) => panic!("controlled reader failure unexpectedly acquired"),
        Err(error) => error,
    };
    assert!(format!("{error:#}").contains("retained repair receipt"));
    assert_eq!(
        std::fs::read(slot.join("late-evidence")).unwrap(),
        b"preserve"
    );
    assert!(
        acquisitions
            .acquire(
                request(
                    Credential::PhysicalOwner(owner.job_physical_owner()),
                    "after-failed-abort",
                    create_target("After failed abort"),
                    Box::new(Cursor::new(
                        include_bytes!("fixtures/source-import/triangle.stl").to_vec(),
                    )),
                ),
                &AtomicBool::new(false),
            )
            .is_err()
    );
    acquisitions.shutdown(Duration::from_secs(1)).unwrap();
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn repeated_captured_intent_returns_original_settled_operation() {
    let root = temporary_root("captured-replay");
    let owner = open_owner(&root);
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let first = acquisitions
        .acquire(
            request(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                "captured-replay",
                create_target("Captured replay"),
                Box::new(Cursor::new(
                    include_bytes!("fixtures/source-import/triangle.stl").to_vec(),
                )),
            ),
            &AtomicBool::new(false),
        )
        .unwrap()
        .wait()
        .unwrap();
    let replay = acquisitions
        .acquire(
            request(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                "captured-replay",
                create_target("Captured replay"),
                Box::new(Cursor::new(
                    include_bytes!("fixtures/source-import/triangle.stl").to_vec(),
                )),
            ),
            &AtomicBool::new(false),
        )
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(replay.job_id, first.job_id);
    assert_eq!(replay.source_id, first.source_id);
    assert_eq!(replay.receipt, first.receipt);
    assert_eq!(retained_capture_count(&root), 0);
    acquisitions.shutdown(Duration::from_secs(10)).unwrap();
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
