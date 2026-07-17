# PhotoRescue

**Get your photos out of iCloud — verified, byte for byte.**

PhotoRescue migrates an iCloud Photos library from the iCloud for Windows sync
folder to any destination you control (NAS, external disk, second volume), with
a SHA-256 manifest proving every single file arrived intact. It was built during
a real 366 GB / 10,600-file exodus that survived four days of Apple's
rate limiting — the field notes from that fight are in
[docs/apple-rate-limiter-field-notes.md](docs/apple-rate-limiter-field-notes.md).

> **Status: pre-release.** The engine is battle-tested on one large real-world
> migration; the packaging around it is young. Expect sharp edges.

## Why this exists

The iCloud for Windows sync folder looks like a folder of photos. It is not —
it's a wall of dehydrated Cloud Files placeholders that occupy ~1% of their
logical size, hydrate (download) on read through a filter driver with a ~60s
timeout, and are policed by an adaptive server-side rate limiter that will
silently refuse downloads for **days** if you bulk-request too aggressively.
Copying this folder with Explorer, robocopy, or rsync either fails, falsely
"succeeds" with placeholder stubs, or gets your account throttled into the
ground.

PhotoRescue handles all of it:

- **Chunked hydration** — reads placeholders in 4 MB ranges, sidestepping the
  60-second full-file recall timeout that kills large videos.
- **Gentle pacing** — single download stream, per-file exponential benching on
  refusal, global backoff when refusals turn systemic, hour-scale cooldowns
  during droughts. Designed from observed limiter behavior, not guesswork.
- **A manifest as the source of truth** — every file's source hash, destination
  hash, status, and timestamps in one CSV ([spec](docs/manifest-spec.md)).
  Kill it at any point; it resumes exactly where it stopped.
- **Verified copies** — a file counts only when the destination's SHA-256
  matches the hydrated source. No exceptions.
- **Space management** — dehydrates verified files (pin/unpin attributes only —
  file contents are never touched) so a 400 GB library migrates through a
  smaller working disk in batches.
- **Copy-only by design** — the tool has no delete path for your data. Source
  and destination are only ever read and written, never pruned. Cleaning up the
  cloud afterward is a human decision, guided by the final report.

Plus a **triage UI** ([ui/triage-template.html](ui/triage-template.html)):
a single-file, dependency-free HTML app for reviewing your largest videos
fullscreen — keep/delete verdicts, keyboard-driven, exports JSON. Decisions
only ever apply to the *cloud* copy; the rescued archive keeps everything.

## Quick start

1. Requirements: Windows 10/11, iCloud for Windows signed in and syncing,
   PowerShell 5.1+ (built in). Nothing to install.
2. Copy `config.sample.json` to `config.json` and set your paths.
3. Run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File engine\rescue.ps1 -Config config.json
   ```

4. Watch progress in `<workdir>\logs\`, `<workdir>\status.json`, or the
   manifest itself. Stop and restart freely — the manifest is the state.

## What it will not do

- Touch your iCloud account, settings, or credentials.
- Delete, move, or modify anything in the source library (the only mutation is
  the Windows pin/unpin file attribute that controls hydration).
- Delete anything at the destination.
- Send a single byte anywhere except from your PC to your chosen destination.

## Roadmap

- [ ] Config-driven engine extracted from the original mission script (done, hardening)
- [ ] Manifest spec v1 frozen
- [ ] Progress TUI / simple dashboard
- [ ] Google Takeout unscrambler as second adapter
- [ ] macOS support (Photos library / iCloud Drive)

## License

MIT (proposed — may become AGPL before first release). Either way: free
forever. This tool is the trust anchor of a larger project; it will never grow
a paywall.
