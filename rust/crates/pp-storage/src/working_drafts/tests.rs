use super::*;
use observation::*;

struct UnusedReads;
impl DraftReads for UnusedReads {
    fn resolve_stl_root(
        &self,
        _: &OwnedStlReadRequest,
        _: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlRootRead>> {
        Err(ReadFailure::Unavailable)
    }
    fn read_checkout_manifest(
        &self,
        _: &OwnedCheckoutReadRequest,
        _: CheckoutManifestUse,
        _: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        Err(ReadFailure::Unavailable)
    }
    fn read_catalog_document(
        &self,
        _: &OwnedCatalogReadRequest,
        _: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        Err(ReadFailure::Unavailable)
    }
}
fn policy() -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
        first_user: auth::FirstUserTenant::NewUser,
    }
}
fn credential() -> Credential {
    Credential::Session(auth::Secret::new("publication-fixture-secret".into()))
}
struct Fixture {
    root: std::path::PathBuf,
    owner: Option<WriterOwner>,
    client: WorkingDraftClient,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pp-working-draft-service-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("print-partner.db"),
            include_bytes!("../../tests/fixtures/plan-publication/first.db"),
        )
        .unwrap();
        let (owner, _) = WriterOwner::open(&root, crate::Limits::default()).unwrap();
        let client = owner
            .working_drafts_with_policy(
                policy(),
                Arc::new(UnusedReads),
                PreparationLimits::default(),
                root.join("repos"),
            )
            .unwrap();
        Self {
            root,
            owner: Some(owner),
            client,
        }
    }
    fn call(&self, request: Request, service: bool) -> Outcome {
        let flag = Arc::new(AtomicBool::new(false));
        if service {
            self.client
                .service(
                    credential(),
                    PositiveId::new(1).unwrap(),
                    request,
                    flag,
                    Duration::from_secs(5),
                )
                .unwrap()
        } else {
            self.client
                .execute(
                    credential(),
                    PositiveId::new(1).unwrap(),
                    request,
                    flag,
                    Duration::from_secs(5),
                )
                .unwrap()
        }
    }
    fn graph(&self) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
        let c = Connection::open(self.root.join("print-partner.db")).unwrap();
        let tables: Vec<String> = c
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        tables
            .into_iter()
            .map(|table| {
                let mut statement = c
                    .prepare(&format!(
                        "SELECT * FROM \"{}\" ORDER BY rowid",
                        table.replace('"', "\"\"")
                    ))
                    .unwrap();
                let columns = statement.column_count();
                let rows = statement
                    .query_map([], |row| {
                        (0..columns)
                            .map(|i| row.get(i))
                            .collect::<rusqlite::Result<Vec<_>>>()
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                (table, rows)
            })
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            owner.shutdown().unwrap();
        }
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn ticket_t_61_publication_service_abandon_replay_preserves_lifecycle() {
    let f = Fixture::new();
    let request = || Request::Transition {
        draft_id: PositiveId::new(1).unwrap(),
        transition: Transition::Abandon,
        expected_lifecycle_version: 0,
    };
    let Outcome::Transitioned { draft: committed } = f.call(request(), true) else {
        panic!("Expected initial abandon")
    };
    let before = f.graph();
    let Outcome::Unchanged { draft: replay } = f.call(request(), true) else {
        panic!("Service abandon replay must retain lifecycle outcome")
    };
    assert_eq!(replay, committed);
    assert_eq!(replay["state"], "abandoned");
    assert_eq!(replay["lifecycleVersion"], 1);
    assert_eq!(f.graph(), before);
}
#[test]
fn ticket_t_61_publication_cancelled_follow_on_preserves_committed_edit() {
    let mut f = Fixture::new();
    let Outcome::Read { draft } = f.call(
        Request::Read {
            draft_id: PositiveId::new(1).unwrap(),
        },
        false,
    ) else {
        panic!("Expected saved draft")
    };
    let request: Request = serde_json::from_value(json!({"kind":"edit","draft_id":1,"expected_snapshot_digest":draft["snapshotDigest"],"decisions":[{"kind":"set_quantity_override","draft_part_ids":[1],"value":2}]})).unwrap();
    let Outcome::Updated { draft: committed } = f.call(request.clone(), false) else {
        panic!("Expected actual committed edit")
    };
    assert_eq!(committed["parts"][0]["quantityOverride"], 2);
    f.owner.take().unwrap().shutdown().unwrap();
    let before = f.graph();
    let command = Command {
        credential: credential(),
        profile: PositiveId::new(1).unwrap(),
        request,
        policy: policy(),
        reads: Arc::new(UnusedReads),
        limits: PreparationLimits::default(),
        repos: f.root.join("repos"),
        cancelled: Arc::new(AtomicBool::new(true)),
        service: true,
    };
    let mut connection = Connection::open(f.root.join("print-partner.db")).unwrap();
    let failure = auto_select(
        &mut connection,
        &command,
        PositiveId::new(1).unwrap(),
        Some(committed.clone()),
        None,
    )
    .expect_err("Cancelled follow-on must fail before selection");
    assert!(matches!(
        failure.downcast_ref::<Failure>(),
        Some(Failure::Cancelled)
    ));
    assert_eq!(f.graph(), before);
    let tx = connection.transaction().unwrap();
    let persisted = required_units::draft(&tx, "default", 1, 1)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot(&persisted).unwrap(), committed);
    assert!(persisted.selected.is_none());
    drop(tx);
    drop(connection);
    let (reopened, _) = WriterOwner::open(&f.root, crate::Limits::default()).unwrap();
    let client = reopened
        .working_drafts_with_policy(
            policy(),
            Arc::new(UnusedReads),
            PreparationLimits::default(),
            f.root.join("repos"),
        )
        .unwrap();
    let Outcome::Read { draft: retained } = client
        .execute(
            credential(),
            PositiveId::new(1).unwrap(),
            Request::Read {
                draft_id: PositiveId::new(1).unwrap(),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
    else {
        panic!("Expected committed edit after orderly restart")
    };
    assert_eq!(retained, committed);
    f.owner = Some(reopened);
}

#[test]
fn ticket_t_61_publication_service_open_unchanged_edit_still_selects() {
    let f = Fixture::new();
    let Outcome::Read { draft } = f.call(
        Request::Read {
            draft_id: PositiveId::new(1).unwrap(),
        },
        false,
    ) else {
        panic!("Expected saved draft")
    };
    let request = serde_json::from_value(json!({"kind":"edit","draft_id":1,"expected_snapshot_digest":draft["snapshotDigest"],"decisions":[{"kind":"set_quantity_override","draft_part_ids":[1],"value":null}]})).unwrap();
    let Outcome::Service {
        outcome: pp_contracts::reconciliation::Outcome::Ready { .. },
        committed_draft: Some(committed),
    } = f.call(request, true)
    else {
        panic!("Open unchanged edits still require service selection")
    };
    assert_eq!(committed, draft);
}
