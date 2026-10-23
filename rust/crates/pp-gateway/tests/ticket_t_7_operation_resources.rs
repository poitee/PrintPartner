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
fn ticket_t_7_ownership_plan_decisions_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.get_plan_decisions",
        json!([
            {"kind": "table", "name": "build_profiles"},
            {"kind": "table", "name": "plan_decisions"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_create_source_category_proposal_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.propose_create_source_category",
        json!([
            {"kind": "table", "name": "app_settings"},
            {"kind": "table", "name": "build_profiles"},
            {"kind": "table", "name": "plan_decisions"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_create_source_category_proposal_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_create_source_category");
}

#[test]
fn ticket_t_7_ownership_rename_source_category_proposal_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.propose_rename_source_category",
        json!([
            {"kind": "table", "name": "app_settings"},
            {"kind": "table", "name": "build_profiles"},
            {"kind": "table", "name": "plan_decisions"},
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "file", "name": "source-workspace"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_rename_source_category_proposal_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_rename_source_category");
}

#[test]
fn ticket_t_7_ownership_delete_source_category_proposal_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.propose_delete_source_category",
        json!([
            {"kind": "table", "name": "app_settings"},
            {"kind": "table", "name": "build_profiles"},
            {"kind": "table", "name": "plan_decisions"},
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "file", "name": "source-workspace"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_delete_source_category_proposal_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_delete_source_category");
}

#[test]
fn ticket_t_7_ownership_set_source_category_proposal_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.propose_set_source_category",
        json!([
            {"kind": "table", "name": "app_settings"},
            {"kind": "table", "name": "build_profiles"},
            {"kind": "table", "name": "plan_decisions"},
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "file", "name": "source-workspace"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_set_source_category_proposal_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_set_source_category");
}

#[test]
fn ticket_t_7_ownership_propose_update_source_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.propose_update_source",
        json!([
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "file", "name": "source-workspace"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_propose_update_source_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_update_source");
}

#[test]
fn ticket_t_7_ownership_propose_update_source_naming_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.propose_update_source_naming",
        json!([
            {"kind": "table", "name": "app_settings"},
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "file", "name": "source-workspace"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_propose_update_source_naming_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_update_source_naming");
}

#[test]
fn ticket_t_7_ownership_propose_import_source_files_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.propose_import_source_files",
        json!([
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "file", "name": "source-workspace"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_propose_import_source_files_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_import_source_files");
}

#[test]
fn ticket_t_7_ownership_propose_set_plan_progress_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.propose_set_plan_progress",
        json!([
            {"kind": "table", "name": "build_profiles"},
            {"kind": "table", "name": "parts"},
            {"kind": "table", "name": "plan_accepted_input_sets"},
            {"kind": "table", "name": "plan_revision_input_sets"},
            {"kind": "table", "name": "plan_revision_inputs"},
            {"kind": "table", "name": "plan_revision_parts"},
            {"kind": "table", "name": "plan_revision_required_unit_sets"},
            {"kind": "table", "name": "plan_revision_required_units"},
            {"kind": "table", "name": "plan_revisions"},
            {"kind": "table", "name": "print_progress"},
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "required_units"},
            {"kind": "table", "name": "source_revisions"},
            {"kind": "file", "name": "source-workspace"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_propose_set_plan_progress_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_set_plan_progress");
}

#[test]
fn ticket_t_7_ownership_propose_set_plan_assembly_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.propose_set_plan_assembly",
        json!([
            {"kind": "table", "name": "build_profiles"},
            {"kind": "table", "name": "parts"},
            {"kind": "table", "name": "plan_accepted_input_sets"},
            {"kind": "table", "name": "plan_revision_input_sets"},
            {"kind": "table", "name": "plan_revision_inputs"},
            {"kind": "table", "name": "plan_revision_parts"},
            {"kind": "table", "name": "plan_revision_required_unit_sets"},
            {"kind": "table", "name": "plan_revision_required_units"},
            {"kind": "table", "name": "plan_revisions"},
            {"kind": "table", "name": "print_progress"},
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "required_units"},
            {"kind": "table", "name": "source_revisions"},
            {"kind": "file", "name": "source-workspace"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_propose_set_plan_assembly_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_set_plan_assembly");
}

#[test]
fn ticket_t_7_ownership_propose_verify_printer_checkoff_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.propose_verify_printer_checkoff",
        json!([
            {"kind": "table", "name": "app_settings"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_propose_verify_printer_checkoff_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_verify_printer_checkoff");
}

fn accepted_plan_operational_resources() -> Value {
    json!([
        {"kind": "table", "name": "build_profiles"},
        {"kind": "table", "name": "parts"},
        {"kind": "table", "name": "plan_accepted_input_sets"},
        {"kind": "table", "name": "plan_revision_input_sets"},
        {"kind": "table", "name": "plan_revision_inputs"},
        {"kind": "table", "name": "plan_revision_parts"},
        {"kind": "table", "name": "plan_revision_required_unit_sets"},
        {"kind": "table", "name": "plan_revision_required_units"},
        {"kind": "table", "name": "plan_revisions"},
        {"kind": "table", "name": "print_progress"},
        {"kind": "table", "name": "projects"},
        {"kind": "table", "name": "required_units"},
        {"kind": "table", "name": "source_revisions"},
        {"kind": "file", "name": "source-workspace"}
    ])
}

#[test]
fn ticket_t_7_ownership_checkoff_reads_have_complete_node_owned_resources() {
    let snapshot = accepted_plan_operational_resources();
    for id in ["tool.get_plan_checkoff", "tool.get_remaining"] {
        assert_sqlite_tool_resources(id, snapshot.clone());
    }
    let mut import = snapshot;
    import
        .as_array_mut()
        .unwrap()
        .push(json!({"kind": "table", "name": "source_docs"}));
    assert_sqlite_tool_resources("tool.propose_import_3mf_checkoff", import);
    assert_sqlite_tool_resources(
        "tool.get_printer_checkoff",
        json!([{"kind": "table", "name": "app_settings"}]),
    );
}

#[test]
fn ticket_t_7_ownership_checkoff_reads_refuse_invalid_admission_before_effects() {
    for id in [
        "tool.get_plan_checkoff",
        "tool.get_remaining",
        "tool.get_printer_checkoff",
        "tool.propose_import_3mf_checkoff",
    ] {
        assert_tool_invalid_admission(id);
    }
}

fn planning_brief_resources() -> Value {
    json!([
        {"kind": "table", "name": "app_settings"},
        {"kind": "table", "name": "projects"},
        {"kind": "table", "name": "source_docs"},
        {"kind": "file", "name": "source-workspace"}
    ])
}

#[test]
fn ticket_t_7_ownership_build_planning_reads_have_complete_node_owned_resources() {
    let brief = planning_brief_resources();
    assert_sqlite_tool_resources("tool.list_build_differences", brief.clone());
    let mut with_draft = brief;
    with_draft.as_array_mut().unwrap().extend([
        json!({"kind": "table", "name": "build_profiles"}),
        json!({"kind": "table", "name": "plan_drafts"}),
        json!({"kind": "table", "name": "plan_draft_inputs"}),
        json!({"kind": "table", "name": "plan_draft_parts"}),
        json!({"kind": "table", "name": "plan_draft_required_unit_reconciliations"}),
        json!({"kind": "table", "name": "plan_draft_required_unit_decisions"}),
        json!({"kind": "table", "name": "plan_draft_required_unit_assignments"}),
    ]);
    for id in ["tool.get_build_planning_state", "tool.get_plan_draft"] {
        assert_sqlite_tool_resources(id, with_draft.clone());
    }
}

#[test]
fn ticket_t_7_ownership_build_planning_reads_refuse_invalid_admission_before_effects() {
    for id in [
        "tool.get_build_planning_state",
        "tool.list_build_differences",
        "tool.get_plan_draft",
    ] {
        assert_tool_invalid_admission(id);
    }
}

#[test]
fn ticket_t_7_ownership_build_planning_proposals_have_complete_node_owned_resources() {
    let settings = json!([{"kind": "table", "name": "app_settings"}]);
    for id in [
        "tool.propose_update_build_brief",
        "tool.propose_resolve_build_differences",
        "tool.propose_set_build_source_roles",
        "tool.propose_rebuild_plan",
        "tool.propose_apply_plan_draft",
    ] {
        assert_sqlite_tool_resources(id, settings.clone());
    }
}

#[test]
fn ticket_t_7_ownership_build_planning_proposals_refuse_invalid_admission_before_effects() {
    for id in [
        "tool.propose_update_build_brief",
        "tool.propose_resolve_build_differences",
        "tool.propose_set_build_source_roles",
        "tool.propose_rebuild_plan",
        "tool.propose_apply_plan_draft",
    ] {
        assert_tool_invalid_admission(id);
    }
}

#[test]
fn ticket_t_7_ownership_list_sources_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.list_sources",
        json!([
            {"kind": "table", "name": "app_settings"},
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "file", "name": "source-workspace"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_list_sources_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.list_sources");
}

#[test]
fn ticket_t_7_ownership_list_source_categories_has_complete_node_owned_resources() {
    assert_sqlite_tool_resources(
        "tool.list_source_categories",
        json!([
            {"kind": "table", "name": "app_settings"},
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "file", "name": "source-workspace"}
        ]),
    );
}

#[test]
fn ticket_t_7_ownership_list_source_categories_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.list_source_categories");
}

fn assert_sqlite_tool_resources(id: &str, expected: Value) {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let index = admit_bundled_manifest().unwrap();
    let resources = index
        .resources_for(id)
        .expect("SQLite tool resources must be reviewed");
    let expected: ResourceSet = serde_json::from_value(expected).unwrap();
    assert_eq!(resources, &expected);
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(
        index.admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: Some(35),
        })
    );
    let mut compatible = manifest();
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Ok(&expected)
    );
    if expected.contains(&File(FileFamily::SourceWorkspace)) {
        for rust_writes in [None, Some(2)] {
            compatible["live_formats"]["source-revision-workspace"]["rust_writes"] =
                json!(rust_writes);
            let mut effect = false;
            let result = admit(&compatible).and_then(|index| {
                index.admit_rollback(id)?;
                effect = true;
                Ok(())
            });
            assert_eq!(
                result,
                Err(AdmissionError::IncompatibleLiveFormat {
                    operation: id.into(),
                    format: "source-revision-workspace".into(),
                    node_reads: 1,
                    rust_writes,
                })
            );
            assert!(!effect);
        }
        compatible["live_formats"]["source-revision-workspace"]["rust_writes"] = json!(1);
    }
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = Value::Null;
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: None,
        })
    );
    for owner in ["rust", "python"] {
        let mut value = manifest();
        regroup(&mut value, id, &[id]);
        value["operations"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["owner"] = json!(owner);
        let expected = if owner == "rust" {
            AdmissionError::UnsupportedRustOwner {
                participant: id.into(),
            }
        } else {
            AdmissionError::UnknownOwner {
                value: owner.into(),
            }
        };
        assert_eq!(admit(&value).unwrap_err(), expected);
    }
}

#[test]
fn ticket_t_7_ownership_list_plans_has_complete_node_owned_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.list_plans";
    let index = admit_bundled_manifest().unwrap();
    let resources = index
        .resources_for(id)
        .expect("plan list resources must be reviewed");
    let expected: ResourceSet = serde_json::from_value(json!([
        {"kind": "table", "name": "build_profiles"},
        {"kind": "table", "name": "parts"},
        {"kind": "table", "name": "profile_layers"},
        {"kind": "table", "name": "projects"},
        {"kind": "table", "name": "source_revisions"},
        {"kind": "table", "name": "app_settings"},
        {"kind": "table", "name": "plan_accepted_input_sets"},
        {"kind": "table", "name": "plan_revision_input_sets"},
        {"kind": "table", "name": "plan_revision_inputs"},
        {"kind": "file", "name": "source-workspace"}
    ]))
    .unwrap();
    assert_eq!(resources, &expected);
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(
        index.admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: Some(35),
        })
    );
    let mut compatible = manifest();
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Ok(&expected)
    );
    for rust_writes in [None, Some(2)] {
        compatible["live_formats"]["source-revision-workspace"]["rust_writes"] = json!(rust_writes);
        assert_eq!(
            admit(&compatible).unwrap().admit_rollback(id),
            Err(AdmissionError::IncompatibleLiveFormat {
                operation: id.into(),
                format: "source-revision-workspace".into(),
                node_reads: 1,
                rust_writes,
            })
        );
    }
    compatible["live_formats"]["source-revision-workspace"]["rust_writes"] = json!(1);
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = Value::Null;
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: None,
        })
    );
}

#[test]
fn reviewed_sets_aliases_and_complete_unresolved_partition() {
    let index = admit_bundled_manifest().unwrap();
    assert_eq!(
        index.resources_for("tool.get_workflow_help"),
        Ok(&BTreeSet::new())
    );
    let lists = BTreeSet::from([
        Table(Projects),
        Table(SourceDocs),
        Table(AppSettings),
        File(FileFamily::SourceWorkspace),
    ]);
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
    assert_eq!(
        index.resources_for("tool.search_source_files"),
        Ok(&BTreeSet::from([
            Table(Projects),
            Table(SourceDocs),
            File(FileFamily::SourceWorkspace),
        ]))
    );
    assert_eq!(
        index.resources_for("tool.preview_source_naming"),
        Ok(&BTreeSet::from([Table(Projects), Table(AppSettings)]))
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
    for (id, operation) in [
        (
            "http.GET /settings/features",
            "http:GET /settings/features current",
        ),
        (
            "http.HEAD /settings/features",
            "http:GET /settings/features current",
        ),
        (
            "http.GET /api/v1/settings/features",
            "http:GET /settings/features current",
        ),
        (
            "http.HEAD /api/v1/settings/features",
            "http:GET /settings/features current",
        ),
        (
            "http.PATCH /settings/features",
            "http:PATCH /settings/features current",
        ),
        (
            "http.PATCH /api/v1/settings/features",
            "http:PATCH /settings/features current",
        ),
    ] {
        assert_eq!(
            index.resources_for(id),
            Err(AdmissionError::UnresolvedResources {
                operation: operation.into()
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
        "tool.get_workflow_help",
        "tool.web_search",
        "tool.fetch_web_page",
        "tool.get_job_status",
        "tool.check_hardware_interfaces",
        "tool.propose_add_custom_filament",
        "tool.propose_create_build",
        "tool.propose_create_source_category",
        "tool.propose_rename_source_category",
        "tool.propose_delete_source_category",
        "tool.propose_set_source_category",
        "tool.propose_update_source",
        "tool.propose_update_source_naming",
        "tool.propose_import_source_files",
        "tool.propose_set_plan_progress",
        "tool.propose_set_plan_assembly",
        "tool.propose_verify_printer_checkoff",
        "tool.get_plan_checkoff",
        "tool.get_remaining",
        "tool.get_printer_checkoff",
        "tool.propose_import_3mf_checkoff",
        "tool.get_build_planning_state",
        "tool.list_build_differences",
        "tool.get_plan_draft",
        "tool.propose_update_build_brief",
        "tool.propose_resolve_build_differences",
        "tool.propose_set_build_source_roles",
        "tool.propose_rebuild_plan",
        "tool.propose_apply_plan_draft",
        "tool.get_plan_decisions",
        "tool.list_plans",
        "tool.list_plan_snapshots",
        "tool.get_plan_snapshot",
        "tool.get_kit_catalog",
        "tool.analyze_build_request",
        "tool.get_build_recipe",
        "tool.get_build_workflow",
        "tool.get_plan_option_groups",
        "tool.ui_highlight_part",
        "tool.ui_focus_stl_search",
        "tool.ui_navigate",
        "tool.ui_open_source",
        "tool.ui_open_docs",
        "tool.ui_focus_kit_option",
        "tool.read_source_file",
        "tool.list_sources",
        "tool.list_source_categories",
        "tool.search_source_files",
        "tool.preview_source_naming",
        "tool.get_source_docs",
        "tool.get_source_inventory",
        "tool.compare_source_revisions",
        "tool.audit_source_provenance",
        "tool.analyze_stl_mesh",
    ]);
    assert_eq!(reviewed.len(), 55);
    assert_eq!(unresolved.len(), 388);
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
    for entry in 1..manifest()["resources"]["reviewed"]
        .as_array()
        .unwrap()
        .len()
    {
        let original = manifest();
        let id = original["resources"]["reviewed"][entry]["operation"]
            .as_str()
            .unwrap();
        let expected = || AdmissionError::ResourceSetMismatch { id: id.into() };
        for resource in 0..original["resources"]["reviewed"][entry]["resources"]
            .as_array()
            .unwrap()
            .len()
        {
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
            if value["resources"]["reviewed"][entry]["resources"]
                == original["resources"]["reviewed"][entry]["resources"]
            {
                assert!(admit(&value).is_ok());
            } else {
                assert_eq!(admit(&value).unwrap_err(), expected());
            }
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
    for entry in 0..manifest()["resources"]["reviewed"]
        .as_array()
        .unwrap()
        .len()
    {
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
            json!("tool.audit_build_coverage"),
            "unknown variant `tool.audit_build_coverage`",
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
        .retain(|id| id != "get_build_workflow");
    value["operations"].as_array_mut().unwrap().push(json!({
        "operation":"gateway.owned", "owner":"node", "participants":["tool.get_build_workflow"]
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
        "tool.get_workflow_help",
        "tool.web_search",
        "tool.fetch_web_page",
        "tool.get_job_status",
        "tool.check_hardware_interfaces",
        "tool.propose_add_custom_filament",
        "tool.propose_create_build",
        "tool.propose_create_source_category",
        "tool.propose_rename_source_category",
        "tool.propose_delete_source_category",
        "tool.propose_set_source_category",
        "tool.propose_update_source",
        "tool.propose_update_source_naming",
        "tool.propose_import_source_files",
        "tool.propose_set_plan_progress",
        "tool.propose_set_plan_assembly",
        "tool.propose_verify_printer_checkoff",
        "tool.get_plan_checkoff",
        "tool.get_remaining",
        "tool.get_printer_checkoff",
        "tool.propose_import_3mf_checkoff",
        "tool.get_build_planning_state",
        "tool.list_build_differences",
        "tool.get_plan_draft",
        "tool.propose_update_build_brief",
        "tool.propose_resolve_build_differences",
        "tool.propose_set_build_source_roles",
        "tool.propose_rebuild_plan",
        "tool.propose_apply_plan_draft",
        "tool.get_plan_decisions",
        "tool.list_plans",
        "tool.list_plan_snapshots",
        "tool.get_plan_snapshot",
        "tool.get_kit_catalog",
        "tool.analyze_build_request",
        "tool.get_build_recipe",
        "tool.get_build_workflow",
        "tool.get_plan_option_groups",
        "tool.ui_highlight_part",
        "tool.ui_focus_stl_search",
        "tool.ui_navigate",
        "tool.ui_open_source",
        "tool.ui_open_docs",
        "tool.ui_focus_kit_option",
        "tool.read_source_file",
        "tool.list_sources",
        "tool.list_source_categories",
        "tool.search_source_files",
        "tool.preview_source_naming",
        "tool.get_source_docs",
        "tool.get_source_inventory",
        "tool.compare_source_revisions",
        "tool.audit_source_provenance",
        "tool.analyze_stl_mesh",
    ] {
        for participants in [vec![id], vec![]] {
            let mut value = manifest();
            regroup(&mut value, "tool.regrouped", &participants);
            value["node_participants"]["tool"]
                .as_array_mut()
                .unwrap()
                .retain(|name| format!("tool.{}", name.as_str().unwrap()) != id);
            let stand_in = "tool.audit_build_coverage";
            regroup(&mut value, id, &[stand_in]);
            let unresolved = value["resources"]["unresolved"].as_array_mut().unwrap();
            unresolved.retain(|operation| operation != stand_in);
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
        ("tool.get_workflow_help", "tool.check_hardware_interfaces"),
        (
            "tool.check_hardware_interfaces",
            "tool.propose_add_custom_filament",
        ),
        (
            "tool.propose_add_custom_filament",
            "tool.propose_create_build",
        ),
        (
            "tool.propose_create_build",
            "tool.propose_create_source_category",
        ),
        ("tool.get_workflow_help", "tool.get_plan_decisions"),
        (
            "tool.propose_create_source_category",
            "tool.get_plan_decisions",
        ),
        (
            "tool.propose_create_source_category",
            "tool.propose_rename_source_category",
        ),
        (
            "tool.propose_rename_source_category",
            "tool.propose_delete_source_category",
        ),
        (
            "tool.propose_delete_source_category",
            "tool.propose_set_source_category",
        ),
        (
            "tool.propose_set_source_category",
            "tool.propose_update_source",
        ),
        (
            "tool.propose_update_source",
            "tool.propose_update_source_naming",
        ),
        (
            "tool.propose_update_source_naming",
            "tool.propose_import_source_files",
        ),
        (
            "tool.propose_import_source_files",
            "tool.propose_set_plan_progress",
        ),
        (
            "tool.propose_set_plan_progress",
            "tool.propose_set_plan_assembly",
        ),
        (
            "tool.propose_set_plan_assembly",
            "tool.propose_verify_printer_checkoff",
        ),
        (
            "tool.propose_verify_printer_checkoff",
            "tool.get_plan_checkoff",
        ),
        ("tool.get_plan_checkoff", "tool.get_remaining"),
        ("tool.get_remaining", "tool.get_printer_checkoff"),
        (
            "tool.get_printer_checkoff",
            "tool.propose_import_3mf_checkoff",
        ),
        (
            "tool.propose_import_3mf_checkoff",
            "tool.get_build_planning_state",
        ),
        (
            "tool.get_build_planning_state",
            "tool.list_build_differences",
        ),
        ("tool.list_build_differences", "tool.get_plan_draft"),
        ("tool.get_plan_draft", "tool.propose_update_build_brief"),
        (
            "tool.propose_update_build_brief",
            "tool.propose_resolve_build_differences",
        ),
        (
            "tool.propose_resolve_build_differences",
            "tool.propose_set_build_source_roles",
        ),
        (
            "tool.propose_set_build_source_roles",
            "tool.propose_rebuild_plan",
        ),
        ("tool.propose_rebuild_plan", "tool.propose_apply_plan_draft"),
        ("tool.list_plans", "tool.list_plan_snapshots"),
        ("tool.list_plan_snapshots", "tool.get_plan_snapshot"),
        ("tool.get_kit_catalog", "tool.analyze_build_request"),
        ("tool.analyze_build_request", "tool.get_build_recipe"),
        ("tool.get_build_recipe", "tool.get_build_workflow"),
        ("tool.get_build_workflow", "tool.get_plan_option_groups"),
        ("tool.get_workflow_help", "tool.web_search"),
        ("tool.web_search", "tool.fetch_web_page"),
        ("tool.fetch_web_page", "tool.get_job_status"),
        ("tool.get_job_status", "tool.ui_highlight_part"),
        ("tool.ui_highlight_part", "tool.ui_focus_stl_search"),
        ("tool.ui_focus_stl_search", "tool.ui_navigate"),
        ("tool.ui_navigate", "tool.ui_open_source"),
        ("tool.ui_open_source", "tool.ui_open_docs"),
        ("tool.ui_open_docs", "tool.ui_focus_kit_option"),
        ("tool.ui_focus_stl_search", "tool.ui_focus_kit_option"),
        ("tool.ui_open_docs", "tool.get_source_docs"),
        ("tool.get_source_docs", "tool.get_source_inventory"),
        ("tool.get_source_inventory", "tool.compare_source_revisions"),
        (
            "tool.compare_source_revisions",
            "tool.audit_source_provenance",
        ),
        ("tool.read_source_file", "tool.analyze_stl_mesh"),
        ("tool.get_workflow_help", "tool.get_job_status"),
        ("tool.get_job_status", "tool.list_plans"),
        ("tool.get_workflow_help", "tool.list_plans"),
        ("tool.get_workflow_help", "tool.preview_source_naming"),
        ("tool.preview_source_naming", "tool.list_sources"),
        ("tool.search_source_files", "tool.preview_source_naming"),
        ("tool.read_source_file", "tool.list_sources"),
        ("tool.read_source_file", "tool.list_source_categories"),
        ("tool.list_sources", "tool.list_source_categories"),
        ("tool.read_source_file", "tool.search_source_files"),
        ("tool.search_source_files", "tool.list_sources"),
        ("tool.search_source_files", "tool.list_source_categories"),
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
        &["tool.audit_build_coverage", "tool.compare_plans"],
    );
    let unresolved = value["resources"]["unresolved"].as_array_mut().unwrap();
    unresolved.retain(|id| id != "tool.audit_build_coverage" && id != "tool.compare_plans");
    unresolved.push(json!("tool.source_queries"));
    let index = admit(&value).unwrap();
    for id in ["tool.audit_build_coverage", "tool.compare_plans"] {
        assert_eq!(index.lookup(id).unwrap().operation, "tool.source_queries");
        assert_eq!(
            index.resources_for(id),
            Err(AdmissionError::UnresolvedResources {
                operation: "tool.source_queries".into()
            })
        );
    }
}

#[test]
fn ticket_t_7_ownership_preview_naming_owner_and_unknown_resource_fail_closed() {
    let id = "tool.preview_source_naming";
    for owner in ["rust", "python"] {
        let mut value = manifest();
        regroup(&mut value, id, &[id]);
        value["operations"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["owner"] = json!(owner);
        let expected = if owner == "rust" {
            AdmissionError::UnsupportedRustOwner {
                participant: id.into(),
            }
        } else {
            AdmissionError::UnknownOwner {
                value: owner.into(),
            }
        };
        assert_eq!(admit(&value).unwrap_err(), expected);
    }
    let mut value = manifest();
    let entry = value["resources"]["reviewed"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["operation"] == id)
        .unwrap();
    entry["resources"][0] = json!({"kind":"table", "name":"unreviewed_naming"});
    let AdmissionError::Malformed(detail) = admit(&value).unwrap_err() else {
        panic!("unknown naming table was admitted");
    };
    assert!(
        detail.contains("unknown variant `unreviewed_naming`"),
        "{detail}"
    );
}

#[test]
fn ticket_t_7_ownership_workflow_help_is_reviewed_empty_and_node_owned() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.get_workflow_help";
    let index = admit_bundled_manifest().unwrap();
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(index.admit_rollback(id), Ok(&BTreeSet::new()));
    for owner in ["rust", "python"] {
        let mut value = manifest();
        regroup(&mut value, id, &[id]);
        value["operations"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["owner"] = json!(owner);
        let expected = if owner == "rust" {
            AdmissionError::UnsupportedRustOwner {
                participant: id.into(),
            }
        } else {
            AdmissionError::UnknownOwner {
                value: owner.into(),
            }
        };
        assert_eq!(admit(&value).unwrap_err(), expected);
    }
    let mut value = manifest();
    let entry = value["resources"]["reviewed"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["operation"] == id)
        .unwrap();
    entry["resources"] = json!([{"kind":"table", "name":"unknown_workflow_table"}]);
    let AdmissionError::Malformed(detail) = admit(&value).unwrap_err() else {
        panic!("unknown workflow resource admitted");
    };
    assert!(
        detail.contains("unknown variant `unknown_workflow_table`"),
        "{detail}"
    );
}

#[test]
fn ticket_t_7_ownership_list_plans_refuses_before_effects() {
    let id = "tool.list_plans";
    let mut compatible = manifest();
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    let execute = |value: &Value, marker: &mut bool| -> Result<(), AdmissionError> {
        let index = admit(value)?;
        index.admit_rollback(id)?;
        *marker = true;
        Ok(())
    };
    let mut marker = false;
    assert_eq!(execute(&compatible, &mut marker), Ok(()));
    assert!(marker);
    let entry = compatible["resources"]["reviewed"]
        .as_array()
        .unwrap()
        .iter()
        .position(|entry| entry["operation"] == id)
        .unwrap();
    for (edit, expected) in [
        (0, AdmissionError::ResourceSetMismatch { id: id.into() }),
        (1, AdmissionError::ResourceSetMismatch { id: id.into() }),
        (
            2,
            malformed("missing reviewed resources for tool.list_plans"),
        ),
        (3, malformed("duplicate resource state for tool.list_plans")),
    ] {
        let mut value = compatible.clone();
        match edit {
            0 => {
                value["resources"]["reviewed"][entry]["resources"]
                    .as_array_mut()
                    .unwrap()
                    .remove(0);
            }
            1 => {
                let resource = value["resources"]["reviewed"][entry]["resources"][0].clone();
                value["resources"]["reviewed"][entry]["resources"]
                    .as_array_mut()
                    .unwrap()
                    .push(resource);
            }
            2 => {
                value["resources"]["reviewed"]
                    .as_array_mut()
                    .unwrap()
                    .remove(entry);
            }
            3 => {
                value["resources"]["unresolved"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(id));
            }
            _ => unreachable!(),
        }
        marker = false;
        assert_eq!(execute(&value, &mut marker), Err(expected));
        assert!(!marker);
    }
    let mut value = compatible.clone();
    value["resources"]["reviewed"][entry]["resources"][0] =
        json!({"kind":"table","name":"future_plan_table"});
    marker = false;
    assert!(
        matches!(execute(&value, &mut marker), Err(AdmissionError::Malformed(detail)) if detail.contains("unknown variant `future_plan_table`"))
    );
    assert!(!marker);
    let mut value = compatible.clone();
    value["operations"]
        .as_array_mut()
        .unwrap()
        .push(json!({"operation":"tool.conflict", "owner":"node", "participants":[id]}));
    marker = false;
    assert_eq!(
        execute(&value, &mut marker),
        Err(AdmissionError::ConflictingParticipant {
            operation: id.into(),
            left: "tool.conflict".into(),
            right: id.into(),
        })
    );
    assert!(!marker);
    for owner in ["rust", "python"] {
        let mut value = compatible.clone();
        regroup(&mut value, id, &[id]);
        value["operations"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["owner"] = json!(owner);
        let expected = if owner == "rust" {
            AdmissionError::UnsupportedRustOwner {
                participant: id.into(),
            }
        } else {
            AdmissionError::UnknownOwner {
                value: owner.into(),
            }
        };
        marker = false;
        assert_eq!(execute(&value, &mut marker), Err(expected));
        assert!(!marker);
    }
    for rust_writes in [None, Some(2)] {
        let mut incompatible_workspace = compatible.clone();
        incompatible_workspace["live_formats"]["source-revision-workspace"]["rust_writes"] =
            json!(rust_writes);
        marker = false;
        assert_eq!(
            execute(&incompatible_workspace, &mut marker),
            Err(AdmissionError::IncompatibleLiveFormat {
                operation: id.into(),
                format: "source-revision-workspace".into(),
                node_reads: 1,
                rust_writes,
            })
        );
        assert!(!marker);
    }
    marker = false;
    assert_eq!(
        execute(&manifest(), &mut marker),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: Some(35)
        })
    );
    assert!(!marker);
}

#[test]
fn ticket_t_7_ownership_job_status_has_reviewed_empty_node_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.get_job_status";
    let index = admit_bundled_manifest().unwrap();
    assert_eq!(index.resources_for(id), Ok(&ResourceSet::new()));
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(index.admit_rollback(id), Ok(&ResourceSet::new()));
}

#[test]
fn ticket_t_7_ownership_job_status_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.get_job_status");
}

#[test]
fn ticket_t_7_ownership_web_search_has_reviewed_empty_node_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.web_search";
    let index = admit_bundled_manifest().unwrap();
    assert_eq!(index.resources_for(id), Ok(&ResourceSet::new()));
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(index.admit_rollback(id), Ok(&ResourceSet::new()));
}

#[test]
fn ticket_t_7_ownership_web_search_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.web_search");
}

#[test]
fn ticket_t_7_ownership_fetch_web_page_has_reviewed_empty_node_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.fetch_web_page";
    let index = admit_bundled_manifest().unwrap();
    assert_eq!(index.resources_for(id), Ok(&ResourceSet::new()));
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(index.admit_rollback(id), Ok(&ResourceSet::new()));
}

#[test]
fn ticket_t_7_ownership_fetch_web_page_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.fetch_web_page");
}

#[test]
fn ticket_t_7_ownership_list_plan_snapshots_has_complete_node_owned_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.list_plan_snapshots";
    let index = admit_bundled_manifest().unwrap();
    let resources = index
        .resources_for(id)
        .expect("snapshot resources must be reviewed");
    let expected: ResourceSet = serde_json::from_value(json!([
        {"kind": "table", "name": "build_profiles"},
        {"kind": "table", "name": "plan_snapshots"}
    ]))
    .unwrap();
    assert_eq!(resources, &expected);
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(
        index.admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: Some(35),
        })
    );
    let mut compatible = manifest();
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Ok(&expected)
    );
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = Value::Null;
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: None,
        })
    );
    for owner in ["rust", "python"] {
        let mut value = manifest();
        regroup(&mut value, id, &[id]);
        value["operations"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["owner"] = json!(owner);
        let expected = if owner == "rust" {
            AdmissionError::UnsupportedRustOwner {
                participant: id.into(),
            }
        } else {
            AdmissionError::UnknownOwner {
                value: owner.into(),
            }
        };
        assert_eq!(admit(&value).unwrap_err(), expected);
    }
}

