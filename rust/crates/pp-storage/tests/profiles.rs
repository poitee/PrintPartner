#![cfg(feature = "desktop_rebuild")]

use pp_storage::profiles::{
    FilamentImportInput, ImportProvenance, ImportShapeError, JsInteger, JsText, PrinterImportInput,
    ProcessImportInput, ProfileImport, ProfileKind, RawFilamentSource, SlicerKind,
};

fn provenance() -> ImportProvenance {
    ImportProvenance {
        name: JsText::from_string("Example"),
        slicer_version: Some(JsText::from_string("2.3")),
        resolved_flat_config: JsText::from_string(r#"{"name":"Example"}"#),
        source_path: JsText::from_string("example.json"),
    }
}

#[test]
fn utf16_json_preserves_lone_surrogates_and_encodes_pairs() {
    let text = JsText::from_utf16(vec![
        0x22, 0x5c, 8, 9, 10, 12, 13, 0, 31, 0xd800, 65, 0xdc00, 0xd83d, 0xde00,
    ]);
    let expected = "\"\\\"\\\\\\b\\t\\n\\f\\r\\u0000\\u001f\\ud800A\\udc00😀\"";
    assert_eq!(text.to_node_json_string(), expected);
    assert_eq!(serde_json::to_string(&text).unwrap(), expected);
    assert_eq!(text.as_utf16()[9], 0xd800);
    assert_eq!(JsText::from_string("😀").as_utf16(), &[0xd83d, 0xde00]);
    assert_eq!(JsText::from_utf16(vec![0xd800]).to_string_lossy(), "�");
    assert_eq!(
        JsText::from_utf16(vec![0xd800, 0xd800, 0xdc00, 0xdc00]).to_node_json_string(),
        r#""\ud800𐀀\udc00""#
    );
    assert_eq!(
        JsText::from_utf16(vec![0xdc00, 0xd800]).to_node_json_string(),
        r#""\udc00\ud800""#
    );
}

#[test]
fn integers_reject_non_integral_numbers_and_normalize_negative_zero() {
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 1.5] {
        assert_eq!(
            JsInteger::new(value),
            Err(ImportShapeError::NonIntegralNumber)
        );
    }
    assert_eq!(
        JsInteger::new(-0.0).unwrap().value().to_bits(),
        0.0_f64.to_bits()
    );
    assert_eq!(JsInteger::new(-42.0).unwrap().value(), -42.0);
    assert_eq!(
        serde_json::to_string(&JsInteger::new(42.0).unwrap()).unwrap(),
        "42.0"
    );
}

#[test]
fn profile_variants_serialize_the_interpreter_return_contract() {
    let printer = ProfileImport::printer(PrinterImportInput {
        provenance: provenance(),
        slicer_format: SlicerKind::Orca,
        nozzle_diameter_mm: Some(JsText::from_string("0.4")),
        extruder_count: Some(JsInteger::new(1.0).unwrap()),
        raw_json: Some(JsText::from_utf16(vec![0xd800])),
    })
    .unwrap();
    assert_eq!(printer.kind(), ProfileKind::Printer);
    assert_eq!(
        serde_json::to_string(&printer).unwrap(),
        r#"{"kind":"printer","provenance":{"name":"Example","slicer_version":"2.3","resolved_flat_config":"{\"name\":\"Example\"}","source_path":"example.json"},"slicer_format":"orca","nozzle_diameter_mm":"0.4","extruder_count":1.0,"raw_json":"\ud800"}"#
    );
    let process = ProfileImport::process(ProcessImportInput {
        provenance: provenance(),
        slicer_format: SlicerKind::Prusa,
        compatible_printers: Some(JsText::from_string("Example")),
    })
    .unwrap();
    assert_eq!(process.kind(), ProfileKind::Process);
    assert_eq!(
        serde_json::to_value(&process).unwrap(),
        serde_json::json!({
            "kind": "process", "provenance": {
                "name": "Example", "slicer_version": "2.3",
                "resolved_flat_config": "{\"name\":\"Example\"}", "source_path": "example.json"
            }, "slicer_format": "prusa", "compatible_printers": "Example"
        })
    );
    let filament = ProfileImport::filament(FilamentImportInput {
        provenance: provenance(),
        material_type: JsText::from_string("PLA"),
        nozzle_temp_c: Some(JsInteger::new(210.0).unwrap()),
        bed_temp_c: None,
        fan_pct: None,
        extrusion_multiplier: None,
        pressure_advance: None,
        retraction: None,
        raw: RawFilamentSource::Ini(JsText::from_string("name=Example")),
    })
    .unwrap();
    assert_eq!(filament.kind(), ProfileKind::Filament);
    assert_eq!(
        serde_json::to_value(&filament).unwrap(),
        serde_json::json!({
            "kind": "filament", "provenance": {
                "name": "Example", "slicer_version": "2.3",
                "resolved_flat_config": "{\"name\":\"Example\"}", "source_path": "example.json"
            }, "material_type": "PLA", "nozzle_temp_c": 210.0, "bed_temp_c": null,
            "fan_pct": null, "extrusion_multiplier": null, "pressure_advance": null,
            "retraction": null, "raw": {"format": "ini", "value": "name=Example"}
        })
    );
    assert_eq!(
        serde_json::to_value(RawFilamentSource::Json(JsText::from_string("{}"))).unwrap(),
        serde_json::json!({"format": "json", "value": "{}"})
    );
    assert_eq!(
        serde_json::to_string(&SlicerKind::Bambu).unwrap(),
        "\"bambu\""
    );
}

#[test]
fn constructors_reject_invalid_provenance_for_every_profile_kind() {
    for (field, expected) in [
        (0, ImportShapeError::EmptyName),
        (1, ImportShapeError::EmptySourcePath),
        (2, ImportShapeError::InvalidResolvedJson),
        (3, ImportShapeError::InvalidResolvedJson),
    ] {
        let mut value = provenance();
        match field {
            0 => value.name = JsText::from_string(""),
            1 => value.source_path = JsText::from_string(""),
            2 => value.resolved_flat_config = JsText::from_string("not json"),
            3 => value.resolved_flat_config = JsText::from_utf16(vec![0xd800]),
            _ => unreachable!(),
        }
        assert_eq!(
            ProfileImport::printer(PrinterImportInput {
                provenance: value.clone(),
                slicer_format: SlicerKind::Orca,
                nozzle_diameter_mm: None,
                extruder_count: None,
                raw_json: None,
            })
            .unwrap_err(),
            expected
        );
        assert_eq!(
            ProfileImport::process(ProcessImportInput {
                provenance: value.clone(),
                slicer_format: SlicerKind::Prusa,
                compatible_printers: None,
            })
            .unwrap_err(),
            expected
        );
        assert_eq!(
            ProfileImport::filament(FilamentImportInput {
                provenance: value,
                material_type: JsText::from_string("PLA"),
                nozzle_temp_c: None,
                bed_temp_c: None,
                fan_pct: None,
                extrusion_multiplier: None,
                pressure_advance: None,
                retraction: None,
                raw: RawFilamentSource::Json(JsText::from_string("{}")),
            })
            .unwrap_err(),
            expected
        );
    }
}
