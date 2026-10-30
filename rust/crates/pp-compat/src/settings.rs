//! Where each environment setting of the Node server lives on desktop (design §4,
//! "Env → desktop setting"). The compatibility child starts with a cleared
//! environment, so only the `Fixed` values below reach it. Every other owner
//! supplies its value through its own path, and a change to any of them takes
//! effect on the next compatibility restart.

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

/// Every environment name the Node server reads: `process.env.NAME`, the one
/// dynamic `process.env[storageParentIdentityEnv]`, and `env.NAME` on an
/// environment object passed down from `process.env`.
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
    ("BAMBU_CONNECT_HOST_PATH_MAP", Owner::Hidden),
    ("BAMBU_CONNECT_LAUNCH", Owner::Hidden),
    ("BASIC_AUTH_PASS", Owner::Hidden),
    ("BASIC_AUTH_USER", Owner::Hidden),
    ("BRAVE_API_KEY", Owner::Credential),
    ("CORS_ORIGIN", Owner::Core),
    ("DATABASE_URL", Owner::Hidden),
    ("DEPLOY_MODE", Owner::Fixed("self-host")),
    ("DISCORD_CALLBACK_URL", Owner::Hidden),
    ("DISCORD_CLIENT_ID", Owner::Hidden),
    ("DISCORD_CLIENT_SECRET", Owner::Hidden),
    ("DOCKER_SOCKET", Owner::DesktopToml),
    ("EXA_API_KEY", Owner::Credential),
    ("GITHUB_CALLBACK_URL", Owner::Hidden),
    ("GITHUB_CLIENT_ID", Owner::Hidden),
    ("GITHUB_CLIENT_SECRET", Owner::Hidden),
    ("GITHUB_REPO", Owner::Hidden),
    ("GOOGLE_CLIENT_ID", Owner::Hidden),
    // Core owns the real listener and hands the child a socket path in the setup
    // pipe (PORT is Core). The child still reads HOST, so it stays pinned to loopback.
    ("HOST", Owner::Fixed("127.0.0.1")),
    ("INTEGRATION_API_KEY", Owner::Credential),
    ("MQTTJS_SOCKS_PROXY", Owner::Hidden),
    ("MULTI_USER", Owner::Core),
    ("NODE_ENV", Owner::Core),
    ("OLLAMA_NUM_CTX", Owner::Database),
    ("OLLAMA_URL", Owner::Database),
    ("OPENAI_API_KEY", Owner::Credential),
    ("OPENAI_BASE_URL", Owner::Database),
    // Core for now: the route turns the UI on while NODE_ENV is not "production",
    // and the child leaves NODE_ENV unset. Becomes a desktop.toml setting
    // (Settings > Advanced, design §4) once GRE-1037 sets NODE_ENV.
    ("OPENAPI_UI", Owner::Core),
    ("PASSWORD_RESET_DEV_EXPOSE", Owner::Hidden),
    ("PORT", Owner::Core),
    ("POSTGRES_EXPERIMENTAL", Owner::Hidden),
    ("PP_COMPOSE_FILE", Owner::DesktopToml),
    ("PP_DESKTOP_REBUILD", Owner::Core),
    ("PP_EXCHANGE_DIR", Owner::DesktopToml),
    ("PP_SOURCE_SYNC_OWNERSHIP_MANIFEST", Owner::Hidden),
    ("PP_STORAGE_CORE_LOCK", Owner::Fixed("1")),
    ("PP_STORAGE_PARENT_IDENTITY", Owner::Core),
    ("PP_STORAGE_RELEASE_RECOVERY", Owner::Hidden),
    ("PRINT_PARTNER_API_KEY", Owner::Credential),
    ("PRINT_PARTNER_DATA_DIR", Owner::Core),
    ("PRINT_PARTNER_IN_CONTAINER", Owner::Hidden),
    ("PRINT_PARTNER_LATEST_VERSION", Owner::Hidden),
    ("PRINT_PARTNER_MCP_PLAN_ID", Owner::Hidden),
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
    ("SLICER_BAMBU_DIR", Owner::DesktopToml),
    ("SLICER_ORCA_DIR", Owner::DesktopToml),
    ("SLICER_PRUSA_DIR", Owner::DesktopToml),
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

/// The environment pairs the compatibility child receives. It also inherits `PATH`,
/// `HOME`, `TMPDIR`, `LANG`, `LC_ALL` and `TZ`, and gets the release commit in `PP_COMMIT`.
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

    /// Environment names read by the non-test server sources. Names are UPPER_SNAKE:
    /// `process.env.<anything else>` fails, and so does any `process.env[...]` other
    /// than the one storage identity lookup. `env.NAME` on an environment object
    /// passed down from `process.env` is collected too; camelCase `env.*` keys
    /// belong to config objects such as the assistant settings, not the environment.
    fn server_names() -> BTreeSet<String> {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../web/apps/server/src");
        let mut files = vec![std::path::PathBuf::from(root)];
        let mut names = BTreeSet::new();
        while let Some(path) = files.pop() {
            if path.is_dir() {
                if path.file_name().is_some_and(|name| name == "test") {
                    continue;
                }
                files.extend(
                    std::fs::read_dir(&path)
                        .unwrap()
                        .map(|entry| entry.unwrap().path()),
                );
                continue;
            }
            let file = path.to_string_lossy();
            if !file.ends_with(".ts") || file.ends_with(".test.ts") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            for (at, _) in text.match_indices("env") {
                let before = text[..at].chars().next_back();
                let after = &text[at + 3..];
                let process = text[..at].ends_with("process.");
                if !process && before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '.') {
                    continue;
                }
                if let Some(rest) = after.strip_prefix('.') {
                    let name: String = rest
                        .chars()
                        .take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_')
                        .collect();
                    assert!(
                        !process
                            || !rest[name.len()..]
                                .starts_with(|c: char| c.is_alphanumeric() || c == '_'),
                        "process.env read with a name that is not UPPER_SNAKE in {file}"
                    );
                    if name.len() > 1 && name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
                    {
                        names.insert(name);
                    }
                } else if process && after.starts_with('[') {
                    assert!(
                        after.starts_with("[storageParentIdentityEnv]"),
                        "unrecognized process.env lookup in {file}"
                    );
                    names.insert("PP_STORAGE_PARENT_IDENTITY".to_owned());
                }
            }
        }
        let lease = std::fs::read_to_string(format!("{root}/storage-lease.ts")).unwrap();
        assert!(lease.contains(r#"storageParentIdentityEnv = "PP_STORAGE_PARENT_IDENTITY""#));
        names
    }

    #[test]
    fn ticket_t_33_every_server_setting_has_one_desktop_owner() {
        let mapped: Vec<&str> = ENVIRONMENT.iter().map(|(name, _)| *name).collect();
        let unique: BTreeSet<String> = mapped.iter().map(|name| name.to_string()).collect();
        assert_eq!(unique.len(), mapped.len(), "a setting is listed twice");
        assert_eq!(unique, server_names());
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
                ("PP_STORAGE_CORE_LOCK", "1"),
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