#[test]
fn ticket_t_7_ownership_list_plan_snapshots_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.list_plan_snapshots");
}

#[test]
fn ticket_t_7_ownership_ui_highlight_part_has_complete_node_owned_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.ui_highlight_part";
    let index = admit_bundled_manifest().unwrap();
    let resources = index
        .resources_for(id)
        .expect("highlight proposal resources must be reviewed");
    let expected: ResourceSet = serde_json::from_value(json!([
        {"kind": "table", "name": "build_profiles"}
    ]))
    .unwrap();
    assert_eq!(resources, &expected);
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(
        index.admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: Some(35),
        })
    );
    let mut compatible = manifest();
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Ok(&expected)
    );
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = Value::Null;
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: None,
        })
    );
    for owner in ["rust", "python"] {
        let mut value = manifest();
        regroup(&mut value, id, &[id]);
        value["operations"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["owner"] = json!(owner);
        let expected = if owner == "rust" {
            AdmissionError::UnsupportedRustOwner {
                participant: id.into(),
            }
        } else {
            AdmissionError::UnknownOwner {
                value: owner.into(),
            }
        };
        assert_eq!(admit(&value).unwrap_err(), expected);
    }
}

#[test]
fn ticket_t_7_ownership_ui_highlight_part_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.ui_highlight_part");
}

