use super::*;
use rusqlite::{Connection, params};
use serde_json::json;
use std::cmp::Ordering;

#[test]
fn json_preserves_lone_and_paired_surrogates() {
    let text = JsText::from_units(vec![0xd800, 0x61, 0xdc00, 0xd83d, 0xde00]);
    let mut output = Vec::new();
    text.write_json(&mut output);
    assert_eq!(output, "\"\\ud800a\\udc00😀\"".as_bytes());
}

fn json_bytes(text: &JsText) -> Vec<u8> {
    let mut output = Vec::new();
    text.write_json(&mut output);
    output
}

#[test]
fn json_escapes_every_control_and_preserves_scalar_bytes() {
    let controls = JsText::from_units((0..=0x1f).collect());
    assert_eq!(
        json_bytes(&controls),
        br#""\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\b\t\n\u000b\f\r\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f""#
    );
    assert_eq!(
        json_bytes(&JsText::scalar("\"\\/é😀\u{2028}\u{2029}\u{e000}")),
        "\"\\\"\\\\/é😀\u{2028}\u{2029}\u{e000}\"".as_bytes()
    );
    assert_eq!(json_bytes(&JsText::scalar("")), b"\"\"");
}

#[test]
fn json_escapes_adjacent_unpaired_surrogates_in_lowercase() {
    assert_eq!(
        json_bytes(&JsText::from_units(vec![0xdbff, 0xd800, 0xdfff, 0xdc00])),
        "\"\\udbff𐏿\\udc00\"".as_bytes()
    );
    assert_eq!(
        json_bytes(&JsText::from_units(vec![0xd800, 0xdc00, 0xdbff, 0xdfff])),
        "\"𐀀\u{10ffff}\"".as_bytes()
    );
}

#[test]
fn scalar_access_and_identifier_labels_preserve_units() {
    let text = JsText::from_units(vec![0x5f, 0xd800, 0x5f, 0x61]);
    assert_eq!(text.units(), &[0x5f, 0xd800, 0x5f, 0x61]);
    assert_eq!(text.as_scalar(), None);
    assert_eq!(text.identifier_label().units(), &[0x20, 0xd800, 0x20, 0x61]);
    assert!(!text.is_empty());
    assert!(JsText::scalar("").is_empty());
    assert_eq!(JsText::scalar("é😀").as_scalar().as_deref(), Some("é😀"));
    assert_eq!(
        OptionGroupId::from("group".to_owned()).0.units(),
        &[103, 114, 111, 117, 112]
    );
    assert_eq!(VariantId::from("a".to_owned()).0.units(), &[97]);
    assert_eq!(ManifestText::from("b".to_owned()).units(), &[98]);
}

#[test]
fn ecmascript_whitespace_set_and_trim_are_exact() {
    let whitespace = vec![
        0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
        0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
        0xfeff,
    ];
    for unit in &whitespace {
        let blank = JsText::from_units(vec![*unit]);
        assert!(blank.is_ecmascript_blank(), "{unit:04x}");
        assert_eq!(blank.trim_ecmascript().units(), &[] as &[u16]);
    }
    let mut surrounded = whitespace.clone();
    surrounded.extend_from_slice(&[0xd800, 0x20, 0x61]);
    surrounded.extend_from_slice(&whitespace);
    assert_eq!(
        JsText::from_units(surrounded).trim_ecmascript().units(),
        &[0xd800, 0x20, 0x61]
    );
    for unit in [0x0, 0x8, 0xe, 0x85, 0x180e, 0x200b, 0x2060, 0xd800, 0xffff] {
        let text = JsText::from_units(vec![unit]);
        assert!(!text.is_ecmascript_blank(), "{unit:04x}");
        assert_eq!(text.trim_ecmascript().units(), &[unit]);
    }
    assert!(JsText::scalar("").is_ecmascript_blank());
    assert_eq!(JsText::scalar("").trim_ecmascript().units(), &[] as &[u16]);
}

#[test]
fn array_index_boundaries_match_ecmascript() {
    for (input, expected) in [
        ("0", Some(0)),
        ("1", Some(1)),
        ("10", Some(10)),
        ("4294967294", Some(4_294_967_294)),
        ("4294967295", None),
        ("4294967296", None),
        ("18446744073709551616", None),
        ("999999999999999999999999999999999", None),
        ("", None),
        ("00", None),
        ("01", None),
        ("-0", None),
        ("+1", None),
        ("1.0", None),
        ("1e0", None),
        (" 1", None),
        ("1\n", None),
        ("١", None),
        ("１", None),
    ] {
        assert_eq!(JsText::scalar(input).array_index(), expected, "{input:?}");
    }
    assert_eq!(JsText::from_units(vec![0xd800]).array_index(), None);
}

