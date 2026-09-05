# Author a stack manifest

Use a repository manifest to describe required files, optional groups, replacements, and variants without storing machine-specific paths.

## File location

Place `print-partner.manifest.yaml` at the root of the STL repository. Print Partner reads it during source sync.

Repository maintainers should publish the manifest with the source. Community manifests for repositories that do not include one belong under `manifests/community/` in this repository.

## Rules

- Use paths relative to the source repository.
- Prefer folder globs such as `PrintedParts/**` over long file lists.
- Keep one base source per Build.
- Model toolheads, probes, and other overlays as add-on sources.
- Use the same category or choice id when related variants span repositories.
- Use `pick_one` for one variant, `pick_any` for an unrestricted set, and `pick_n` with inclusive `min` and `max` bounds for a limited set.
- Use `replaces` or a shared slot when an add-on replaces a base part.
- Never store absolute paths or database ids in a published manifest.

Common path patterns are listed in [`docs/path-hints.yaml`](../path-hints.yaml).

## Cross-source choices

A choice can collect variants from several sources. Give the category the same id in each manifest while keeping each source's path glob local to that repository.

Example:

```yaml
option_groups:
  toolhead:
    rule: pick_one
    variants:
      - id: stealthburner
        parts:
          - Stealthburner/**
```

An add-on repository may contribute another `toolhead` variant with a different path. Print Partner merges the choice by id when both sources are attached to a Build.

For `pick_any` and `pick_n`, Print Partner stores selected ids as a YAML list. Keep the list values unique. Do not join ids with commas or another delimiter. Repository defaults must contain at least one id. In a plan, omit the selection key to inherit the repository default, or use an empty list to select no variants explicitly. A plan with fewer selections than the group's minimum remains incomplete.

```yaml
option_groups:
  cosmetic_parts:
    rule: pick_n
    min: 1
    max: 2
    variants:
      - id: skirts
        parts: ["skirts/**"]
      - id: panels
        parts: ["panels/**"]
selections:
  cosmetic_parts:
    - skirts
```

## Validate the result

1. Sync every source in Library.
2. Create a test Build and attach the base and add-on sources.
3. Select each variant on Sources.
4. Rebuild the draft.
5. Check Plan for missing, duplicate, or conflicting parts.
6. Apply the Plan and confirm Checkoff contains the expected units.

Use the [cross-source Voron example](../examples/cross-source-voron/ldo-2.4-golden-stack.md) as a reference.

## Submit a community manifest

Follow the registry layout and validation commands in [the manifest guide](../../manifests/README.md). CI validates the schema and checks that embedded server copies match the canonical files.
