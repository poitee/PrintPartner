use super::*;
use std::sync::Condvar;

const DEFAULT_SESSION_SECONDS: i64 = 14 * 24 * 60 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthLifetimes {
    pub(super) session_seconds: i64,
    pub(super) key_seconds: Option<i64>,
}

impl Default for AuthLifetimes {
    fn default() -> Self {
        Self {
            session_seconds: DEFAULT_SESSION_SECONDS,
            key_seconds: None,
        }
    }
}

impl AuthLifetimes {
    pub fn shorter(session: Duration, key: Option<Duration>) -> Result<Self> {
        let session_seconds = i64::try_from(session.as_secs()).unwrap_or(i64::MAX);
        ensure!(
            session_seconds > 0 && session_seconds < DEFAULT_SESSION_SECONDS,
            AuthFailure::InvalidInput(AuthInputFailure::Policy)
        );
        let key_seconds = key.map(|value| i64::try_from(value.as_secs()).unwrap_or(i64::MAX));
        ensure!(
            key_seconds.is_none_or(|seconds| {
                seconds > 0
                    && time::OffsetDateTime::now_utc()
                        .checked_add(time::Duration::seconds(seconds))
                        .is_some()
            }),
            AuthFailure::InvalidInput(AuthInputFailure::Policy)
        );
        Ok(Self {
            session_seconds,
            key_seconds,
        })
    }
}

#[derive(Clone)]
pub struct RebuildAuthClient {
    storage: SettingsClient,
    policy: AuthPolicy,
    runtime: Arc<AuthRuntime>,
    lifetimes: AuthLifetimes,
    #[cfg(test)]
    kdf_gate: Option<Arc<TestKdfGate>>,
}
#[cfg(test)]
struct TestKdfGate {
    entered: mpsc::SyncSender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}
#[cfg(test)]
struct TestKdfRelease {
    sender: mpsc::SyncSender<()>,
    released: bool,
}
#[cfg(test)]
impl TestKdfRelease {
    fn release(&mut self) {
        self.sender.send(()).expect("KDF gate dropped");
        self.sender.send(()).expect("KDF gate dropped");
        self.released = true;
    }
}
#[cfg(test)]
impl Drop for TestKdfRelease {
    fn drop(&mut self) {
        if !self.released {
            let _ = self.sender.try_send(());
            let _ = self.sender.try_send(());
        }
    }
}
#[cfg(test)]
impl TestKdfGate {
    fn new() -> (Arc<Self>, mpsc::Receiver<()>, TestKdfRelease) {
        let (entered_send, entered_receive) = mpsc::sync_channel(2);
        let (release_send, release_receive) = mpsc::sync_channel(2);
        (
            Arc::new(Self {
                entered: entered_send,
                release: Mutex::new(release_receive),
            }),
            entered_receive,
            TestKdfRelease {
                sender: release_send,
                released: false,
            },
        )
    }

