use super::manifest::Groups;
use super::observation::{PreparationBudget, PreparationLimits, ReadFailure, ReadResult, Resource};
use std::sync::atomic::AtomicBool;

fn infer_within(paths: &[&str], cancelled: bool, limits: PreparationLimits) -> ReadResult<Groups> {
    let cancelled = AtomicBool::new(cancelled);
    let mut budget = PreparationBudget::new(&cancelled, limits)?;
    let paths: Vec<String> = paths.iter().map(|p| (*p).into()).collect();
    super::siblings::infer(&paths, &mut budget)
}

fn infer(paths: &[String]) -> Groups {
    let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
    match infer_within(&paths, false, PreparationLimits::default()) {
        Ok(groups) => groups,
        Err(error) => panic!("sibling inference failed: {error}"),
    }
}

type Shape = Vec<(String, Vec<(String, Vec<String>)>)>;

fn shape(paths: &[&str]) -> Shape {
    let paths: Vec<String> = paths.iter().map(|p| (*p).into()).collect();
    infer(&paths)
        .into_iter()
        .map(|(id, group)| {
            (
                id.0.as_scalar().unwrap_or_default(),
                group
                    .variants
                    .into_iter()
                    .map(|v| {
                        (
                            v.id.0.as_scalar().unwrap_or_default(),
                            v.parts
                                .into_iter()
                                .map(|p| p.0.as_scalar().unwrap_or_default())
                                .collect(),
                        )
                    })
                    .collect(),
            )
        })
        .collect()
}

type Expected<'a> = (&'a str, &'a [(&'a str, &'a [&'a str])]);

