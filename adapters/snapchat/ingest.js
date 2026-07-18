#!/usr/bin/env node
"use strict";

/*
 Snapchat Memories export ingester (PhotoFerry adapter).

 Usage:
   node ingest.js <input> --out <output-folder> [--commit]
   node ingest.js --selftest

 <input> is a folder containing one or more Snapchat "My Data" exports,
 either as .zip files or already-extracted folders. Zips are extracted with
 PowerShell Expand-Archive into <out>\_extracted\<zipname> (skipped if that
 folder already exists, so interrupted runs can resume).

 Dry-run by default: prints what would happen, writes report.txt only.
 With --commit: copies media into <out>\memories\ renamed to
 <YYYY-MM-DD_HH-MM-SS>_<shortid>.<ext> (UTC capture time), restores file
 mtime/atime to capture time, pairs overlays, verifies every copy with
 SHA-256, and writes manifest.csv + metadata.csv + report.txt.

 Zero npm dependencies (node:fs, node:path, node:crypto, node:child_process,
 node:os). Node 18+. Windows-first but works elsewhere (unzip/pwsh fallback).
*/

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const MEDIA_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp",
  ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".3gp"
]);
const IGNORE_BASENAMES = new Set(["desktop.ini", "thumbs.db"]);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/*
 Field-name variants for memories_history.json records, collected across
 export generations. Observed shapes:

   Wrapper:  { "Saved Media": [ ...records ] }   (most common)
             or a bare array of records.

   Record (link generation - JSON mirrors the memories_history.html table):
     "Date": "2020-01-02 03:04:05 UTC"
     "Media Type": "Image" | "Video" | "PHOTO" | "VIDEO"
     "Download Link": "https://app.snapchat.com/dmd/memories?uid=...&sig=..."
       (in HTML this appears wrapped as downloadMemories('https://...', ...))
     "Location": "Latitude, Longitude: 59.9139, 10.7522"

   Record (media-included generation - memories/ folder ships the files,
   named YYYY-MM-DD_<uuid>-main.<ext> plus optional -overlay files):
     "Media ID" / "Mid": uuid matching the uuid embedded in the filename
     some variants carry separate "Latitude" / "Longitude" fields
     some variants carry a filename field directly.

 Keys are matched case- and punctuation-insensitively (normKey), and
 unknown fields are ignored.
*/
const DATE_KEYS = ["date", "createtime", "created", "capturetime",
  "timestamp", "savedat", "creationtimestamp", "mediacreatetime"];
const TYPE_KEYS = ["mediatype", "type"];
const ID_KEYS = ["mediaid", "mid", "id", "filename", "medianame",
  "mediafilename", "sourcefilename", "name"];
const LINK_KEYS = ["downloadlink", "downloadurl", "medialink",
  "mediadownloadurl", "url", "link"];
const LOC_KEYS = ["location", "gps", "coordinates", "geodata"];
const LAT_KEYS = ["latitude", "lat"];
const LON_KEYS = ["longitude", "lon", "lng", "long"];

/* ---------------- small helpers ---------------- */

