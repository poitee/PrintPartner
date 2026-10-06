use pp_contracts::{PositiveId, build_identity::BuildName};
use pp_storage::{
    Limits, WriterOwner,
    auth::{
        AuthPolicy, FirstUserTenant, Outcome as AuthOutcome, RegistrationPolicy,
        Request as AuthRequest, Secret, SessionTenantPolicy,
    },
    build_graph::{BuildCommand, BuildOutcome, Failure},
    catalog::{CreateSource, Credentials, Outcome as CatalogOutcome, Request as CatalogRequest},
    read_model::Credential,
};
use rusqlite::{Connection, OptionalExtension};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let path = std::env::temp_dir().join(format!("pp-build-graph-{}", hex::encode(random)));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn open(&self) -> WriterOwner {
        WriterOwner::open(
            &self.0,
            Limits {
                queued_writes: 4,
                readers: 1,
            },
        )
        .unwrap()
        .0
    }

    fn from_database(database: &[u8]) -> Self {
        let fixture = Self::new();
        std::fs::write(fixture.0.join("print-partner.db"), database).unwrap();
        fixture
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        first_user: FirstUserTenant::NewUser,
        session_tenant: SessionTenantPolicy::AccountTenant,
    }
}

fn default_tenant_policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::FirstAccountOnly,
        first_user: FirstUserTenant::NewUser,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
    }
}