#[test]
fn ticket_t_7_ownership_ui_focus_stl_search_has_complete_node_owned_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.ui_focus_stl_search";
    let index = admit_bundled_manifest().unwrap();
    let resources = index
        .resources_for(id)
        .expect("STL search proposal resources must be reviewed");
    let expected: ResourceSet = serde_json::from_value(json!([
        {"kind": "table", "name": "build_profiles"}
    ]))
    .unwrap();
    assert_eq!(resources, &expected);
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(
        index.admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: Some(35),
        })
    );
    let mut compatible = manifest();
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Ok(&expected)
    );
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = Value::Null;
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: None,
        })
    );
    for owner in ["rust", "python"] {
        let mut value = manifest();
        regroup(&mut value, id, &[id]);
        value["operations"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["owner"] = json!(owner);
        let expected = if owner == "rust" {
            AdmissionError::UnsupportedRustOwner {
                participant: id.into(),
            }
        } else {
            AdmissionError::UnknownOwner {
                value: owner.into(),
            }
        };
        assert_eq!(admit(&value).unwrap_err(), expected);
    }
}

#[test]
fn ticket_t_7_ownership_ui_focus_stl_search_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.ui_focus_stl_search");
}

#[test]
fn ticket_t_7_ownership_ui_navigate_has_complete_node_owned_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.ui_navigate";
    let index = admit_bundled_manifest().unwrap();
    let resources = index
        .resources_for(id)
        .expect("Navigation proposal resources must be reviewed");
    let expected: ResourceSet = serde_json::from_value(json!([
        {"kind": "table", "name": "build_profiles"}
    ]))
    .unwrap();
    assert_eq!(resources, &expected);
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(
        index.admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: Some(35),
        })
    );
    let mut compatible = manifest();
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Ok(&expected)
    );
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = Value::Null;
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: None,
        })
    );
    for owner in ["rust", "python"] {
        let mut value = manifest();
        regroup(&mut value, id, &[id]);
        value["operations"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["owner"] = json!(owner);
        let expected = if owner == "rust" {
            AdmissionError::UnsupportedRustOwner {
                participant: id.into(),
            }
        } else {
            AdmissionError::UnknownOwner {
                value: owner.into(),
            }
        };
        assert_eq!(admit(&value).unwrap_err(), expected);
    }
}

