use pp_contracts::{PositiveId, build_identity::BuildName};
use pp_storage::{
    Limits, WriterOwner,
    auth::{
        AuthPolicy, FirstUserTenant, Outcome as AuthOutcome, RegistrationPolicy, Request, Secret,
        SessionTenantPolicy,
    },
    build_graph::{BuildCommand, BuildOutcome, ManifestOptionsCommand, ManifestOptionsOutcome},
    read_model::Credential,
};
use rusqlite::Connection;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("pp-manifest-options-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&directory).unwrap();
        Self(directory)
    }

    fn owner(&self) -> WriterOwner {
        WriterOwner::open(&self.0, Limits::default()).unwrap().0
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

fn register(owner: &WriterOwner) -> String {
    register_as(owner, "manifest@example.test")
}

fn register_as(owner: &WriterOwner, email: &str) -> String {
    let AuthOutcome::Session { token, .. } = owner
        .auth(FirstUserTenant::NewUser)
        .submit(
            Request::Register {
                email: email.into(),
                display_name: "Manifest".into(),
                password: Secret::new("manifest-password-123".into()),
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
    token.expose().into()
}

#[test]
fn manifest_owner_preserves_tenant_cancellation_stop_and_missing_ordering() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let token = register(&owner);
    let foreign = register_as(&owner, "manifest-foreign@example.test");
    let client = owner.build_graph_with_policy(policy()).unwrap();
    let BuildOutcome::Created { profile, .. } = execute(
        &client,
        &token,
        BuildCommand::Create {
            name: BuildName::parse("Manifest guards".into()).unwrap(),
            base_source: None,
        },
    ) else {
        panic!("build expected")
    };
    let build = PositiveId::new(profile.id as u64).unwrap();
    assert!(matches!(
        execute(
            &client,
            &foreign,
            BuildCommand::Manifest(ManifestOptionsCommand::ReadKit { build })
        ),
        BuildOutcome::Manifest(ManifestOptionsOutcome::MissingBuild)
    ));
    let missing = PositiveId::new(9_007_199_254_740_991).unwrap();
    assert!(matches!(
        execute(
            &client,
            &token,
            BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
                build: missing,
                request: br#"{"kit":{"name":7}}"#.to_vec(),
            })
        ),
        BuildOutcome::Manifest(ManifestOptionsOutcome::MissingBuild)
    ));
    let cancelled = Arc::new(AtomicBool::new(true));
    let error = client
        .execute(
            Credential::Session(Secret::new(token.clone())),
            BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
                build,
                request: br#"{"kit":{"name":"cancelled"}}"#.to_vec(),
            }),
            cancelled,
            Duration::from_secs(2),
        )
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref(),
        Some(pp_storage::build_graph::Failure::Cancelled)
    ));
    let kit = manifest_json(execute(
        &client,
        &token,
        BuildCommand::Manifest(ManifestOptionsCommand::ReadKit { build }),
    ));
    assert!(kit["kit"]["name"].is_null());
    owner.shutdown().unwrap();
    let error = client
        .execute(
            Credential::Session(Secret::new(token)),
            BuildCommand::Manifest(ManifestOptionsCommand::ReadBuilder { build }),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
        )
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref(),
        Some(pp_storage::build_graph::Failure::Stopped)
    ));
}

