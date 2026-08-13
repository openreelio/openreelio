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
naming the stores written, e.g. `["indexDb","bundle","annotations"]`. Cut on shot
boundaries, not round numbers.

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
  auto-falls back to composite when there is no such clip (a title card, say) and
  reports `fellBackToComposite: true`.
- `--mode composite` renders a minimal window through the full stack, so effects
  and overlays appear. Range renders decode from zero, so it costs more.
- `--max-width` caps output size (default 1280 px, aspect preserved, never
  upscaled). `--format png|jpeg`.

**Contact sheets.** `--grid COLSxROWS --between START END [--count N]` writes one
sheet and returns `sheet.cells[{index,row,col,timelineSec}]`, mapping every cell
a vision model comments on back to a timecode. Capped at 100 cells.

Single and batch extraction return
`frames[{index,timeSec,sourceTimeSec,clipId,assetId,path,width,height}]`.
