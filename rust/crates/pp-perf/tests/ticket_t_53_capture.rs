use std::fs;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use pp_perf::{PssError, package_bytes, tree_cpu_ticks_at, utc_timestamp};

/// A procfs `stat` line with the given parent and CPU ticks in fields 14-15.
fn fake_stat(proc_root: &Path, pid: u32, comm: &str, parent: u32, utime: u64, stime: u64) {
    let dir = proc_root.join(pid.to_string());
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("stat"),
        format!("{pid} ({comm}) S {parent} {pid} {pid} 0 -1 4194560 10 0 0 0 {utime} {stime} 0 0 20 0 1 0\n"),
    )
    .unwrap();
}

#[test]
fn ticket_t_53_cpu_ticks_sum_the_root_and_its_descendants_only() {
    let proc_root = tempfile::tempdir().unwrap();
    let root = proc_root.path();
    fake_stat(root, 1, "systemd", 0, 9_000, 9_000);
    fake_stat(root, 100, "pp-server", 1, 40, 7);
    fake_stat(root, 101, "node) S 1 (", 100, 300, 25);
    fake_stat(root, 102, "pp worker", 101, 3, 2);
    fake_stat(root, 200, "unrelated", 1, 5_000, 5_000);
    fs::create_dir_all(root.join("self")).unwrap();

    assert_eq!(tree_cpu_ticks_at(root, 100), Ok(40 + 7 + 300 + 25 + 3 + 2));
    assert_eq!(tree_cpu_ticks_at(root, 102), Ok(5));
}

#[test]
fn ticket_t_53_cpu_ticks_report_a_missing_root_and_malformed_stat() {
    let proc_root = tempfile::tempdir().unwrap();
    let root = proc_root.path();
    assert_eq!(tree_cpu_ticks_at(root, 7), Err(PssError::RootMissing(7)));

    let dir = root.join("7");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("stat"), "7 (short) S 1 7 7 0\n").unwrap();
    assert!(
        matches!(tree_cpu_ticks_at(root, 7), Err(PssError::Malformed { detail, .. }) if detail == "no utime")
    );
    fs::write(dir.join("stat"), "7 (bad) S 1 7 7 0 -1 0 0 0 0 0 lots 1\n").unwrap();
    assert!(
        matches!(tree_cpu_ticks_at(root, 7), Err(PssError::Malformed { detail, .. }) if detail == "utime \"lots\" is not a number")
    );
}

#[test]
fn ticket_t_53_package_bytes_sums_files_without_following_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let package = dir.path().join("Print Partner.app");
    fs::create_dir_all(package.join("Contents/MacOS")).unwrap();
    fs::write(package.join("Contents/Info.plist"), vec![0u8; 300]).unwrap();
    fs::write(package.join("Contents/MacOS/pp-desktop"), vec![0u8; 4_000]).unwrap();
    let outside = dir.path().join("outside.bin");
    fs::write(&outside, vec![0u8; 1_000_000]).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, package.join("Contents/link")).unwrap();

    let link_bytes = if cfg!(unix) {
        fs::symlink_metadata(package.join("Contents/link"))
            .unwrap()
            .len()
    } else {
        0
    };
    assert_eq!(package_bytes(&package).unwrap(), 4_300 + link_bytes);
    assert_eq!(
        package_bytes(&package.join("Contents/MacOS/pp-desktop")).unwrap(),
        4_000
    );
    assert!(package_bytes(&dir.path().join("missing")).is_err());
}

