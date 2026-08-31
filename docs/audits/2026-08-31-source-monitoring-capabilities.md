# Source monitoring capabilities

Date: 2026-08-31

## Question

Which source types can PrintPartner monitor and refresh automatically, and what should the user experience promise?

## Findings

### GitHub repositories

GitHub provides repository commit APIs and repository webhooks. A push webhook can report a new commit as it happens; polling a tracked branch or tag is also supported. Creating a repository webhook requires webhook write permission and a reachable callback URL, so scheduled polling remains the dependable default for a local PrintPartner installation.

Sources:

- [GitHub repository webhook API](https://docs.github.com/en/rest/repos/webhooks)
- [GitHub push webhook event](https://docs.github.com/en/webhooks/webhook-events-and-payloads#push)
- [GitHub webhook overview](https://docs.github.com/en/webhooks/about-webhooks)

PrintPartner already syncs an entire Git repository, records immutable source revisions, checks the configured branch or tag, and marks accepted Plans stale when their inputs move. GitHub is therefore the only current source kind that should be described as automatically monitorable and refreshable.

### Printables, MakerWorld, and Thangs

The provider pages support model downloads and following creators or collections. Model files and licenses can change over time. The reviewed official pages do not provide a documented integration contract that PrintPartner currently implements for authenticated archive download or revision polling.

Examples:

- [MakerWorld model download page](https://makerworld.com/en/models/99205)
- [MakerWorld collection following](https://makerworld.com/en/collections/6006903-default-collection)
- [Thangs designer following and releases](https://thangs.com/designer/alext1/printable-3d-models)
- [Thangs model download page](https://thangs.com/designer/Darna3D/3d-model/Vase%20Draft.3mf-1547809)

The repository confirms this limitation: its Printables and MakerWorld adapters are manual stubs, and the prior site audit lists a Thangs manual adapter as unfinished. Scraping private or unstable provider endpoints would make sync unreliable and could mishandle license-gated files.

These platforms should therefore be represented as tracked manual-download sources:

1. Store the canonical model URL and provider.
2. Let the user upload the archive they downloaded under the provider's license.
3. Keep the source and its local revision available to Builds.
4. Label automatic update checking as unavailable for that source.
5. Keep the model URL prominent so the user can review and download a newer archive.

## Product recommendation

Use one Source Library with provider-specific capability labels:

| Source | Track URL | Import files | Automatic update check | Automatic refresh |
| --- | --- | --- | --- | --- |
| GitHub repository | Yes | Automatic | Yes | Optional |
| Local folder/files | Local reference | Direct upload | No remote | No remote |
| ZIP archive | Optional | Direct upload | No remote | No remote |
| Printables model | Yes | Manual archive | Not currently supported | Not currently supported |
| MakerWorld model | Yes | Manual archive | Not currently supported | Not currently supported |
| Thangs model | Yes | Manual archive | Not currently supported | Not currently supported |

The application should notify users about GitHub updates and automatic refreshes inside PrintPartner. External notification channels remain optional delivery targets, not the owner of source-monitoring settings.
