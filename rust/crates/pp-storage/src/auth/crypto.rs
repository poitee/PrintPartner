use super::{AuthFailure, AuthInputFailure, Secret};
use anyhow::{Result, anyhow, ensure};
use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHashString, SaltString},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub(super) fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| anyhow!("Entropy unavailable"))?;
    Ok(bytes)
}
pub(super) fn token() -> Result<Secret> {
    Ok(Secret(hex::encode(random::<32>()?)))
}
pub(super) fn digest(raw: &str) -> String {
    hex::encode(Sha256::digest(raw.as_bytes()))
}
pub(super) fn validate(password: &Secret) -> Result<()> {
    ensure!(
        password.0.encode_utf16().count() >= 8,
        AuthFailure::InvalidInput(AuthInputFailure::PasswordTooShort)
    );
    ensure!(
        password.0.len() <= 4096,
        AuthFailure::InvalidInput(AuthInputFailure::TooLong)
    );
    Ok(())
}
pub(super) fn hash(password: &Secret) -> Result<String> {
    validate(password)?;
    let salt =
        SaltString::encode_b64(&random::<16>()?).map_err(|_| anyhow!("Salt encoding failed"))?;
    Argon2::default()
        .hash_password(password.0.as_bytes(), &salt)
        .map(|v| v.to_string())
        .map_err(|_| anyhow!("Password hashing failed"))
}

pub(super) enum SupportedPasswordHash {
    Argon2id(PasswordHashString),
    LegacyScrypt { salt: [u8; 16], expected: [u8; 64] },
}

impl SupportedPasswordHash {
    pub(super) fn is_legacy(&self) -> bool {
        matches!(self, Self::LegacyScrypt { .. })
    }
}

pub(super) fn inspect(stored: &str) -> Option<SupportedPasswordHash> {
    if stored.len() > 512 {
        return None;
    }
    if stored.starts_with("scrypt:") {
        let fields: Vec<_> = stored.split(':').collect();
        if fields.len() != 6 || fields[1..4] != ["16384", "8", "1"] {
            return None;
        }
        let (Ok(salt), Ok(expected)) = (
            URL_SAFE_NO_PAD.decode(fields[4]),
            URL_SAFE_NO_PAD.decode(fields[5]),
        ) else {
            return None;
        };
        Some(SupportedPasswordHash::LegacyScrypt {
            salt: salt.try_into().ok()?,
            expected: expected.try_into().ok()?,
        })
    } else {
        let owned = PasswordHashString::new(stored).ok()?;
        let parsed = owned.password_hash();
        if parsed.algorithm.as_str() != "argon2id"
            || parsed.version != Some(19)
            || parsed.params.get_decimal("m") != Some(19456)
            || parsed.params.get_decimal("t") != Some(2)
            || parsed.params.get_decimal("p") != Some(1)
            || parsed.params.iter().count() != 3
            || parsed.hash.is_none_or(|hash| hash.len() != 32)
            || parsed.salt.is_none_or(|salt| salt.as_str().len() != 22)
        {
            return None;
        };
        Some(SupportedPasswordHash::Argon2id(owned))
    }
}

pub(super) fn verify_supported(password: &Secret, stored: &SupportedPasswordHash) -> bool {
    if password.0.len() > 4096 {
        return false;
    }
    match stored {
        SupportedPasswordHash::LegacyScrypt { salt, expected } => {
            let Ok(params) = scrypt::Params::new(14, 8, 1, 64) else {
                return false;
            };
            let mut actual = [0; 64];
            scrypt::scrypt(password.0.as_bytes(), salt, &params, &mut actual).is_ok()
                && bool::from(actual.ct_eq(expected))
        }
        SupportedPasswordHash::Argon2id(owned) => Argon2::default()
            .verify_password(password.0.as_bytes(), &owned.password_hash())
            .is_ok(),
    }
}

#[cfg(test)]
pub(super) fn verify(password: &Secret, stored: &str) -> bool {
    inspect(stored).is_some_and(|stored| verify_supported(password, &stored))
}
