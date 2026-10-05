use super::{
    AuthFailure, AuthInputFailure, AuthPolicy, FirstUserTenant, RegistrationPolicy,
    SessionTenantPolicy, crypto, keys, policy, session_user,
};
use anyhow::{Result, ensure};
use rusqlite::Transaction;
use serde::{Deserialize, Serialize};

pub(crate) struct AuthorityBasis {
    credential: AuthorityCredential,
    admitted_tenant: String,
    admitted_subject: String,
    policy: PolicyIdentity,
}

enum AuthorityCredential {
    Session(SealedSessionReference),
    RoutedKey {
        routed_tenant: String,
        key: SealedRoutedKeyReference,
    },
}

struct SealedSessionReference(String);

struct SealedRoutedKeyReference {
    id: String,
    hash: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct PolicyIdentity {
    registration: &'static str,
    session_tenant: &'static str,
    first_user: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorityFailure {
    Missing,
    PolicyRequired,
    PolicyChanged,
    CredentialInvalid,
    TenantChanged,
    SubjectChanged,
}

impl std::fmt::Display for AuthorityFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Missing => "Job has no durable original authority",
            Self::PolicyRequired => "Current authentication policy is required",
            Self::PolicyChanged => "Authentication policy changed",
            Self::CredentialInvalid => "Original credential is no longer valid",
            Self::TenantChanged => "Original credential tenant changed",
            Self::SubjectChanged => "Original credential subject changed",
        })
    }
}

