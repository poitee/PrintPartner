//! Emits a deterministic SourcePath corpus with Rust accept/reject decisions
//! for rust/tests/source-artifacts/source-path-replay.mjs.
//!
//! Usage: source_path_corpus [--cases N] [--seed HEX64]
//! Fault-injection proof only: --test-reject PATH forces one emitted verdict
//! false while retaining its honest reference-model verdict.

#[path = "../tests/support/source_path.rs"]
mod source_path;

use proptest::{
    strategy::{Strategy, ValueTree},
    test_runner::{Config, RngAlgorithm, TestRng, TestRunner},
};
use serde::{Deserialize, Serialize};
use source_path::{any_path, reference_accepts, rust_accepts, unicode_version_fixtures};
use unicode_normalization::{UNICODE_VERSION, UnicodeNormalization};

const DEFAULT_SEED: &str = "5052494e54504152544e45522d475245353431534f5552434550415448210000";

#[derive(Deserialize)]
struct Fixture {
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    path: String,
    origin: &'static str,
    rust_accepts: bool,
    rust_reference_accepts: bool,
    rust_nfc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    rust_fixture_accepts: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rust_fixture_nfc: Option<String>,
}

impl Case {
    fn new(path: String, origin: &'static str) -> Self {
        Self {
            rust_accepts: rust_accepts(&path),
            rust_reference_accepts: reference_accepts(&path),
            rust_nfc: path.nfc().collect(),
            rust_fixture_accepts: None,
            rust_fixture_nfc: None,
            path,
            origin,
        }
    }
}

#[derive(Serialize)]
struct Corpus {
    seed: String,
    generated: usize,
    rust_unicode_version: (u8, u8, u8),
    #[serde(skip_serializing_if = "Option::is_none")]
    regression_reject: Option<String>,
    cases: Vec<Case>,
}

fn main() {
    let mut cases = 20_000usize;
    let mut seed = DEFAULT_SEED.to_owned();
    let mut regression_reject = None;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .unwrap_or_else(|| panic!("{flag} needs a value"));
        match flag.as_str() {
            "--cases" => {
                cases = value
                    .parse()
                    .unwrap_or_else(|error| panic!("--cases must be an integer: {error:?}"));
            }
            "--seed" => seed = value,
            "--test-reject" => regression_reject = Some(value),
            _ => panic!("unknown flag {flag}"),
        }
    }
    let seed_bytes: [u8; 32] = hex::decode(&seed)
        .unwrap_or_else(|error| panic!("--seed must be hex: {error:?}"))
        .try_into()
        .unwrap_or_else(|error| panic!("--seed must be 32 bytes: {error:?}"));

    let fixtures: Vec<Fixture> =
        serde_json::from_str(include_str!("../tests/fixtures/source-path-cases.json"))
            .unwrap_or_else(|error| {
                panic!("called `Result::unwrap()` on an `Err` value: {error:?}")
            });
    let mut corpus: Vec<Case> = fixtures
        .into_iter()
        .map(|f| Case::new(f.path, "fixture"))
        .collect();
    for f in unicode_version_fixtures() {
        // Let replay retain a disagreement rather than aborting before it can
        // collect Node proof. Golden NFC is checked by the Rust fixture test.
        let mut case = Case::new(f.path, "fixture");
        case.rust_fixture_accepts = Some(f.accept);
        case.rust_fixture_nfc = Some(f.rust_nfc);
        corpus.push(case);
    }

    let mut runner = TestRunner::new_with_rng(
        Config::default(),
        TestRng::from_seed(RngAlgorithm::ChaCha, &seed_bytes),
    );
    let strategy = any_path();
    for _ in 0..cases {
        let path = strategy
            .new_tree(&mut runner)
            .unwrap_or_else(|error| {
                panic!("called `Result::unwrap()` on an `Err` value: {error:?}")
            })
            .current();
        corpus.push(Case::new(path, "generated"));
    }

    if let Some(path) = &regression_reject {
        let case = corpus
            .iter_mut()
            .find(|case| &case.path == path)
            .unwrap_or_else(|| panic!("--test-reject must name an emitted case"));
        case.rust_accepts = false;
    }
    let out = Corpus {
        seed,
        generated: cases,
        rust_unicode_version: UNICODE_VERSION,
        regression_reject,
        cases: corpus,
    };
    serde_json::to_writer(std::io::stdout().lock(), &out)
        .unwrap_or_else(|error| panic!("called `Result::unwrap()` on an `Err` value: {error:?}"));
}
