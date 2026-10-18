#![cfg(test)]

use super::*;
use observation::*;

struct NoReads;
impl DraftReads for NoReads {
    fn resolve_stl_root(
        &self,
        _: &OwnedStlReadRequest,
        _: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlRootRead>> {
        panic!("empty capture must not read a Source")
    }
    fn read_checkout_manifest(
        &self,
        _: &OwnedCheckoutReadRequest,
        _: CheckoutManifestUse,
        _: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        panic!("empty capture must not read a manifest")
    }
    fn read_catalog_document(
        &self,
        _: &OwnedCatalogReadRequest,
        _: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        panic!("empty capture must not read a catalog")
    }
}

fn ambiguous_merge(limit: usize, artifact: bool) -> Result<Vec<Conflict>> {
    let mut db = Connection::open_in_memory()?;
    db.execute_batch(
        "CREATE TABLE profile_layers(tenant_id,profile_id,layer_order);
         CREATE TABLE app_settings(tenant_id,key,value);",
    )?;
    let cancelled = AtomicBool::new(false);
    let tx = db.transaction()?;
    let mut capture = preparation::capture(
        &tx,
        "default",
        1,
        &NoReads,
        &mut PreparationBudget::new(&cancelled, PreparationLimits::default())?,
    )?;
    capture.inputs = vec![json!({"sourceId":1,"sourceLayer":"source","trackingKind":"revision"})];
    let part = |id, key| {
        DraftPart::new(
            json!({"id":id,"partKey":key,"sourceLayer":"source","artifactDigest":"same","included":false}),
            Default::default(),
        )
    };
    let source = Draft {
        header: json!({}),
        inputs: capture.inputs.clone(),
        parts: vec![part(7, "old")],
        planning: String::new(),
        selected: None,
    };
    let key = if artifact { "renamed" } else { "old" };
    let mut fresh = preparation::PreparedDraftSnapshot {
        base: json!({}),
        capture,
        parts: vec![part(1, key), part(2, key)],
        digest: "unchanged".into(),
    };
    let mut budget = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            comparison_work: limit,
            ..Default::default()
        },
    )?;
    let result = merge(&source, &[], &[], &mut fresh, &mut budget);
    assert_eq!(fresh.digest, "unchanged");
    result
}

#[test]
fn ambiguity_candidates_spend_the_comparison_budget() {
    for artifact in [false, true] {
        assert_eq!(
            ambiguous_merge(2, artifact).unwrap(),
            vec![Conflict::TargetAmbiguous {
                source_part_id: 7,
                target_part_ids: vec![1, 2]
            }],
        );
        let error = ambiguous_merge(1, artifact).unwrap_err();
        assert!(
            matches!(
                error.downcast_ref::<ReadFailure>(),
                Some(ReadFailure::LimitExceeded(Resource::ComparisonWork))
            ),
            "{error:?}"
        );
    }
}

fn accepted_database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE plan_revisions(id,tenant_id,profile_id);
         CREATE TABLE plan_revision_parts(id,tenant_id,revision_id,projection_part_id,included,quantity_override);
         INSERT INTO plan_revisions VALUES(1,'default',2);
         INSERT INTO plan_revision_parts VALUES(10,'default',1,100,1,NULL),(11,'default',1,101,0,3);
         INSERT INTO plan_revision_parts VALUES(12,'other',1,102,'invalid',NULL);",
    ).unwrap();
    db
}

#[test]
fn accepted_parts_charge_each_row_and_preserve_values_and_scope() {
    let mut db = accepted_database();
    let tx = db.transaction().unwrap();
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            visits: 2,
            ..Default::default()
        },
    )
    .unwrap();
    let parts = accepted_parts(&tx, "default", 2, &json!(1), &mut budget).unwrap();
    let values: Vec<_> = parts
        .iter()
        .map(|p| {
            (
                p.id,
                p.projection,
                p.included.clone(),
                p.quantity_override.clone(),
            )
        })
        .collect();
    assert_eq!(
        values,
        vec![
            (10, Some(100), json!(true), Value::Null),
            (11, Some(101), json!(false), json!(3))
        ]
    );
    let mut budget = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            visits: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let error = accepted_parts(&tx, "default", 2, &json!(1), &mut budget)
        .err()
        .unwrap();
    assert!(
        matches!(
            error.downcast_ref::<ReadFailure>(),
            Some(ReadFailure::LimitExceeded(Resource::Visits))
        ),
        "{error:?}"
    );
}

#[test]
fn accepted_parts_stop_before_decoding_an_over_budget_row() {
    let mut db = accepted_database();
    db.execute(
        "UPDATE plan_revision_parts SET included='invalid' WHERE id=11",
        [],
    )
    .unwrap();
    let tx = db.transaction().unwrap();
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            visits: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let error = accepted_parts(&tx, "default", 2, &json!(1), &mut budget)
        .err()
        .unwrap();
    assert!(
        matches!(
            error.downcast_ref::<ReadFailure>(),
            Some(ReadFailure::LimitExceeded(Resource::Visits))
        ),
        "{error:?}"
    );
    let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    let error = accepted_parts(&tx, "default", 2, &json!(1), &mut budget)
        .err()
        .unwrap();
    assert!(
        matches!(
            error.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::InvalidColumnType(..))
        ),
        "{error:?}"
    );
}

#[test]
fn accepted_parts_check_cancellation_between_rows() {
    let mut db = accepted_database();
    db.execute(
        "UPDATE plan_revision_parts SET included='invalid' WHERE id=11",
        [],
    )
    .unwrap();
    let tx = db.transaction().unwrap();
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    budget.cancel_after_checks(1);
    let error = accepted_parts(&tx, "default", 2, &json!(1), &mut budget)
        .err()
        .unwrap();
    assert!(
        matches!(
            error.downcast_ref::<ReadFailure>(),
            Some(ReadFailure::Cancelled)
        ),
        "{error:?}"
    );
}
