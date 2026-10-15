use super::manifest::Groups;

fn infer(paths: &[String]) -> Groups {
    super::siblings::infer(paths)
}

type Shape = Vec<(String, Vec<(String, Vec<String>)>)>;

fn shape(paths: &[&str]) -> Shape {
    let paths: Vec<String> = paths.iter().map(|p| (*p).into()).collect();
    infer(&paths)
        .into_iter()
        .map(|(id, group)| {
            (
                id.0.as_scalar().unwrap(),
                group
                    .variants
                    .into_iter()
                    .map(|v| {
                        (
                            v.id.0.as_scalar().unwrap(),
                            v.parts
                                .into_iter()
                                .map(|p| p.0.as_scalar().unwrap())
                                .collect(),
                        )
                    })
                    .collect(),
            )
        })
        .collect()
}

fn expect(groups: &[(&str, &[(&str, &[&str])])]) -> Shape {
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
