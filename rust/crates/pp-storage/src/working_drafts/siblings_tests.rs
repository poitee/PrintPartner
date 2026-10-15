use super::siblings::infer;

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
