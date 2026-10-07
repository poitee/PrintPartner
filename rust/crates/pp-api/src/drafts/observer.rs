use anyhow::Result;
use pp_storage::read_model::{
    Snapshot,
    views::{FilamentLookup, ReviewObservations},
};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, atomic::AtomicBool},
};

pub type FilamentFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Box<dyn FilamentLookup + Send + Sync>>> + Send + 'a>>;

pub trait ReviewObservationPort: Send + Sync + 'static {
    fn review_observations(
        &self,
        snapshot: &Snapshot,
        cancelled: &AtomicBool,
    ) -> Result<ReviewObservations>;

    fn filament_lookup<'a>(
        &'a self,
        snapshot: &'a Snapshot,
        cancelled: Arc<AtomicBool>,
    ) -> FilamentFuture<'a>;
}
