# References-only sharing

Status: Build and collection export, read-only validation, explicit dependency mapping, and printable Build creation are implemented. Direct Git publishing is still a later increment.

Tracking: [GitHub issue 65](https://github.com/poitee/PrintPartner/issues/65).

## Decision

Sharing distributes a recipe and references, never model files. This applies even when a model license permits redistribution. Recipients obtain models from the original publisher with their own access. Sharing does not add an approval or publication gate to normal planning, Production, or Checkoff.

The sharing manifest is distinct from a Source's option manifest and the legacy Kit backup format. A Build manifest describes one recipe. A collection manifest describes selected Library Sources. Neither is a database export or a backup.

## User workflow

1. Open Share on a Build and choose the references-only option.
2. Preview the exact manifest. It includes title, source page links, branch/tag/commit when available, file rules, relative part paths, quantities, colors, and option selections.
3. Download `printpartner.share.json`, or a Git-ready ZIP containing that same file, a README, and a defensive `.gitignore`. No models, thumbnails, sliced files, printer assignments, credentials, customer order numbers, private notes, or progress are included.
4. Review the text before sharing. Names, file paths, and selected options can themselves be private. Source visibility cannot be established from a URL alone.
5. Commit these text files to a repository the user chooses. PrintPartner does not create a remote repository or push on the user's behalf in this increment.

Git-ready means ready for an ordinary Git commit, not a new Git protocol. A later GitHub integration must show owner/repository/branch/path, requested permissions, exact diff, and visibility before creating a commit or PR. Never infer a public destination. Use least-privilege installation permissions and never embed tokens in files or URLs.

## Format v1

The format discriminator is `printpartner-reference-share`, with integer `version: 1`, and `kind: build | collection`. Strict validation rejects unknown fields, embedded content, unsafe paths, malformed references, unsupported versions, and dangling source references. Each source receives a document-local key, not a server database id. Source identity for future import uses origin URL and exact revision/content verification, never the display name.

Source locations are either an original HTTPS publisher page or `manual`, meaning the recipient must locate the original. Initial export supports GitHub, GitLab, Codeberg, Printables, MakerWorld, and Thangs page URLs. Other URLs, local paths, URLs with credentials, query strings, or fragments are omitted and produce warnings. No source URL is fetched by manifest validation or export. A hostname allowlist does not establish that a repository is public or that a user has access.

Git commits are recorded when known; a branch or tag alone is not an immutable content guarantee. Missing revision information must be visible, not manufactured. Build output is deterministic for unchanged recipe data, without export timestamps. No model bytes are read to generate this format.

The initial format does not assert licenses or authorship absent reliable metadata. It directs recipients to the original publisher for attribution, license terms, and downloads. Later provenance metadata must describe original authors, not grant new rights over their models.

## Receiving a manifest

Validation previews JSON without creating or changing data. The format is deliberately not passed to the legacy Kit importer, which matches Sources by name and can change shared import rules.

A recipient maps each reference to a Library Source they already have. The check shows `File required`, `Revision unverified`, or `Ready` per included part. A printable Build is created only when every included part is Ready. Relative path and recorded commit are checked. A same-name Source is not selected automatically, and import rules are left unchanged.

Creating a Build must be atomic or recoverably idempotent. It creates recipient-owned state, resets Checkoff, and leaves printers unassigned. A retry must not create duplicate Builds. Do not download models through the sender, mirror them in Git, bypass paid/private access, or execute imported G-code.

## Collections and updates

A collection is an explicit selection of Source references, not the entire Library by default. The Library selection bar exports that selection. Future additions require a separate opt-in subscription.

Updates create new manifest revisions. Recipients see a diff and choose whether to adopt them. Source changes, revoked links, or an unreachable Git server must not invalidate already acquired local models or block existing printing and Checkoff.

## Delivery and acceptance

- Export and validation: strict contract, deterministic Build JSON/Git export, preview, and read-only JSON validation. Tests inspect ZIP entries and reject embedded content. Export works without multi-user mode and without network access.
- Mapping and import: Library selection exports a collection manifest for the chosen Sources only. Build import maps each reference explicitly, refuses missing or unverified files, rolls back a failed write, and repeats the same mapping without a second Build.
- Later: Git URL import with redirect/SSRF controls, then optional commit/PR publishing. Neither integration may acquire model bytes through sharing. Test authentication boundaries and private repository handling.

User-visible proof must download both formats from an isolated running app, inspect the ZIP contents, and confirm a local-only source stays a manual reference. No production data or physical printers are used for verification.

## Initial API

| Method and route | Result |
| --- | --- |
| `GET /plans/:id/reference-share` | Tenant-owned Build manifest and warnings. Does not require multi-user mode. |
| `GET /plans/:id/reference-share?format=git` | Git bundle from the current Build. |
| `POST /reference-shares/validate` | Validate a JSON manifest and report dependency warnings without mutations or downloads. |
| `POST /reference-shares/git` | Package the exact validated manifest supplied in the request. The UI uses this so the download matches the preview. |
| `POST /reference-shares/dependencies` | Report `File required`, `Revision unverified`, or `Ready` for an explicit source mapping. Does not mutate or download. |
| `POST /reference-shares/imports` | Create one recipient-owned Build when every included part is Ready. A repeated mapping returns the same Build. |
| `POST /reference-shares/collections` | Export a collection manifest for the listed Library Source ids only. |

These routes inherit the installation's existing authentication and API middleware. They are not public sharing links. JSON requests and generated manifests are limited to 4 MiB. Errors do not echo the rejected payload.

Run the browser proof against a disposable fixture with a local Source and at least one part:

```sh
# From web/apps/web, after starting isolated API and Vite instances:
REFERENCE_SHARE_UI=http://127.0.0.1:5184 \
REFERENCE_SHARE_API=http://127.0.0.1:18877 \
REFERENCE_SHARE_BUILD=1 node test/browser/reference-sharing.browser.mjs
```

The harness refuses API data directories outside its `/tmp/pp-reference-share-` fixture prefix. It checks real downloads, ZIP contents, read-only validation, and narrow-screen overflow. Remote Git publishing is not implemented yet.
