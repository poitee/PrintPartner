use axum::http::Uri;
use pp_net::target::CanonicalTarget;
use proptest::prelude::*;
use std::fmt::Write;

fn encoded(text: &str, lowercase: bool) -> String {
    let mut result = String::new();
    for byte in text.bytes() {
        if lowercase {
            write!(result, "%{byte:02x}").unwrap();
        } else {
            write!(result, "%{byte:02X}").unwrap();
        }
    }
    result
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn arbitrary_uri_bytes_are_stable(bytes in prop::collection::vec(any::<u8>(), 0..512)) {
        if let Ok(uri) = Uri::try_from(bytes)
            && let Ok(target) = CanonicalTarget::parse(&uri)
        {
            prop_assert!(target.uri.scheme().is_none());
            prop_assert!(target.uri.authority().is_none());
            prop_assert_eq!(target.uri.query(), uri.query());
            prop_assert_eq!(target.uri.path(), target.path.as_str());
            prop_assert!(target.path.starts_with('/'));
            prop_assert!(!target.path.contains("//"));
            let again = CanonicalTarget::parse(&target.uri).unwrap();
            prop_assert_eq!(again.path, target.path);
            prop_assert_eq!(again.uri, target.uri);
        }
    }

    #[test]
    fn encoded_unicode_segments_and_query_are_preserved(
        segments in prop::collection::vec("[a-zA-Z0-9 éλ中🦀]{1,16}", 1..8),
        query in prop::option::of("[a-zA-Z0-9%/?=&+._~-]{0,64}"),
    ) {
        let upper = format!("/{}", segments.iter().map(|s| encoded(s, false)).collect::<Vec<_>>().join("/"));
        let lower = format!("/{}", segments.iter().map(|s| encoded(s, true)).collect::<Vec<_>>().join("/"));
        let suffix = query.as_ref().map(|q| format!("?{q}")).unwrap_or_default();
        let a = CanonicalTarget::parse(&format!("{upper}{suffix}").parse().unwrap()).unwrap();
        let b = CanonicalTarget::parse(&format!("{lower}{suffix}").parse().unwrap()).unwrap();
        prop_assert_eq!(&a.path, &b.path);
        prop_assert_eq!(a.uri.query(), query.as_deref());
        let decoded: Vec<String> = a.path[1..].split('/').map(|s| {
            let mut bytes = Vec::new();
            let mut i = 0;
            while i < s.len() {
                if s.as_bytes()[i] == b'%' {
                    bytes.push(u8::from_str_radix(&s[i+1..i+3], 16).unwrap());
                    i += 3;
                } else {
                    bytes.push(s.as_bytes()[i]);
                    i += 1;
                }
            }
            String::from_utf8(bytes).unwrap()
        }).collect();
        prop_assert_eq!(decoded, segments);
        let again = CanonicalTarget::parse(&a.uri).unwrap();
        prop_assert_eq!(again.uri, a.uri);
    }

    #[test]
    fn unreserved_encoding_has_one_canonical_spelling(segment in "[a-zA-Z0-9_~-]{1,64}") {
        let raw = format!("/{segment}");
        let escaped = format!("/{}", encoded(&segment, true));
        let target = CanonicalTarget::parse(&escaped.parse().unwrap()).unwrap();
        prop_assert_eq!(target.path, raw);
    }

    #[test]
    fn unsafe_segments_are_rejected(
        prefix in "[a-z]{1,16}", suffix in "[a-z]{1,16}",
        unsafe_segment in prop::sample::select(vec![
            ".", "..", "%2e", "%2E%2e", ".%2e", "%2e.", "%2f", "%2F", "%5c", "%5C",
            "%25", "%252f", "%252e%252e", "%00", "%1f", "%7f", "%C2%80", "%ff",
            "%c0%af", "%ED%A0%80", "%", "%2", "%GG", "",
        ]),
    ) {
        let raw = format!("/{prefix}/{unsafe_segment}/{suffix}");
        prop_assert!(CanonicalTarget::parse(&raw.parse().unwrap()).is_err());
    }

    #[test]
    fn absolute_form_is_rejected(host in "[a-z]{1,16}", path in "[a-z]{0,32}") {
        let uri: Uri = format!("http://{host}.invalid/{path}").parse().unwrap();
        prop_assert!(CanonicalTarget::parse(&uri).is_err());
    }
}
