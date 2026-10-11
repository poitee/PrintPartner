//! Emits a deterministic SourcePath corpus with Rust accept/reject decisions
//! for rust/tests/source-artifacts/source-path-replay.mjs.
//!
//! Usage: source_path_corpus [--cases N] [--seed HEX64]

#[path = "../tests/support/source_path.rs"]
mod source_path;

use proptest::{
    strategy::{Strategy, ValueTree},
    test_runner::{Config, RngAlgorithm, TestRng, TestRunner},
};
use serde::{Deserialize, Serialize};
use source_path::{any_path, reference_accepts, rust_accepts};
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
    rust_nfc: String,
}

impl Case {
    fn new(path: String, origin: &'static str) -> Self {
        let rust_accepts = rust_accepts(&path);
        // Exercise the independent model here too; do not suppress unused code
        // just because this support module is also compiled in integration tests.
        assert_eq!(rust_accepts, reference_accepts(&path), "{path:?}");
        Self {
            rust_accepts,
            rust_nfc: path.nfc().collect(),
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
    cases: Vec<Case>,
}

fn main() {
    let mut cases = 20_000usize;
    let mut seed = DEFAULT_SEED.to_owned();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .unwrap_or_else(|| panic!("{flag} needs a value"));
        match flag.as_str() {
            "--cases" => cases = value.parse().expect("--cases must be an integer"),
            "--seed" => seed = value,
            _ => panic!("unknown flag {flag}"),
        }
    }
    let seed_bytes: [u8; 32] = hex::decode(&seed)
        .expect("--seed must be hex")
        .try_into()
        .expect("--seed must be 32 bytes");

    let fixtures: Vec<Fixture> =
        serde_json::from_str(include_str!("../tests/fixtures/source-path-cases.json")).unwrap();
    let mut corpus: Vec<Case> = fixtures
        .into_iter()
        .map(|f| Case::new(f.path, "fixture"))
        .collect();

    let mut runner = TestRunner::new_with_rng(
        Config::default(),
        TestRng::from_seed(RngAlgorithm::ChaCha, &seed_bytes),
    );
    let strategy = any_path();
    for _ in 0..cases {
        let path = strategy.new_tree(&mut runner).unwrap().current();
        corpus.push(Case::new(path, "generated"));
    }

    let out = Corpus {
        seed,
        generated: cases,
        rust_unicode_version: UNICODE_VERSION,
        cases: corpus,
    };
    serde_json::to_writer(std::io::stdout().lock(), &out).unwrap();
}
