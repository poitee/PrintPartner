#![no_main]

use axum::http::Uri;
use libfuzzer_sys::fuzz_target;
use pp_net::target::CanonicalTarget;

fuzz_target!(|data: &[u8]| {
    let Ok(uri) = Uri::try_from(data) else { return };
    let Ok(target) = CanonicalTarget::parse(&uri) else {
        return;
    };
    assert!(target.uri.scheme().is_none());
    assert!(target.uri.authority().is_none());
    assert_eq!(target.uri.query(), uri.query());
    assert_eq!(target.uri.path(), target.path);
    assert!(target.path.starts_with('/'));
    assert!(!target.path.contains("//"));
    // Decode once independently to check accepted segments cannot hide a boundary,
    // traversal, second encoding layer, invalid UTF-8 or control character.
    for segment in target.path.split('/') {
        let mut decoded = Vec::new();
        let mut bytes = segment.bytes();
        while let Some(byte) = bytes.next() {
            let value = if byte == b'%' {
                let pair = [bytes.next().unwrap(), bytes.next().unwrap()];
                assert!(
                    pair.iter()
                        .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(b))
                );
                u8::from_str_radix(std::str::from_utf8(&pair).unwrap(), 16).unwrap()
            } else {
                byte
            };
            assert!(!matches!(value, b'/' | b'\\' | b'%'));
            decoded.push(value);
        }
        let text = std::str::from_utf8(&decoded).unwrap();
        assert!(!text.chars().any(char::is_control));
        assert!(!matches!(text, "." | ".."));
    }
    let again = CanonicalTarget::parse(&target.uri).unwrap();
    assert_eq!(again.path, target.path);
    assert_eq!(again.uri, target.uri);
});
