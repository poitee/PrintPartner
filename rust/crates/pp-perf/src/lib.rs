//! Performance measurement records and the regression gate (GRE-388, T-53).
//!
//! A [`Measurement`] keeps every raw sample with the machine, artifact and
//! toolchain that produced it. [`compare`] applies the 10% regression gate only
//! when both sides are comparable and repeatable; otherwise it names every
//! reason the pair cannot be compared. It never reports an improvement.
//! Launching the app under test is `pp_core::perf_launch`, since process
//! spawning belongs to the runtime crates; this crate only reads `/proc` and
//! files.

mod compare;
mod cpu;
mod meta;
mod pss;
mod record;

pub use compare::{Comparison, MIN_SAMPLES, Mismatch, REGRESSION_GATE_PCT, Side, Verdict, compare};
pub use cpu::{clock_ticks_per_second, tree_cpu_ticks, tree_cpu_ticks_at};
pub use meta::{package_bytes, this_machine, utc_timestamp};
pub use pss::{ProcessTreePss, PssError, sample_process_tree, sample_process_tree_at};
pub use record::{Artifact, Machine, Measurement, Metric, SCHEMA_VERSION, Toolchain};
