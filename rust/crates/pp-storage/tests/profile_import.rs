use pp_storage::{
    Limits, WriterOwner,
    profiles::{
        FilamentImportInput, ImportProvenance, JsInteger, JsText, PrinterImportInput,
        ProcessImportInput, ProfileImport, ProfileKind, ProfileLibraryRequest, RawFilamentSource,
        SlicerKind,
    },
};
use rusqlite::{Connection, params};
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};

const BOUND_NAME: &str = "Binding lone � and astral 😀";
const RESOLVED_INITIAL: &str = r#"{"lone":"\ud800","low":"\udc00","pair":"😀","ordinary":"value"}"#;
const RESOLVED_UPDATED: &str = r#"{"lone":"\udc00","pair":"😀","update":"second"}"#;

fn text(value: &str) -> JsText {
    JsText::from_string(value)
}

fn bound_name() -> JsText {
    JsText::from_utf16(vec![
        66, 105, 110, 100, 105, 110, 103, 32, 108, 111, 110, 101, 32, 0xd800, 32, 97, 110, 100, 32,
        97, 115, 116, 114, 97, 108, 32, 0xd83d, 0xde00,
    ])
}

fn provenance(initial: bool) -> ImportProvenance {
    ImportProvenance {
        name: bound_name(),
        slicer_version: Some(if initial {
            JsText::from_utf16("version-".encode_utf16().chain([0xd800]).collect())
        } else {
            text("updated-😀")
        }),
        resolved_flat_config: text(if initial {
            RESOLVED_INITIAL
        } else {
            RESOLVED_UPDATED
        }),
        source_path: if initial {
            JsText::from_utf16(
                "/owned/source/initial-"
                    .encode_utf16()
                    .chain([0xd800])
                    .chain("-😀.json".encode_utf16())
                    .collect(),
            )
        } else {
            JsText::from_utf16(
                "/owned/source/updated-"
                    .encode_utf16()
                    .chain([0xdc00])
                    .chain("-😀.ini".encode_utf16())
                    .collect(),
            )
        },
    }
}

fn process(initial: bool) -> ProfileImport {
    let mut process_provenance = provenance(initial);
    if initial {
        process_provenance.slicer_version = None;
    }
    ProfileImport::process(ProcessImportInput {
        provenance: process_provenance,
        slicer_format: if initial {
            SlicerKind::Prusa
        } else {
            SlicerKind::Bambu
        },
        compatible_printers: initial.then(|| {
            JsText::from_utf16(
                "compatible-"
                    .encode_utf16()
                    .chain([0xd800])
                    .chain("-😀".encode_utf16())
                    .collect(),
            )
        }),
    })
    .unwrap()
}

fn connection(root: &Path) -> Connection {
    Connection::open(root.join("print-partner.db")).unwrap()
}

fn now_text() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