    fn wait(&self) {
        self.entered.send(()).expect("KDF gate observer dropped");
        self.release
            .lock()
            .expect("KDF gate poisoned")
            .recv()
            .expect("KDF gate release dropped");
    }
}
struct Admission {
    admitted: Mutex<usize>,
    changed: Condvar,
}
struct AuthLease {
    admission: Arc<Admission>,
}
impl Drop for AuthLease {
    fn drop(&mut self) {
        let mut admitted = self
            .admission
            .admitted
            .lock()
            .expect("Auth admission poisoned");
        *admitted -= 1;
        self.admission.changed.notify_one();
    }
}
struct Completion {
    reply: Option<mpsc::Sender<Result<Outcome>>>,
}
impl Completion {
    fn finish(mut self, result: Result<Outcome>) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(normalize_result(result));
        }
    }
}
impl Drop for Completion {
    fn drop(&mut self) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(Err(AuthFailure::CommitUnknown.into()));
        }
    }
}
struct AuthFlow {
    storage: SettingsClient,
    policy: AuthPolicy,
    runtime: Arc<AuthRuntime>,
    lifetimes: AuthLifetimes,
    cancelled: Arc<AtomicBool>,
    completion: Completion,
    _lease: AuthLease,
    #[cfg(test)]
    kdf_gate: Option<Arc<TestKdfGate>>,
}
impl AuthFlow {
    fn finish(self, result: Result<Outcome>) {
        self.completion.finish(result);
    }
}
enum WriterStage {
    Begin(Request),
    KdfReady {
        task: KdfTask,
        continuation: Continuation,
    },
    Resume {
        continuation: Continuation,
        result: Result<KdfOutcome>,
    },
}
pub(crate) struct WriterWork {
    flow: AuthFlow,
    stage: WriterStage,
    ready_since: Instant,
    retry_not_before: Option<Instant>,
}
impl WriterWork {
    fn begin(flow: AuthFlow, request: Request) -> Self {
        Self {
            flow,
            stage: WriterStage::Begin(request),
            ready_since: Instant::now(),
            retry_not_before: None,
        }
    }
    fn resume(flow: AuthFlow, continuation: Continuation, result: Result<KdfOutcome>) -> Self {
        Self {
            flow,
            stage: WriterStage::Resume {
                continuation,
                result,
            },
            ready_since: Instant::now(),
            retry_not_before: None,
        }
    }
    pub(crate) fn eligible(&self, now: Instant) -> bool {
        self.retry_not_before.is_none_or(|retry| retry <= now)
    }
    pub(crate) fn retry_at(&self) -> Option<Instant> {
        self.retry_not_before
    }
}
enum KdfTask {
    HashNewPassword(Secret),
    Login {
        password: Secret,
        stored: crypto::SupportedPasswordHash,
    },
    ChangePassword {
        current: Secret,
        replacement: Secret,
        stored: crypto::SupportedPasswordHash,
    },
    HashResetReplacement(Secret),
}
enum Continuation {
    Register {
        email: String,
        display_name: String,
    },
    Login(Credential),
    ChangePassword {
        session: String,
        credential: Credential,
    },
    ResetPassword {
        token: String,
    },
}
enum KdfOutcome {
    Hash(String),
    LoginVerified(Option<String>),
    ChangeVerified(String),
}
struct KdfJob {
    flow: AuthFlow,
    task: KdfTask,
    continuation: Continuation,
    writer_ready_since: Instant,
}
struct KdfPool {
    sender: mpsc::SyncSender<KdfJob>,
}
struct AuthRuntime {
    admission: Arc<Admission>,
    kdf: KdfPool,
}
impl AuthRuntime {
    fn global() -> Arc<Self> {
        static RUNTIME: OnceLock<Arc<AuthRuntime>> = OnceLock::new();
        RUNTIME
            .get_or_init(|| {
                let (sender, receiver) = mpsc::sync_channel::<KdfJob>(32);
                let receiver = Arc::new(Mutex::new(receiver));
                for _ in 0..2 {
                    let receiver = receiver.clone();
                    thread::spawn(move || {
                        loop {
                            let job = receiver.lock().expect("KDF pool poisoned").recv();
                            let Ok(job) = job else {
                                break;
                            };
                            run_kdf(job);
                        }
                    });
                }
                Arc::new(Self {
                    admission: Arc::new(Admission {
                        admitted: Mutex::new(0),
                        changed: Condvar::new(),
                    }),
                    kdf: KdfPool { sender },
                })
            })
            .clone()
    }
    fn acquire(&self, cancelled: &AtomicBool, wait: Duration) -> Result<AuthLease> {
        let deadline = Instant::now() + wait;
        let mut admitted = self
            .admission
            .admitted
            .lock()
            .map_err(|_| anyhow!("Auth admission poisoned"))?;
        loop {
            ensure!(
                !cancelled.load(Ordering::Acquire),
                "Cancelled before admission"
            );
            if *admitted < 34 {
                *admitted += 1;
                return Ok(AuthLease {
                    admission: self.admission.clone(),
                });
            }
            ensure!(Instant::now() < deadline, AuthFailure::QueueFull);
            admitted = self
                .admission
                .changed
                .wait_timeout(admitted, Duration::from_millis(2))
                .map_err(|_| anyhow!("Auth admission poisoned"))?
                .0;
        }
    }
}
fn normalize_result(result: Result<Outcome>) -> Result<Outcome> {
    result.map_err(|error| {
        if error.downcast_ref::<AuthFailure>().is_some() {
            error
        } else {
            error.context(AuthFailure::Storage)
        }
    })
}
fn run_kdf(job: KdfJob) {
    let KdfJob {
        flow,
        task,
        continuation,
        writer_ready_since: _,
    } = job;
    let result = if flow.cancelled.load(Ordering::Acquire) {
        Err(anyhow!("Cancelled before authentication"))
    } else {
        #[cfg(test)]
        if let Some(gate) = &flow.kdf_gate {
            gate.wait();
        }
        (|| -> Result<KdfOutcome> {
            match task {
                KdfTask::HashNewPassword(password) | KdfTask::HashResetReplacement(password) => {
                    crypto::hash(&password).map(KdfOutcome::Hash)
                }
                KdfTask::Login { password, stored } => {
                    ensure!(
                        crypto::verify_supported(&password, &stored),
                        AuthFailure::InvalidCredentials
                    );
                    let replacement = if stored.is_legacy() {
                        crypto::hash(&password).ok()
                    } else {
                        None
                    };
                    Ok(KdfOutcome::LoginVerified(replacement))
                }
                KdfTask::ChangePassword {
                    current,
                    replacement,
                    stored,
                } => {
                    ensure!(
                        crypto::verify_supported(&current, &stored),
                        AuthFailure::CurrentPasswordIncorrect
                    );
                    crypto::hash(&replacement).map(KdfOutcome::ChangeVerified)
                }
            }
        })()
    };
    let storage = flow.storage.clone();
    storage.enqueue_auth(WriterWork::resume(flow, continuation, result));
}
impl WriterOwner {
    pub fn rebuild_auth_with_policy(
        &self,
        policy: AuthPolicy,
        lifetimes: AuthLifetimes,
    ) -> Result<RebuildAuthClient> {
        validate_policy(policy)?;
        Ok(RebuildAuthClient {
            storage: self.client(),
            policy,
            runtime: AuthRuntime::global(),
            lifetimes,
            #[cfg(test)]
            kdf_gate: None,
        })
    }
}
impl RebuildAuthClient {
    #[cfg(test)]
    fn with_kdf_gate(&self, gate: Arc<TestKdfGate>) -> Self {
        Self {
            storage: self.storage.clone(),
            policy: self.policy,
            runtime: self.runtime.clone(),
            lifetimes: self.lifetimes,
            kdf_gate: Some(gate),
        }
    }