#[test]
fn ticket_t_7_ownership_ui_navigate_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.ui_navigate");
}

#[test]
fn ticket_t_7_ownership_ui_open_source_has_complete_node_owned_resources() {
    assert_workspace_tool_resources("tool.ui_open_source");
}

#[test]
fn ticket_t_7_ownership_ui_open_docs_has_complete_node_owned_resources() {
    assert_workspace_tool_resources("tool.ui_open_docs");
}

#[test]
fn ticket_t_7_ownership_ui_focus_kit_option_has_complete_node_owned_resources() {
    assert_workspace_tool_resources("tool.ui_focus_kit_option");
}

fn assert_workspace_tool_resources(id: &str) {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let index = admit_bundled_manifest().unwrap();
    let resources = index
        .resources_for(id)
        .expect("Workspace tool resources must be reviewed");
    let expected: ResourceSet = serde_json::from_value(if id == "tool.analyze_stl_mesh" {
        json!([
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "file", "name": "source-workspace"}
        ])
    } else if matches!(
        id,
        "tool.compare_source_revisions" | "tool.audit_source_provenance"
    ) {
        json!([
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "table", "name": "source_revisions"},
            {"kind": "file", "name": "source-workspace"}
        ])
    } else if matches!(id, "tool.get_source_docs" | "tool.get_source_inventory") {
        json!([
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "table", "name": "source_notes"},
            {"kind": "table", "name": "source_revisions"},
            {"kind": "table", "name": "app_settings"},
            {"kind": "file", "name": "source-workspace"}
        ])
    } else {
        json!([
            {"kind": "table", "name": "build_profiles"},
            {"kind": "table", "name": "projects"},
            {"kind": "table", "name": "source_docs"},
            {"kind": "file", "name": "source-workspace"}
        ])
    })
    .unwrap();
    assert_eq!(resources, &expected);
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    for writer in [json!(35), Value::Null] {
        let mut value = manifest();
        value["live_formats"]["sqlite-schema"]["rust_writes"] = writer.clone();
        let mut effect = false;
        let result = admit(&value).and_then(|index| {
            index.admit_rollback(id)?;
            effect = true;
            Ok(())
        });
        assert_eq!(
            result,
            Err(AdmissionError::IncompatibleLiveFormat {
                operation: id.into(),
                format: "sqlite-schema".into(),
                node_reads: 34,
                rust_writes: if writer.is_null() { None } else { Some(35) },
            })
        );
        assert!(!effect);
    }
    let mut compatible = manifest();
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Ok(&expected)
    );
    compatible["live_formats"]["sqlite-schema"]["rust_writes"] = Value::Null;
    assert_eq!(
        admit(&compatible).unwrap().admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: None,
        })
    );
    for writer in [Value::Null, json!(2)] {
        let mut value = manifest();
        value["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
        value["live_formats"]["source-revision-workspace"]["rust_writes"] = writer.clone();
        let mut effect = false;
        let result = admit(&value).and_then(|index| {
            index.admit_rollback(id)?;
            effect = true;
            Ok(())
        });
        assert_eq!(
            result,
            Err(AdmissionError::IncompatibleLiveFormat {
                operation: id.into(),
                format: "source-revision-workspace".into(),
                node_reads: 1,
                rust_writes: if writer.is_null() { None } else { Some(2) },
            })
        );
        assert!(!effect);
    }
    for owner in ["rust", "python"] {
        let mut value = manifest();
        regroup(&mut value, id, &[id]);
        value["operations"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["owner"] = json!(owner);
        let expected = if owner == "rust" {
            AdmissionError::UnsupportedRustOwner {
                participant: id.into(),
            }
        } else {
            AdmissionError::UnknownOwner {
                value: owner.into(),
            }
        };
        assert_eq!(admit(&value).unwrap_err(), expected);
    }
}

#[test]
fn ticket_t_7_ownership_ui_open_source_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.ui_open_source");
}