#[test]
fn kit_setting_and_build_freshness_commit_together_and_reopen() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let token = register(&owner);
    let client = owner.build_graph_with_policy(policy()).unwrap();
    let BuildOutcome::Created { profile, .. } = execute(
        &client,
        &token,
        BuildCommand::Create {
            name: BuildName::parse("Atomic manifest save".into()).unwrap(),
            base_source: None,
        },
    ) else {
        panic!("build expected")
    };
    let build = PositiveId::new(profile.id as u64).unwrap();
    owner.shutdown().unwrap();
    let database = Connection::open(fixture.0.join("print-partner.db")).unwrap();
    let before: String = database
        .query_row(
            "SELECT config_modified_at FROM build_profiles WHERE id=?1",
            [profile.id],
            |row| row.get(0),
        )
        .unwrap();
    let absent: i64 = database
        .query_row(
            "SELECT count(*) FROM app_settings WHERE key=?1",
            [format!("kit_manifest_{}", profile.id)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(absent, 0);
    drop(database);
    std::thread::sleep(Duration::from_millis(2));
    let owner = fixture.owner();
    let client = owner.build_graph_with_policy(policy()).unwrap();
    assert!(matches!(
        execute(
            &client,
            &token,
            BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
                build,
                request: br#"{"kit":{"name":"Committed"}}"#.to_vec(),
            })
        ),
        BuildOutcome::Manifest(ManifestOptionsOutcome::Saved { .. })
    ));
    owner.shutdown().unwrap();
    let database = Connection::open(fixture.0.join("print-partner.db")).unwrap();
    let (after, stored): (String, String) = database
        .query_row(
            "SELECT build.config_modified_at,setting.value FROM build_profiles build JOIN app_settings setting ON setting.tenant_id=build.tenant_id AND setting.key=?1 WHERE build.id=?2",
            (format!("kit_manifest_{}", profile.id), profile.id),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_ne!(before, after);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&stored).unwrap()["name"],
        "Committed"
    );
    drop(database);
    let owner = fixture.owner();
    let client = owner.build_graph_with_policy(policy()).unwrap();
    let kit = manifest_json(execute(
        &client,
        &token,
        BuildCommand::Manifest(ManifestOptionsCommand::ReadKit { build }),
    ));
    assert_eq!(kit["kit"]["name"], "Committed");
    owner.shutdown().unwrap();
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

fn manifest_json(outcome: BuildOutcome) -> serde_json::Value {
    serde_json::from_slice(&manifest_bytes(outcome)).unwrap()
}

fn manifest_bytes(outcome: BuildOutcome) -> Vec<u8> {
    let BuildOutcome::Manifest(outcome) = outcome else {
        panic!("manifest outcome expected")
    };
    outcome.into_success_body().unwrap().into_bytes()
}

#[test]
fn node_representation_survives_save_storage_and_reopen() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let token = register(&owner);
    let client = owner.build_graph_with_policy(policy()).unwrap();
    let BuildOutcome::Created { profile, .. } = execute(
        &client,
        &token,
        BuildCommand::Create {
            name: BuildName::parse("Node representation".into()).unwrap(),
            base_source: None,
        },
    ) else {
        panic!("build expected")
    };
    let build = PositiveId::new(profile.id as u64).unwrap();
    let request = br#"{"kit":{"name":"\ud800","layers":["\udc00"],"base_source_id":"x\ud800","addon_source_ids":["\ud800x"],"selections":{" group ":" \ufeffstock\ufeff ","\ud800":["\udc00"]},"include":["\ud800"],"exclude":["\udc00"],"replacements":{"b":"first","2":"two","1":"one","\ud800":"\udc00","b":"last"},"choice_tree":[{"b":1,"2":"two","a":3,"1":"one","b":4}],"category_links":["\ud800"]}}"#;
    let kit = br#"{"name":"\ud800","layers":["\udc00"],"base_source_id":"x\ud800","addon_source_ids":["\ud800x"],"selections":{" group ":"stock","\ud800":["\udc00"]},"include":["\ud800"],"exclude":["\udc00"],"replacements":{"1":"one","2":"two","b":"last","\ud800":"\udc00"},"choice_tree":[{"1":"one","2":"two","b":4,"a":3}],"category_links":["\ud800"]}"#;
    let expected = [
        format!(r#"{{"profile_id":{},"kit":"#, profile.id).into_bytes(),
        kit.to_vec(),
        b"}".to_vec(),
    ]
    .concat();
    let saved = manifest_bytes(execute(
        &client,
        &token,
        BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
            build,
            request: request.to_vec(),
        }),
    ));
    assert_eq!(saved, expected);
    owner.shutdown().unwrap();

    let database = Connection::open(fixture.0.join("print-partner.db")).unwrap();
    let stored: String = database
        .query_row(
            "SELECT value FROM app_settings WHERE key=?1",
            [format!("kit_manifest_{}", profile.id)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored.as_bytes(), kit);
    drop(database);

    let owner = fixture.owner();
    let client = owner.build_graph_with_policy(policy()).unwrap();
    let reopened = manifest_bytes(execute(
        &client,
        &token,
        BuildCommand::Manifest(ManifestOptionsCommand::ReadKit { build }),
    ));
    assert_eq!(reopened, expected);
    owner.shutdown().unwrap();
}