fn expect(groups: &[Expected<'_>]) -> Shape {
    groups
        .iter()
        .map(|(id, variants)| {
            (
                (*id).into(),
                variants
                    .iter()
                    .map(|(v, parts)| ((*v).into(), parts.iter().map(|p| (*p).into()).collect()))
                    .collect(),
            )
        })
        .collect()
}

fn assert_shape_in_any_order(paths: &[&str], expected: &[Expected<'_>]) {
    let mut paths = paths.to_vec();
    for _ in 0..paths.len() {
        assert_eq!(shape(&paths), expect(expected), "paths: {paths:?}");
        paths.reverse();
        assert_eq!(shape(&paths), expect(expected), "paths: {paths:?}");
        paths.reverse();
        paths.rotate_left(1);
    }
}

fn assert_selectable_shape(paths: &[&str], expected: &[Expected<'_>]) {
    for (group, variants) in shape(paths) {
        for (variant, _) in variants {
            let body = serde_json::to_vec(&serde_json::json!({
                "kit": {"selections": {&group: &variant}}
            }))
            .unwrap();
            let manifest = crate::manifest_options::KitManifest::from_request(&body)
                .unwrap_or_else(|error| panic!("unselectable {group:?}/{variant:?}: {error:?}"));
            assert_eq!(
                manifest.selection_projection(),
                vec![(group.clone().into(), vec![variant.into()])]
            );
        }
    }
    assert_shape_in_any_order(paths, expected);
}

#[test]
fn siblings_nonempty_id_selects_punctuation_parent_versions() {
    assert_selectable_shape(
        &["!!!/base.stl", "!!!/Version 2/a.stl", "!!!/Version 3/b.stl"],
        &[(
            "inferred",
            &[
                ("default", &["!!!/base.stl"]),
                ("version_2", &["!!!/Version 2/*"]),
                ("version_3", &["!!!/Version 3/*"]),
            ],
        )],
    );
}

#[test]
fn siblings_nonempty_id_selects_multiple_empty_slugs() {
    assert_selectable_shape(
        &[
            "!!!/base.stl",
            "!!!/Version 2/a.stl",
            "+++/base.stl",
            "+++/Version 2/b.stl",
        ],
        &[
            (
                "inferred",
                &[
                    ("default", &["!!!/base.stl"]),
                    ("version_2", &["!!!/Version 2/*"]),
                ],
            ),
            (
                "inferred_2",
                &[
                    ("default", &["+++/base.stl"]),
                    ("version_2", &["+++/Version 2/*"]),
                ],
            ),
        ],
    );
}

#[test]
fn siblings_nonempty_id_selects_canonical_unicode_ties() {
    assert_selectable_shape(
        &[
            "\u{30ac}/base.stl",
            "\u{30ac}/Version_A/a.stl",
            "\u{30ab}\u{3099}/base.stl",
            "\u{30ab}\u{3099}/Version_A/b.stl",
        ],
        &[
            (
                "inferred",
                &[
                    ("default", &["\u{30ab}\u{3099}/base.stl"]),
                    ("version_a", &["\u{30ab}\u{3099}/Version_A/*"]),
                ],
            ),
            (
                "inferred_2",
                &[
                    ("default", &["\u{30ac}/base.stl"]),
                    ("version_a", &["\u{30ac}/Version_A/*"]),
                ],
            ),
        ],
    );
}

#[test]
fn siblings_nonempty_id_keeps_fallback_suffix_collisions_and_root_aliases() {
    assert_selectable_shape(
        &[
            "!!!/base.stl",
            "!!!/Version A/a.stl",
            "+++/base.stl",
            "+++/Version A/b.stl",
            "inferred/base.stl",
            "inferred/Version A/c.stl",
            "inferred_2/base.stl",
            "inferred_2/Version A/d.stl",
            "base.stl",
            "Version A/e.stl",
            "root/base.stl",
            "root/Version A/f.stl",
        ],
        &[
            (
                "inferred",
                &[
                    ("default", &["!!!/base.stl"]),
                    ("version_a", &["!!!/Version A/*"]),
                ],
            ),
            (
                "inferred_2",
                &[
                    ("default", &["+++/base.stl"]),
                    ("version_a", &["+++/Version A/*"]),
                ],
            ),
            (
                "inferred_2_2",
                &[
                    ("default", &["inferred_2/base.stl"]),
                    ("version_a", &["inferred_2/Version A/*"]),
                ],
            ),
            (
                "inferred_3",
                &[
                    ("default", &["inferred/base.stl"]),
                    ("version_a", &["inferred/Version A/*"]),
                ],
            ),
            (
                "root",
                &[
                    ("default", &["root/base.stl"]),
                    ("version_a", &["root/Version A/*"]),
                ],
            ),
            (
                "root_2",
                &[("default", &["base.stl"]), ("version_a", &["Version A/*"])],
            ),
        ],
    );
}

#[test]
fn siblings_group_collision_preserves_independent_mods() {
    assert_shape_in_any_order(
        &["Mods/Red+Blue/a.stl", "Mods/Red Blue/b.stl"],
        &[
            (
                "mods_red_blue",
                &[("skip", &[]), ("include", &["Mods/Red Blue/*"])],
            ),
            (
                "mods_red_blue_2",
                &[("skip", &[]), ("include", &["Mods/Red+Blue/*"])],
            ),
        ],
    );
}

#[test]
fn siblings_group_collision_preserves_independent_options() {
    assert_shape_in_any_order(
        &[
            "A+B/Options/X/a.stl",
            "A+B/Options/Y/b.stl",
            "A B/Options/X/c.stl",
            "A B/Options/Y/d.stl",
        ],
        &[
            (
                "a_b_options",
                &[("x", &["A B/Options/X/*"]), ("y", &["A B/Options/Y/*"])],
            ),
            (
                "a_b_options_2",
                &[("x", &["A+B/Options/X/*"]), ("y", &["A+B/Options/Y/*"])],
            ),
        ],
    );
}

#[test]
fn siblings_group_collision_preserves_independent_numeric_groups() {
    assert_shape_in_any_order(
        &[
            "A+B/Size 1/a.stl",
            "A+B/Size 2/b.stl",
            "A B/Size 1/c.stl",
            "A B/Size 2/d.stl",
        ],
        &[
            (
                "a_b_size_n",
                &[("size_1", &["A B/Size 1/*"]), ("size_2", &["A B/Size 2/*"])],
            ),
            (
                "a_b_size_n_2",
                &[("size_1", &["A+B/Size 1/*"]), ("size_2", &["A+B/Size 2/*"])],
            ),
        ],
    );
    assert_shape_in_any_order(
        &[
            "Size 1/a.stl",
            "Size 2/b.stl",
            "Size+1/c.stl",
            "Size+2/d.stl",
        ],
        &[
            (
                "root_size_n",
                &[("size_1", &["Size 1/*"]), ("size_2", &["Size 2/*"])],
            ),
            (
                "root_size_n_2",
                &[("size_1", &["Size+1/*"]), ("size_2", &["Size+2/*"])],
            ),
        ],
    );
}

#[test]
fn siblings_group_collision_breaks_collation_ties_by_literal_path() {
    assert_shape_in_any_order(
        &["Mods/\u{30ac}/a.stl", "Mods/\u{30ab}\u{3099}/b.stl"],
        &[
            (
                "mods",
                &[("skip", &[]), ("include", &["Mods/\u{30ab}\u{3099}/*"])],
            ),
            (
                "mods_2",
                &[("skip", &[]), ("include", &["Mods/\u{30ac}/*"])],
            ),
        ],
    );
}

#[test]
fn siblings_group_collision_keeps_natural_suffixes_and_cross_kind_groups() {
    assert_shape_in_any_order(
        &[
            "Mods/A B/a.stl",
            "Mods/A+B/b.stl",
            "Mods/A+B_2/c.stl",
            "Mods_A_B/base.stl",
            "Mods_A_B/Version A/d.stl",
            "Mods_A_B/Version B/e.stl",
        ],
        &[
            ("mods_a_b", &[("skip", &[]), ("include", &["Mods/A B/*"])]),
            ("mods_a_b_2", &[("skip", &[]), ("include", &["Mods/A+B/*"])]),
            (
                "mods_a_b_2_2",
                &[("skip", &[]), ("include", &["Mods/A+B_2/*"])],
            ),
            (
                "mods_a_b_3",
                &[
                    ("default", &["Mods_A_B/base.stl"]),
                    ("version_a", &["Mods_A_B/Version A/*"]),
                    ("version_b", &["Mods_A_B/Version B/*"]),
                ],
            ),
        ],
    );
}

#[test]
fn siblings_group_collision_retains_one_version_aggregate_per_directory() {
    assert_shape_in_any_order(
        &[
            "A B/base.stl",
            "A B/Version A/a.stl",
            "A B/Version B/b.stl",
            "A+B/base.stl",
            "A+B/Version A/c.stl",
            "A+B/Version B/d.stl",
        ],
        &[
            (
                "a_b",
                &[
                    ("default", &["A B/base.stl"]),
                    ("version_a", &["A B/Version A/*"]),
                    ("version_b", &["A B/Version B/*"]),
                ],
            ),
            (
                "a_b_2",
                &[
                    ("default", &["A+B/base.stl"]),
                    ("version_a", &["A+B/Version A/*"]),
                    ("version_b", &["A+B/Version B/*"]),
                ],
            ),
        ],
    );
}

#[test]
fn siblings_options_preserve_folder_order_and_typed_patterns() {
    let groups = infer(&[
        "./Options/Size 10/large.stl".into(),
        "Options/Size 2/small.stl".into(),
        "Options/CAD/model.step".into(),
        "Options/images/photo.png".into(),
    ]);
    assert_eq!(groups.len(), 1);
    let (id, group) = &groups[0];
    assert_eq!(id.0.as_scalar().as_deref(), Some("options"));
    assert_eq!(group.rule, "pick_one");
    assert_eq!(
        group.label.as_ref().unwrap().0.as_scalar().as_deref(),
        Some("Options")
    );
    assert!(group.parts.is_empty());
    assert_eq!((group.min, group.max), (None, None));
    let variants: Vec<_> = group
        .variants
        .iter()
        .map(|v| {
            (
                v.id.0.as_scalar().unwrap(),
                v.label.as_ref().unwrap().0.as_scalar().unwrap(),
                v.parts
                    .iter()
                    .map(|p| p.0.as_scalar().unwrap())
                    .collect::<Vec<_>>(),
                v.excludes.len(),
            )
        })
        .collect();
    assert_eq!(
        variants,
        vec![
            (
                "size_10".into(),
                "Size 10".into(),
                vec!["Options/Size 10/*".into()],
                0
            ),
            (
                "size_2".into(),
                "Size 2".into(),
                vec!["Options/Size 2/*".into()],
                0
            ),
        ]
    );
}

#[test]
fn siblings_optional_mods_have_skip_and_include() {
    let groups = infer(&[
        r"Mods\Camera\mount.stl".into(),
        "Mods/Light/bracket.stl".into(),
    ]);
    assert_eq!(groups.len(), 2);
    for ((id, group), (expected_id, expected_label, expected_path)) in groups.iter().zip([
        ("mods_camera", "Camera (optional mod)", "Mods/Camera/*"),
        ("mods_light", "Light (optional mod)", "Mods/Light/*"),
    ]) {
        assert_eq!(id.0.as_scalar().as_deref(), Some(expected_id));
        assert_eq!(
            group.label.as_ref().unwrap().0.as_scalar().as_deref(),
            Some(expected_label)
        );
        assert_eq!(group.rule, "pick_one");
        assert_eq!(group.variants.len(), 2);
        assert_eq!(group.variants[0].id.0.as_scalar().as_deref(), Some("skip"));
        assert!(group.variants[0].parts.is_empty());
        assert_eq!(
            group.variants[1].id.0.as_scalar().as_deref(),
            Some("include")
        );
        assert_eq!(
            group.variants[1].parts[0].0.as_scalar().as_deref(),
            Some(expected_path)
        );
    }
}

#[test]
fn siblings_numeric_names_and_version_defaults() {
    let groups = infer(&["Mount 10/a.stl".into(), "Mount 2/b.stl".into()]);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].0.0.as_scalar().as_deref(), Some("root_mount_n"));
    assert_eq!(
        groups[0]
            .1
            .variants
            .iter()
            .map(|v| v.id.0.as_scalar().unwrap())
            .collect::<Vec<_>>(),
        ["mount_10", "mount_2"]
    );
    let groups = infer(&["Body/current.stl".into(), "Body/Version 2/new.stl".into()]);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].0.0.as_scalar().as_deref(), Some("body"));
    assert_eq!(
        groups[0].1.variants[0].id.0.as_scalar().as_deref(),
        Some("default")
    );
    assert_eq!(
        groups[0].1.variants[0].parts[0].0.as_scalar().as_deref(),
        Some("Body/current.stl")
    );
    assert_eq!(
        groups[0].1.variants[1].parts[0].0.as_scalar().as_deref(),
        Some("Body/Version 2/*")
    );
}

