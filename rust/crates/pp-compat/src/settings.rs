//! Where each environment setting of the Node server lives on desktop (design §4,
//! "Env → desktop setting"). The compatibility child starts with a cleared
//! environment, so only the `Fixed` values below reach it. Every other owner
//! supplies its value through its own path, and a change to any of them takes
//! effect on the next compatibility restart. Settings Node reads outside
//! `config.ts`, such as `SLICER_*_DIR`, are not covered yet.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    /// Passed to the child unchanged on every launch.
    Fixed(&'static str),
    /// Decided by core or the desktop entry point, never by the user.
    Core,
    /// User setting persisted in `desktop.toml`.
    DesktopToml,
    /// Secret held by the credential adapter. Never part of an ordinary settings payload.
    Credential,
    /// Stored in the database and edited in the app.
    Database,
    /// Not used on desktop: hosted, Docker self-host or multi-user only, or behind a
    /// feature that desktop keeps off. Left unset.
    Hidden,
}

/// Every `process.env` name read by `web/apps/server/src/config.ts`.
pub const ENVIRONMENT: &[(&str, Owner)] = &[
    ("AI_DAILY_REQUEST_BUDGET", Owner::Database),
    ("AI_DAILY_TOKEN_BUDGET", Owner::Database),
    ("AI_ENABLED", Owner::Fixed("0")),
    ("AI_MAX_TOKENS", Owner::Database),
    ("AI_MODEL", Owner::Database),
    ("AI_PROVIDER", Owner::Database),
    ("ALLOWED_ORIGINS", Owner::Core),
    ("ANTHROPIC_API_KEY", Owner::Credential),
    ("APP_PUBLIC_URL", Owner::Hidden),
    ("ASSISTANT_ALLOW_URL_INGEST", Owner::Database),
    ("ASSISTANT_GUIDE_INGEST_MAX_BYTES", Owner::Hidden),
    ("AUTH_SUCCESS_REDIRECT", Owner::Hidden),
    ("BASIC_AUTH_PASS", Owner::Hidden),
    ("BASIC_AUTH_USER", Owner::Hidden),
    ("BRAVE_API_KEY", Owner::Credential),
    ("CORS_ORIGIN", Owner::Core),
    ("DATABASE_URL", Owner::Hidden),
    ("DEPLOY_MODE", Owner::Fixed("self-host")),
    ("DISCORD_CALLBACK_URL", Owner::Hidden),
    ("DISCORD_CLIENT_ID", Owner::Hidden),
    ("DISCORD_CLIENT_SECRET", Owner::Hidden),
    ("EXA_API_KEY", Owner::Credential),
    ("GITHUB_CALLBACK_URL", Owner::Hidden),
    ("GITHUB_CLIENT_ID", Owner::Hidden),
    ("GITHUB_CLIENT_SECRET", Owner::Hidden),
    ("GITHUB_REPO", Owner::Hidden),
    ("GOOGLE_CLIENT_ID", Owner::Hidden),
    ("HOST", Owner::Fixed("127.0.0.1")),
    ("INTEGRATION_API_KEY", Owner::Credential),
    ("MULTI_USER", Owner::Core),
    ("NODE_ENV", Owner::Core),
    ("OLLAMA_URL", Owner::Database),
    ("OPENAI_API_KEY", Owner::Credential),
    ("OPENAI_BASE_URL", Owner::Database),
    ("PASSWORD_RESET_DEV_EXPOSE", Owner::Hidden),
    ("PORT", Owner::Core),
    ("POSTGRES_EXPERIMENTAL", Owner::Hidden),
    ("PP_EXCHANGE_DIR", Owner::DesktopToml),
    ("PRINT_PARTNER_API_KEY", Owner::Credential),
    ("PRINT_PARTNER_DATA_DIR", Owner::Core),
    ("PRINT_PARTNER_LATEST_VERSION", Owner::Hidden),
    ("PRINT_PARTNER_UPDATE_CHECK", Owner::Fixed("0")),
    ("PRINT_PARTNER_UPDATE_CHECK_CACHE_HOURS", Owner::Hidden),
    ("REGISTRATION_OPEN", Owner::Core),
    ("SAAS_ALLOW_ANONYMOUS", Owner::Hidden),
    ("SAAS_BASIC_AUTH", Owner::Hidden),
    ("SAAS_BASIC_AUTH_PASS", Owner::Hidden),
    ("SAAS_BASIC_AUTH_USER", Owner::Hidden),
    ("SAAS_DATA_DIR", Owner::Hidden),
    ("SEARCH_API_KEY", Owner::Credential),
    ("SEARCH_PROVIDER", Owner::Database),
    // Turns on with optional LAN HTTPS (T-42); off until then.
    ("SESSION_COOKIE_SECURE", Owner::Core),
    ("SESSION_SECRET", Owner::Credential),
    ("SINGLE_USER_AUTH", Owner::Core),
    ("SMTP_FROM", Owner::Hidden),
    ("SMTP_HOST", Owner::Hidden),
    ("SMTP_PASS", Owner::Hidden),
    ("SMTP_PORT", Owner::Hidden),
    ("SMTP_SECURE", Owner::Hidden),
    ("SMTP_USER", Owner::Hidden),
    ("SOURCE_DOCS_MAX_BYTES", Owner::Hidden),
    ("STATIC_DIR", Owner::Core),
    ("TRUST_PROXY", Owner::Core),
];

/// The environment pairs the compatibility child receives on top of the inherited
/// `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL` and `TZ`.
pub fn fixed_env() -> impl Iterator<Item = (&'static str, &'static str)> {
    ENVIRONMENT.iter().filter_map(|(name, owner)| match owner {
        Owner::Fixed(value) => Some((*name, *value)),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn config_names() -> BTreeSet<String> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../web/apps/server/src/config.ts"
        );
        let text = std::fs::read_to_string(path).unwrap();
        text.match_indices("process.env.")
            .map(|(at, prefix)| {
                text[at + prefix.len()..]
                    .chars()
                    .take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_')
                    .collect::<String>()
            })
            .filter(|name| !name.is_empty())
            .collect()
    }

    #[test]
    fn ticket_t_33_every_node_config_setting_has_one_desktop_owner() {
        let mapped: Vec<&str> = ENVIRONMENT.iter().map(|(name, _)| *name).collect();
        let unique: BTreeSet<String> = mapped.iter().map(|name| name.to_string()).collect();
        assert_eq!(unique.len(), mapped.len(), "a setting is listed twice");
        assert_eq!(unique, config_names());
    }

    #[test]
    fn ticket_t_33_child_receives_only_the_fixed_settings() {
        let fixed: Vec<_> = fixed_env().collect();
        assert_eq!(
            fixed,
            [
                ("AI_ENABLED", "0"),
                ("DEPLOY_MODE", "self-host"),
                ("HOST", "127.0.0.1"),
                ("PRINT_PARTNER_UPDATE_CHECK", "0"),
            ]
        );
    }

    #[test]
    fn ticket_t_33_secrets_stay_out_of_ordinary_settings() {
        for (name, owner) in ENVIRONMENT {
            if ["SECRET", "PASS", "_KEY"]
                .iter()
                .any(|marker| name.contains(marker))
            {
                assert!(
                    matches!(owner, Owner::Credential | Owner::Hidden),
                    "{name} is {owner:?}"
                );
            }
        }
    }
}