#[test]
fn ordering_uses_utf16_rather_than_utf8_or_scalar_values() {
    let supplementary = JsText::scalar("𐀀");
    let bmp = JsText::scalar("\u{e000}");
    assert_eq!(supplementary.cmp(&bmp), Ordering::Less);
    assert_eq!(
        JsText::from_units(vec![0xd800]).cmp(&supplementary),
        Ordering::Less
    );
    assert_eq!(
        compare_json_bytes("\"𐀀\"".as_bytes(), "\"\u{e000}\"".as_bytes()).unwrap(),
        Ordering::Less
    );
    assert_eq!(compare_json_bytes(b"[]", b"[]").unwrap(), Ordering::Equal);
    assert_eq!(compare_json_bytes(b"a", b"aa").unwrap(), Ordering::Less);
    assert_eq!(compare_json_bytes(b"b", b"a").unwrap(), Ordering::Greater);
    assert!(compare_json_bytes(b"\xff", b"[]").is_err());
    assert!(compare_json_bytes(b"[]", b"\xed\xa0\x80").is_err());
}

#[test]
fn digest_hashes_exact_bytes_without_json_normalization() {
    assert_eq!(
        digest_json_bytes(br#"{"a":1}"#),
        "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862"
    );
    assert_eq!(
        digest_json_bytes(b"{\"a\":1}\n"),
        "e346432021b04179518d9614f3560ccd71354a4ee101ddcb893d6959a9d6301c"
    );
}

fn surrogate_part() -> DraftPart {
    DraftPart::new(
        json!({"partKey":"custom.stl", "included":true, "count":2}),
        PartManifestMetadata {
            requirement: Some(ManifestText(JsText::from_units(vec![0xd801]))),
            option_group_id: Some(OptionGroupId(JsText::from_units(vec![0xd800]))),
            manifest_source: Some("repo".into()),
        },
    )
}

#[test]
fn typed_scalar_carrier_matches_literal_json_and_known_digest() {
    let fields = [
        "baseRevisionPartId",
        "partKey",
        "included",
        "requirement",
        "optionGroupId",
        "manifestSource",
    ];
    for (text, expected, digest) in [
        ("ordinary", r#"{"baseRevisionPartId":null,"partKey":"a.stl","included":true,"requirement":"ordinary","optionGroupId":"ordinary","manifestSource":"repo"}"#.as_bytes(), "eb7214088217f93490ed91947a18e1ca9c87cd26d88e94bd3eb5ba6a20c444bf"),
        ("literal PPJS text", r#"{"baseRevisionPartId":null,"partKey":"a.stl","included":true,"requirement":"literal PPJS text","optionGroupId":"literal PPJS text","manifestSource":"repo"}"#.as_bytes(), "9d1cd60802f95ff3ecf4cb2bf70b2e7e233e9e6f09d57756fbc354f5160347b1"),
        ("uD800", r#"{"baseRevisionPartId":null,"partKey":"a.stl","included":true,"requirement":"uD800","optionGroupId":"uD800","manifestSource":"repo"}"#.as_bytes(), "b7f5536eda8eebb7a1aa0ddb0499ea0f159a4edf2cd9fd895779a6eb49ec051f"),
        ("😀", r#"{"baseRevisionPartId":null,"partKey":"a.stl","included":true,"requirement":"😀","optionGroupId":"😀","manifestSource":"repo"}"#.as_bytes(), "adcff2076a2e717ab89d0876d9fb3f48d4c2c1e4965e6b66a67c546081e6c3df"),
        ("\\uD800", r#"{"baseRevisionPartId":null,"partKey":"a.stl","included":true,"requirement":"\\uD800","optionGroupId":"\\uD800","manifestSource":"repo"}"#.as_bytes(), "84cad06f2c1b2fc410d58a34cec92634c117fb69378a80995e13402a69e3a5ef"),
        ("a\n\t\u{0001}b", r#"{"baseRevisionPartId":null,"partKey":"a.stl","included":true,"requirement":"a\n\t\u0001b","optionGroupId":"a\n\t\u0001b","manifestSource":"repo"}"#.as_bytes(), "f732a9e96de8af2598dc7e35c278423a0cdbe2e2bf003d72cfe71d7d56da4fc1"),
    ] {
        let part = DraftPart::new(
            json!({"baseRevisionPartId":null, "partKey":"a.stl", "included":true}),
            PartManifestMetadata {
                requirement: Some(text.to_owned().into()),
                option_group_id: Some(text.to_owned().into()),
                manifest_source: Some("repo".into()),
            },
        );
        let bytes = part.json_fields(&fields, false);
        assert_eq!(bytes, expected);
        assert_eq!(digest_json_bytes(&bytes), digest);
    }
}

#[test]
fn typed_both_metadata_fields_write_distinct_lowercase_units() {
    let part = surrogate_part();
    let bytes = part.json_fields(
        &["requirement", "optionGroupId", "partKey", "manifestSource"],
        false,
    );
    assert_eq!(bytes, br#"{"requirement":"\ud801","optionGroupId":"\ud800","partKey":"custom.stl","manifestSource":"repo"}"#);
    assert_eq!(
        digest_json_bytes(&bytes),
        "7c242b81e59bb6fbf911e1d63bab71d1c90dcfd00590ce77bd299cb2ada3d967"
    );
    assert_eq!(
        part.sql_fields(&["requirement", "optionGroupId"]).unwrap(),
        vec![
            (
                "requirement".into(),
                Value::Blob(b"PPJS\x01\0\0\0\x01\xd8\x01".to_vec())
            ),
            (
                "optionGroupId".into(),
                Value::Blob(b"PPJS\x01\0\0\0\x01\xd8\0".to_vec())
            ),
        ]
    );
}

#[test]
fn draft_aliases_projection_and_scalar_mutation_preserve_metadata() {
    let part = surrogate_part();
    assert_eq!(
        part.json_fields(&["optionGroupId", "manifestSource", "partKey"], true),
        br#"{"option_group_id":"\ud800","manifest_source":"repo","part_key":"custom.stl"}"#
    );
    assert_eq!(
        part.json_fields(&["option_group_id", "manifest_source"], false),
        br#"{"option_group_id":"\ud800","manifest_source":"repo"}"#
    );
    let mut projected = part.projected(&[
        "partKey",
        "requirement",
        "option_group_id",
        "manifestSource",
        "missing",
    ]);
    assert_eq!(
        projected.scalar,
        json!({"partKey":"custom.stl", "missing":null})
    );
    assert_eq!(projected.manifest, part.manifest);
    assert_eq!(projected["partKey"], "custom.stl");
    projected["partKey"] = json!("changed.stl");
    assert!(!projected.same_field(&part, "partKey"));
    for field in [
        "requirement",
        "optionGroupId",
        "option_group_id",
        "manifestSource",
        "manifest_source",
        "missing",
    ] {
        assert!(projected.same_field(&part, field), "{field}");
    }
    projected.manifest.requirement = None;
    projected.manifest.option_group_id = None;
    projected.manifest.manifest_source = None;
    for field in [
        "requirement",
        "optionGroupId",
        "option_group_id",
        "manifestSource",
        "manifest_source",
    ] {
        assert!(!projected.same_field(&part, field), "{field}");
    }
    assert_eq!(
        projected.json_fields(
            &["requirement", "optionGroupId", "manifestSource", "missing"],
            false
        ),
        br#"{"requirement":null,"optionGroupId":null,"manifestSource":null,"missing":null}"#
    );
    assert_eq!(part.projected(&[]).scalar, json!({}));
    assert_eq!(part.json_fields(&[], false), b"{}");
}

#[test]
#[should_panic]
fn draft_rejects_manifest_metadata_in_scalar_carrier() {
    DraftPart::new(
        json!({"option_group_id":"hidden"}),
        PartManifestMetadata::default(),
    );
}

#[test]
fn draft_sql_bindings_cover_aliases_nulls_and_scalar_types() {
    let part = DraftPart::new(
        json!({"flag":true, "off":false, "min":i64::MIN, "max":i64::MAX, "text":"hello", "nil":null}),
        PartManifestMetadata {
            requirement: Some("a".to_owned().into()),
            option_group_id: Some("b".to_owned().into()),
            manifest_source: Some("repo".into()),
        },
    );
    let fields = [
        "flag",
        "off",
        "min",
        "max",
        "text",
        "nil",
        "missing",
        "requirement",
        "optionGroupId",
        "option_group_id",
        "manifestSource",
        "manifest_source",
    ];
    let values: Vec<_> = part
        .sql_fields(&fields)
        .unwrap()
        .into_iter()
        .map(|(_, value)| value)
        .collect();
    assert_eq!(
        values,
        vec![
            Value::Integer(1),
            Value::Integer(0),
            Value::Integer(i64::MIN),
            Value::Integer(i64::MAX),
            Value::Text("hello".into()),
            Value::Null,
            Value::Null,
            Value::Text("a".into()),
            Value::Text("b".into()),
            Value::Text("b".into()),
            Value::Text("repo".into()),
            Value::Text("repo".into())
        ]
    );
    let empty = DraftPart::new(json!({}), PartManifestMetadata::default());
    assert_eq!(
        empty
            .sql_fields(&["requirement", "optionGroupId", "manifestSource"])
            .unwrap(),
        vec![
            ("requirement".into(), Value::Null),
            ("optionGroupId".into(), Value::Null),
            ("manifestSource".into(), Value::Null)
        ]
    );
}

#[test]
fn draft_sql_rejects_arrays_objects_floats_and_unsigned_overflow() {
    for value in [
        json!([]),
        json!({}),
        json!(1.5),
        json!(1.0),
        json!(u64::MAX),
    ] {
        let part = DraftPart::new(json!({"value":value}), PartManifestMetadata::default());
        let error = part.sql_fields(&["value"]).unwrap_err().to_string();
        assert_eq!(
            error,
            if value.is_number() {
                "Invalid scalar part integer"
            } else {
                "Invalid scalar part field"
            }
        );
    }
}

#[test]
fn sqlite_encoding_uses_exact_canonical_bytes() {
    assert_eq!(
        JsText::scalar("PPJS\u{e000}é𐀀").sqlite_value().unwrap(),
        Value::Text("PPJS\u{e000}é𐀀".into())
    );
    for (units, blob) in [
        (vec![0xd800], b"PPJS\x01\0\0\0\x01\xd8\0".as_slice()),
        (vec![0xdc00], b"PPJS\x01\0\0\0\x01\xdc\0".as_slice()),
        (
            vec![0x61, 0xd800, 0xdc00, 0xdc00],
            b"PPJS\x01\0\0\0\x04\0a\xd8\0\xdc\0\xdc\0".as_slice(),
        ),
    ] {
        let text = JsText::from_units(units.clone());
        assert_eq!(text.sqlite_value().unwrap(), Value::Blob(blob.to_vec()));
        assert_eq!(
            read_manifest_text(ValueRef::Blob(blob))
                .unwrap()
                .unwrap()
                .units(),
            units
        );
    }
    assert_eq!(read_manifest_text(ValueRef::Null).unwrap(), None);
    assert_eq!(
        read_manifest_text(ValueRef::Text(b"")).unwrap(),
        Some(JsText::scalar(""))
    );
}

#[test]
fn sqlite_bind_and_read_preserve_storage_classes_and_units() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch("CREATE TABLE texts(value)")
        .unwrap();
    let cases = [
        (Value::Null, "null", None),
        (
            JsText::scalar("").sqlite_value().unwrap(),
            "text",
            Some(JsText::scalar("")),
        ),
        (
            JsText::scalar("PPJS\u{1}\u{0}\u{e000}uD800\u{e000}😀")
                .sqlite_value()
                .unwrap(),
            "text",
            Some(JsText::scalar("PPJS\u{1}\u{0}\u{e000}uD800\u{e000}😀")),
        ),
        (
            JsText::from_units(vec![0x61, 0xd800, 0xdc00, 0xdc00])
                .sqlite_value()
                .unwrap(),
            "blob",
            Some(JsText::from_units(vec![0x61, 0xd800, 0xdc00, 0xdc00])),
        ),
    ];
    for (value, _, _) in &cases {
        connection
            .execute("INSERT INTO texts VALUES (?1)", params![value])
            .unwrap();
    }
    let mut statement = connection
        .prepare("SELECT typeof(value), value FROM texts ORDER BY rowid")
        .unwrap();
    let mut rows = statement.query([]).unwrap();
    for (expected_value, expected_type, expected_text) in cases {
        let row = rows.next().unwrap().unwrap();
        assert_eq!(row.get::<_, String>(0).unwrap(), expected_type);
        assert_eq!(row.get::<_, Value>(1).unwrap(), expected_value);
        assert_eq!(
            read_manifest_text(row.get_ref(1).unwrap()).unwrap(),
            expected_text
        );
    }
    assert!(rows.next().unwrap().is_none());
}

#[test]
fn draft_sql_metadata_bindings_survive_real_sqlite() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch("CREATE TABLE parts(requirement, option_group_id, manifest_source)")
        .unwrap();
    let bindings = surrogate_part()
        .sql_fields(&["requirement", "option_group_id", "manifest_source"])
        .unwrap();
    connection
        .execute(
            "INSERT INTO parts VALUES (?1, ?2, ?3)",
            params![bindings[0].1, bindings[1].1, bindings[2].1],
        )
        .unwrap();
    let mut statement = connection.prepare("SELECT * FROM parts").unwrap();
    let mut rows = statement.query([]).unwrap();
    let row = rows.next().unwrap().unwrap();
    assert_eq!(
        read_manifest_text(row.get_ref(0).unwrap())
            .unwrap()
            .unwrap()
            .units(),
        &[0xd801]
    );
    assert_eq!(
        read_manifest_text(row.get_ref(1).unwrap())
            .unwrap()
            .unwrap()
            .units(),
        &[0xd800]
    );
    assert_eq!(row.get::<_, String>(2).unwrap(), "repo");
}

#[test]
fn sqlite_rejects_malformed_headers_counts_lengths_versions_and_scalar_blobs() {
    for bytes in [
        b"".as_slice(),
        b"generic",
        b"PPJS",
        b"PPJS\x01\0\0\0",
        b"PPJT\x01\0\0\0\x01\xd8\0",
        b"PPJS\x02\0\0\0\x01\xd8\0",
    ] {
        assert_eq!(
            read_manifest_text(ValueRef::Blob(bytes))
                .unwrap_err()
                .to_string(),
            "Invalid PPJS manifest text header"
        );
    }
    for bytes in [
        b"PPJS\x01\0\0\0\x01\xd8".as_slice(),
        b"PPJS\x01\0\0\0\x01\xd8\0\0",
        b"PPJS\x01\0\0\0\x02\xd8\0",
        b"PPJS\x01\0\0\0\0\xd8\0",
    ] {
        assert_eq!(
            read_manifest_text(ValueRef::Blob(bytes))
                .unwrap_err()
                .to_string(),
            "Invalid PPJS manifest text length"
        );
    }
    for bytes in [
        b"PPJS\x01\0\0\0\0".as_slice(),
        b"PPJS\x01\0\0\0\x01\0a",
        b"PPJS\x01\0\0\0\x02\xd8\0\xdc\0",
    ] {
        assert_eq!(
            read_manifest_text(ValueRef::Blob(bytes))
                .unwrap_err()
                .to_string(),
            "Scalar manifest text must use SQLite TEXT"
        );
    }
}

#[test]
fn sqlite_checks_declared_budget_before_length_or_allocation() {
    for bytes in [
        b"PPJS\x01\0\x80\0\x01".as_slice(),
        b"PPJS\x01\xff\xff\xff\xff",
    ] {
        assert_eq!(
            read_manifest_text(ValueRef::Blob(bytes))
                .unwrap_err()
                .to_string(),
            "PPJS manifest text exceeds unit budget"
        );
    }
    assert_eq!(
        read_manifest_text(ValueRef::Blob(b"PPJS\x01\0\x80\0\0"))
            .unwrap_err()
            .to_string(),
        "Invalid PPJS manifest text length"
    );
}

#[test]
fn sqlite_rejects_numeric_types_and_invalid_utf8_from_real_rows() {
    let connection = Connection::open_in_memory().unwrap();
    for sql in [
        "SELECT 1",
        "SELECT 1.5",
        "SELECT CAST(x'ff' AS TEXT)",
        "SELECT x'50504a5301000000010061'",
    ] {
        let mut statement = connection.prepare(sql).unwrap();
        let mut rows = statement.query([]).unwrap();
        let row = rows.next().unwrap().unwrap();
        assert!(
            read_manifest_text(row.get_ref(0).unwrap()).is_err(),
            "{sql}"
        );
    }
    for bytes in [
        b"\xff".as_slice(),
        b"\xed\xa0\x80",
        b"\xf4\x90\x80\x80",
        b"\xe2\x82",
    ] {
        assert!(read_manifest_text(ValueRef::Text(bytes)).is_err());
    }
    for value in [ValueRef::Integer(1), ValueRef::Real(1.5)] {
        assert_eq!(
            read_manifest_text(value).unwrap_err().to_string(),
            "Manifest text must use NULL, TEXT or canonical PPJS BLOB"
        );
    }
}
