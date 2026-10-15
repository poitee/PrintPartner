#![cfg(feature = "desktop_rebuild")]
use pp_domain::PositiveId;
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    build_graph::{
        AcceptedProgress, AcceptedProgressUnavailable, BuildCommand, BuildGraphClient,
        BuildOutcome, Failure, PlanFreshness, PlanStaleReason, ProfileSummary,
    },
    read_model::Credential,
};
use rusqlite::Connection;
use std::{
    os::unix::fs::DirBuilderExt,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
fn id(value: u64) -> PositiveId {
    PositiveId::new(value).unwrap()
}
fn credential() -> Credential {
    Credential::Session(Secret::new("read-fixture-secret".into()))
}
fn policy() -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        first_user: auth::FirstUserTenant::NewUser,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
    }
}
struct Fixture {
    root: PathBuf,
    owner: Option<WriterOwner>,
    client: BuildGraphClient,
}
impl Fixture {
    fn new() -> Self {
        Self::from_bytes(include_bytes!("fixtures/accepted-plan-node.db"))
    }
    fn from_bytes(database: &[u8]) -> Self {
        let root = std::env::temp_dir().join(format!(
            "pp-plan-read-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root.join("repos/1/revisions/accepted"))
            .unwrap();
        std::fs::write(root.join("print-partner.db"), database).unwrap();
        let (owner, _) = WriterOwner::open(
            &root,
            Limits {
                queued_writes: 2,
                readers: 1,
            },
        )
        .unwrap();
        let client = owner.build_graph_with_policy(policy()).unwrap();
        Self {
            root,
            owner: Some(owner),
            client,
        }
    }
    fn read(&self) -> ProfileSummary {
        match self.run(BuildCommand::Read { build: id(1) }).unwrap() {
            BuildOutcome::Read { profile } => *profile,
            outcome => panic!("{outcome:?}"),
        }
    }
    fn run(&self, command: BuildCommand) -> anyhow::Result<BuildOutcome> {
        self.client.execute(
            credential(),
            command,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
        )
    }
    fn raw(&self) -> Connection {
        let c = Connection::open(self.root.join("print-partner.db")).unwrap();
        c.busy_timeout(Duration::from_secs(3)).unwrap();
        c
    }
    fn mutate(&self, sql: &str) {
        let c = self.raw();
        c.pragma_update(None, "foreign_keys", false).unwrap();
        let triggers = c
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for t in triggers {
            c.execute_batch(&format!("DROP TRIGGER \"{t}\";")).unwrap();
        }
        c.execute_batch(sql)
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
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
fn accepted_summary_counts_units_and_preserves_freshness() {
    let f = Fixture::new();
    let p = f.read();
    assert_eq!(p.id, 1);
    assert_eq!(p.part_count, 2);
    assert!(matches!(
        p.accepted_progress,
        AcceptedProgress::Ready {
            total_units: 1,
            remaining_units: 1
        }
    ));
    assert!(matches!(p.freshness, PlanFreshness::Current { .. }));
    assert!(!p.build_stale);
    f.mutate("UPDATE build_profiles SET config_modified_at='2099-01-01T00:00:00.000Z' WHERE id=1;");
    let p = f.read();
    assert!(p.build_stale);
    assert!(
        matches!(p.freshness, PlanFreshness::Stale { reasons, .. } if reasons.iter().any(|r| matches!(r, PlanStaleReason::PlanConfigurationChanged)))
    );
}
#[test]
fn tenant_isolation_missing_and_invalid_credentials() {
    let f = Fixture::new();
    f.mutate("INSERT INTO build_profiles(id,tenant_id,name) VALUES(50,'other','Hidden');");
    for build in [50, 999] {
        assert!(matches!(
            f.run(BuildCommand::Read { build: id(build) }).unwrap(),
            BuildOutcome::MissingBuild
        ));
        assert!(matches!(
            f.run(BuildCommand::ListLayers { build: id(build) })
                .unwrap(),
            BuildOutcome::MissingBuild
        ));
    }
    assert!(
        f.client
            .execute(
                Credential::Session(Secret::new("invalid".into())),
                BuildCommand::List,
                Arc::new(AtomicBool::new(false)),
                Duration::ZERO
            )
            .is_err()
    );
}
#[test]
fn list_and_layers_have_stable_order_and_trim_requests() {
    let f = Fixture::new();
    f.mutate("UPDATE build_profiles SET name='Zulu'; INSERT INTO build_profiles(id,tenant_id,name,special_request) SELECT 20,tenant_id,'Alpha','  please  ' FROM build_profiles WHERE id=1; INSERT INTO build_profiles(id,tenant_id,name) SELECT 21,tenant_id,'Beta' FROM build_profiles WHERE id=1;");
    let BuildOutcome::Listed { profiles } = f.run(BuildCommand::List).unwrap() else {
        panic!("list")
    };
    assert_eq!(
        profiles
            .iter()
            .map(|p| (p.id, p.name.as_str()))
            .collect::<Vec<_>>(),
        vec![(20, "Alpha"), (21, "Beta"), (1, "Zulu")]
    );
    assert_eq!(profiles[0].special_request.as_deref(), Some("please"));
    assert!(matches!(
        profiles[0].accepted_progress,
        AcceptedProgress::Empty
    ));
    f.mutate("INSERT INTO profile_layers(id,tenant_id,profile_id,layer_order,layer_type,project_id) VALUES(10,'default',1,2,'addon',NULL),(9,'default',1,1,'addon',NULL),(8,'default',1,1,'addon',NULL);");
    let BuildOutcome::Layers { profile_id, layers } =
        f.run(BuildCommand::ListLayers { build: id(1) }).unwrap()
    else {
        panic!("layers")
    };
    assert_eq!(profile_id, 1);
    assert_eq!(
        layers.iter().map(|l| l.id).collect::<Vec<_>>(),
        vec![1, 8, 9, 10]
    );
    assert_eq!(
        layers
            .iter()
            .map(|l| (l.layer_order, l.project_id))
            .collect::<Vec<_>>(),
        vec![(0, Some(1)), (1, None), (1, None), (2, None)]
    );
}
#[test]
fn unavailable_states_are_honest() {
    for (sql, expected) in [
        (
            "UPDATE build_profiles SET accepted_plan_revision_id=NULL;",
            AcceptedProgressUnavailable::CompatibilityDirty,
        ),
        (
            "DELETE FROM plan_revision_required_unit_sets; DELETE FROM plan_revision_required_units; DELETE FROM required_units;",
            AcceptedProgressUnavailable::Uninitialized,
        ),
        (
            "UPDATE plan_revisions SET snapshot_digest='broken';",
            AcceptedProgressUnavailable::Integrity,
        ),
    ] {
        let f = Fixture::new();
        f.mutate(sql);
        let p = f.read();
        assert!(
            matches!(p.accepted_progress, AcceptedProgress::Unavailable(reason) if std::mem::discriminant(&reason) == std::mem::discriminant(&expected))
        );
    }
}
#[test]
fn cancelled_and_stopped_requests_are_typed_failures() {
    let mut f = Fixture::new();
    let err = f
        .client
        .execute(
            credential(),
            BuildCommand::List,
            Arc::new(AtomicBool::new(true)),
            Duration::ZERO,
        )
        .unwrap_err();
    assert!(matches!(err.downcast_ref(), Some(Failure::Cancelled)));
    f.owner.take().unwrap().shutdown().unwrap();
    let err = f.run(BuildCommand::List).unwrap_err();
    assert!(matches!(err.downcast_ref(), Some(Failure::Stopped)));
}

#[test]
fn ppjs_metadata_is_lossless_and_projection_mismatch_is_integrity() {
    let f = Fixture::new();
    f.mutate("UPDATE parts SET requirement=x'50504a530100000001d800',option_group_id=x'50504a530100000001dc00' WHERE id=2; UPDATE plan_revision_parts SET requirement=x'50504a530100000001d800',option_group_id=x'50504a530100000001dc00' WHERE id=2; UPDATE plan_revisions SET snapshot_digest='dce022016e6d53ef863ddd38b2f132add059758f0f53f109a65352c0bc3e9eab';");
    let profile = f.read();
    assert!(
        matches!(
            profile.accepted_progress,
            AcceptedProgress::Ready {
                total_units: 1,
                remaining_units: 1
            }
        ),
        "{profile:?}"
    );
    let batch = f
        .owner
        .as_ref()
        .unwrap()
        .accepted_reads_with_policy(policy())
        .unwrap()
        .read(
            credential(),
            &[1],
            &AtomicBool::new(false),
            Duration::from_secs(2),
        )
        .unwrap();
    assert!(matches!(&batch.builds[0].accepted,
        pp_storage::read_model::AcceptedRead::IntegrityFailure { code, message }
        if code == "manifest_text" && message.contains("lossless snapshot projection")));
    f.mutate("UPDATE parts SET requirement=x'50504a530100000001d801' WHERE id=2;");
    assert!(matches!(
        f.read().accepted_progress,
        AcceptedProgress::Unavailable(AcceptedProgressUnavailable::Integrity)
    ));
}

#[test]
fn review_malformed_manifest_is_typed_and_list_keeps_healthy_build() {
    for field in ["requirement", "option_group_id"] {
        let f = Fixture::new();
        f.mutate(&format!("UPDATE plan_revision_parts SET {field}=x'50504a5301' WHERE id=2; INSERT INTO build_profiles(id,tenant_id,name) VALUES(20,'default','Healthy');"));
        assert!(matches!(
            f.read().accepted_progress,
            AcceptedProgress::Unavailable(AcceptedProgressUnavailable::Integrity)
        ));
        let BuildOutcome::Listed { profiles } = f.run(BuildCommand::List).unwrap() else {
            panic!("list")
        };
        assert_eq!(profiles.len(), 2);
        assert!(matches!(
            profiles
                .iter()
                .find(|p| p.id == 20)
                .unwrap()
                .accepted_progress,
            AcceptedProgress::Empty
        ));
    }
}

#[test]
fn review_list_caps_builds_before_loading_graphs() {
    let f = Fixture::new();
    f.mutate("WITH RECURSIVE n(id) AS (SELECT 2 UNION ALL SELECT id+1 FROM n WHERE id<64) INSERT INTO build_profiles(id,tenant_id,name) SELECT id,'default','Empty '||id FROM n;");
    let BuildOutcome::Listed { profiles } = f.run(BuildCommand::List).unwrap() else {
        panic!("list")
    };
    assert_eq!(profiles.len(), 64);
    f.mutate("INSERT INTO build_profiles(id,tenant_id,name) VALUES(65,'default','Extra'); DROP TABLE plan_revision_parts;");
    let error = f.run(BuildCommand::List).unwrap_err();
    assert!(matches!(error.downcast_ref(), Some(Failure::TooManyBuilds)));
}

#[test]
fn review_working_counts_non_scalar_metadata_edits() {
    for field in ["requirement", "option_group_id"] {
        let f = Fixture::new();
        let c = f.raw();
        let columns = c
            .prepare("SELECT * FROM plan_revision_parts")
            .unwrap()
            .column_names()
            .iter()
            .filter(|s| !matches!(**s, "id" | "revision_id" | "projection_part_id"))
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .join(",");
        drop(c);
        f.mutate(&format!("DELETE FROM plan_draft_parts; DELETE FROM plan_drafts; INSERT INTO plan_drafts(id,tenant_id,profile_id,base_revision_id,base_plan_version,state,digest_format,snapshot_digest,created_by,idempotency_key,created_at) SELECT 1,tenant_id,profile_id,id,1,'open','v1','digest','fixture','key','then' FROM plan_revisions LIMIT 1; INSERT INTO plan_draft_parts(draft_id,base_revision_part_id,{columns}) SELECT 1,id,{columns} FROM plan_revision_parts; UPDATE plan_revision_parts SET {field}=x'50504a530100000001d800' WHERE id=2; UPDATE plan_draft_parts SET {field}=x'50504a530100000001d801' WHERE base_revision_part_id=2;"));
        let batch = f
            .owner
            .as_ref()
            .unwrap()
            .accepted_reads_with_policy(policy())
            .unwrap()
            .read(
                credential(),
                &[1],
                &AtomicBool::new(false),
                Duration::from_secs(2),
            )
            .unwrap();
        let context = serde_json::to_value(batch.builds[0].context.as_ref().unwrap()).unwrap();
        assert_eq!(
            context["workflow"]["workspace"]["working_plan"]["change_count"],
            serde_json::json!(1),
            "{context}"
        );
    }
}

#[test]
fn review_missing_accepted_input_retains_healthy_build() {
    let f = Fixture::new();
    f.mutate("UPDATE plan_accepted_input_sets SET input_set_id=999999; INSERT INTO build_profiles(id,tenant_id,name) VALUES(20,'default','Healthy');");
    let profile = f.read();
    assert!(matches!(
        profile.accepted_progress,
        AcceptedProgress::Unavailable(AcceptedProgressUnavailable::Integrity)
    ));
    assert!(
        matches!(profile.freshness, PlanFreshness::Unavailable { code } if code == "accepted_inputs")
    );
    let BuildOutcome::Listed { profiles } = f.run(BuildCommand::List).unwrap() else {
        panic!("list")
    };
    assert_eq!(profiles.len(), 2);
    assert!(
        profiles.iter().any(|profile| profile.id == 20
            && matches!(profile.accepted_progress, AcceptedProgress::Empty))
    );
}

#[test]
fn review_layers_allow_1024_and_reject_1025() {
    let f = Fixture::new();
    f.mutate("DELETE FROM profile_layers; WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<1024) INSERT INTO profile_layers(id,tenant_id,profile_id,layer_order,layer_type) SELECT n,'default',1,n,'addon' FROM ids;");
    let BuildOutcome::Layers { layers, .. } =
        f.run(BuildCommand::ListLayers { build: id(1) }).unwrap()
    else {
        panic!("layers")
    };
    assert_eq!(layers.len(), 1024);
    f.mutate("INSERT INTO profile_layers(id,tenant_id,profile_id,layer_order,layer_type) VALUES(1025,'default',1,1025,'addon');");
    let error = f
        .run(BuildCommand::ListLayers { build: id(1) })
        .unwrap_err();
    assert!(matches!(error.downcast_ref(), Some(Failure::TooManyLayers)));
}
