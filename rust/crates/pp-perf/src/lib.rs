//! Performance measurement records and the regression gate (GRE-388, T-53).
//!
//! A [`Measurement`] keeps every raw sample with the machine, artifact and
//! toolchain that produced it. [`compare`] applies the 10% regression gate only
//! when both sides are comparable and repeatable; otherwise it names every
//! reason the pair cannot be compared. It never reports an improvement.
//! [`capture_run`] measures one run of an app process; the `pp-perf-capture`
//! binary repeats it and writes one [`Measurement`] file per metric.

mod capture;
mod compare;
mod cpu;
mod pss;
mod record;

pub use capture::{
    CaptureError, CaptureOptions, RunSample, capture_run, package_bytes, this_machine,
    utc_timestamp,
};
pub use compare::{Comparison, MIN_SAMPLES, Mismatch, REGRESSION_GATE_PCT, Side, Verdict, compare};
pub use cpu::{clock_ticks_per_second, tree_cpu_ticks, tree_cpu_ticks_at};
pub use pss::{ProcessTreePss, PssError, sample_process_tree, sample_process_tree_at};
pub use record::{Artifact, Machine, Measurement, Metric, SCHEMA_VERSION, Toolchain};
