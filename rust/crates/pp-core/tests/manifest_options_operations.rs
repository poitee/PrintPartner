use pp_contracts::{PositiveId, build_identity::BuildName};
use pp_core::draft_observations::{DraftReadConfiguration, FilesystemPolicy, issue_build_graph};
use pp_storage::{
    Limits, WriterOwner,
    auth::{
        AuthPolicy, FirstUserTenant, Outcome as AuthOutcome, RegistrationPolicy, Request, Secret,
        SessionTenantPolicy,
    },
    build_graph::{BuildCommand, BuildOutcome, ManifestOptionsCommand, ManifestOptionsOutcome},
    catalog::{CreateSource, Credentials, Outcome as CatalogOutcome, Request as CatalogRequest},
    read_model::Credential,
};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        first_user: FirstUserTenant::NewUser,
        session_tenant: SessionTenantPolicy::AccountTenant,
    }
}

fn manifest_json(outcome: BuildOutcome) -> serde_json::Value {
    let BuildOutcome::Manifest(outcome) = outcome else {
        panic!("manifest outcome expected")
    };
    serde_json::from_slice(&outcome.into_success_body().unwrap().into_bytes()).unwrap()
}

#[test]
fn builder_observes_the_controlled_live_manifest_and_stl_inventory() {
    let root = std::env::temp_dir().join(format!(
        "pp-live-manifest-options-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let AuthOutcome::Session { token, .. } = owner
        .auth(FirstUserTenant::NewUser)
        .submit(
            Request::Register {
                email: "live-manifest@example.test".into(),
                display_name: "Live Manifest".into(),
                password: Secret::new("live-manifest-password-123".into()),
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
    let token = token.expose().to_owned();
    let catalog = owner.source_catalog(Credentials::Session(Secret::new(token.clone())));
    let CatalogOutcome::Source(Some(source)) = catalog
        .execute(CatalogRequest::Create {
            source: CreateSource {
                name: "Live Source".into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..CreateSource::default()
            },
        })
        .unwrap()
    else {
        panic!("source expected")
    };
    let source_root = source
        .local_path
        .as_ref()
        .map(std::path::PathBuf::from)
        .unwrap();
    fs::create_dir_all(source_root.join("toolhead")).unwrap();
    fs::write(
        source_root.join("toolhead/stock.stl"),
        b"solid stock\nendsolid stock\n",
    )
    .unwrap();
    fs::write(
        source_root.join("print-partner.manifest.yaml"),
        b"format: print-partner-manifest-v2\nversion: 2\nproject: Live Source\noption_groups:\n  toolhead:\n    rule: pick_one\n    variants:\n      - id: stock\n        parts: [\"toolhead/**\"]\nselections:\n  toolhead: stock\n",
    )
    .unwrap();
    let graph = issue_build_graph(
        &owner,
        policy(),
        DraftReadConfiguration {
            repos: root.join("repos"),
            limits: pp_storage::working_drafts::observation::PreparationLimits::default(),
            relative_base: root.join("repos"),
            policy: FilesystemPolicy::Isolated,
            shipped_hints: [root.join("missing-hints-1"), root.join("missing-hints-2")],
            custom_hints: None,
            community_manifests: BTreeMap::new(),
        },
    )
    .unwrap();
    let execute = |command| {
        graph
            .execute(
                Credential::Session(Secret::new(token.clone())),
                command,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
            .unwrap()
    };
    let BuildOutcome::Created { profile, .. } = execute(BuildCommand::Create {
        name: BuildName::parse("Live manifest build".into()).unwrap(),
        base_source: Some(PositiveId::new(source.id as u64).unwrap()),
    }) else {
        panic!("build expected")
    };
    let BuildOutcome::Manifest(ManifestOptionsOutcome::Builder(builder)) = execute(
        BuildCommand::Manifest(ManifestOptionsCommand::ReadBuilder {
            build: PositiveId::new(profile.id as u64).unwrap(),
        }),
    ) else {
        panic!("builder expected")
    };
    let builder: serde_json::Value = serde_json::from_slice(
        &ManifestOptionsOutcome::Builder(builder)
            .into_success_body()
            .unwrap()
            .into_bytes(),
    )
    .unwrap();
    assert_eq!(builder["sources"][0]["exists"], true);
    assert_eq!(
        builder["sources"][0]["scanned_parts"][0]["relative_path"],
        "toolhead/stock.stl"
    );
    assert_eq!(
        builder["merged_option_groups"]["toolhead"]["variants"][0]["source_id"],
        source.id
    );
    assert!(matches!(
        execute(BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
            build: PositiveId::new(profile.id as u64).unwrap(),
            request: br#"{"kit":{"selections":{"toolhead":[]}}}"#.to_vec(),
        })),
        BuildOutcome::Manifest(ManifestOptionsOutcome::InvalidInput { .. })
    ));
    let kit = manifest_json(execute(BuildCommand::Manifest(
        ManifestOptionsCommand::ReadKit {
            build: PositiveId::new(profile.id as u64).unwrap(),
        },
    )));
    assert_eq!(kit["kit"]["selections"], serde_json::json!({}));
    fs::create_dir_all(source_root.join("options/stock")).unwrap();
    fs::create_dir_all(source_root.join("options/custom")).unwrap();
    fs::write(source_root.join("options/stock/a.stl"), b"solid a\n").unwrap();
    fs::write(source_root.join("options/custom/b.stl"), b"solid b\n").unwrap();
    fs::write(
        source_root.join("print-partner.manifest.yaml"),
        b"not: [valid",
    )
    .unwrap();
    let BuildOutcome::Manifest(ManifestOptionsOutcome::Builder(fallback)) = execute(
        BuildCommand::Manifest(ManifestOptionsCommand::ReadBuilder {
            build: PositiveId::new(profile.id as u64).unwrap(),
        }),
    ) else {
        panic!("fallback builder expected")
    };
    let fallback: serde_json::Value = serde_json::from_slice(
        &ManifestOptionsOutcome::Builder(fallback)
            .into_success_body()
            .unwrap()
            .into_bytes(),
    )
    .unwrap();
    assert_eq!(fallback["sources"][0]["exists"], false);
    assert!(
        fallback["sources"][0]["yaml"]
            .as_str()
            .unwrap()
            .contains("Live Source")
    );
    assert_eq!(
        fallback["sources"][0]["scanned_parts"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert!(
        !fallback["merged_option_groups"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    let constrained = issue_build_graph(
        &owner,
        policy(),
        DraftReadConfiguration {
            repos: root.join("repos"),
            limits: pp_storage::working_drafts::observation::PreparationLimits {
                nodes: 1,
                ..pp_storage::working_drafts::observation::PreparationLimits::default()
            },
            relative_base: root.join("repos"),
            policy: FilesystemPolicy::Isolated,
            shipped_hints: [root.join("missing-hints-1"), root.join("missing-hints-2")],
            custom_hints: None,
            community_manifests: BTreeMap::new(),
        },
    )
    .unwrap();
    assert!(matches!(
        constrained
            .execute(
                Credential::Session(Secret::new(token.clone())),
                BuildCommand::Manifest(ManifestOptionsCommand::ReadBuilder {
                    build: PositiveId::new(profile.id as u64).unwrap(),
                }),
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
            .unwrap(),
        BuildOutcome::Manifest(ManifestOptionsOutcome::ObservationFailed { .. })
    ));
    fs::create_dir_all(source_root.join("bulk")).unwrap();
    for index in 0..9000 {
        fs::write(
            source_root.join(format!("bulk/{index:04}.stl")),
            b"solid bulk\n",
        )
        .unwrap();
    }
    let changing = Arc::new(AtomicBool::new(true));
    let writes = Arc::new(AtomicUsize::new(0));
    let mutating_root = source_root.clone();
    let changing_for_thread = changing.clone();
    let writes_for_thread = writes.clone();
    let mutator = std::thread::spawn(move || {
        let mut revision = 0usize;
        while changing_for_thread.load(Ordering::Acquire) {
            revision += 1;
            let replacement = mutating_root.join("print-partner.manifest.yaml.next");
            fs::write(
                &replacement,
                format!("project: Live Source\n# observation revision {revision}\n"),
            )
            .unwrap();
            fs::rename(
                replacement,
                mutating_root.join("print-partner.manifest.yaml"),
            )
            .unwrap();
            writes_for_thread.store(revision, Ordering::Release);
        }
    });
    while writes.load(Ordering::Acquire) < 10 {
        std::thread::yield_now();
    }
    let stale_save = execute(BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
        build: PositiveId::new(profile.id as u64).unwrap(),
        request: br#"{"kit":{"name":"must stay unsaved"}}"#.to_vec(),
    }));
    assert!(
        matches!(
            stale_save,
            BuildOutcome::Manifest(ManifestOptionsOutcome::StaleObservation)
        ),
        "{stale_save:?}"
    );
    assert!(matches!(
        execute(BuildCommand::Manifest(
            ManifestOptionsCommand::ReadBuilder {
                build: PositiveId::new(profile.id as u64).unwrap(),
            }
        )),
        BuildOutcome::Manifest(ManifestOptionsOutcome::StaleObservation)
    ));
    changing.store(false, Ordering::Release);
    mutator.join().unwrap();
    let kit = manifest_json(execute(BuildCommand::Manifest(
        ManifestOptionsCommand::ReadKit {
            build: PositiveId::new(profile.id as u64).unwrap(),
        },
    )));
    assert!(kit["kit"]["name"].is_null());
    let CatalogOutcome::Source(Some(addon)) = catalog
        .execute(CatalogRequest::Create {
            source: CreateSource {
                name: "Concurrent Addon".into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..CreateSource::default()
            },
        })
        .unwrap()
    else {
        panic!("addon source expected")
    };
    let concurrent_graph = graph.clone();
    let concurrent_token = token.clone();
    let concurrent = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(10));
        concurrent_graph
            .execute(
                Credential::Session(Secret::new(concurrent_token)),
                BuildCommand::AttachAddon {
                    build: PositiveId::new(profile.id as u64).unwrap(),
                    source: PositiveId::new(addon.id as u64).unwrap(),
                },
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
            .unwrap()
    });
    let database_stale = execute(BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
        build: PositiveId::new(profile.id as u64).unwrap(),
        request: br#"{"kit":{"name":"database stale"}}"#.to_vec(),
    }));
    assert!(matches!(
        concurrent.join().unwrap(),
        BuildOutcome::Layers { .. }
    ));
    assert!(
        matches!(
            database_stale,
            BuildOutcome::Manifest(ManifestOptionsOutcome::StaleObservation)
        ),
        "{database_stale:?}"
    );
    let kit = manifest_json(execute(BuildCommand::Manifest(
        ManifestOptionsCommand::ReadKit {
            build: PositiveId::new(profile.id as u64).unwrap(),
        },
    )));
    assert!(kit["kit"]["name"].is_null());
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_after_admission = cancelled.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1));
        cancel_after_admission.store(true, Ordering::Release);
    });
    let error = graph
        .execute(
            Credential::Session(Secret::new(token)),
            BuildCommand::Manifest(ManifestOptionsCommand::ReadBuilder {
                build: PositiveId::new(profile.id as u64).unwrap(),
            }),
            cancelled,
            Duration::from_secs(2),
        )
        .unwrap_err();
    canceller.join().unwrap();
    assert!(matches!(
        error.downcast_ref(),
        Some(pp_storage::build_graph::Failure::Cancelled)
    ));
    println!(
        "manifest_operation_observation={}",
        serde_json::json!({
            "live_manifest":true,
            "live_stl_inventory":true,
            "malformed_manifest_fallback":true,
            "inferred_groups":true,
            "reader_limit_refusal":"ObservationFailed",
            "save_source_stale":"StaleObservation",
            "read_builder_persistent_stale":"StaleObservation",
            "save_database_stale":"StaleObservation",
            "cancel_during_large_observation":"Cancelled",
            "stale_and_cancelled_kit_name":null,
            "read_builder_retry_limit":1,
            "save_retry_limit":0,
        })
    );
    owner.shutdown().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn source_budget_refusal_preserves_kit_setting_and_freshness_rows() {
    let root = std::env::temp_dir().join(format!(
        "pp-manifest-budget-refusal-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let AuthOutcome::Session { token, .. } = owner
        .auth(FirstUserTenant::NewUser)
        .submit(
            Request::Register {
                email: "manifest-budget@example.test".into(),
                display_name: "Manifest Budget".into(),
                password: Secret::new("manifest-budget-password-123".into()),
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
    let token = token.expose().to_owned();
    let catalog = owner.source_catalog(Credentials::Session(Secret::new(token.clone())));
    let CatalogOutcome::Source(Some(source)) = catalog
        .execute(CatalogRequest::Create {
            source: CreateSource {
                name: "Budget Source".into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..CreateSource::default()
            },
        })
        .unwrap()
    else {
        panic!("source expected")
    };
    let source_root = std::path::PathBuf::from(source.local_path.as_ref().unwrap());
    fs::create_dir_all(source_root.join("toolhead")).unwrap();
    fs::write(source_root.join("toolhead/stock.stl"), b"solid stock\n").unwrap();
    fs::write(
        source_root.join("print-partner.manifest.yaml"),
        b"format: print-partner-manifest-v2\nversion: 2\nproject: Budget Source\noption_groups:\n  toolhead:\n    rule: pick_one\n    variants:\n      - id: stock\n        parts: [\"toolhead/**\"]\n",
    )
    .unwrap();
    let configuration = |nodes| DraftReadConfiguration {
        repos: root.join("repos"),
        limits: pp_storage::working_drafts::observation::PreparationLimits {
            nodes,
            ..pp_storage::working_drafts::observation::PreparationLimits::default()
        },
        relative_base: root.join("repos"),
        policy: FilesystemPolicy::Isolated,
        shipped_hints: [root.join("missing-hints-1"), root.join("missing-hints-2")],
        custom_hints: None,
        community_manifests: BTreeMap::new(),
    };
    let graph = issue_build_graph(&owner, policy(), configuration(100_000)).unwrap();
    let execute = |command| {
        graph
            .execute(
                Credential::Session(Secret::new(token.clone())),
                command,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
            .unwrap()
    };
    let BuildOutcome::Created { profile, .. } = execute(BuildCommand::Create {
        name: BuildName::parse("Budget refusal".into()).unwrap(),
        base_source: Some(PositiveId::new(source.id as u64).unwrap()),
    }) else {
        panic!("build expected")
    };
    let build = PositiveId::new(profile.id as u64).unwrap();
    assert!(matches!(
        execute(BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
            build,
            request: br#"{"kit":{"name":"baseline"}}"#.to_vec(),
        })),
        BuildOutcome::Manifest(ManifestOptionsOutcome::Saved { .. })
    ));
    owner.shutdown().unwrap();

    let rows = || {
        let database = rusqlite::Connection::open(root.join("print-partner.db")).unwrap();
        database
            .query_row(
                "SELECT build.config_modified_at,setting.value FROM build_profiles build JOIN app_settings setting ON setting.tenant_id=build.tenant_id AND setting.key=?1 WHERE build.id=?2",
                (format!("kit_manifest_{}", profile.id), profile.id),
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap()
    };
    let before = rows();

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let constrained = issue_build_graph(&owner, policy(), configuration(1)).unwrap();
    let refused = constrained
        .execute(
            Credential::Session(Secret::new(token)),
            BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
                build,
                request: br#"{"kit":{"name":"must stay unsaved"}}"#.to_vec(),
            }),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
        )
        .unwrap();
    assert!(matches!(
        refused,
        BuildOutcome::Manifest(ManifestOptionsOutcome::ObservationFailed { .. })
    ));
    owner.shutdown().unwrap();
    assert_eq!(rows(), before);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn owned_loopback_builder_observes_live_source_on_every_alias() {
    let root = std::env::temp_dir().join(format!(
        "pp-live-manifest-http-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let mut child = Command::new(env!("CARGO_BIN_EXE_drafts-http-fixture"))
        .arg(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let startup: serde_json::Value = serde_json::from_str(&line).unwrap();
    let origin = startup["origin"].as_str().unwrap();
    println!(
        "manifest_loopback_receipt={}",
        serde_json::json!({"origin":origin,"pid":child.id(),"writer_owners":startup["writer_owners"]})
    );
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let registered = client
        .post(format!("{origin}/auth/register"))
        .header("Origin", origin)
        .json(&serde_json::json!({"email":"loopback-manifest@example.test","password":"loopback-manifest-password-123"}))
        .send()
        .await
        .unwrap();
    assert_eq!(registered.status(), 200);
    let cookie = registered.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let source = client
        .post(format!("{origin}/sources"))
        .header("Origin", origin)
        .header("Cookie", cookie)
        .json(&serde_json::json!({"name":"Loopback Source","source_kind":"local"}))
        .send()
        .await
        .unwrap();
    assert_eq!(source.status(), 200);
    let source: serde_json::Value = source.json().await.unwrap();
    let source_id = source["id"].as_i64().unwrap();
    let source_root = root.join("repos").join(source_id.to_string());
    fs::create_dir_all(source_root.join("toolhead/stock")).unwrap();
    fs::create_dir_all(source_root.join("toolhead/custom")).unwrap();
    fs::write(
        source_root.join("toolhead/stock/stock.stl"),
        b"solid stock\nendsolid stock\n",
    )
    .unwrap();
    fs::write(
        source_root.join("toolhead/custom/custom.stl"),
        b"solid custom\nendsolid custom\n",
    )
    .unwrap();
    fs::write(
        source_root.join("print-partner.manifest.yaml"),
        b"format: print-partner-manifest-v2\nversion: 2\nproject: Loopback Source\noption_groups:\n  toolhead:\n    rule: pick_one\n    variants:\n      - id: stock\n        parts: [\"toolhead/stock/**\"]\n      - id: custom\n        parts: [\"toolhead/custom/**\"]\nselections:\n  toolhead: stock\n",
    )
    .unwrap();
    let build = client
        .post(format!("{origin}/plans"))
        .header("Origin", origin)
        .header("Cookie", cookie)
        .json(&serde_json::json!({"name":"Loopback Manifest","base_project_id":source_id}))
        .send()
        .await
        .unwrap();
    assert_eq!(build.status(), 200);
    let build: serde_json::Value = build.json().await.unwrap();
    let build_id = build["id"].as_i64().unwrap();
    let mut first_builder = None;
    for prefix in ["", "/api/v2", "/api/v1"] {
        let path = format!("{prefix}/plans/{build_id}/plan-manifest-builder");
        let response = client
            .get(format!("{origin}{path}"))
            .header("Cookie", cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["sources"][0]["exists"], true);
        assert_eq!(body["resolved_selections"]["toolhead"], "stock");
        assert_eq!(
            body["sources"][0]["scanned_parts"][0]["relative_path"],
            "toolhead/custom/custom.stl"
        );
        assert_eq!(
            body["merged_option_groups"]["toolhead"]["variants"][0]["source_id"],
            source_id
        );
        first_builder.get_or_insert_with(|| body.clone());
        let head = client
            .head(format!("{origin}{path}"))
            .header("Cookie", cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(head.status(), 200);
        assert!(head.bytes().await.unwrap().is_empty());
    }
    let saved = client
        .put(format!("{origin}/plans/{build_id}/kit-manifest"))
        .header("Origin", origin)
        .header("Cookie", cookie)
        .header("content-type", "application/json")
        .body(r#"{"kit":{"name":"\ud800","selections":{"toolhead":"custom"}}}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), 200);
    let saved = saved.text().await.unwrap();
    assert!(saved.contains(r#""name":"\ud800""#), "{saved}");
    assert!(
        saved.contains(r#""selections":{"toolhead":"custom"}"#),
        "{saved}"
    );
    let recompute = |key: &str, apply_manifest: bool| {
        client
            .post(format!("{origin}/plans/{build_id}/drafts/recompute"))
            .header("Origin", origin)
            .header("Cookie", cookie)
            .header("Idempotency-Key", key)
            .json(&serde_json::json!({"apply_manifest":apply_manifest}))
            .send()
    };
    let selected = recompute("manifest-selected", true).await.unwrap();
    let selected_status = selected.status();
    let selected: serde_json::Value = selected.json().await.unwrap();
    assert_eq!(selected_status, 200, "{selected}");
    let selected_parts = selected["parts"].as_array().unwrap();
    assert_eq!(selected_parts.len(), 2);
    assert!(selected_parts.iter().any(|part| {
        part["relative_path"] == "toolhead/custom/custom.stl" && part["included"] == true
    }));
    assert!(selected_parts.iter().any(|part| {
        part["relative_path"] == "toolhead/stock/stock.stl" && part["included"] == false
    }));
    let unfiltered = recompute("manifest-unfiltered", false).await.unwrap();
    let unfiltered_status = unfiltered.status();
    let unfiltered: serde_json::Value = unfiltered.json().await.unwrap();
    assert_eq!(unfiltered_status, 200, "{unfiltered}");
    let unfiltered_parts = unfiltered["parts"].as_array().unwrap();
    assert_eq!(unfiltered_parts.len(), 2);
    assert!(
        unfiltered_parts
            .iter()
            .all(|part| part["relative_path"].as_str().is_some())
    );
    println!(
        "manifest_http_observation={}",
        serde_json::json!({
            "builder_aliases":6,
            "get_statuses":[200,200,200],
            "head_statuses":[200,200,200],
            "head_body_bytes":[0,0,0],
            "builder":first_builder.unwrap(),
            "saved":saved,
            "draft_apply_manifest_true":selected,
            "draft_apply_manifest_false":unfiltered,
        })
    );
    child.stdin.take().unwrap().write_all(b"\n").unwrap();
    assert!(child.wait().unwrap().success());
    let database = rusqlite::Connection::open(root.join("print-partner.db")).unwrap();
    let mut statement = database
        .prepare("SELECT draft_id,source_id,source_layer,layer_order,tracking_kind,source_revision_id,manifest_digest,effective_naming_digest FROM plan_draft_inputs ORDER BY draft_id")
        .unwrap();
    let inputs = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "draft_id":row.get::<_,i64>(0)?,
                "source_id":row.get::<_,i64>(1)?,
                "source_layer":row.get::<_,String>(2)?,
                "layer_order":row.get::<_,i64>(3)?,
                "tracking_kind":row.get::<_,String>(4)?,
                "source_revision_id":row.get::<_,Option<i64>>(5)?,
                "manifest_digest":row.get::<_,Option<String>>(6)?,
                "effective_naming_digest":row.get::<_,String>(7)?,
            }))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(inputs.len(), 2);
    for input in &inputs {
        assert_eq!(input["source_id"], source_id);
        assert_eq!(input["source_layer"], "base:Loopback Source");
        assert_eq!(input["layer_order"], 0);
        assert_eq!(input["tracking_kind"], "untracked");
        assert!(input["source_revision_id"].is_null());
        assert!(input["manifest_digest"].is_null());
        assert!(input["effective_naming_digest"].as_str().is_some());
    }
    assert_eq!(
        inputs[0]["effective_naming_digest"],
        inputs[1]["effective_naming_digest"]
    );
    println!("manifest_draft_inputs={}", serde_json::json!(inputs));
    drop(statement);
    drop(database);
    fs::remove_dir_all(root).unwrap();
}
