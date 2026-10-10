pub mod autosave;
pub use autosave::*;

// typify 0.5.0 emits Clone-based reference conversions even for Copy enums.
#[allow(dead_code, clippy::clone_on_copy)]
mod generated;
pub mod semantics;
