use anyhow::{Context, Result, ensure};
use axum::http::Uri;

pub(crate) struct CanonicalTarget {
    pub(crate) uri: Uri,
    pub(crate) path: String,
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

impl CanonicalTarget {
    pub(crate) fn parse(uri: &Uri) -> Result<Self> {
        ensure!(
            uri.scheme().is_none() && uri.authority().is_none(),
            "Origin-form target required"
        );
        let raw = uri.path();
        ensure!(
            raw.starts_with('/') && !raw.contains("//"),
            "Invalid path boundary"
        );
        let mut path = String::new();
        for (index, segment) in raw.split('/').enumerate() {
            if index > 0 {
                path.push('/');
            }
            let mut decoded = Vec::new();
            let mut bytes = segment.bytes();
            while let Some(byte) = bytes.next() {
                let value = if byte == b'%' {
                    let high = bytes.next().and_then(hex).context("Malformed encoding")?;
                    let low = bytes.next().and_then(hex).context("Malformed encoding")?;
                    high * 16 + low
                } else {
                    byte
                };
                ensure!(
                    !matches!(value, b'/' | b'\\' | b'%'),
                    "Ambiguous path character"
                );
                decoded.push(value);
            }
            let text = std::str::from_utf8(&decoded).context("Invalid UTF-8 segment")?;
            ensure!(
                !text.chars().any(char::is_control),
                "Control character in path"
            );
            ensure!(text != "." && text != "..", "Traversal segment");
            for byte in decoded {
                if byte.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@".contains(&byte) {
                    path.push(char::from(byte));
                } else {
                    use std::fmt::Write;
                    write!(path, "%{byte:02X}")?;
                }
            }
        }
        let target = if let Some(query) = uri.query() {
            format!("{path}?{query}")
        } else {
            path.clone()
        };
        Ok(Self {
            uri: target.parse()?,
            path,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_and_encoded_control_characters_are_denied() {
        for code in (0..=0x1f).chain(0x7f..=0x9f) {
            let control = char::from_u32(code).unwrap();
            let raw = format!("/a{control}b");
            // Uri rejects some raw controls before they can reach the gateway.
            if let Ok(uri) = raw.parse::<Uri>() {
                assert!(CanonicalTarget::parse(&uri).is_err(), "accepted {raw:?}");
            }
            let mut encoded = String::from("/a");
            let mut buffer = [0; 4];
            for byte in control.encode_utf8(&mut buffer).bytes() {
                use std::fmt::Write;
                write!(encoded, "%{byte:02X}").unwrap();
            }
            encoded.push('b');
            assert!(
                CanonicalTarget::parse(&encoded.parse().unwrap()).is_err(),
                "accepted {encoded}"
            );
        }
    }

    #[test]
    fn encoded_segments_are_canonical_before_signing() {
        let target = CanonicalTarget::parse(
            &"/%73ources/1/stl/pi%c3%a8ce%20test.stl/mesh?x=%2f"
                .parse()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(target.path, "/sources/1/stl/pi%C3%A8ce%20test.stl/mesh");
        assert_eq!(
            target.uri.to_string(),
            "/sources/1/stl/pi%C3%A8ce%20test.stl/mesh?x=%2f"
        );
        assert_eq!(CanonicalTarget::parse(&target.uri).unwrap().uri, target.uri);
    }
    #[test]
    fn ambiguous_or_invalid_segments_are_denied() {
        for path in [
            "/a%2fb",
            "/a%5Cb",
            "/a\\b",
            "/%00",
            "/%1f",
            "/%7f",
            "/%",
            "/%2",
            "/%ZZ",
            "/%ff",
            "/%c0%af",
            "/%ED%A0%80",
            "/%2e",
            "/a/./b",
            "/a/../b",
            "/sources/1/stl/%2e%2e/mesh",
            "/.%2e",
            "/%2e.",
            "/%2E%2e",
            "/%25",
            "/%252e%252e",
            "/%252f",
            "/a//b",
            "/../b",
            "http://foreign.invalid/a",
        ] {
            assert!(
                CanonicalTarget::parse(&path.parse().unwrap()).is_err(),
                "accepted {path}"
            );
        }
    }
}