#[test]
fn ticket_t_53_timestamps_are_utc_iso_8601() {
    let at = |seconds| utc_timestamp(UNIX_EPOCH + Duration::from_secs(seconds));
    assert_eq!(at(0), "1970-01-01T00:00:00Z");
    assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(at(1_793_271_241), "2026-10-29T10:54:01Z");
    assert_eq!(at(4_102_444_799), "2099-12-31T23:59:59Z");
}

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::OsString;
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    use pp_perf::{
        CaptureError, CaptureOptions, Comparison, Measurement, Metric, Verdict, capture_run,
        compare,
    };

    fn options(script: &str, idle_ms: u64) -> CaptureOptions {
        CaptureOptions {
            command: ["sh", "-c", script].map(OsString::from).to_vec(),
            ready_timeout: Duration::from_secs(10),
            idle: Duration::from_millis(idle_ms),
            stop_timeout: Duration::from_secs(5),
        }
    }

    /// The process has left /proc, allowing init a moment to reap an orphan.
    fn gone(pid: &str) -> bool {
        let path = Path::new("/proc").join(pid);
        for _ in 0..100 {
            if !path.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn ticket_t_53_capture_times_readiness_and_stops_the_app() {
        // The shell prints its own pid as the ready line, then sleeps idle.
        let sample = capture_run(&options("echo $$; exec sleep 30", 500)).unwrap();
        assert!(sample.startup_ready_ms > 0.0);
        assert!(sample.startup_ready_ms < 10_000.0);
        assert!(sample.idle_cpu_percent < 20.0, "{sample:?}");
        assert!(sample.pss_bytes > 0);
        assert!(
            gone(&sample.ready_line),
            "app {} still running",
            sample.ready_line
        );
    }

    #[test]
    fn ticket_t_53_capture_counts_a_busy_child_in_the_process_tree() {
        // The ready shell stays idle; its child spins one core.
        let script = "(while :; do :; done) & echo $!; wait";
        let sample = capture_run(&options(script, 1_000)).unwrap();
        assert!(sample.idle_cpu_percent > 50.0, "{sample:?}");
        assert!(
            gone(&sample.ready_line),
            "busy child {} survived",
            sample.ready_line
        );
    }

    #[test]
    fn ticket_t_53_capture_refuses_apps_that_never_get_ready() {
        assert!(matches!(
            capture_run(&options("exit 0", 0)),
            Err(CaptureError::ExitedBeforeReady)
        ));
        let mut slow = options("exec sleep 30", 0);
        slow.ready_timeout = Duration::from_millis(300);
        assert!(matches!(capture_run(&slow), Err(CaptureError::NotReady(_))));
        let mut empty = options("", 0);
        empty.command.clear();
        assert!(matches!(
            capture_run(&empty),
            Err(CaptureError::EmptyCommand)
        ));
    }

    #[test]
    fn ticket_t_53_capture_binary_writes_one_record_per_metric() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = dir.path().join("pp-server");
        std::fs::write(&artifact, b"binary under test").unwrap();
        let out = dir.path().join("run-1");
        let capture = |out: &Path| {
            Command::new(env!("CARGO_BIN_EXE_pp-perf-capture"))
                .args(["--kind", "rust-server", "--name", "pp-server", "--artifact"])
                .arg(&artifact)
                .args(["--runs", "5", "--idle-secs", "0.2", "--noise-pct", "50"])
                .args(["--printers", "5", "--rustc", "1.99.0", "--out"])
                .arg(out)
                .args(["--", "sh", "-c", "echo ready; exec sleep 30"])
                .output()
                .unwrap()
        };
        let output = capture(&out);
        assert!(output.status.success(), "{output:?}");

        let read = |file: &str| -> Measurement {
            serde_json::from_slice(&std::fs::read(out.join(file)).unwrap()).unwrap()
        };
        let startup = read("startup_ready_ms.json");
        let cpu = read("idle_cpu_percent.json");
        let pss = read("memory_linux_pss_bytes.json");
        let size = read("package_bytes.json");
        for (record, metric) in [
            (&startup, Metric::StartupReadyMs),
            (&cpu, Metric::IdleCpuPercent),
            (&pss, Metric::MemoryLinuxPssBytes),
            (&size, Metric::PackageBytes),
        ] {
            assert_eq!(record.metric, metric);
            assert_eq!(record.samples.len(), 5);
            assert_eq!(record.simulated_printers, 5);
            assert_eq!(record.machine.os, "linux");
            assert_eq!(record.artifact.kind, "rust-server");
            assert_eq!(
                record.artifact.sha256,
                "d8f1d7d7c46e8c286db2384895cb75c18010d60e5908d032a05efe73be9fc0c6"
            );
            assert_eq!(record.toolchain.rustc.as_deref(), Some("1.99.0"));
        }
        assert_eq!(size.samples, [17.0; 5]);
        assert!(pss.samples.iter().all(|&bytes| bytes > 0.0));
        // A run compares with itself: same setup, steady package size.
        assert!(matches!(
            compare(&size, &size),
            Comparison::Comparable {
                verdict: Verdict::Pass,
                ..
            }
        ));

        // A second capture into the same directory keeps the first.
        let again = capture(&out);
        assert_eq!(again.status.code(), Some(2));
        assert_eq!(read("package_bytes.json"), size);
    }
}
