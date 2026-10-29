# GRE-1006: log redaction for settings secrets

`pp_compat::redact::Scrubber` is the one scrub policy for `core.log`, `compat.log`, the Logs view and Sentry. `CoreLog` runs every `tracing` event's fields through it before writing a row.

GRE-1006 adds the secrets that the prod inventory found in `app_settings`:

- Field names `webhook`, `webhook_url`, `webhookUrl`, `pat`, `api_keys` and any name ending in `_webhook`, `_webhook_url`, `_pat` or `_keys`.
- A trailing version suffix is ignored, so `api_keys_v1` matches `api_keys`.
- Webhook URLs keep their host and id but lose the token: `https://discord.com/api/webhooks/1234/[REDACTED]`. Slack `hooks.slack.com/services/...` paths are redacted the same way.

Existing rules still cover `password`, `token`, `cookie`, `authorization`, `api_key`, URL userinfo, query parameters, header lines and known token shapes (`ghp_`, `github_pat_`, JWTs, `sk_live_`).

Tests:

- `redact::tests::gre_1006_scrub_covers_webhooks_pats_and_versioned_key_settings`
- `logs::tests::gre_1006_core_log_redacts_each_sensitive_field_kind` emits tracing events with each field kind as a field, inside a URL and inside a header map, then checks that `core.log` has no planted value and only `[REDACTED]` markers.

Not in this slice: moving the secrets into `native_secrets`, the `app_settings` migration, and backup exclusion. Those touch `pp-storage`, which belongs to the storage lane.
