use pp_domain::{Digest, MAX_SAFE_INTEGER, PositiveId, Quantity, Version, WireInteger, WireText};
use proptest::prelude::*;
use serde::{Deserialize, de::value::F64Deserializer};

type Integer = WireInteger<3, 17>;
type Text = WireText<2, 8>;

fn decode_float(value: f64) -> Result<Integer, serde::de::value::Error> {
    Integer::deserialize(F64Deserializer::new(value))
}

fn unicode_text(
    length: impl Into<proptest::collection::SizeRange>,
) -> impl Strategy<Value = String> {
    proptest::collection::vec(any::<char>(), length).prop_map(|chars| chars.into_iter().collect())
}

fn hex_digest(length: impl Into<proptest::collection::SizeRange>) -> impl Strategy<Value = String> {
    proptest::collection::vec(0u8..16, length).prop_map(|digits| {
        digits
            .into_iter()
            .map(|digit| char::from(b"0123456789abcdef"[usize::from(digit)]))
            .collect()
    })
}

proptest! {
    #[test]
    fn integer_accepts_inclusive_range(value in 3u64..=17) {
        prop_assert_eq!(Integer::new(value).unwrap().get(), value);
        prop_assert_eq!(serde_json::from_str::<Integer>(&value.to_string()).unwrap().get(), value);
        prop_assert_eq!(decode_float(value as f64).unwrap().get(), value);
    }

    #[test]
    fn integer_rejects_outside_range(value in prop_oneof![0u64..3, 18u64..=u64::MAX]) {
        prop_assert!(Integer::new(value).is_err());
        prop_assert!(serde_json::from_str::<Integer>(&value.to_string()).is_err());
        prop_assert!(decode_float(value as f64).is_err());
    }

    #[test]
    fn integer_rejects_negative_values(value in i64::MIN..0i64) {
        prop_assert!(serde_json::from_str::<Integer>(&value.to_string()).is_err());
    }

    #[test]
    fn integer_rejects_fractional_values(whole in 3u32..17, fraction in 1u32..1024) {
        let value = f64::from(whole) + f64::from(fraction) / 1024.0;
        prop_assert!(decode_float(value).is_err());
        prop_assert!(serde_json::from_str::<Integer>(&value.to_string()).is_err());
    }

    #[test]
    fn integer_round_trip(value in 3u64..=17) {
        let original = Integer::new(value).unwrap();
        let json = serde_json::to_string(&original).unwrap();
        prop_assert_eq!(json.as_str(), value.to_string());
        prop_assert_eq!(serde_json::from_str::<Integer>(&json).unwrap(), original);
    }

    #[test]
    fn safe_integer_round_trip(value in 1u64..=MAX_SAFE_INTEGER) {
        let original = PositiveId::new(value).unwrap();
        let json = serde_json::to_string(&original).unwrap();
        prop_assert_eq!(serde_json::from_str::<PositiveId>(&json).unwrap(), original);
    }

    #[test]
    fn text_accepts_unicode_scalars(value in unicode_text(2..=8)) {
        let original = Text::new(value.clone()).unwrap();
        prop_assert_eq!(original.as_str(), &value);
        let json = serde_json::to_string(&original).unwrap();
        prop_assert_eq!(json.as_str(), serde_json::to_string(&value).unwrap());
        prop_assert_eq!(serde_json::from_str::<Text>(&json).unwrap(), original);
    }

    #[test]
    fn text_rejects_outside_scalar_bounds(value in prop_oneof![unicode_text(0..2), unicode_text(9..=32)]) {
        prop_assert!(Text::new(value.clone()).is_err());
        let json = serde_json::to_string(&value).unwrap();
        prop_assert!(serde_json::from_str::<Text>(&json).is_err());
    }

    #[test]
    fn text_counts_emoji_at_both_bounds(prefix in any::<char>()) {
        for length in [1, 2, 8, 9] {
            let value = format!("{prefix}{}", "😀".repeat(length - 1));
            let expected = (2..=8).contains(&length);
            prop_assert_eq!(Text::new(value.clone()).is_ok(), expected);
            let json = serde_json::to_string(&value).unwrap();
            prop_assert_eq!(serde_json::from_str::<Text>(&json).is_ok(), expected);
        }
    }

    #[test]
    fn digest_round_trip(value in hex_digest(64)) {
        let original = Digest::new(value.clone()).unwrap();
        prop_assert_eq!(original.as_str(), &value);
        let json = serde_json::to_string(&original).unwrap();
        prop_assert_eq!(json.as_str(), serde_json::to_string(&value).unwrap());
        prop_assert_eq!(serde_json::from_str::<Digest>(&json).unwrap(), original);
    }

    #[test]
    fn digest_rejects_wrong_length(value in hex_digest(0..=128).prop_filter("not 64 bytes", |s| s.len() != 64)) {
        prop_assert!(Digest::new(value.clone()).is_err());
        let json = serde_json::to_string(&value).unwrap();
        prop_assert!(serde_json::from_str::<Digest>(&json).is_err());
    }

    #[test]
    fn digest_rejects_non_lowercase_hex(value in hex_digest(64), index in 0usize..64,
        invalid in proptest::char::range('\0', '\u{7f}').prop_filter("not lowercase hex", |c| !c.is_ascii_digit() && !('a'..='f').contains(c))) {
        let mut chars: Vec<_> = value.chars().collect();
        chars[index] = invalid;
        let value: String = chars.into_iter().collect();
        prop_assert!(Digest::new(value.clone()).is_err());
        let json = serde_json::to_string(&value).unwrap();
        prop_assert!(serde_json::from_str::<Digest>(&json).is_err());
    }
}

