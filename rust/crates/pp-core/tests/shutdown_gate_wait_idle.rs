use pp_core::ShutdownGate;
use std::{
    future::Future,
    task::{Context, Waker},
    time::Duration,
};
use tokio::time::{Instant, advance};

#[tokio::test(start_paused = true)]
async fn tracked_work_keeps_wait_idle_pending_until_all_work_completes() {
    let gate = ShutdownGate::new();
    let first = gate.track().unwrap();
    let last = gate.track().unwrap();
    gate.reject_new();

    let started = Instant::now();
    let wait = gate.wait_idle(Duration::from_secs(5));
    tokio::pin!(wait);
    let mut cx = Context::from_waker(Waker::noop());
    assert!(wait.as_mut().poll(&mut cx).is_pending());

    advance(Duration::from_secs(1)).await;
    drop(first);
    assert!(wait.as_mut().poll(&mut cx).is_pending());

    advance(Duration::from_secs(1)).await;
    assert!(wait.as_mut().poll(&mut cx).is_pending());
    drop(last);
    assert!(wait.await, "the last completed work must release the drain");
    assert_eq!(started.elapsed(), Duration::from_secs(2));
}

#[tokio::test(start_paused = true)]
async fn tracked_work_keeps_wait_idle_pending_until_the_deadline() {
    let gate = ShutdownGate::new();
    let work = gate.track().unwrap();
    gate.reject_new();

    let started = Instant::now();
    let wait = gate.wait_idle(Duration::from_secs(5));
    tokio::pin!(wait);
    let mut cx = Context::from_waker(Waker::noop());
    assert!(wait.as_mut().poll(&mut cx).is_pending());

    advance(Duration::from_secs(4)).await;
    assert!(wait.as_mut().poll(&mut cx).is_pending());

    advance(Duration::from_secs(1)).await;
    assert!(!wait.await, "tracked work must time out at the deadline");
    assert_eq!(started.elapsed(), Duration::from_secs(5));

    drop(work);
    assert!(gate.wait_idle(Duration::ZERO).await);
}