#[test]
fn ticket_t_7_ownership_ui_open_docs_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.ui_open_docs");
}

#[test]
fn ticket_t_7_ownership_ui_focus_kit_option_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.ui_focus_kit_option");
}

#[test]
fn ticket_t_7_ownership_get_source_docs_has_complete_node_owned_resources() {
    assert_workspace_tool_resources("tool.get_source_docs");
}

#[test]
fn ticket_t_7_ownership_get_source_docs_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.get_source_docs");
}

#[test]
fn ticket_t_7_ownership_get_source_inventory_has_complete_node_owned_resources() {
    assert_workspace_tool_resources("tool.get_source_inventory");
}

#[test]
fn ticket_t_7_ownership_get_source_inventory_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.get_source_inventory");
}

#[test]
fn ticket_t_7_ownership_compare_source_revisions_has_complete_node_owned_resources() {
    assert_workspace_tool_resources("tool.compare_source_revisions");
}

#[test]
fn ticket_t_7_ownership_compare_source_revisions_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.compare_source_revisions");
}

#[test]
fn ticket_t_7_ownership_audit_source_provenance_has_complete_node_owned_resources() {
    assert_workspace_tool_resources("tool.audit_source_provenance");
}

#[test]
fn ticket_t_7_ownership_audit_source_provenance_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.audit_source_provenance");
}

