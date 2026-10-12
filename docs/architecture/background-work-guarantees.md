# Supported single-process guarantees

One Print Partner server process keeps the printer send queue and a backup restore inside the rules on this page. A second process, a crash during restore activation, and exactly-once printer execution are outside these rules.

Jobs from `InProcessJobRunner` live in process memory. `GET /jobs/:id` returns 404 when that memory no longer has the job. A 404 is not a successful send. The durable record is the printer send queue setting `printer.send_queue`.

## Printer send states

A queue row is `queued`, `sending`, `done`, `error`, or `cancelled`.

| From | To | When |
| --- | --- | --- |
| `queued` | `sending` | Dispatch or drain claims the row and starts a printer-upload job. |
| `queued` | `error` | Dispatch finds the staged file missing. |
| `queued` | `cancelled` | You delete the row. |
| `sending` | `done` | The printer-upload job in this process finishes successfully. |
| `sending` | `error` | The printer-upload job in this process fails. |
| `sending` | `error` | This process starts, or reads the queue, and the job id is not in memory. |
| `error` | `sending` | You dispatch that row again. |
| `error` | `cancelled` | You delete the row. |
| `done` or `cancelled` | unchanged | Restart does not reopen a finished row. |

Restart leaves a `queued` row queued. No printer command has been recorded for it, so a later drain may still send it. That is the original send.

Restart changes `sending` to `error` with this text.

`Interrupted by process restart. Printer outcome is unknown, so this send was not marked successful. The staged file remains for an explicit retry. This process will not retry a print on its own.`

The row does not become `done`. The process does not start another printer-upload job for that row. Dispatch is the retry. Drain skips `error` rows, so a physical print is not repeated on its own. The `start` flag on an explicit retry is the flag you stored. It is not an automatic print.

A failed queued upload keeps its staged file until the send succeeds or you delete the row. A one-shot printer upload, which has no queue row, still deletes its staged directory when that job ends.

On process start, this reconciliation runs for the tenant active while routes register. That is `default` for self-host. Another tenant is reconciled on that tenant's next queue read, dispatch, or drain. Until then the row stays `sending`. It does not become `done`.

## Restore activation

`POST /backups/restore` rejects a second restore in the same process with HTTP 409 and `A backup restore is already in progress`. The flag lives in the route module. It is not shared with another process.

Ordinary in-process rollback happens when activation throws and this process is still running. Restore has already moved each replaced path aside. Rollback renames those previous paths back, in reverse order, then reconnects SQLite. If rollback itself throws, the `.restore-tmp-*` workspace stays on disk and the error lists the recovery failures.

Interrupted activation is different. If the process is killed between those renames, rollback does not run. There is no activation journal. The next process does not infer which renames finished, and it does not repair the data directory. You inspect the `.restore-tmp-*` workspace, including `.previous`, before you restore again.

Restore does not drain the job runner, the source watcher, or the printer send queue. `app.ts` still owns those writers, and this change does not add a maintenance lease. Stop those writers yourself before you restore. A process-local flag is not a claim that concurrent writers are idle.

Maps and the in-process restore flag do not make activation crash-safe or safe across processes. A durable activation journal would be a separate change.
