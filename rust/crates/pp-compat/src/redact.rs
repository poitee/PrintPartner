//! The one scrub policy for local log files, the Logs view and opt-in Sentry
//! (GRE-336). Every sink that persists or uploads text applies [`Scrubber`];
//! there is no second policy.
//!
//! The policy over-redacts on purpose: a value is replaced when its name looks
//! like a credential, when it uses a known token shape, or when it equals a
//! secret the process registered at runtime.

use regex::{Captures, Regex};
use std::sync::LazyLock;

pub const REDACTED: &str = "[REDACTED]";

/// Header names whose whole value is a credential. In free text the rest of
/// the line is dropped, because cookie lists and auth parameters contain
/// separators.
const HEADERS: &str =
    "authorization|proxy-authorization|cookie|set-cookie|x-pp-principal|x-pp-signature|x-api-key";

/// Field, header, query and environment names that carry credentials.
pub fn sensitive_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase().replace('-', "_");
    matches!(
        name.as_str(),
        "authorization"
            | "proxy_authorization"
            | "cookie"
            | "cookies"
            | "set_cookie"
            | "x_pp_principal"
            | "x_pp_signature"
            | "principal"
            | "signature"
            | "bootstrap"
            | "token"
            | "secret"
            | "password"
            | "passwd"
            | "passphrase"
            | "key"
            | "apikey"
            | "credential"
            | "credentials"
            | "session"
            | "sessionid"
    ) || [
        "_token",
        "_secret",
        "_password",
        "_key",
        "_apikey",
        "_credential",
        "_session",
    ]
    .iter()
    .any(|suffix| name.ends_with(suffix))
}

/// Names that are credentials only inside a URL query, such as OAuth codes.
fn sensitive_query_name(name: &str) -> bool {
    sensitive_name(name) || matches!(name.to_ascii_lowercase().as_str(), "code" | "state" | "sig")
}

struct Rules {
    url_userinfo: Regex,
    token_shapes: Regex,
    json_pair: Regex,
    header_line: Regex,
    auth_scheme: Regex,
    pair: Regex,
}

