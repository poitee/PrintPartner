use anyhow::{Result, anyhow};
use pp_storage::{Limits, Setting, SettingCommand, SettingSnapshot, WriterOwner};
use std::{
    io::{self, BufRead, Write},
    path::Path,
    sync::atomic::AtomicBool,
    time::Duration,
};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let directory = Path::new(args.get(2).ok_or_else(|| {
        anyhow!("Usage: storage-fixture initialize|settings|hold|contend DIRECTORY CLOCK")
    })?);
    if args[1] == "contend" {
        return contend(directory);
    }
    let clock = args
        .get(3)
        .map(String::as_str)
        .unwrap_or("2026-10-02T00:00:00.000Z");
    let (owner, ready) = WriterOwner::open_at(
        directory,
        Limits {
            queued_writes: 2,
            readers: 2,
        },
        clock,
    )?;
    if args[1] == "settings" || args[1] == "hold" {
        let client = owner.client();
        for (tenant, key, value) in [
            ("tenant-a", "discord_notify_on_update", "1"),
            ("tenant-b", "discord_notify_on_update", "0"),
            ("tenant-a", "discord_notify_on_sync", ""),
        ] {
            client
                .submit(
                    SettingCommand::Set(Setting {
                        tenant: tenant.into(),
                        key: key.into(),
                        value: value.into(),
                    }),
                    &AtomicBool::new(false),
                    Duration::from_secs(5),
                )?
                .recv()??;
        }
        let read = client.reader(Duration::ZERO)?;
        assert_eq!(
            read.snapshot("tenant-a", "discord_notify_on_sync")?,
            SettingSnapshot::Stored { value: "".into() }
        );
        assert_eq!(
            read.get_setting("tenant-a", "discord_notify_on_sync", Some("fallback"))?,
            Some("fallback".into())
        );
        assert_eq!(read.get_setting("tenant-a", "missing", None)?, None);
        drop(read);
        for (expected, value, outcome) in [
            (SettingSnapshot::Stored { value: "".into() }, "1", true),
            (SettingSnapshot::Missing, "wrong", false),
        ] {
            let reply = client.submit(
                SettingCommand::CompareAndSet {
                    setting: Setting {
                        tenant: "tenant-a".into(),
                        key: "discord_notify_on_sync".into(),
                        value: value.into(),
                    },
                    expected,
                },
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )?;
            assert_eq!(reply.recv()??, outcome);
        }
        if args[1] == "settings" {
            owner.backup(&directory.with_extension("backup.db"))?;
        }
    }
    println!("{}", serde_json::to_string(&ready)?);
    io::stdout().flush()?;
    if args[1] == "hold" {
        for line in io::stdin().lock().lines() {
            let line = line?;
            if line.trim().is_empty() {
                break;
            }
        }
    }
    owner.shutdown()?;
    Ok(())
}

/// Stands in for the recorded Node child, which writes the owner's copy through
/// its own SQLite connection. Holds a half-finished business transaction until
/// stdin says commit; killing the process instead abandons it mid-transaction.
fn contend(directory: &Path) -> Result<()> {
    let connection = rusqlite::Connection::open(directory.join("print-partner.db"))?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let upsert = "INSERT INTO app_settings(tenant_id,key,value) VALUES('tenant-a',?1,'1') ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value";
    connection.execute_batch("BEGIN IMMEDIATE")?;
    connection.execute(upsert, ["transfer-debit"])?;
    println!("{}", serde_json::json!({"event": "locked"}));
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line)?;
    if line.trim() != "commit" {
        return Err(anyhow!("Expected commit, got {line:?}"));
    }
    connection.execute(upsert, ["transfer-credit"])?;
    connection.execute_batch("COMMIT")?;
    println!("{}", serde_json::json!({"event": "committed"}));
    io::stdout().flush()?;
    Ok(())
}