#[test]
fn saved_kit_resets_omitted_fields_normalizes_numbers_and_falls_back_from_malformed_storage() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let token = register(&owner);
    let client = owner.build_graph_with_policy(policy()).unwrap();
    let BuildOutcome::Created { profile, .. } = execute(
        &client,
        &token,
        BuildCommand::Create {
            name: BuildName::parse("Manifest build".into()).unwrap(),
            base_source: None,
        },
    ) else {
        panic!("build expected")
    };
    let build = PositiveId::new(profile.id as u64).unwrap();
    let populated = br#"{"kit":{"name":"Populated","layers":["layer"],"selections":{"retired":["old"]},"include":["part"],"choice_tree":[9007199254740993,1e400]}}"#;
    let kit = manifest_json(execute(
        &client,
        &token,
        BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
            build,
            request: populated.to_vec(),
        }),
    ));
    assert_eq!(
        kit["kit"]["choice_tree"],
        json!([9007199254740992u64, null])
    );
    let recursive = json!({
        "kit": {
            "choice_tree": [null, true, "text", [1], {"nested": [false]}],
            "category_links": [{"category": "toolhead"}]
        }
    });
    let kit = manifest_json(execute(
        &client,
        &token,
        BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
            build,
            request: serde_json::to_vec(&recursive).unwrap(),
        }),
    ));
    assert_eq!(kit["kit"]["choice_tree"], recursive["kit"]["choice_tree"]);
    let mut too_deep = serde_json::Value::Null;
    for _ in 0..66 {
        too_deep = json!([too_deep]);
    }
    for rejected in [
        serde_json::to_vec(&json!({"kit":{"choice_tree":[too_deep]}})).unwrap(),
        serde_json::to_vec(&json!({"kit":{"choice_tree":vec![serde_json::Value::Null; 100_001]}}))
            .unwrap(),
        vec![b' '; 8 * 1024 * 1024 + 1],
    ] {
        assert!(matches!(
            execute(
                &client,
                &token,
                BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
                    build,
                    request: rejected,
                })
            ),
            BuildOutcome::Manifest(ManifestOptionsOutcome::InvalidInput { .. })
        ));
    }
    let partial = json!({"kit":{"name":"Partial"}});
    assert!(matches!(
        execute(
            &client,
            &token,
            BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
                build,
                request: serde_json::to_vec(&partial).unwrap()
            })
        ),
        BuildOutcome::Manifest(ManifestOptionsOutcome::Saved { .. })
    ));
    let kit = manifest_json(execute(
        &client,
        &token,
        BuildCommand::Manifest(ManifestOptionsCommand::ReadKit { build }),
    ));
    assert_eq!(
        kit["kit"],
        json!({"name":"Partial","layers":[],"base_source_id":null,"addon_source_ids":[],"selections":{},"include":[],"exclude":[],"replacements":{},"choice_tree":[],"category_links":[]})
    );
    owner.shutdown().unwrap();
    let database = Connection::open(fixture.0.join("print-partner.db")).unwrap();
    database.execute("UPDATE app_settings SET value='{' WHERE tenant_id=(SELECT tenant_id FROM build_profiles WHERE id=?1) AND key=?2", (profile.id, format!("kit_manifest_{}", profile.id))).unwrap();
    drop(database);
    let owner = fixture.owner();
    let client = owner.build_graph_with_policy(policy()).unwrap();
    let kit = manifest_json(execute(
        &client,
        &token,
        BuildCommand::Manifest(ManifestOptionsCommand::ReadKit { build }),
    ));
    assert_eq!(
        kit["kit"],
        json!({"name":null,"layers":[],"base_source_id":null,"addon_source_ids":[],"selections":{},"include":[],"exclude":[],"replacements":{},"choice_tree":[],"category_links":[]})
    );
    owner.shutdown().unwrap();
}