    pub fn submit(
        &self,
        request: Request,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
    ) -> Result<AuthReply> {
        request.validate()?;
        let lease = self.runtime.acquire(&cancelled, wait)?;
        let (reply, receiver) = mpsc::channel();
        let flow = AuthFlow {
            storage: self.storage.clone(),
            policy: self.policy,
            runtime: self.runtime.clone(),
            lifetimes: self.lifetimes,
            cancelled,
            completion: Completion { reply: Some(reply) },
            _lease: lease,
            #[cfg(test)]
            kdf_gate: self.kdf_gate.clone(),
        };
        self.storage.enqueue_auth(WriterWork::begin(flow, request));
        Ok(receiver)
    }

    #[cfg(test)]
    fn submit_verified_login(
        &self,
        credential: Credential,
        replacement: String,
    ) -> Result<AuthReply> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let lease = self.runtime.acquire(&cancelled, Duration::from_secs(5))?;
        let (reply, receiver) = mpsc::channel();
        let flow = AuthFlow {
            storage: self.storage.clone(),
            policy: self.policy,
            runtime: self.runtime.clone(),
            lifetimes: self.lifetimes,
            cancelled,
            completion: Completion { reply: Some(reply) },
            _lease: lease,
            kdf_gate: None,
        };
        self.storage.enqueue_auth(WriterWork::resume(
            flow,
            Continuation::Login(credential),
            Ok(KdfOutcome::LoginVerified(Some(replacement))),
        ));
        Ok(receiver)
    }
}

enum Prepared {
    Complete(Outcome),
    Kdf(KdfTask, Continuation),
}

pub(crate) fn finish_stopped(work: WriterWork) {
    work.flow.finish(Err(AuthFailure::Stopped.into()));
}

pub(crate) fn advance(connection: &mut Connection, work: WriterWork) -> Option<WriterWork> {
    let WriterWork {
        flow,
        stage,
        ready_since,
        retry_not_before: _,
    } = work;
    if Instant::now().duration_since(ready_since) >= Duration::from_secs(5) {
        flow.finish(Err(AuthFailure::QueueFull.into()));
        return None;
    }
    if flow.cancelled.load(Ordering::Acquire) {
        flow.finish(Err(anyhow!("Cancelled before write admission")));
        return None;
    }
    match stage {
        WriterStage::Begin(request) => match prepare(connection, &flow, request) {
            Ok(Prepared::Complete(outcome)) => {
                flow.finish(Ok(outcome));
                None
            }
            Ok(Prepared::Kdf(task, continuation)) => submit_kdf(KdfJob {
                flow,
                task,
                continuation,
                writer_ready_since: Instant::now(),
            }),
            Err(error) => {
                flow.finish(Err(error));
                None
            }
        },
        WriterStage::KdfReady { task, continuation } => submit_kdf(KdfJob {
            flow,
            task,
            continuation,
            writer_ready_since: ready_since,
        }),
        WriterStage::Resume {
            continuation,
            result,
        } => {
            let policy = flow.policy;
            let result = result.and_then(|result| {
                resume(connection, policy, flow.lifetimes, continuation, result)
            });
            flow.finish(result);
            None
        }
    }
}

