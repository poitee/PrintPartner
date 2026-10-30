use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

/// What one sample measures. Lower is better for every metric.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Metric {
    StartupReadyMs,
    /// Each sample is the p95 Plan-save latency of one run.
    PlanSaveP95Ms,
    IdleCpuPercent,
    PackageBytes,
    MemoryLinuxPssBytes,
    MemoryMacosFootprintBytes,
    MemoryMacosRssBytes,
}

impl Metric {
    /// The only OS a memory metric may be captured on. Linux PSS and macOS
    /// footprint/RSS measure different things and are never mixed.
    pub fn required_os(self) -> Option<&'static str> {
        match self {
            Self::MemoryLinuxPssBytes => Some("linux"),
            Self::MemoryMacosFootprintBytes | Self::MemoryMacosRssBytes => Some("macos"),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Machine {
    /// `std::env::consts::OS` spelling: `linux`, `macos`, `windows`.
    pub os: String,
    pub arch: String,
    pub kernel: String,
    pub cpu_model: String,
    pub logical_cpus: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Artifact {
    /// What was measured, such as `node-server` or `rust-desktop`. Two runs
    /// compare only when the kind matches.
    pub kind: String,
    pub name: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Toolchain {
    pub rustc: Option<String>,
    pub node: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Measurement {
    pub schema: u32,
    pub metric: Metric,
    pub samples: Vec<f64>,
    /// Largest coefficient of variation, in percent, at which the samples
    /// still count as repeatable.
    pub noise_tolerance_pct: f64,
    pub simulated_printers: u32,
    pub captured_at: String,
    pub machine: Machine,
    pub artifact: Artifact,
    pub toolchain: Toolchain,
}

impl Measurement {
    /// Problems that make this record unusable on its own.
    pub(crate) fn defects(&self) -> Vec<String> {
        let mut defects = Vec::new();
        if self.schema != SCHEMA_VERSION {
            defects.push(format!("schema {} is not {SCHEMA_VERSION}", self.schema));
        }
        if let Some(index) = self.samples.iter().position(|s| !s.is_finite() || *s < 0.0) {
            defects.push(format!(
                "sample {index} is not a finite non-negative number"
            ));
        }
        if !self.noise_tolerance_pct.is_finite()
            || !(0.0..100.0).contains(&self.noise_tolerance_pct)
        {
            defects.push("noise tolerance must be at least 0 and below 100 percent".into());
        }
        if let Some(os) = self.metric.required_os()
            && self.machine.os != os
        {
            defects.push(format!(
                "{:?} is only captured on {os}, not {}",
                self.metric, self.machine.os
            ));
        }
        defects
    }
}
