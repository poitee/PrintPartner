# Per-source domain packs

Curated notes the assistant loads for a source, keyed by the exact Source name
as it appears in `list_sources`. Ships empty on purpose — Print Partner has no
opinion about what you build.

Add a directory per source, either here or under
`<PRINT_PARTNER_DATA_DIR>/assistant-domain/sources/`:

```
sources/Example-Printer/
  identity.yaml        # source_name, role, summary, important_tags
  compatibility.yaml   # slots filled/required, known-good peers
  workflow.md          # build-order notes
  pitfalls.md          # gotchas specific to this source
  quotes.md            # verbatim excerpts from the source's own docs
```

A pack is only injected into the assistant prompt when a source of that name is
actually synced in the workspace, so packs for projects you do not build cost
nothing and never bias the model.
