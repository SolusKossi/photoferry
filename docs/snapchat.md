# Snapchat Memories rescue

## What is happening

Snapchat capped free Memories storage at 5 GB. Accounts over the cap must
either pay for a storage plan or export their Memories; per press coverage,
memories above the cap face deletion, with a September 2026 deadline. If you
have years of Memories, get them out.

## Requesting the export

1. Sign in at accounts.snapchat.com and open "My Data".
2. Select **Memories** and make sure **include JSON files** is checked. The
   JSON is not optional for a usable archive - see the gotcha below.
3. Submit the request. The export arrives as one or more email links to zip
   files. Large libraries are split across several zips; download all of them.

## What is inside the zip

- The media files (photos and videos)
- `memories_history.json` - one record per memory with a UTC capture
  timestamp and, when available, GPS coordinates
- An HTML index

**The key gotcha:** Snapchat strips EXIF metadata from the media files. Dates
and GPS exist only in the JSON. If you import the raw files into a photo app,
every item lands on the export date, not the capture date.

## What the adapter does

`adapters/snapchat/ingest.js`:

- extracts the zip(s)
- matches each media file to its record in `memories_history.json`
- renames files to capture-date-based names
- restores file timestamps to the capture date
- pairs overlay files with their base media
- copies everything into an output folder with SHA-256 verification of
  every copy
- writes `manifest.csv`, `metadata.csv` (timestamps and GPS per file), and a
  reconciliation report

## Usage

```
node adapters/snapchat/ingest.js --input <folder-with-zips> --output <folder>            (dry run)
node adapters/snapchat/ingest.js --input <folder-with-zips> --output <folder> --commit
```

Dry run reports what would happen without writing media. Add `--commit` to
perform the copy.

## Limitations

- EXIF embedding is not yet implemented. Timestamps are restored at the
  filesystem level and preserved in `metadata.csv`, but not written into the
  media files themselves.
- Link-only exports (zips that contain download links instead of media) are
  detected and reported, but not downloaded automatically.

## Importing the output

Point Synology Photos, Immich, or any other photo app at the output memories
folder. Most apps read the file dates, so items sort under their capture
dates. Apps that only read EXIF will not see dates until EXIF embedding is
implemented; `metadata.csv` holds the full record either way.
