use super::*;
use auth::rebuild as auth;

#[derive(Clone, Copy)]
pub(super) enum QueueClass {
    Normal,
    Auth,
}
pub(super) enum Scheduled {
    Normal(Envelope),
    Auth(auth::WriterWork),
}
pub(super) fn push_auth_ready(pending: &mut VecDeque<Envelope>, work: auth::WriterWork) {
    if let Some(Envelope::AuthReady { ready, .. }) = pending
        .iter_mut()
        .find(|envelope| matches!(envelope, Envelope::AuthReady { .. }))
    {
        ready.push_back(work);
    } else {
        pending.push_back(Envelope::AuthReady {
            ready: VecDeque::from([work]),
            next: QueueClass::Normal,
        });
    }
}
pub(super) fn schedule(pending: &mut VecDeque<Envelope>, now: Instant) -> Option<Scheduled> {
    let auth_envelope = pending.iter().position(|envelope| {
        matches!(
            envelope,
            Envelope::AuthReady { ready, .. } if ready.iter().any(|work| work.eligible(now))
        )
    });
    let normal = pending
        .iter()
        .position(|envelope| !matches!(envelope, Envelope::AuthReady { .. }));
    let take_auth = match (normal, auth_envelope) {
        (None, None) => return None,
        (Some(_), None) => false,
        (None, Some(_)) => true,
        (Some(_), Some(index)) => matches!(
            pending.get(index),
            Some(Envelope::AuthReady {
                next: QueueClass::Auth,
                ..
            })
        ),
    };
    if take_auth {
        let index = auth_envelope.expect("Auth work located");
        let Envelope::AuthReady { ready, next } =
            pending.get_mut(index).expect("Auth work located")
        else {
            unreachable!()
        };
        let work_index = ready
            .iter()
            .position(|work| work.eligible(now))
            .expect("Eligible auth work located");
        let work = ready
            .remove(work_index)
            .expect("Eligible auth work located");
        *next = QueueClass::Normal;
        if ready.is_empty() {
            pending.remove(index);
        }
        Some(Scheduled::Auth(work))
    } else {
        if let Some(index) = auth_envelope
            && let Some(Envelope::AuthReady { next, .. }) = pending.get_mut(index)
        {
            *next = QueueClass::Auth;
        }
        normal
            .and_then(|index| pending.remove(index))
            .map(Scheduled::Normal)
    }
}
pub(super) fn earliest_auth_retry(pending: &VecDeque<Envelope>) -> Option<Instant> {
    pending
        .iter()
        .filter_map(|envelope| match envelope {
            Envelope::AuthReady { ready, .. } => {
                ready.iter().filter_map(|work| work.retry_at()).min()
            }
            _ => None,
        })
        .min()
}
