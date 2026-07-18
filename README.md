# PhotoFerry

Verified migration of an iCloud Photos library out of the iCloud for Windows
sync folder to a NAS, external drive, or any other destination you control.

Every file is hashed (SHA-256) at the source and at the destination. A file
counts as migrated only when both hashes match. Progress lives in a CSV
manifest, so the run can be killed and resumed at any point.

## Why not just copy the folder?

The sync folder contains placeholders, not photos. Reading one triggers a
download with a 60-second OS timeout that large videos cannot meet, and Apple
rate-limits bulk downloads to the point of refusing everything for days if you
push too hard. Naive copies fail, produce stubs, or get your account
throttled. PhotoFerry reads files in small chunks, paces itself, backs off
per file and globally, and retries around throttling automatically. Details:
[docs/apple-rate-limiter-field-notes.md](docs/apple-rate-limiter-field-notes.md).

## Requirements

- Windows 10/11
- iCloud for Windows, signed in, Photos sync enabled
- PowerShell 5.1+ (built in, nothing to install)

## Usage

```
copy config.sample.json config.json   (edit paths)
powershell -NoProfile -ExecutionPolicy Bypass -File engine\rescue.ps1 -Config config.json
```

Progress: `<workdir>\logs\rescue.log`, `<workdir>\status.json`, or the
manifest itself. Stop and restart freely.

| config key | default | meaning |
|---|---|---|
| `source` | required | iCloud Photos folder, e.g. `...\iCloud Photos\Photos` |
| `destination` | required | where verified copies go (UNC path or drive) |
| `workdir` | required | manifest, logs, state |
| `batch_gb` | 25 | max GB hydrated per batch |
| `batch_files` | 750 | max files per batch |
| `min_free_gb` | 60 | pause if workdir drive drops below this |
| `hash_workers` | 1 | download streams; keep at 1 (see field notes) |
| `order` | oldest-first | or `largest-first` |

## What it does not do

- Modify or delete anything in the source library. The only mutation is the
  Windows pin/unpin file attribute that controls placeholder hydration.
- Delete anything at the destination.
- Touch your iCloud account, settings, or credentials.
- Send data anywhere except from your PC to your destination.

## Also in this repo

- `ui/triage-template.html` - single-file review UI for keep/delete verdicts
  on large videos (exports JSON, decides nothing by itself)
- `docs/manifest-spec.md` - the manifest format

## Status

Tested end to end on one 366 GB, 10,600-file library. Pre-release.

## License

MIT.