fn submit_kdf(job: KdfJob) -> Option<WriterWork> {
    let runtime = job.flow.runtime.clone();
    match runtime.kdf.sender.try_send(job) {
        Ok(()) => None,
        Err(mpsc::TrySendError::Full(job)) => Some(WriterWork {
            flow: job.flow,
            stage: WriterStage::KdfReady {
                task: job.task,
                continuation: job.continuation,
            },
            ready_since: job.writer_ready_since,
            retry_not_before: Some(Instant::now() + Duration::from_millis(2)),
        }),
        Err(mpsc::TrySendError::Disconnected(job)) => {
            job.flow.finish(Err(AuthFailure::Stopped.into()));
            None
        }
    }
}

fn prepare(connection: &mut Connection, flow: &AuthFlow, request: Request) -> Result<Prepared> {
    let policy = flow.policy;
    let lifetimes = flow.lifetimes;
    match request {
        Request::Status => execute_outcome(connection, Command::Status, policy, lifetimes),
        Request::IdentityExists {
            provider,
            provider_user_id,
        } => {
            validate_identity(provider, &provider_user_id)?;
            execute_outcome(
                connection,
                Command::IdentityExists {
                    provider,
                    provider_user_id,
                },
                policy,
                lifetimes,
            )
        }
        Request::Register {
            email,
            display_name,
            password,
        } => {
            validate_email(&email)?;
            crypto::validate(&password)?;
            Ok(Prepared::Kdf(
                KdfTask::HashNewPassword(password),
                Continuation::Register {
                    email: email.to_lowercase(),
                    display_name,
                },
            ))
        }
        Request::Login { email, password } => {
            let credential = execute_credential(
                connection,
                Command::CredentialByEmail(email.to_lowercase()),
                policy,
                lifetimes,
            )?
            .ok_or_else(|| anyhow!(AuthFailure::InvalidCredentials))?;
            let stored = credential
                .hash
                .as_deref()
                .and_then(crypto::inspect)
                .ok_or_else(|| anyhow!(AuthFailure::InvalidCredentials))?;
            Ok(Prepared::Kdf(
                KdfTask::Login { password, stored },
                Continuation::Login(credential),
            ))
        }
        Request::ResolveSession { token } => execute_outcome(
            connection,
            Command::ResolveSession(crypto::digest(token.expose())),
            policy,
            lifetimes,
        ),
        Request::Logout { token } => execute_outcome(
            connection,
            Command::Logout(crypto::digest(token.expose())),
            policy,
            lifetimes,
        ),
        Request::LogoutAll { session } => execute_outcome(
            connection,
            Command::LogoutAll(crypto::digest(session.expose())),
            policy,
            lifetimes,
        ),
        Request::ChangePassword {
            session,
            current,
            replacement,
        } => {
            let session = crypto::digest(session.expose());
            let credential = execute_credential(
                connection,
                Command::CredentialBySession(session.clone()),
                policy,
                lifetimes,
            )?
            .ok_or_else(|| anyhow!(AuthFailure::SessionRequired))?;
            let hash = credential
                .hash
                .as_deref()
                .ok_or_else(|| anyhow!(AuthFailure::OAuthOnlyAccount))?;
            let stored = crypto::inspect(hash)
                .ok_or_else(|| anyhow!(AuthFailure::CurrentPasswordIncorrect))?;
            Ok(Prepared::Kdf(
                KdfTask::ChangePassword {
                    current,
                    replacement,
                    stored,
                },
                Continuation::ChangePassword {
                    session,
                    credential,
                },
            ))
        }
        Request::RequestReset { email } => execute_outcome(
            connection,
            Command::RequestReset(email.to_lowercase()),
            policy,
            lifetimes,
        ),
        Request::ResetPassword { token, replacement } => {
            crypto::validate(&replacement)?;
            Ok(Prepared::Kdf(
                KdfTask::HashResetReplacement(replacement),
                Continuation::ResetPassword {
                    token: crypto::digest(token.expose()),
                },
            ))
        }
        Request::OAuthLogin {
            provider,
            provider_user_id,
            email,
            display_name,
        } => {
            validate_identity(provider, &provider_user_id)?;
            if let Some(email) = &email {
                validate_email(email)?;
            }
            execute_outcome(
                connection,
                Command::OAuthLogin {
                    provider,
                    provider_user_id,
                    email: email.map(|email| email.to_lowercase()),
                    display_name,
                    first_user: policy.first_user,
                },
                policy,
                lifetimes,
            )
        }
        Request::LinkIdentity {
            session,
            provider,
            provider_user_id,
        } => {
            validate_identity(provider, &provider_user_id)?;
            execute_outcome(
                connection,
                Command::LinkIdentity {
                    session: crypto::digest(session.expose()),
                    provider,
                    provider_user_id,
                },
                policy,
                lifetimes,
            )
        }
        Request::ListKeys { session } => execute_outcome(
            connection,
            Command::Keys {
                session: crypto::digest(session.expose()),
                action: keys::Action::List,
            },
            policy,
            lifetimes,
        ),
        Request::CreateKey { session } => execute_outcome(
            connection,
            Command::Keys {
                session: crypto::digest(session.expose()),
                action: keys::Action::Create,
            },
            policy,
            lifetimes,
        ),
        Request::RevokeKey { session, key_id } => execute_outcome(
            connection,
            Command::Keys {
                session: crypto::digest(session.expose()),
                action: keys::Action::Revoke(key_id),
            },
            policy,
            lifetimes,
        ),
        Request::RotateKey { session, key_id } => execute_outcome(
            connection,
            Command::Keys {
                session: crypto::digest(session.expose()),
                action: keys::Action::Rotate(key_id),
            },
            policy,
            lifetimes,
        ),
        Request::ResolveKey { tenant_id, key } => execute_outcome(
            connection,
            Command::ResolveKey { tenant_id, key },
            policy,
            lifetimes,
        ),
    }
}

