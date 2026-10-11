// Shared by tests/source_path_props.rs and examples/source_path_corpus.rs.
use pp_source::{MANIFEST, SourcePath};
use proptest::prelude::*;
use unicode_normalization::is_nfc;

pub const MAX_PATH_BYTES: usize = 4096;
pub const MAX_COMPONENTS: usize = 64;

pub fn rust_accepts(path: &str) -> bool {
    SourcePath::try_from(path.to_owned()).is_ok()
}

/// The documented SourcePath contract, written independently of `TryFrom`.
pub fn reference_accepts(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    !path.is_empty()
        && path.len() <= MAX_PATH_BYTES
        && !path.chars().any(|c| matches!(c, '\\' | '\0' | ':'))
        && is_nfc(path)
        && segments.len() <= MAX_COMPONENTS
        && segments
            .iter()
            .all(|s| !s.is_empty() && *s != "." && *s != "..")
        && segments[0] != MANIFEST
}

// Interesting fragments: NFC/NFD pairs, Hangul jamo, singleton decompositions,
// astral and private-use characters, and the reserved manifest name.
const ATOMS: &[&str] = &[
    "café",
    "cafe\u{301}",
    "\u{1100}\u{1161}",
    "\u{ac00}",
    "\u{212b}",
    "\u{c5}",
    "\u{344}",
    "\u{1f600}",
    "\u{e000}",
    "\u{feff}",
    "\u{200b}",
    "~",
    "%2e",
    "%2F",
    " ",
    "-",
    MANIFEST,
];

pub fn safe_segment() -> impl Strategy<Value = String> {
    prop_oneof![
        "[A-Za-z0-9_-][A-Za-z0-9 _.-]{0,15}",
        "[A-Za-z0-9 _-]{0,4}[.][A-Za-z0-9]{1,4}"
            .prop_filter("dot segment", |s| s != "." && s != ".."),
        prop::sample::select(
            &[
                "café",
                "\u{ac00}",
                "\u{c5}",
                "\u{1f600}",
                "\u{e000}",
                "parts",
                "README.md"
            ][..]
        )
        .prop_map(str::to_owned),
    ]
}

/// Paths built only from segments the contract accepts.
pub fn valid_path() -> impl Strategy<Value = String> {
    prop::collection::vec(safe_segment(), 1..8)
        .prop_map(|segments| segments.join("/"))
        .prop_filter("first segment reserved", |p| {
            p.split('/').next() != Some(MANIFEST)
        })
}

fn fragment() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => "[A-Za-z0-9 _.-]{1,6}",
        2 => prop::sample::select(ATOMS).prop_map(str::to_owned),
        2 => prop::sample::select(&[".", "..", "\\", "\0", ":", "/", "//"][..]).prop_map(str::to_owned),
        1 => any::<char>().prop_map(String::from),
        1 => prop::char::range('\u{300}', '\u{36f}').prop_map(String::from),
    ]
}

fn segment() -> impl Strategy<Value = String> {
    prop_oneof![
        8 => prop::collection::vec(fragment(), 1..4).prop_map(|parts| parts.concat()),
        1 => Just(String::new()),
        1 => prop::sample::select(&[".", "..", MANIFEST][..]).prop_map(str::to_owned),
    ]
}

fn mixed_path() -> impl Strategy<Value = String> {
    (
        any::<bool>(),
        prop::collection::vec(segment(), 0..8),
        any::<bool>(),
    )
        .prop_map(|(leading, segments, trailing)| {
            let mut path = segments.join("/");
            if leading {
                path.insert(0, '/');
            }
            if trailing {
                path.push('/');
            }
            path
        })
}

/// Paths around the 64-component and 4096-byte bounds.
fn bound_path() -> impl Strategy<Value = String> {
    prop_oneof![
        (MAX_COMPONENTS - 2..MAX_COMPONENTS + 3, safe_segment())
            .prop_map(|(count, segment)| vec![segment; count].join("/")),
        (
            MAX_PATH_BYTES - 3..MAX_PATH_BYTES + 4,
            prop::sample::select(&["a", "é", "\u{ac00}", "\u{1f600}"][..])
        )
            .prop_map(|(target, filler)| {
                let mut path = String::new();
                let mut chars = 0;
                while path.len() + filler.len() <= target {
                    chars += 1;
                    path.push_str(if chars % 50 == 0 { "/" } else { filler });
                }
                path
            },),
    ]
}

// U+1ADD acquired a combining class in Unicode 17. Rust's pinned Unicode 16
// normalizer and Node 24.21.0 disagree on the first spelling (GRE-555).
fn unicode_version_path() -> impl Strategy<Value = String> {
    (
        valid_path(),
        prop::sample::select(&["a\u{1add}\u{300}", "\u{e0}\u{1add}", "a:\u{1add}\u{300}"][..]),
        any::<bool>(),
    )
        .prop_map(|(prefix, spelling, colon)| {
            format!("{prefix}/{spelling}{}.stl", if colon { ":" } else { "" })
        })
}

/// Mixed corpus: mostly hostile paths, with valid and boundary paths in the mix.
/// Rust char/String strategies produce Unicode scalar values, excluding lone
/// UTF-16 surrogates. Those Node-only strings are outside this shared corpus.
pub fn any_path() -> impl Strategy<Value = String> {
    prop_oneof![
        6 => mixed_path(),
        2 => valid_path(),
        1 => bound_path(),
        1 => any::<String>(),
        1 => unicode_version_path(),
    ]
}
