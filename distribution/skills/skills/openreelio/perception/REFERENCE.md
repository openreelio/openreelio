# Perception

Find out what is in the footage before cutting it. Results are cached in the
project's shared analysis bundle, so the desktop app sees whatever you computed.

## Analysis verbs

```bash
openreelio-cli analysis shots   --path ./demo --id <ASSET_ID> \
  [--threshold 0.3] [--min-shot-duration 0.5] [--timeout-sec 600] [--no-persist]
openreelio-cli analysis silence --path ./demo --id <ASSET_ID> \
  [--threshold-db -40] [--min-duration 0.5]
openreelio-cli analysis audio   --path ./demo --id <ASSET_ID>
openreelio-cli analysis run     --path ./demo --id <ASSET_ID> \
  [--all | --shots --audio --segments --visual --transcript] [--progress]
openreelio-cli analysis report  --path ./demo --id <ASSET_ID>
```

**`analysis shots`** returns `totalDurationSec`, `shotCount`, and
`shots[{index,startSec,endSec,durationSec,confidence}]`. `persisted` is an array
naming the stores written, e.g. `["indexDb","bundle","annotations"]`, and
`warnings` explains every store that was not. `status` is `ok` (all requested
stores written, or `--no-persist`), `partial` (some written — still exit `0`),
or `failed` (none written — detection worked but the verb did not, exit `1`).
Cut on shot boundaries, not round numbers.

> `asset import` does not probe media duration, so a clip placed by
> `timeline insert` gets the 10-second default length. `totalDurationSec` from
> `analysis shots` (or `durationSec` from `analysis audio`) is how you learn the
> real length; then `timeline trim --source-in 0 --source-out <duration>`.

**`analysis silence`** returns `regions[{startSec,endSec,durationSec}]`,
`totalSilenceSec`, and a boolean `persisted`. Results reach the shared cache only
at the default thresholds (`-40` dB, `0.5` s) *and* only when an audio profile
already exists. Otherwise the run is output-only: `"persisted": false` with a
`reason` of `"non-default threshold"`, `"non-default min-duration"`, or
``"no audio profile in bundle; run `analysis audio` first"``. The numbers are
still correct — they just do not update the cache.

**`analysis audio`** runs the full profiler (silence, loudness curve, peak, BPM,
speech regions) and always persists into the bundle.

**`analysis run`** drives the job runner with local-only providers. Transcript is
off unless `--transcript` is passed and fails fast with a
`transcription install` hint when no Whisper model is present. `--progress`
streams `{"type":"progress","job","status","detail"}` to stderr. Per-job failures
land in `errors`; the exit is non-zero only if every enabled sub-job failed.

Semantic search over cached analysis (needs transcript/segments):

```bash
openreelio-cli analysis search         --path ./demo --id <ASSET_ID> --query "host question"
openreelio-cli analysis search-library --path ./demo --query "crowd cheer" --limit 8
openreelio-cli analysis build-selects  --path ./demo --query "crowd cheer" \
  --track-name "Source Selects" --limit 6 --apply
```

## Look at frames

```bash
openreelio-cli frame extract --path ./demo --time 12.5 --out frame.png
openreelio-cli frame extract --path ./demo --times 2,8,14 --out ./stills/
openreelio-cli frame extract --path ./demo --asset <ASSET_ID> --source-time 3.0 --out src.png
openreelio-cli frame extract --path ./demo --grid 3x2 --between 0 30 --out sheet.jpg
```

- `--time` is a timeline position; `--asset` + `--source-time` reads the asset's
  own media timebase; `--times a,b,c` writes a batch and needs `--out` to be a
  directory.
- `--mode fast` (default) renders the topmost file-backed clip only — no
  effects, text, or compositing. Cheap, and right for "what footage is here". It
  auto-falls back to composite, reporting `fellBackToComposite: true`, whenever
  fast mode cannot answer honestly: when there is no file-backed clip at that
  time (a title card, say), and when the topmost clip carries a transform or a
  non-default opacity, whose whole point is that the picture is no longer the
  source file. So a still used to check your own `SetClipTransform` edit shows
  the transform, at composite cost.
- `--mode composite` renders a minimal window through the full stack, so effects
  and overlays appear. Range renders decode from zero, so it costs more. It works
  anywhere inside the timeline, including over a gap — a gap has no picture, so a
  black frame is the answer, not an error.
- `--max-width` caps output size (1–3840 px, default 1280 px, aspect preserved,
  never upscaled).
- `--format png|jpeg` is optional: the format follows the `--out` extension, so
  `--out sheet.jpg` writes JPEG at exactly that path. Reach for `--format` on
  extensionless paths and `--times` directories, which default to PNG. A
  `--format` contradicting a `.png`/`.jpg` extension is rejected instead of
  quietly writing somewhere else.

**Contact sheets.** `--grid COLSxROWS` with either `--between START END
[--count N]` (uniform sampling) or `--times a,b,c` (explicit list, kept in the
order given) writes one sheet and returns
`sheet.cells[{index,row,col,timelineSec}]`, mapping every cell a vision model
comments on back to a timecode. Capped at 100 cells, and at 8000 px on either
finished edge — an oversized combination is rejected before any cell is
extracted.

- `--label-cells` burns each cell's index and *requested* timecode into the
  image, so the mapping survives without the JSON — use it beyond a 3×3.
- `--cell-width` / `--cell-height` (64–1024, default 320×180) size the cells.
  640×360 is the floor for reading captions; one dimension on its own derives
  the other at 16:9, since cells are fitted with
  `force_original_aspect_ratio=decrease` and a 640×180 cell would just pad black
  around a 320×180 picture. Grid cells are extracted at the cell width, so
  `--max-width` only matters as an oversampling override.
- All three flags need `--grid`; passing them with `--time` or `--asset` is
  rejected rather than ignored.

**From a rendered file.** `--file <RENDER>` extracts stills or sheets from a
rendered video instead of the project timeline — times are in the file's own
timebase and cells map back as `fileSec`. This is the cheap way to inspect the
render you just made (fast seeks, no per-cell timeline renders), and it shows
exactly the pixels `verify --file` measured. See
[Judging](../judging/REFERENCE.md) for the loop built on it.

Every timeline time has to be inside the sequence. One at or past the end is
rejected with the sequence's real duration in the message — the `0 30` above
assumes a sequence at least 30 s long, so check `timeline info` first.

Single and batch extraction return
`frames[{index,timeSec,sourceTimeSec,clipId,assetId,path,width,height}]`.
