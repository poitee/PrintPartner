use pp_storage::production::{
    layout::{
        self, GroupField, GroupKind, GroupRule, GroupUnit, LayoutFailure, PackResult, PackedUnit,
        Placement, PlateInput, PrinterGeometry, Spacing, UnitInput,
    },
    model::{
        AcceptedPlanBasis, Digest, DimensionUm, OffsetUm, PlateId, RequiredUnitToken,
        millimetres_to_micrometres,
    },
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

#[test]
fn validates_global_tokens_zero_offsets_and_legacy_overlap_rule() {
    let expected = HashSet::from([token('a'), token('b')]);
    let unplaced = unit('a', 0, 0, Placement::Unplaced);
    let placed = unit('b', 10, 10, Placement::Auto);
    let ready = layout::validate_plates(
        vec![plate(vec![unplaced, placed])],
        &expected,
        true,
        Spacing::Clearance,
    )
    .unwrap();
    assert!(!ready[0].input.units[0].pinned);
    assert_eq!(ready[0].input.printer_id, "printer");
    let touching = vec![
        unit('a', 10, 10, Placement::Auto),
        unit('b', 40, 10, Placement::Auto),
    ];
    assert_eq!(
        layout::validate_plates(
            vec![plate(touching.clone())],
            &expected,
            true,
            Spacing::Clearance
        ),
        Err(LayoutFailure::OverlappingUnits)
    );
    assert!(
        layout::validate_plates(vec![plate(touching)], &expected, true, Spacing::OverlapOnly)
            .is_ok()
    );
}

#[test]
fn current_and_legacy_digests_are_canonical_and_distinct() {
    let expected = HashSet::from([token('a')]);
    let plate = layout::validate_plates(
        vec![plate(vec![unit('a', 10, 10, Placement::Auto)])],
        &expected,
        true,
        Spacing::Clearance,
    )
    .unwrap();
    assert_eq!(
        layout::layout_digest(&plate, 2).as_str(),
        "b75cda4a8e76f8fbbb396626bf0ecec6873354e0eba7983a7e1883aa5b66b2e3"
    );
    assert_eq!(
        layout::layout_digest(&plate, 1).as_str(),
        "69baa60a5a056a0832030ee8a190326fefa067ba0df61fa3665ef0644a55f9dd"
    );
}

#[test]
fn shelf_packing_and_fixed_unit_candidates_match_node_order() {
    let packed = layout::pack_units(
        &printer(),
        &[
            layout::PackingUnit {
                token: token('c'),
                width_um: dimension(30),
                depth_um: dimension(20),
                height_um: dimension(10),
            },
            layout::PackingUnit {
                token: token('a'),
                width_um: dimension(50),
                depth_um: dimension(30),
                height_um: dimension(10),
            },
            layout::PackingUnit {
                token: token('b'),
                width_um: dimension(40),
                depth_um: dimension(40),
                height_um: dimension(10),
            },
        ],
    );
    let PackResult::Packed(plates) = packed else {
        panic!("expected packed units")
    };
    assert_eq!(
        plates[0]
            .iter()
            .map(|unit| (
                unit.unit.token.as_str().to_owned(),
                unit.x_um.get(),
                unit.y_um.get()
            ))
            .collect::<Vec<_>>(),
        vec![
            (token('a').as_str().to_owned(), 10, 10),
            (token('b').as_str().to_owned(), 70, 10),
            (token('c').as_str().to_owned(), 10, 60)
        ]
    );
    let occupied = PackedUnit {
        unit: layout::PackingUnit {
            token: token('a'),
            width_um: dimension(30),
            depth_um: dimension(20),
            height_um: dimension(10),
        },
        x_um: offset(40),
        y_um: offset(40),
    };
    let moving = layout::PackingUnit {
        token: token('b'),
        width_um: dimension(30),
        depth_um: dimension(20),
        height_um: dimension(10),
    };
    let PackResult::Packed(around) = layout::pack_units_around(&printer(), &[occupied], &[moving])
    else {
        panic!("expected packed around fixed")
    };
    assert_eq!((around[0][1].x_um.get(), around[0][1].y_um.get()), (10, 10));
}

#[test]
fn identity_grouping_and_printer_conversion_are_checked() {
    let basis = AcceptedPlanBasis {
        profile_id: 1,
        plan_version: 2,
        plan_revision_id: 3,
        plan_revision_digest: Digest::parse("a".repeat(64)).unwrap(),
        required_unit_mapping_digest: Digest::parse("b".repeat(64)).unwrap(),
    };
    assert_eq!(
        layout::initial_plate_id(&basis, "printer", &[token('b'), token('a')])
            .unwrap()
            .as_str(),
        "plate_b0f96d52840717324f219292d3eca2a8"
    );
    let values = vec![
        GroupUnit {
            value: "a",
            token: token('a'),
            object_name: "a".into(),
            filename: "a.stl".into(),
            source_directory: "XY".into(),
            source_layer: "base".into(),
            role: "primary".into(),
            filament_color_id: Some("#FF6600".into()),
            filament_custom_hex: None,
            material_type: None,
        },
        GroupUnit {
            value: "b",
            token: token('b'),
            object_name: "b".into(),
            filename: "b.stl".into(),
            source_directory: "XY".into(),
            source_layer: "base".into(),
            role: "primary".into(),
            filament_color_id: Some("ff6600".into()),
            filament_custom_hex: None,
            material_type: None,
        },
    ];
    let buckets = layout::grouping_buckets(
        &values,
        &[GroupRule {
            id: "color".into(),
            enabled: true,
            kind: GroupKind::SeparateBy,
            field: GroupField::Color,
            value: None,
            material_type: None,
        }],
    );
    assert_eq!(buckets, vec![vec!["a", "b"]]);
    assert_eq!(millimetres_to_micrometres(12.345), Some(12_345));
    assert_eq!(millimetres_to_micrometres(0.0001), None);
}

#[test]
fn actual_node_golden_matches_callable_layout_functions() {
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/plate-layout-parity.json")).unwrap();
    let expected = HashSet::from([token('a')]);
    let mut input = plate(vec![unit('a', 10, 10, Placement::Auto)]);
    input.printer_id = "\u{feff}printer\u{feff}".into();
    input.printer_name = format!("\u{feff}{}\u{feff}", "é".repeat(200));
    input.printer_model = " Mødel 😺 ".into();
    let validated =
        layout::validate_plates(vec![input], &expected, true, Spacing::Clearance).unwrap();
    assert_eq!(validated[0].input.printer_name.chars().count(), 200);
    assert_eq!(
        layout::layout_digest(&validated, 1).as_str(),
        golden["layout"]["format1"].as_str().unwrap()
    );
    assert_eq!(
        layout::layout_digest(&validated, 2).as_str(),
        golden["layout"]["format2"].as_str().unwrap()
    );

    let basis = AcceptedPlanBasis {
        profile_id: 1,
        plan_version: 2,
        plan_revision_id: 3,
        plan_revision_digest: Digest::parse("a".repeat(64)).unwrap(),
        required_unit_mapping_digest: Digest::parse("b".repeat(64)).unwrap(),
    };
    assert_eq!(
        layout::initial_plate_id(&basis, "printer", &[token('b'), token('a')])
            .unwrap()
            .as_str(),
        golden["initialPlateId"].as_str().unwrap()
    );

    let units = [
        layout::PackingUnit {
            token: token('c'),
            width_um: dimension(30),
            depth_um: dimension(20),
            height_um: dimension(10),
        },
        layout::PackingUnit {
            token: token('a'),
            width_um: dimension(50),
            depth_um: dimension(30),
            height_um: dimension(10),
        },
        layout::PackingUnit {
            token: token('b'),
            width_um: dimension(40),
            depth_um: dimension(40),
            height_um: dimension(10),
        },
    ];
    let PackResult::Packed(packed) = layout::pack_units(&printer(), &units) else {
        panic!("expected packed units")
    };
    let actual = packed[0]
        .iter()
        .map(|unit| {
            serde_json::json!({
                "token": unit.unit.token.as_str(),
                "widthUm": unit.unit.width_um.get(),
                "depthUm": unit.unit.depth_um.get(),
                "heightUm": unit.unit.height_um.get(),
                "xUm": unit.x_um.get(),
                "yUm": unit.y_um.get(),
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        serde_json::Value::Array(actual),
        golden["packed"]["plates"][0]["units"]
    );

    let occupied = PackedUnit {
        unit: layout::PackingUnit {
            token: token('a'),
            width_um: dimension(30),
            depth_um: dimension(20),
            height_um: dimension(10),
        },
        x_um: offset(40),
        y_um: offset(40),
    };
    let moving = [
        layout::PackingUnit {
            token: token('b'),
            width_um: dimension(30),
            depth_um: dimension(20),
            height_um: dimension(10),
        },
        layout::PackingUnit {
            token: token('c'),
            width_um: dimension(50),
            depth_um: dimension(30),
            height_um: dimension(10),
        },
    ];
    let PackResult::Packed(around) = layout::pack_units_around(&printer(), &[occupied], &moving)
    else {
        panic!("expected fixed packing")
    };
    let actual = around
        .iter()
        .map(|plate| {
            serde_json::json!({
                "units": plate.iter().map(|unit| serde_json::json!({
                    "token": unit.unit.token.as_str(),
                    "widthUm": unit.unit.width_um.get(),
                    "depthUm": unit.unit.depth_um.get(),
                    "heightUm": unit.unit.height_um.get(),
                    "xUm": unit.x_um.get(),
                    "yUm": unit.y_um.get(),
                })).collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(serde_json::Value::Array(actual), golden["around"]["plates"]);

    let group_units = [
        GroupUnit {
            value: token('a').as_str().to_owned(),
            token: token('a'),
            object_name: "ä".into(),
            filename: "a.stl".into(),
            source_directory: "XY".into(),
            source_layer: "base".into(),
            role: "primary".into(),
            filament_color_id: Some("\u{feff}".into()),
            filament_custom_hex: Some("#FF6600".into()),
            material_type: None,
        },
        GroupUnit {
            value: token('b').as_str().to_owned(),
            token: token('b'),
            object_name: "b".into(),
            filename: "b.stl".into(),
            source_directory: "XY".into(),
            source_layer: "base".into(),
            role: "primary".into(),
            filament_color_id: None,
            filament_custom_hex: Some("ff6600".into()),
            material_type: None,
        },
        GroupUnit {
            value: token('c').as_str().to_owned(),
            token: token('c'),
            object_name: "c".into(),
            filename: "c.stl".into(),
            source_directory: "skirts".into(),
            source_layer: "base".into(),
            role: "accent".into(),
            filament_color_id: Some("green".into()),
            filament_custom_hex: None,
            material_type: None,
        },
    ];
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
        serde_json::json!(layout::grouping_buckets(&group_units, &rules)),
        golden["grouped"]
    );

    let converted = PrinterGeometry::from_millimetres(0.12, 0.10, 0.08, 0.01).unwrap();
    assert_eq!(converted, printer());
    assert_eq!(
        serde_json::json!({
            "bed_width_um": converted.bed_width_um.get(),
            "bed_depth_um": converted.bed_depth_um.get(),
            "bed_height_um": converted.bed_height_um.get(),
            "margin_um": converted.margin_um.get(),
        }),
        serde_json::json!({
            "bed_width_um": golden["printerConversion"]["accepted"]["bed_width_um"],
            "bed_depth_um": golden["printerConversion"]["accepted"]["bed_depth_um"],
            "bed_height_um": golden["printerConversion"]["accepted"]["bed_height_um"],
            "margin_um": golden["printerConversion"]["accepted"]["margin_um"],
        })
    );
    assert_eq!(
        PrinterGeometry::from_millimetres(0.1201, 0.10, 0.08, 0.01).is_none(),
        golden["printerConversion"]["fractionalRejected"]
            .as_bool()
            .unwrap()
    );
}

#[test]
fn invalid_printer_geometry_does_not_panic_during_packing() {
    let invalid = PrinterGeometry {
        bed_width_um: dimension(1),
        bed_depth_um: dimension(1),
        bed_height_um: dimension(1),
        margin_um: offset(1),
    };
    let unit = layout::PackingUnit {
        token: token('a'),
        width_um: dimension(1),
        depth_um: dimension(1),
        height_um: dimension(1),
    };
    assert_eq!(
        layout::pack_units(&invalid, &[unit]),
        PackResult::UnitTooLarge(token('a'))
    );
}
