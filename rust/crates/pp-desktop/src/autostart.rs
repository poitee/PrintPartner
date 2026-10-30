//! Open-at-login through a per-user macOS LaunchAgent (T-31).
//!
//! The agent lives at `~/Library/LaunchAgents/<bundle id>.plist` and starts
//! the app binary with [`MINIMIZED_ARG`] as a separate argument, so no shell
//! parses the path. The release build resolves its data directory from the
//! same home directory at login, so the agent does not pin a data path.
//! Disabling removes only this app's agent file, and only when it still
//! carries this app's label.

use anyhow::{Context, Result, ensure};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The bundle identifier from `tauri.conf.json`, also the agent label.
pub const LABEL: &str = "com.poitee.printpartner";
/// Launch argument that keeps the main window hidden at startup.
pub const MINIMIZED_ARG: &str = "--minimized";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Created,
    Updated,
    Unchanged,
    Removed,
    Absent,
}

#[derive(Debug, Clone)]
pub struct LaunchAgent {
    path: PathBuf,
    executable: PathBuf,
}

impl LaunchAgent {
    /// The agent for `executable` under `home`. Both paths must be absolute.
    pub fn new(home: &Path, executable: &Path) -> Result<Self> {
        ensure!(home.is_absolute(), "Home directory must be absolute");
        ensure!(executable.is_absolute(), "App executable must be absolute");
        Ok(Self {
            path: home
                .join("Library/LaunchAgents")
                .join(format!("{LABEL}.plist")),
            executable: executable.to_owned(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The property list text. `ProgramArguments` is an array, one string per
    /// argument, with XML escaping and no shell.
    pub fn plist(&self) -> String {
        let executable = escape(&self.executable.to_string_lossy());
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n\
             <dict>\n\
             \t<key>Label</key>\n\
             \t<string>{LABEL}</string>\n\
             \t<key>ProgramArguments</key>\n\
             \t<array>\n\
             \t\t<string>{executable}</string>\n\
             \t\t<string>{MINIMIZED_ARG}</string>\n\
             \t</array>\n\
             \t<key>RunAtLoad</key>\n\
             \t<true/>\n\
             \t<key>ProcessType</key>\n\
             \t<string>Interactive</string>\n\
             </dict>\n\
             </plist>\n"
        )
    }

    pub fn is_enabled(&self) -> bool {
        fs::read_to_string(&self.path).is_ok_and(|text| text == self.plist())
    }

    /// Writes the agent. A second call with the same executable changes
    /// nothing. The file is written to a temp name and renamed into place.
    pub fn enable(&self) -> Result<Change> {
        let wanted = self.plist();
        let existed = match fs::symlink_metadata(&self.path) {
            Ok(meta) => {
                ensure!(meta.is_file(), "LaunchAgent path is not a regular file");
                if fs::read_to_string(&self.path).is_ok_and(|text| text == wanted) {
                    return Ok(Change::Unchanged);
                }
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error).context("Read LaunchAgent"),
        };
        let directory = self.path.parent().context("LaunchAgent directory")?;
        fs::create_dir_all(directory).context("Create LaunchAgents directory")?;
        let temp = directory.join(format!(".{LABEL}.plist.tmp"));
        let mut file = fs::File::create(&temp).context("Write LaunchAgent")?;
        file.write_all(wanted.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &self.path).context("Publish LaunchAgent")?;
        Ok(if existed {
            Change::Updated
        } else {
            Change::Created
        })
    }

    /// Removes this app's agent. Other agents in the directory are untouched,
    /// and a file at this path that does not carry this app's label is kept.
    pub fn disable(&self) -> Result<Change> {
        match fs::symlink_metadata(&self.path) {
            Ok(meta) => {
                ensure!(meta.is_file(), "LaunchAgent path is not a regular file");
                let text = fs::read_to_string(&self.path).context("Read LaunchAgent")?;
                ensure!(
                    text.contains(&format!("<string>{LABEL}</string>")),
                    "LaunchAgent at this path does not belong to Print Partner"
                );
                fs::remove_file(&self.path).context("Remove LaunchAgent")?;
                Ok(Change::Removed)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Change::Absent),
            Err(error) => Err(error).context("Read LaunchAgent"),
        }
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