#[test]
fn siblings_ignore_archived_and_unrelated_paths() {
    assert!(infer(&[]).is_empty());
    assert!(
        infer(&[
            "flat.stl".into(),
            "plain/part.stl".into(),
            "archive/Options/A/a.stl".into(),
            "archive/Options/B/b.stl".into()
        ])
        .is_empty()
    );
}

#[test]
fn siblings_bound_candidate_and_variant_counts() {
    let paths: Vec<_> = (0..13)
        .flat_map(|n| {
            [
                format!("Set {n}/Options/A/part.stl"),
                format!("Set {n}/Options/B/part.stl"),
            ]
        })
        .collect();
    let groups = infer(&paths);
    assert_eq!(groups.len(), 12);
    assert!(groups.iter().all(|(_, g)| g.variants.len() == 2));
    let paths: Vec<_> = (0..20)
        .map(|n| format!("Options/Choice {n}/part.stl"))
        .collect();
    let groups = infer(&paths);
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].1.variants.len(), 16);
    assert_eq!(groups[1].1.variants.len(), 4);
    assert!(groups.iter().all(|(_, g)| g.variants.len() <= 16));
}

#[test]
fn siblings_root_version_default_keeps_root_files_and_names_the_group() {
    assert_eq!(
        shape(&["current.stl", "Version 2/new.stl", "docs/readme.stl"]),
        expect(&[(
            "root",
            &[
                ("default", &["current.stl"]),
                ("version_2", &["Version 2/*"]),
            ],
        )])
    );
    assert_eq!(
        shape(&[
            "base.stl",
            "Deprecated Options/A/a.stl",
            "Deprecated Options/B/b.stl"
        ]),
        expect(&[(
            "deprecated_options",
            &[
                ("default", &["base.stl"]),
                ("a", &["Deprecated Options/A/*"]),
                ("b", &["Deprecated Options/B/*"]),
            ],
        )])
    );
}