impl std::error::Error for AuthorityFailure {}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedBasis {
    version: u8,
    credential: PersistedCredential,
    admitted_tenant: String,
    admitted_subject: String,
    policy: PersistedPolicy,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PersistedCredential {
    Session {
        digest: String,
    },
    RoutedKey {
        routed_tenant: String,
        id: String,
        hash: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedPolicy {
    registration: String,
    session_tenant: String,
    first_user: String,
}

impl PolicyIdentity {
    fn new(policy: AuthPolicy) -> Self {
        Self {
            registration: match policy.registration {
                RegistrationPolicy::Open => "open",
                RegistrationPolicy::Closed => "closed",
                RegistrationPolicy::FirstAccountOnly => "first_account_only",
            },
            session_tenant: match policy.session_tenant {
                SessionTenantPolicy::AccountTenant => "account_tenant",
                SessionTenantPolicy::SingleAccountDefault => "single_account_default",
            },
            first_user: match policy.first_user {
                FirstUserTenant::NewUser => "new_user",
                FirstUserTenant::ClaimDefault => "claim_default",
            },
        }
    }
}

fn valid_text(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn session_identity(
    tx: &Transaction<'_>,
    digest: &str,
    policy: AuthPolicy,
) -> Result<(String, String)> {
    let actor = session_user(tx, digest)?
        .map(|credential| credential.user)
        .ok_or(AuthorityFailure::CredentialInvalid)?;
    let tenant = policy::tenant_for_authenticated_actor(tx, &actor, policy)?;
    Ok((tenant, format!("user:{}", actor.user_id)))
}

pub(crate) fn admit(
    tx: &Transaction<'_>,
    credential: crate::jobs::Credential,
    policy: AuthPolicy,
    storage: &std::sync::Arc<crate::Shared>,
) -> Result<(String, String, Option<AuthorityBasis>)> {
    let policy_identity = PolicyIdentity::new(policy);
    match credential {
        crate::jobs::Credential::Session(token) => {
            ensure!(
                token.expose().len() <= 4096,
                AuthFailure::InvalidInput(AuthInputFailure::TooLong)
            );
            let digest = crypto::digest(token.expose());
            let actor = super::actor(tx, &digest)?;
            let tenant = policy::tenant_for_authenticated_actor(tx, &actor, policy)?;
            let subject = format!("user:{}", actor.user_id);
            let basis = AuthorityBasis {
                credential: AuthorityCredential::Session(SealedSessionReference(digest)),
                admitted_tenant: tenant.clone(),
                admitted_subject: subject.clone(),
                policy: policy_identity,
            };
            Ok((tenant, subject, Some(basis)))
        }
        crate::jobs::Credential::RoutedKey { tenant, key } => {
            let Some(reference) = keys::admit_reference(tx, &tenant, &key)? else {
                return Err(AuthFailure::SessionRequired.into());
            };
            let principal = reference.principal;
            let subject = format!("key:{}", principal.key_id);
            let basis = AuthorityBasis {
                credential: AuthorityCredential::RoutedKey {
                    routed_tenant: tenant,
                    key: SealedRoutedKeyReference {
                        id: reference.id,
                        hash: reference.hash,
                    },
                },
                admitted_tenant: principal.tenant_id.clone(),
                admitted_subject: subject.clone(),
                policy: policy_identity,
            };
            Ok((principal.tenant_id, subject, Some(basis)))
        }
        crate::jobs::Credential::PhysicalOwner(owner) => {
            ensure!(
                std::sync::Arc::ptr_eq(storage, &owner.storage),
                "Foreign physical owner"
            );
            Ok(("default".into(), "physical-owner".into(), None))
        }
    }
}

pub(crate) fn resolve(
    tx: &Transaction<'_>,
    basis: &AuthorityBasis,
    policy: AuthPolicy,
) -> Result<(String, String)> {
    ensure!(
        basis.policy == PolicyIdentity::new(policy),
        AuthorityFailure::PolicyChanged
    );
    let (tenant, subject) = match &basis.credential {
        AuthorityCredential::Session(reference) => session_identity(tx, &reference.0, policy)?,
        AuthorityCredential::RoutedKey { routed_tenant, key } => {
            let principal = keys::resolve_reference(tx, routed_tenant, &key.id, &key.hash)?
                .ok_or(AuthorityFailure::CredentialInvalid)?;
            let subject = format!("key:{}", principal.key_id);
            (principal.tenant_id, subject)
        }
    };
    ensure!(
        tenant == basis.admitted_tenant,
        AuthorityFailure::TenantChanged
    );
    ensure!(
        subject == basis.admitted_subject,
        AuthorityFailure::SubjectChanged
    );
    Ok((tenant, subject))
}

pub(crate) fn encode(basis: &AuthorityBasis) -> Result<serde_json::Value> {
    let credential = match &basis.credential {
        AuthorityCredential::Session(reference) => PersistedCredential::Session {
            digest: reference.0.clone(),
        },
        AuthorityCredential::RoutedKey { routed_tenant, key } => PersistedCredential::RoutedKey {
            routed_tenant: routed_tenant.clone(),
            id: key.id.clone(),
            hash: key.hash.clone(),
        },
    };
    Ok(serde_json::to_value(PersistedBasis {
        version: 1,
        credential,
        admitted_tenant: basis.admitted_tenant.clone(),
        admitted_subject: basis.admitted_subject.clone(),
        policy: PersistedPolicy {
            registration: basis.policy.registration.into(),
            session_tenant: basis.policy.session_tenant.into(),
            first_user: basis.policy.first_user.into(),
        },
    })?)
}

pub(crate) fn decode(value: serde_json::Value) -> Result<AuthorityBasis> {
    let persisted: PersistedBasis = serde_json::from_value(value)?;
    ensure!(
        persisted.version == 1
            && valid_text(&persisted.admitted_tenant, 512)
            && valid_text(&persisted.admitted_subject, 640),
        "Invalid durable authority"
    );
    let policy = PolicyIdentity {
        registration: match persisted.policy.registration.as_str() {
            "open" => "open",
            "closed" => "closed",
            "first_account_only" => "first_account_only",
            _ => return Err(anyhow::anyhow!("Invalid durable authority")),
        },
        session_tenant: match persisted.policy.session_tenant.as_str() {
            "account_tenant" => "account_tenant",
            "single_account_default" => "single_account_default",
            _ => return Err(anyhow::anyhow!("Invalid durable authority")),
        },
        first_user: match persisted.policy.first_user.as_str() {
            "new_user" => "new_user",
            "claim_default" => "claim_default",
            _ => return Err(anyhow::anyhow!("Invalid durable authority")),
        },
    };
    let credential = match persisted.credential {
        PersistedCredential::Session { digest } => {
            ensure!(valid_digest(&digest), "Invalid durable authority");
            AuthorityCredential::Session(SealedSessionReference(digest))
        }
        PersistedCredential::RoutedKey {
            routed_tenant,
            id,
            hash,
        } => {
            ensure!(
                valid_text(&routed_tenant, 512) && valid_text(&id, 128) && valid_digest(&hash),
                "Invalid durable authority"
            );
            AuthorityCredential::RoutedKey {
                routed_tenant,
                key: SealedRoutedKeyReference { id, hash },
            }
        }
    };
    Ok(AuthorityBasis {
        credential,
        admitted_tenant: persisted.admitted_tenant,
        admitted_subject: persisted.admitted_subject,
        policy,
    })
}
