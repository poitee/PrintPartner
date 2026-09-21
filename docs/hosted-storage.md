# Hosted tenant storage

The hosted planning site limits each tenant to 2 GiB of Source workspaces, upload staging, and generated exports. Self-hosted deployments have no tenant quota.

A hosted server must be the only writer process for its data directory. Disk-writing jobs, Source uploads, automatic sync, manifest edits, assistant imports, and PDF extraction share a queue per tenant. Different tenants can run concurrently. This queue is process-local; multiple server processes sharing storage require a cross-process coordinator before deployment.

Each operation measures that tenant's exports and owned Source directories under `repos` and `sources`. It charges new bytes before buffered writes or stream chunks reach disk. Temporary copies count; renames do not add usage. Completed upload staging is removed, and failed snapshot/export candidates are cleaned up. Crash leftovers remain included in the next measurement.

Charges are not refunded within an operation, even if a temporary file is deleted. This can reject a large operation conservatively; the next operation measures actual usage again. A queued job may be accepted by HTTP and later finish with a quota error when earlier work consumes its available space. Quota failures do not activate an incomplete Source snapshot.

The design uses a serialized operation budget because a request-time usage check cannot account for concurrent jobs or unknown remote file sizes. It avoids a separate reservation ledger: filesystem measurement happens once after the prior writer finishes, then synchronous byte charges bound all writes until cleanup completes.
