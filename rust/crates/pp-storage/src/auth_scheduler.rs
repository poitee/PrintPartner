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
pub(super) fn schedule(queue: &mut Queue, now: Instant) -> Option<Scheduled> {
    let eligible = queue.auth_ready.iter().position(|work| work.eligible(now));
    if let Some(index) = eligible
        && (queue.pending.is_empty() || matches!(queue.next, QueueClass::Auth))
    {
        queue.next = QueueClass::Normal;
        return queue.auth_ready.remove(index).map(Scheduled::Auth);
    }
    let normal = queue.pending.pop_front()?;
    queue.next = QueueClass::Auth;
    Some(Scheduled::Normal(normal))
}
