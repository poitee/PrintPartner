# Print Partner community manifests

This folder holds **community-submitted** kit manifests for STL repositories that do not ship an owner-authored `print-partner.manifest.yaml`.

## Authoritative owner manifest (preferred)

Project maintainers should add **`print-partner.manifest.yaml`** at the **root** of their STL repository. Print Partner loads it automatically on **Sources → Sync**. Power users can edit repo YAML via the manifest API or community PR flow below.

## Submit a community manifest

1. Fork [PrintPartner](https://github.com/poitee/PrintPartner).
2. Add `manifests/community/{slug}/manifest.yaml` and `meta.yaml` (submitter, `repo_url`, branch).
3. Add an entry to `manifests/registry/index.yaml` with `status: proposed`.
4. Open a **pull request**. CI reads `version` and validates against the matching
   v1 or v2 JSON Schema.
5. A linked **GitHub Issue** is used for discussion; use 👍 / 👎 reactions or maintainer checklist for consensus.
6. When approved, maintainers set `status: approved` in the index.

## Voting

- One active **approved** entry per `target_repo` + branch unless `variant` is set in `meta.yaml`.
- Deprecate by setting `status: deprecated` and commenting on the issue.

## App import

Users pick an approved manifest in the community registry or rely on the repo-root file after sync. Maintainers export a PR bundle via the manifest registry API when submitting to this repository.

## Example v2 stack export

A plan with base + addons exports as source references (URLs + rules), not embedded STLs:

```yaml
# Example: LDO 2.4 + Stealthburner + Tap (see manifests/community/ldo-2.4-sb-tap/)
base:
  source: LDOVoron2
  url: https://github.com/MotorDynamics2/LDOVoron2
addons:
  - source: Voron-Stealthburner
    url: https://github.com/VoronDesign/Voron-Stealthburner
  - source: Voron-Tap
    url: https://github.com/VoronDesign/Voron-Tap
selections:
  toolhead: stealthburner
  probe: voron_tap
```

See `docs/kit-catalog.yaml` → `stack_presets` for reference preset ids.

## Validation and embedded copies

Files under `manifests/community/` and `manifests/registry/` are authoritative.
The server copies under `web/apps/server/src/data/manifests/` are generated
runtime assets; CI rejects drift.

```bash
python -m pip install -r manifests/requirements.txt
python manifests/scripts/validate.py
# After changing a canonical registry or manifest:
python manifests/scripts/validate.py --sync-embedded
```

## Canonical paths for community manifests

Community and registry manifests must express rules as **relative path globs** from each repo root (same normalization as scan `match_key`):

| Pattern | Example | Use |
|---------|---------|-----|
| Folder glob | `PrintedParts/**` | Required/optional folder, variant membership |
| Nested folder | `Stealthburner/**` | Toolhead variant in addon repo |
| Flexible match | `**/Tap/**` | Probe variant when folder name is stable |
| File glob | `**/frame_*.stl` | Required frame parts |

**Do not** use absolute paths or plan-private ids in `parts[].match` or `variants[].parts`.

Align folder names with [docs/path-hints.yaml](../docs/path-hints.yaml) where possible so import-rule suggestions and CI review scoring stay consistent. Shared category ids (e.g. `toolhead`, `probe`) merge across repos; variants are distinguished by path globs per repo.