function normKey(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fieldMap(obj) {
  const m = new Map();
  for (const k of Object.keys(obj)) {
    const nk = normKey(k);
    if (!m.has(nk)) m.set(nk, obj[k]);
  }
  return m;
}

function pick(map, keys) {
  for (const k of keys) {
    if (map.has(k)) {
      const v = map.get(k);
      if (v !== null && v !== undefined && v !== "") return v;
    }
  }
  return undefined;
}

function parseDateUtc(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && isFinite(v)) {
    return new Date(v > 1e11 ? v : v * 1000);
  }
  let s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return new Date(n > 1e11 ? n : n * 1000);
  }
  s = s.replace(/\s+UTC$/i, "Z");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?/.test(s)) {
    s = s.replace(" ", "T");
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
    s += "Z"; // bare timestamp: treat as UTC
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function normType(v) {
  if (!v) return "";
  const s = String(v);
  if (/photo|image/i.test(s)) return "Image";
  if (/video/i.test(s)) return "Video";
  return s;
}

function typeFromExt(ext) {
  const e = ext.toLowerCase();
  if ([".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".3gp"].includes(e)) return "Video";
  if (MEDIA_EXTS.has(e)) return "Image";
  return "";
}

function extractLink(v) {
  if (!v) return null;
  const m = String(v).match(/https?:\/\/[^'")\s]+/);
  return m ? m[0] : null;
}

function parseLatLon(map) {
  let lat = pick(map, LAT_KEYS);
  let lon = pick(map, LON_KEYS);
  if (lat === undefined || lon === undefined) {
    const loc = pick(map, LOC_KEYS);
    if (loc && typeof loc === "object" && !Array.isArray(loc)) {
      const lm = fieldMap(loc);
      if (lat === undefined) lat = pick(lm, LAT_KEYS);
      if (lon === undefined) lon = pick(lm, LON_KEYS);
    } else if (typeof loc === "string") {
      // "Latitude, Longitude: 59.9139, 10.7522"
      const tail = loc.includes(":") ? loc.slice(loc.lastIndexOf(":") + 1) : loc;
      const m = tail.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
      if (m) {
        if (lat === undefined) lat = m[1];
        if (lon === undefined) lon = m[2];
      }
    }
  }
  return {
    lat: lat === undefined ? "" : String(lat),
    lon: lon === undefined ? "" : String(lon)
  };
}

function csvEsc(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function isoSec(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stampForName(d) {
  const iso = d.toISOString(); // 2023-05-01T10:20:30.000Z
  return iso.slice(0, 10) + "_" + iso.slice(11, 19).replace(/:/g, "-");
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(p);
    s.on("error", reject);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

function sha8(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
}

function normPath(p) {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function isInside(p, prefix) {
  const a = normPath(p);
  const b = normPath(prefix);
  return a === b || a.startsWith(b + path.sep);
}

/* ---------------- zip extraction ---------------- */

function extractZip(zipPath, destDir, log) {
  if (fs.existsSync(destDir)) {
    log("skip extract (already extracted): " + destDir);
    return true;
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  const q = (s) => s.replace(/'/g, "''");
  const psCmd = "Expand-Archive -LiteralPath '" + q(zipPath) +
    "' -DestinationPath '" + q(destDir) + "' -Force";
  const psArgs = ["-NoProfile", "-NonInteractive", "-Command", psCmd];
  const attempts = process.platform === "win32"
    ? [["powershell.exe", psArgs], ["pwsh", psArgs]]
    : [["unzip", ["-o", zipPath, "-d", destDir]], ["pwsh", psArgs]];
  log("extracting: " + zipPath);
  for (const [cmd, args] of attempts) {
    let r;
    try {
      r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
    } catch (e) {
      continue;
    }
    if (r && r.status === 0 && fs.existsSync(destDir)) return true;
  }
  // remove partial output so a re-run retries instead of skipping
  try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  log("EXTRACTION FAILED: " + zipPath);
  return false;
}

/* ---------------- discovery ---------------- */

function collectRoots(input, out, log) {
  const st = fs.statSync(input);
  if (!st.isDirectory()) throw new Error("input is not a folder: " + input);
  const resolvedOut = path.resolve(out);
  const roots = [];
  const extractionFailures = [];
  const entries = fs.readdirSync(input, { withFileTypes: true });
  const looksLikeRoot = entries.some((e) =>
    (e.isDirectory() && ["memories", "json", "html"].includes(e.name.toLowerCase())) ||
    (e.isFile() && /^memories_history.*\.(json|html)$/i.test(e.name)));
  for (const e of entries) {
    if (e.isFile() && /\.zip$/i.test(e.name)) {
      const zipPath = path.join(input, e.name);
      const destDir = path.join(out, "_extracted", e.name.replace(/\.zip$/i, ""));
      if (extractZip(zipPath, destDir, log)) roots.push(destDir);
      else extractionFailures.push(zipPath);
    }
  }
  if (looksLikeRoot) {
    roots.push(path.resolve(input));
  } else {
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.resolve(input, e.name);
      if (isInside(p, resolvedOut)) continue;
      roots.push(p);
    }
  }
  return { roots, extractionFailures };
}

function walkFiles(root, skipDir) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (skipDir && isInside(p, skipDir)) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) files.push(p);
    }
  }
  return files;
}

function classifyMediaFile(p) {
  const base = path.basename(p);
  if (IGNORE_BASENAMES.has(base.toLowerCase())) return null;
  const ext = path.extname(base);
  if (!MEDIA_EXTS.has(ext.toLowerCase())) return null;
  const segs = p.split(/[\\/]/).slice(0, -1).map((s) => s.toLowerCase());
  const inMemoriesDir = segs.includes("memories");
  const stem = base.slice(0, base.length - ext.length);
  const um = stem.match(UUID_RE);
  const dm = stem.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!inMemoriesDir && !(dm && um)) return null; // avoid sweeping unrelated media
  let role = "main";
  let stripped = stem;
  const ovm = stem.match(/^(.*)-overlay(?:[_~-]?\d+)?$/i);
  const mnm = stem.match(/^(.*)-main(?:[_~-]?\d+)?$/i);
  if (ovm) { role = "overlay"; stripped = ovm[1]; }
  else if (mnm) { stripped = mnm[1]; }
  return {
    path: p, base, ext, stem, role, stripped,
    uuid: um ? um[0].toLowerCase() : null,
    pairKey: (path.dirname(p) + "|" + stripped).toLowerCase(),
    dateFromName: dm ? dm[1] : null
  };
}

/* ---------------- JSON records ---------------- */

function loadRecords(jsonPath, log) {
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, "utf8").replace(/^\uFEFF/, "");
  } catch (e) {
    log("WARN cannot read " + jsonPath + ": " + e.message);
    return [];
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log("WARN cannot parse " + jsonPath + ": " + e.message);
    return [];
  }
  let recs = [];
  if (Array.isArray(data)) {
    recs = data;
  } else if (data && typeof data === "object") {
    // usually { "Saved Media": [...] }; tolerate any array-of-objects value
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) recs = recs.concat(v);
    }
    if (recs.length === 0 && Object.keys(data).length > 0) recs = [data];
  }
  return recs.filter((r) => r && typeof r === "object" && !Array.isArray(r));
}

function parseRecord(rawRec, ordinal) {
  const map = fieldMap(rawRec);
  const dateRaw = pick(map, DATE_KEYS);
  const date = parseDateUtc(dateRaw);
  const type = normType(pick(map, TYPE_KEYS));
  const link = extractLink(pick(map, LINK_KEYS));
  const { lat, lon } = parseLatLon(map);
  const keys = new Set();
  let firstId = "";
  for (const idk of ID_KEYS) {
    const v = map.get(idk);
    if (typeof v === "string" && v.trim()) {
      const s = v.trim().toLowerCase();
      if (!firstId) firstId = v.trim();
      keys.add(s);
      const um = s.match(UUID_RE);
      if (um) keys.add(um[0]);
      const ext = path.extname(s);
      if (ext && MEDIA_EXTS.has(ext)) {
        const stem = s.slice(0, s.length - ext.length);
        keys.add(stem);
        const mm = stem.match(/^(.*)-main(?:[_~-]?\d+)?$/);
        if (mm) keys.add(mm[1]);
      }
    }
  }
  if (link) {
    const lm = link.toLowerCase().match(UUID_RE);
    if (lm) keys.add(lm[0]);
    const pm = link.match(/[?&](?:mid|uid|media_id|sid)=([^&'"\s]+)/i);
    if (pm) {
      try { keys.add(decodeURIComponent(pm[1]).toLowerCase()); }
      catch (e) { keys.add(pm[1].toLowerCase()); }
    }
  }
  const label = [
    dateRaw ? String(dateRaw) : (date ? isoSec(date) : "no-date"),
    type || "unknown-type",
    firstId || (link ? link.slice(0, 60) : "record#" + ordinal)
  ].join(" | ");
  return { raw: rawRec, dateRaw, date, type, link, lat, lon, keys, label, matched: false };
}

/* ---------------- core run ---------------- */

async function run(opts) {
  const input = path.resolve(opts.input);
  const out = path.resolve(opts.out);
  const commit = !!opts.commit;
  const log = opts.log || ((s) => console.log(s));

  log("snapchat ingest - mode: " + (commit ? "commit" : "dry-run"));
  log("input:  " + input);
  log("output: " + out);
  fs.mkdirSync(out, { recursive: true });

  const { roots, extractionFailures } = collectRoots(input, out, log);
  if (roots.length === 0) {
    log("no exports found in input (no zips, no folders).");
  }

  // per-root discovery
  const rootInfos = [];
  const allRecords = [];
  const allMedia = [];
  for (const root of roots) {
    const skipDir = isInside(root, out) ? null : out;
    const files = walkFiles(root, skipDir);
    const jsonFiles = files.filter((f) => /^memories_history.*\.json$/i.test(path.basename(f)));
    const htmlFiles = files.filter((f) => /^memories_history.*\.html$/i.test(path.basename(f)));
    const media = [];
    for (const f of files) {
      const m = classifyMediaFile(f);
      if (m) media.push(m);
    }
    const records = [];
    for (const jf of jsonFiles) {
      const recs = loadRecords(jf, log);
      for (const r of recs) records.push(parseRecord(r, allRecords.length + records.length));
      log("parsed " + recs.length + " records from " + jf);
    }
    const linkRecords = records.filter((r) => r.link).length;
    rootInfos.push({
      root, jsonFiles, htmlFiles, records, media, linkRecords,
      linkOnly: records.length > 0 && media.length === 0 && linkRecords > 0
    });
    allRecords.push(...records);
    allMedia.push(...media);
    log("export root: " + root + " (records: " + records.length +
      ", media files: " + media.length + ")");
  }

  // record index
  const index = new Map();
  for (const rec of allRecords) {
    for (const k of rec.keys) {
      if (!index.has(k)) index.set(k, rec);
    }
  }

  // group media into items (main + overlays)
  const groups = new Map();
  const items = [];
  for (const m of allMedia) {
    let g = groups.get(m.pairKey);
    if (!g) { g = { main: null, overlays: [] }; groups.set(m.pairKey, g); }
    if (m.role === "overlay") g.overlays.push(m);
    else if (!g.main) g.main = m;
    else items.push({ main: m, overlays: [] }); // duplicate main, standalone item
  }
  for (const g of groups.values()) {
    if (g.main) items.push({ main: g.main, overlays: g.overlays });
    else for (const ov of g.overlays) items.push({ main: ov, overlays: [], orphanOverlay: true });
  }

  // match items to records, resolve capture time
  const unmatchedMedia = [];
  for (const it of items) {
    const m = it.main;
    const candidates = [m.uuid, m.stripped.toLowerCase(), m.stem.toLowerCase(),
      m.base.toLowerCase()].filter(Boolean);
    let rec = null;
    for (const c of candidates) {
      if (index.has(c)) { rec = index.get(c); break; }
    }
    it.record = rec;
    if (rec) rec.matched = true;
    else unmatchedMedia.push(m.path);
    let capture = rec ? rec.date : null;
    let source = "json";
    if (!capture && m.dateFromName) {
      capture = new Date(m.dateFromName + "T00:00:00Z");
      source = "filename";
    }
    if (!capture || isNaN(capture.getTime())) {
      try { capture = fs.statSync(m.path).mtime; } catch (e) { capture = new Date(0); }
      source = "mtime";
    }
    it.captureDate = capture;
    it.captureSource = source;
    it.mediaType = (rec && rec.type) ? rec.type : typeFromExt(m.ext);
    it.shortId = m.uuid ? m.uuid.slice(0, 8) : sha8(m.stripped.toLowerCase());
  }

  // plan output names (deterministic order, collision suffixes)
  items.sort((a, b) => {
    const t = a.captureDate.getTime() - b.captureDate.getTime();
    return t !== 0 ? t : a.main.path.localeCompare(b.main.path);
  });
  const taken = new Set();
  const claim = (base, ext) => {
    let name = base + ext;
    let n = 2;
    while (taken.has(name.toLowerCase())) {
      name = base + " (" + n + ")" + ext;
      n++;
    }
    taken.add(name.toLowerCase());
    return name;
  };
  for (const it of items) {
    const base = stampForName(it.captureDate) + "_" + it.shortId;
    it.outName = claim(base, it.main.ext.toLowerCase());
    const outBase = it.outName.slice(0, it.outName.length - path.extname(it.outName).length);
    it.overlayOutNames = it.overlays.map((ov) => claim(outBase + "_overlay", ov.ext.toLowerCase()));
  }

  const recordsWithoutMedia = allRecords.filter((r) => !r.matched);
  const totalFiles = items.reduce((n, it) => n + 1 + it.overlays.length, 0);

  // process
  const memDir = path.join(out, "memories");
  const manifestRows = [];
  const metadataRows = [];
  let processed = 0;
  let printed = 0;
  if (commit) fs.mkdirSync(memDir, { recursive: true });

  for (const it of items) {
    const pairs = [{ src: it.main, dstName: it.outName }];
    it.overlays.forEach((ov, i) => pairs.push({ src: ov, dstName: it.overlayOutNames[i] }));
    for (const pr of pairs) {
      processed++;
      try {
        if (!commit) {
          if (printed < 50) {
            log("would copy: " + pr.src.path + " -> memories\\" + pr.dstName);
            printed++;
            if (printed === 50 && totalFiles > 50) {
              log("... (" + (totalFiles - 50) + " more, suppressed)");
            }
          }
        } else {
          const row = {
            filename: pr.dstName, bytes: "", lastwrite_utc: "",
            sha256_src: "", sha256_dst: "", status: "", attempts: 1,
            last_error: "", completed_at: ""
          };
          try {
            const st = fs.statSync(pr.src.path);
            row.bytes = st.size;
            row.lastwrite_utc = isoSec(st.mtime);
            row.sha256_src = await sha256File(pr.src.path);
            const dstPath = path.join(memDir, pr.dstName);
            fs.copyFileSync(pr.src.path, dstPath);
            row.sha256_dst = await sha256File(dstPath);
            if (row.sha256_dst === row.sha256_src) {
              fs.utimesSync(dstPath, it.captureDate, it.captureDate);
              row.status = "verified";
              row.completed_at = isoSec(new Date());
            } else {
              row.status = "failed_hash";
              row.last_error = "sha256 mismatch after copy";
            }
          } catch (e) {
            row.status = "failed_copy";
            row.last_error = String(e.message || e);
          }
          manifestRows.push(row);
          metadataRows.push({
            filename: pr.dstName,
            capture_time_utc: isoSec(it.captureDate),
            latitude: it.record ? it.record.lat : "",
            longitude: it.record ? it.record.lon : "",
            media_type: it.mediaType,
            original_name: pr.src.base
          });
        }
      } catch (e) {
        log("WARN unexpected failure on " + pr.src.path + ": " + String(e.message || e));
      }
      if (processed % 200 === 0) {
        log("progress: " + processed + "/" + totalFiles + " files");
      }
    }
  }

  const copied = manifestRows.filter((r) => r.status === "verified").length;
  const failedRows = manifestRows.filter((r) => r.status !== "verified");

  // write csvs (commit only - they record actual hashes)
  if (commit) {
    const mh = "filename,bytes,lastwrite_utc,sha256_src,sha256_dst,status,attempts,last_error,completed_at";
    const mlines = [mh];
    for (const r of manifestRows) {
      mlines.push([r.filename, r.bytes, r.lastwrite_utc, r.sha256_src, r.sha256_dst,
        r.status, r.attempts, r.last_error, r.completed_at].map(csvEsc).join(","));
    }
    fs.writeFileSync(path.join(out, "manifest.csv"), mlines.join("\n") + "\n", "utf8");
    if (failedRows.length > 0) {
      const flines = [mh];
      for (const r of failedRows) {
        flines.push([r.filename, r.bytes, r.lastwrite_utc, r.sha256_src, r.sha256_dst,
          r.status, r.attempts, r.last_error, r.completed_at].map(csvEsc).join(","));
      }
      fs.writeFileSync(path.join(out, "failed.csv"), flines.join("\n") + "\n", "utf8");
    }
    const dh = "filename,capture_time_utc,latitude,longitude,media_type,original_name";
    const dlines = [dh];
    for (const r of metadataRows) {
      dlines.push([r.filename, r.capture_time_utc, r.latitude, r.longitude,
        r.media_type, r.original_name].map(csvEsc).join(","));
    }
    fs.writeFileSync(path.join(out, "metadata.csv"), dlines.join("\n") + "\n", "utf8");
  }

  // reconciliation report
  const mains = items.length;
  const overlays = totalFiles - mains;
  const matched = items.filter((it) => it.record).length;
  const linkRecordsTotal = allRecords.filter((r) => r.link).length;
  const rpt = [];
  rpt.push("Snapchat ingest reconciliation report");
  rpt.push("generated: " + isoSec(new Date()));
  rpt.push("mode: " + (commit ? "commit" : "dry-run"));
  rpt.push("input:  " + input);
  rpt.push("output: " + out);
  rpt.push("");
  rpt.push("export roots: " + roots.length);
  for (const ri of rootInfos) {
    let verdict = "media export";
    if (ri.linkOnly) verdict = "LINKS ONLY";
    else if (ri.records.length === 0 && ri.media.length === 0) {
      verdict = ri.htmlFiles.length > 0 ? "html only (re-request export with JSON included)" : "empty";
    } else if (ri.records.length === 0) verdict = "media, no json";
    rpt.push("  - " + ri.root);
    rpt.push("      records: " + ri.records.length + ", media files: " + ri.media.length +
      ", verdict: " + verdict);
  }
  for (const ef of extractionFailures) {
    rpt.push("  - EXTRACTION FAILED: " + ef);
  }
  rpt.push("");
  rpt.push("JSON records found: " + allRecords.length);
  rpt.push("records with download links: " + linkRecordsTotal);
  rpt.push("media files found: " + totalFiles + " (main: " + mains + ", overlay: " + overlays + ")");
  rpt.push("matched (main media <-> JSON record): " + matched);
  if (commit) {
    rpt.push("copied+verified: " + copied);
    rpt.push("failed: " + failedRows.length);
    for (const r of failedRows) {
      rpt.push("  - " + r.filename + " [" + r.status + "] " + r.last_error);
    }
  } else {
    rpt.push("would copy: " + totalFiles + " files (dry-run, nothing written)");
  }
  rpt.push("unmatched media files (no JSON record, dated from filename/mtime): " + unmatchedMedia.length);
  for (const u of unmatchedMedia) rpt.push("  - " + u);
  rpt.push("records without media: " + recordsWithoutMedia.length +
    (recordsWithoutMedia.length > 50 ? " (showing first 50)" : ""));
  for (const r of recordsWithoutMedia.slice(0, 50)) rpt.push("  - " + r.label);
  const linkOnlyRoots = rootInfos.filter((ri) => ri.linkOnly);
  if (linkOnlyRoots.length > 0) {
    rpt.push("");
    rpt.push("NOTE: link-based export(s) detected. These contain download links");
    rpt.push("instead of media files. Nothing was downloaded.");
    for (const ri of linkOnlyRoots) {
      rpt.push("  - " + ri.root + ": " + ri.linkRecords + " download links, 0 media files");
    }
  }
  const reportText = rpt.join("\n") + "\n";
  log("");
  log(reportText);
  fs.writeFileSync(path.join(out, "report.txt"), reportText, "utf8");

  return {
    records: allRecords.length,
    linkRecords: linkRecordsTotal,
    mediaFound: totalFiles,
    mains, overlays, matched,
    copied, failed: failedRows.length,
    unmatchedMedia, recordsWithoutMedia,
    items, manifestRows, rootInfos, extractionFailures
  };
}

/* ---------------- self test ---------------- */

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snap-ingest-test-"));
  const inputDir = path.join(tmp, "input");
  const outDir = path.join(tmp, "out");
  const memSrc = path.join(inputDir, "export1", "memories");
  const jsonDir = path.join(inputDir, "export1", "json");
  fs.mkdirSync(memSrc, { recursive: true });
  fs.mkdirSync(jsonDir, { recursive: true });

  const uA = "aaaaaaaa-1111-2222-3333-444444444444";
  const uB = "bbbbbbbb-1111-2222-3333-444444444444";
  const uC = "cccccccc-1111-2222-3333-444444444444";
  const uD = "dddddddd-1111-2222-3333-444444444444";
  const mk = (name, content) =>
    fs.writeFileSync(path.join(memSrc, name), Buffer.from(content.repeat(40)));
  mk("2023-05-01_" + uA + "-main.jpg", "fake jpeg A ");
  mk("2023-05-01_" + uA + "-overlay.png", "fake overlay A ");
  mk("2023-06-02_" + uB + "-main.mp4", "fake video B ");
  mk("2023-07-03_" + uC + "-main.jpg", "fake orphan C "); // no JSON record
  mk("2024-01-15_" + uD + "-main.jpg", "fake jpeg D ");

  const json = {
    "Saved Media": [
      { "Date": "2023-05-01 10:20:30 UTC", "Media Type": "Image", "Media ID": uA,
        "Location": "Latitude, Longitude: 59.9139, 10.7522" },
      { "Date": "2023-06-02 08:00:00 UTC", "Media Type": "Video", "Media ID": uB },
      { "Date": "2024-01-15 23:59:59 UTC", "Media Type": "PHOTO", "Mid": uD,
        "Latitude": "40.7128", "Longitude": "-74.0060" },
      { "Date": "2022-12-25 18:00:00 UTC", "Media Type": "Image",
        "Download Link": "https://app.snapchat.com/dmd/memories?mid=eeeeeeee-1111-2222-3333-444444444444&sig=x" }
    ]
  };
  fs.writeFileSync(path.join(jsonDir, "memories_history.json"), JSON.stringify(json, null, 2));

  try {
    // dry run
    const dry = await run({ input: inputDir, out: outDir, commit: false });
    assert(!fs.existsSync(path.join(outDir, "memories")), "dry-run must not create memories dir");
    assert(fs.existsSync(path.join(outDir, "report.txt")), "dry-run writes report.txt");
    assert(dry.records === 4, "dry: records found = 4, got " + dry.records);
    assert(dry.mediaFound === 5, "dry: media found = 5, got " + dry.mediaFound);
    assert(dry.matched === 3, "dry: matched = 3, got " + dry.matched);
    assert(dry.copied === 0, "dry: copied = 0, got " + dry.copied);

    // commit
    const res = await run({ input: inputDir, out: outDir, commit: true });
    assert(res.records === 4, "records found = 4, got " + res.records);
    assert(res.mediaFound === 5, "media found = 5, got " + res.mediaFound);
    assert(res.mains === 4 && res.overlays === 1, "mains=4 overlays=1, got " +
      res.mains + "/" + res.overlays);
    assert(res.matched === 3, "matched = 3, got " + res.matched);
    assert(res.copied === 5, "copied+verified = 5, got " + res.copied);
    assert(res.failed === 0, "failed = 0, got " + res.failed);
    assert(res.unmatchedMedia.length === 1 && res.unmatchedMedia[0].includes(uC),
      "unmatched media = 1 (file C)");
    assert(res.recordsWithoutMedia.length === 1 &&
      res.recordsWithoutMedia[0].label.includes("2022-12-25"),
      "records without media = 1 (link record)");

    const memOut = path.join(outDir, "memories");
    const outFiles = fs.readdirSync(memOut).sort();
    const expect = [
      "2023-05-01_10-20-30_aaaaaaaa.jpg",
      "2023-05-01_10-20-30_aaaaaaaa_overlay.png",
      "2023-06-02_08-00-00_bbbbbbbb.mp4",
      "2023-07-03_00-00-00_cccccccc.jpg",
      "2024-01-15_23-59-59_dddddddd.jpg"
    ];
    assert(JSON.stringify(outFiles) === JSON.stringify(expect),
      "output names, got " + JSON.stringify(outFiles));

    // mtime restored to capture time
    const stA = fs.statSync(path.join(memOut, expect[0]));
    assert(Math.abs(stA.mtime.getTime() - Date.UTC(2023, 4, 1, 10, 20, 30)) < 2000,
      "mtime of A = capture time, got " + stA.mtime.toISOString());
    const stC = fs.statSync(path.join(memOut, expect[3]));
    assert(Math.abs(stC.mtime.getTime() - Date.UTC(2023, 6, 3, 0, 0, 0)) < 2000,
      "mtime of C = filename date midnight, got " + stC.mtime.toISOString());
    // overlay gets the capture time of its main
    const stOv = fs.statSync(path.join(memOut, expect[1]));
    assert(Math.abs(stOv.mtime.getTime() - Date.UTC(2023, 4, 1, 10, 20, 30)) < 2000,
      "overlay mtime = main capture time");

    // manifest: 5 rows, all verified, hashes match
    const man = fs.readFileSync(path.join(outDir, "manifest.csv"), "utf8")
      .trim().split("\n");
    assert(man[0] === "filename,bytes,lastwrite_utc,sha256_src,sha256_dst,status,attempts,last_error,completed_at",
      "manifest header");
    assert(man.length === 6, "manifest rows = 5, got " + (man.length - 1));
    for (const line of man.slice(1)) {
      assert(line.includes(",verified,"), "manifest row verified: " + line);
    }
    assert(res.manifestRows.every((r) => r.sha256_src === r.sha256_dst && r.sha256_src.length === 64),
      "all sha256 pairs match");
    assert(!fs.existsSync(path.join(outDir, "failed.csv")), "no failed.csv when zero failures");

    // metadata: gps carried through
    const meta = fs.readFileSync(path.join(outDir, "metadata.csv"), "utf8");
    assert(meta.includes("59.9139") && meta.includes("10.7522"), "metadata has location of A");
    assert(meta.includes("40.7128") && meta.includes("-74.0060"), "metadata has separate lat/lon of D");
    assert(meta.trim().split("\n").length === 6, "metadata rows = 5");

    // report saved
    const rep = fs.readFileSync(path.join(outDir, "report.txt"), "utf8");
    assert(rep.includes("records without media: 1"), "report counts records without media");
    assert(rep.includes(uC), "report lists unmatched media file C");

    console.log("SELFTEST PASSED");
    return true;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

/* ---------------- cli ---------------- */

function usage() {
  console.log("usage: node ingest.js <input> --out <output-folder> [--commit]");
  console.log("       node ingest.js --selftest");
  console.log("<input>: folder containing Snapchat My Data exports (.zip or extracted folders)");
  console.log("dry-run by default; --commit performs the copy.");
}

async function main() {
  const args = process.argv.slice(2);
  let input = null, out = null, commit = false, doSelftest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--commit") commit = true;
    else if (a === "--selftest") doSelftest = true;
    else if (a === "--out" || a === "--output") out = args[++i];
    else if (a === "--input" || a === "--in") input = args[++i];
    else if (a === "--help" || a === "-h") { usage(); return; }
    else if (!a.startsWith("--") && !input) input = a;
    else { console.error("unknown argument: " + a); usage(); process.exitCode = 1; return; }
  }
  if (doSelftest) {
    try {
      await selftest();
    } catch (e) {
      console.error("SELFTEST FAILED: " + String(e.message || e));
      process.exitCode = 1;
    }
    return;
  }
  if (!input || !out) { usage(); process.exitCode = 1; return; }
  if (!fs.existsSync(input)) {
    console.error("input not found: " + input);
    process.exitCode = 1;
    return;
  }
  try {
    await run({ input, out, commit });
  } catch (e) {
    console.error("fatal: " + String(e.message || e));
    process.exitCode = 1;
  }
}

main();