/// `None` only if a pattern fails to compile; [`Scrubber::text`] then
/// redacts the whole text instead of passing it through.
static RULES: LazyLock<Option<Rules>> = LazyLock::new(|| {
    Some(Rules {
        url_userinfo: Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@").ok()?,
        token_shapes: Regex::new(concat!(
            r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+",
            r"|\b(?:sk|pk|rk)[-_](?:live[-_]|test[-_])?[A-Za-z0-9_-]{16,}",
            r"|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}",
            r"|\bxox[abprs]-[A-Za-z0-9-]{10,}",
            r"|\bAKIA[0-9A-Z]{16}\b",
        ))
        .ok()?,
        json_pair: Regex::new(r#""([A-Za-z0-9_.-]+)"(\s*:\s*)"((?:[^"\\]|\\.)*)""#).ok()?,
        header_line: Regex::new(&format!(
            r#"(?i)\b({HEADERS})(["']?\s*:\s*)("\[REDACTED\]"|[^\r\n]*)"#
        ))
        .ok()?,
        auth_scheme: Regex::new(r"(?i)\b(bearer|basic|digest)(\s+)[A-Za-z0-9._~+/=-]+").ok()?,
        pair: Regex::new(r#"([A-Za-z][A-Za-z0-9_.-]*)(["']?\s*[=:]\s*["']?)([^\s"'&,;?#}\]]+)"#)
            .ok()?,
    })
});

/// Applies the shared scrub policy, plus secrets known only at runtime.
#[derive(Clone, Default)]
pub struct Scrubber {
    literals: Vec<String>,
}

impl Scrubber {
    /// Also replace this exact value wherever it appears. Values shorter than
    /// eight bytes are ignored so that common words are never registered.
    pub fn with_secret(mut self, secret: impl Into<String>) -> Self {
        let secret = secret.into();
        if secret.len() >= 8 && !self.literals.contains(&secret) {
            self.literals.push(secret);
            self.literals
                .sort_by_key(|literal| std::cmp::Reverse(literal.len()));
        }
        self
    }

    pub fn text(&self, text: &str) -> String {
        let Some(rules) = RULES.as_ref() else {
            return REDACTED.to_owned();
        };
        let mut text = text.to_owned();
        for literal in &self.literals {
            if text.contains(literal.as_str()) {
                text = text.replace(literal.as_str(), REDACTED);
            }
        }
        let text = rules
            .url_userinfo
            .replace_all(&text, format!("${{1}}{REDACTED}@"));
        let text = rules.token_shapes.replace_all(&text, REDACTED);
        let text = rules.json_pair.replace_all(&text, |caps: &Captures| {
            if sensitive_name(&caps[1]) {
                format!("\"{}\"{}\"{REDACTED}\"", &caps[1], &caps[2])
            } else {
                caps[0].to_owned()
            }
        });
        let text = rules.header_line.replace_all(&text, |caps: &Captures| {
            if &caps[3] == "\"[REDACTED]\"" {
                caps[0].to_owned()
            } else {
                format!("{}{}{REDACTED}", &caps[1], &caps[2])
            }
        });
        let text = rules
            .auth_scheme
            .replace_all(&text, format!("${{1}}${{2}}{REDACTED}"));
        let haystack = text.as_ref();
        rules
            .pair
            .replace_all(haystack, |caps: &Captures| {
                let start = caps.get(0).map_or(0, |whole| whole.start());
                let in_query = haystack[..start].ends_with(['?', '&']);
                let sensitive = if in_query {
                    sensitive_query_name(&caps[1])
                } else {
                    sensitive_name(&caps[1])
                };
                if sensitive && !caps[3].starts_with("[REDACTED") {
                    format!("{}{}{REDACTED}", &caps[1], &caps[2])
                } else {
                    caps[0].to_owned()
                }
            })
            .into_owned()
    }

    /// Scrub a JSON value in place. A credential-named field loses its whole
    /// value; every other string is scrubbed as text.
    pub fn json(&self, value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(text) => *text = self.text(text),
            serde_json::Value::Array(items) => items.iter_mut().for_each(|item| self.json(item)),
            serde_json::Value::Object(fields) => {
                for (name, field) in fields.iter_mut() {
                    if sensitive_name(name) && !field.is_null() {
                        *field = serde_json::Value::String(REDACTED.to_owned());
                    } else {
                        self.json(field);
                    }
                }
            }
            _ => {}
        }
    }

    /// Scrub an error and every source in its chain, joined with `": "`.
    pub fn error(&self, error: &(dyn std::error::Error + 'static)) -> String {
        let mut chain = vec![self.text(&error.to_string())];
        let mut source = error.source();
        while let Some(cause) = source {
            chain.push(self.text(&cause.to_string()));
            source = cause.source();
        }
        chain.join(": ")
    }
}

/// Scrub text with the shared policy and no runtime secrets.
pub fn scrub(text: &str) -> String {
    Scrubber::default().text(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLANTED: [&str; 12] = [
        "PLANTED_BEARER_1f9c",
        "PLANTED_COOKIE_77aa",
        "PLANTED_SESSION_PAIR",
        "PLANTED_BOOTSTRAP_e1",
        "PLANTED_OAUTH_CODE_9",
        "PLANTED_PRINCIPAL_5d",
        "PLANTED_SIGNATURE_42",
        "PLANTED_API_KEY_beef",
        "PLANTED_PASSWORD_00",
        "PLANTED_USERINFO_PW",
        "PLANTED_RUNTIME_KEY_ab12cd34",
        "PLANTED_CLIENT_SECRET",
    ];

    fn planted_text() -> String {
        [
            "request failed Authorization: Bearer PLANTED_BEARER_1f9c",
            "Cookie: pp_session=PLANTED_COOKIE_77aa; theme=dark; sid=PLANTED_SESSION_PAIR",
            "GET http://127.0.0.1:4100/desktop?bootstrap=PLANTED_BOOTSTRAP_e1&tab=jobs",
            "redirect url=/desktop?bootstrap=PLANTED_BOOTSTRAP_e1",
            "callback /oauth/return?code=PLANTED_OAUTH_CODE_9&state=x",
            "x-pp-principal: PLANTED_PRINCIPAL_5d",
            "headers {\"x-pp-signature\":\"PLANTED_SIGNATURE_42\",\"accept\":\"*/*\"}",
            "spoolman api_key=PLANTED_API_KEY_beef retrying",
            "login password: 'PLANTED_PASSWORD_00'",
            "proxy https://chad:PLANTED_USERINFO_PW@proxy.local/",
            "setup echo PLANTED_RUNTIME_KEY_ab12cd34",
            "oauth client_secret=\"PLANTED_CLIENT_SECRET\"",
        ]
        .join("\n")
    }

    #[test]
    fn ticket_t_13_scrub_removes_planted_secrets_from_messages() {
        let scrubber = Scrubber::default().with_secret("PLANTED_RUNTIME_KEY_ab12cd34");
        let scrubbed = scrubber.text(&planted_text());
        for secret in PLANTED {
            assert!(!scrubbed.contains(secret), "{secret} leaked: {scrubbed}");
        }
        assert!(scrubbed.contains("Authorization: [REDACTED]"));
        assert!(scrubbed.contains("?bootstrap=[REDACTED]&tab=jobs"));
        assert!(scrubbed.contains("\"accept\":\"*/*\""));
        assert!(scrubbed.contains("https://[REDACTED]@proxy.local/"));
        assert!(scrubbed.contains("spoolman api_key=[REDACTED] retrying"));
    }

    #[test]
    fn ticket_t_13_scrub_keeps_ordinary_diagnostics_readable() {
        let text = "compat exited code=1 after 3 attempts; state: ready, path=/srv/jobs?page=2";
        assert_eq!(scrub(text), text);
        let once = scrub("token=abc123456 Bearer abcdefgh");
        assert_eq!(once, "token=[REDACTED] Bearer [REDACTED]");
        assert_eq!(scrub(&once), once);
    }

    #[test]
    fn ticket_t_13_scrub_recognizes_token_shapes_without_names() {
        let text = "seen eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJl and \
                    sk_live_0123456789abcdefXYZ and ghp_0123456789abcdefghijABCD and AKIAABCDEFGHIJKLMNOP";
        assert_eq!(
            scrub(text),
            "seen [REDACTED] and [REDACTED] and [REDACTED] and [REDACTED]"
        );
    }

    #[test]
    fn ticket_t_13_scrub_json_drops_credential_fields_and_scrubs_strings() {
        let mut value = serde_json::json!({
            "level": 50,
            "msg": "upstream rejected Bearer PLANTED_BEARER_1f9c",
            "req": {"url": "/desktop?bootstrap=PLANTED_BOOTSTRAP_e1", "headers": {
                "authorization": "Basic PLANTED_PASSWORD_00",
                "cookie": "pp_session=PLANTED_COOKIE_77aa",
                "x-pp-principal": "PLANTED_PRINCIPAL_5d",
                "accept": "*/*"
            }},
            "integration": {"spoolman": {"apiKey": "PLANTED_API_KEY_beef", "client_secret": {"v": "PLANTED_CLIENT_SECRET"}}},
            "err": {"message": "boom", "stack": "Error: echo PLANTED_RUNTIME_KEY_ab12cd34\n    at x.js:1"},
            "key": null
        });
        Scrubber::default()
            .with_secret("PLANTED_RUNTIME_KEY_ab12cd34")
            .json(&mut value);
        let text = value.to_string();
        for secret in PLANTED {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert_eq!(value["req"]["headers"]["accept"], "*/*");
        assert_eq!(value["req"]["headers"]["cookie"], REDACTED);
        assert_eq!(value["integration"]["spoolman"]["apiKey"], REDACTED);
        assert_eq!(value["level"], 50);
        assert!(value["key"].is_null());
    }

    #[test]
    fn ticket_t_13_scrub_error_walks_the_whole_chain() {
        let error = anyhow::anyhow!("token=PLANTED_BEARER_1f9c rejected")
            .context("GET /desktop?bootstrap=PLANTED_BOOTSTRAP_e1")
            .context("Compatibility request failed");
        let scrubbed = Scrubber::default().error(error.as_ref());
        assert_eq!(
            scrubbed,
            "Compatibility request failed: GET /desktop?bootstrap=[REDACTED]: token=[REDACTED] rejected"
        );
    }
}
