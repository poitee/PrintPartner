use pp_gateway::ownership::{
    AdmissionError,
    manifest::{OwnershipIndex, admit_bundled_manifest, admit_manifest_documents},
    resources::{
        FileFamily,
        ResourceId::{File, Table},
        ResourceSet,
        TableId::*,
    },
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn manifest() -> Value {
    serde_json::from_str(include_str!("../ownership-manifest.json")).unwrap()
}
fn admit(value: &Value) -> Result<OwnershipIndex, AdmissionError> {
    admit_manifest_documents(
        &value.to_string(),
        include_str!("../operations.json"),
        include_str!("../../../../web/apps/server/src/data/source-sync-ownership.json"),
    )
}
fn malformed(detail: &str) -> AdmissionError {
    AdmissionError::Malformed(detail.into())
}

#[test]
fn reviewed_sets_aliases_and_complete_unresolved_partition() {
    let index = admit_bundled_manifest().unwrap();
    let lists = BTreeSet::from([Table(Projects), Table(SourceDocs), Table(AppSettings)]);
    assert_eq!(index.resources_for("tool.list_sources"), Ok(&lists));
    assert_eq!(
        index.resources_for("tool.list_source_categories"),
        Ok(&lists)
    );
    assert_eq!(
        index.resources_for("tool.read_source_file"),
        Ok(&BTreeSet::from([
            Table(Projects),
            Table(SourceDocs),
            File(FileFamily::SourceWorkspace),
        ]))
    );
    let sync: ResourceSet = BTreeSet::from([
        Table(Projects),
        Table(SourceRevisions),
        Table(SourceDocs),
        Table(AppSettings),
        Table(AppEvents),
        Table(BuildProfiles),
        File(FileFamily::SourceWorkspace),
        File(FileFamily::SourceCovers),
    ]);
    for id in [
        "http.POST /jobs/sync",
        "http.POST /api/v1/jobs/sync",
        "http.GET /sources/:id/docs",
        "http.HEAD /sources/:id/docs",
        "job.sync",
    ] {
        assert_eq!(index.resources_for(id), Ok(&sync));
        assert!(std::ptr::eq(
            index.resources_for(id).unwrap(),
            index.resources_for("job.sync").unwrap()
        ));
    }
    for id in [
        "http.GET /plans",
        "http.HEAD /plans",
        "http.GET /api/v2/plans",
        "http.HEAD /api/v2/plans",
    ] {
        assert_eq!(
            index.resources_for(id),
            Err(AdmissionError::UnresolvedResources {
                operation: "http:GET /plans current".into()
            })
        );
    }
    let manifest = manifest();
    let unresolved: BTreeSet<_> = manifest["resources"]["unresolved"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let reviewed = BTreeSet::from([
        "source.sync",
        "tool.read_source_file",
        "tool.list_sources",
        "tool.list_source_categories",
    ]);
    let resolved: BTreeSet<_> = index
        .claims()
        .values()
        .map(|c| c.operation.as_str())
        .collect();
    assert_eq!(resolved, unresolved.union(&reviewed).copied().collect());
    for (id, claim) in index.claims() {
        if unresolved.contains(claim.operation.as_str()) {
            assert_eq!(
                index.resources_for(id),
                Err(AdmissionError::UnresolvedResources {
                    operation: claim.operation.clone()
                })
            );
        }
    }
    assert_eq!(
        index.resources_for("tool.missing"),
        Err(AdmissionError::UnknownParticipant {
            id: "tool.missing".into()
        })
    );
}

#[test]
fn each_reviewed_resource_is_required_exactly_once() {
    for entry in 1..=3 {
        let original = manifest();
        let id = original["resources"]["reviewed"][entry]["operation"]
            .as_str()
            .unwrap();
        let expected = || AdmissionError::ResourceSetMismatch { id: id.into() };
        for resource in 0..3 {
            let mut value = original.clone();
            value["resources"]["reviewed"][entry]["resources"]
                .as_array_mut()
                .unwrap()
                .remove(resource);
            assert_eq!(admit(&value).unwrap_err(), expected());
            let mut value = original.clone();
            let duplicate = value["resources"]["reviewed"][entry]["resources"][resource].clone();
            value["resources"]["reviewed"][entry]["resources"]
                .as_array_mut()
                .unwrap()
                .push(duplicate);
            assert_eq!(admit(&value).unwrap_err(), expected());
        }
        for resources in [
            json!([]),
            json!([{"kind":"table","name":"projects"},{"kind":"table","name":"source_docs"},{"kind":"table","name":"build_profiles"}]),
        ] {
            let mut value = original.clone();
            value["resources"]["reviewed"][entry]["resources"] = resources;
            assert_eq!(admit(&value).unwrap_err(), expected());
        }
        let mut value = original.clone();
        value["resources"]["reviewed"][entry]["resources"]
            .as_array_mut()
            .unwrap()
            .push(json!({"kind":"table","name":"build_profiles"}));
        assert_eq!(admit(&value).unwrap_err(), expected());
    }
}

#[test]
fn reviewed_states_cannot_disappear_downgrade_or_repeat() {
    for entry in 0..=3 {
        let mut value = manifest();
        let removed = value["resources"]["reviewed"]
            .as_array_mut()
            .unwrap()
            .remove(entry);
        let id = removed["operation"].as_str().unwrap();
        assert_eq!(
            admit(&value).unwrap_err(),
            malformed(&format!("missing reviewed resources for {id}"))
        );
        value["resources"]["unresolved"]
            .as_array_mut()
            .unwrap()
            .push(json!(id));
        assert_eq!(
            admit(&value).unwrap_err(),
            malformed(&format!("missing reviewed resources for {id}"))
        );
        let mut value = manifest();
        value["resources"]["reviewed"]
            .as_array_mut()
            .unwrap()
            .push(removed.clone());
        assert_eq!(
            admit(&value).unwrap_err(),
            malformed(&format!("duplicate resource state for {id}"))
        );
        let mut value = manifest();
        value["resources"]["unresolved"]
            .as_array_mut()
            .unwrap()
            .push(json!(id));
        assert_eq!(
            admit(&value).unwrap_err(),
            malformed(&format!("duplicate resource state for {id}"))
        );
    }
}

#[test]
fn every_unresolved_state_is_required_and_unique() {
    let original = manifest();
    for entry in 0..original["resources"]["unresolved"]
        .as_array()
        .unwrap()
        .len()
    {
        let mut value = original.clone();
        let removed = value["resources"]["unresolved"]
            .as_array_mut()
            .unwrap()
            .remove(entry);
        let id = removed.as_str().unwrap();
        assert_eq!(
            admit(&value).unwrap_err(),
            malformed(&format!("missing resource state for {id}"))
        );
    }
    let mut value = original.clone();
    value["resources"]["unresolved"]
        .as_array_mut()
        .unwrap()
        .push(json!("stale"));
    assert_eq!(
        admit(&value).unwrap_err(),
        AdmissionError::UnknownOperation {
            value: "stale".into()
        }
    );
    let mut value = original;
    let duplicate = value["resources"]["unresolved"][0].clone();
    value["resources"]["unresolved"]
        .as_array_mut()
        .unwrap()
        .push(duplicate.clone());
    assert_eq!(
        admit(&value).unwrap_err(),
        malformed(&format!(
            "duplicate resource state for {}",
            duplicate.as_str().unwrap()
        ))
    );
}

#[test]
fn unknown_resource_syntax_and_competing_import_fail_closed() {
    for (resource, detail) in [
        (
            json!({"kind":"table","name":"future_table"}),
            "unknown variant `future_table`",
        ),
        (
            json!({"kind":"file","name":"future-root"}),
            "unknown variant `future-root`",
        ),
        (
            json!({"kind":"socket","name":"projects"}),
            "unknown variant `socket`",
        ),
        (
            json!({"kind":"table","name":"projects","owner":"node"}),
            r#"invalid value: string "owner", expected "kind" or "name""#,
        ),
    ] {
        let mut value = manifest();
        value["resources"]["reviewed"][1]["resources"][0] = resource;
        let AdmissionError::Malformed(error) = admit(&value).unwrap_err() else {
            panic!("expected malformed resource");
        };
        assert!(error.contains(detail), "{error}");
    }
    for (pointer, replacement, detail) in [
        (
            "/resources/reviewed/0/import",
            json!("other"),
            "unknown variant `other`",
        ),
        (
            "/resources/reviewed/0/resources",
            json!([]),
            "unknown field `resources`",
        ),
        (
            "/resources/reviewed/1/extra",
            json!(true),
            "unknown field `extra`",
        ),
        (
            "/resources/reviewed/1/operation",
            json!("tool.get_source_docs"),
            "unknown variant `tool.get_source_docs`",
        ),
        ("/resources/extra", json!(true), "unknown field `extra`"),
    ] {
        let mut value = manifest();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        value.pointer_mut(parent).unwrap()[key] = replacement;
        let AdmissionError::Malformed(error) = admit(&value).unwrap_err() else {
            panic!("expected malformed resource state");
        };
        assert!(error.contains(detail), "{pointer}: {error}");
    }
}

#[test]
fn mixed_dispositions_for_one_operation_are_rejected() {
    let mut value = manifest();
    value["node_participants"]["tool"]
        .as_array_mut()
        .unwrap()
        .retain(|id| id != "get_source_docs");
    value["operations"].as_array_mut().unwrap().push(json!({
        "operation":"gateway.owned", "owner":"node", "participants":["tool.get_source_docs"]
    }));
    assert_eq!(
        admit(&value).unwrap_err(),
        malformed("mixed dispositions for gateway.owned")
    );
}

fn regroup(value: &mut Value, operation: &str, participants: &[&str]) {
    value["node_participants"]["tool"]
        .as_array_mut()
        .unwrap()
        .retain(|name| {
            !participants.contains(&format!("tool.{}", name.as_str().unwrap()).as_str())
        });
    value["operations"].as_array_mut().unwrap().push(json!({
        "operation": operation, "owner": "node", "participants": participants
    }));
}

#[test]
fn reviewed_participants_cannot_move_to_unresolved_operations() {
    for id in [
        "tool.read_source_file",
        "tool.list_sources",
        "tool.list_source_categories",
    ] {
        for participants in [vec![id], vec![]] {
            let mut value = manifest();
            regroup(&mut value, "tool.regrouped", &participants);
            value["node_participants"]["tool"]
                .as_array_mut()
                .unwrap()
                .retain(|name| format!("tool.{}", name.as_str().unwrap()) != id);
            regroup(&mut value, id, &["tool.get_source_docs"]);
            let unresolved = value["resources"]["unresolved"].as_array_mut().unwrap();
            unresolved.retain(|operation| operation != "tool.get_source_docs");
            if !participants.is_empty() {
                unresolved.push(json!("tool.regrouped"));
            }
            assert_eq!(
                admit(&value).err(),
                Some(malformed(&format!(
                    "reviewed participant {id} must belong to operation {id}"
                ))),
                "{id}, participants={participants:?}"
            );
        }
    }
}

#[test]
fn reviewed_participants_cannot_swap_operations() {
    for (first, second) in [
        ("tool.read_source_file", "tool.list_sources"),
        ("tool.read_source_file", "tool.list_source_categories"),
        ("tool.list_sources", "tool.list_source_categories"),
    ] {
        let mut value = manifest();
        regroup(&mut value, first, &[second]);
        regroup(&mut value, second, &[first]);
        assert_eq!(
            admit(&value).err(),
            Some(malformed(&format!(
                "reviewed participant {first} must belong to operation {first}"
            ))),
            "{first}, {second}"
        );
    }
}

#[test]
fn unresolved_participants_can_share_a_regrouped_operation() {
    let mut value = manifest();
    regroup(
        &mut value,
        "tool.source_queries",
        &["tool.get_source_docs", "tool.get_source_inventory"],
    );
    let unresolved = value["resources"]["unresolved"].as_array_mut().unwrap();
    unresolved.retain(|id| id != "tool.get_source_docs" && id != "tool.get_source_inventory");
    unresolved.push(json!("tool.source_queries"));
    let index = admit(&value).unwrap();
    for id in ["tool.get_source_docs", "tool.get_source_inventory"] {
        assert_eq!(index.lookup(id).unwrap().operation, "tool.source_queries");
        assert_eq!(
            index.resources_for(id),
            Err(AdmissionError::UnresolvedResources {
                operation: "tool.source_queries".into()
            })
        );
    }
}