#[test]
fn integer_boundaries_and_aliases() {
    for value in [2, 3, 17, 18] {
        let expected = (3..=17).contains(&value);
        assert_eq!(Integer::new(value).is_ok(), expected);
        assert_eq!(
            serde_json::from_str::<Integer>(&value.to_string()).is_ok(),
            expected
        );
        assert_eq!(decode_float(value as f64).is_ok(), expected);
    }
    for value in [0, 1, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER + 1, u64::MAX] {
        let json = value.to_string();
        assert_eq!(
            serde_json::from_str::<PositiveId>(&json).is_ok(),
            (1..=MAX_SAFE_INTEGER).contains(&value)
        );
        assert_eq!(
            serde_json::from_str::<Version>(&json).is_ok(),
            value <= MAX_SAFE_INTEGER
        );
    }
    for value in [0, 1, 10_000, 10_001] {
        assert_eq!(
            serde_json::from_str::<Quantity>(&value.to_string()).is_ok(),
            (1..=10_000).contains(&value)
        );
    }
}

#[test]
fn integer_rejects_non_finite_floats() {
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(decode_float(value).is_err());
    }
}

#[test]
fn text_scalar_boundaries() {
    for value in [
        "",
        "😀",
        "😀😀",
        "😀".repeat(8).as_str(),
        "😀".repeat(9).as_str(),
        "e\u{301}",
    ] {
        let expected = (2..=8).contains(&value.chars().count());
        assert_eq!(Text::new(value.into()).is_ok(), expected);
        assert_eq!(
            serde_json::from_str::<Text>(&serde_json::to_string(value).unwrap()).is_ok(),
            expected
        );
    }
    assert!(WireText::<0, 0>::new(String::new()).is_ok());
    assert!(WireText::<0, 0>::new("😀".into()).is_err());
}

#[test]
fn digest_boundaries() {
    for length in [0, 63, 64, 65] {
        let value = "a".repeat(length);
        assert_eq!(Digest::new(value.clone()).is_ok(), length == 64);
        assert_eq!(
            serde_json::from_str::<Digest>(&serde_json::to_string(&value).unwrap()).is_ok(),
            length == 64
        );
    }
    for invalid in ['A', 'g', '😀'] {
        assert!(Digest::new(format!("{}{}", "a".repeat(63), invalid)).is_err());
    }
}
