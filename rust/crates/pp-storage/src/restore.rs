use crate::lease::StorageLease;
use anyhow::{Result, bail};
use std::path::Path;

pub struct PreparedRestore;
impl PreparedRestore {
    pub fn prepare(_owner: &StorageLease, _archive: &Path) -> Result<Self> {
        bail!("Offline restore unavailable")
    }
    pub fn activate(self, owner: &StorageLease) -> Result<()> {
        self.activate_with(owner, || Ok(()))
    }
    fn activate_with(
        self,
        _owner: &StorageLease,
        _boundary: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        bail!("Offline restore unavailable")
    }
}
pub fn recover_pending(_owner: &StorageLease) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests;
