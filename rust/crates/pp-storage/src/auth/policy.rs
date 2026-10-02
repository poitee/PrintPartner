use super::{FirstUserTenant, User};
use anyhow::{Result, ensure};
use rusqlite::Transaction;
use serde::Serialize;

#[derive(Clone, Copy)]
pub enum RegistrationPolicy {
    Open,
    Closed,
    FirstAccountOnly,
}
#[derive(Clone, Copy)]
pub enum SessionTenantPolicy {
    AccountTenant,
    SingleAccountDefault,
}
#[derive(Clone, Copy)]
pub struct AuthPolicy {
    pub registration: RegistrationPolicy,
    pub session_tenant: SessionTenantPolicy,
    pub first_user: FirstUserTenant,
}
#[derive(Clone, Copy, Debug)]
pub enum AuthInputFailure {
    TooLong,
    Email,
    ProviderIdentity,
    PasswordTooShort,
    Policy,
}
#[derive(Clone, Copy, Debug)]
pub enum AuthFailure {
    InvalidInput(AuthInputFailure),
    InvalidCredentials,
    SessionRequired,
    CurrentPasswordIncorrect,
    OAuthOnlyAccount,
    DuplicateEmail,
    RegistrationClosed,
    SingleAccountExists,
    OwnerMappingRequired,
    CredentialChanged,
    QueueFull,
    Stopped,
    CommitUnknown,
    Storage,
}
impl std::fmt::Display for AuthFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidInput(AuthInputFailure::TooLong) => "Authentication input too long",
            Self::InvalidInput(AuthInputFailure::Email) => "Invalid email",
            Self::InvalidInput(AuthInputFailure::ProviderIdentity) => "Invalid provider identity",
            Self::InvalidInput(AuthInputFailure::PasswordTooShort) => {
                "Password must be at least 8 characters"
            }
            Self::InvalidInput(AuthInputFailure::Policy) => "Invalid authentication policy",
            Self::InvalidCredentials => "Invalid email or password",
            Self::SessionRequired => "Authentication required",
            Self::CurrentPasswordIncorrect => "Current password is incorrect",
            Self::OAuthOnlyAccount => "This account uses OAuth sign-in only",
            Self::DuplicateEmail => "Email already registered",
            Self::RegistrationClosed => "Registration is closed",
            Self::SingleAccountExists => "The single-user administrator already exists",
            Self::OwnerMappingRequired => "Explicit account owner mapping is required",
            Self::CredentialChanged => "Credential changed",
            Self::QueueFull => "Authentication queue full",
            Self::Stopped => "Storage stopped",
            Self::CommitUnknown => "Authentication result unknown",
            Self::Storage => "Authentication unavailable",
        })
    }
}
impl std::error::Error for AuthFailure {}
#[derive(Clone, Debug, Serialize)]
pub struct AuthStatus {
    pub registration_open: bool,
    pub single_user_auth: bool,
    pub single_user_setup_required: bool,
    pub owner_mapping_required: bool,
}
fn count(tx: &Transaction<'_>) -> Result<i64> {
    Ok(tx.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?)
}
pub(super) fn registration_allowed(tx: &Transaction<'_>, policy: AuthPolicy) -> Result<()> {
    match policy.registration {
        RegistrationPolicy::Open => Ok(()),
        RegistrationPolicy::Closed => Err(AuthFailure::RegistrationClosed.into()),
        RegistrationPolicy::FirstAccountOnly => {
            ensure!(count(tx)? == 0, AuthFailure::SingleAccountExists);
            Ok(())
        }
    }
}
pub(super) fn tenant_for_authenticated_actor(
    tx: &Transaction<'_>,
    actor: &User,
    policy: AuthPolicy,
) -> Result<String> {
    match policy.session_tenant {
        SessionTenantPolicy::AccountTenant => Ok(actor.tenant_id.clone()),
        SessionTenantPolicy::SingleAccountDefault => {
            ensure!(count(tx)? <= 1, AuthFailure::OwnerMappingRequired);
            Ok("default".into())
        }
    }
}
pub(super) fn status(tx: &Transaction<'_>, policy: AuthPolicy) -> Result<AuthStatus> {
    let count = count(tx)?;
    let single = matches!(
        policy.session_tenant,
        SessionTenantPolicy::SingleAccountDefault
    );
    Ok(AuthStatus {
        registration_open: match policy.registration {
            RegistrationPolicy::Open => true,
            RegistrationPolicy::Closed => false,
            RegistrationPolicy::FirstAccountOnly => count == 0,
        },
        single_user_auth: single,
        single_user_setup_required: single && count == 0,
        owner_mapping_required: single && count > 1,
    })
}
