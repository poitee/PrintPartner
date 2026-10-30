use crate::record::Measurement;

/// A candidate whose median is more than this many percent above the baseline
/// median regresses.
pub const REGRESSION_GATE_PCT: f64 = 10.0;
/// Fewer samples than this on either side cannot show repeatability.
pub const MIN_SAMPLES: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Baseline,
    Candidate,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Mismatch {
    Invalid {
        side: Side,
        defect: String,
    },
    Metric,
    Os,
    Arch,
    CpuModel,
    LogicalCpus,
    ArtifactKind,
    SimulatedPrinters,
    TooFewSamples {
        side: Side,
        count: usize,
    },
    Noisy {
        side: Side,
        spread_pct: f64,
        tolerance_pct: f64,
    },
    ZeroBaseline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// At most [`REGRESSION_GATE_PCT`] worse. This includes faster or smaller
    /// candidates; the gate does not claim improvements.
    Pass,
    Regression,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Comparison {
    Comparable {
        baseline_median: f64,
        candidate_median: f64,
        change_pct: f64,
        verdict: Verdict,
    },
    NotComparable(Vec<Mismatch>),
}

pub fn compare(baseline: &Measurement, candidate: &Measurement) -> Comparison {
    let mut reasons = Vec::new();
    for (side, run) in [(Side::Baseline, baseline), (Side::Candidate, candidate)] {
        reasons.extend(
            run.defects()
                .into_iter()
                .map(|defect| Mismatch::Invalid { side, defect }),
        );
    }
    let (b, c) = (baseline, candidate);
    let checks = [
        (b.metric != c.metric, Mismatch::Metric),
        (b.machine.os != c.machine.os, Mismatch::Os),
        (b.machine.arch != c.machine.arch, Mismatch::Arch),
        (
            b.machine.cpu_model != c.machine.cpu_model,
            Mismatch::CpuModel,
        ),
        (
            b.machine.logical_cpus != c.machine.logical_cpus,
            Mismatch::LogicalCpus,
        ),
        (b.artifact.kind != c.artifact.kind, Mismatch::ArtifactKind),
        (
            b.simulated_printers != c.simulated_printers,
            Mismatch::SimulatedPrinters,
        ),
    ];
    reasons.extend(
        checks
            .into_iter()
            .filter(|(differs, _)| *differs)
            .map(|(_, reason)| reason),
    );
    if !reasons.is_empty() {
        return Comparison::NotComparable(reasons);
    }
    for (side, run) in [(Side::Baseline, b), (Side::Candidate, c)] {
        if run.samples.len() < MIN_SAMPLES {
            reasons.push(Mismatch::TooFewSamples {
                side,
                count: run.samples.len(),
            });
            continue;
        }
        let spread_pct = coefficient_of_variation_pct(&run.samples);
        if spread_pct > run.noise_tolerance_pct {
            reasons.push(Mismatch::Noisy {
                side,
                spread_pct,
                tolerance_pct: run.noise_tolerance_pct,
            });
        }
    }
    let baseline_median = median(&b.samples);
    if reasons.is_empty() && baseline_median == 0.0 {
        reasons.push(Mismatch::ZeroBaseline);
    }
    if !reasons.is_empty() {
        return Comparison::NotComparable(reasons);
    }
    let candidate_median = median(&c.samples);
    let change_pct = (candidate_median - baseline_median) / baseline_median * 100.0;
    let verdict = if change_pct > REGRESSION_GATE_PCT {
        Verdict::Regression
    } else {
        Verdict::Pass
    };
    Comparison::Comparable {
        baseline_median,
        candidate_median,
        change_pct,
        verdict,
    }
}

fn median(samples: &[f64]) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    match sorted.len() {
        0 => 0.0,
        n if n % 2 == 0 => (sorted[mid - 1] + sorted[mid]) / 2.0,
        _ => sorted[mid],
    }
}

/// Population standard deviation over the mean, in percent. All-zero samples
/// have no spread.
fn coefficient_of_variation_pct(samples: &[f64]) -> f64 {
    let n = samples.len() as f64;
    let mean = samples.iter().sum::<f64>() / n;
    if mean == 0.0 {
        return 0.0;
    }
    let variance = samples.iter().map(|s| (s - mean).powi(2)).sum::<f64>() / n;
    variance.sqrt() / mean * 100.0
}
