use std::ffi::OsStr;
use std::process::Command;

pub fn command(program: impl AsRef<OsStr>) -> Command {
    Command::new(program)
}
