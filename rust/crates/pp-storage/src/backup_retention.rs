//! Pre-upgrade backup retention (T-8-archive). After an upgrade commits, keep
//! every copy it wrote, including its rollback copy, plus the three newest
//! verified `pre-schema*.db` copies left by earlier upgrades. Only this crate's own files are candidates: Node's pre-update and
//! manual `.tar.gz` archives, temporary `.backup-*.db` files and SQLite
//! sidecars are never touched. A file that fails verification is kept and
//! reported, never deleted.

use rusqlite::{Connection, OpenFlags};
use std::{
    path::{Path, PathBuf},
    time::SystemTime,
};

pub(crate) const KEEP_VERIFIED: usize = 3;

#[derive(Debug, Default)]
pub(crate) struct Pruned {
    pub removed: Vec<PathBuf>,
    pub warnings: Vec<String>,
}

/// `pre-schema{N}.db` or `pre-schema{N}-to-{M}.db`, nothing else.
fn is_candidate(name: &str) -> bool {
    let Some(versions) = name
        .strip_prefix("pre-schema")
        .and_then(|rest| rest.strip_suffix(".db"))
    else {
        return false;
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    match versions.split_once("-to-") {
        Some((from, to)) => digits(from) && digits(to),
        None => digits(versions),
    }
}

/// Opens the copy as an immutable read-only URI, so verification creates no
/// `-wal` or `-shm` file, and requires `integrity_check` to return `ok`.
fn verified(path: &Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    let mut uri = String::from("file:");
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri.push_str("?immutable=1");
    Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .and_then(|check| check.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)))
    .is_ok_and(|result| result == "ok")
}

fn remove_with_sidecars(path: &Path) -> std::io::Result<()> {
    std::fs::remove_file(path)?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        match std::fs::remove_file(PathBuf::from(sidecar)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

/// Prunes the backups directory that holds `rollback`, the from-version copy
/// of the upgrade that just committed. `written` lists the step copies that
/// upgrade wrote; they are kept too. Errors become warnings; they never fail
/// startup.
pub(crate) fn prune(rollback: &Path, written: &[PathBuf]) -> Pruned {
    let mut pruned = Pruned::default();
    let Some(directory) = rollback.parent() else {
        return pruned;
    };
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            pruned
                .warnings
                .push(format!("Read {}: {error}", directory.display()));
            return pruned;
        }
    };
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                pruned
                    .warnings
                    .push(format!("Read {}: {error}", directory.display()));
                continue;
            }
        };
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_candidate(&name) || path == rollback || written.contains(&path) {
            continue;
        }
        match path.symlink_metadata() {
            Ok(metadata) if metadata.is_file() => {
                let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                candidates.push((modified, name, path));
            }
            Ok(_) => {}
            Err(error) => pruned
                .warnings
                .push(format!("Inspect {}: {error}", path.display())),
        }
    }
    // Newest first; equal times fall back to the name so the result is stable.
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    let mut kept = 0;
    for (_, _, path) in candidates {
        if !verified(&path) {
            pruned.warnings.push(format!(
                "Kept unverified backup {}; it does not count toward the {KEEP_VERIFIED} retained",
                path.display()
            ));
        } else if kept < KEEP_VERIFIED {
            kept += 1;
        } else {
            match remove_with_sidecars(&path) {
                Ok(()) => pruned.removed.push(path),
                Err(error) => pruned
                    .warnings
                    .push(format!("Remove {}: {error}", path.display())),
            }
        }
    }
    pruned
}

#[cfg(test)]
mod tests {
    use super::is_candidate;

    #[test]
    fn ticket_t_8_archive_retention_matches_only_pre_schema_copies() {
        for name in ["pre-schema38.db", "pre-schema34-to-41.db"] {
            assert!(is_candidate(name), "{name}");
        }
        for name in [
            "pre-schema38.db-wal",
            "pre-schema38.db-shm",
            "pre-schema.db",
            "pre-schema38-to-.db",
            "pre-schemaX.db",
            "pre-schema38.db.bak",
            ".backup-0011aa.db",
            "print-partner-pre-update-to-3.9.0-schema-34-to-41.tar.gz",
            "print-partner-backup-2026-10-29T12-00-00-000Z.tar.gz",
            "PRE-SCHEMA38.db",
        ] {
            assert!(!is_candidate(name), "{name}");
        }
    }
}
