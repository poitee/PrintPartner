use super::*;
use serde_json::json;

fn summary(effective: &Effective) -> Vec<(&'static str, bool, Source)> {
    effective
        .iter()
        .map(|resolved| (resolved.feature.key(), resolved.enabled, resolved.source))
        .collect()
}

fn toggles(value: serde_json::Value) -> Toggles {
    serde_json::from_value(value).unwrap()
}

#[test]
fn new_user_gets_every_feature_off_by_default() {
    let effective = resolve(&Toggles::default(), None);
    assert_eq!(
        summary(&effective),
        [
            ("farm", false, Source::Default),
            ("orders", false, Source::Default),
            ("bambu", false, Source::Default),
            ("spoolman", false, Source::Default),
        ]
    );
    assert!(!effective.enabled(Feature::Farm));
}

#[test]
fn plan_choice_beats_user_choice_and_absence_inherits() {
    let user = toggles(json!({"farm": true}));
    let user_only = resolve(&user, None);
    assert!(user_only.enabled(Feature::Farm));
    assert_eq!(
        summary(&user_only)[0..2],
        [
            ("farm", true, Source::User),
            ("orders", false, Source::Default)
        ]
    );

    let plan_off = resolve(&user, Some(&toggles(json!({"farm": false}))));
    assert!(!plan_off.enabled(Feature::Farm));
    assert_eq!(summary(&plan_off)[0], ("farm", false, Source::Plan));

    let plan_silent = resolve(&user, Some(&toggles(json!({"orders": true}))));
    assert_eq!(
        summary(&plan_silent),
        [
            ("farm", true, Source::User),
            ("orders", true, Source::Plan),
            ("bambu", false, Source::Default),
            ("spoolman", false, Source::Default),
        ]
    );
}

#[test]
fn set_patches_one_feature_and_none_clears_it() {
    let mut layer = Toggles::default();
    layer.set(Feature::Bambu, Some(true));
    layer.set(Feature::Farm, Some(false));
    assert_eq!(
        layer.iter().collect::<Vec<_>>(),
        [(Feature::Farm, false), (Feature::Bambu, true)]
    );
    layer.set(Feature::Bambu, None);
    layer.set(Feature::Farm, None);
    assert!(layer.is_empty());
    assert_eq!(layer.get(Feature::Farm), None);
}

#[test]
fn toggles_json_round_trips_and_drops_unknown_features() {
    let mut layer = Toggles::default();
    layer.set(Feature::Spoolman, Some(false));
    layer.set(Feature::Farm, Some(true));
    let text = serde_json::to_string(&layer).unwrap();
    assert_eq!(text, r#"{"farm":true,"spoolman":false}"#);
    assert_eq!(serde_json::from_str::<Toggles>(&text).unwrap(), layer);

    let newer: Toggles =
        serde_json::from_str(r#"{"farm":true,"future_thing":{"mode":"x"}}"#).unwrap();
    assert_eq!(newer.iter().collect::<Vec<_>>(), [(Feature::Farm, true)]);

    let error = serde_json::from_str::<Toggles>(r#"{"farm":"yes"}"#).unwrap_err();
    assert_eq!(
        error.to_string(),
        "invalid type: string \"yes\", expected a boolean at line 1 column 13"
    );
    assert!(serde_json::from_str::<Toggles>("[]").is_err());
}

#[test]
fn feature_keys_are_the_wire_format() {
    assert_eq!(
        serde_json::to_string(&Feature::ALL).unwrap(),
        r#"["farm","orders","bambu","spoolman"]"#
    );
    for feature in Feature::ALL {
        assert_eq!(Feature::from_key(feature.key()), Some(feature));
        let wire = serde_json::to_value(feature).unwrap();
        assert_eq!(serde_json::from_value::<Feature>(wire).unwrap(), feature);
    }
    assert_eq!(Feature::from_key("unknown"), None);
    assert_eq!(
        serde_json::from_value::<Feature>(json!("unknown"))
            .unwrap_err()
            .to_string(),
        "unknown feature `unknown`"
    );
}
