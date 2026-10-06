mod crypto;
mod keys;
mod policy;
pub use policy::{
    AuthFailure, AuthInputFailure, AuthPolicy, AuthStatus, RegistrationPolicy, SessionTenantPolicy,
};

use crate::{SettingsClient, WriterOwner};
use anyhow::{Result, anyhow, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

pub struct Secret(String);
impl Secret {
    pub fn new(value: String) -> Self {
        Self(value)
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
#[derive(Clone, Copy)]
pub enum FirstUserTenant {
    NewUser,
    ClaimDefault,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Email,
    Github,
    Discord,
}
impl Provider {
    fn name(self) -> &'static str {
        match self {
            Self::Email => "email",
            Self::Github => "github",
            Self::Discord => "discord",
        }
    }
    fn from_name(value: &str) -> Result<Self> {
        match value {
            "email" => Ok(Self::Email),
            "github" => Ok(Self::Github),
            "discord" => Ok(Self::Discord),
            _ => Err(AuthFailure::Storage.into()),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct User {
    pub user_id: String,
    pub tenant_id: String,
    pub login: String,
    pub display_name: String,
    pub email: Option<String>,
    pub provider: Provider,
    pub is_admin: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub id: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub expires_at: Option<String>,
    pub is_active: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeyPrincipal {
    pub tenant_id: String,
    pub key_id: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub enum LocalCommit {
    ReadOnly,
    Committed,
}
pub enum Outcome {
    Status(AuthStatus),
    IdentityExists(bool),
    Session {
        user: User,
        token: Secret,
    },
    User(Option<User>),
    ResetToken(Option<Secret>),
    Changed(bool),
    Keys {
        keys: Vec<KeyInfo>,
        commit: LocalCommit,
    },
    KeyChanged {
        changed: bool,
        commit: LocalCommit,
    },
    KeyCreated {
        info: KeyInfo,
        key: Secret,
    },
    KeyResolved {
        principal: Option<KeyPrincipal>,
        commit: LocalCommit,
    },
}
pub enum Request {
    Status,
    IdentityExists {
        provider: Provider,
        provider_user_id: String,
    },
    Register {
        email: String,
        display_name: String,
        password: Secret,
    },
    Login {
        email: String,
        password: Secret,
    },
    ResolveSession {
        token: Secret,
    },
    Logout {
        token: Secret,
    },
    LogoutAll {
        session: Secret,
    },
    ChangePassword {
        session: Secret,
        current: Secret,
        replacement: Secret,
    },
    RequestReset {
        email: String,
    },
    ResetPassword {
        token: Secret,
        replacement: Secret,
    },
    OAuthLogin {
        provider: Provider,
        provider_user_id: String,
        email: Option<String>,
        display_name: String,
    },
    LinkIdentity {
        session: Secret,
        provider: Provider,
        provider_user_id: String,
    },
    ListKeys {
        session: Secret,
    },
    CreateKey {
        session: Secret,
    },
    RevokeKey {
        session: Secret,
        key_id: String,
    },
    RotateKey {
        session: Secret,
        key_id: String,
    },
    ResolveKey {
        tenant_id: String,
        key: Secret,
    },
}
impl Request {
    fn validate(&self) -> Result<()> {
        let fields: Vec<&str> = match self {
            Self::Status => vec![],
            Self::IdentityExists {
                provider_user_id, ..
            } => vec![provider_user_id],
            Self::Register {
                email,
                display_name,
                password,
            } => vec![email, display_name, password.expose()],
            Self::Login { email, password } => vec![email, password.expose()],
            Self::ResolveSession { token } | Self::Logout { token } => vec![token.expose()],
            Self::LogoutAll { session }
            | Self::ListKeys { session }
            | Self::CreateKey { session } => vec![session.expose()],
            Self::ChangePassword {
                session,
                current,
                replacement,
            } => vec![session.expose(), current.expose(), replacement.expose()],
            Self::RequestReset { email } => vec![email],
            Self::ResetPassword { token, replacement } => {
                vec![token.expose(), replacement.expose()]
            }
            Self::OAuthLogin {
                provider_user_id,
                email,
                display_name,
                ..
            } => vec![
                provider_user_id,
                email.as_deref().unwrap_or(""),
                display_name,
            ],
            Self::LinkIdentity {
                session,
                provider_user_id,
                ..
            } => vec![session.expose(), provider_user_id],
            Self::RevokeKey { session, key_id } | Self::RotateKey { session, key_id } => {
                vec![session.expose(), key_id]
            }
            Self::ResolveKey { tenant_id, key } => vec![tenant_id, key.expose()],
        };
        ensure!(
            fields.iter().all(|value| value.len() <= 4096),
            AuthFailure::InvalidInput(AuthInputFailure::TooLong)
        );
        Ok(())
    }
}
pub type AuthReply = mpsc::Receiver<Result<Outcome>>;
#[derive(Clone)]
pub struct AuthClient {
    storage: SettingsClient,
    policy: AuthPolicy,
    runtime: Arc<AuthRuntime>,
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
pub(super) struct WriterWork {
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
    pub(super) fn eligible(&self, now: Instant) -> bool {
        self.retry_not_before.is_none_or(|retry| retry <= now)
    }
    pub(super) fn retry_at(&self) -> Option<Instant> {
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
    pub fn auth(&self, first_user: FirstUserTenant) -> AuthClient {
        AuthClient {
            storage: self.client(),
            policy: AuthPolicy {
                registration: RegistrationPolicy::Open,
                session_tenant: SessionTenantPolicy::AccountTenant,
                first_user,
            },
            runtime: AuthRuntime::global(),
            #[cfg(test)]
            kdf_gate: None,
        }
    }
    pub fn auth_with_policy(&self, policy: AuthPolicy) -> Result<AuthClient> {
        validate_policy(policy)?;
        Ok(AuthClient {
            storage: self.client(),
            policy,
            runtime: AuthRuntime::global(),
            #[cfg(test)]
            kdf_gate: None,
        })
    }
}
pub(crate) fn validate_policy(policy: AuthPolicy) -> Result<()> {
    ensure!(
        !matches!(
            (policy.session_tenant, policy.first_user),
            (
                SessionTenantPolicy::SingleAccountDefault,
                FirstUserTenant::ClaimDefault
            )
        ),
        AuthFailure::InvalidInput(AuthInputFailure::Policy)
    );
    Ok(())
}
impl AuthClient {
    #[cfg(test)]
    fn with_kdf_gate(&self, gate: Arc<TestKdfGate>) -> Self {
        Self {
            storage: self.storage.clone(),
            policy: self.policy,
            runtime: self.runtime.clone(),
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

pub(super) fn finish_stopped(work: WriterWork) {
    work.flow.finish(Err(AuthFailure::Stopped.into()));
}

pub(super) fn advance(connection: &mut Connection, work: WriterWork) -> Option<WriterWork> {
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
            flow.finish(result.and_then(|result| resume(connection, policy, continuation, result)));
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
    match request {
        Request::Status => execute_outcome(connection, Command::Status, policy),
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
        ),
        Request::Logout { token } => execute_outcome(
            connection,
            Command::Logout(crypto::digest(token.expose())),
            policy,
        ),
        Request::LogoutAll { session } => execute_outcome(
            connection,
            Command::LogoutAll(crypto::digest(session.expose())),
            policy,
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
            )
        }
        Request::ListKeys { session } => execute_outcome(
            connection,
            Command::Keys {
                session: crypto::digest(session.expose()),
                action: keys::Action::List,
            },
            policy,
        ),
        Request::CreateKey { session } => execute_outcome(
            connection,
            Command::Keys {
                session: crypto::digest(session.expose()),
                action: keys::Action::Create,
            },
            policy,
        ),
        Request::RevokeKey { session, key_id } => execute_outcome(
            connection,
            Command::Keys {
                session: crypto::digest(session.expose()),
                action: keys::Action::Revoke(key_id),
            },
            policy,
        ),
        Request::RotateKey { session, key_id } => execute_outcome(
            connection,
            Command::Keys {
                session: crypto::digest(session.expose()),
                action: keys::Action::Rotate(key_id),
            },
            policy,
        ),
        Request::ResolveKey { tenant_id, key } => {
            execute_outcome(connection, Command::ResolveKey { tenant_id, key }, policy)
        }
    }
}

fn execute_outcome(
    connection: &mut Connection,
    command: Command,
    policy: AuthPolicy,
) -> Result<Prepared> {
    match execute(connection, command, policy)? {
        Reply::Outcome(outcome) => Ok(Prepared::Complete(outcome)),
        Reply::Credential(_) => bail!("Unexpected authentication reply"),
    }
}

fn execute_credential(
    connection: &mut Connection,
    command: Command,
    policy: AuthPolicy,
) -> Result<Option<Credential>> {
    match execute(connection, command, policy)? {
        Reply::Credential(credential) => Ok(credential),
        Reply::Outcome(_) => bail!("Unexpected authentication reply"),
    }
}

fn resume(
    connection: &mut Connection,
    policy: AuthPolicy,
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
    match execute(connection, command, policy)? {
        Reply::Outcome(outcome) => Ok(outcome),
        Reply::Credential(_) => bail!("Unexpected authentication reply"),
    }
}
fn validate_email(email: &str) -> Result<()> {
    ensure!(
        !email.is_empty() && email.len() <= 320 && email.contains('@'),
        AuthFailure::InvalidInput(AuthInputFailure::Email)
    );
    Ok(())
}
fn validate_identity(provider: Provider, id: &str) -> Result<()> {
    ensure!(
        provider != Provider::Email && !id.is_empty() && id.len() <= 512,
        AuthFailure::InvalidInput(AuthInputFailure::ProviderIdentity)
    );
    Ok(())
}
pub(super) struct Credential {
    user: User,
    hash: Option<String>,
}
pub(super) enum Reply {
    Credential(Option<Credential>),
    Outcome(Outcome),
}
pub(super) enum Command {
    Status,
    IdentityExists {
        provider: Provider,
        provider_user_id: String,
    },
    CredentialByEmail(String),
    CredentialBySession(String),
    Register {
        email: String,
        display_name: String,
        hash: String,
        first_user: FirstUserTenant,
    },
    Login {
        credential: Credential,
        replacement: Option<String>,
    },
    ResolveSession(String),
    Logout(String),
    LogoutAll(String),
    ChangePassword {
        session: String,
        credential: Credential,
        replacement: String,
    },
    RequestReset(String),
    ResetPassword {
        token: String,
        replacement: String,
    },
    OAuthLogin {
        provider: Provider,
        provider_user_id: String,
        email: Option<String>,
        display_name: String,
        first_user: FirstUserTenant,
    },
    LinkIdentity {
        session: String,
        provider: Provider,
        provider_user_id: String,
    },
    Keys {
        session: String,
        action: keys::Action,
    },
    ResolveKey {
        tenant_id: String,
        key: Secret,
    },
}
fn timestamp(after_seconds: i64) -> String {
    let now = time::OffsetDateTime::now_utc() + time::Duration::seconds(after_seconds);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}
fn read_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<Credential> {
    let id: String = row.get(0)?;
    let email: Option<String> = row.get(1)?;
    let display: String = row.get(2)?;
    Ok(Credential {
        user: User {
            user_id: id.clone(),
            tenant_id: id,
            login: email.clone().unwrap_or_else(|| display.clone()),
            display_name: display,
            email,
            provider: Provider::Email,
            is_admin: row.get(4)?,
        },
        hash: row.get(3)?,
    })
}
fn by_id(tx: &Transaction<'_>, id: &str) -> Result<Option<Credential>> {
    Ok(tx
        .query_row(
            "SELECT id,email,display_name,password_hash,is_admin FROM users WHERE id=?1",
            [id],
            read_user,
        )
        .optional()?)
}
fn by_email(tx: &Transaction<'_>, email: &str) -> Result<Option<Credential>> {
    Ok(tx
        .query_row(
            "SELECT id,email,display_name,password_hash,is_admin FROM users WHERE email=?1",
            [email],
            read_user,
        )
        .optional()?)
}
fn session_user(tx: &Transaction<'_>, token: &str) -> Result<Option<Credential>> {
    let session: Option<(String, String)> = tx
        .query_row(
            "SELECT user_id,provider FROM sessions WHERE id=?1 AND expires_at>?2",
            params![token, timestamp(0)],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match session {
        Some((id, provider)) => {
            let provider = Provider::from_name(&provider)?;
            let mut credential = by_id(tx, &id)?;
            if let Some(credential) = &mut credential {
                credential.user.provider = provider;
            }
            Ok(credential)
        }
        None => Ok(None),
    }
}
fn actor(tx: &Transaction<'_>, token: &str) -> Result<User> {
    session_user(tx, token)?
        .map(|c| c.user)
        .ok_or_else(|| anyhow!(AuthFailure::SessionRequired))
}
fn create_user(
    tx: &Transaction<'_>,
    email: Option<String>,
    display_name: String,
    hash: Option<String>,
    first_user: FirstUserTenant,
) -> Result<User> {
    ensure!(
        display_name.len() <= 512,
        AuthFailure::InvalidInput(AuthInputFailure::TooLong)
    );
    let first: bool = tx.query_row("SELECT NOT EXISTS(SELECT 1 FROM users)", [], |row| {
        row.get(0)
    })?;
    let id = if first && matches!(first_user, FirstUserTenant::ClaimDefault) {
        "default".to_owned()
    } else {
        let mut bytes = crypto::random::<16>()?;
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        let value = hex::encode(bytes);
        format!(
            "{}-{}-{}-{}-{}",
            &value[..8],
            &value[8..12],
            &value[12..16],
            &value[16..20],
            &value[20..]
        )
    };
    let display_name = display_name.trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'));
    let display_name = if display_name.is_empty() {
        "User"
    } else {
        display_name
    };
    tx.execute("INSERT INTO users(id,email,display_name,password_hash,is_admin,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![id,email,display_name,hash,first,timestamp(0)])?;
    Ok(by_id(tx, &id)?
        .ok_or_else(|| anyhow!("User insert failed"))?
        .user)
}
fn create_session(
    tx: &Transaction<'_>,
    mut user: User,
    provider: Provider,
    policy: AuthPolicy,
) -> Result<Outcome> {
    user.tenant_id = policy::tenant_for_authenticated_actor(tx, &user, policy)?;
    user.provider = provider;
    let token = crypto::token()?;
    tx.execute(
        "INSERT INTO sessions(id,user_id,expires_at,provider) VALUES(?1,?2,?3,?4)",
        params![
            crypto::digest(token.expose()),
            user.user_id,
            timestamp(14 * 24 * 60 * 60),
            provider.name()
        ],
    )?;
    Ok(Outcome::Session { user, token })
}
fn invalidate(tx: &Transaction<'_>, id: &str) -> Result<()> {
    tx.execute("DELETE FROM sessions WHERE user_id=?1", [id])?;
    tx.execute("DELETE FROM password_reset_tokens WHERE user_id=?1", [id])?;
    Ok(())
}
fn identity(tx: &Transaction<'_>, provider: Provider, provider_id: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT user_id FROM auth_identities WHERE provider=?1 AND provider_user_id=?2",
            params![provider.name(), provider_id],
            |row| row.get(0),
        )
        .optional()?)
}
fn link(tx: &Transaction<'_>, user: &str, provider: Provider, provider_id: &str) -> Result<()> {
    if let Some(existing) = identity(tx, provider, provider_id)? {
        ensure!(existing == user, "Identity already belongs to another user");
    } else {
        tx.execute(
            "INSERT INTO auth_identities(user_id,provider,provider_user_id) VALUES(?1,?2,?3)",
            params![user, provider.name(), provider_id],
        )?;
    }
    Ok(())
}
pub(super) fn execute(
    connection: &mut Connection,
    command: Command,
    policy: AuthPolicy,
) -> Result<Reply> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let outcome = match command {
        Command::Status => {
            return Ok(Reply::Outcome(Outcome::Status(policy::status(
                &tx, policy,
            )?)));
        }
        Command::IdentityExists {
            provider,
            provider_user_id,
        } => {
            return Ok(Reply::Outcome(Outcome::IdentityExists(
                identity(&tx, provider, &provider_user_id)?.is_some(),
            )));
        }
        Command::CredentialByEmail(email) => return Ok(Reply::Credential(by_email(&tx, &email)?)),
        Command::CredentialBySession(token) => {
            return Ok(Reply::Credential(session_user(&tx, &token)?));
        }
        Command::Register {
            email,
            display_name,
            hash,
            first_user,
        } => {
            policy::registration_allowed(&tx, policy)?;
            ensure!(
                by_email(&tx, &email)?.is_none(),
                AuthFailure::DuplicateEmail
            );
            let user = create_user(&tx, Some(email), display_name, Some(hash), first_user)?;
            create_session(&tx, user, Provider::Email, policy)?
        }
        Command::Login {
            credential,
            replacement,
        } => {
            let current = by_id(&tx, &credential.user.user_id)?
                .ok_or_else(|| anyhow!(AuthFailure::CredentialChanged))?;
            ensure!(
                current.hash == credential.hash,
                AuthFailure::CredentialChanged
            );
            if let Some(hash) = replacement {
                tx.execute(
                    "UPDATE users SET password_hash=?1 WHERE id=?2",
                    params![hash, current.user.user_id],
                )?;
            }
            create_session(&tx, current.user, Provider::Email, policy)?
        }
        Command::ResolveSession(token) => Outcome::User(
            session_user(&tx, &token)?
                .map(|credential| {
                    let mut user = credential.user;
                    user.tenant_id = policy::tenant_for_authenticated_actor(&tx, &user, policy)?;
                    Ok::<_, anyhow::Error>(user)
                })
                .transpose()?,
        ),
        Command::Logout(token) => {
            Outcome::Changed(tx.execute("DELETE FROM sessions WHERE id=?1", [token])? > 0)
        }
        Command::LogoutAll(token) => {
            let user = actor(&tx, &token)?;
            tx.execute("DELETE FROM sessions WHERE user_id=?1", [user.user_id])?;
            Outcome::Changed(true)
        }
        Command::ChangePassword {
            session,
            credential,
            replacement,
        } => {
            let user = actor(&tx, &session)?;
            ensure!(
                user.user_id == credential.user.user_id,
                AuthFailure::CredentialChanged
            );
            let changed = tx.execute(
                "UPDATE users SET password_hash=?1 WHERE id=?2 AND password_hash IS ?3",
                params![replacement, user.user_id, credential.hash],
            )?;
            ensure!(changed == 1, AuthFailure::CredentialChanged);
            invalidate(&tx, &user.user_id)?;
            create_session(&tx, user, Provider::Email, policy)?
        }
        Command::RequestReset(email) => {
            if let Some(credential) = by_email(&tx, &email)? {
                let token = Secret(URL_SAFE_NO_PAD.encode(crypto::random::<32>()?));
                tx.execute(
                    "DELETE FROM password_reset_tokens WHERE user_id=?1",
                    [&credential.user.user_id],
                )?;
                tx.execute("INSERT INTO password_reset_tokens(id,user_id,expires_at,created_at) VALUES(?1,?2,?3,?4)", params![crypto::digest(token.expose()),credential.user.user_id,timestamp(3600),timestamp(0)])?;
                Outcome::ResetToken(Some(token))
            } else {
                Outcome::ResetToken(None)
            }
        }
        Command::ResetPassword { token, replacement } => {
            let id: Option<String> = tx
                .query_row(
                    "SELECT user_id FROM password_reset_tokens WHERE id=?1 AND expires_at>?2",
                    params![token, timestamp(0)],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(id) = id {
                ensure!(
                    tx.execute(
                        "UPDATE users SET password_hash=?1 WHERE id=?2",
                        params![replacement, id]
                    )? == 1,
                    "Reset user missing"
                );
                invalidate(&tx, &id)?;
                let user = by_id(&tx, &id)?
                    .ok_or_else(|| anyhow!("Reset user missing"))?
                    .user;
                create_session(&tx, user, Provider::Email, policy)?
            } else {
                Outcome::Changed(false)
            }
        }
        Command::OAuthLogin {
            provider,
            provider_user_id,
            email,
            display_name,
            first_user,
        } => {
            let existing = match identity(&tx, provider, &provider_user_id)? {
                Some(id) => by_id(&tx, &id)?,
                None => {
                    policy::registration_allowed(&tx, policy)?;
                    match &email {
                        Some(email) => by_email(&tx, email)?,
                        None => None,
                    }
                }
            };
            let user = match existing {
                Some(c) => c.user,
                None => create_user(&tx, email, display_name, None, first_user)?,
            };
            link(&tx, &user.user_id, provider, &provider_user_id)?;
            create_session(&tx, user, provider, policy)?
        }
        Command::LinkIdentity {
            session,
            provider,
            provider_user_id,
        } => {
            let user = actor(&tx, &session)?;
            link(&tx, &user.user_id, provider, &provider_user_id)?;
            Outcome::Changed(true)
        }
        Command::Keys { session, action } => {
            let user = actor(&tx, &session)?;
            let tenant = policy::tenant_for_authenticated_actor(&tx, &user, policy)?;
            keys::manage(&tx, &tenant, action)?
        }
        Command::ResolveKey { tenant_id, key } => keys::resolve(&tx, &tenant_id, key)?,
    };
    tx.commit()?;
    Ok(Reply::Outcome(outcome))
}

#[cfg(test)]
mod tests;

pub(crate) fn read_session_tenant(
    tx: &Transaction<'_>,
    secret: &Secret,
    policy: AuthPolicy,
) -> Result<String> {
    ensure!(
        !secret.expose().is_empty() && secret.expose().len() <= 4096,
        AuthFailure::SessionRequired
    );
    policy::tenant_for_authenticated_actor(
        tx,
        &actor(tx, &crypto::digest(secret.expose()))?,
        policy,
    )
}
pub(crate) fn read_key_tenant(
    tx: &Transaction<'_>,
    routed_tenant: &str,
    secret: &Secret,
) -> Result<String> {
    keys::read_tenant(tx, routed_tenant, secret)
}
pub(crate) fn catalog_timestamp() -> String {
    timestamp(0)
}
pub(crate) fn catalog_tenant(
    tx: &Transaction<'_>,
    credentials: crate::catalog::Credentials,
    policy: AuthPolicy,
) -> Result<String> {
    match credentials {
        crate::catalog::Credentials::Session(token) => {
            ensure!(token.expose().len() <= 4096, AuthFailure::SessionRequired);
            read_session_tenant(tx, &token, policy)
        }
        crate::catalog::Credentials::Key { tenant_id, key } => {
            match keys::resolve(tx, &tenant_id, key)? {
                Outcome::KeyResolved {
                    principal: Some(principal),
                    ..
                } => Ok(principal.tenant_id),
                _ => bail!(AuthFailure::SessionRequired),
            }
        }
    }
}

pub(crate) fn job_session_actor(
    tx: &Transaction<'_>,
    token: &str,
    policy: AuthPolicy,
) -> Result<(String, String)> {
    ensure!(
        token.len() <= 4096,
        AuthFailure::InvalidInput(AuthInputFailure::TooLong)
    );
    let actor = actor(tx, &crypto::digest(token))?;
    Ok((
        policy::tenant_for_authenticated_actor(tx, &actor, policy)?,
        format!("user:{}", actor.user_id),
    ))
}
pub(crate) fn job_key_actor(
    tx: &Transaction<'_>,
    tenant: &str,
    key: Secret,
) -> Result<(String, String)> {
    match keys::resolve(tx, tenant, key)? {
        Outcome::KeyResolved {
            principal: Some(principal),
            ..
        } => Ok((principal.tenant_id, format!("key:{}", principal.key_id))),
        _ => Err(AuthFailure::SessionRequired.into()),
    }
}

pub(crate) fn reconciliation_actor(
    tx: &Transaction<'_>,
    credential: crate::read_model::Credential,
    policy: AuthPolicy,
) -> Result<(String, String)> {
    reconciliation_actor_ref(tx, &credential, policy)
}
pub(crate) fn reconciliation_actor_ref(
    tx: &Transaction<'_>,
    credential: &crate::read_model::Credential,
    policy: AuthPolicy,
) -> Result<(String, String)> {
    match credential {
        crate::read_model::Credential::Session(secret) => {
            ensure!(
                !secret.expose().is_empty() && secret.expose().len() <= 4096,
                "Authentication required"
            );
            let user = actor(tx, &crypto::digest(secret.expose()))?;
            let tenant = policy::tenant_for_authenticated_actor(tx, &user, policy)?;
            Ok((tenant, user.user_id))
        }
        crate::read_model::Credential::ApiKey {
            routed_tenant,
            secret,
        } => match keys::resolve_ref(tx, routed_tenant, secret)? {
            Outcome::KeyResolved {
                principal: Some(principal),
                ..
            } => {
                let actor = format!("tenant:{}", principal.tenant_id);
                Ok((principal.tenant_id, actor))
            }
            _ => bail!("Authentication required"),
        },
    }
}

pub(crate) fn observe_reconciliation_actor(
    tx: &Transaction<'_>,
    credential: &crate::read_model::Credential,
    policy: AuthPolicy,
) -> Result<(String, String)> {
    match credential {
        crate::read_model::Credential::Session(secret) => {
            ensure!(
                !secret.expose().is_empty() && secret.expose().len() <= 4096,
                AuthFailure::SessionRequired
            );
            let user = actor(tx, &crypto::digest(secret.expose()))?;
            let tenant = policy::tenant_for_authenticated_actor(tx, &user, policy)?;
            Ok((tenant, user.user_id))
        }
        crate::read_model::Credential::ApiKey {
            routed_tenant,
            secret,
        } => {
            let tenant = keys::read_tenant(tx, routed_tenant, secret)?;
            Ok((tenant.clone(), format!("tenant:{tenant}")))
        }
    }
}
