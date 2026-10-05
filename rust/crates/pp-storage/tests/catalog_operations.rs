use pp_storage::{
    Limits, WriterOwner,
    auth::{FirstUserTenant, Outcome as AuthOutcome, Request as AuthRequest, Secret},
    catalog::{
        CreateSource, Credentials, Deletion, NamingCommand, NamingProfile, Outcome, Request,
        SourceCatalogClient, SourcePatch,
    },
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "pp-catalog-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn open(&self) -> WriterOwner {
        WriterOwner::open(
            &self.0,
            Limits {
                queued_writes: 2,
                readers: 1,
            },
        )
        .unwrap()
        .0
    }
    fn sql(&self) -> Connection {
        Connection::open(self.0.join("print-partner.db")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn value(client: &SourceCatalogClient, r: Request) -> Value {
    serde_json::to_value(client.execute(r).unwrap()).unwrap()
}
fn create(client: &SourceCatalogClient, name: &str) -> i64 {
    value(
        client,
        Request::Create {
            source: CreateSource {
                name: name.into(),
                source_kind: Some("local".into()),
                ..Default::default()
            },
        },
    )["id"]
        .as_i64()
        .unwrap()
}
fn actor(owner: &WriterOwner, email: &str) -> (String, String) {
    let auth = owner.auth(FirstUserTenant::NewUser);
    let AuthOutcome::Session { user, token } = auth
        .submit(
            AuthRequest::Register {
                email: email.into(),
                display_name: "User".into(),
                password: Secret::new("strong-password".into()),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("session")
    };
    (user.tenant_id, token.expose().into())
}
fn session(owner: &WriterOwner, token: &str) -> SourceCatalogClient {
    owner.source_catalog(Credentials::Session(Secret::new(token.into())))
}
fn rows(path: &Path) -> Value {
    let db = Connection::open_with_flags(
        path.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let names = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let mut result = serde_json::Map::new();
    for name in names {
        let mut stmt = db
            .prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))
            .unwrap();
        let cols = stmt.column_count();
        let records = stmt
            .query_map([], |r| {
                let mut values = Vec::new();
                for i in 0..cols {
                    let v = match r.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(i) => json!(i),
                        rusqlite::types::ValueRef::Real(v) => json!(v),
                        rusqlite::types::ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                        rusqlite::types::ValueRef::Blob(b) => json!(hex::encode(b)),
                    };
                    values.push(v);
                }
                Ok(json!(values))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        result.insert(name, json!(records));
    }
    json!(result)
}
#[test]
fn ticket_t_59_catalog_crud_owner_restart_and_cancelled_lost_reply() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    let id = create(&client, " B ");
    let a = create(&client, "A");
    assert_eq!(value(&client, Request::List {})[0]["id"], a);
    assert!(
        client
            .submit(
                Request::Delete { id },
                &AtomicBool::new(true),
                Duration::ZERO
            )
            .is_err()
    );
    let patch = SourcePatch {metadata:Some(serde_json::from_value(json!({"custom_name":"Friendly","category":" A / B ","sync_error":"bad","remote_checked_at":"then"})).unwrap()),..Default::default()};
    value(&client, Request::Update { id, patch });
    let patch = SourcePatch {
        url: Some("https://example.invalid/new".into()),
        ..Default::default()
    };
    let changed = value(&client, Request::Update { id, patch });
    assert_eq!(changed["metadata"]["custom_name"], "Friendly");
    assert_eq!(changed["metadata"]["category"], "A/B");
    assert_eq!(changed["update_status"], "unknown");
    assert!(changed["metadata"].get("sync_error").is_none());
    assert!(changed["metadata"].get("remote_checked_at").is_none());
    drop(
        client
            .submit(
                Request::Create {
                    source: CreateSource {
                        name: "Lost reply".into(),
                        ..Default::default()
                    },
                },
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .unwrap(),
    );
    owner.shutdown().unwrap();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    assert_eq!(
        value(&client, Request::List {}).as_array().unwrap().len(),
        3
    );
    assert_eq!(value(&client, Request::Get { id })["name"], "B");
    assert_eq!(value(&client, Request::Delete { id })["kind"], "deleted");
    assert_eq!(value(&client, Request::Get { id }), Value::Null);
    assert_eq!(value(&client, Request::Delete { id })["kind"], "not_found");
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_59_catalog_session_key_owner_isolation_and_revocation() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let (tenant_a, token_a) = actor(&owner, "a@example.com");
    let (_, token_b) = actor(&owner, "b@example.com");
    let a = session(&owner, &token_a);
    let b = session(&owner, &token_b);
    let local = owner.local_source_catalog();
    let owner_id = create(&local, "Local owner");
    let id = create(&a, "A source");
    assert_eq!(value(&b, Request::Get { id }), Value::Null);
    assert_eq!(value(&a, Request::Get { id: owner_id }), Value::Null);
    assert_eq!(value(&local, Request::Get { id }), Value::Null);
    let auth = owner.auth(FirstUserTenant::NewUser);
    let AuthOutcome::KeyCreated { info, key } = auth
        .submit(
            AuthRequest::CreateKey {
                session: Secret::new(token_a.clone()),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("key")
    };
    let key_client = owner.source_catalog(Credentials::Key {
        tenant_id: tenant_a,
        key: Secret::new(key.expose().into()),
    });
    assert_eq!(value(&key_client, Request::Get { id })["id"], id);
    let wrong = owner.source_catalog(Credentials::Key {
        tenant_id: "default".into(),
        key: Secret::new(key.expose().into()),
    });
    assert!(wrong.execute(Request::List {}).is_err());
    auth.submit(
        AuthRequest::RevokeKey {
            session: Secret::new(token_a.clone()),
            key_id: info.id,
        },
        Arc::new(AtomicBool::new(false)),
        Duration::from_secs(5),
    )
    .unwrap()
    .recv()
    .unwrap()
    .unwrap();
    assert!(key_client.execute(Request::List {}).is_err());
    auth.submit(
        AuthRequest::Logout {
            token: Secret::new(token_a),
        },
        Arc::new(AtomicBool::new(false)),
        Duration::from_secs(5),
    )
    .unwrap()
    .recv()
    .unwrap()
    .unwrap();
    assert!(
        a.execute(Request::Create {
            source: CreateSource {
                name: "revoked".into(),
                ..Default::default()
            }
        })
        .is_err()
    );
    assert_eq!(value(&local, Request::List {}).as_array().unwrap().len(), 1);
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_59_catalog_work_delete_ordering() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    let id = create(&client, "Active");
    let mut lease = client
        .begin_work(id, &AtomicBool::new(false), Duration::ZERO)
        .unwrap();
    assert_eq!(
        value(&client, Request::Delete { id })["kind"],
        "active_work"
    );
    lease.release().unwrap();
    assert_eq!(value(&client, Request::Delete { id })["kind"], "deleted");
    assert!(
        client
            .begin_work(id, &AtomicBool::new(false), Duration::ZERO)
            .is_err()
    );
    let id = create(&client, "Dropped lease");
    let lease = client
        .begin_work(id, &AtomicBool::new(false), Duration::ZERO)
        .unwrap();
    drop(lease);
    assert_eq!(value(&client, Request::Delete { id })["kind"], "deleted");
    assert!(
        client
            .begin_work(id, &AtomicBool::new(true), Duration::ZERO)
            .is_err()
    );
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_59_catalog_categories_naming_and_import_invalidation() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    let id = create(&client, "Metadata");
    assert_eq!(
        value(&client, Request::GetImportRules { id }),
        json!({"rules":[],"legacy_import_all":true})
    );
    value(
        &client,
        Request::SaveCategories {
            categories: vec![" Printers / Frame ".into(), "Mods".into()],
            replacements: Default::default(),
        },
    );
    assert_eq!(
        value(&client, Request::GetCategories {}),
        json!(["Printers", "Printers/Frame", "Mods"])
    );
    assert_eq!(
        value(&client, Request::GetCategoryTree {})[0]["children"][0]["path"],
        "Printers/Frame"
    );
    let bulk = value(
        &client,
        Request::BulkCategory {
            source_ids: vec![id, id, 999],
            category: Some(" Printers / Frame ".into()),
        },
    );
    assert_eq!(bulk["succeeded"], 1);
    assert_eq!(bulk["failed"], 1);
    value(
        &client,
        Request::SaveCategories {
            categories: vec!["Machine/Frame".into(), "Mods".into()],
            replacements: std::collections::HashMap::from([(
                "Printers".into(),
                Some("Machine".into()),
            )]),
        },
    );
    assert_eq!(
        value(&client, Request::Get { id })["category"],
        "Machine/Frame"
    );
    let mut profile = NamingProfile::default();
    profile.roles[0].label = "Custom".into();
    profile.quantity.regex = r"(?<=x)([0-9]+)\.stl$".into();
    value(
        &client,
        Request::SaveNaming {
            id,
            settings: NamingCommand::Override { profile },
        },
    );
    let naming = value(&client, Request::GetNaming { id });
    assert_eq!(naming["effective"]["roles"][0]["label"], "Custom");
    assert_eq!(naming["effective_digest"].as_str().unwrap().len(), 64);
    value(
        &client,
        Request::SaveNaming {
            id,
            settings: NamingCommand::UseDefaults,
        },
    );
    assert_eq!(
        value(&client, Request::GetNaming { id })["use_defaults"],
        true
    );
    owner.shutdown().unwrap();
    fixture.sql().execute_batch(&format!("INSERT INTO build_profiles(id,tenant_id,name) VALUES(1,'default','Uses source'),(2,'other','Other tenant'); INSERT INTO profile_layers(tenant_id,profile_id,layer_type,project_id) VALUES('default',1,'base',{id}),('other',2,'addon',{id});")).unwrap();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    assert_eq!(
        value(
            &client,
            Request::SaveImportRules {
                id,
                rules: vec![" /STLs ".into(), "\\STLs".into(), "a.STL".into(), "".into()]
            }
        ),
        json!({"rules":["STLs/","a.STL"]})
    );
    assert_eq!(
        value(&client, Request::GetImportRules { id })["legacy_import_all"],
        false
    );
    owner.shutdown().unwrap();
    let db = fixture.sql();
    let timestamps = db
        .prepare("SELECT config_modified_at FROM build_profiles ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get::<_, Option<String>>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(timestamps[0].is_some());
    assert!(timestamps[1].is_none());
}
#[test]
fn ticket_t_59_catalog_rejections_preserve_rows_and_import_transaction() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    let id = create(&client, "Rollback");
    owner.shutdown().unwrap();
    let db = fixture.sql();
    db.execute_batch(&format!("INSERT INTO build_profiles(id,tenant_id,name) VALUES(1,'default','Build'); INSERT INTO profile_layers(tenant_id,profile_id,layer_type,project_id) VALUES('default',1,'base',{id}); CREATE TRIGGER reject_config BEFORE UPDATE ON build_profiles BEGIN SELECT RAISE(ABORT,'fixture rejects invalidation'); END;")).unwrap();
    drop(db);
    let owner = fixture.open();
    let before = rows(&fixture.0);
    let client = owner.local_source_catalog();
    assert!(
        client
            .execute(Request::SaveImportRules {
                id,
                rules: vec!["Models".into()]
            })
            .is_err()
    );
    assert!(
        client
            .execute(Request::SaveCategories {
                categories: vec![],
                replacements: Default::default()
            })
            .is_err()
    );
    assert_eq!(value(&client, Request::Delete { id })["kind"], "referenced");
    assert_eq!(rows(&fixture.0), before);
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_59_catalog_immutable_and_reference_graphs() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    for n in [
        "History",
        "Direct",
        "Accepted input",
        "Draft input",
        "Legacy part",
        "Snapshot",
    ] {
        create(&client, n);
    }
    owner.shutdown().unwrap();
    let db = fixture.sql();
    db.execute_batch("PRAGMA foreign_keys=ON; INSERT INTO build_profiles(id,tenant_id,name) VALUES(1,'default','Graph'); INSERT INTO source_revisions(tenant_id,project_id,upstream_revision_key,manifest_digest,snapshot_locator,synced_at) VALUES('default',1,'immutable-key','digest','1/revisions/key','2026-01-01'); INSERT INTO profile_layers(tenant_id,profile_id,layer_type,project_id) VALUES('default',1,'base',2); INSERT INTO plan_revision_input_sets(id,tenant_id,profile_id,input_set_digest,expected_input_count,recorded_at,published_at) VALUES(1,'default',1,'inputs',1,'then','then'); INSERT INTO plan_revision_inputs(tenant_id,input_set_id,source_id,source_layer,tracking_kind) VALUES('default',1,3,'base:Accepted input','untracked'); INSERT INTO plan_drafts(id,tenant_id,profile_id,base_plan_version,state,digest_format,snapshot_digest,created_by,idempotency_key,created_at) VALUES(1,'default',1,0,'open','v1','digest','fixture','key','then'); INSERT INTO plan_draft_inputs(tenant_id,draft_id,source_id,source_layer,layer_order,tracking_kind,effective_naming_digest) VALUES('default',1,4,'base:Draft input',0,'untracked','naming'); INSERT INTO parts(tenant_id,profile_id,match_key,filename,source_layer) VALUES('default',1,'part','file.stl','base:Legacy part'); INSERT INTO plan_snapshots(tenant_id,profile_id,name,created_at,payload_json) VALUES('default',1,'Snapshot','then','{\"layers\":[{\"project_id\":6,\"source_name\":\"Snapshot\"}]}');").unwrap();
    drop(db);
    let owner = fixture.open();
    let before = rows(&fixture.0);
    let client = owner.local_source_catalog();
    for id in 1..=6 {
        let expected = if id == 1 {
            "retained_history"
        } else {
            "referenced"
        };
        assert_eq!(
            value(&client, Request::Delete { id })["kind"],
            expected,
            "source {id}"
        );
    }
    assert_eq!(rows(&fixture.0), before);
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_59_catalog_no_payload_paths_or_forged_authority() {
    for payload in [
        json!({"operation":"create","source":{"name":"Bad","local_path":"/etc"}}),
        json!({"operation":"update","id":1,"patch":{"localPath":"/etc"}}),
        json!({"operation":"list","owner":true}),
        json!({"operation":"list","tenant":"default"}),
    ] {
        assert!(serde_json::from_value::<Request>(payload).is_err());
    }
}
#[test]
fn ticket_t_59_catalog_work_races_delete_through_shared_writer() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = Arc::new(owner.local_source_catalog());
    let id = create(&client, "Race");
    let a = client.clone();
    let b = client.clone();
    let (work, deletion) = std::thread::scope(|scope| {
        let w =
            scope.spawn(move || a.begin_work(id, &AtomicBool::new(false), Duration::from_secs(5)));
        let d = scope.spawn(move || b.execute(Request::Delete { id }));
        (w.join().unwrap(), d.join().unwrap().unwrap())
    });
    match deletion {
        Outcome::Deletion(Deletion::Deleted { .. }) => assert!(work.is_err()),
        Outcome::Deletion(Deletion::ActiveWork) => work.unwrap().release().unwrap(),
        _ => panic!("unexpected deletion"),
    };
    owner.shutdown().unwrap();
}

#[test]
fn ticket_t_59_catalog_deletion_retains_files_and_counts_docs() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    let id = create(&client, "Docs");
    let source = value(&client, Request::Get { id });
    let path = PathBuf::from(source["local_path"].as_str().unwrap());
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("part.stl"), b"retained").unwrap();
    owner.shutdown().unwrap();
    fixture.sql().execute("INSERT INTO source_docs(tenant_id,project_id,path,kind,updated_at) VALUES('default',?1,'readme.md','markdown','then')",[id]).unwrap();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    assert_eq!(value(&client, Request::Get { id })["doc_count"], 1);
    assert_eq!(value(&client, Request::Delete { id })["kind"], "deleted");
    assert_eq!(std::fs::read(path.join("part.stl")).unwrap(), b"retained");
    owner.shutdown().unwrap();
    assert_eq!(
        fixture
            .sql()
            .query_row("SELECT count(*) FROM source_docs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn ticket_t_59_catalog_metadata_rejection_and_legacy_bytes() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    let id = create(&client, "Legacy");
    owner.shutdown().unwrap();
    fixture
        .sql()
        .execute(
            "UPDATE projects SET metadata_json='not-json',source_kind='' WHERE id=?1",
            [id],
        )
        .unwrap();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    value(
        &client,
        Request::Update {
            id,
            patch: SourcePatch {
                name: Some("Changed".into()),
                ..Default::default()
            },
        },
    );
    let mut invalid = NamingProfile::default();
    invalid.quantity.regex = "(bad)(two)".into();
    let before = rows(&fixture.0);
    assert!(
        client
            .execute(Request::SaveNaming {
                id,
                settings: NamingCommand::Override { profile: invalid }
            })
            .is_err()
    );
    assert_eq!(rows(&fixture.0), before);
    owner.shutdown().unwrap();
    let db = fixture.sql();
    assert_eq!(
        db.query_row(
            "SELECT metadata_json,source_kind FROM projects WHERE id=?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        )
        .unwrap(),
        ("not-json".into(), "".into())
    );
}

#[test]
fn ticket_t_59_catalog_public_backpressure() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    let mut admitted = Vec::new();
    let mut rejected = false;
    for i in 0..1000 {
        match client.submit(
            Request::Create {
                source: CreateSource {
                    name: format!("Queued {i}"),
                    ..Default::default()
                },
            },
            &AtomicBool::new(false),
            Duration::ZERO,
        ) {
            Ok(reply) => admitted.push(reply),
            Err(error) => {
                assert_eq!(error.to_string(), "Writer queue full");
                rejected = true;
                break;
            }
        }
    }
    assert!(rejected);
    let count = admitted.len();
    for reply in admitted {
        reply.recv().unwrap().unwrap();
    }
    assert_eq!(
        value(&client, Request::List {}).as_array().unwrap().len(),
        count
    );
    owner.shutdown().unwrap();
}

#[test]
fn ticket_t_59_catalog_build_json_and_scoped_note_references() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    for name in ["Evidence", "Managed", "Pinned", "Decision", "Scoped note"] {
        create(&client, name);
    }
    owner.shutdown().unwrap();
    fixture.sql().execute_batch("INSERT INTO build_profiles(id,tenant_id,name) VALUES(1,'default','Build'); INSERT INTO app_settings(tenant_id,key,value) VALUES('default','build_planning.v1.1','{\"evidence\":[{\"source_id\":1}],\"managed_source_ids\":[2],\"draft_source_revisions\":{\"3\":\"revision\"}}'); INSERT INTO plan_decisions(tenant_id,profile_id,created_at,kind,params_json) VALUES('default',1,'then','applied_action','{\"inputs\":[{\"source_id\":4}]}'); INSERT INTO source_notes(tenant_id,project_id,profile_id,created_at,updated_at) VALUES('default',5,1,'then','then');").unwrap();
    let owner = fixture.open();
    let before = rows(&fixture.0);
    let client = owner.local_source_catalog();
    for id in 1..=5 {
        assert_eq!(value(&client, Request::Delete { id })["kind"], "referenced");
    }
    assert_eq!(rows(&fixture.0), before);
    owner.shutdown().unwrap();
}

fn database_bytes(path: &Path) -> Vec<Option<Vec<u8>>> {
    ["print-partner.db", "print-partner.db-wal"]
        .map(|name| std::fs::read(path.join(name)).ok())
        .into()
}

#[test]
fn catalog_rename_requires_a_name_and_preserves_unique_index_enforcement() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    let first = create(&client, "First");
    create(&client, "Second");

    let error = client
        .execute(Request::Update {
            id: first,
            patch: SourcePatch {
                name: Some(" \u{2003} ".into()),
                ..Default::default()
            },
        })
        .unwrap_err();
    assert_eq!(error.to_string(), "Source name is required");

    assert!(
        client
            .execute(Request::Update {
                id: first,
                patch: SourcePatch {
                    name: Some("Second".into()),
                    ..Default::default()
                },
            })
            .is_err()
    );
    assert_eq!(value(&client, Request::Get { id: first })["name"], "First");
    owner.shutdown().unwrap();
}

#[test]
fn ticket_t_59_catalog_legacy_names_cannot_be_renamed_out_of_history() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    for name in [
        "Legacy",
        "Accepted",
        "Draft",
        "Snapshot",
        "Modern",
        "Empty",
        "Ångström",
    ] {
        create(&client, name);
    }
    owner.shutdown().unwrap();
    fixture.sql().execute_batch("PRAGMA foreign_keys=ON;
        INSERT INTO build_profiles(id,tenant_id,name) VALUES(1,'default','Build');
        INSERT INTO parts(tenant_id,profile_id,match_key,filename,source_layer) VALUES('default',1,'p','a.stl','base:legacy');
        INSERT INTO parts(tenant_id,profile_id,match_key,filename,source_layer) VALUES('default',1,'unicode','b.stl','base:ångström');
        INSERT INTO plan_revisions(id,tenant_id,profile_id,revision_number,provenance_kind,digest_format,snapshot_digest,created_by,accepted_by,created_at,accepted_at) VALUES(1,'default',1,1,'legacy','v1','digest','user','user','then','then');
        INSERT INTO plan_revision_parts(tenant_id,revision_id,part_key,source_layer) VALUES('default',1,'accepted','addon:ACCEPTED');
        INSERT INTO plan_drafts(id,tenant_id,profile_id,base_plan_version,state,digest_format,snapshot_digest,created_by,idempotency_key,created_at) VALUES(1,'default',1,0,'open','v1','digest','fixture','key','then');
        INSERT INTO plan_draft_parts(tenant_id,draft_id,part_key,source_layer) VALUES('default',1,'draft','base:dRaFt');
        INSERT INTO plan_snapshots(tenant_id,profile_id,name,created_at,payload_json) VALUES('default',1,'Historical','then','{\"layers\":[{\"source_name\":\"snapshot\"}]}');
        INSERT INTO plan_revision_input_sets(id,tenant_id,profile_id,input_set_digest,expected_input_count,recorded_at,published_at) VALUES(1,'default',1,'inputs',1,'then','then');
        INSERT INTO plan_revision_inputs(tenant_id,input_set_id,source_id,source_layer,tracking_kind) VALUES('default',1,5,'base:Modern','untracked');
        INSERT INTO plan_revisions(id,tenant_id,profile_id,revision_number,input_set_id,provenance_kind,digest_format,snapshot_digest,created_by,accepted_by,created_at,accepted_at) VALUES(2,'default',1,2,1,'tracked','v1','modern-digest','user','user','then','then');").unwrap();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    let original = rows(&fixture.0);
    let bytes = database_bytes(&fixture.0);
    for id in [1, 2, 3, 4, 7] {
        let error = client
            .execute(Request::Update {
                id,
                patch: SourcePatch {
                    name: Some("Renamed".into()),
                    metadata: Some(
                        serde_json::from_value(json!({"aliases": ["untrusted"]})).unwrap(),
                    ),
                    ..Default::default()
                },
            })
            .unwrap_err();
        assert!(error.to_string().contains("historical name"));
        assert_eq!(value(&client, Request::Delete { id })["kind"], "referenced");
        assert_eq!(rows(&fixture.0), original);
        assert_eq!(database_bytes(&fixture.0), bytes);
    }
    value(
        &client,
        Request::Update {
            id: 1,
            patch: SourcePatch {
                name: Some(" Legacy ".into()),
                ..Default::default()
            },
        },
    );
    assert_eq!(
        value(
            &client,
            Request::Update {
                id: 5,
                patch: SourcePatch {
                    name: Some("Modern renamed".into()),
                    ..Default::default()
                }
            }
        )["name"],
        "Modern renamed"
    );
    assert_eq!(
        value(&client, Request::Delete { id: 5 })["kind"],
        "referenced"
    );
    value(
        &client,
        Request::Update {
            id: 6,
            patch: SourcePatch {
                name: Some("Empty renamed".into()),
                ..Default::default()
            },
        },
    );
    assert_eq!(value(&client, Request::Delete { id: 6 })["kind"], "deleted");
    owner.shutdown().unwrap();
    let owner = fixture.open();
    assert_eq!(
        value(&owner.local_source_catalog(), Request::Get { id: 1 })["name"],
        "Legacy"
    );
    owner.shutdown().unwrap();
}

#[test]
fn ticket_t_59_catalog_regex_complexity_rejection_preserves_writer_and_settings() {
    let fixture = Fixture::new();
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    let id = create(&client, "Naming");
    let original = rows(&fixture.0);
    let bytes = database_bytes(&fixture.0);
    let nested = format!("{}(x){}", "(?:".repeat(16), ")".repeat(16));
    let groups = format!("(x){}", "(?:x)".repeat(64));
    for pattern in [&nested, &groups, "(x", r"(x)[abc", "(x)\\"] {
        for source in [false, true] {
            let mut profile = NamingProfile::default();
            profile.quantity.regex = pattern.into();
            let request = if source {
                Request::SaveNaming {
                    id,
                    settings: NamingCommand::Override { profile },
                }
            } else {
                Request::SaveGlobalNaming { profile }
            };
            assert!(client.execute(request).is_err(), "{pattern}");
            assert_eq!(value(&client, Request::Get { id })["name"], "Naming");
            assert_eq!(rows(&fixture.0), original);
            assert_eq!(database_bytes(&fixture.0), bytes);
        }
    }
    for pattern in [
        r"(?<=x)([0-9]+)\.stl$",
        r"(?=x)(x)\1",
        r"[(](x)[)]",
        r"\((x)\)",
        r"[\](](x)",
    ] {
        let mut profile = NamingProfile::default();
        profile.quantity.regex = pattern.into();
        value(
            &client,
            Request::SaveNaming {
                id,
                settings: NamingCommand::Override { profile },
            },
        );
        assert_eq!(
            value(&client, Request::GetNaming { id })["effective"]["quantity"]["regex"],
            pattern
        );
    }
    for pattern in [
        format!("{}(x){}", "(?:".repeat(15), ")".repeat(15)),
        format!("(x){}", "(?:x)".repeat(63)),
    ] {
        let mut profile = NamingProfile::default();
        profile.quantity.regex = pattern.clone();
        value(
            &client,
            Request::SaveNaming {
                id,
                settings: NamingCommand::Override { profile },
            },
        );
        assert_eq!(
            value(&client, Request::GetNaming { id })["effective"]["quantity"]["regex"],
            pattern
        );
    }
    owner.shutdown().unwrap();
    let mut stored = serde_json::to_value(NamingProfile::default()).unwrap();
    stored["quantity"]["regex"] = json!(nested);
    let db = fixture.sql();
    db.execute("INSERT INTO app_settings(tenant_id,key,value) VALUES('default','stl_naming_defaults',?1) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value", [stored.to_string()]).unwrap();
    db.execute(
        "UPDATE projects SET metadata_json=?1 WHERE id=?2",
        rusqlite::params![
            json!({"naming":{"use_defaults":false,"override":stored}}).to_string(),
            id
        ],
    )
    .unwrap();
    drop(db);
    let owner = fixture.open();
    let client = owner.local_source_catalog();
    let original = rows(&fixture.0);
    let bytes = database_bytes(&fixture.0);
    assert!(client.execute(Request::GetNaming { id }).is_err());
    assert_eq!(
        value(&client, Request::GetGlobalNaming {})["quantity"]["regex"],
        NamingProfile::default().quantity.regex
    );
    assert_eq!(value(&client, Request::Get { id })["name"], "Naming");
    assert_eq!(rows(&fixture.0), original);
    assert_eq!(database_bytes(&fixture.0), bytes);
    owner.shutdown().unwrap();
}
