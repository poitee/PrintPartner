#![cfg(feature = "desktop_rebuild")]

use pp_core::production::geometry::{
    GeometryLimits, MeshBounds, ParsedMesh, dimensions_um, parse_accepted_stl,
};

fn golden() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/farm/plate-layout-geometry.json"
    ))
    .unwrap()
}

fn ascii() -> Vec<u8> {
    b"solid dimensions\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 0.0014 0 0\nvertex 0 0.0026 0.0035\nendloop\nendfacet\nendsolid dimensions".to_vec()
}

fn mesh_dimensions(mesh: &ParsedMesh) -> serde_json::Value {
    dimensions_um(mesh)
        .map(|dimensions| {
            serde_json::json!({
                "widthUm": dimensions.width_um.get(),
                "depthUm": dimensions.depth_um.get(),
                "heightUm": dimensions.height_um.get(),
            })
        })
        .unwrap_or(serde_json::Value::Null)
}

#[test]
fn strict_ascii_envelopes_match_committed_node_golden() {
    for case in golden()["stl"]["envelopes"].as_array().unwrap() {
        let bytes = hex::decode(case["hex"].as_str().unwrap()).unwrap();
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
        let actual = mesh_dimensions(&mesh);
        assert_eq!(actual, case["dimensions"], "{}", case["name"]);
    }
}

#[test]
fn binary_mesh_has_bounded_finite_coordinates() {
    let mut binary = vec![0_u8; 134];
    binary[80..84].copy_from_slice(&1_u32.to_le_bytes());
    for (offset, value) in [(96, 1_f32), (112, 2_f32), (128, 3_f32)] {
        binary[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    let limits = GeometryLimits {
        max_bytes: binary.len(),
        max_triangles: 1,
    };
    let mesh = parse_accepted_stl(&binary, limits).unwrap();
    assert_eq!(mesh.triangles, 1);
    assert_eq!(
        mesh.bounds,
        MeshBounds {
            min_x: 0.0,
            min_y: 0.0,
            min_z: 0.0,
            max_x: 1.0,
            max_y: 2.0,
            max_z: 3.0
        }
    );
    assert!(
        parse_accepted_stl(
            &binary,
            GeometryLimits {
                max_bytes: 133,
                ..limits
            }
        )
        .is_err()
    );
    assert!(
        parse_accepted_stl(
            &binary,
            GeometryLimits {
                max_triangles: 0,
                ..limits
            }
        )
        .is_err()
    );
    let mut extra = binary.clone();
    extra.push(0);
    assert!(parse_accepted_stl(&extra, GeometryLimits::default()).is_err());
    binary[96..100].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(parse_accepted_stl(&binary, limits).is_err());
}

#[test]
fn reference_accepts_syntactic_nonfinite_normals() {
    let nonfinite = String::from_utf8(ascii())
        .unwrap()
        .replace("vertex 0 0 0", "vertex 1e999 0 0");
    assert!(parse_accepted_stl(nonfinite.as_bytes(), GeometryLimits::default()).is_err());
    let bytes = String::from_utf8(ascii())
        .unwrap()
        .replace("normal 0 0 1", "normal 1e999 0 1");
    assert_eq!(
        parse_accepted_stl(bytes.as_bytes(), GeometryLimits::default()).is_ok(),
        golden()["stl"]["nonfiniteNormalAccepted"]
            .as_bool()
            .unwrap()
    );
}

#[test]
fn facet_boundaries_match_committed_node_golden() {
    for case in golden()["stl"]["facetCases"].as_array().unwrap() {
        let bytes = hex::decode(case["hex"].as_str().unwrap()).unwrap();
        let parsed = parse_accepted_stl(&bytes, GeometryLimits::default());
        let actual = parsed.as_ref().ok().map(|mesh| mesh.triangles);
        assert_eq!(
            serde_json::json!(actual),
            case["triangles"],
            "{}",
            case["name"]
        );
        if let Ok(mesh) = parsed {
            assert_eq!(
                mesh_dimensions(&mesh),
                case["dimensions"],
                "{}",
                case["name"]
            );
            for (max_triangles, accepted) in [(mesh.triangles, true), (mesh.triangles - 1, false)] {
                let limits = GeometryLimits {
                    max_triangles,
                    ..GeometryLimits::default()
                };
                assert_eq!(parse_accepted_stl(&bytes, limits).is_ok(), accepted);
            }
        }
    }
}

#[test]
fn ascii_dimensions_and_decoding_match_committed_node_golden() {
    let bytes = ascii();
    let mesh = parse_accepted_stl(&bytes, GeometryLimits::default()).unwrap();
    assert_eq!(mesh_dimensions(&mesh), golden()["stl"]["dimensions"]);
    let mut invalid_utf8 = bytes.clone();
    invalid_utf8[6] = 0xff;
    assert_eq!(
        parse_accepted_stl(&invalid_utf8, GeometryLimits::default()).is_ok(),
        golden()["stl"]["invalidUtf8HeaderAccepted"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(
        parse_accepted_stl(&bytes[..bytes.len() / 2], GeometryLimits::default()).is_err(),
        golden()["stl"]["truncatedRejected"].as_bool().unwrap()
    );
}
