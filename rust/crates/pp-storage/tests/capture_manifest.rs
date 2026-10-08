use pp_storage::uploads::inspect_capture_manifest;

#[test]
fn capture_manifest_public_inspection_rejects_malformed_bytes() {
    assert!(inspect_capture_manifest(br#"{}"#).is_err());
}

fn manifest_fixture() -> std::path::PathBuf {
    manifest_fixture_with_metadata(&[])
}

fn manifest_fixture_with_metadata(overrides: &[(&str, &str, &[u8])]) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("pp-u15-manifest-{:016x}", rand::random::<u64>()));
    let (owner, ready) =
        pp_storage::WriterOwner::open(&path, pp_storage::Limits::default()).unwrap();
    assert_eq!(ready.version, 41);
    owner.shutdown().unwrap();
    let conn = rusqlite::Connection::open(path.join("print-partner.db")).unwrap();
    conn.execute_batch("INSERT INTO build_profiles(id,name) VALUES(1,'U15 owned fixture');
        INSERT INTO plan_revisions(id,profile_id,revision_number,provenance_kind,digest_format,snapshot_digest,created_by,accepted_by,created_at,accepted_at)
        VALUES(1,1,1,'legacy','legacy-v1','fixture','fixture','fixture','2026-10-08','2026-10-08');
        INSERT INTO plan_drafts(id,profile_id,base_plan_version,state,digest_format,snapshot_digest,created_by,idempotency_key,created_at)
        VALUES(1,1,0,'open','plan-draft-v1','fixture','fixture','fixture','2026-10-08');
        ").unwrap();
    for (table, owner_column, key_column) in [
        ("parts", "profile_id", "match_key"),
        ("plan_revision_parts", "revision_id", "part_key"),
        ("plan_draft_parts", "draft_id", "part_key"),
    ] {
        let value = |column: &str, scalar: &str| {
            overrides
                .iter()
                .find(|(target_table, target_column, _)| {
                    *target_table == table && *target_column == column
                })
                .map_or_else(
                    || rusqlite::types::Value::Text(scalar.into()),
                    |(_, _, bytes)| rusqlite::types::Value::Blob(bytes.to_vec()),
                )
        };
        conn.execute(
            &format!("INSERT INTO {table}({owner_column},{key_column},requirement,option_group_id,notes) VALUES(1,'part.stl',?1,?2,?3)"),
            rusqlite::params![value("requirement", "literal PPJS text"), value("option_group_id", "toolhead"), value("notes", "")],
        ).unwrap();
    }
    path
}

fn manifest_rows(path: &std::path::Path) -> Vec<(String, String)> {
    let conn = rusqlite::Connection::open(path.join("print-partner.db")).unwrap();
    ["parts", "plan_revision_parts", "plan_draft_parts"]
        .into_iter()
        .map(|table| {
            conn.query_row(
                &format!(
                    "SELECT quote(requirement),quote(option_group_id) FROM {table} WHERE id=1"
                ),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
        })
        .collect()
}

#[test]
fn manifest_generation41_preserves_six_scalar_columns_and_reopens_canonical_blobs() {
    let path = manifest_fixture();
    let before = manifest_rows(&path);
    std::fs::rename(
        path.join("backups/pre-schema41.db"),
        path.join("backups/fresh-generation40-fixture.db"),
    )
    .unwrap();
    {
        let conn = rusqlite::Connection::open(path.join("print-partner.db")).unwrap();
        conn.execute(
            "UPDATE app_settings SET value='40' WHERE tenant_id='default' AND key='schema_version'",
            [],
        )
        .unwrap();
    }
    let (owner, ready) =
        pp_storage::WriterOwner::open(&path, pp_storage::Limits::default()).unwrap();
    assert_eq!((ready.previous_version, ready.version), (40, 41));
    owner.shutdown().unwrap();
    assert_eq!(manifest_rows(&path), before);
    let backup = rusqlite::Connection::open(path.join("backups/pre-schema41.db")).unwrap();
    let version: String = backup
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, "40");
    drop(backup);
    let canonical_requirement = b"PPJS\x01\0\0\0\x01\xd8\0".as_slice();
    let canonical_group = b"PPJS\x01\0\0\0\x01\xdc\0".as_slice();
    let canonical_path = manifest_fixture_with_metadata(&[
        ("parts", "requirement", canonical_requirement),
        ("parts", "option_group_id", canonical_group),
        ("plan_revision_parts", "requirement", canonical_requirement),
        ("plan_revision_parts", "option_group_id", canonical_group),
        ("plan_draft_parts", "requirement", canonical_requirement),
        ("plan_draft_parts", "option_group_id", canonical_group),
    ]);
    let blobs = manifest_rows(&canonical_path);
    assert_eq!(
        blobs,
        vec![
            (
                "X'50504A530100000001D800'".into(),
                "X'50504A530100000001DC00'".into()
            );
            3
        ]
    );
    let (owner, ready) =
        pp_storage::WriterOwner::open(&canonical_path, pp_storage::Limits::default()).unwrap();
    assert_eq!(ready.previous_version, 41);
    owner.shutdown().unwrap();
    assert_eq!(manifest_rows(&canonical_path), blobs);
    println!(
        "{}",
        serde_json::json!({"case":"manifest41_six_columns","scalar_before":before,"blobs_after_reopen":blobs})
    );
}

#[test]
fn manifest_generation_refuses_pre41_blobs_malformed41_other_column_blobs_and42() {
    for table in ["parts", "plan_revision_parts", "plan_draft_parts"] {
        for column in ["requirement", "option_group_id"] {
            for (generation, bytes) in [
                (40, b"PPJS\x01\0\0\0\x01\xd8\0".as_slice()),
                (41, b"malformed".as_slice()),
            ] {
                let path = manifest_fixture_with_metadata(&[(table, column, bytes)]);
                {
                    let conn = rusqlite::Connection::open(path.join("print-partner.db")).unwrap();
                    conn.execute("UPDATE app_settings SET value=?1 WHERE tenant_id='default' AND key='schema_version'", [generation.to_string()]).unwrap();
                }
                let before = manifest_rows(&path);
                let error =
                    match pp_storage::WriterOwner::open(&path, pp_storage::Limits::default()) {
                        Ok(_) => panic!("invalid manifest row admitted"),
                        Err(error) => error.to_string(),
                    };
                assert!(
                    error.contains(if generation == 40 {
                        "Pre41 manifest metadata"
                    } else {
                        "Invalid PPJS manifest text header"
                    }),
                    "{error}"
                );
                assert_eq!(manifest_rows(&path), before);
                println!(
                    "{}",
                    serde_json::json!({"case":"manifest_refusal","generation":generation,"table":table,"column":column,"error":error})
                );
            }
        }
        let path = manifest_fixture_with_metadata(&[(table, "notes", b"generic BLOB")]);
        assert!(
            pp_storage::WriterOwner::open(&path, pp_storage::Limits::default())
                .err()
                .unwrap()
                .to_string()
                .contains("BLOB is not admitted")
        );
    }
    let path = manifest_fixture();
    {
        let conn = rusqlite::Connection::open(path.join("print-partner.db")).unwrap();
        conn.execute(
            "UPDATE app_settings SET value='42' WHERE tenant_id='default' AND key='schema_version'",
            [],
        )
        .unwrap();
    }
    assert!(
        pp_storage::WriterOwner::open(&path, pp_storage::Limits::default())
            .err()
            .unwrap()
            .to_string()
            .contains("newer than supported version 41")
    );
}
