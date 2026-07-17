# Manifest specification — v1 (draft)

The manifest is a UTF-8 CSV, one row per source file, that serves as the
migration's complete state: progress tracker, resume point, verification
record, and final audit document. A migration is defined by its manifest; the
tool is just the thing that fills it in.

## Columns

| column | type | meaning |
|---|---|---|
| `filename` | string | File name relative to the source root. Unique key. |
| `bytes` | integer | Size of the **hydrated** file (placeholder logical sizes are estimates and can differ by >50%; the manifest records reality). |
| `lastwrite_utc` | ISO-8601 | Source LastWriteTimeUtc at hash time. |
| `sha256_src` | hex string | SHA-256 of the fully hydrated source file. |
| `sha256_dst` | hex string | SHA-256 of the destination copy. Equal to `sha256_src` for a verified row. |
| `status` | enum | `verified` \| `pending` \| `failed_hydration` \| `failed_copy` \| `failed_hash` |
| `attempts` | integer | Attempt cycles consumed. |
| `last_error` | string | Human-readable reason for the most recent failure, empty on success. |
| `completed_at` | ISO-8601 | UTC timestamp when the row reached `verified`. |

## Status semantics

- `verified` — destination hash matched source hash. Terminal. Rows are never
  demoted; a re-run skips them.
- `pending` — enumerated but not yet processed (or re-queued for retry).
- `failed_hydration` — the cloud provider would not produce the bytes
  (timeouts, refusals, source vanished). Retryable.
- `failed_copy` — destination write/read failed. Retryable.
- `failed_hash` — copy completed but hashes mismatched. Retryable; the copy is
  overwritten on retry, never trusted.

## Invariants

1. **One row per source file**, keyed by `filename`. Rewriting the manifest
   must preserve exactly-one-row semantics.
2. A row may only be `verified` if `sha256_src == sha256_dst` and both are
   non-empty.
3. The manifest is rewritten atomically per batch, never per file, so a crash
   loses at most one batch of *progress* (never data).
4. `failed_*` rows are also exported to a companion `failed.csv` for human
   review; the sets must stay consistent.
5. Excluded system files (`desktop.ini`, `Thumbs.db`) appear in neither the
   manifest nor the destination.

## Definition of done

Every file present in the source at final sweep is either `verified` or listed
in `failed.csv` with a reason. Destination count equals `verified` count plus
any tool-owned artifacts (e.g. `_write_test.txt`, triage HTML) that are
explicitly documented in the summary report.