#[test]
fn ticket_t_7_ownership_analyze_stl_mesh_has_complete_node_owned_resources() {
    assert_workspace_tool_resources("tool.analyze_stl_mesh");
}

#[test]
fn ticket_t_7_ownership_analyze_stl_mesh_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.analyze_stl_mesh");
}

#[test]
fn ticket_t_7_ownership_get_plan_snapshot_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.get_plan_snapshot");
}

#[test]
fn ticket_t_7_ownership_get_kit_catalog_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.get_kit_catalog");
}

#[test]
fn ticket_t_7_ownership_analyze_build_request_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.analyze_build_request");
}

#[test]
fn ticket_t_7_ownership_get_build_recipe_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.get_build_recipe");
}

fn assert_tool_invalid_admission(id: &str) {
    let mut original = manifest();
    original["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    let mut baseline_effect = false;
    admit(&original)
        .and_then(|index| {
            index.admit_rollback(id)?;
            baseline_effect = true;
            Ok(())
        })
        .unwrap();
    assert!(baseline_effect);
    let entry = original["resources"]["reviewed"]
        .as_array()
        .unwrap()
        .iter()
        .position(|entry| entry["operation"] == id)
        .unwrap();
    for resource_index in 0..original["resources"]["reviewed"][entry]["resources"]
        .as_array()
        .unwrap()
        .len()
    {
        for duplicate in [false, true] {
            let mut value = original.clone();
            let resources = value["resources"]["reviewed"][entry]["resources"]
                .as_array_mut()
                .unwrap();
            if duplicate {
                resources.push(resources[resource_index].clone());
            } else {
                resources.remove(resource_index);
            }
            let mut effect = false;
            assert_eq!(
                admit(&value).and_then(|index| {
                    index.admit_rollback(id)?;
                    effect = true;
                    Ok(())
                }),
                Err(AdmissionError::ResourceSetMismatch { id: id.into() }),
                "{id}, resource {resource_index}, duplicate {duplicate}"
            );
            assert!(
                !effect,
                "{id}, resource {resource_index}, duplicate {duplicate}"
            );
        }
    }
    let resources_empty = original["resources"]["reviewed"][entry]["resources"]
        .as_array()
        .unwrap()
        .is_empty();
    for edit in 0..15 {
        if resources_empty && (9..=11).contains(&edit) {
            continue;
        }
        let mut value = original.clone();
        let expected = match edit {
            0 | 1 => {
                value["resources"]["reviewed"][entry]["resources"] = if edit == 0 {
                    json!([{"kind":"table","name":"projects"}])
                } else {
                    json!([{"kind":"file","name":"source-workspace"}])
                };
                AdmissionError::ResourceSetMismatch { id: id.into() }
            }
            2 | 3 => {
                value["resources"]["reviewed"]
                    .as_array_mut()
                    .unwrap()
                    .remove(entry);
                if edit == 3 {
                    value["resources"]["unresolved"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(id));
                }
                malformed(&format!("missing reviewed resources for {id}"))
            }
            4 => {
                value["resources"]["reviewed"]
                    .as_array_mut()
                    .unwrap()
                    .push(original["resources"]["reviewed"][entry].clone());
                malformed(&format!("duplicate resource state for {id}"))
            }
            5 => {
                value["resources"]["unresolved"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(id));
                malformed(&format!("duplicate resource state for {id}"))
            }
            6 | 7 => {
                regroup(&mut value, id, &[id]);
                value["operations"]
                    .as_array_mut()
                    .unwrap()
                    .last_mut()
                    .unwrap()["owner"] = json!(if edit == 6 { "rust" } else { "python" });
                if edit == 6 {
                    AdmissionError::UnsupportedRustOwner {
                        participant: id.into(),
                    }
                } else {
                    AdmissionError::UnknownOwner {
                        value: "python".into(),
                    }
                }
            }
            8 => {
                value["operations"].as_array_mut().unwrap().push(
                    json!({"operation":"tool.conflict", "owner":"node", "participants":[id]}),
                );
                AdmissionError::ConflictingParticipant {
                    operation: id.into(),
                    left: "tool.conflict".into(),
                    right: id.into(),
                }
            }
            9..=11 => {
                let resources = value["resources"]["reviewed"][entry]["resources"]
                    .as_array_mut()
                    .unwrap();
                match edit {
                    9 => {
                        resources.remove(0);
                    }
                    10 => {
                        resources.push(resources[0].clone());
                    }
                    11 => {
                        resources.clear();
                    }
                    _ => unreachable!(),
                }
                AdmissionError::ResourceSetMismatch { id: id.into() }
            }
            12 => {
                value["resources"]["reviewed"][entry]["resources"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"kind":"table","name":"plan_snapshots"}));
                AdmissionError::ResourceSetMismatch { id: id.into() }
            }
            13 => {
                let participant = "tool.audit_build_coverage";
                regroup(&mut value, "tool.regrouped", &[id]);
                regroup(&mut value, id, &[participant]);
                let unresolved = value["resources"]["unresolved"].as_array_mut().unwrap();
                unresolved.retain(|operation| operation != participant);
                unresolved.push(json!("tool.regrouped"));
                malformed(&format!(
                    "reviewed participant {id} must belong to operation {id}"
                ))
            }
            14 => {
                value["resources"]["reviewed"][entry]["resources"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"kind":"table","name":"plan_decisions"}));
                AdmissionError::ResourceSetMismatch { id: id.into() }
            }
            _ => unreachable!(),
        };
        let mut effect = false;
        let result = admit(&value).and_then(|index| {
            index.admit_rollback(id)?;
            effect = true;
            Ok(())
        });
        assert_eq!(result, Err(expected), "{id}, edit {edit}");
        assert!(!effect, "{id}, edit {edit}");
    }

    for resource in [
        json!({"kind":"table","name":"unregistered_table"}),
        json!({"kind":"file","name":"unregistered-file"}),
    ] {
        let mut value = original.clone();
        value["resources"]["reviewed"][entry]["resources"]
            .as_array_mut()
            .unwrap()
            .push(resource.clone());
        let mut effect = false;
        assert!(
            matches!(
                admit(&value).and_then(|index| {
                    index.admit_rollback(id)?;
                    effect = true;
                    Ok(())
                }),
                Err(AdmissionError::Malformed(_))
            ),
            "{id}, unregistered resource {resource}"
        );
        assert!(!effect, "{id}, unregistered resource {resource}");
    }
}

