# Farm helper parity targets

These input/output goldens are the targets for the Print Partner Desktop Rust
port of the TypeScript farm helpers in `web/apps/server/src/services/`:

| Fixture | Helper | Cases |
| --- | --- | ---: |
| `printer-farm-match.json` | `wantedFilamentIdsForQueueItem` | 1 |
| `printer-queue-suggestions.json` | `computePrinterQueueSuggestions` | 8 |
| `production-packing-rules.json` | `productionPackingBuckets` | 5 |

Every case in the three corresponding `.test.ts` files has a named fixture.
Inputs expand the tests' default constructors; outputs record the complete
returned data, including queue metadata and packing units. The parity check also
checks source test names against fixture names, so added cases require goldens.

`schemaVersion: 1` stores a helper name and an ordered `cases` array with `name`,
`input`, and `output`. Farm filament sets are sorted arrays. Queue idle integration
sets are arrays in insertion order. All other output arrays retain their order.
The farm repository input is its `listParts` result. Queue tests mock filament
lookup: `wantedFilamentIdsByItem` records the exact ordered filament IDs returned
by that dependency, separate from the queue helper's inputs. The Rust queue
parity harness must supply those dependency results too; filenames themselves
are not production filament metadata. Packing outputs preserve the original
units, even when material assignments affect grouping.

From `web/`, check outputs against committed goldens (also included in the normal
server Vitest suite):

```sh
npm run test -w @print-partner/server -- src/services/farm-parity.test.ts src/services/printer-farm-match.test.ts src/services/printer-queue-suggestions.test.ts src/services/production-packing-rules.test.ts
```

To intentionally regenerate outputs after reviewing a behavior change:

```sh
UPDATE_FARM_PARITY=1 npm run test -w @print-partner/server -- src/services/farm-parity.test.ts
```

Regeneration only updates outputs. Add or update explicit inputs when source
cases change, review the JSON diff, then run the check without the update flag.
The checker performs no printer, network, or database I/O.
