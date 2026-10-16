#![cfg(feature = "desktop_rebuild")]
//! Replays the Node job result golden in `fixtures/parity/jobs-model`.
//! Regenerate it with `node fixtures/parity/jobs-model/generate.mjs`.
use pp_storage::jobs::{CompletedResult, JobKind};

#[test]
fn node_job_results_decode_to_their_kind_and_encode_identically() {
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/jobs-model/jobs-model.json"
    ))
    .unwrap();
    let cases = golden["results"].as_array().unwrap();
    assert_eq!(cases.len(), 3);
    for case in cases {
        let decoded: CompletedResult = serde_json::from_value(case["node"].clone()).unwrap();
        let kind: JobKind = serde_json::from_value(case["kind"].clone()).unwrap();
        assert_eq!(decoded.kind(), kind, "{}", case["id"]);
        assert_eq!(
            serde_json::to_string(&decoded).unwrap(),
            serde_json::to_string(&case["node"]).unwrap(),
            "{}",
            case["id"]
        );
    }
}

/// Node builds these results inside `InProcessJobRunner` (`job-runner.ts`) and
/// the helpers it spreads in, so the literals follow that source's key order.
/// `JSON.stringify` drops `undefined` optional fields.
#[test]
fn runner_result_literals_decode_to_their_kind_and_encode_identically() {
    let scan = r#"{"stl_count":12,"downloaded":3,"doc_count":2,"docs_downloaded":1,"pdf_extract_job_id":"job-pdf"}"#;
    let cases = [
        // runSync over syncProjectById (routes/sources.ts)
        (
            JobKind::Sync,
            r#"{"synced":1,"failed":1,"results":[{"project_id":4,"stl_count":12,"downloaded":3,"doc_count":2,"docs_downloaded":1,"postprocess_warning":"Cover failed"}],"failures":[{"project_id":5,"name":null,"error":"Repository not found"}]}"#,
        ),
        (JobKind::ImportScan, scan),
        // runExtractSourceDocs over extractPendingPdfsForSource (source-docs-index.ts)
        (
            JobKind::ExtractSourceDocs,
            r#"{"project_id":4,"extracted":2,"errors":1}"#,
        ),
        // checkAllSourceUpdates (source-update-check.ts)
        (
            JobKind::CheckSourceUpdates,
            r#"{"checked":[{"source_id":4,"name":"Voron","update_status":"updates_available"}],"skipped":[{"source_id":5,"name":"Local","reason":"not_git"}],"updates_available":1,"checked_count":1}"#,
        ),
        (
            JobKind::ExportStlPack,
            r#"{"root_path":"stl-pack/build-7","download_url":"/exports/stl-pack.zip","file_counts":{"Black":2,"Red":1},"zip_counts":{"Black":2,"Red":1},"warnings":[],"missing_only":false,"file_total":3,"plan_version":11,"revision_id":13}"#,
        ),
        (
            JobKind::ExportChecklistHtml,
            r#"{"path":"checklists/7/build.html","download_url":null,"part_count":0,"thumb_count":0}"#,
        ),
        (
            JobKind::ExportKitBundle,
            r#"{"path":"kits/7/build.zip","download_url":"/exports/kit.zip","profile_id":7,"plan_version":11,"revision_id":13}"#,
        ),
        // runPrinterUploadJob (printer-upload-job.ts)
        (
            JobKind::PrinterUpload,
            r#"{"printer_id":"voron","printer_name":"Voron","integration_id":"moonraker-1","integration_type":"moonraker","host_name":"Voron","filename":"plate.gcode","remote_path":"plate.gcode","started":false,"checkoff_units":0}"#,
        ),
    ];
    for (kind, literal) in cases {
        let decoded: CompletedResult = serde_json::from_str(literal).unwrap();
        assert_eq!(decoded.kind(), kind, "{literal}");
        assert_eq!(serde_json::to_string(&decoded).unwrap(), literal);
    }
}
