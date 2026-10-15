#![cfg(feature = "desktop_rebuild")]

use pp_storage::manifest_options::{KitManifest, ManifestInputDetail};

fn emit(kit: &KitManifest) -> Vec<u8> {
    let mut bytes = Vec::new();
    kit.write_json(&mut bytes);
    bytes
}

fn request_error(input: &[u8]) -> Vec<u8> {
    KitManifest::from_request(input)
        .unwrap_err()
        .into_body()
        .into_bytes()
}

fn stored_error(input: &str) -> Vec<u8> {
    KitManifest::from_stored(input)
        .unwrap_err()
        .into_body()
        .into_bytes()
}

#[test]
fn defaults_and_append_emit_exact_bytes() {
    let expected = br#"{"name":null,"layers":[],"base_source_id":null,"addon_source_ids":[],"selections":{},"include":[],"exclude":[],"replacements":{},"choice_tree":[],"category_links":[]}"#;
    let kit = KitManifest::from_request(br#"{"kit":{},"ignored":true}"#).unwrap();
    assert_eq!(emit(&kit), expected);
    assert_eq!(emit(&KitManifest::default()), expected);
    let mut output = b"prefix".to_vec();
    kit.write_json(&mut output);
    assert_eq!(output, [b"prefix".as_slice(), expected].concat());
    assert!(kit.selection_projection().is_empty());
}

#[test]
fn normalization_preserves_group_keys_and_scalar_array_shapes() {
    let kit = KitManifest::from_request(
        br#"{"kit":{"name":"  kit  ","layers":[" layer "],"base_source_id":" base ","addon_source_ids":[" addon "],"selections":{" group ":"\ufeff a \u2029","empty":[],"many":["\u00a0b\t","c"]},"include":[" include "],"exclude":[" exclude "],"replacements":{" old ":" new "},"unknown":12}}"#,
    )
    .unwrap();
    assert_eq!(
        emit(&kit),
        br#"{"name":"  kit  ","layers":[" layer "],"base_source_id":" base ","addon_source_ids":[" addon "],"selections":{" group ":"a","empty":[],"many":["b","c"]},"include":[" include "],"exclude":[" exclude "],"replacements":{" old ":" new "},"choice_tree":[],"category_links":[]}"#
    );
    let projection = kit.selection_projection();
    let scalar = projection
        .iter()
        .map(|(group, variants)| {
            (
                group.0.as_scalar().unwrap(),
                variants
                    .iter()
                    .map(|variant| variant.0.as_scalar().unwrap())
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        scalar,
        vec![
            (" group ".into(), vec!["a".into()]),
            ("empty".into(), vec![]),
            ("many".into(), vec!["b".into(), "c".into()]),
        ]
    );
}

#[test]
fn request_validation_emits_exact_error_bodies() {
    for (input, detail) in [
        ("{", "Request is invalid"),
        ("{} trailing", "Request is invalid"),
        ("[]", "kit is required"),
        ("{}", "kit is required"),
        (r#"{"kit":null}"#, "kit must be an object"),
        (r#"{"kit":{"name":1}}"#, "kit.name must be a string or null"),
        (
            r#"{"kit":{"base_source_id":false}}"#,
            "kit.base_source_id must be a string or null",
        ),
        (
            r#"{"kit":{"layers":[null]}}"#,
            "kit.layers must be an array of strings",
        ),
        (
            r#"{"kit":{"addon_source_ids":null}}"#,
            "kit.addon_source_ids must be an array of strings",
        ),
        (
            r#"{"kit":{"include":[1]}}"#,
            "kit.include must be an array of strings",
        ),
        (
            r#"{"kit":{"exclude":{}}}"#,
            "kit.exclude must be an array of strings",
        ),
        (
            r#"{"kit":{"selections":[]}}"#,
            "kit.selections must be an object",
        ),
        (
            r#"{"kit":{"selections":{"\ufeff\u2029":"a"}}}"#,
            "kit.selections group id is required",
        ),
        (
            r#"{"kit":{"selections":{"g":true}}}"#,
            "kit.selections.g must contain unique nonempty variant ids",
        ),
        (
            r#"{"kit":{"selections":{"g":["a",1]}}}"#,
            "kit.selections.g must contain unique nonempty variant ids",
        ),
        (
            r#"{"kit":{"selections":{"g":"\u00a0"}}}"#,
            "kit.selections.g must contain unique nonempty variant ids",
        ),
        (
            r#"{"kit":{"replacements":[]}}"#,
            "kit.replacements must be an object",
        ),
        (
            r#"{"kit":{"replacements":{"x":1}}}"#,
            "kit.replacements must map strings to strings",
        ),
        (
            r#"{"kit":{"choice_tree":null}}"#,
            "kit.choice_tree must be an array",
        ),
        (
            r#"{"kit":{"category_links":{}}}"#,
            "kit.category_links must be an array",
        ),
    ] {
        assert_eq!(
            request_error(input.as_bytes()),
            format!(r#"{{"detail":"{detail}"}}"#).into_bytes(),
            "{input}"
        );
    }
    assert_eq!(
        request_error(&[0xff]),
        br#"{"detail":"Request is invalid"}"#
    );
}

#[test]
fn duplicate_variant_ids_are_rejected_after_ecmascript_trim() {
    for variants in [r#"["a"," a "]"#, r#"["\ud800","\ufeff\ud800\u2029"]"#] {
        let input = format!(r#"{{"kit":{{"selections":{{"g":{variants}}}}}}}"#);
        assert_eq!(
            request_error(input.as_bytes()),
            br#"{"detail":"kit.selections.g must contain unique nonempty variant ids"}"#
        );
    }
    let kit =
        KitManifest::from_request(br#"{"kit":{"selections":{"g":["a","\u0085a"]}}}"#).unwrap();
    assert_eq!(kit.selection_projection()[0].1[1].0.units(), &[0x85, 0x61]);
}

#[test]
fn surrogate_text_keys_and_errors_remain_lossless() {
    let kit = KitManifest::from_request(
        br#"{"kit":{"name":"\ud800","layers":["\udc00"],"selections":{"\ud800":" \udc00 "},"replacements":{"\udc00":"\ud800"},"choice_tree":[{"\ud800":"\udc00"}],"category_links":["\ud800"]}}"#,
    ).unwrap();
    let expected = br#"{"name":"\ud800","layers":["\udc00"],"base_source_id":null,"addon_source_ids":[],"selections":{"\ud800":"\udc00"},"include":[],"exclude":[],"replacements":{"\udc00":"\ud800"},"choice_tree":[{"\ud800":"\udc00"}],"category_links":["\ud800"]}"#;
    assert_eq!(emit(&kit), expected);
    let projection = kit.selection_projection();
    assert_eq!(projection[0].0.0.units(), &[0xd800]);
    assert_eq!(projection[0].1[0].0.units(), &[0xdc00]);
    assert_eq!(
        request_error(br#"{"kit":{"selections":{"\ud800":["x"," x "]}}}"#),
        br#"{"detail":"kit.selections.\ud800 must contain unique nonempty variant ids"}"#
    );
    assert_eq!(
        KitManifest::from_stored(std::str::from_utf8(expected).unwrap()).unwrap(),
        kit
    );
}

#[test]
fn dynamic_json_and_duplicate_keys_emit_javascript_bytes_and_roundtrip() {
    let kit = KitManifest::from_request(
        br#"{"kit":{"name":"first","name":"last","selections":{"b":"old","2":"two","1":"one","b":"new","01":["leading"]},"choice_tree":[{"z":0,"2":-0,"1":1e21,"z":1e400,"a":9007199254740993}],"category_links":[true,false,null,"\ud83d\ude00",1e-7]}}"#,
    ).unwrap();
    let expected = "{\"name\":\"last\",\"layers\":[],\"base_source_id\":null,\"addon_source_ids\":[],\"selections\":{\"1\":\"one\",\"2\":\"two\",\"b\":\"new\",\"01\":[\"leading\"]},\"include\":[],\"exclude\":[],\"replacements\":{},\"choice_tree\":[{\"1\":1e+21,\"2\":0,\"z\":null,\"a\":9007199254740992}],\"category_links\":[true,false,null,\"😀\",1e-7]}";
    assert_eq!(emit(&kit), expected.as_bytes());
    let stored = KitManifest::from_stored(expected).unwrap();
    assert_eq!(emit(&stored), expected.as_bytes());
    let wrapped = format!(r#"{{"kit":{expected}}}"#);
    assert_eq!(
        stored,
        KitManifest::from_request(wrapped.as_bytes()).unwrap()
    );
}

#[test]
fn stored_errors_collapse_validation_and_syntax_failures() {
    for input in [
        "null",
        "[]",
        "{",
        r#"{"name":7}"#,
        r#"{"selections":{"g":["a"," a "]}}"#,
    ] {
        assert_eq!(
            stored_error(input),
            br#"{"detail":"stored kit is malformed"}"#
        );
    }
    assert_eq!(
        ManifestInputDetail::from("quoted \"detail\"\n")
            .into_body()
            .into_bytes(),
        br#"{"detail":"quoted \"detail\"\n"}"#
    );
    assert_eq!(
        ManifestInputDetail::from(String::from("text"))
            .into_body()
            .into_bytes(),
        br#"{"detail":"text"}"#
    );
}

#[test]
fn request_and_stored_limits_accept_boundary_and_reject_excess() {
    const MAX_BYTES: usize = 8 * 1024 * 1024;
    let mut request = br#"{"kit":{}}"#.to_vec();
    request.resize(MAX_BYTES, b' ');
    assert!(KitManifest::from_request(&request).is_ok());
    request.push(b' ');
    assert_eq!(
        request_error(&request),
        br#"{"detail":"Request body too large"}"#
    );
    let mut stored = String::from("{}");
    stored.extend(std::iter::repeat_n(' ', MAX_BYTES - 2));
    assert!(KitManifest::from_stored(&stored).is_ok());
    stored.push(' ');
    assert_eq!(
        stored_error(&stored),
        br#"{"detail":"stored kit exceeds the supported byte limit"}"#
    );

    for (wrapper, depth, nodes, prefix) in [
        (true, 61, 99_995, "kit JSON"),
        (false, 62, 99_997, "stored kit"),
    ] {
        let wrap = |value: String| {
            if wrapper {
                format!(r#"{{"kit":{value}}}"#)
            } else {
                value
            }
        };
        let parse = |input: &str| {
            if wrapper {
                KitManifest::from_request(input.as_bytes())
            } else {
                KitManifest::from_stored(input)
            }
        };
        let nested = |depth| {
            wrap(format!(
                r#"{{"choice_tree":[{}null{}]}}"#,
                "[".repeat(depth),
                "]".repeat(depth)
            ))
        };
        assert!(parse(&nested(depth)).is_ok());
        assert_eq!(
            parse(&nested(depth + 1))
                .unwrap_err()
                .into_body()
                .into_bytes(),
            format!(r#"{{"detail":"{prefix} exceeds the supported depth limit"}}"#).into_bytes()
        );
        let many = |count| {
            wrap(format!(
                r#"{{"choice_tree":[{}]}}"#,
                std::iter::repeat_n("null", count)
                    .collect::<Vec<_>>()
                    .join(",")
            ))
        };
        assert!(parse(&many(nodes)).is_ok());
        assert_eq!(
            parse(&many(nodes + 1))
                .unwrap_err()
                .into_body()
                .into_bytes(),
            format!(r#"{{"detail":"{prefix} exceeds the supported node limit"}}"#).into_bytes()
        );
    }
}
