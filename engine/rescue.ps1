# PhotoRescue engine: batch -> chunked-read hash (hydrates via ranges) -> copy -> verify -> dehydrate.
# Verified migration out of an iCloud for Windows sync folder. See docs/apple-rate-limiter-field-notes.md
# for why every design choice here exists (chunked reads, gentle single stream, benching, cooldowns).
# COPY-ONLY by design: the tool never deletes user data at source or destination.
# Only mutation of source files: pin/unpin attributes (attrib -U +P / +U -P) to manage hydration space.
# Exit codes: 0=done, 2=paused low disk, 3=paused systemic refusal, 4=paused destination unreachable, 5=paused iCloud client missing.

param([string]$Config = (Join-Path (Split-Path $PSScriptRoot -Parent) 'config.json'))
$ErrorActionPreference = 'Continue'
if (-not (Test-Path -LiteralPath $Config)) {
    Write-Error "Config not found: $Config  (copy config.sample.json to config.json and set your paths)"
    exit 1
}
$cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
foreach ($req in 'source','destination','workdir') {
    if (-not $cfg.$req) { Write-Error "config.json is missing required key '$req'"; exit 1 }
}
function CfgOr($val, $default) { if ($null -ne $val -and $val -ne 0) { $val } else { $default } }

$SRC      = $cfg.source
$DST      = $cfg.destination
$WORK     = $cfg.workdir
$MANIFEST = "$WORK\manifest.csv"
$FAILEDCSV= "$WORK\failed.csv"
$LOG      = "$WORK\logs\rescue.log"
$STATUS   = "$WORK\status.json"
$BATCH_BYTES = [long](CfgOr $cfg.batch_gb 25) * 1GB
$BATCH_FILES = [int](CfgOr $cfg.batch_files 750)
$MIN_FREE    = [long](CfgOr $cfg.min_free_gb 60) * 1GB
$EXCLUDE     = @('desktop.ini','Thumbs.db')
$POLL_SEC        = 30
$STALL_EXIT_MIN  = 30    # no progress for this long -> defer remaining, move to copy stage
$MAX_DEFERRALS   = 6     # file-specific deferrals before failed_hydration
$MAX_COOLDOWNS   = 96    # systemic cooldowns (60 min each) before pausing
$LARGE_BYTES     = 8MB
$HASH_WORKERS    = [int](CfgOr $cfg.hash_workers 1)  # keep at 1: parallel pressure triggers Apple's rate limiter
$BACKOFF_BASE_SEC = 120  # global hold after systemic refusals, doubling to max 15 min
$WORK_DRIVE = (Split-Path -Qualifier $WORK).TrimEnd(':')

# first-run initialization
New-Item -ItemType Directory -Force -Path $WORK, "$WORK\logs" | Out-Null
if (-not (Test-Path -LiteralPath $MANIFEST)) {
    'filename,bytes,lastwrite_utc,sha256_src,sha256_dst,status,attempts,last_error,completed_at' |
        Out-File -LiteralPath $MANIFEST -Encoding utf8
}

# Self-contained worker script: chunked SHA-256 that hydrates placeholders range-by-range.
$CHUNK_HASH_SRC = @'
param($path)
try {
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $buf = New-Object byte[] (4194304)
        $total = [long]0
        while (($n = $fs.Read($buf, 0, $buf.Length)) -gt 0) {
            [void]$sha.TransformBlock($buf, 0, $n, $null, 0)
            $total += $n
        }
        [void]$sha.TransformFinalBlock($buf, 0, 0)
        @{ Ok = $true; Hash = (-join ($sha.Hash | ForEach-Object { $_.ToString('X2') })); Bytes = $total }
    } finally { $fs.Close() }
} catch {
    @{ Ok = $false; Error = $_.Exception.Message }
}
'@

Add-Type -Name Disk -Namespace Win32 -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern uint GetCompressedFileSizeW(string lpFileName, out uint lpFileSizeHigh);
'@ -ErrorAction SilentlyContinue

function Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    try { $line | Add-Content -LiteralPath $LOG -Encoding utf8 -ErrorAction Stop } catch {}
    Write-Output $line
}

function Save-Manifest([hashtable]$man) {
    $rows = $man.Values | Sort-Object filename
    $rows | Select-Object filename,bytes,lastwrite_utc,sha256_src,sha256_dst,status,attempts,last_error,completed_at |
        Export-Csv -LiteralPath $MANIFEST -NoTypeInformation -Encoding utf8
    $rows | Where-Object { $_.status -like 'failed_*' } |
        Select-Object filename,bytes,lastwrite_utc,sha256_src,sha256_dst,status,attempts,last_error,completed_at |
        Export-Csv -LiteralPath $FAILEDCSV -NoTypeInformation -Encoding utf8
}

function Write-StatusFile([hashtable]$h) {
    $h['updated'] = (Get-Date).ToUniversalTime().ToString('o')
    ($h | ConvertTo-Json) | Out-File -LiteralPath $STATUS -Encoding utf8
}

function Get-FreeH { (Get-PSDrive -Name $WORK_DRIVE).Free }

function Get-HydrationState([string]$path) {
    $fi = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    $attr = [uint32]$fi.Attributes.value__
    $high = [uint32]0
    $low = [Win32.Disk]::GetCompressedFileSizeW($path, [ref]$high)
    $onDisk = ([uint64]$high -shl 32) -bor $low
    return @{ OnDisk = [long]$onDisk; Hydrated = (($attr -band 0x400000) -eq 0) }
}

# Chunked SHA-256: hydrates placeholders range-by-range; throws on recall refusal (fast).
function Get-ChunkedHash([string]$path) {
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $buf = New-Object byte[] (4MB)
        $total = [long]0
        while (($n = $fs.Read($buf, 0, $buf.Length)) -gt 0) {
            [void]$sha.TransformBlock($buf, 0, $n, $null, 0)
            $total += $n
        }
        [void]$sha.TransformFinalBlock($buf, 0, 0)
        return @{ Hash = (-join ($sha.Hash | ForEach-Object { $_.ToString('X2') })); Bytes = $total }
    } finally { $fs.Close() }
}

function Recover-Space([hashtable]$man) {
    Log "space recovery: dehydrating verified files that are still hydrated"
    $names = $man.Values | Where-Object { $_.status -eq 'verified' } | ForEach-Object { $_.filename }
    $n = 0
    foreach ($name in $names) {
        $p = Join-Path $SRC $name
        if (Test-Path -LiteralPath $p) {
            try { $st = Get-HydrationState $p } catch { continue }
            if ($st.OnDisk -gt 0) { attrib +U -P "$p" | Out-Null; $n++ }
        }
    }
    Log "space recovery: unpinned $n files; waiting 90s for provider"
    Start-Sleep -Seconds 90
}

# ---- load manifest ----
$man = @{}
if (Test-Path -LiteralPath $MANIFEST) {
    foreach ($row in (Import-Csv -LiteralPath $MANIFEST)) {
        if ($row.filename) { $man[$row.filename] = $row }
    }
}
Log "rescue engine start: manifest has $($man.Count) rows ($(@($man.Values | Where-Object status -eq 'verified').Count) verified)"

$runStart = Get-Date
$bytesVerifiedThisRun = [long]0
$batchNum = 0
$retryPassDone = $false
$deferrals = @{}     # filename -> count of file-specific hydration deferrals
$cooldowns = 0       # consecutive systemic cooldowns

