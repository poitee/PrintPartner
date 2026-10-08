use super::{AuthFailure, KeyInfo, KeyPrincipal, LocalCommit, Outcome, Secret, crypto, timestamp};
use anyhow::{Result, anyhow, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub(crate) enum Action {
    List,
    Create(Option<i64>),
    Revoke(String),
    Rotate(String, Option<i64>),
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredKey {
    id: String,
    key_hash: String,
    created_at: String,
    last_used_at: Option<String>,
    expires_at: Option<String>,
    is_active: bool,
}
pub(super) struct ResolvedKeyReference {
    pub(super) principal: KeyPrincipal,
    pub(super) id: String,
    pub(super) hash: String,
}
pub(super) struct StreamKeyAuthority {
    pub(super) principal: KeyPrincipal,
    pub(super) key_id: String,
    pub(super) expires_at: Option<i64>,
}
impl StoredKey {
    fn info(&self) -> KeyInfo {
        KeyInfo {
            id: self.id.clone(),
            created_at: self.created_at.clone(),
            last_used_at: self.last_used_at.clone(),
            expires_at: self.expires_at.clone(),
            is_active: self.is_active,
        }
    }
}
fn digest(raw: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(b"print-partner:settings-api-key:v1")
        .expect("HMAC accepts context");
    mac.update(raw.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}
fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn migrate(value: &str) -> String {
    let decoded = STANDARD
        .decode(value)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
    match decoded {
        Some(decoded) if STANDARD.encode(decoded.as_bytes()) == value => digest(&decoded),
        _ => digest(value),
    }
}
fn load(tx: &Transaction<'_>, tenant: &str) -> Result<(Vec<StoredKey>, bool)> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id=?1 AND key='api_keys_v1'",
            [tenant],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Ok((Vec::new(), false));
    };
    ensure!(raw.len() <= 1024 * 1024, "API key collection too large");
    let mut keys: Vec<StoredKey> =
        serde_json::from_str(&raw).map_err(|_| anyhow!("Corrupt API key collection"))?;
    ensure!(keys.len() <= 4096, "API key collection too large");
    let mut ids = std::collections::HashSet::new();
    let mut migrated = false;
    for key in &mut keys {
        ensure!(
            !key.id.is_empty()
                && key.id.len() <= 128
                && ids.insert(key.id.clone())
                && !key.key_hash.is_empty()
                && key.key_hash.len() <= 4096,
            "Corrupt API key collection"
        );
        if !is_digest(&key.key_hash) {
            key.key_hash = migrate(&key.key_hash);
            migrated = true;
        }
    }
    Ok((keys, migrated))
}
fn save(tx: &Transaction<'_>, tenant: &str, keys: &[StoredKey]) -> Result<()> {
    let value = serde_json::to_string(keys)?;
    ensure!(value.len() <= 1024 * 1024, "API key collection too large");
    tx.execute("INSERT INTO app_settings(tenant_id,key,value) VALUES(?1,'api_keys_v1',?2) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value", params![tenant,value])?;
    Ok(())
}
fn create(keys: &mut Vec<StoredKey>, expires_after: Option<i64>) -> Result<Outcome> {
    ensure!(keys.len() < 4096, "API key collection too large");
    let raw = Secret(format!("ppk_{}", hex::encode(crypto::random::<32>()?)));
    let key = StoredKey {
        id: format!("key_{}", hex::encode(crypto::random::<8>()?)),
        key_hash: digest(raw.expose()),
        created_at: timestamp(0),
        last_used_at: None,
        expires_at: expires_after.map(timestamp),
        is_active: true,
    };
    let info = key.info();
    keys.push(key);
    Ok(Outcome::KeyCreated { info, key: raw })
}
pub(super) fn manage(tx: &Transaction<'_>, tenant: &str, action: Action) -> Result<Outcome> {
    let (mut keys, mut changed) = load(tx, tenant)?;
    let outcome = match action {
        Action::List => Outcome::Keys {
            keys: keys.iter().map(StoredKey::info).collect(),
            commit: if changed {
                LocalCommit::Committed
            } else {
                LocalCommit::ReadOnly
            },
        },
        Action::Create(expires_after) => {
            changed = true;
            create(&mut keys, expires_after)?
        }
        Action::Revoke(id) => {
            let found = keys.iter_mut().find(|key| key.id == id);
            let exists = found.is_some();
            if let Some(key) = found {
                key.is_active = false;
                changed = true;
            }
            Outcome::KeyChanged {
                changed: exists,
                commit: if changed {
                    LocalCommit::Committed
                } else {
                    LocalCommit::ReadOnly
                },
            }
        }
        Action::Rotate(id, expires_after) => {
            if let Some(key) = keys.iter_mut().find(|key| key.id == id) {
                key.is_active = false;
                changed = true;
                create(&mut keys, expires_after)?
            } else {
                Outcome::KeyChanged {
                    changed: false,
                    commit: if changed {
                        LocalCommit::Committed
                    } else {
                        LocalCommit::ReadOnly
                    },
                }
            }
        }
    };
    if changed {
        save(tx, tenant, &keys)?;
    }
    Ok(outcome)
}
fn unexpired(expires: &Option<String>) -> bool {
    match expires {
        None => true,
        Some(expires) => {
            time::OffsetDateTime::parse(expires, &time::format_description::well_known::Rfc3339)
                .is_ok_and(|expiry| expiry > time::OffsetDateTime::now_utc())
        }
    }
}

fn expiry_seconds(expires: &Option<String>) -> Result<Option<i64>> {
    expires
        .as_ref()
        .map(|value| {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
                .map(|value| value.unix_timestamp())
                .map_err(Into::into)
        })
        .transpose()
}

pub(super) fn stream_authority(
    tx: &Transaction<'_>,
    tenant: &str,
    raw: &Secret,
    touch: bool,
) -> Result<Option<StreamKeyAuthority>> {
    ensure!(
        !tenant.is_empty() && tenant.len() <= 512 && raw.expose().len() <= 4096,
        "Invalid key request"
    );
    let (mut keys, migrated) = load(tx, tenant)?;
    let hash = digest(raw.expose());
    let Some(key) = keys.iter_mut().find(|key| {
        key.is_active
            && unexpired(&key.expires_at)
            && bool::from(key.key_hash.as_bytes().ct_eq(hash.as_bytes()))
    }) else {
        if migrated {
            save(tx, tenant, &keys)?;
        }
        return Ok(None);
    };
    let authority = StreamKeyAuthority {
        principal: KeyPrincipal {
            tenant_id: tenant.to_owned(),
            key_id: key.id.clone(),
        },
        key_id: key.id.clone(),
        expires_at: expiry_seconds(&key.expires_at)?,
    };
    if touch {
        key.last_used_at = Some(super::timestamp(0));
    }
    if migrated || touch {
        save(tx, tenant, &keys)?;
    }
    Ok(Some(authority))
}
pub(super) fn resolve(tx: &Transaction<'_>, tenant: &str, raw: Secret) -> Result<Outcome> {
    resolve_ref(tx, tenant, &raw)
}
pub(super) fn resolve_ref(tx: &Transaction<'_>, tenant: &str, raw: &Secret) -> Result<Outcome> {
    let (reference, changed) = lookup_reference(tx, tenant, raw)?;
    Ok(Outcome::KeyResolved {
        principal: reference.map(|reference| reference.principal),
        commit: if changed {
            LocalCommit::Committed
        } else {
            LocalCommit::ReadOnly
        },
    })
}

fn lookup_reference(
    tx: &Transaction<'_>,
    tenant: &str,
    raw: &Secret,
) -> Result<(Option<ResolvedKeyReference>, bool)> {
    ensure!(
        !tenant.is_empty() && tenant.len() <= 512 && raw.expose().len() <= 4096,
        "Invalid key request"
    );
    if raw.expose().is_empty() {
        return Ok((None, false));
    }
    let (mut keys, mut changed) = load(tx, tenant)?;
    let hash = digest(raw.expose());
    let found = keys.iter_mut().find(|key| {
        key.is_active
            && unexpired(&key.expires_at)
            && bool::from(key.key_hash.as_bytes().ct_eq(hash.as_bytes()))
    });
    let reference = found.map(|key| {
        key.last_used_at = Some(timestamp(0));
        changed = true;
        ResolvedKeyReference {
            principal: KeyPrincipal {
                tenant_id: tenant.to_owned(),
                key_id: key.id.clone(),
            },
            id: key.id.clone(),
            hash: key.key_hash.clone(),
        }
    });
    if changed {
        save(tx, tenant, &keys)?;
    }
    Ok((reference, changed))
}

pub(super) fn admit_reference(
    tx: &Transaction<'_>,
    tenant: &str,
    raw: &Secret,
) -> Result<Option<ResolvedKeyReference>> {
    Ok(lookup_reference(tx, tenant, raw)?.0)
}

pub(super) fn resolve_reference(
    tx: &Transaction<'_>,
    tenant: &str,
    id: &str,
    original_hash: &str,
) -> Result<Option<KeyPrincipal>> {
    ensure!(
        !tenant.is_empty()
            && tenant.len() <= 512
            && !id.is_empty()
            && id.len() <= 128
            && is_digest(original_hash),
        "Invalid key reference"
    );
    let (mut keys, mut changed) = load(tx, tenant)?;
    let found = keys.iter_mut().find(|key| {
        key.id == id
            && key.is_active
            && unexpired(&key.expires_at)
            && bool::from(key.key_hash.as_bytes().ct_eq(original_hash.as_bytes()))
    });
    let principal = found.map(|key| {
        key.last_used_at = Some(timestamp(0));
        changed = true;
        KeyPrincipal {
            tenant_id: tenant.to_owned(),
            key_id: key.id.clone(),
        }
    });
    if changed {
        save(tx, tenant, &keys)?;
    }
    Ok(principal)
}

pub(super) fn read_tenant(tx: &Transaction<'_>, tenant: &str, secret: &Secret) -> Result<String> {
    ensure!(
        !tenant.is_empty()
            && tenant.len() <= 512
            && !secret.expose().is_empty()
            && secret.expose().len() <= 4096,
        AuthFailure::SessionRequired
    );
    let bytes: i64 = tx.query_row("SELECT coalesce(sum(length(cast(value AS blob))),0) FROM app_settings WHERE key='api_keys_v1' AND tenant_id=?1", [tenant], |r| r.get(0))?;
    ensure!(bytes <= 1024 * 1024, "API key collection too large");
    let (keys, _) = load(tx, tenant)?;
    let hash = digest(secret.expose());
    ensure!(
        keys.iter().any(|key| key.is_active
            && unexpired(&key.expires_at)
            && bool::from(key.key_hash.as_bytes().ct_eq(hash.as_bytes()))),
        AuthFailure::SessionRequired
    );
    Ok(tenant.to_owned())
}