fn stored_timestamp_extrema(db: &Connection) -> (String, String, String, String) {
    db.query_row(
        "SELECT min(imported_at),max(imported_at),min(last_synced_at),max(last_synced_at) FROM (SELECT imported_at,last_synced_at FROM printer_profiles WHERE tenant_id='default' AND name=?1 UNION ALL SELECT imported_at,last_synced_at FROM process_profiles WHERE tenant_id='default' AND name=?1 UNION ALL SELECT imported_at,last_synced_at FROM filament_profiles WHERE tenant_id='default' AND name=?1)",
        [BOUND_NAME],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .unwrap()
}

#[test]
fn local_importer_persists_node_values_updates_and_generation_boundaries() {
    let root = std::env::temp_dir().join(format!("pp-profile-import-{}", rand::random::<u64>()));
    std::fs::create_dir_all(&root).unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    owner.shutdown().unwrap();

    let db = connection(&root);
    db.execute(
        "INSERT INTO process_profiles (tenant_id,name,slicer_format,compatible_printers,resolved_flat_config,imported_at,source_path,synced_from_slicer_version,last_synced_at) VALUES ('foreign',?1,'orca','foreign-printer','{\"foreign\":true}','2000-01-01T00:00:00.000Z','/foreign','foreign-version','2000-01-01T00:00:00.000Z')",
        params![BOUND_NAME],
    )
    .unwrap();
    drop(db);

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let importer = owner.local_profile_importer();
    assert!(matches!(
        importer.import(process(true), &AtomicBool::new(true), Duration::ZERO),
        Err(pp_storage::profiles::ProfileImportFailure::CancelledBeforeAdmission)
    ));
    assert_eq!(
        connection(&root)
            .query_row(
                "SELECT count(*) FROM process_profiles WHERE tenant_id='default' AND name=?1",
                [BOUND_NAME],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    let cancelled = AtomicBool::new(false);
    let initial_before = now_text();
    let printer = ProfileImport::printer(PrinterImportInput {
        provenance: provenance(true),
        slicer_format: SlicerKind::Orca,
        nozzle_diameter_mm: None,
        extruder_count: None,
        raw_json: Some(text(
            r#"{"name":"Binding lone \uD800 and astral \uD83D\uDE00","kind":"printer"}"#,
        )),
    })
    .unwrap();
    let filament = ProfileImport::filament(FilamentImportInput {
        provenance: provenance(true),
        material_type: JsText::from_utf16(
            "PLA-"
                .encode_utf16()
                .chain([0xdc00])
                .chain("-😀".encode_utf16())
                .collect(),
        ),
        nozzle_temp_c: None,
        bed_temp_c: None,
        fan_pct: None,
        extrusion_multiplier: None,
        pressure_advance: None,
        retraction: None,
        raw: RawFilamentSource::Ini(text(
            "name = Binding lone \\uD800 and astral 😀\nmaterial = PLA\\uDC00\n",
        )),
    })
    .unwrap();
    let printer_id = *importer
        .import(printer, &cancelled, Duration::from_secs(1))
        .unwrap()
        .identity();
    let process_id = *importer
        .import(process(true), &cancelled, Duration::from_secs(1))
        .unwrap()
        .identity();
    let filament_id = *importer
        .import(filament, &cancelled, Duration::from_secs(1))
        .unwrap()
        .identity();
    let initial_after = now_text();
    assert_eq!(printer_id.kind(), ProfileKind::Printer);
    assert_eq!(process_id.kind(), ProfileKind::Process);
    assert_eq!(filament_id.kind(), ProfileKind::Filament);

    let db = connection(&root);
    let initial_printer: (i64, String, String, i64, String, String, String, String) = db
        .query_row(
            "SELECT id,name,typeof(extruder_count),extruder_count,raw_json,resolved_flat_config,imported_at,last_synced_at FROM printer_profiles WHERE tenant_id='default' AND name=?1",
            [BOUND_NAME],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
        )
        .unwrap();
    assert_eq!(initial_printer.0, printer_id.id());
    assert_eq!(initial_printer.1, BOUND_NAME);
    assert_eq!(
        (initial_printer.2.as_str(), initial_printer.3),
        ("integer", 1)
    );
    assert_eq!(
        initial_printer.4,
        r#"{"name":"Binding lone \uD800 and astral \uD83D\uDE00","kind":"printer"}"#
    );
    assert_eq!(initial_printer.5, RESOLVED_INITIAL);
    assert_eq!(initial_printer.6, initial_printer.7);
    let initial_imported_at = initial_printer.6;
    let initial_process: (String, String, String, String, String) = db
        .query_row(
            "SELECT compatible_printers,typeof(synced_from_slicer_version),resolved_flat_config,source_path,slicer_format FROM process_profiles WHERE tenant_id='default' AND name=?1",
            [BOUND_NAME],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();
    assert_eq!(
        initial_process,
        (
            "compatible-�-😀".into(),
            "null".into(),
            RESOLVED_INITIAL.into(),
            "/owned/source/initial-�-😀.json".into(),
            "prusa".into()
        )
    );
    let initial_filament: (String, i64, String, String, String, String, String, String, String) = db
        .query_row(
            "SELECT material_type,material_tier,typeof(nozzle_temp_c),typeof(bed_temp_c),typeof(fan_pct),typeof(raw_json),typeof(raw_ini),raw_ini,resolved_flat_config FROM filament_profiles WHERE tenant_id='default' AND name=?1",
            [BOUND_NAME],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?)),
        )
        .unwrap();
    assert_eq!(
        (initial_filament.0.as_str(), initial_filament.1),
        ("PLA-�-😀", 1)
    );
    assert_eq!(
        (
            initial_filament.2.as_str(),
            initial_filament.3.as_str(),
            initial_filament.4.as_str()
        ),
        ("null", "null", "null")
    );
    assert_eq!(
        (initial_filament.5.as_str(), initial_filament.6.as_str()),
        ("null", "text")
    );
    assert_eq!(
        initial_filament.7,
        "name = Binding lone \\uD800 and astral 😀\nmaterial = PLA\\uDC00\n"
    );
    assert_eq!(initial_filament.8, RESOLVED_INITIAL);
    let initial_other_imported: (String, String) = db
        .query_row(
            "SELECT (SELECT imported_at FROM process_profiles WHERE tenant_id='default' AND name=?1),(SELECT imported_at FROM filament_profiles WHERE tenant_id='default' AND name=?1)",
            [BOUND_NAME],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let initial_times = stored_timestamp_extrema(&db);
    assert!(initial_before <= initial_times.0);
    assert!(initial_times.1 <= initial_after);
    assert_eq!(initial_times.0, initial_times.2);
    assert_eq!(initial_times.1, initial_times.3);
    drop(db);

    std::thread::sleep(Duration::from_millis(2));
    let update_before = now_text();
    let updated_printer = ProfileImport::printer(PrinterImportInput {
        provenance: provenance(false),
        slicer_format: SlicerKind::Bambu,
        nozzle_diameter_mm: Some(text("1e+308")),
        extruder_count: Some(JsInteger::new(9_007_199_254_740_992.0).unwrap()),
        raw_json: Some(text(
            r#"{"name":"Binding lone \uD800 and astral \uD83D\uDE00","kind":"printer","updated":true}"#,
        )),
    })
    .unwrap();
    let updated_filament = ProfileImport::filament(FilamentImportInput {
        provenance: ImportProvenance {
            slicer_version: None,
            ..provenance(false)
        },
        material_type: JsText::from_utf16(
            "PETG-"
                .encode_utf16()
                .chain([0xd800])
                .chain("-😀".encode_utf16())
                .collect(),
        ),
        nozzle_temp_c: Some(JsInteger::new(1e308).unwrap()),
        bed_temp_c: Some(JsInteger::new(9_007_199_254_740_992.0).unwrap()),
        fan_pct: Some(JsInteger::new(-0.0).unwrap()),
        extrusion_multiplier: Some(text("1e+308")),
        pressure_advance: None,
        retraction: Some(text("0")),
        raw: RawFilamentSource::Json(text(
            r#"{"name":"Binding lone \uD800 and astral \uD83D\uDE00","kind":"filament","updated":true}"#,
        )),
    })
    .unwrap();
    assert_eq!(
        importer
            .import(updated_printer, &cancelled, Duration::from_secs(1))
            .unwrap()
            .identity(),
        &printer_id
    );
    assert_eq!(
        importer
            .import(process(false), &cancelled, Duration::from_secs(1))
            .unwrap()
            .identity(),
        &process_id
    );
    assert_eq!(
        importer
            .import(updated_filament, &cancelled, Duration::from_secs(1))
            .unwrap()
            .identity(),
        &filament_id
    );
    let update_after = now_text();
    let stale = owner.local_profile_importer();
    owner.shutdown().unwrap();

    let db = connection(&root);
    let updated_printer: (i64, String, i64, String, String, String, String, String, String) = db
        .query_row(
            "SELECT id,typeof(extruder_count),extruder_count,slicer_format,source_path,resolved_flat_config,imported_at,last_synced_at,raw_json FROM printer_profiles WHERE tenant_id='default' AND name=?1",
            [BOUND_NAME],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?)),
        )
        .unwrap();
    assert_eq!(updated_printer.0, printer_id.id());
    assert_eq!(
        (updated_printer.1.as_str(), updated_printer.2),
        ("integer", 9_007_199_254_740_992)
    );
    assert_eq!(updated_printer.3, "bambu");
    assert_eq!(updated_printer.4, "/owned/source/updated-�-😀.ini");
    assert_eq!(updated_printer.5, RESOLVED_UPDATED);
    assert_eq!(updated_printer.6, initial_imported_at);
    assert!(updated_printer.7 > updated_printer.6);
    assert!(updated_printer.8.contains("\\uD800"));
    let updated_printer_provenance: (String, String, String) = db
        .query_row(
            "SELECT slicer_version_at_import,nozzle_diameter_mm,synced_from_slicer_version FROM printer_profiles WHERE tenant_id='default' AND name=?1",
            [BOUND_NAME],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        updated_printer_provenance,
        ("updated-😀".into(), "1e+308".into(), "updated-😀".into())
    );
    let updated_process: (String, Option<String>, String, String, Option<String>) = db
        .query_row(
            "SELECT slicer_format,compatible_printers,resolved_flat_config,source_path,synced_from_slicer_version FROM process_profiles WHERE tenant_id='default' AND name=?1",
            [BOUND_NAME],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();
    assert_eq!(
        updated_process,
        (
            "bambu".into(),
            None,
            RESOLVED_UPDATED.into(),
            "/owned/source/updated-�-😀.ini".into(),
            Some("updated-😀".into())
        )
    );
    let updated_filament: (String, f64, String, i64, String, Option<String>, String, Option<String>) = db
        .query_row(
            "SELECT typeof(nozzle_temp_c),nozzle_temp_c,typeof(bed_temp_c),bed_temp_c,typeof(raw_json),raw_ini,raw_json,synced_from_slicer_version FROM filament_profiles WHERE tenant_id='default' AND name=?1",
            [BOUND_NAME],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
        )
        .unwrap();
    assert_eq!(
        (updated_filament.0.as_str(), updated_filament.1),
        ("real", 1e308)
    );
    assert_eq!(
        (updated_filament.2.as_str(), updated_filament.3),
        ("integer", 9_007_199_254_740_992)
    );
    assert_eq!(updated_filament.4, "text");
    assert_eq!(updated_filament.5, None);
    assert!(updated_filament.6.contains("updated"));
    assert_eq!(updated_filament.7, None);
    let updated_filament_values: (String, i64, i64, String, Option<String>, String, String, String) = db
        .query_row(
            "SELECT material_type,material_tier,fan_pct,extrusion_multiplier,pressure_advance,retraction,resolved_flat_config,source_path FROM filament_profiles WHERE tenant_id='default' AND name=?1",
            [BOUND_NAME],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
        )
        .unwrap();
    assert_eq!(
        updated_filament_values,
        (
            "PETG-�-😀".into(),
            1,
            0,
            "1e+308".into(),
            None,
            "0".into(),
            RESOLVED_UPDATED.into(),
            "/owned/source/updated-�-😀.ini".into()
        )
    );
    let updated_times = stored_timestamp_extrema(&db);
    assert_eq!(updated_times.0, initial_times.0);
    assert_eq!(updated_times.1, initial_times.1);
    assert!(update_before <= updated_times.2);
    assert!(updated_times.3 <= update_after);
    let updated_other_imported: (String, String) = db
        .query_row(
            "SELECT (SELECT imported_at FROM process_profiles WHERE tenant_id='default' AND name=?1),(SELECT imported_at FROM filament_profiles WHERE tenant_id='default' AND name=?1)",
            [BOUND_NAME],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(updated_other_imported, initial_other_imported);
    let foreign: (String, String, String, String) = db
        .query_row(
            "SELECT compatible_printers,resolved_flat_config,source_path,last_synced_at FROM process_profiles WHERE tenant_id='foreign' AND name=?1",
            [BOUND_NAME],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        foreign,
        (
            "foreign-printer".into(),
            "{\"foreign\":true}".into(),
            "/foreign".into(),
            "2000-01-01T00:00:00.000Z".into()
        )
    );
    let process_last_synced: String = db
        .query_row(
            "SELECT last_synced_at FROM process_profiles WHERE tenant_id='default' AND name=?1",
            [BOUND_NAME],
            |row| row.get(0),
        )
        .unwrap();
    drop(db);

    let (reopened, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert!(matches!(
        stale.import(process(false), &AtomicBool::new(false), Duration::ZERO),
        Err(pp_storage::profiles::ProfileImportFailure::Stopped)
    ));
    assert_eq!(
        connection(&root)
            .query_row(
                "SELECT last_synced_at FROM process_profiles WHERE tenant_id='default' AND name=?1",
                [BOUND_NAME],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        process_last_synced
    );
    let new_generation = reopened
        .local_profile_importer()
        .import(
            ProfileImport::process(ProcessImportInput {
                provenance: ImportProvenance {
                    name: text("New generation"),
                    slicer_version: None,
                    resolved_flat_config: text("{}"),
                    source_path: text("/new-generation"),
                },
                slicer_format: SlicerKind::Orca,
                compatible_printers: None,
            })
            .unwrap(),
            &cancelled,
            Duration::from_secs(1),
        )
        .unwrap();
    assert_eq!(new_generation.identity().kind(), ProfileKind::Process);
    let library = reopened
        .local_profile_library()
        .read(ProfileLibraryRequest, &cancelled, Duration::from_secs(1))
        .unwrap();
    let library = serde_json::to_value(library).unwrap();
    let profiles = library["profiles"].as_array().unwrap();
    assert_eq!(
        profiles
            .iter()
            .filter(|row| row["name"] == BOUND_NAME)
            .count(),
        3
    );
    assert!(profiles.iter().any(|row| row["name"] == "New generation"));
    assert!(
        profiles
            .iter()
            .any(|row| row["kind"] == "printer" && row["id"] == printer_id.id())
    );
    assert!(
        profiles
            .iter()
            .any(|row| row["kind"] == "process" && row["id"] == process_id.id())
    );
    assert!(
        profiles
            .iter()
            .any(|row| row["kind"] == "filament" && row["id"] == filament_id.id())
    );
    reopened.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
