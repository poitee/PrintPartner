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

impl TrackedShutdownWork {
    pub fn cancellation(&self) -> CancellationToken {
        self.gate.cancellation()
    }
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

pub(crate) async fn reject_and_wait<G, F>(
    bound: Duration,
    gate: &ShutdownGate,
    reject_gateway: impl FnOnce(),
    gateway_idle: F,
    disarm_restarts: impl FnOnce(),
) -> (bool, bool)
where
    F: FnOnce(Duration) -> G,
    G: std::future::Future<Output = bool>,
{
    gate.reject_new();
    reject_gateway();
    disarm_restarts();
    tokio::join!(gate.wait_idle(bound), gateway_idle(bound))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn ticket_t_3_drain_rejects_gateway_before_tracked_idle() {
        let gate = ShutdownGate::new();
        let work = gate.track().unwrap();
        let admitted = AtomicBool::new(true);
        let bound = Duration::from_millis(40);
        let (tracked_idle, gateway_idle) = reject_and_wait(
            bound,
            &gate,
            || admitted.store(false, Ordering::SeqCst),
            |bound| {
                let closed_when_wait_built = !admitted.load(Ordering::SeqCst);
                async move {
                    assert!(
                        closed_when_wait_built,
                        "gateway admissions were still open when the shared wait was built"
                    );
                    tokio::time::sleep(bound).await;
                    false
                }
            },
            || {},
        )
        .await;
        assert!(gate.track().is_err());
        assert!(!admitted.load(Ordering::SeqCst));
        assert!(!tracked_idle);
        assert!(!gateway_idle);
        drop(work);
        assert!(gate.wait_idle(Duration::from_millis(20)).await);
    }

    #[tokio::test]
    async fn ticket_t_3_drain_disarms_restarts_before_the_shared_wait() {
        let gate = ShutdownGate::new();
        let disarmed = AtomicBool::new(false);
        let bound = Duration::from_millis(20);
        let (tracked_idle, _gateway_idle) = reject_and_wait(
            bound,
            &gate,
            || {},
            |bound| {
                let disarmed_when_wait_built = disarmed.load(Ordering::SeqCst);
                async move {
                    assert!(
                        disarmed_when_wait_built,
                        "restarts were still allowed when the shared wait was built"
                    );
                    tokio::time::sleep(bound).await;
                    true
                }
            },
            || disarmed.store(true, Ordering::SeqCst),
        )
        .await;
        assert!(tracked_idle);
        assert!(disarmed.load(Ordering::SeqCst));
    }
}
