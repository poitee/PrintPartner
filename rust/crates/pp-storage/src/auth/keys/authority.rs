use super::*;

pub(crate) struct ResolvedKeyReference {
    pub(crate) principal: KeyPrincipal,
    pub(crate) id: String,
    pub(crate) hash: String,
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
    let hash = digest(raw.expose())?;
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

pub(crate) fn admit_reference(
    tx: &Transaction<'_>,
    tenant: &str,
    raw: &Secret,
) -> Result<Option<ResolvedKeyReference>> {
    Ok(lookup_reference(tx, tenant, raw)?.0)
}

pub(crate) fn resolve_reference(
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

pub(crate) struct StreamKeyAuthority {
    pub(crate) principal: KeyPrincipal,
    pub(crate) key_id: String,
    pub(crate) expires_at: Option<i64>,
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

pub(crate) fn stream_authority(
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
    let hash = digest(raw.expose())?;
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
pub(crate) fn resolve_ref(tx: &Transaction<'_>, tenant: &str, raw: &Secret) -> Result<Outcome> {
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