#[test]
fn siblings_variant_ids_are_unique_within_a_group() {
    assert_eq!(
        shape(&["Options/Red+Blue/a.stl", "Options/Red Blue/b.stl"]),
        expect(&[(
            "options",
            &[
                ("red_blue", &["Options/Red Blue/*"]),
                ("red_blue_2", &["Options/Red+Blue/*"]),
            ],
        )])
    );
    assert_eq!(
        shape(&[
            "Body/base.stl",
            "Body/Deprecated Options/Default/a.stl",
            "Body/Deprecated Options/Other/b.stl"
        ]),
        expect(&[(
            "body_deprecated_options",
            &[
                ("default", &["Body/base.stl"]),
                ("default_2", &["Body/Deprecated Options/Default/*"]),
                ("other", &["Body/Deprecated Options/Other/*"]),
            ],
        )])
    );
    assert_eq!(
        shape(&[
            "Options/\u{65e5}\u{672c}/a.stl",
            "Options/\u{4e2d}\u{56fd}/b.stl"
        ]),
        expect(&[(
            "options",
            &[
                ("options", &["Options/\u{4e2d}\u{56fd}/*"]),
                ("options_2", &["Options/\u{65e5}\u{672c}/*"]),
            ],
        )])
    );
}

#[test]
fn siblings_collect_every_recognized_version_folder() {
    assert_eq!(
        shape(&[
            "Body/current.stl",
            "Body/Version 2/a.stl",
            "Body/Version 3/b.stl"
        ]),
        expect(&[(
            "body",
            &[
                ("default", &["Body/current.stl"]),
                ("version_2", &["Body/Version 2/*"]),
                ("version_3", &["Body/Version 3/*"]),
            ],
        )])
    );
}

