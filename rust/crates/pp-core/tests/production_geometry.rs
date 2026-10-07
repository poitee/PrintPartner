use pp_core::production::geometry::{
    GeometryLimits, MeshBounds, ParsedMesh, dimensions_um, parse_accepted_stl,
};

fn golden() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/plate-layout-parity.json")).unwrap()
}

fn decode_hex(value: &str) -> Vec<u8> {
    let (pairs, remainder) = value.as_bytes().as_chunks::<2>();
    assert!(remainder.is_empty());
    pairs
        .iter()
        .map(|pair| {
            let pair = std::str::from_utf8(pair).unwrap();
            u8::from_str_radix(pair, 16).unwrap()
        })
        .collect()
}

fn ascii() -> Vec<u8> {
    b"solid dimensions\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 0.0014 0 0\nvertex 0 0.0026 0.0035\nendloop\nendfacet\nendsolid dimensions".to_vec()
}

#[test]
fn strict_ascii_mesh_produces_node_rounded_dimensions() {
    let mesh = parse_accepted_stl(&ascii(), GeometryLimits::default()).unwrap();
    let dimensions = dimensions_um(&mesh).unwrap();
    assert_eq!(dimensions.width_um.get(), 1);
    assert_eq!(dimensions.depth_um.get(), 3);
    assert_eq!(dimensions.height_um.get(), 4);
}

#[test]
fn strict_ascii_envelopes_match_committed_node_golden() {
    for case in golden()["stl"]["envelopes"].as_array().unwrap() {
        let bytes = decode_hex(case["hex"].as_str().unwrap());
        assert_eq!(
            parse_accepted_stl(&bytes, GeometryLimits::default()).is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"].as_str().unwrap()
        );
    }
}

#[test]
fn mesh_dimension_boundaries_match_committed_node_golden() {
    for case in golden()["stl"]["dimensionCases"].as_array().unwrap() {
        let width = case["widthMm"].as_f64().unwrap();
        let mesh = ParsedMesh {
            triangles: 1,
            bounds: MeshBounds {
                min_x: 0.0,
                min_y: 0.0,
                min_z: 0.0,
                max_x: width,
                max_y: 1.0,
                max_z: 1.0,
            },
        };
        let actual = dimensions_um(&mesh)
            .map(|dimensions| {
                serde_json::json!({
                    "widthUm": dimensions.width_um.get(),
                    "depthUm": dimensions.depth_um.get(),
                    "heightUm": dimensions.height_um.get(),
                })
            })
            .unwrap_or(serde_json::Value::Null);
        assert_eq!(actual, case["dimensions"], "{}", case["name"]);
    }
}

#[test]
fn strict_parser_rejects_truncation_nonfinite_and_extra_binary_data() {
    assert!(
        parse_accepted_stl(b"solid incomplete\nvertex 0 0 0", GeometryLimits::default()).is_err()
    );
    assert!(parse_accepted_stl(b"solid bad\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1e999 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid bad", GeometryLimits::default()).is_err());
    assert!(
        parse_accepted_stl(
            b"solid bad\nfacet normal 0\nendsolid bad",
            GeometryLimits::default()
        )
        .is_err()
    );
    let mut binary = vec![0_u8; 134];
    binary[80..84].copy_from_slice(&1_u32.to_le_bytes());
    binary[96..100].copy_from_slice(&1_f32.to_le_bytes());
    binary[112..116].copy_from_slice(&1_f32.to_le_bytes());
    binary.push(0);
    assert!(parse_accepted_stl(&binary, GeometryLimits::default()).is_err());
}

#[test]
fn binary_mesh_has_bounded_finite_coordinates() {
    let mut binary = vec![0_u8; 134];
    binary[80..84].copy_from_slice(&1_u32.to_le_bytes());
    for (offset, value) in [(96, 1_f32), (112, 2_f32), (128, 3_f32)] {
        binary[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    let mesh = parse_accepted_stl(
        &binary,
        GeometryLimits {
            max_bytes: 200,
            max_triangles: 1,
        },
    )
    .unwrap();
    assert_eq!(mesh.triangles, 1);
    assert!(
        parse_accepted_stl(
            &ascii(),
            GeometryLimits {
                max_bytes: 8,
                max_triangles: 1
            }
        )
        .is_err()
    );
}

#[test]
fn actual_node_golden_matches_callable_geometry_functions() {
    let golden = golden();
    let mesh = parse_accepted_stl(&ascii(), GeometryLimits::default()).unwrap();
    let dimensions = dimensions_um(&mesh).unwrap();
    assert_eq!(
        serde_json::json!({
            "widthUm": dimensions.width_um.get(),
            "depthUm": dimensions.depth_um.get(),
            "heightUm": dimensions.height_um.get(),
        }),
        golden["stl"]["dimensions"]
    );

    let nonfinite_normal = b"solid accepted\nfacet normal 1e999 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 1\nendloop\nendfacet\nendsolid accepted";
    assert_eq!(
        parse_accepted_stl(nonfinite_normal, GeometryLimits::default()).is_ok(),
        golden["stl"]["nonfiniteNormalAccepted"].as_bool().unwrap()
    );

    let mut invalid_utf8_header = b"solid ".to_vec();
    invalid_utf8_header.push(0xff);
    invalid_utf8_header.extend_from_slice(&ascii()["solid dimensions".len()..]);
    assert_eq!(
        parse_accepted_stl(&invalid_utf8_header, GeometryLimits::default()).is_ok(),
        golden["stl"]["invalidUtf8HeaderAccepted"]
            .as_bool()
            .unwrap()
    );
}