fn execute_outcome(
    connection: &mut Connection,
    command: Command,
    policy: AuthPolicy,
    lifetimes: AuthLifetimes,
) -> Result<Prepared> {
    match execute(
        connection,
        Command::WithLifetimes {
            command: Box::new(command),
            lifetimes,
        },
        policy,
    )? {
        Reply::Outcome(outcome) => Ok(Prepared::Complete(outcome)),
        Reply::Credential(_) => bail!("Unexpected authentication reply"),
    }
}

fn execute_credential(
    connection: &mut Connection,
    command: Command,
    policy: AuthPolicy,
    lifetimes: AuthLifetimes,
) -> Result<Option<Credential>> {
    match execute(
        connection,
        Command::WithLifetimes {
            command: Box::new(command),
            lifetimes,
        },
        policy,
    )? {
        Reply::Credential(credential) => Ok(credential),
        Reply::Outcome(_) => bail!("Unexpected authentication reply"),
    }
}

fn resume(
    connection: &mut Connection,
    policy: AuthPolicy,
    lifetimes: AuthLifetimes,
    continuation: Continuation,
    result: KdfOutcome,
) -> Result<Outcome> {
    let command = match (continuation, result) {
        (
            Continuation::Register {
                email,
                display_name,
            },
            KdfOutcome::Hash(hash),
        ) => Command::Register {
            email,
            display_name,
            hash,
            first_user: policy.first_user,
        },
        (Continuation::Login(credential), KdfOutcome::LoginVerified(replacement)) => {
            Command::Login {
                credential,
                replacement,
            }
        }
        (
            Continuation::ChangePassword {
                session,
                credential,
            },
            KdfOutcome::ChangeVerified(replacement),
        ) => Command::ChangePassword {
            session,
            credential,
            replacement,
        },
        (Continuation::ResetPassword { token }, KdfOutcome::Hash(replacement)) => {
            Command::ResetPassword { token, replacement }
        }
        _ => bail!(AuthFailure::Storage),
    };
    match execute(
        connection,
        Command::WithLifetimes {
            command: Box::new(command),
            lifetimes,
        },
        policy,
    )? {
        Reply::Outcome(outcome) => Ok(outcome),
        Reply::Credential(_) => bail!("Unexpected authentication reply"),
    }
}

#[cfg(test)]
mod tests;
