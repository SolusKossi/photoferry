# Apple iCloud download throttling  -  field notes from a 366 GB exodus

Observed July 2026, iCloud for Windows on Windows 11, one library:
10,619 files / ~366 GB logical (93% of bytes in 454 camera videos). These are
empirical observations, not documentation of Apple internals; treat them as a
empirical observations only.

## The placeholder trap

- Files in the sync folder are Cloud Files API placeholders: `ReparsePoint` +
  `RECALL_ON_DATA_ACCESS` attributes, 0 bytes on disk, full logical size
  advertised. **Logical sizes are estimates**  -  we observed a "18.1 GB"
  placeholder hydrate to a 6.4 GB actual file and a "607 MB" one to 471 MB.
- A naive full-file read of a placeholder blocks while the filter driver
  recalls the file, and aborts after ~60 s
  (`ERROR_CLOUD_FILE_REQUEST_TIMEOUT`). Any video too large to download in
  60 s therefore *cannot* be read naively  -  it fails every time while small
  photos sail through. This false-failure mode wasted seven hours of our first
  run and marked 45 perfectly fine videos "failed".
- **Fix: chunked reads.** Reading 4 MB ranges hydrates range-by-range; each
  chunk completes well inside the timeout, hydrated ranges persist, and an
  interrupted file resumes cheaply (already-hydrated ranges re-read at disk
  speed). Hash while you read  -  one pass, no separate hydration step.

## The rate limiter

- Behavior is consistent with an adaptive, account-scoped token bucket on the
  "download original" path. It is **pressure-sensitive**: mass-pinning
  hundreds of files (which makes the client itself issue a request storm),
  parallel download streams, and rapid retry loops all trip it.
- When tripped, *every* request fails instantly with a bogus
  "cloud sync provider failed... network being unavailable" error  - 
  including tiny files. Small cached/derivative requests may still succeed,
  which makes early diagnosis confusing.
- Penalties are long: we observed refusal periods of **hours to 2+ days**.
  One-hour quiet periods did not reset it; a ~12-hour full silence did.
- Some refusals are **file-specific**: individual (mostly older `.MOV`)
  assets refused for days while neighbors flowed. Bench refused files
  individually with escalating timeouts and move on  -  do not let one cursed
  file's global backoff starve the healthy queue.
- Sustained single-stream throughput when healthy: **2-5 MB/s** in our runs.
  Parallelism did not add throughput; it added refusals (4 workers -> same
  aggregate, then a ban). One gentle stream wins on wall-clock.

## Strategy that worked end to end

1. No pinning. One download stream. Chunked-read hashing as the only
   hydration mechanism.
2. Per-file exponential bench on refusal (5 -> 10 -> 20 -> 40 -> 60 min).
3. Global hold only when N *distinct* files refuse consecutively (systemic
   signal), escalating 2 -> 15 min.
4. Batch-level cooldowns (sleep 1 h, retry) when a whole batch verifies
   nothing; never mark files failed during a systemic drought  -  during
   droughts, failure attribution is meaningless.
5. Manifest checkpoint after every batch; kill/resume freely.
6. Dehydrate (unpin) verified files to reclaim working-disk space  - 
   attribute-only, contents untouched.

## Numbers worth remembering

- Windows cloud-read timeout: ~60 s, non-negotiable, per read call.
- Refusal cost when handled well: ~0.5 s (instant error) vs 10+ min when
  handled naively (timeout x retries x backoff).
- Library shape (typical iPhone user): photos are nothing, videos are
  everything. Ours: all 4,685 photos ever taken = 7.3 GB; top 100 videos =
  303 GB. Plan batching, triage, and user expectations around videos.
