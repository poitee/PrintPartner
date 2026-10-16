# Server Spoolman access

With `PP_DESKTOP_REBUILD=1` or `true`, Spoolman access follows the account setting and the current Plan override.
With the flag off, access keeps its existing behavior.

The Spoolman proxy routes and `GET /filaments/catalog` accept an optional `profile_id` query parameter.
It must be a positive safe integer identifying a Plan owned by the current tenant.
Requests that omit `profile_id` use account settings, so existing clients keep account semantics.
Malformed IDs return 400, missing or foreign Plans return 404, and invalid stored feature settings return 500.

Disabled access prevents new Spoolman assignments, inventory reads, deductions, and assistant proposals.
The catalog still returns base and custom colors, but omits `default_spoolman_integration_id` and returns no Spoolman colors.
Handlers recheck access after remote inventory reads before returning inventory or applying an assistant assignment.

Saving a Plan preserves its existing Spoolman references while access is disabled.
New draft parts, duplicated Plans, and kit imports omit Spoolman references when the target Plan has no access.
Non-Spoolman colors and custom hex values remain intact.