fn actor(owner: &WriterOwner, email: &str) -> (String, String) {
    let AuthOutcome::Session { user, token } = owner
        .auth(FirstUserTenant::NewUser)
        .submit(
            AuthRequest::Register {
                email: email.into(),
                display_name: email.into(),
                password: Secret::new("strong-password".into()),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("session expected")
    };
    (user.tenant_id, token.expose().into())
}

fn source(owner: &WriterOwner, token: &str, name: &str) -> PositiveId {
    let client = owner.source_catalog(Credentials::Session(Secret::new(token.into())));
    let CatalogOutcome::Source(Some(source)) = client
        .execute(CatalogRequest::Create {
            source: CreateSource {
                name: name.into(),
                source_kind: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("source expected")
    };
    PositiveId::new(source.id as u64).unwrap()
}

fn execute(
    client: &pp_storage::build_graph::BuildGraphClient,
    token: &str,
    command: BuildCommand,
) -> BuildOutcome {
    client
        .execute(
            Credential::Session(Secret::new(token.into())),
            command,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
        )
        .unwrap()
}

#[test]
fn authenticated_graph_is_tenant_scoped_atomic_and_path_scoped() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let (_, token_a) = actor(&owner, "a@example.test");
    let (_, token_b) = actor(&owner, "b@example.test");
    let source_a = source(&owner, &token_a, "A Source");
    let source_b = source(&owner, &token_b, "B Source");
    let client = owner.build_graph_with_policy(policy()).unwrap();
    assert!(matches!(
        execute(
            &client,
            &token_a,
            BuildCommand::Create {
                name: BuildName::parse("Atomic refusal".into()).unwrap(),
                base_source: Some(source_b),
            }
        ),
        BuildOutcome::InvalidBaseSource
    ));
    assert!(matches!(
        execute(&client, &token_a, BuildCommand::List),
        BuildOutcome::Listed { profiles } if profiles.is_empty()
    ));
    let BuildOutcome::Created {
        profile: first,
        layers: first_layers,
    } = execute(
        &client,
        &token_a,
        BuildCommand::Create {
            name: BuildName::parse("First".into()).unwrap(),
            base_source: Some(source_a),
        },
    )
    else {
        panic!("created expected")
    };
    let BuildOutcome::Created {
        profile: second,
        layers: second_layers,
    } = execute(
        &client,
        &token_a,
        BuildCommand::Create {
            name: BuildName::parse("Second".into()).unwrap(),
            base_source: None,
        },
    )
    else {
        panic!("created expected")
    };
    let first_id = PositiveId::new(first.id as u64).unwrap();
    let second_id = PositiveId::new(second.id as u64).unwrap();
    let first_layer = PositiveId::new(first_layers[0].id as u64).unwrap();
    assert!(second_layers.is_empty());
    assert!(matches!(
        execute(
            &client,
            &token_a,
            BuildCommand::Detach {
                build: second_id,
                layer: first_layer,
            }
        ),
        BuildOutcome::MissingLayer
    ));
    assert!(matches!(
        execute(&client, &token_b, BuildCommand::Read { build: first_id }),
        BuildOutcome::MissingBuild
    ));
    let cancelled = Arc::new(AtomicBool::new(true));
    let error = client
        .execute(
            Credential::Session(Secret::new(token_a.clone())),
            BuildCommand::List,
            cancelled,
            Duration::ZERO,
        )
        .unwrap_err();
    assert!(matches!(error.downcast_ref(), Some(Failure::Cancelled)));
    owner.shutdown().unwrap();

    let owner = fixture.open();
    let client = owner.build_graph_with_policy(policy()).unwrap();
    let BuildOutcome::Layers { layers, .. } = execute(
        &client,
        &token_a,
        BuildCommand::ListLayers { build: first_id },
    ) else {
        panic!("layers expected")
    };
    assert_eq!(layers, first_layers);
    owner.shutdown().unwrap();
    let error = client
        .execute(
            Credential::Session(Secret::new(token_a)),
            BuildCommand::List,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
        )
        .unwrap_err();
    assert!(matches!(error.downcast_ref(), Some(Failure::Stopped)));
}

#[test]
fn explicit_delete_cleans_settings_layers_and_survives_reopen() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let (tenant, token) = actor(&owner, "delete@example.test");
    let source = source(&owner, &token, "Retained Source");
    let client = owner.build_graph_with_policy(policy()).unwrap();
    let BuildOutcome::Created { profile, .. } = execute(
        &client,
        &token,
        BuildCommand::Create {
            name: BuildName::parse("Delete me".into()).unwrap(),
            base_source: Some(source),
        },
    ) else {
        panic!("created expected")
    };
    let build = PositiveId::new(profile.id as u64).unwrap();
    owner.shutdown().unwrap();
    let database = fixture.0.join("print-partner.db");
    let sql = Connection::open(&database).unwrap();
    sql.execute(
        "INSERT INTO app_settings(tenant_id,key,value) VALUES(?1,?2,'owned')",
        (&tenant, format!("production_setup:{}", profile.id)),
    )
    .unwrap();
    sql.execute(
        "INSERT INTO app_settings(tenant_id,key,value) VALUES(?1,?2,'owned')",
        (&tenant, format!("role_filaments_{}", profile.id)),
    )
    .unwrap();
    drop(sql);
    let owner = fixture.open();
    let client = owner.build_graph_with_policy(policy()).unwrap();
    assert!(matches!(
        execute(&client, &token, BuildCommand::Delete { build }),
        BuildOutcome::Deleted
    ));
    owner.shutdown().unwrap();
    let sql = Connection::open(&database).unwrap();
    let profile_count: i64 = sql
        .query_row(
            "SELECT count(*) FROM build_profiles WHERE tenant_id=?1 AND id=?2",
            (&tenant, profile.id),
            |row| row.get(0),
        )
        .unwrap();
    let layer_count: i64 = sql
        .query_row(
            "SELECT count(*) FROM profile_layers WHERE tenant_id=?1 AND profile_id=?2",
            (&tenant, profile.id),
            |row| row.get(0),
        )
        .unwrap();
    let setting_count: i64 = sql
        .query_row(
            "SELECT count(*) FROM app_settings WHERE tenant_id=?1 AND key IN (?2,?3)",
            (
                &tenant,
                format!("production_setup:{}", profile.id),
                format!("role_filaments_{}", profile.id),
            ),
            |row| row.get(0),
        )
        .unwrap();
    let foreign_keys: Option<String> = sql
        .query_row("PRAGMA foreign_key_check", [], |row| row.get(0))
        .optional()
        .unwrap();
    assert_eq!((profile_count, layer_count, setting_count), (0, 0, 0));
    assert!(foreign_keys.is_none());
    let source_count: i64 = sql
        .query_row(
            "SELECT count(*) FROM projects WHERE tenant_id=?1 AND id=?2",
            (&tenant, source.get() as i64),
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(source_count, 1);
}

#[test]
fn explicit_delete_cascades_the_public_accepted_plate_history_graph() {
    let fixture = Fixture::from_database(include_bytes!("fixtures/accepted-plate-node.db"));
    let database = fixture.0.join("print-partner.db");
    let before = Connection::open(&database).unwrap();
    let source_count: i64 = before
        .query_row("SELECT count(*) FROM projects", [], |row| row.get(0))
        .unwrap();
    for table in [
        "profile_layers",
        "plan_drafts",
        "plan_revisions",
        "plan_apply_requests",
        "required_units",
        "accepted_plate_revisions",
        "accepted_plates",
    ] {
        let count: i64 = before
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(count > 0, "fixture must exercise {table}");
    }
    drop(before);

    let owner = fixture.open();
    let client = owner
        .build_graph_with_policy(default_tenant_policy())
        .unwrap();
    assert!(matches!(
        execute(
            &client,
            "read-fixture-secret",
            BuildCommand::Delete {
                build: PositiveId::new(1).unwrap(),
            }
        ),
        BuildOutcome::Deleted
    ));
    owner.shutdown().unwrap();

    for _ in 0..2 {
        let sql = Connection::open(&database).unwrap();
        for table in [
            "build_profiles",
            "profile_layers",
            "plan_drafts",
            "plan_revisions",
            "plan_apply_requests",
            "required_units",
            "accepted_plate_revisions",
            "accepted_plates",
        ] {
            let count: i64 = sql
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "delete must cascade {table}");
        }
        let retained_sources: i64 = sql
            .query_row("SELECT count(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(retained_sources, source_count);
        assert!(
            sql.query_row("PRAGMA foreign_key_check", [], |row| row
                .get::<_, String>(0))
                .optional()
                .unwrap()
                .is_none()
        );
        drop(sql);
        let owner = fixture.open();
        owner.shutdown().unwrap();
    }
}

#[test]
fn explicit_delete_cascades_completed_and_sent_jobs_and_preserves_controls() {
    for status in ["completed", "sent"] {
        let fixture = Fixture::new();
        let owner = fixture.open();
        let (tenant, token) = actor(&owner, &format!("target-{status}@example.test"));
        let (_, foreign_token) = actor(&owner, &format!("foreign-{status}@example.test"));
        let retained_source = source(&owner, &token, &format!("Retained {status}"));
        let client = owner.build_graph_with_policy(policy()).unwrap();
        let BuildOutcome::Created {
            profile: target, ..
        } = execute(
            &client,
            &token,
            BuildCommand::Create {
                name: BuildName::parse(format!("Target {status}")).unwrap(),
                base_source: Some(retained_source),
            },
        )
        else {
            panic!("target expected")
        };
        let BuildOutcome::Created {
            profile: control, ..
        } = execute(
            &client,
            &token,
            BuildCommand::Create {
                name: BuildName::parse(format!("Control {status}")).unwrap(),
                base_source: None,
            },
        )
        else {
            panic!("control expected")
        };
        let BuildOutcome::Created {
            profile: foreign, ..
        } = execute(
            &client,
            &foreign_token,
            BuildCommand::Create {
                name: BuildName::parse(format!("Foreign {status}")).unwrap(),
                base_source: None,
            },
        )
        else {
            panic!("foreign control expected")
        };
        owner.shutdown().unwrap();

        let database = fixture.0.join("print-partner.db");
        let sql = Connection::open(&database).unwrap();
        sql.execute(
            "INSERT INTO print_jobs(id,tenant_id,profile_id,at,status) VALUES(?1,?2,?3,'2026-01-01T00:00:00.000Z',?4)",
            (format!("job-{status}"), &tenant, target.id, status),
        )
        .unwrap();
        drop(sql);

        let owner = fixture.open();
        let client = owner.build_graph_with_policy(policy()).unwrap();
        assert!(matches!(
            execute(
                &client,
                &token,
                BuildCommand::Delete {
                    build: PositiveId::new(target.id as u64).unwrap(),
                }
            ),
            BuildOutcome::Deleted
        ));
        owner.shutdown().unwrap();

        for _ in 0..2 {
            let sql = Connection::open(&database).unwrap();
            let target_and_job: (i64, i64) = (
                sql.query_row(
                    "SELECT count(*) FROM build_profiles WHERE id=?1",
                    [target.id],
                    |row| row.get(0),
                )
                .unwrap(),
                sql.query_row(
                    "SELECT count(*) FROM print_jobs WHERE id=?1",
                    [format!("job-{status}")],
                    |row| row.get(0),
                )
                .unwrap(),
            );
            assert_eq!(target_and_job, (0, 0));
            let controls: i64 = sql
                .query_row(
                    "SELECT count(*) FROM build_profiles WHERE id IN (?1,?2)",
                    (control.id, foreign.id),
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(controls, 2);
            let retained_sources: i64 = sql
                .query_row(
                    "SELECT count(*) FROM projects WHERE id=?1",
                    [retained_source.get() as i64],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(retained_sources, 1);
            assert!(
                sql.query_row("PRAGMA foreign_key_check", [], |row| row
                    .get::<_, String>(0))
                    .optional()
                    .unwrap()
                    .is_none()
            );
            drop(sql);
            let owner = fixture.open();
            owner.shutdown().unwrap();
        }
    }
}