#[test]
fn siblings_numeric_inference_skips_claimed_folders() {
    let optional = expect(&[("optional", &[("skip", &[]), ("include", &["Optional/*"])])]);
    assert_eq!(
        shape(&["Optional/Size 10/a.stl", "Optional/Size 20/b.stl"]),
        optional
    );
    assert_eq!(
        shape(&["Optional/Set/Size 10/a.stl", "Optional/Set/Size 20/b.stl"]),
        optional
    );
    assert_eq!(
        shape(&[
            "65 Spindle Mount/a.stl",
            "80 Spindle Mount/b.stl",
            "Spindle Mount Kit 1/c.stl",
            "Spindle Mount Kit 2/d.stl"
        ]),
        expect(&[(
            "root_n_spindle_mount",
            &[
                ("65_spindle_mount", &["65 Spindle Mount/*"]),
                ("80_spindle_mount", &["80 Spindle Mount/*"]),
                ("spindle_mount_kit_1", &["Spindle Mount Kit 1/*"]),
                ("spindle_mount_kit_2", &["Spindle Mount Kit 2/*"]),
            ],
        )])
    );
}

#[test]
fn siblings_later_skeleton_expansion_skips_folders_claimed_earlier() {
    assert_eq!(
        shape(&[
            "Big Spindle 1/a.stl",
            "Big Spindle 2/b.stl",
            "Big Spindle Mount 1/c.stl",
            "Big Spindle Mount 2/d.stl",
            "Spindle Mount 65/e.stl",
            "Spindle Mount 80/f.stl"
        ]),
        expect(&[
            (
                "root_big_spindle_n",
                &[
                    ("big_spindle_1", &["Big Spindle 1/*"]),
                    ("big_spindle_2", &["Big Spindle 2/*"]),
                    ("big_spindle_mount_1", &["Big Spindle Mount 1/*"]),
                    ("big_spindle_mount_2", &["Big Spindle Mount 2/*"]),
                ],
            ),
            (
                "root_spindle_mount_n",
                &[
                    ("spindle_mount_65", &["Spindle Mount 65/*"]),
                    ("spindle_mount_80", &["Spindle Mount 80/*"]),
                ],
            ),
        ])
    );
}

#[test]
fn siblings_default_files_do_not_claim_numeric_subfolders() {
    assert_eq!(
        shape(&[
            "Body/a.stl",
            "Body/Version 2/v.stl",
            "Body/Size 1/s.stl",
            "Body/Size 2/t.stl"
        ]),
        expect(&[
            (
                "body",
                &[
                    ("default", &["Body/a.stl"]),
                    ("version_2", &["Body/Version 2/*"])
                ],
            ),
            (
                "body_size_n",
                &[
                    ("size_1", &["Body/Size 1/*"]),
                    ("size_2", &["Body/Size 2/*"])
                ],
            ),
        ])
    );
}

#[test]
fn siblings_underscores_separate_option_and_version_words() {
    assert_eq!(
        shape(&["Recommended_Options/A/a.stl", "Recommended_Options/B/b.stl"]),
        expect(&[(
            "recommended_options",
            &[
                ("a", &["Recommended_Options/A/*"]),
                ("b", &["Recommended_Options/B/*"]),
            ],
        )])
    );
    assert_eq!(
        shape(&["Body/a.stl", "Body/Version_2/b.stl"]),
        expect(&[(
            "body",
            &[
                ("default", &["Body/a.stl"]),
                ("version_2", &["Body/Version_2/*"])
            ],
        )])
    );
    assert!(shape(&["Body/a.stl", "Body/Conversions/b.stl"]).is_empty());
}

