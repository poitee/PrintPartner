use pp_gateway::ownership::{
    AdmissionError,
    manifest::{OwnershipIndex, admit_bundled_manifest, admit_manifest_documents},
    resources::{
        FileFamily,
        ResourceId::{File, Table},
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

fn number_after(source: &str, marker: &str) -> u64 {
    let start = source
        .find(marker)
        .unwrap_or_else(|| panic!("{marker} not found"))
        + marker.len();
    source[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap()
}

type Edit = fn(&mut Value);

fn sqlite_refusal(operation: &str) -> AdmissionError {
    AdmissionError::IncompatibleLiveFormat {
        operation: operation.into(),
        format: "sqlite-schema".into(),
        node_reads: 34,
        rust_writes: Some(35),
    }
}

#[test]
fn declared_versions_match_the_node_and_rust_sources() {
    let formats = &manifest()["live_formats"];
    let node_schema = number_after(
        include_str!("../../../../web/apps/server/src/db/schema.ts"),
        "export const currentSchemaVersion = ",
    );
    let rust_schema = number_after(
        include_str!("../../pp-storage/src/schema.rs"),
        "is newer than supported version ",
    );
    let node_snapshot = number_after(
        include_str!("../../../../web/apps/server/src/services/local-source-snapshot.ts"),
        "const SOURCE_SNAPSHOT_MANIFEST_VERSION = ",
    );
    let rust_snapshot = number_after(
        include_str!("../../pp-source/src/lib.rs"),
        "manifest.version != ",
    );
    assert_eq!((node_schema, rust_schema), (34, 35));
    assert_eq!((node_snapshot, rust_snapshot), (1, 1));
    assert_eq!(
        formats,
        &json!({
            "sqlite-schema": {"node_reads": node_schema, "rust_writes": rust_schema},
            "source-revision-workspace": {"node_reads": node_snapshot, "rust_writes": rust_snapshot},
            "source-covers": {"node_reads": 1, "rust_writes": null},
        })
    );
}

#[test]
fn bundled_rollback_refuses_every_reviewed_operation_on_the_newer_schema() {
    let index = admit_bundled_manifest().unwrap();
    for (participant, operation) in [
        ("job.sync", "source.sync"),
        ("http.POST /api/v1/jobs/sync", "source.sync"),
        ("http.HEAD /sources/:id/docs", "source.sync"),
        ("mcp.start_sync", "source.sync"),
        ("tool.read_source_file", "tool.read_source_file"),
        ("tool.search_source_files", "tool.search_source_files"),
        ("tool.preview_source_naming", "tool.preview_source_naming"),
        ("tool.list_sources", "tool.list_sources"),
        ("tool.list_source_categories", "tool.list_source_categories"),
    ] {
        assert_eq!(
            index.admit_rollback(participant),
            Err(sqlite_refusal(operation)),
            "{participant}"
        );
    }
    assert_eq!(
        index.admit_rollback("http.GET /api/v2/plans"),
        Err(AdmissionError::UnresolvedResources {
            operation: "http:GET /plans current".into()
        })
    );
    assert_eq!(
        index.admit_rollback("tool.missing"),
        Err(AdmissionError::UnknownParticipant {
            id: "tool.missing".into()
        })
    );
    assert_eq!(
        sqlite_refusal("tool.list_sources").to_string(),
        "rollback of tool.list_sources refused: Rust writes sqlite-schema 35, Node reads up to 34"
    );
}

#[test]
fn rollback_admits_only_when_node_reads_every_written_format() {
    let mut value = manifest();
    value["live_formats"]["sqlite-schema"]["node_reads"] = json!(35);
    let index = admit(&value).unwrap();
    for participant in ["tool.read_source_file", "tool.search_source_files"] {
        assert_eq!(
            index.admit_rollback(participant),
            Ok(&BTreeSet::from([
                Table(Projects),
                Table(SourceDocs),
                File(FileFamily::SourceWorkspace),
            ]))
        );
    }
    assert_eq!(
        index.admit_rollback("tool.list_sources"),
        Ok(&BTreeSet::from([
            Table(Projects),
            Table(SourceDocs),
            Table(AppSettings)
        ]))
    );
    assert_eq!(
        index.admit_rollback("tool.preview_source_naming"),
        Ok(&BTreeSet::from([Table(Projects), Table(AppSettings)]))
    );
    let no_writer = index.admit_rollback("job.sync").unwrap_err();
    assert_eq!(
        no_writer,
        AdmissionError::IncompatibleLiveFormat {
            operation: "source.sync".into(),
            format: "source-covers".into(),
            node_reads: 1,
            rust_writes: None,
        }
    );
    assert_eq!(
        no_writer.to_string(),
        "rollback of source.sync refused: no Rust writer for source-covers"
    );

    value["live_formats"]["source-revision-workspace"]["rust_writes"] = json!(2);
    for participant in ["tool.read_source_file", "tool.search_source_files"] {
        assert_eq!(
            admit(&value).unwrap().admit_rollback(participant),
            Err(AdmissionError::IncompatibleLiveFormat {
                operation: participant.into(),
                format: "source-revision-workspace".into(),
                node_reads: 1,
                rust_writes: Some(2),
            })
        );
    }
}

#[test]
fn malformed_live_format_declarations_fail_admission() {
    let malformed = |edit: &dyn Fn(&mut Value)| {
        let mut value = manifest();
        edit(&mut value);
        match admit(&value) {
            Err(AdmissionError::Malformed(detail)) => detail,
            other => panic!("expected malformed, got {other:?}"),
        }
    };
    let cases: [(Edit, &str); 8] = [
        (
            |v| {
                v.as_object_mut().unwrap().remove("live_formats");
            },
            "missing field `live_formats`",
        ),
        (
            |v| {
                v["live_formats"]
                    .as_object_mut()
                    .unwrap()
                    .remove("source-covers");
            },
            "missing field `source-covers`",
        ),
        (
            |v| v["live_formats"]["thumbnails"] = json!({"node_reads": 1, "rust_writes": 1}),
            "unknown field `thumbnails`",
        ),
        (
            |v| {
                v["live_formats"]["source-covers"]
                    .as_object_mut()
                    .unwrap()
                    .remove("rust_writes");
            },
            "missing field `rust_writes`",
        ),
        (
            |v| {
                v["live_formats"]["sqlite-schema"]
                    .as_object_mut()
                    .unwrap()
                    .remove("node_reads");
            },
            "missing field `node_reads`",
        ),
        (
            |v| v["live_formats"]["sqlite-schema"]["rollback"] = json!("compatible"),
            "unknown field `rollback`",
        ),
        (
            |v| v["live_formats"]["sqlite-schema"]["rust_writes"] = json!("35"),
            "invalid type",
        ),
        (
            |v| v["live_formats"]["source-covers"]["node_reads"] = json!(-1),
            "invalid value",
        ),
    ];
    for (edit, expected) in cases {
        let detail = malformed(&edit);
        assert!(detail.contains(expected), "{expected}: {detail}");
    }
    for (format, field) in [
        ("sqlite-schema", "node_reads"),
        ("source-covers", "rust_writes"),
    ] {
        assert_eq!(
            malformed(&|v| v["live_formats"][format][field] = json!(0)),
            format!("live format {format} has version 0")
        );
    }
}

#[test]
fn workspace_format_must_match_the_source_sync_record() {
    let duplicate = include_str!("../ownership-manifest.json").replacen(
        "\"live_formats\": {",
        "\"live_formats\": {\n    \"source-covers\": {\"node_reads\": 1, \"rust_writes\": null},",
        1,
    );
    assert!(matches!(
        admit_manifest_documents(
            &duplicate,
            include_str!("../operations.json"),
            include_str!("../../../../web/apps/server/src/data/source-sync-ownership.json"),
        ),
        Err(AdmissionError::Malformed(detail)) if detail.contains("duplicate field `source-covers`")
    ));
    let mut value = manifest();
    value["live_formats"]["source-revision-workspace"]["node_reads"] = json!(2);
    assert_eq!(
        admit(&value).unwrap_err(),
        AdmissionError::UnknownLiveFormat {
            value: "source-revision-workspace-v2".into()
        }
    );
}
