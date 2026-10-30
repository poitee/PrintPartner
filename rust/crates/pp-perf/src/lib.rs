//! Performance measurement records and the regression gate (GRE-388, T-53).
//!
//! A [`Measurement`] keeps every raw sample with the machine, artifact and
//! toolchain that produced it. [`compare`] applies the 10% regression gate only
//! when both sides are comparable and repeatable; otherwise it names every
//! reason the pair cannot be compared. It never reports an improvement.

mod compare;
mod pss;
mod record;

pub use compare::{Comparison, MIN_SAMPLES, Mismatch, REGRESSION_GATE_PCT, Side, Verdict, compare};
pub use pss::{ProcessTreePss, PssError, sample_process_tree, sample_process_tree_at};
pub use record::{Artifact, Machine, Measurement, Metric, SCHEMA_VERSION, Toolchain};
