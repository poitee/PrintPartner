use super::*;
use crate::{Queue, ReaderPool, ReaderState, Shared};
use std::{
    collections::VecDeque,
    sync::{Arc, Condvar, Mutex},
};

#[test]
fn ticket_t_59_catalog_private_full_queue_retains_unreleased_work() {
    let (reply, _) = mpsc::channel();
    let shared = Arc::new(Shared {
        queue: Mutex::new(Queue {
            closed: false,
            pending: VecDeque::from([Envelope::Catalog {
                command: Command::End(999),
                reply,
            }]),
        }),
        changed: Condvar::new(),
        capacity: 1,
    });
    let readers = Arc::new(ReaderPool {
        state: Mutex::new(ReaderState {
            closed: false,
            idle: vec![],
            active: 0,
        }),
        changed: Condvar::new(),
    });
    let client = SettingsClient {
        shared: shared.clone(),
        readers,
    };
    let lease = SourceWorkLease {
        client: client.clone(),
        token: Some(17),
    };
    assert!(
        enqueue(
            &client,
            Command::End(17),
            &AtomicBool::new(false),
            Duration::ZERO
        )
        .is_err()
    );
    drop(lease);
    let mut queue = shared.queue.lock().unwrap();
    assert_eq!(queue.pending.len(), 1);
    let Envelope::Catalog {
        command: Command::End(token),
        ..
    } = queue.pending.pop_front().unwrap()
    else {
        panic!("existing queued work must survive")
    };
    assert_eq!(token, 999);
    drop(queue);
    let lease = SourceWorkLease {
        client,
        token: Some(17),
    };
    drop(lease);
    let Envelope::Catalog {
        command: Command::End(token),
        ..
    } = shared.queue.lock().unwrap().pending.pop_front().unwrap()
    else {
        panic!("release must be serialized")
    };
    assert_eq!(token, 17);
}
