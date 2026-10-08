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
        anyhow!("Usage: storage-fixture initialize|settings|hold DIRECTORY CLOCK")
    })?);
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
        owner.backup(&directory.with_extension("backup.db"))?;
    }
    println!("{}", serde_json::to_string(&ready)?);
    io::stdout().flush()?;
    if args[1] == "hold" {
        let _ = io::stdin().lock().lines().next();
    }
    owner.shutdown()?;
    Ok(())
}