#[test]
fn ticket_t_7_ownership_get_plan_snapshot_has_complete_node_owned_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.get_plan_snapshot";
    let index = admit_bundled_manifest().unwrap();
    let resources = index
        .resources_for(id)
        .expect("snapshot resources must be reviewed");
    let expected: ResourceSet = serde_json::from_value(json!([
        {"kind":"table","name":"build_profiles"},
        {"kind":"table","name":"parts"},
        {"kind":"table","name":"profile_layers"},
        {"kind":"table","name":"projects"},
        {"kind":"table","name":"source_revisions"},
        {"kind":"table","name":"app_settings"},
        {"kind":"table","name":"plan_accepted_input_sets"},
        {"kind":"table","name":"plan_revision_input_sets"},
        {"kind":"table","name":"plan_revision_inputs"},
        {"kind":"file","name":"source-workspace"},
        {"kind":"file","name":"kit-catalog"}
    ]))
    .unwrap();
    assert_eq!(resources, &expected);
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    for (format, node_reads, writers) in [
        ("sqlite-schema", 34, vec![Some(35), None]),
        ("source-revision-workspace", 1, vec![Some(2), None]),
        ("kit-catalog", 1, vec![Some(2), None]),
    ] {
        for rust_writes in writers {
            let mut value = manifest();
            value["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
            value["live_formats"]["kit-catalog"]["rust_writes"] = json!(1);
            value["live_formats"][format]["rust_writes"] = json!(rust_writes);
            let mut effect = false;
            assert_eq!(
                admit(&value).and_then(|index| {
                    index.admit_rollback(id)?;
                    effect = true;
                    Ok(())
                }),
                Err(AdmissionError::IncompatibleLiveFormat {
                    operation: id.into(),
                    format: format.into(),
                    node_reads,
                    rust_writes,
                })
            );
            assert!(!effect);
        }
    }
    assert_eq!(
        index.admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: Some(35),
        })
    );
    let mut value = manifest();
    value["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    assert_eq!(admit(&value).unwrap().admit_rollback(id), Ok(&expected));
    value["live_formats"]["kit-catalog"]["rust_writes"] = json!(1);
    assert_eq!(admit(&value).unwrap().admit_rollback(id), Ok(&expected));
    value["live_formats"]["kit-catalog"]["node_reads"] = json!(2);
    assert_eq!(admit(&value).unwrap().admit_rollback(id), Ok(&expected));
}

#[test]
fn ticket_t_7_ownership_get_plan_snapshot_requires_valid_catalog_format() {
    for field in ["node_reads", "rust_writes"] {
        let mut value = manifest();
        value["live_formats"]["kit-catalog"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            matches!(admit(&value), Err(AdmissionError::Malformed(detail)) if detail.contains(&format!("missing field `{field}`")))
        );
        value["live_formats"]["kit-catalog"][field] = json!(0);
        assert_eq!(
            admit(&value).unwrap_err(),
            malformed("live format kit-catalog has version 0")
        );
    }
    let mut value = manifest();
    value["live_formats"]
        .as_object_mut()
        .unwrap()
        .remove("kit-catalog");
    assert!(
        matches!(admit(&value), Err(AdmissionError::Malformed(detail)) if detail.contains("missing field `kit-catalog`"))
    );
}

#[test]
fn ticket_t_7_ownership_get_kit_catalog_has_complete_node_owned_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.get_kit_catalog";
    let index = admit_bundled_manifest().unwrap();
    let expected: ResourceSet = serde_json::from_value(json!([
        {"kind":"file","name":"kit-catalog"}
    ]))
    .unwrap();
    assert_eq!(index.resources_for(id), Ok(&expected));
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(index.admit_rollback(id), Ok(&expected));
    for rust_writes in [None, Some(2)] {
        let mut value = manifest();
        value["live_formats"]["kit-catalog"]["rust_writes"] = json!(rust_writes);
        let mut effect = false;
        assert_eq!(
            admit(&value).and_then(|index| {
                index.admit_rollback(id)?;
                effect = true;
                Ok(())
            }),
            Err(AdmissionError::IncompatibleLiveFormat {
                operation: id.into(),
                format: "kit-catalog".into(),
                node_reads: 1,
                rust_writes,
            })
        );
        assert!(!effect);
    }
    let mut value = manifest();
    value["live_formats"]["kit-catalog"]["rust_writes"] = json!(1);
    assert_eq!(admit(&value).unwrap().admit_rollback(id), Ok(&expected));
}

#[test]
fn ticket_t_7_ownership_analyze_build_request_has_complete_node_owned_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.analyze_build_request";
    let index = admit_bundled_manifest().unwrap();
    let expected: ResourceSet = serde_json::from_value(json!([
        {"kind":"file","name":"kit-catalog"}
    ]))
    .unwrap();
    assert_eq!(index.resources_for(id), Ok(&expected));
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(index.admit_rollback(id), Ok(&expected));
    for rust_writes in [None, Some(2)] {
        let mut value = manifest();
        value["live_formats"]["kit-catalog"]["rust_writes"] = json!(rust_writes);
        let mut effect = false;
        assert_eq!(
            admit(&value).and_then(|index| {
                index.admit_rollback(id)?;
                effect = true;
                Ok(())
            }),
            Err(AdmissionError::IncompatibleLiveFormat {
                operation: id.into(),
                format: "kit-catalog".into(),
                node_reads: 1,
                rust_writes,
            })
        );
        assert!(!effect);
    }
    let mut value = manifest();
    value["live_formats"]["kit-catalog"]["rust_writes"] = json!(1);
    assert_eq!(admit(&value).unwrap().admit_rollback(id), Ok(&expected));
}

#[test]
fn ticket_t_7_ownership_get_build_recipe_has_complete_node_owned_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.get_build_recipe";
    let index = admit_bundled_manifest().unwrap();
    let expected: ResourceSet = serde_json::from_value(json!([
        {"kind":"table","name":"build_profiles"},
        {"kind":"table","name":"profile_layers"},
        {"kind":"table","name":"projects"},
        {"kind":"table","name":"source_docs"},
        {"kind":"table","name":"app_settings"},
        {"kind":"table","name":"plan_decisions"},
        {"kind":"file","name":"kit-catalog"},
        {"kind":"file","name":"source-workspace"}
    ]))
    .unwrap();
    assert_eq!(index.resources_for(id), Ok(&expected));
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(
        index.admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: Some(35),
        })
    );
    let mut sqlite_compatible = manifest();
    sqlite_compatible["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    assert_eq!(
        admit(&sqlite_compatible).unwrap().admit_rollback(id),
        Ok(&expected)
    );
    for (format, node_reads, writers) in [
        ("sqlite-schema", 34, vec![Some(35), None]),
        ("source-revision-workspace", 1, vec![Some(2), None]),
        ("kit-catalog", 1, vec![Some(2), None]),
    ] {
        for rust_writes in writers {
            let mut value = manifest();
            value["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
            value["live_formats"]["kit-catalog"]["rust_writes"] = json!(1);
            value["live_formats"][format]["rust_writes"] = json!(rust_writes);
            let mut effect = false;
            assert_eq!(
                admit(&value).and_then(|index| {
                    index.admit_rollback(id)?;
                    effect = true;
                    Ok(())
                }),
                Err(AdmissionError::IncompatibleLiveFormat {
                    operation: id.into(),
                    format: format.into(),
                    node_reads,
                    rust_writes,
                })
            );
            assert!(!effect);
        }
    }
    let mut value = manifest();
    value["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    value["live_formats"]["kit-catalog"]["rust_writes"] = json!(1);
    assert_eq!(admit(&value).unwrap().admit_rollback(id), Ok(&expected));
}

#[test]
fn ticket_t_7_ownership_get_build_workflow_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.get_build_workflow");
}