#[test]
fn siblings_numeric_inference_ignores_archived_folders() {
    assert!(shape(&["archive/Mount 1/a.stl", "archive/Mount 2/b.stl"]).is_empty());
    assert!(shape(&["Archived 1/a.stl", "Archived 2/b.stl"]).is_empty());
    assert_eq!(
        shape(&[
            "Spindle Mount 1/a.stl",
            "Spindle Mount 2/b.stl",
            "Archived Spindle Mount 3/c.stl"
        ]),
        expect(&[(
            "root_spindle_mount_n",
            &[
                ("spindle_mount_1", &["Spindle Mount 1/*"]),
                ("spindle_mount_2", &["Spindle Mount 2/*"]),
            ],
        )])
    );
}

#[test]
fn siblings_charge_one_node_per_folder_and_honor_cancellation() {
    let paths = ["Options/A/a.stl", "Options/B/b.stl"];
    let three = PreparationLimits {
        nodes: 3,
        ..PreparationLimits::default()
    };
    let groups = infer_within(&paths, false, three).unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].0.0.as_scalar().as_deref(), Some("options"));
    assert!(matches!(
        infer_within(&paths, false, PreparationLimits { nodes: 2, ..three }),
        Err(ReadFailure::LimitExceeded(Resource::Nodes))
    ));
    assert!(matches!(
        infer_within(&paths, true, PreparationLimits::default()),
        Err(ReadFailure::Cancelled)
    ));
    assert!(matches!(
        infer_within(&["flat.stl"], true, PreparationLimits::default()),
        Err(ReadFailure::Cancelled)
    ));
}

#[test]
fn siblings_recovery_root_version_does_not_alias_a_real_root_folder() {
    assert_eq!(
        shape(&[
            "base.stl",
            "Version 2/a.stl",
            "root/base.stl",
            "root/Version 2/b.stl",
        ]),
        expect(&[
            (
                "root",
                &[
                    ("default", &["root/base.stl"]),
                    ("version_2", &["root/Version 2/*"]),
                ],
            ),
            (
                "root_2",
                &[("default", &["base.stl"]), ("version_2", &["Version 2/*"]),],
            ),
        ])
    );
}

#[test]
fn siblings_recovery_truncated_expansion_does_not_consume_a_discarded_group() {
    let mut paths: Vec<_> = (1..=15).map(|n| format!("A Beam {n}/a.stl")).collect();
    paths.extend([
        "A Beam Mount 1/a.stl".into(),
        "A Beam Mount 2/a.stl".into(),
        "Beam Mount 65/a.stl".into(),
        "Beam Mount 80/a.stl".into(),
    ]);
    let paths: Vec<_> = paths.iter().map(String::as_str).collect();
    let groups = shape(&paths);
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].0, "root_a_beam_n");
    assert_eq!(groups[0].1.len(), 16);
    assert_eq!(
        &groups[1..],
        expect(&[(
            "root_beam_mount_n",
            &[
                ("a_beam_mount_2", &["A Beam Mount 2/*"]),
                ("beam_mount_65", &["Beam Mount 65/*"]),
                ("beam_mount_80", &["Beam Mount 80/*"]),
            ],
        )])
    );
}

#[test]
fn siblings_share_node_budget_and_refuse_excessive_depth() {
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            nodes: 3,
            ..PreparationLimits::default()
        },
    )
    .unwrap();
    budget.node(0).unwrap();
    assert!(matches!(
        super::siblings::infer(
            &["Options/A/a.stl".into(), "Options/B/b.stl".into()],
            &mut budget,
        ),
        Err(ReadFailure::LimitExceeded(Resource::Nodes))
    ));
    assert!(matches!(
        infer_within(
            &["Options/A/a.stl", "Options/B/b.stl"],
            false,
            PreparationLimits {
                depth: 1,
                ..PreparationLimits::default()
            },
        ),
        Err(ReadFailure::LimitExceeded(Resource::Depth))
    ));
}

#[test]
fn siblings_version_aggregation_respects_the_option_cap() {
    let mut paths = vec!["Body/base.stl".into()];
    paths.extend((b'A'..=b'Q').map(|n| format!("Body/Version {}/a.stl", char::from(n))));
    let paths: Vec<_> = paths.iter().map(String::as_str).collect();
    let groups = shape(&paths);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].0, "body");
    assert_eq!(groups[0].1.len(), 16);
    assert_eq!(
        &groups[0].1[..2],
        &expect(&[(
            "body",
            &[
                ("default", &["Body/base.stl"]),
                ("version_a", &["Body/Version A/*"]),
            ],
        )])[0]
            .1
    );
    assert_eq!(
        groups[0].1[15],
        ("version_o".into(), vec!["Body/Version O/*".into()])
    );
}
