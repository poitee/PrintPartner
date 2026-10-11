//! Replays every TypeScript golden in `fixtures/parity/gcode-objects` through
//! the Rust port. Regenerate with
//! `node fixtures/parity/gcode-objects/generate.mjs`.

use pp_domain::gcode_objects::{group_objects_by_part, match_objects_to_filenames};
use std::path::PathBuf;

const CASES: [&str; 11] = [
    "test-unit-suffixes",
    "test-sliced-filename",
    "test-fuzzy-matcher",
    "test-duplicate-basenames",
    "edge-no-objects",
    "edge-duplicate-names",
    "edge-stem-nn",
    "edge-unicode-names",
    "edge-truncated-file",
    "extra-slicer-formats",
    "extra-fuzzy-ambiguous",
];

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/parity/gcode-objects")
}

fn mismatches(case: &str) -> Vec<String> {
    let path = golden_dir().join(format!("{case}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"));
    let golden = json::parse(&text);
    let input = golden.get("input");
    let names = input.get("names").strings();
    let library = input.get("libraryFilenames").strings();
    let expected = golden.get("expected");

    let groups = group_objects_by_part(&names);
    let actual_groups: Vec<_> = groups
        .iter()
        .map(|plate| {
            let objects: Vec<_> = plate
                .objects
                .iter()
                .map(|object| {
                    (
                        object.name.clone(),
                        object.stl_basename.clone(),
                        object.copy_index,
                        object.format.as_str().to_owned(),
                    )
                })
                .collect();
            (plate.stl_basename.clone(), plate.count as f64, objects)
        })
        .collect();
    let expected_groups: Vec<_> = expected
        .get("groups")
        .items()
        .iter()
        .map(|group| {
            assert_eq!(group.get("key").str(), group.get("stlBasename").str());
            let objects: Vec<_> = group
                .get("objects")
                .items()
                .iter()
                .map(|object| {
                    (
                        object.get("name").str().to_owned(),
                        object.get("stlBasename").str().to_owned(),
                        object.get("copyIndex").num(),
                        object.get("format").str().to_owned(),
                    )
                })
                .collect();
            (
                group.get("stlBasename").str().to_owned(),
                group.get("count").num(),
                objects,
            )
        })
        .collect();

    let actual_matches = match_objects_to_filenames(&groups, &library);
    let expected_matches: Vec<_> = expected
        .get("matches")
        .items()
        .iter()
        .map(|row| {
            (
                row.get("key").str().to_owned(),
                row.get("filenames").strings(),
            )
        })
        .collect();

    let mut found = Vec::new();
    if actual_groups != expected_groups {
        found.push(format!(
            "{case}: groups\n  rust: {actual_groups:?}\n  ts:   {expected_groups:?}"
        ));
    }
    if actual_matches != expected_matches {
        found.push(format!(
            "{case}: matches\n  rust: {actual_matches:?}\n  ts:   {expected_matches:?}"
        ));
    }
    found
}

macro_rules! parity_cases {
    ($($test:ident => $case:literal,)*) => {
        $(
            #[test]
            fn $test() {
                let found = mismatches($case);
                assert!(found.is_empty(), "{}", found.join("\n"));
            }
        )*
    };
}

parity_cases! {
    test_unit_suffixes => "test-unit-suffixes",
    test_sliced_filename => "test-sliced-filename",
    test_fuzzy_matcher => "test-fuzzy-matcher",
    test_duplicate_basenames => "test-duplicate-basenames",
    edge_no_objects => "edge-no-objects",
    edge_duplicate_names => "edge-duplicate-names",
    edge_stem_nn => "edge-stem-nn",
    edge_unicode_names => "edge-unicode-names",
    edge_truncated_file => "edge-truncated-file",
    extra_slicer_formats => "extra-slicer-formats",
    extra_fuzzy_ambiguous => "extra-fuzzy-ambiguous",
}

#[test]
fn every_golden_is_replayed_with_zero_mismatches() {
    let mut on_disk: Vec<String> = std::fs::read_dir(golden_dir())
        .expect("golden dir")
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().into_string().ok()?;
            name.strip_suffix(".json").map(str::to_owned)
        })
        .collect();
    on_disk.sort();
    let mut listed: Vec<String> = CASES.iter().map(|case| (*case).to_owned()).collect();
    listed.sort();
    assert_eq!(on_disk, listed, "every golden needs a parity case");

    let found: Vec<String> = CASES.iter().flat_map(|case| mismatches(case)).collect();
    println!(
        "gcode_objects parity: {} goldens, {} mismatches",
        CASES.len(),
        found.len()
    );
    assert!(found.is_empty(), "{}", found.join("\n"));
}

/// Minimal JSON reader for the goldens, so pp-domain keeps zero extra deps.
mod json {
    #[derive(Debug)]
    pub enum Value {
        /// `null`, `true` or `false`; the goldens never read them.
        Literal,
        Num(f64),
        Str(String),
        Arr(Vec<Value>),
        Obj(Vec<(String, Value)>),
    }

