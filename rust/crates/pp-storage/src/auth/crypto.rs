use super::Secret;
use anyhow::{Result, anyhow, ensure};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
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
        "Password must be at least 8 characters"
    );
    ensure!(password.0.len() <= 4096, "Password too long");
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
pub(super) fn verify(password: &Secret, stored: &str) -> bool {
    verify_with_kdf(
        password,
        stored,
        |salt, expected| {
            let Ok(params) = scrypt::Params::new(14, 8, 1, 64) else {
                return false;
            };
            let mut actual = [0; 64];
            scrypt::scrypt(password.0.as_bytes(), salt, &params, &mut actual).is_ok()
                && bool::from(actual.ct_eq(expected))
        },
        |parsed| {
            Argon2::default()
                .verify_password(password.0.as_bytes(), parsed)
                .is_ok()
        },
    )
}

fn verify_with_kdf(
    password: &Secret,
    stored: &str,
    scrypt_kdf: impl FnOnce(&[u8], &[u8]) -> bool,
    argon2_kdf: impl FnOnce(&PasswordHash<'_>) -> bool,
) -> bool {
    if password.0.len() > 4096 || stored.len() > 512 {
        return false;
    }
    if stored.starts_with("scrypt:") {
        let fields: Vec<_> = stored.split(':').collect();
        if fields.len() != 6 || fields[1..4] != ["16384", "8", "1"] {
            return false;
        }
        let (Ok(salt), Ok(expected)) = (
            URL_SAFE_NO_PAD.decode(fields[4]),
            URL_SAFE_NO_PAD.decode(fields[5]),
        ) else {
            return false;
        };
        if salt.len() != 16 || expected.len() != 64 {
            return false;
        }
        scrypt_kdf(&salt, &expected)
    } else {
        let Ok(parsed) = PasswordHash::new(stored) else {
            return false;
        };
        if parsed.algorithm.as_str() != "argon2id"
            || parsed.version != Some(19)
            || parsed.params.get_decimal("m") != Some(19456)
            || parsed.params.get_decimal("t") != Some(2)
            || parsed.params.get_decimal("p") != Some(1)
            || parsed.params.iter().count() != 3
            || parsed.hash.is_none_or(|hash| hash.len() != 32)
            || parsed.salt.is_none_or(|salt| salt.as_str().len() != 22)
        {
            return false;
        }
        argon2_kdf(&parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_t_17_hostile_costs_reject_before_hashing() {
        let password = Secret::new("password-before".into());
        let scrypt = include_str!("../../tests/node-scrypt.txt").trim();
        // Valid salt and output lengths isolate rejection of the cost parameters.
        let argon2 = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let invalid = [
            scrypt.replacen(":16384:", ":1073741824:", 1),
            scrypt.replacen(":8:", ":4294967295:", 1),
            scrypt.replacen(":1:", ":999999999:", 1),
            "scrypt:16384:8:1:AAAA:AAAA".into(),
            argon2.replace("m=19456", "m=4294967295"),
            argon2.replace("t=2", "t=999999999"),
            "not-a-password-hash".into(),
        ];
        for stored in &invalid {
            assert!(!verify_with_kdf(
                &password,
                stored,
                |_, _| panic!("hostile input reached scrypt"),
                |_| panic!("hostile input reached Argon2"),
            ));
        }
        // Positive controls prove valid inputs reach the injected KDFs.
        assert!(verify_with_kdf(
            &password,
            scrypt,
            |_, _| true,
            |_| panic!("scrypt input reached Argon2"),
        ));
        assert!(verify_with_kdf(
            &password,
            argon2,
            |_, _| panic!("Argon2 input reached scrypt"),
            |_| true,
        ));
    }
}
