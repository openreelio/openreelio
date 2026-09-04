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
> `timeline insert` gets the 10-second default length — which is also why a
> second `timeline insert --at 4.0` is refused as an overlap. `totalDurationSec`
> from `analysis shots` (or `durationSec` from `analysis audio`) is how you learn
> the real length; then trim the clip to it, naming the clip and its track:
>
> ```bash
> openreelio-cli timeline trim --path ./demo --clip <CLIP_ID> --track <TRACK_ID> \
>                              --source-in 0 --source-out <TOTAL_DURATION_SEC>
> ```
>
> `--clip` and `--track` are required; read both from `timeline clips`.

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
openreelio-cli frame extract --path ./demo --range 4 9.5 --grid auto --out changed.jpg
openreelio-cli frame extract --path ./demo --at-cuts --grid auto --out cuts.jpg
openreelio-cli frame extract --path ./demo --time 12.5 --out frame.png
openreelio-cli frame extract --path ./demo --times 2,8,14 --out ./stills/
openreelio-cli frame extract --path ./demo --asset <ASSET_ID> --source-time 3.0 --out src.png
openreelio-cli frame extract --path ./demo --grid 3x2 --between 0 30 --out sheet.jpg
```

- `--time` is a timeline position; `--asset` + `--source-time` reads the asset's
  own media timebase; `--times a,b,c` writes a batch and needs `--out` to be a
  directory.
- `--mode composite` is the **default**, and it is what export produces:
  captions, text clips, transforms, layered clips and blends all rendered, at the
  sequence canvas, losslessly. It works anywhere inside the timeline, including
  over a gap — a gap has no picture, so a black frame is the answer, not an
  error. Cost tracks the in-clip offset rather than the timeline position.
- A composite still is served **out of the preview render cache** when a cached
  segment covers the time and still matches the edit: one seek, identical pixels.
  Every still says where it came from — `"source": "cache" | "composite" |
  "source"` — and a contact sheet adds `sheet.sources`, counting the cells per
  tier. Nothing is written back to the cache; no cache is a miss, not an error.
- `--mode fast` is the opt-in cheap path: the topmost file-backed clip's own
  media, no effects, text, or compositing. Right for "what footage is here",
  wrong for judging an edit — when the sampled time carries captions, text, an
  effect, a transition, or a source that is not the canvas size, `warnings` names
  the time and says the picture is missing them. It still auto-falls back to
  composite, reporting `fellBackToComposite: true`, whenever fast mode cannot
  answer at all: no file-backed clip at that time (a title card, say), or a
  topmost clip carrying a transform or a non-default opacity, whose whole point
  is that the picture is no longer the source file. Outside `fast`,
  `fellBackToComposite` is `null`.
- `--max-width` caps output size (1–3840 px, default 1280 px, aspect preserved,
  never upscaled).
- `--format png|jpeg` is optional: the format follows the `--out` extension, so
  `--out sheet.jpg` writes JPEG at exactly that path. Reach for `--format` on
  extensionless paths and `--times` directories, which default to PNG. A
  `--format` contradicting a `.png`/`.jpg` extension is rejected instead of
  quietly writing somewhere else.

**Samplers: let the edit choose the times.** Rather than reading `timeline info`
and assembling a `--times` list, ask for the events:

| Flag | Samples | `reason` on each frame/cell |
| ---- | ------- | --------------------------- |
| `--range START END` (repeatable) | every range you name — the `affectedRanges` an apply just returned: its start, its middle, its last frame, and both sides of each cut inside it | `affectedStart` `affectedMid` `affectedEnd` `cutBefore` `cutAfter` |
| `--affected` | the same, over the last *recorded* edit's ranges rather than ranges you name | `affectedStart` `affectedMid` `affectedEnd` `cutBefore` `cutAfter` |
| `--at-cuts` | every cut, twice: the outgoing shot's last frame at `cut − 1.5/fps` and the incoming shot's first at the cut itself | `cutBefore` `cutAfter` |
| `--at-transitions` | each two-input blend's start, cut and end | `transitionStart` `transitionCut` `transitionEnd` |
| `--at-captions` | the middle of every caption span and text clip | `captionMid` `textMid` |
| `--at-markers` | every sequence marker | `marker` |
| `--per-shot` | the middle of every enabled, non-text clip on the video tracks the export includes | `shotMid` |
| `--around <SEC>` | a window around one time — `--span` (default 0.5 s) and `--around-count` (default 5) | `around` |

- The offset before a cut is a frame and a half, not a frame: seeks resolve
  **forward**, so a smaller backoff lands on the incoming shot and both samples
  show the same picture.
- Samplers combine as a union, deduplicate to the microsecond, and sort
  ascending. They cannot be combined with `--time`, `--times`, `--between`,
  `--count`, `--asset` or `--file`, which name their own times, and `--range`
  and `--affected` are mutually exclusive.
- `--limit <N>` thins an oversized selection evenly, keeping its first and last
  entry.
- The payload gains `sampler: {kinds, candidates, selected, limited,
  affectedRanges?}`, so a thinned list is visible rather than looking like a
  short timeline.
- **After an apply, use `--range`.** Every mutating verb — `command execute`,
  `plan execute`, and the `timeline`, `text` and `caption` edit verbs — returns
  `affectedRanges` alongside its op ids; pass one `--range START END` per entry.
  No hand-off file is read, so nothing another surface applies in between can
  redirect the look, and `sampler.kinds` reports `["ranges"]`.
- `--affected` is the shortcut for when you did not keep that result. It reads
  `<project>/.openreelio/cache/agent/last_affected_ranges.json`, written by those
  same verbs **and by the app's own edit path** (each record carries
  `source: cli | gui | agent-plan`) — so it is a shared slot, and an interactive
  edit made in the timeline after yours overwrites it. Such a record is still
  served, with a warning on the payload that the ranges belong to an interactive
  edit. Pass `--after-op <OP_ID>` — the `opId` your own edit reported — to have
  that checked: a record ending at another operation is refused, naming both.
  With no record, one naming another sequence, or one that does not end at the
  project's current operation, it errors and says what to do — it never guesses.
- Without `--grid` a sampler writes a batch of stills, so `--out` must be a
  directory.

**Contact sheets.** `--grid COLSxROWS` with either a sampler, `--between START
END [--count N]` (uniform sampling) or `--times a,b,c` (explicit list, kept in
the order given) writes one sheet and returns
`sheet.cells[{index,row,col,timelineSec,reason?}]`, mapping every cell a vision
model comments on back to a timecode. Capped at 100 cells, and at 8000 px on
either finished edge — an oversized combination is rejected before any cell is
extracted.

- `--grid auto` picks the layout from the sample count: 1 column for a single
  sample, 2 for two, 3 up to 9, 4 up to 16, then 6. It needs a sampler or `--times`, since
  `--between` already fixes its own count.

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
`frames[{index,timeSec,sourceTimeSec,clipId,assetId,path,width,height}]`, plus
`reason` on every frame a sampler chose.