while ($true) {
    # ---- preconditions ----
    $ok = $false
    foreach ($try in 1..5) {
        if (Test-Path -LiteralPath $DST) { $ok = $true; break }
        Log "WARN: NAS destination unreachable (try $try/5), waiting 60s"; Start-Sleep -Seconds 60
    }
    if (-not $ok) { Log "PAUSED: NAS unreachable"; Write-StatusFile @{state='paused'; reason='NAS unreachable'}; exit 4 }

    $ok = $false
    foreach ($try in 1..5) {
        if (Get-Process -Name 'iCloudPhotos' -ErrorAction SilentlyContinue) { $ok = $true; break }
        Log "WARN: iCloudPhotos process not running (try $try/5), waiting 60s"; Start-Sleep -Seconds 60
    }
    if (-not $ok) { Log "PAUSED: iCloud client not running"; Write-StatusFile @{state='paused'; reason='iCloud client not running'}; exit 5 }

    if ((Get-FreeH) -lt $MIN_FREE) {
        Recover-Space $man
        if ((Get-FreeH) -lt $MIN_FREE) {
            Log "PAUSED: H: free below 60 GB even after recovery"
            Write-StatusFile @{state='paused'; reason='low disk space on H:'}
            exit 2
        }
    }

    # ---- enumerate and pick batch ----
    $all = Get-ChildItem -LiteralPath $SRC -File -Force | Where-Object { $EXCLUDE -notcontains $_.Name } | Sort-Object LastWriteTime
    $totalFiles = $all.Count
    $totalBytes = ($all | Measure-Object Length -Sum).Sum
    $pending = @($all | Where-Object { -not $man.ContainsKey($_.Name) -or ($man[$_.Name].status -ne 'verified' -and $man[$_.Name].status -notlike 'failed_*') })
    # order: "oldest-first" (default - secure the oldest, most irreplaceable files first) or
    # "largest-first" (maximize verified bytes per hour, useful when freeing cloud space is the goal)
    if ($cfg.order -eq 'largest-first') { $pending = @($pending | Sort-Object Length -Descending) }

    if ($pending.Count -eq 0) {
        $failedRows = @($man.Values | Where-Object { $_.status -like 'failed_*' })
        if ($failedRows.Count -gt 0 -and -not $retryPassDone) {
            Log "main pass complete; starting one retry pass over $($failedRows.Count) failed files"
            foreach ($r in $failedRows) { $r.status = 'pending'; $r.last_error = "retry pass; was: $($r.last_error)" }
            Save-Manifest $man
            $retryPassDone = $true
            $deferrals = @{}
            continue
        }
        Log "all files processed; exiting main loop"
        break
    }

    $batchNum++
    $batch = New-Object System.Collections.Generic.List[object]
    $batchBytes = [long]0
    foreach ($f in $pending) {
        if ($batch.Count -ge $BATCH_FILES) { break }
        if ($batch.Count -gt 0 -and ($batchBytes + $f.Length) -gt $BATCH_BYTES) { break }
        $batch.Add($f); $batchBytes += $f.Length
    }
    $doneFiles = $totalFiles - $pending.Count
    Log ("batch {0}: {1} files, {2:N2} GB (progress: {3}/{4} files done, pending {5})" -f $batchNum, $batch.Count, ($batchBytes/1GB), $doneFiles, $totalFiles, $pending.Count)
    Write-StatusFile @{state='running'; stage='hydrating'; batch=$batchNum; files_done=$doneFiles; files_total=$totalFiles; batch_files=$batch.Count; batch_gb=[math]::Round($batchBytes/1GB,2)}

    # ---- v5: NO pinning. Mass-pinning makes the iCloud client flood Apple with its own download
    # requests, which rate-limits the whole account into refusing everything. Files hydrate one at a
    # time through our chunked reads instead.
    Log "batch ${batchNum}: no pinning (gentle single-stream mode)"

    # ---- hydrate + hash via PARALLEL chunked reads (v4: worker pool) ----
    $srcInfo = @{}
    $wasUnhydrated = @{}
    $remaining = @{}
    foreach ($f in $batch) {
        $remaining[$f.Name] = $f
        try { $st0 = Get-HydrationState $f.FullName; if (-not $st0.Hydrated) { $wasUnhydrated[$f.Name] = $true } } catch {}
    }
    $lastProgress = Get-Date
    $lastOnDiskSum = [long](-1)
    $lastStatusWrite = Get-Date
    $recallSucceeded = $false   # any file that was a placeholder got fully hashed this batch

    $pool = [runspacefactory]::CreateRunspacePool(1, $HASH_WORKERS)
    $pool.Open()
    $jobs = @{}
    $retryAfter = @{}   # filename -> earliest next dispatch after a refusal/error
    $fileRefusals = @{} # filename -> refusal count this batch (drives per-file exponential bench)
    $globalHoldUntil = [datetime]::MinValue   # only when several DISTINCT files refuse consecutively
    $refusalStreak = 0
    # dispatch big files first so long downloads start early; small files fill idle workers
    $dispatchOrder = New-Object System.Collections.Generic.List[object]
    foreach ($f in ($batch | Sort-Object Length -Descending)) { $dispatchOrder.Add($f) }

    while ($remaining.Count -gt 0 -or $jobs.Count -gt 0) {
        # top up workers
        foreach ($f in $dispatchOrder) {
            if ($jobs.Count -ge $HASH_WORKERS) { break }
            if ((Get-Date) -lt $globalHoldUntil) { break }
            if (-not $remaining.ContainsKey($f.Name)) { continue }
            if ($jobs.ContainsKey($f.Name)) { continue }
            if ($retryAfter.ContainsKey($f.Name) -and (Get-Date) -lt $retryAfter[$f.Name]) { continue }
            $ps = [powershell]::Create()
            $ps.RunspacePool = $pool
            [void]$ps.AddScript($CHUNK_HASH_SRC).AddArgument($f.FullName)
            $jobs[$f.Name] = @{ ps = $ps; h = $ps.BeginInvoke(); file = $f }
        }

        # collect finished workers
        foreach ($name in @($jobs.Keys)) {
            $j = $jobs[$name]
            if (-not $j.h.IsCompleted) { continue }
            $res = $null
            try { $out = $j.ps.EndInvoke($j.h); $res = $out[0] } catch { $res = @{ Ok = $false; Error = $_.Exception.Message } }
            $j.ps.Dispose()
            $jobs.Remove($name)
            $f = $j.file
            if ($res -and $res.Ok) {
                $fi = Get-Item -LiteralPath $f.FullName -Force
                $srcInfo[$name] = [pscustomobject]@{ bytes = $res.Bytes; lastwrite_utc = $fi.LastWriteTimeUtc.ToString('o'); sha256_src = $res.Hash; attempts = 1 }
                $remaining.Remove($name)
                $lastProgress = Get-Date
                $refusalStreak = 0
                $globalHoldUntil = [datetime]::MinValue
                if ($wasUnhydrated.ContainsKey($name)) { $recallSucceeded = $true }
            } else {
                if (-not (Test-Path -LiteralPath $f.FullName)) {
                    Log "WARN: $name disappeared from source mid-run (live sync?)"
                    $man[$name] = [pscustomobject]@{ filename=$name; bytes=$f.Length; lastwrite_utc=$f.LastWriteTimeUtc.ToString('o'); sha256_src=''; sha256_dst=''; status='failed_hydration'; attempts=1; last_error='source file disappeared during run'; completed_at='' }
                    $remaining.Remove($name)
                } else {
                    # per-file exponential bench: 5 -> 10 -> 20 -> 40 -> 60 min; stream moves on to next file
                    $cnt = [int]$fileRefusals[$name]
                    $benchSec = [Math]::Min(3600, 300 * [Math]::Pow(2, [Math]::Min($cnt, 3)))
                    $fileRefusals[$name] = $cnt + 1
                    $retryAfter[$name] = (Get-Date).AddSeconds($benchSec)
                    $refusalStreak++
                    if ($refusalStreak -ge 5) {
                        # 5 distinct refusals in a row = systemic; polite global hold
                        $holdSec = [Math]::Min(900, $BACKOFF_BASE_SEC * [Math]::Pow(2, [Math]::Min($refusalStreak - 5, 3)))
                        $globalHoldUntil = (Get-Date).AddSeconds($holdSec)
                        Log "batch ${batchNum}: refusal streak $refusalStreak - global hold $([int]$holdSec)s"
                    } else {
                        Log "batch ${batchNum}: $name refused (bench $([int]($benchSec/60)) min, streak $refusalStreak)"
                    }
                }
            }
        }

        # hydration byte progress (pin downloads count even with no completions)
        $onDiskSum = [long]0
        foreach ($f in @($remaining.Values)) {
            try { $st = Get-HydrationState $f.FullName; $onDiskSum += $st.OnDisk } catch {}
        }
        if ($onDiskSum -ne $lastOnDiskSum) { $lastProgress = Get-Date; $lastOnDiskSum = $onDiskSum }

        if ($remaining.Count -gt 0 -and ((Get-Date) - $lastProgress).TotalMinutes -ge $STALL_EXIT_MIN) {
            Log "batch ${batchNum}: no hydration progress for $STALL_EXIT_MIN min; deferring $($remaining.Count) files to a later batch"
            foreach ($name in @($jobs.Keys)) { $j = $jobs[$name]; try { $j.ps.Stop() } catch {}; $j.ps.Dispose(); $jobs.Remove($name) }
            break
        }

        if (((Get-Date) - $lastStatusWrite).TotalSeconds -ge 120) {
            $hydDone = $batch.Count - $remaining.Count
            Log ("batch {0}: hashed {1}/{2} files ({3} in flight)" -f $batchNum, $hydDone, $batch.Count, $jobs.Count)
            Write-StatusFile @{state='running'; stage='hydrating'; batch=$batchNum; batch_hashed=$hydDone; batch_files=$batch.Count; files_done=$doneFiles; files_total=$totalFiles; workers=$jobs.Count}
            $lastStatusWrite = Get-Date
        }
        if ($remaining.Count -gt 0 -or $jobs.Count -gt 0) { Start-Sleep -Seconds 5 }
    }
    $pool.Close(); $pool.Dispose()

    # ---- deferral accounting for unresolved files ----
    # Only count deferrals in a HEALTHY batch (most placeholders hydrated fine), so that a file
    # refused 6 times while its peers succeed is genuinely suspect. During a systemic drought
    # (Apple throttling: most placeholders refused) nothing is counted - files just retry later.
    $deferredNow = @($remaining.Keys)
    $placeholderTotal = $wasUnhydrated.Count
    $hydratedPlaceholders = 0
    foreach ($n in $wasUnhydrated.Keys) { if ($srcInfo.ContainsKey($n)) { $hydratedPlaceholders++ } }
    $healthyBatch = ($placeholderTotal -gt 0 -and ($hydratedPlaceholders / $placeholderTotal) -ge 0.5)
    foreach ($name in $deferredNow) {
        if ($healthyBatch) {
            $deferrals[$name] = 1 + [int]$deferrals[$name]
            if ($deferrals[$name] -ge $MAX_DEFERRALS) {
                $f = $remaining[$name]
                $man[$name] = [pscustomobject]@{ filename=$name; bytes=$f.Length; lastwrite_utc=$f.LastWriteTimeUtc.ToString('o'); sha256_src=''; sha256_dst=''; status='failed_hydration'; attempts=$deferrals[$name]; last_error='recall refused repeatedly while most other placeholders hydrated'; completed_at='' }
                Log "batch ${batchNum}: $name marked failed_hydration after $($deferrals[$name]) deferrals"
            }
        }
    }
    Log "batch ${batchNum}: hashing complete ($($srcInfo.Count) ok, $($deferredNow.Count) deferred)"

    # ---- copy (chunked robocopy) ----
    Write-StatusFile @{state='running'; stage='copy'; batch=$batchNum; files_done=$doneFiles; files_total=$totalFiles}
    $toCopy = @($batch | Where-Object { $srcInfo.ContainsKey($_.Name) })
    $chunkSize = 150
    for ($c = 0; $c -lt $toCopy.Count; $c += $chunkSize) {
        $chunk = @($toCopy[$c..([Math]::Min($c+$chunkSize-1, $toCopy.Count-1))])
        $names = $chunk | ForEach-Object { $_.Name }
        $rcArgs = @($SRC, $DST) + $names + @('/COPY:DAT','/DCOPY:T','/R:2','/W:5','/FFT','/MT:8','/NP','/NDL',"/LOG+:$WORK\logs\robocopy_batch$batchNum.log")
        & robocopy @rcArgs | Out-Null
        if ($LASTEXITCODE -ge 8) { Log "WARN: robocopy chunk exit code $LASTEXITCODE in batch $batchNum (per-file verify will catch specifics)" }
    }
    Log "batch ${batchNum}: copy stage complete ($($toCopy.Count) files)"

    # ---- verify ----
    Write-StatusFile @{state='running'; stage='verify'; batch=$batchNum; files_done=$doneFiles; files_total=$totalFiles}
    $verified = 0
    $consecVerifyErr = 0
    $i = 0
    foreach ($f in $toCopy) {
        $i++
        $info = $srcInfo[$f.Name]
        $dstPath = Join-Path $DST $f.Name
        $result = ''
        $err = ''
        foreach ($attempt in 1..3) {
            try {
                if ($attempt -eq 3) {
                    $r2 = Get-ChunkedHash $f.FullName
                    $fi2 = Get-Item -LiteralPath $f.FullName -Force
                    $info.sha256_src = $r2.Hash; $info.bytes = $r2.Bytes; $info.lastwrite_utc = $fi2.LastWriteTimeUtc.ToString('o')
                }
                if ($attempt -gt 1) {
                    & robocopy $SRC $DST "$($f.Name)" /COPY:DAT /DCOPY:T /R:2 /W:5 /FFT /NP /NDL "/LOG+:$WORK\logs\robocopy_batch$batchNum.log" | Out-Null
                }
                $dh = Get-FileHash -LiteralPath $dstPath -Algorithm SHA256 -ErrorAction Stop
                if ($dh.Hash -eq $info.sha256_src) { $result = 'verified'; break }
                $err = "hash mismatch (src $($info.sha256_src) vs dst $($dh.Hash))"
                Log "WARN: verify attempt $attempt mismatch for $($f.Name)"
            } catch {
                $err = $_.Exception.Message
                Log "WARN: verify attempt $attempt error for $($f.Name): $err"
                Start-Sleep -Seconds (15 * $attempt)
            }
            $info.attempts = $attempt + 1
        }
        if ($result -eq 'verified') {
            $verified++
            $consecVerifyErr = 0
            $bytesVerifiedThisRun += [long]$info.bytes
            $man[$f.Name] = [pscustomobject]@{ filename=$f.Name; bytes=$info.bytes; lastwrite_utc=$info.lastwrite_utc; sha256_src=$info.sha256_src; sha256_dst=$info.sha256_src; status='verified'; attempts=$info.attempts; last_error=''; completed_at=(Get-Date).ToUniversalTime().ToString('o') }
        } else {
            $status = 'failed_copy'
            if ($err -like '*mismatch*') { $status = 'failed_hash' }
            $man[$f.Name] = [pscustomobject]@{ filename=$f.Name; bytes=$info.bytes; lastwrite_utc=$info.lastwrite_utc; sha256_src=$info.sha256_src; sha256_dst=''; status=$status; attempts=$info.attempts; last_error=$err; completed_at='' }
            $consecVerifyErr++
            if ($consecVerifyErr -ge 20 -and -not (Test-Path -LiteralPath $DST)) {
                Save-Manifest $man
                foreach ($fx in $batch) { attrib +U -P "$($fx.FullName)" | Out-Null }
                Log "PAUSED: 20 consecutive verify failures and NAS unreachable"
                Write-StatusFile @{state='paused'; reason='NAS unreachable during verify'}
                exit 4
            }
        }
        if ($i % 100 -eq 0) { Log "batch ${batchNum}: verified $i/$($toCopy.Count)" }
    }
    Save-Manifest $man

    # ---- dehydrate verified batch files; leave deferred files pinned so the provider can keep trying ----
    foreach ($f in $toCopy) { attrib +U -P "$($f.FullName)" | Out-Null }
    Log "batch ${batchNum}: unpinned $($toCopy.Count) processed files for dehydration"

    # ---- heartbeat ----
    $vTotal = @($man.Values | Where-Object status -eq 'verified').Count
    $fTotal = @($man.Values | Where-Object { $_.status -like 'failed_*' }).Count
    $sumV = [long]0
    foreach ($r in ($man.Values | Where-Object status -eq 'verified')) { $sumV += [long]$r.bytes }
    $gbDone = [math]::Round($sumV/1GB, 2)
    $elapsedH = ((Get-Date) - $runStart).TotalHours
    $rate = 0; $etaH = 0
    if ($elapsedH -gt 0) { $rate = [math]::Round(($bytesVerifiedThisRun/1MB) / ($elapsedH*3600), 2) }
    $remBytes = [long]$totalBytes - $sumV
    if ($rate -gt 0 -and $remBytes -gt 0) { $etaH = [math]::Round(($remBytes/1MB) / $rate / 3600, 1) }
    $free = [math]::Round((Get-FreeH)/1GB, 1)
    Log ("HEARTBEAT batch {0}: {1}/{2} files verified, {3} failed, {4} deferred, ~{5} GB done of ~{6:N0} GB, rate {7} MB/s, ETA {8} h, H: free {9} GB" -f $batchNum, $vTotal, $totalFiles, $fTotal, $deferredNow.Count, $gbDone, ($totalBytes/1GB), $rate, $etaH, $free)
    Write-StatusFile @{state='running'; stage='batch_done'; batch=$batchNum; files_verified=$vTotal; files_failed=$fTotal; files_deferred=$deferredNow.Count; files_total=$totalFiles; gb_done=$gbDone; gb_total=[math]::Round($totalBytes/1GB,0); rate_mbps=$rate; eta_hours=$etaH; h_free_gb=$free}

    # ---- systemic cooldown: batch verified nothing and recalls were refused ----
    if ($verified -eq 0 -and $deferredNow.Count -gt 0) {
        $cooldowns++
        if ($cooldowns -ge $MAX_COOLDOWNS) {
            Log "PAUSED: $cooldowns consecutive cooldowns - iCloud client still refusing downloads (restart iCloud for Windows)"
            Write-StatusFile @{state='paused'; reason='iCloud client refusing downloads; needs restart'}
            exit 3
        }
        Log "HEARTBEAT-COOLDOWN $cooldowns/${MAX_COOLDOWNS}: iCloud refusing all downloads; sleeping 60 min before retrying"
        Write-StatusFile @{state='cooldown'; cooldown=$cooldowns; max_cooldowns=$MAX_COOLDOWNS; files_verified=$vTotal; files_total=$totalFiles}
        Start-Sleep -Seconds 3600
    } else {
        $cooldowns = 0
    }
}

# ---- done ----
$vTotal = @($man.Values | Where-Object status -eq 'verified').Count
$fTotal = @($man.Values | Where-Object { $_.status -like 'failed_*' }).Count
Save-Manifest $man
Log "PHASE 2 COMPLETE: $vTotal verified, $fTotal failed"
Write-StatusFile @{state='done'; files_verified=$vTotal; files_failed=$fTotal}
exit 0