#[test]
fn ticket_t_7_ownership_get_build_workflow_has_complete_node_owned_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.get_build_workflow";
    let index = admit_bundled_manifest().unwrap();
    let expected: ResourceSet = serde_json::from_value(json!([
        {"kind":"table","name":"accepted_plate_heads"},
        {"kind":"table","name":"accepted_plate_revisions"},
        {"kind":"table","name":"accepted_plate_units"},
        {"kind":"table","name":"accepted_plates"},
        {"kind":"table","name":"app_settings"},
        {"kind":"table","name":"build_profiles"},
        {"kind":"table","name":"parts"},
        {"kind":"table","name":"plan_accepted_input_sets"},
        {"kind":"table","name":"plan_draft_inputs"},
        {"kind":"table","name":"plan_draft_parts"},
        {"kind":"table","name":"plan_draft_required_unit_assignments"},
        {"kind":"table","name":"plan_draft_required_unit_decisions"},
        {"kind":"table","name":"plan_draft_required_unit_reconciliations"},
        {"kind":"table","name":"plan_drafts"},
        {"kind":"table","name":"plan_revision_input_sets"},
        {"kind":"table","name":"plan_revision_inputs"},
        {"kind":"table","name":"plan_revision_parts"},
        {"kind":"table","name":"plan_revision_required_unit_sets"},
        {"kind":"table","name":"plan_revision_required_units"},
        {"kind":"table","name":"plan_revisions"},
        {"kind":"table","name":"print_progress"},
        {"kind":"table","name":"profile_layers"},
        {"kind":"table","name":"projects"},
        {"kind":"table","name":"required_units"},
        {"kind":"table","name":"source_revisions"},
        {"kind":"file","name":"source-workspace"}
    ]))
    .unwrap();
    assert_eq!(index.resources_for(id), Ok(&expected));
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(
        index.admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: Some(35),
        })
    );
    let mut sqlite_compatible = manifest();
    sqlite_compatible["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    assert_eq!(
        admit(&sqlite_compatible).unwrap().admit_rollback(id),
        Ok(&expected)
    );
    for (format, node_reads, writers) in [
        ("sqlite-schema", 34, vec![Some(35), None]),
        ("source-revision-workspace", 1, vec![Some(2), None]),
    ] {
        for rust_writes in writers {
            let mut value = manifest();
            value["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
            value["live_formats"][format]["rust_writes"] = json!(rust_writes);
            let mut effect = false;
            assert_eq!(
                admit(&value).and_then(|index| {
                    index.admit_rollback(id)?;
                    effect = true;
                    Ok(())
                }),
                Err(AdmissionError::IncompatibleLiveFormat {
                    operation: id.into(),
                    format: format.into(),
                    node_reads,
                    rust_writes,
                })
            );
            assert!(!effect);
        }
    }
    let mut value = manifest();
    value["live_formats"]["sqlite-schema"]["rust_writes"] = json!(34);
    value["live_formats"]["source-revision-workspace"]["rust_writes"] = json!(1);
    assert_eq!(admit(&value).unwrap().admit_rollback(id), Ok(&expected));
}

#[test]
fn ticket_t_7_ownership_get_plan_option_groups_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.get_plan_option_groups");
}

#[test]
fn ticket_t_7_ownership_get_plan_option_groups_has_complete_node_owned_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.get_plan_option_groups";
    let index = admit_bundled_manifest().unwrap();
    let resources = index
        .resources_for(id)
        .expect("plan option group resources must be reviewed");
    let expected: ResourceSet = serde_json::from_value(json!([
        {"kind":"table","name":"build_profiles"},
        {"kind":"table","name":"profile_layers"},
        {"kind":"table","name":"projects"},
        {"kind":"table","name":"app_settings"},
        {"kind":"file","name":"source-workspace"},
        {"kind":"file","name":"path-hints"},
        {"kind":"file","name":"community-manifests"}
    ]))
    .unwrap();
    assert_eq!(resources, &expected);
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(
        index.admit_rollback(id),
        Err(AdmissionError::IncompatibleLiveFormat {
            operation: id.into(),
            format: "sqlite-schema".into(),
            node_reads: 34,
            rust_writes: Some(35),
        })
    );
    let mut sqlite_compatible = manifest();
    sqlite_compatible["live_formats"]["sqlite-schema"]["node_reads"] = json!(35);
    assert_eq!(
        admit(&sqlite_compatible).unwrap().admit_rollback(id),
        Ok(&expected)
    );
    for format in ["path-hints", "community-manifests"] {
        assert_eq!(
            sqlite_compatible["live_formats"][format]["rust_writes"],
            json!("none")
        );
    }
    for (format, node_reads) in [
        ("sqlite-schema", 34),
        ("source-revision-workspace", 1),
        ("path-hints", 1),
        ("community-manifests", 1),
    ] {
        for rust_writes in [None, Some(node_reads + 1)] {
            let mut value = manifest();
            for (compatible_format, version) in [
                ("sqlite-schema", 34),
                ("source-revision-workspace", 1),
                ("path-hints", 1),
                ("community-manifests", 1),
            ] {
                value["live_formats"][compatible_format]["rust_writes"] = json!(version);
            }
            let compatible = admit(&value).unwrap();
            assert_eq!(compatible.admit_rollback(id), Ok(&expected));
            value["live_formats"][format]["rust_writes"] = json!(rust_writes);
            let mut effect = false;
            assert_eq!(
                admit(&value).and_then(|index| {
                    index.admit_rollback(id)?;
                    effect = true;
                    Ok(())
                }),
                Err(AdmissionError::IncompatibleLiveFormat {
                    operation: id.into(),
                    format: format.into(),
                    node_reads,
                    rust_writes,
                })
            );
            assert!(!effect);
        }
    }
}

#[test]
fn ticket_t_7_ownership_get_plan_option_groups_requires_valid_inference_formats() {
    for format in ["path-hints", "community-manifests"] {
        for field in ["node_reads", "rust_writes"] {
            let mut value = manifest();
            value["live_formats"][format]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(
                matches!(admit(&value), Err(AdmissionError::Malformed(detail)) if detail.contains(&format!("missing field `{field}`")))
            );
            value["live_formats"][format][field] = json!(0);
            assert_eq!(
                admit(&value).unwrap_err(),
                malformed(&format!("live format {format} has version 0"))
            );
        }
        let mut value = manifest();
        value["live_formats"]
            .as_object_mut()
            .unwrap()
            .remove(format);
        assert!(
            matches!(admit(&value), Err(AdmissionError::Malformed(detail)) if detail.contains(&format!("missing field `{format}`")))
        );
    }
}

#[test]
fn ticket_t_7_ownership_hardware_interfaces_has_reviewed_empty_node_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.check_hardware_interfaces";
    let index = admit_bundled_manifest().unwrap();
    assert_eq!(index.resources_for(id), Ok(&ResourceSet::new()));
    assert_eq!(
        index.lookup(id).unwrap().disposition,
        Disposition::Owned(Owner::Node)
    );
    assert_eq!(index.admit_rollback(id), Ok(&ResourceSet::new()));
}

#[test]
fn ticket_t_7_ownership_hardware_interfaces_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.check_hardware_interfaces");
}

#[test]
fn ticket_t_7_ownership_custom_filament_proposal_has_reviewed_empty_node_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.propose_add_custom_filament";
    let index = admit_bundled_manifest().unwrap();
    assert_eq!(index.resources_for(id), Ok(&ResourceSet::new()));
    let claim = index.lookup(id).unwrap();
    assert_eq!(claim.operation, id);
    assert_eq!(claim.disposition, Disposition::Owned(Owner::Node));
    assert_eq!(index.admit_rollback(id), Ok(&ResourceSet::new()));

    let application = "assistant.propose_add_custom_filament";
    assert_eq!(
        index.resources_for(application),
        Err(AdmissionError::UnresolvedResources {
            operation: application.into()
        })
    );
    let mut effect = false;
    assert_eq!(
        index.admit_rollback(application).map(|_| effect = true),
        Err(AdmissionError::UnresolvedResources {
            operation: application.into()
        })
    );
    assert!(!effect);
}

#[test]
fn ticket_t_7_ownership_custom_filament_proposal_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_add_custom_filament");
}

#[test]
fn ticket_t_7_ownership_create_build_proposal_has_reviewed_empty_node_resources() {
    use pp_gateway::ownership::{Owner, manifest::Disposition};
    let id = "tool.propose_create_build";
    let index = admit_bundled_manifest().unwrap();
    assert_eq!(index.resources_for(id), Ok(&ResourceSet::new()));
    let claim = index.lookup(id).unwrap();
    assert_eq!(claim.operation, id);
    assert_eq!(claim.disposition, Disposition::Owned(Owner::Node));
    assert_eq!(index.admit_rollback(id), Ok(&ResourceSet::new()));

    let application = "assistant.propose_create_build";
    assert_eq!(
        index.resources_for(application),
        Err(AdmissionError::UnresolvedResources {
            operation: application.into()
        })
    );
    let mut effect = false;
    assert_eq!(
        index.admit_rollback(application).map(|_| effect = true),
        Err(AdmissionError::UnresolvedResources {
            operation: application.into()
        })
    );
    assert!(!effect);
}

#[test]
fn ticket_t_7_ownership_create_build_proposal_refuses_invalid_admission_before_effects() {
    assert_tool_invalid_admission("tool.propose_create_build");
}