    impl Value {
        pub fn get(&self, key: &str) -> &Value {
            match self {
                Value::Obj(fields) => fields
                    .iter()
                    .find(|(name, _)| name == key)
                    .map(|(_, value)| value)
                    .unwrap_or_else(|| panic!("missing {key}")),
                other => panic!("expected object for {key}, got {other:?}"),
            }
        }
        pub fn items(&self) -> &[Value] {
            match self {
                Value::Arr(items) => items,
                other => panic!("expected array, got {other:?}"),
            }
        }
        pub fn str(&self) -> &str {
            match self {
                Value::Str(text) => text,
                other => panic!("expected string, got {other:?}"),
            }
        }
        pub fn num(&self) -> f64 {
            match self {
                Value::Num(number) => *number,
                other => panic!("expected number, got {other:?}"),
            }
        }
        pub fn strings(&self) -> Vec<String> {
            self.items()
                .iter()
                .map(|item| item.str().to_owned())
                .collect()
        }
    }

    pub fn parse(text: &str) -> Value {
        let mut parser = Parser {
            chars: text.chars().collect(),
            at: 0,
        };
        let value = parser.value();
        parser.space();
        assert_eq!(parser.at, parser.chars.len(), "trailing JSON");
        value
    }

    struct Parser {
        chars: Vec<char>,
        at: usize,
    }

    impl Parser {
        fn next(&mut self) -> char {
            let c = *self.chars.get(self.at).expect("unexpected end of JSON");
            self.at += 1;
            c
        }
        fn space(&mut self) {
            while matches!(self.chars.get(self.at), Some(' ' | '\n' | '\r' | '\t')) {
                self.at += 1;
            }
        }
        fn literal(&mut self, word: &str) -> Value {
            for expected in word.chars() {
                assert_eq!(self.next(), expected, "bad JSON literal");
            }
            Value::Literal
        }
        fn value(&mut self) -> Value {
            self.space();
            match self
                .chars
                .get(self.at)
                .copied()
                .expect("unexpected end of JSON")
            {
                'n' => self.literal("null"),
                't' => self.literal("true"),
                'f' => self.literal("false"),
                '"' => Value::Str(self.string()),
                '[' => {
                    self.at += 1;
                    let mut items = Vec::new();
                    self.space();
                    if self.chars.get(self.at) == Some(&']') {
                        self.at += 1;
                        return Value::Arr(items);
                    }
                    loop {
                        items.push(self.value());
                        self.space();
                        match self.next() {
                            ',' => continue,
                            ']' => return Value::Arr(items),
                            other => panic!("bad JSON array separator {other:?}"),
                        }
                    }
                }
                '{' => {
                    self.at += 1;
                    let mut fields = Vec::new();
                    self.space();
                    if self.chars.get(self.at) == Some(&'}') {
                        self.at += 1;
                        return Value::Obj(fields);
                    }
                    loop {
                        self.space();
                        let key = self.string();
                        self.space();
                        assert_eq!(self.next(), ':', "bad JSON object");
                        fields.push((key, self.value()));
                        self.space();
                        match self.next() {
                            ',' => continue,
                            '}' => return Value::Obj(fields),
                            other => panic!("bad JSON object separator {other:?}"),
                        }
                    }
                }
                _ => {
                    let start = self.at;
                    while matches!(
                        self.chars.get(self.at),
                        Some('-' | '+' | '.' | 'e' | 'E' | '0'..='9')
                    ) {
                        self.at += 1;
                    }
                    let number: String = self.chars[start..self.at].iter().collect();
                    Value::Num(number.parse().expect("bad JSON number"))
                }
            }
        }
        fn hex4(&mut self) -> u32 {
            (0..4).fold(0, |code, _| {
                code * 16 + self.next().to_digit(16).expect("bad JSON \\u escape")
            })
        }
        fn string(&mut self) -> String {
            assert_eq!(self.next(), '"', "expected JSON string");
            let mut text = String::new();
            loop {
                match self.next() {
                    '"' => return text,
                    '\\' => text.push(match self.next() {
                        '"' => '"',
                        '\\' => '\\',
                        '/' => '/',
                        'b' => '\u{8}',
                        'f' => '\u{C}',
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        'u' => {
                            let high = self.hex4();
                            let code = if (0xD800..0xDC00).contains(&high) {
                                assert_eq!((self.next(), self.next()), ('\\', 'u'));
                                0x10000 + ((high - 0xD800) << 10) + (self.hex4() - 0xDC00)
                            } else {
                                high
                            };
                            char::from_u32(code).expect("lone surrogate in golden")
                        }
                        other => panic!("bad JSON escape {other:?}"),
                    }),
                    c => text.push(c),
                }
            }
        }
    }
}
