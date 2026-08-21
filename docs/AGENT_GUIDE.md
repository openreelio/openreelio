# OpenReelio Agent Guide

The canonical reference for driving OpenReelio from an AI agent or a script.

`openreelio-cli` is a headless non-linear editor. It keeps a real project on
disk — an append-only command log plus a derived state snapshot — and exposes
media analysis, editing, captioning, rendering and deterministic QC as
subcommands that print JSON. Every edit is a command in the log, so a session is
inspectable, undoable and replayable. Everything below was cross-checked against
the CLI; when this document and `openreelio-cli <verb> --help` disagree, the
binary wins.

## 1. Install

### npm (recommended for agents)

```bash
npm install -g openreelio-cli
# or, without installing:
npx openreelio-cli --help
```

The package downloads nothing at install time. The binary ships in a
platform-specific optional dependency (`@openreelio/cli-win32-x64`,
`-darwin-x64`, `-darwin-arm64`, `-linux-x64`) that npm resolves from `os`/`cpu`,
so installs work with lifecycle scripts disabled. Linux builds are glibc only;
there is no musl variant.

### Standalone release archive

Every release publishes standalone CLI archives named
`openreelio-cli-<version>-<target-triple>.zip` (Windows) or
`openreelio-cli-<version>-<target-triple>.tar.gz` (macOS, Linux) on the
[releases page](https://github.com/openreelio/openreelio/releases). macOS marks
downloaded archives with a quarantine attribute; clear it before running the
extracted binary:

```bash
xattr -d com.apple.quarantine ./openreelio-cli
```

### App-bundled sidecar

The desktop app ships the same binary next to the app executable:
`<app-dir>/binaries/openreelio-cli[.exe]` on Windows and Linux,
`OpenReelio.app/Contents/Resources/binaries/openreelio-cli` on macOS
(`<app-dir>/resources/binaries/` is also searched).

Point the npm shim at any binary with `OPENREELIO_CLI_BINARY=<absolute path>`;
the launcher then uses it verbatim.

## 2. The machine contract

**stdout is one JSON object.** Every successful command prints a single JSON
document to stdout and nothing else.

**stderr carries progress and diagnostics.** Long-running verbs
(`render start --progress`, `analysis run --progress`) stream NDJSON progress
lines to stderr. Log output (`--verbose`, `--quiet`) also goes to stderr. Never
parse stderr as the result.

**Exit codes.** Most verbs exit `0` on success and `1` on failure, with the
error text on stderr. `verify` is the exception: `0` ran without breaching the
`--fail-on` threshold, `1` breached it, `2` the tool itself failed (bad
arguments, unreadable file, FFmpeg error).

**`--path <PROJECT_DIR>` on every project verb.** There is no ambient "current
project". Only `help-json`, `command schema`, `plan template`, `render presets`,
`ffmpeg info`, `transcription status` and `transcription install` omit it.
`--sequence` is always optional and defaults to the active sequence.

**IDs are ULIDs, not `asset_001`.** The examples in `help-json` use readable
placeholders. Real IDs look like `01KZW64VJ4JPBS5B9YZEA335J8`. Read them from
`createdIds` in the command result, or from `asset list` / `timeline tracks` /
`timeline clips`.

**Negative numbers need `=`.** `--target-lufs -14` is parsed as a flag and
errors. Write `--target-lufs=-14` and `--max-true-peak=-1`. Two options accept
the spaced form as well — `analysis silence --threshold-db -40` and
`state jump --index -1` — but the `=` form works everywhere, so write it
everywhere rather than tracking the exceptions.

### Discovering the surface

`help-json` prints the whole command schema, but it is ~68 KB — do not preload
it into a context window. Fetch help per verb instead
(`openreelio-cli verify --help`, `openreelio-cli frame extract --help`), use
`openreelio-cli command schema` for the 79 backend command types, and
`openreelio-cli packs list` for the curated caption styles, transition recipes,
text presets, and pacing profiles (`--kind caption|transition|text|pacing`).

### Self-diagnosis

`openreelio-cli ffmpeg info` returns
`{status, ffmpegPath, ffprobePath, version, source}`, where `source` is one of
`explicit`, `env`, `bundled`, `managed`, `dev`, `system` — the resolution order.
Override the toolchain with `OPENREELIO_FFMPEG_PATH` and
`OPENREELIO_FFPROBE_PATH`; both outrank every bundled or system install. Run
this first when a media verb fails for no obvious reason.

## 3. Project lifecycle

`project create` makes the directory and a default sequence with one video and
one audio track. `asset import` returns
`{"status","opId","createdIds":[<ASSET_ID>],"assetName","uri"}`.

```bash
openreelio-cli project create --name "Demo" --path ./demo
openreelio-cli project open   --path ./demo
openreelio-cli project info   --path ./demo
openreelio-cli project save   --path ./demo
openreelio-cli asset import   --path ./demo --file ./footage.mp4 [--name "A-roll"]
openreelio-cli asset list     --path ./demo
openreelio-cli asset info     --path ./demo --id <ASSET_ID>
openreelio-cli asset remove   --path ./demo --id <ASSET_ID>
```

> **Duration gap.** `asset import` does not probe media duration. A clip placed
> with `timeline insert` therefore gets the 10-second default length regardless
> of how long the file actually is. The reliable source of real duration is
> perception: `analysis shots` returns `totalDurationSec`, and `analysis audio`
> returns `durationSec`. Insert, then `timeline trim --source-in 0
> --source-out <totalDurationSec>` to make the clip match the media.

## 4. Editing

### Timeline verbs

```bash
openreelio-cli timeline info    --path ./demo
openreelio-cli timeline tracks  --path ./demo
openreelio-cli timeline clips   --path ./demo [--track <TRACK_ID>]

openreelio-cli timeline insert  --path ./demo --asset <ASSET_ID> --track <TRACK_ID> --at 0.0
openreelio-cli timeline trim    --path ./demo --clip <CLIP_ID> --track <TRACK_ID> --source-in 0 --source-out 12
openreelio-cli timeline split   --path ./demo --clip <CLIP_ID> --track <TRACK_ID> --at 6.0
openreelio-cli timeline move    --path ./demo --clip <CLIP_ID> --track <TRACK_ID> --to 10.0 [--new-track <TRACK_ID>]
openreelio-cli timeline speed   --path ./demo --clip <CLIP_ID> --track <TRACK_ID> --speed 2.0 [--reverse]
openreelio-cli timeline remove  --path ./demo --clip <CLIP_ID> --track <TRACK_ID>

openreelio-cli timeline add-track    --path ./demo --kind video --name "Video 2"
openreelio-cli timeline remove-track --path ./demo --track <TRACK_ID>

openreelio-cli timeline undo --path ./demo
openreelio-cli timeline redo --path ./demo
```

The trim flags are `--source-in` / `--source-out` (source-media in/out points),
not `--in` / `--out`.

`timeline clips` returns each clip's `id`, `trackId`, `assetId`,
`timelineInSec`, `durationSec`, `sourceInSec`, `sourceOutSec` and `speed` —
enough to compute any subsequent edit without dumping full state.

### The escape hatch: `command execute`

The convenience verbs cover the common cuts. Everything the editor can do —
79 command types including effects, masks, keyframes, compound clips,
adjustment layers, audio ducking, blend modes — is reachable directly:

```bash
openreelio-cli command schema                       # list all 79 types
openreelio-cli command validate --type RenameTrack --payload '{…}'
openreelio-cli command execute  --path ./demo --type SplitClip \
  --payload '{"sequenceId":"…","trackId":"…","clipId":"…","splitTime":5}'
```

Payloads are camelCase JSON objects. Use `--payload-file <FILE>` instead of
`--payload` when the JSON is large or shell quoting is awkward. `command
validate` runs the same strict parser without touching the project.

### Transitions

Transitions are effects — there is no `AddTransition` command. `AddEffect`
accepts a curated `recipe` in place of an `effectType` plus hand-picked
parameters:

```bash
openreelio-cli packs list --kind transition
openreelio-cli command execute --path ./demo --type AddEffect   --payload '{"sequenceId":"…","trackId":"…","clipId":"…","recipe":"dissolve-soft"}'
```

Recipes: `dissolve-soft`, `dissolve-standard`, `dissolve-long`, `fade-in`,
`fade-out`, `wipe-left`, `wipe-right`, `wipe-up`, `wipe-down`, `slide-left`,
`slide-right`. A recipe is a base layer — `params` overrides it key by key —
and a recipe paired with a contradictory `effectType` is rejected. `fade-out`
is anchored on the clip's tail when the command executes; pass
`params.start_time` only to put the fade somewhere else in the clip.

### Transitions and when they render

A transition is rendered when it can be, and reported as a cut when it cannot:

| Recipe family | Rendered by `render start` |
|---------------|----------------------------|
| `fade-in`, `fade-out` | **Yes** — single-input filters in the clip's own chain |
| `dissolve-*`, `wipe-*`, `slide-*` | **Yes, given handles** — the boundary blends, the picture and the sound crossfade together, and the file stays exactly as long as the timeline. Without handles the boundary renders as a hard cut and the render reports a warning naming the clip, the effect and the reason |

A two-input transition needs the outgoing and incoming pictures at once, and
overlapping them the naive way shortens the video stream while every clip's
audio stays at its absolute timeline position: the file would drift out of sync
and end before `Sequence::output_duration()`, which is the length `verify`
measures against. So the blend is not paid for out of the timeline. Both clips
reach into source media the edit is not using instead — **handles**: the
outgoing clip plays half the transition past its out point, the incoming clip
starts half of it early, and the overlap consumes exactly what they added. Not a
frame of the timeline moves.

That means a transition needs **half its length of unused source media on each
side**. A one-second dissolve needs half a second past the outgoing clip's out
point and half a second before the incoming clip's in point. Clips trimmed from
longer sources have this; a clip using every frame of its source does not.

The render degrades to a cut, with a warning naming the clip, the effect and the
reason, when:

1. the effect is not on a video track — there is no picture to blend;
2. its track is hidden;
3. the clip carrying it is disabled;
4. it is on an adjustment layer, which grades the clips beneath it rather than
   contributing a picture of its own;
5. it is on a text clip, which is drawn over the finished picture rather than
   contributing one to blend;
6. no clip starts where the carrier ends on the same track (a gap, or the last
   clip on the track) — there is nothing to blend into;
7. the clip that does start there contributes no picture either, for any of
   reasons 1-5;
8. the clip carries **another two-input transition already** — a clip has one
   out point, so the first one wins and every later one is refused by name;
9. its `duration` is not a positive number, or is longer than the **10 s**
   maximum the engine will place (a guard against a millisecond value arriving
   where seconds were meant);
10. its duration is **not shorter than both** shots it joins — shorten the
    transition or lengthen the clips;
11. either clip is frozen, reversed or time-remapped, so its render window has
    no well-defined reach into source;
12. the outgoing asset's length was never measured, so its handle cannot be
    *proven* to exist — import or re-probe the asset (`analysis run`);
13. either side is short of handle — the warning says which side, how much media
    it has, and how much the blend needed.

A transition that renders can still draw a warning of its own: a blend across a
**razor split** — where the outgoing clip's out point is the incoming clip's in
point in the same source — mixes every frame with itself and is invisible in the
finished file. It renders, correctly, and the render says it will not be seen.
Trim material at the boundary first.

**Audio on a separate track is not crossfaded.** The engine fades the audio that
travels with the two clips it is blending. Sound placed on its own audio track —
detached audio, a music bed, a separate narration take — keeps whatever fades it
was authored with, so a hard edit there will still be heard as a hard edit
underneath a picture that dissolves. Author `fade_in_sec`/`fade_out_sec` on those
clips to match.

An eligible transition produces **no warning at all** — the render matches what
the timeline shows. For a soft-looking cut where handles are impossible, put
`fade-out` on the outgoing clip and `fade-in` on the incoming one.

`verify` reports the same refusals as the structural check
`transition.no_handles`, without needing a rendered file: it reads the project,
asks the same planner the render asks, and carries a `RemoveEffect` fix for each
transition that will not survive the render.

### Framing a clip: transform and opacity

`SetClipTransform` places a clip on the canvas and `SetClipOpacity` fades it.
Both render in the final export, not just in the preview:

```bash
openreelio-cli command execute --path ./demo --type SetClipTransform   --payload '{"sequenceId":"…","trackId":"…","clipId":"…","transform":{
    "position":{"x":0.25,"y":0.25},"scale":{"x":0.5,"y":0.5},
    "rotationDeg":0,"anchor":{"x":0.5,"y":0.5}}}'
```

`position` is where the *anchor* lands on the canvas as a fraction of it;
`anchor` is the point of the picture pinned there, and rotation turns about it.
`scale` multiplies the letterbox fit, so `{1, 1}` means "fitted to the canvas".
Placement is measured against the source's real pixel size, so a 4:3 clip in a
16:9 sequence keeps its shape.

Three limits remain, and the export is explicit about each:

| Feature | Rendered by `render start` |
|---------|----------------------------|
| Clip transform and opacity | **Yes** — composited at the clip's base values |
| Motion keyframes (`SetClipMotionKeyframes`) | **Not yet** — the clip renders static at its base transform and the result carries a `warnings` entry naming it |
| Simultaneous layered video clips (picture-in-picture), blend modes | **Not yet** — validation refuses the render rather than dropping a layer |

Motion is stored, round-trips through the project and animates in the preview;
only the render is static. A clip whose keyframes all match its base transform
is not warned about, because that is exactly the picture the export produces.

### Atomic batches: `plan execute`

An edit plan is `{"id": "...", "steps": [{"id","commandType","payload","dependsOn"}]}`.
The whole plan is validated before anything mutates (1000-step cap); steps run
in dependency order and the whole plan rolls back if any step fails.
`plan execute` returns `{"status","planId","stepsExecuted","stepResults":[…]}`.

```bash
openreelio-cli plan template --type split-and-move
openreelio-cli plan validate --path ./demo --file plan.json
openreelio-cli plan execute  --path ./demo --file plan.json
```

`plan execute` has its own exit codes: `0` applied and saved, `1` rejected or
failed and rolled back cleanly, `2` the tool failed, the rollback was
incomplete (`rollbackIncomplete: true`), or the plan applied but could not be
saved (`appliedNotSaved: true` — the work is already durable; do **not** re-run
the plan).

### Pacing profiles: `plan from-profile`

A curated pacing profile names the decisions an automated cut has to make — mean
shot length, how far shots swing either side of it, and whether cuts land on
detected shot changes — so `dynamic-social` replaces guesses with one checked id.
`packs list --kind pacing` prints the registry.

| Profile | Target shot | Variance | Tempo | Snaps to shot changes |
|---------|-------------|----------|-------|-----------------------|
| `shorts-hook-fast` | 1.8 s | 0.6 s | fast | yes |
| `music-montage` | 1.5 s | 0.2 s | fast | no |
| `dynamic-social` | 2.5 s | 1.0 s | moderate | yes |
| `steady-documentary` | 4.5 s | 1.5 s | moderate | yes |
| `calm-longform` | 7.0 s | 2.0 s | slow | yes |

Every shipped profile cuts hard. `transitionRecipe` (`null`) and
`transitionEveryN` (`0`) stay in the schema, still reserved — and handles are
not the reason. A profile cuts one asset, so every boundary it makes is a razor
split: both sides keep all the unused media a blend could want, and the renderer
would blend each one. Both sides are also the same footage at the same frame, so
the blend mixes every frame with itself and renders identically to the cut it
replaced — see
[Transitions and when they render](#transitions-and-when-they-render). Producing
boundaries with material to blend between is a separate piece of work. Ids resolve case- and separator-insensitively and accept
aliases (`shorts`, `montage`, `social`, `doc`, `calm`, …).

Analysis is a precondition, not a nicety: the plan needs the source duration, and
shot boundaries are what let cuts land on real shot changes. Without a cached
bundle the command fails and names `analysis run`.

```bash
openreelio-cli analysis run      --path ./demo --id <ASSET_ID> --shots
openreelio-cli plan from-profile --path ./demo --profile dynamic-social \
  --asset <ASSET_ID> [--sequence <SEQUENCE_ID>] [--track-name "Cut"] --out plan.json
openreelio-cli plan validate     --path ./demo --file plan.json
openreelio-cli plan execute      --path ./demo --file plan.json
openreelio-cli verify            --path ./demo --structural-only
openreelio-cli render start      --path ./demo --proxy --output ./proxy.mp4 --progress
```

`from-profile` mutates nothing. It prints one JSON object — `status`, `planId`,
`profile`, `assetId`, `sequenceId`, `stepCount`, `cutCount`, `transitionCount`,
`transitionRecipe`, `fidelityScore`, `warnings`, `errors`, `stepsWithReferences`,
`outputPath`, and `plan`. With `--out` the plan is written to that file and
`plan` is `null` on stdout — the summary plus the path rather than a second copy;
without `--out` the plan is inlined. `--track-name` defaults to
`Pacing: <profile>`. Review the file, then validate and execute it; after the
proxy render, score it with a contact sheet against the rubric in the skill's
`judging/REFERENCE.md`. Two profiles are two candidates, so a profile is a
natural axis for best-of-N.

A source too short to cut is not a failure: the plan still creates the track and
places the clip, `cutCount` is `0`, and `warnings` says why — a source under 1.5x
the target shot rounds to a single shot, and a `respectShotBoundaries` profile
whose bundle holds a single shot has nothing to snap onto. Read `warnings` before
drawing any conclusion from a low `cutCount`.

The plan creates its own video track (`AddTrack`), inserts the asset
(`InsertClip`) and splits it (`SplitClip` per cut). Steps reference ids earlier
steps create, as `{"$fromStep": "step-0", "$path": "createdIds.0"}`, so run it
whole through `plan execute` rather than replaying steps by hand — and
`plan validate` rejects a reference whose target step is not ordered behind it
via `dependsOn`, listing every step carrying one under `stepsWithReferences`.
A reference is type-checked with a stand-in of either JSON type, so one pointing
into a numeric field (`splitTime`) validates as readily as one into a string
field (`clipId`); only the referenced value itself waits for execute.

### What a pacing profile does not decide

A profile decides pace. Nothing else.

- **No transitions.** Every shipped profile cuts hard. A dissolve added by hand
  does render, given handles on both sides of the boundary — the planner just
  does not place one for you.
- **No beat sync.** The analysis bundle carries BPM as a single average scalar,
  not a beat grid. `music-montage` is metronomic, not beat-locked; cutting on the
  beat needs analysis that does not exist yet.
- **No content awareness beyond shot boundaries.** The planner does not know what
  is in frame, whether a sentence finished, or whether a face is mid-blink.
  `respectShotBoundaries` snapping — a cut moves at most half a target shot to
  reach a detected shot change — is the whole of it, and it does nothing without
  cached shot detection.
- **No randomness.** Shot lengths alternate deterministically, half a variance
  either side of the target, then scale to fill the source, so the same profile
  on the same source always yields the same plan. That makes the plan reviewable;
  it is not a claim of variety.
- **`fidelityScore` is not a quality score.** It measures how close the mean
  generated shot is to the profile's target, and says nothing about whether the
  edit is any good. That judgement belongs to the judging loop.

### Undo and history

`timeline undo` / `timeline redo` walk the op log. `state ops --last N` shows
recent operations, `state dump` the full derived state, `state snapshot` forces
a snapshot write.

`state history` lists the persisted history as one index space —
`{appliedCount, redoCount, currentIndex, entries:[{index, opId, commandType,
timestamp}]}` — and `state jump --index N` repositions history after entry `N`
in one step (`--index=-1` undoes everything; the move persists). Any new
mutating command after a jump clears the redo branch, so an unwound state is
only reachable again by re-applying its plan JSON.

A jump reports what it removed: `unwound:[{opId, commandType}]` lists every
applied entry the rewind took out, in order, and `adopted` counts the ops this
invocation folded in from the log when it opened. Both matter because the index
space is recomputed on every invocation — an index recorded before another
writer appended does not mean the same thing afterwards. Re-read `state history`
immediately before jumping, confirm every entry above your baseline is your own,
and check `unwound` after. If the save fails after the move, the response is
`{"status":"error","historyMoved":true,…}` with exit code 2: the reposition is
already durable, so do not retry the jump expecting the old position.

## 5. The perception loop

An agent that cannot see the footage is guessing. These verbs produce the facts.

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

- **`analysis shots`** returns `totalDurationSec`, `shotCount` and
  `shots[{index,startSec,endSec,durationSec,confidence}]`. `persisted` is an
  array naming the stores written: `["indexDb","bundle","annotations"]`, and
  `warnings` explains every store that was not. `status` follows the same
  vocabulary as `analysis run`: `ok` (every requested store accepted the write,
  or `--no-persist` was passed), `partial` (some did, exit still `0`), or
  `failed` (none did — detection succeeded but the verb did not, so it exits
  `1`). Cut on shot boundaries instead of round numbers.
- **`analysis silence`** returns `regions[{startSec,endSec,durationSec}]`,
  `totalSilenceSec` and a boolean `persisted`. **Persistence contract:** results
  reach the shared analysis cache only at the default thresholds (`-40` dB,
  `0.5` s) *and* only when an audio profile already exists. Otherwise the run is
  output-only, returning `"persisted": false` with a `reason` of
  `"non-default threshold"`, `"non-default min-duration"`, or
  ``"no audio profile in bundle; run `analysis audio` first"``. The numbers are
  still correct — they just do not update the cache the GUI reads.
- **`analysis audio`** runs the full profiler (silence, loudness curve, peak,
  BPM, speech regions) and always persists into the bundle.
- **`analysis run`** drives the job runner with local-only providers.
  Transcript is off unless `--transcript` is passed, and fails fast with an
  `openreelio-cli transcription install` hint when no Whisper model is present.
  `--progress` streams `{"type":"progress","job","status","detail"}` NDJSON to
  stderr. Per-job failures appear in the `errors` object; the exit is non-zero
  only if every enabled sub-job failed.

Results land in the project's shared analysis bundle (`analysis report` reads it
back), so the desktop app sees whatever the CLI computed.

### Looking at frames

```bash
openreelio-cli frame extract --path ./demo --time 12.5 --out frame.png      # one still
openreelio-cli frame extract --path ./demo --times 2,8,14 --out ./stills/   # batch (dir)
openreelio-cli frame extract --path ./demo --asset <ASSET_ID> --source-time 3.0 --out src.png
openreelio-cli frame extract --path ./demo --grid 3x2 --between 0 30 --out sheet.jpg
```

- `--mode fast` (default) renders the topmost file-backed clip only: no
  effects, text or compositing. Cheap, and right for "what footage is here". It
  auto-falls back to composite, reporting `fellBackToComposite: true`, whenever
  fast mode cannot answer honestly: when there is no file-backed clip at that
  time (a title card, for example), and when the topmost clip carries a
  transform or a non-default opacity — the whole point of which is that the
  picture is no longer the source file. Checking your own `SetClipTransform`
  edit therefore shows the transform, at composite cost.
- `--mode composite` renders a minimal window through the full stack, so
  effects and overlays appear. Range renders decode from zero, so it costs more.
  It works anywhere inside the timeline, including over a gap — a gap has no
  picture, so a black frame is the correct answer, not an error.
- `--max-width` caps the output (1–3840 px, default 1280 px, aspect
  preserved, never upscaled).
- `--format png|jpeg` is optional: the format follows the `--out` extension, so
  `--out sheet.jpg` writes JPEG at exactly that path. Use `--format` for
  extensionless paths and `--times` directories (which default to PNG). A
  `--format` that contradicts a `.png`/`.jpg` extension is rejected rather than
  silently writing to a different file.
- `--grid COLSxROWS` with `--between START END [--count N]` (uniform sampling)
  or `--times a,b,c` (explicit list, kept in order) writes one contact sheet
  and returns `sheet.cells[{index,row,col,timelineSec}]`, which maps every cell
  a vision model comments on back to a timecode. Grids are capped at 100 cells,
  and the finished sheet at 8000 px on either edge — an oversized combination is
  rejected before the first cell is extracted, not after the whole grid.
- `--label-cells` burns each cell's **requested** index and timecode into the
  image (not the decoded frame's PTS); `--cell-width` / `--cell-height`
  (64–1024, default 320×180) size the cells — 640×360 is the floor for reading
  captions. Passing one dimension alone derives the other at 16:9, because
  cells are fitted with `force_original_aspect_ratio=decrease`: a 640×180 cell
  would only pad black around the same 320×180 picture. Grid cells are
  extracted at the cell width, so `--max-width` only matters as an oversampling
  override. All three flags require `--grid` and are rejected without it.
- `--file <RENDER>` extracts stills or sheets from a rendered video file
  instead of the timeline — times are in the file's timebase and cells map back
  as `fileSec`. It is the cheap way to inspect a render you just made, and it
  shows exactly the pixels `verify --file` measured. Times are validated against
  the **video stream's** end (`source.videoDurationSec`), not the container's,
  so a file whose audio outlasts its picture is rejected where the picture
  stops. A request FFmpeg produces no frame for is an error, never a silently
  stale image at `--out`.

Every timeline time must fall inside the sequence. Asking for one at or past
the end is rejected with the sequence's actual duration in the message, so widen
the edit or narrow `--between` rather than guessing.

Single and batch extraction return
`frames[{index,timeSec,sourceTimeSec,clipId,assetId,path,width,height}]`.
`sourceTimeSec`, `clipId` and `assetId` name the clip the pixels came from, so
they are absent on a composited frame — there is no single source clip behind a
title card or a gap. Treat them as optional.

### Draft renders

```bash
openreelio-cli render start --path ./demo --proxy --output proxy.mp4 \
  --start 0 --end 30 --progress
```

`--proxy` is an alias for the `proxy_480p` preset: 480p-class frame, CRF 30,
H.264 + AAC, `ultrafast`. The frame is **fitted to the sequence canvas**, not
fixed at 854x480: the short edge is capped at 480 px and the long edge at
854 px, aspect preserved, both edges even, and a canvas already inside that
budget is left alone. So 1920x1080 → 854x480, 1080x1920 → 480x854,
1080x1080 → 480x480, 1920x800 → 854x356, and 640x360 stays 640x360 — a
vertical edit is never pillarboxed into a landscape frame. Combine it with
`--start` / `--end` to render only the range under review. `--output` is required. `--progress` streams
`{"type":"progress","percent","frame","totalFrames","fps","etaSeconds","message"}`
to stderr. The result carries `outputPath`, `durationSec`, `fileSize`,
`encodingTimeSec`, `planHash` and `warnings`. `render presets` lists the
presets; `render graph` prints the render graph without encoding anything.

## 6. The verify loop

```bash
openreelio-cli verify --path ./demo                          # structural only
openreelio-cli verify --path ./demo --file ./proxy.mp4       # + rendered measurements
openreelio-cli verify --path ./demo --file ./proxy.mp4 \
  --target-lufs=-14 --max-true-peak=-1 --fail-on error
```

Without `--file`, only structural checks run and FFmpeg is never invoked.
`--structural-only` makes that explicit and conflicts with `--file`.

Twenty-three checks in two categories. **structural**: `sequence.empty`,
`timeline.gap`, `clip.orphan`, `clip.missing_asset`, `clip.aspect_ratio`,
`audio.silent_clip`, `caption.overlap`, `caption.reading_rate`,
`caption.out_of_bounds`, `caption.safe_area`, `shot.length_stats`,
`shot.cut_rhythm`, `transition.no_handles`, plus the opt-in `asset.license` and
`sequence.duration`.
**rendered**: `render.duration_mismatch`, `render.missing_video`,
`render.resolution_mismatch`, `render.black_frames`, `render.frozen`,
`audio.peak`, `audio.clipping`, `audio.loudness`. The two opt-ins run only when
named in `--checks`; narrow any run with `--checks a,b` or `--skip a,b`.

`render.duration_mismatch` asks the question the other rendered checks assume
an answer to: is the measured file this sequence at all? A stale or truncated
render measures perfectly well and is still not the deliverable, so a file
shorter than the render is an error. The comparison is against the length a
full-range render writes, not the editing extent: a clip the export drops —
disabled, or on a muted track — shortens the expected file with it, so a
correct render of a timeline ending on one still passes. The tolerance is
0.5s (or two frames, when that is longer) and does not scale with the running
time; `--duration-tolerance-sec` sets it explicitly and is honoured exactly.

`render.missing_video` asks the same kind of question about the picture. Every
other picture check reads a detection list, and a file with no video stream
produces empty lists — indistinguishable from a clean picture. A sequence that
puts anything on screen and rendered without a video stream is an error, and
`render.black_frames` / `render.frozen` report `skipped` rather than passing
over a file they cannot see.

`render.resolution_mismatch` compares the written frame against the canvas: a
different shape is an error (the composition was cropped or barred), the same
shape at a different size is info (a proxy or a delivery size), and a resampled
frame rate is a warning. `render.frozen` reports how much of the program never
moves — held frames and title cards are info, a program frozen for most of its
length is an error. `render.black_frames` grades the same way on the **total**
black in the program, so a render broken into several dark stretches cannot
pass by keeping each one short. `audio.clipping` reports the flat-topped
samples `astats` measures, at warning: a master limited on purpose reads the
same way.

The report always lists every check that ran, was skipped, or errored — so
"checked and clean" is distinguishable from "never looked". Each entry carries
`id`, `category`, `status`, `violationCount`, `timeRanges`, `metrics`,
`autoFixable` and, when the rule knows the repair, `suggestedFix`.
`measurements` holds the file-level numbers: `videoStream` (`width`, `height`,
`fps`, or `null` when the file has no picture), `blackRanges`, `freezeRanges`,
`silenceRanges`, `integratedLufs`, `loudnessRangeLu`, `truePeakDbtp`,
`samplePeakDb`, `flatFactor`.

Per-check `status` is `passed` (ran, found nothing), `warned` (ran, found only
warning/info issues), `failed` (ran, found error or critical), `skipped` or
`errored`; `checks[].passed` is true only for `passed`. The top-level
`status`/`passed` are the verdict and follow severity alone, so a report can be
`"passed": true` with `warned` checks inside it.

`--fail-on info|warning|error|critical` (default `error`) sets which severity
turns exit `0` into exit `1`. Taste-adjacent findings stay at warning/info;
`error` is reserved for objectively broken output.

Measured times are file-relative while structural findings are
timeline-relative, so `--file` expects a render of the whole sequence from zero.
A partial render still measures correctly, but its timestamps no longer line up.

### Feeding a fix back

`suggestedFix` is `{"description","confidence","steps":[…]}` and the steps are
already in plan shape. Wrap them in a plan envelope and execute:

```bash
openreelio-cli verify --path ./demo --file ./proxy.mp4 --fail-on warning > report.json
# take report.checks[].suggestedFix.steps → {"id":"fix_plan","steps":[…]} → fix.json
openreelio-cli plan validate --path ./demo --file fix.json
openreelio-cli plan execute  --path ./demo --file fix.json
openreelio-cli verify --path ./demo --file ./proxy.mp4 --fail-on warning
```

That is the whole loop: **analyze → edit → proxy render → look at frames →
verify → fix → verify again.**

### Best-of-N judging

When the brief has editorial freedom, converge-on-one-answer is not the only
strategy: apply candidate plans one at a time, render and score each, and keep
the best.

```bash
openreelio-cli state history --path ./demo                     # note currentIndex (baseline)
openreelio-cli plan execute  --path ./demo --file candidate-a.json
openreelio-cli render start  --path ./demo --proxy --output ./judge/a.mp4 --progress
openreelio-cli frame extract --path ./demo --file ./judge/a.mp4 \
  --grid 4x3 --between 0 <END> --label-cells --out ./judge/a-sheet.jpg
openreelio-cli verify        --path ./demo --file ./judge/a.mp4 > ./judge/a-verify.json
openreelio-cli state history --path ./demo                     # re-read: is the baseline still yours?
openreelio-cli state jump    --path ./demo --index <BASELINE>  # unwind, try the next
# …score every candidate, then re-apply the winner's plan JSON
```

Score against a fixed rubric with the deterministic signals first (`verify`,
`shot.length_stats`), then the sheet (hook, continuity, readability,
composition). Re-apply the winner from its plan file — a new edit after a jump
clears the redo branch. Re-read `state history` right before each rewind and
check the jump's `unwound` list afterwards: rendering and verifying take
minutes, and a baseline index recorded before another writer appended no longer
points where it did. The full rubric and judgement-file convention live in the
skill's `judging/REFERENCE.md`.

## 7. Captions and text

Captions are timed subtitle entries; text clips are styled overlays with
position, transform and effects. Both are ordinary commands in the op log.

```bash
openreelio-cli caption add    --path ./demo --text "Hello" --start 0.5 --end 3.0 [--style-pack <PACK_ID>]
openreelio-cli caption update --path ./demo --id <CAPTION_ID> --text "Updated" [--style-pack <PACK_ID>]
openreelio-cli caption list   --path ./demo
openreelio-cli caption remove --path ./demo --id <CAPTION_ID>
openreelio-cli caption import --path ./demo --file subs.srt [--format srt|vtt|transcript-json]
openreelio-cli caption export --path ./demo --format srt --output subs.srt

openreelio-cli text add       --path ./demo --text "Title" --start 0 [--duration 3] [--preset <PRESET_ID>]
openreelio-cli text update    --path ./demo --id <CLIP_ID> --text "New"
openreelio-cli text transform --path ./demo --id <CLIP_ID> --x 0.38 --y 0.42 --scale-x 1.2
openreelio-cli text list      --path ./demo
openreelio-cli text remove    --path ./demo --id <CLIP_ID>
```

### Caption style packs

Packs are the quality floor — reach for free-form styling only when a pack
cannot express the brief. Each pairs typography with an anchor and is verified to
draw zero `caption.safe_area` violations on both 1920x1080 and 1080x1920 — the
same check `verify` runs, measuring the text block against each canvas rather
than only comparing margins.

```bash
openreelio-cli packs list --kind caption
```

`standard-outline` (the default), `clean-minimal`, `boxed-contrast`,
`yellow-classic`, `shorts-bold-outline`, `broadcast-lower`,
`high-contrast-accessible`, `caption-top`.

A pack is a base layer, not a lock: `--style-json` / `--position` override it key
by key, so `--style-pack boxed-contrast --style-json '{"fontSize":96}'` is the
boxed pack at 96pt. `--position top|center|bottom` names a vertical anchor only,
so it keeps the pack's checked margin rather than replacing it. The same field is
`stylePack` on `CreateCaption`, `UpdateCaption`, and `ImportGeneratedCaptions`,
so `command execute` and MCP clients get it for free. An unknown id is rejected
with the full valid list.

On an **update** a pack restyles without moving the caption: `caption update
--style-pack …` keeps the anchor the caption already has, because an update
replaces whatever position it carries. Pass `--position` when you do want it
moved.

### Text presets

`--preset` is the same idea for text overlays: one id supplies typography,
anchor, starter copy, and a suggested duration (used when `--duration` is
omitted).

```bash
openreelio-cli packs list --kind text
```

One registry serves the CLI, MCP, the agent tools, and the app, so the ids the
hints advertise are exactly the ids the parser accepts — `quote`, `watermark`,
`countdown`, `label`, `tech-style`, `callout-warning`, `subtitle-outline`,
`end-card-title`, and `lower-third-minimal` used to be advertised and rejected,
and now work. Entries print `category` (`lower-third`, `title`, `subtitle`,
`callout`, `credit`, `brand`, `creative`), `defaultDurationSec`, aliases, and
the full `clip`.

A preset is a base layer, not a lock: explicit flags override it, so
`--preset quote --font-size 96` is the quote preset at 96pt. The same field is
`preset` on `AddTextClip`, so `command execute`, `plan execute`, and MCP clients
get it too, and `textData` there carries only the overrides (commonly just
`content`) or may be omitted entirely. Nested layers merge key by key, so
`{"style":{"bold":false}}` un-bolds a bold preset and leaves everything else
alone. The op log records the concrete values, never the preset id, so replay
never depends on the catalog. An unknown id is rejected with the full valid
list; `default` means no preset.

**Changed geometry.** Unifying on the app's catalog changed what three
already-shipped spellings produce. Existing projects replay unchanged, because
the op log stores concrete values — only new runs of a script that names one of
these is affected:

| Id | Was | Now |
|----|-----|-----|
| `title` (alias of `centered-title`) | upper third, y=0.15, 72pt bold | frame center, y=0.5, 72pt bold with wider letter spacing |
| `lower-third` | centered (0.5, 0.80), 36pt, regular, no shadow | left-aligned (0.08, 0.82), 42pt, bold, with shadow |
| `subtitle` | y=0.85 with a thin outline, background `#000000AA` | y=0.9, no outline, background `#00000099` |

No id reproduces the old layouts, so re-anchor with flags where the previous
placement mattered:

```bash
# the old upper-third title
openreelio-cli text add --path ./demo --text "Chapter One" --start 0 --preset title --y 0.15
# the old centered lower third
openreelio-cli text add --path ./demo --text "Name" --start 0 --preset lower-third \
  --x 0.5 --y 0.8 --align center --font-size 36 --style-json '{"bold":false}'
# the old outlined subtitle
openreelio-cli text add --path ./demo --text "Line" --start 0 --preset subtitle --y 0.85 \
  --background-color "#000000AA" --outline-json '{"color":"#000000","width":1}'
```

Preset ids are append-only from here — see the stability note in
`src-tauri/src/core/style/text_presets.rs`, which a contract test now enforces
for these three.

### How text is burned in

Both captions and text clips reach the render through libass, which decides five
things you cannot see until you inspect the output file.

- **Only preset caption positions wrap.** A caption at a preset position wraps
  inside a box 10% clear of each canvas edge. A caption at a `custom` position
  and *every* text clip are placed exactly, and break only where they meet the
  frame edge — long text runs nearly the full width rather than re-flowing.
  Prefer a preset caption whenever the text length is not under your control:
  generated or transcribed captions especially.
- **A preset margin is a gap to the block's near edge.** "10% from the bottom"
  puts the bottom of the last line a tenth of the frame above the bottom edge,
  and extra wrapped lines grow *upward*, toward the middle. The margin you ask
  for is the margin you get, however tall the block turns out to be. A custom
  position is the opposite: it marks the block's centre, so a tall caption
  overruns it in both directions.
- **`fontSize` is resolution-independent.** It means pixels at 1080p; the script
  is authored 1080 tall with the canvas aspect regardless of export resolution,
  so a project looks the same at 1080p and 4K. This changed: exports used to
  author the script at the output size, which made the same `fontSize` render
  smaller relative to the frame the larger the export got, and disagree with the
  preview on any canvas that was not 1080 tall. A pre-existing project whose
  canvas is not 1080 tall will burn text at a different size than it did before
  — the new size is the one the preview has always shown.
- **`lineHeight` is dropped.** ASS has no line-spacing control, so libass spaces
  lines from the font's own metrics. A clip whose `lineHeight` deviates from the
  1.2 default is reported as a render warning. Only the `drawtext` fallback,
  which an export takes when FFmpeg has no `subtitles` filter, honors it.
- **Eight font families ship with the binary** and are embedded into the script,
  so they burn identically on a machine that has never installed them:
  `TikTok Sans`, `Montserrat`, `Anton`, `Archivo Black`, `Bebas Neue`,
  `Poppins`, `Bangers`, `Luckiest Guy`. Any other family is resolved against the
  host's installed fonts, and is only as reproducible as that host. A family
  found in neither is replaced with `TikTok Sans` — itself bundled, so the
  fallback is deterministic too — and reported rather than silently substituted.

Render warnings come back from `render start` and from export validation, so an
agent can read them before shipping the file.

Speech-to-text is local (Whisper); `--import` writes the result straight into a
caption track.

```bash
openreelio-cli transcription status
openreelio-cli transcription install --model large-v3-turbo-q5_0
openreelio-cli transcription generate --path ./demo --asset <ASSET_ID> --import
openreelio-cli transcription generate-sequence --path ./demo --import
```

**Caption cue boundaries come from DTW-aligned word timings.** Instead of
Whisper's cheap heuristic token timestamps, whisper.cpp aligns tokens by dynamic
time warping over the decoder's cross-attention. Those word timings decide where
each caption cue starts and ends, including the leading and trailing edge of a
cue that needed no splitting.

The scope is exactly that — caption cues. The transcript editor and the
analysis/annotation word surfaces (`analysis run`, transcript word lists) still
derive word times by dividing a segment's duration equally among its words. Do
not read a word offset from those surfaces and expect DTW accuracy.

Which models get it:

- `tiny`, `base`, `small`, `medium`, `large-v3`, `large-v3-turbo` and their
  quantized variants (`-q5_0`, `-q8_0`) map to an alignment-head preset.
- Any file OpenReelio does not recognize by name — a third-party or hand-renamed
  `.bin` — is run without DTW. This is the common skip, not `large`.
- `large` (`ggml-large.bin`) is deliberately excluded: the plain filename has
  pointed at v1 and v2 upstream, so the version cannot be inferred and a wrong
  alignment-head preset would misalign silently.
- The filename is an identity claim, not a checksum. `large-v2` weights renamed
  to `ggml-large-v3.bin` have the same head counts, pass the bounds check, and
  align against the wrong heads without any error.
- Note that "best installed model" ranks `large` above `medium` on transcription
  accuracy, even though `medium` gets DTW timings and `large` does not.

Failure is never fatal. The alignment heads are validated when whisper.cpp
creates its first state, not when the weights load, so the engine probes for that
at startup and rebuilds the context without DTW if the probe fails — you get a
warning in the log and heuristic timings, never a failed transcription. Flash
attention stays off globally because enabling it disables DTW in whisper.cpp.

A deterministic repair pass then runs — **on every transcription, DTW or not.**
DTW improves the input it repairs; it does not replace it. The pass:

- recovers the first word's start from the audio. DTW stamps a token where the
  alignment path *leaves* it, so a token's start is the previous token's stamp
  and the first token has none; Whisper's fallback estimate for it is just the
  segment start, which is silence whenever the segment opens before anyone
  speaks. That start is taken from the first short-time-energy onset instead;
- keeps word starts ordered, non-overlapping and inside their segment;
- grows collapsed words back toward at least 40 ms where the surrounding audio
  allows — a dense run with no room to give is spread evenly and stays under
  40 ms;
- releases a word that would otherwise stretch across a pause after at most
  350 ms per syllable-ish unit, except the segment's last word, whose end
  anchors the tail cue;
- snaps each start to the nearest energy onset within 80 ms when that neither
  reorders words nor starves a neighbour.

Accuracy is indicative, not contractual. On English and Korean test clips
(`small` and `large-v3-turbo`, speech preceded by silence) the leading cue edge
landed on the hand-measured speech onset to within the 10 ms analysis hop.
That is clean speech with a clear attack; noisy or overlapping dialogue will do
worse. Verify anything you are going to cut against.

## 8. Interchange: OpenTimelineIO

`otio export` writes [OpenTimelineIO](https://opentimeline.io/), the Academy
Software Foundation's editorial interchange format; `otio import` reads one back
into a sequence. DaVinci Resolve imports OTIO natively on the free tier, which
makes this the "assemble headless here, finish there" path.

```bash
openreelio-cli otio export --path ./demo --out cut.otio [--sequence <SEQUENCE_ID>]
openreelio-cli otio import --path ./demo --file cut.otio [--sequence <SEQUENCE_ID>] \
  [--dry-run] [--allow-external-media]
```

### It is a cut interchange, and it says what it drops

**Survives:** video and audio tracks · clips, with their media file and source
in-point · gaps · two-input transitions (cross dissolve, wipe, slide) · sequence
markers.

**Does not survive:** effects and colour grading · transforms, motion keyframes,
opacity, blend modes · caption tracks and text clips · clip audio settings
(levels, pan, fades) · speed, reverse, freeze frames, time remapping · compound
clips and adjustment layers.

Neither verb drops any of that quietly. Both print `warnings` (structural changes
— skipped tracks, offline media, trimmed overlaps) and `unsupported` (editorial
detail that could not cross), and both arrays are always present, so a caller can
tell "checked and clean" from "not reported".

```json
{
  "status": "ok",
  "output": "/abs/path/cut.otio",
  "trackCount": 2,
  "clipCount": 4,
  "warnings": ["clip 'c7' is disabled and was exported as a gap"],
  "unsupported": [
    "caption track 'Subtitles' was not exported: OTIO has no caption track kind…",
    "3 clip(s) carry effects that were dropped: c1, c2, c5"
  ]
}
```

### What the export does to keep the cut exact

Every boundary is computed in frames at the sequence rate and only converted to
seconds at the edges, so a long timeline does not accumulate drift.

- **Gaps are explicit.** An OTIO track is a contiguous child list, so every hole
  becomes a `Gap`, including one standing in for a clip OTIO cannot carry at the
  end of a track — a track keeps its length. Nothing else is written after the
  last shot, and OTIO permits tracks of different lengths.
- **A speed-changed clip keeps its slot, not its speed.** It is written occupying
  the same timeline span from the same source in-point, so every later cut stays
  on its frame, and it plays unmodified in the importing tool. The clip is named
  in `unsupported`. (This is also the OTIO-correct shape: a speed change is a
  separate `LinearTimeWarp` effect that scales the media read without changing
  `source_range.duration`.)
- **Caption, text, compound and adjustment clips become gaps**, so the shots
  around them do not slide.
- **A wipe or slide exports as `"Custom"`** — OTIO only standardises a dissolve —
  with the real type and direction preserved under `metadata.openreelio`.
- **A transition that does not fit is dropped and named** in `warnings`. It has
  to fit inside the shot on each side of the cut: an 8s dissolve in front of a
  quarter-second shot cannot be written as valid OTIO.

### Importing

An import builds an edit plan and runs it through the same machinery as
`plan execute`: one atomic, undoable unit that rolls back on failure, with the
same exit codes — `0` applied and saved, `1` rejected or rolled back cleanly,
`2` tool failure or an incomplete rollback.

Dry-run first on any file you did not write. `--dry-run` prints the plan, its
warnings and the media it would import, and stops without touching the project —
it does not even open an editing session, so nothing under the project directory
changes.

Media resolves in order: the asset id in `metadata.openreelio` (our own files),
then the file path, then the file name. Anything still unmatched becomes an
`ImportAsset` step and appears in `assetImports`.

**Media is scoped to the project.** An `.otio` chooses its own media paths, and
importing one makes OpenReelio stat — and sometimes ffprobe — whatever it names,
so a file you did not write is a filesystem probe aimed at your machine. Media
that matches no existing asset is only imported from inside the project
directory; `--allow-external-media` lifts that for a file you trust. Media the
project already holds resolves wherever it lives.

Times are converted through each node's own rate, never the sequence rate, so a
file that mixes rates imports correctly — and every timeline position is then
snapped to the target sequence's frame grid, with any rate difference reported in
`unsupported`. A cut may move by up to half a frame; the alternative is sub-frame
holes between shots that no later edit can see.

**Refused outright:** an `OTIO_SCHEMA` version this build does not read, or a
node missing that field entirely (the error names it) · image-sequence
references · a file over 64 MiB · a file needing more plan steps than the cap
allows, since chunking it would give up atomicity · media on a network / UNC path
in any spelling (`\\host\share`, `/\host\share`, `file://host/share`,
percent-encoded separators), which would open an outbound connection the file's
author chose and leak an NTLM handshake on Windows · media outside the project
directory without `--allow-external-media` · a `metadata.openreelio`
`transitionType` that is not a two-input blend, so an untrusted file cannot add
an arbitrary effect through a cut verb · a clip or marker whose time is
unreadable, infinite or negative.

**Reported but not fatal:** nested stacks, non-editorial track kinds, offline
clips, asymmetric transitions (OpenReelio stores one duration, so the blend is
re-centred on the cut), transitions whose handles cannot be verified, a
transition beside a clip that was skipped (omitted rather than moved onto a cut
the file never named), track markers (they become sequence markers), clip markers
(OpenReelio has none), and the speed / reverse / freeze / time-remap detail an
export recorded that the import does not restore. Handle checking mirrors the
render engine's own test — see
[Transitions and when they render](#transitions-and-when-they-render) — so an
import tells you up front which cuts the renderer would later refuse to blend.

### The `metadata.openreelio` namespace

Exports stash detail the standard schema cannot carry — exact track kind,
original ids, mute state, the real transition type behind a `"Custom"` and its
direction, a marker's exact colour, a clip's speed / reverse / freeze /
time-remap flags — under `metadata.openreelio` on the relevant node. Foreign
tools ignore it and see ordinary OTIO; our own import reads it to restore what it
can. It never changes where a clip sits.

Import restores the asset id and the transition's type and direction from it. The
speed flags it only *reports*: each is named in `unsupported` and the clip is
placed at unmodified speed, because the namespace records what the timeline was,
not what the import rebuilt.

### Verifying a Resolve round trip

CI cannot run Resolve, so this is a manual check. Export, then in Resolve use
**File → Import → Timeline → Import AAF, EDL, XML…** and pick the `.otio` file.
Confirm the track count, that each cut lands on the frame the export named, that
media links resolve, and that any dissolve sits on the boundary it was reported
on. Anything in `unsupported` will be missing — that is the format, not a bug.

## 9. MCP server

The same binary is an MCP server over stdio. `--stdio` is required to actually
serve; without it the command prints the tool list, resources and policy as JSON
so you can inspect the surface first.

```bash
openreelio-cli mcp --project ./demo             # prints the discovery payload
openreelio-cli mcp --stdio --project ./demo     # serves JSON-RPC on stdio
openreelio-cli mcp --stdio --project ./demo --allow-write
```

**Read-only by default.** Fifteen tools are advertised: `host.context`,
`project.info`, `selection.read`, `diagnostics.read`, `timeline.snapshot`,
`assets.list`, `annotation.read`, `command.schema`, `command.validate`,
`plan.validate`, `preview.describe`, `frame.extract`, `transcription.status`,
`transcription.generate` and `verify` — each prefixed `openreelio.`.

**`--allow-write` is a local-trust switch.** It adds `openreelio.media.insert`
and `openreelio.plan.apply` and drops the per-call approval token those tools
otherwise require; the policy block then reports `"mode": "allow-write-local"`
and `"filesystemAccess": "project-write"`. Every mutation still goes through the
command log and stays undoable, but use it only with a locally trusted client.
The three policy modes are `read-only` (the default, `"filesystemAccess":
"project-readonly"`), `approve-mutations` (an approval token is active), and
`allow-write-local`; without `--project` the access is `"none"`.
Without the flag, a host can still authorize a single call by supplying
`OPENREELIO_MCP_APPROVAL_TOKEN` — an empty value is not a grant, and a token
scoped with `OPENREELIO_MCP_APPROVAL_PROJECT_ID` or
`OPENREELIO_MCP_APPROVAL_PLAN_ID` is rejected outside that scope. Discovery and
`host.context` report the same policy object, so the two can never disagree.

`filesystemAccess` describes the project — its state and command log — not every
byte under the directory. `frame.extract` writes the images it returns into
`.openreelio/cache/frames/` even on a read-only server, so the policy discloses
that separately as `"cacheWrites": "frame-extract"`. That cache is derived data
and safe to delete; it bounds itself to its 16 newest entries, and an extraction
that fails removes the entry it created.

**The project directory is the whole filesystem scope.** Every path a client
sends resolves inside it: a relative path is joined onto the project root, and
absolute paths outside it, `..` escapes, UNC/network paths, and URLs are
rejected before they reach the filesystem or FFmpeg.

**`openreelio.verify`** is read-only-safe and always advertised. It accepts
`{sequenceId?, file?, structuralOnly?, checks?[], skip?[], failOn?}` and returns
the same report document the CLI prints — so an MCP client gets the fix loop
without shelling out. `file` must be inside the project directory, so render
into the project before verifying.

**`openreelio.frame.extract`** is the judge loop over MCP: it answers with the
picture itself, as an MCP `image` content block, so a vision model can look at
the edit without a Bash or file-reading tool. It accepts
`{time?, times?[], grid?, between?[start,end], file?, sequenceId?, mode?,
cellWidth?, cellHeight?, labelCells?, maxWidth?}` — the same selectors as
[`frame extract`](#5-the-perception-loop).

```jsonc
// tools/call → openreelio.frame.extract
{ "file": "render.mp4", "grid": "4x3", "between": [0, 90], "labelCells": true }
```

The reply is one `image` block per still — or exactly one for a contact sheet,
however many cells it holds — followed by the usual `text` block carrying the
CLI's JSON, including `sheet.cells[]` mapping every cell back to a timecode.
Notes that matter:

- **The caller never picks an output path.** Images are written into
  `.openreelio/cache/frames/<timestamp>/` and the written path is reported.
- **`file` is confined to the project directory**, like `verify`'s — render into
  the project before judging it.
- **Responses are bounded in cells _and_ in pixels**: a grid holds at most 100
  cells, `times` at most 12 stills, `cellWidth`/`cellHeight` are 64–1024 px, a
  finished sheet is at most 8000 px on either edge, and `maxWidth` is at most
  3840 px. Anything past those is an argument error raised before a single frame
  is extracted. Ask for a sheet rather than a long batch; it costs one image.
- Images come back as JPEG. Every other tool's reply is unchanged — a lone
  `text` block.

## 10. Environment variables

| Variable                        | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `OPENREELIO_CLI_BINARY`         | Absolute path to a CLI binary; bypasses npm package lookup   |
| `OPENREELIO_FFMPEG_PATH`        | Explicit FFmpeg binary (highest precedence)                  |
| `OPENREELIO_FFPROBE_PATH`       | Explicit FFprobe binary                                      |
| `OPENREELIO_MCP_APPROVAL_TOKEN` | Host-issued single-call write approval for the MCP server    |

## 11. See also

- [`AGENT_PERCEPTION_CLI_PLAN.md`](./AGENT_PERCEPTION_CLI_PLAN.md) — design
  rationale and accepted deviations for the perception and verify surfaces
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture
- [`COMMAND_REFERENCE.md`](./COMMAND_REFERENCE.md) — backend edit commands
- [`API_SPEC.md`](./API_SPEC.md) — IPC/API specifications
