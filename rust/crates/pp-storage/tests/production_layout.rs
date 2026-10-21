#![cfg(feature = "desktop_rebuild")]

use pp_storage::production::{
    layout::{
        self, GroupField, GroupKind, GroupRule, GroupUnit, LayoutFailure, PackResult, PackedUnit,
        Placement, PlateInput, PrinterGeometry, Spacing, UnitInput,
    },
    model::{AcceptedPlanBasis, Digest, DimensionUm, OffsetUm, PlateId, RequiredUnitToken},
};
use std::collections::HashSet;

fn token(value: char) -> RequiredUnitToken {
    RequiredUnitToken::parse(format!("ppu_{}", value.to_string().repeat(32))).unwrap()
}
fn dimension(value: i64) -> DimensionUm {
    DimensionUm::parse(value).unwrap()
}
fn offset(value: i64) -> OffsetUm {
    OffsetUm::parse(value).unwrap()
}
fn printer() -> PrinterGeometry {
    PrinterGeometry {
        bed_width_um: dimension(120),
        bed_depth_um: dimension(100),
        bed_height_um: dimension(80),
        margin_um: offset(10),
    }
}
fn unit(value: char, x: i64, y: i64, placement: Placement) -> UnitInput {
    UnitInput {
        token: token(value),
        x_um: offset(x),
        y_um: offset(y),
        width_um: dimension(30),
        depth_um: dimension(20),
        height_um: dimension(10),
        placement,
        pinned: true,
    }
}
fn plate(units: Vec<UnitInput>) -> PlateInput {
    PlateInput {
        plate_id: PlateId::parse("plate_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap(),
        printer_id: " printer ".into(),
        printer_name: " Printer ".into(),
        printer_model: " Model ".into(),
        printer: printer(),
        units,
    }
}

// Node outputs captured in a71bb9db by web/scripts/plate-layout-parity-capture.mts.
fn golden() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/farm/plate-layout-geometry.json"
    ))
    .unwrap()
}
fn packing(c: char, w: i64, d: i64) -> layout::PackingUnit {
    layout::PackingUnit {
        token: token(c),
        width_um: dimension(w),
        depth_um: dimension(d),
        height_um: dimension(10),
    }
}
fn packed_json(result: PackResult) -> serde_json::Value {
    let PackResult::Packed(plates) = result else {
        panic!("expected packed units")
    };
    serde_json::json!({"kind": "packed", "plates": plates.iter().map(|plate| serde_json::json!({
        "units": plate.iter().map(|u| serde_json::json!({"token": u.unit.token.as_str(),
        "widthUm": u.unit.width_um.get(), "depthUm": u.unit.depth_um.get(), "heightUm": u.unit.height_um.get(),
        "xUm": u.x_um.get(), "yUm": u.y_um.get()})).collect::<Vec<_>>()
    })).collect::<Vec<_>>()})
}
#[test]
fn node_hashes_identity_and_shelf_outputs() {
    let g = golden();
    let expected = HashSet::from([token('a')]);
    let mut input = plate(vec![unit('a', 10, 10, Placement::Auto)]);
    input.printer_id = "\u{feff}printer\u{feff}".into();
    input.printer_name = format!("\u{feff}{}\u{feff}", "é".repeat(200));
    input.printer_model = " Mødel 😺 ".into();
    let validated =
        layout::validate_plates(vec![input], &expected, true, Spacing::Clearance).unwrap();
    for format in [1, 2] {
        assert_eq!(
            layout::layout_digest(&validated, format).as_str(),
            g["layout"][format!("format{format}")].as_str().unwrap()
        );
    }
    let mut basis = AcceptedPlanBasis {
        profile_id: 1,
        plan_version: 2,
        plan_revision_id: 3,
        plan_revision_digest: Digest::parse("a".repeat(64)).unwrap(),
        required_unit_mapping_digest: Digest::parse("b".repeat(64)).unwrap(),
    };
    for tokens in [[token('b'), token('a')], [token('a'), token('b')]] {
        assert_eq!(
            layout::initial_plate_id(&basis, "printer", &tokens)
                .unwrap()
                .as_str(),
            g["initialPlateId"].as_str().unwrap()
        );
    }
    basis.plan_revision_id = 0;
    assert!(layout::initial_plate_id(&basis, "printer", &[token('a')]).is_err());
    let units = [
        packing('c', 30, 20),
        packing('a', 50, 30),
        packing('b', 40, 40),
    ];
    assert_eq!(
        packed_json(layout::pack_units(&printer(), &units)),
        g["packed"]
    );
    let fixed = PackedUnit {
        unit: packing('a', 30, 20),
        x_um: offset(40),
        y_um: offset(40),
    };
    assert_eq!(
        packed_json(layout::pack_units_around(
            &printer(),
            std::slice::from_ref(&fixed),
            &[packing('b', 30, 20), packing('c', 50, 30)]
        )),
        g["around"]
    );
    assert_eq!(
        layout::pack_units(&printer(), &[packing('a', 101, 20)]),
        PackResult::UnitTooLarge(token('a'))
    );
    let mut invalid = printer();
    invalid.margin_um = offset(61);
    assert_eq!(
        layout::pack_units(&invalid, &[packing('a', 1, 1)]),
        PackResult::UnitTooLarge(token('a'))
    );
}
#[test]
fn invalid_layouts_and_legacy_spacing() {
    let expected = HashSet::from([token('a'), token('b')]);
    let a = unit('a', 10, 10, Placement::Manual);
    let b = unit('b', 40, 10, Placement::Auto);
    let validate =
        |plates, every| layout::validate_plates(plates, &expected, every, Spacing::Clearance);
    assert_eq!(validate(vec![], true), Err(LayoutFailure::InvalidUnits));
    assert_eq!(
        validate(vec![plate(vec![a.clone()])], true),
        Err(LayoutFailure::InvalidUnits)
    );
    assert!(validate(vec![plate(vec![a.clone()])], false).is_ok());
    for units in [
        vec![a.clone(), a.clone()],
        vec![a.clone(), unit('c', 50, 10, Placement::Auto)],
    ] {
        assert_eq!(
            validate(vec![plate(units)], false),
            Err(LayoutFailure::InvalidUnits)
        );
    }
    assert_eq!(
        validate(vec![plate(vec![a.clone()]), plate(vec![b.clone()])], true),
        Err(LayoutFailure::InvalidUnits)
    );
    assert_eq!(
        validate(vec![plate(vec![a.clone(), b.clone()])], true),
        Err(LayoutFailure::OverlappingUnits)
    );
    assert!(
        layout::validate_plates(
            vec![plate(vec![a.clone(), b])],
            &expected,
            true,
            Spacing::OverlapOnly
        )
        .is_ok()
    );
    for (x, y) in [(9, 10), (81, 10), (10, 71)] {
        assert_eq!(
            validate(vec![plate(vec![unit('a', x, y, Placement::Auto)])], false),
            Err(LayoutFailure::OutsideBuildArea)
        );
    }
    let mut tall = a.clone();
    tall.height_um = dimension(81);
    assert_eq!(
        validate(vec![plate(vec![tall])], false),
        Err(LayoutFailure::OutsideBuildArea)
    );
    let ready = validate(
        vec![plate(vec![unit('a', 0, 0, Placement::Unplaced)])],
        false,
    )
    .unwrap();
    assert_eq!(ready[0].ordinal, 1);
    assert!(!ready[0].input.units[0].pinned);
    assert_eq!(ready[0].input.printer_name, "Printer");
    let mut invalid = plate(vec![a.clone()]);
    invalid.printer_name = "😺".repeat(101);
    assert_eq!(
        validate(vec![invalid], false),
        Err(LayoutFailure::InvalidUnits)
    );
    let first = validate(vec![plate(vec![a.clone()])], false).unwrap();
    let mut changed = first.clone();
    changed[0].input.units[0].pinned = false;
    assert_eq!(
        layout::layout_digest(&first, 1),
        layout::layout_digest(&changed, 1)
    );
    assert_ne!(
        layout::layout_digest(&first, 2),
        layout::layout_digest(&changed, 2)
    );
}
#[test]
fn typed_boundaries_and_printer_conversion() {
    use pp_storage::production::model::*;
    for value in [-1, i64::from(MAX_PLATE_UM) + 1] {
        assert!(OffsetUm::parse(value).is_err());
        assert!(DimensionUm::parse(value).is_err());
    }
    assert!(DimensionUm::parse(0).is_err());
    assert!(checked_js_id(0).is_err());
    assert!(checked_js_id(MAX_JS_SAFE_INTEGER + 1).is_err());
    assert!(RequiredUnitToken::parse(format!("ppu_{}", "A".repeat(32))).is_err());
    assert!(Digest::parse("a".repeat(63)).is_err());
    assert_eq!(trim_ecmascript("\u{feff} x \u{a0}"), "x");
    assert_eq!(trim_ecmascript("\u{85}x\u{85}"), "\u{85}x\u{85}");
    assert_eq!(millimetres_to_micrometres(12.345), Some(12345));
    for value in [0.0001, f64::NAN, f64::INFINITY, 1e20] {
        assert_eq!(millimetres_to_micrometres(value), None);
    }
    assert_eq!(
        PrinterGeometry::from_millimetres(0.12, 0.10, 0.08, 0.01).unwrap(),
        printer()
    );
    assert!(PrinterGeometry::from_millimetres(0.1201, 0.1, 0.08, 0.01).is_none());
    assert!(PrinterGeometry::from_millimetres(0.12, 0.1, 0.08, 0.05).is_none());
}
#[test]
fn node_grouping_with_material_override_and_color_fallback() {
    let units = [
        ('a', "XY", Some("\u{feff}"), Some("#FF6600")),
        ('b', "XY", None, Some("ff6600")),
        ('c', "skirts", Some("green"), None),
    ]
    .map(|(c, dir, color, hex)| GroupUnit {
        value: token(c).as_str().to_owned(),
        token: token(c),
        object_name: c.to_string(),
        filename: format!("{c}.stl"),
        source_directory: dir.into(),
        source_layer: "base".into(),
        role: "primary".into(),
        filament_color_id: color.map(str::to_owned),
        filament_custom_hex: hex.map(str::to_owned),
        material_type: None,
    });
    let rules = [
        GroupRule {
            id: "xy-abs".into(),
            enabled: true,
            kind: GroupKind::SetMaterial,
            field: GroupField::SourceDirectory,
            value: Some("XY".into()),
            material_type: Some("ABS".into()),
        },
        GroupRule {
            id: "materials".into(),
            enabled: true,
            kind: GroupKind::SeparateBy,
            field: GroupField::Material,
            value: None,
            material_type: None,
        },
        GroupRule {
            id: "orange".into(),
            enabled: true,
            kind: GroupKind::KeepTogether,
            field: GroupField::Color,
            value: Some("#ff6600".into()),
            material_type: None,
        },
    ];
    assert_eq!(
        serde_json::json!(layout::grouping_buckets(&units, &rules)),
        golden()["grouped"]
    );
    let interleaved = [units[0].clone(), units[2].clone(), units[1].clone()];
    assert_eq!(
        serde_json::json!(layout::grouping_buckets(&interleaved, &rules)),
        golden()["grouped"]
    );
}
