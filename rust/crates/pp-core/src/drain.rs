use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct ShutdownGate {
    inner: Arc<GateInner>,
}

struct GateInner {
    open: AtomicBool,
    inflight: AtomicUsize,
    idle: Notify,
    cancel: CancellationToken,
}

pub struct TrackedShutdownWork {
    gate: ShutdownGate,
}

impl ShutdownGate {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(GateInner {
                open: AtomicBool::new(true),
                inflight: AtomicUsize::new(0),
                idle: Notify::new(),
                cancel: CancellationToken::new(),
            }),
        }
    }

    pub fn cancellation(&self) -> CancellationToken {
        self.inner.cancel.clone()
    }

    pub fn track(&self) -> Result<TrackedShutdownWork, &'static str> {
        self.inner.inflight.fetch_add(1, Ordering::AcqRel);
        if self.inner.open.load(Ordering::Acquire) {
            return Ok(TrackedShutdownWork { gate: self.clone() });
        }
        self.release_one();
        Err("shutdown rejects new mutations")
    }

    pub fn reject_new(&self) {
        self.inner.open.store(false, Ordering::Release);
        self.inner.cancel.cancel();
    }

    pub async fn wait_idle(&self, bound: Duration) -> bool {
        let started = tokio::time::Instant::now();
        loop {
            if self.inner.inflight.load(Ordering::Acquire) == 0 {
                return true;
            }
            let left = bound.saturating_sub(started.elapsed());
            if left.is_zero() {
                return self.inner.inflight.load(Ordering::Acquire) == 0;
            }
            let notified = self.inner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.inner.inflight.load(Ordering::Acquire) == 0 {
                return true;
            }
            let _ = tokio::time::timeout(left, notified).await;
        }
    }

    fn release_one(&self) {
        if self.inner.inflight.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.inner.idle.notify_waiters();
        }
    }
}

impl Drop for TrackedShutdownWork {
    fn drop(&mut self) {
        self.gate.release_one();
    }
}

impl Default for ShutdownGate {
    fn default() -> Self {
        Self::new()
    }
}
