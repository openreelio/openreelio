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
errors. Write `--target-lufs=-14` and `--max-true-peak=-1`.
(`analysis silence --threshold-db -40` is the one option that accepts the
spaced form.)

### Discovering the surface

`help-json` prints the whole command schema, but it is ~58 KB — do not preload
it into a context window. Fetch help per verb instead
(`openreelio-cli verify --help`, `openreelio-cli frame extract --help`), and use
`openreelio-cli command schema` for the 79 backend command types.

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
  auto-falls back to composite when there is no such clip (a title card, for
  example) and reports `fellBackToComposite: true`.
- `--mode composite` renders a minimal window through the full stack, so
  effects and overlays appear. Range renders decode from zero, so it costs more.
  It works anywhere inside the timeline, including over a gap — a gap has no
  picture, so a black frame is the correct answer, not an error.
- `--max-width` caps the output (default 1280 px, aspect preserved, never
  upscaled).
- `--format png|jpeg` is optional: the format follows the `--out` extension, so
  `--out sheet.jpg` writes JPEG at exactly that path. Use `--format` for
  extensionless paths and `--times` directories (which default to PNG). A
  `--format` that contradicts a `.png`/`.jpg` extension is rejected rather than
  silently writing to a different file.
- `--grid COLSxROWS` with `--between START END [--count N]` (uniform sampling)
  or `--times a,b,c` (explicit list, kept in order) writes one contact sheet
  and returns `sheet.cells[{index,row,col,timelineSec}]`, which maps every cell
  a vision model comments on back to a timecode. Grids are capped at 100 cells.
- `--label-cells` burns each cell's index and timecode into the image;
  `--cell-width` / `--cell-height` (64–1024, default 320×180) size the cells —
  640-wide is the floor for reading captions. Grid cells are extracted at the
  cell width, so `--max-width` only matters as an oversampling override.
- `--file <RENDER>` extracts stills or sheets from a rendered video file
  instead of the timeline — times are in the file's timebase and cells map back
  as `fileSec`. It is the cheap way to inspect a render you just made, and it
  shows exactly the pixels `verify --file` measured.

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

Twenty-two checks in two categories. **structural**: `sequence.empty`,
`timeline.gap`, `clip.orphan`, `clip.missing_asset`, `clip.aspect_ratio`,
`audio.silent_clip`, `caption.overlap`, `caption.reading_rate`,
`caption.out_of_bounds`, `caption.safe_area`, `shot.length_stats`,
`shot.cut_rhythm`, plus the opt-in `asset.license` and `sequence.duration`.
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
openreelio-cli state jump    --path ./demo --index <BASELINE>  # unwind, try the next
# …score every candidate, then re-apply the winner's plan JSON
```

Score against a fixed rubric with the deterministic signals first (`verify`,
`shot.length_stats`), then the sheet (hook, continuity, readability,
composition). Re-apply the winner from its plan file — a new edit after a jump
clears the redo branch. The full rubric and judgement-file convention live in
the skill's `judging/REFERENCE.md`.

## 7. Captions and text

Captions are timed subtitle entries; text clips are styled overlays with
position, transform and effects. Both are ordinary commands in the op log.

```bash
openreelio-cli caption add    --path ./demo --text "Hello" --start 0.5 --end 3.0
openreelio-cli caption update --path ./demo --id <CAPTION_ID> --text "Updated"
openreelio-cli caption list   --path ./demo
openreelio-cli caption remove --path ./demo --id <CAPTION_ID>
openreelio-cli caption import --path ./demo --file subs.srt [--format srt|vtt|transcript-json]
openreelio-cli caption export --path ./demo --format srt --output subs.srt

openreelio-cli text add       --path ./demo --text "Title" --start 0 --duration 3 [--preset credits]
openreelio-cli text update    --path ./demo --id <CLIP_ID> --text "New"
openreelio-cli text transform --path ./demo --id <CLIP_ID> --x 0.38 --y 0.42 --scale-x 1.2
openreelio-cli text list      --path ./demo
openreelio-cli text remove    --path ./demo --id <CLIP_ID>
```

Speech-to-text is local (Whisper); `--import` writes the result straight into a
caption track.

```bash
openreelio-cli transcription status
openreelio-cli transcription install --model large-v3-turbo
openreelio-cli transcription generate --path ./demo --asset <ASSET_ID> --import
openreelio-cli transcription generate-sequence --path ./demo --import
```

## 8. MCP server

The same binary is an MCP server over stdio. `--stdio` is required to actually
serve; without it the command prints the tool list, resources and policy as JSON
so you can inspect the surface first.

```bash
openreelio-cli mcp --project ./demo             # prints the discovery payload
openreelio-cli mcp --stdio --project ./demo     # serves JSON-RPC on stdio
openreelio-cli mcp --stdio --project ./demo --allow-write
```

**Read-only by default.** Fourteen tools are advertised: `host.context`,
`project.info`, `selection.read`, `diagnostics.read`, `timeline.snapshot`,
`assets.list`, `annotation.read`, `command.schema`, `command.validate`,
`plan.validate`, `preview.describe`, `transcription.status`,
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

**The project directory is the whole filesystem scope.** Every path a client
sends resolves inside it: a relative path is joined onto the project root, and
absolute paths outside it, `..` escapes, UNC/network paths, and URLs are
rejected before they reach the filesystem or FFmpeg.

**`openreelio.verify`** is read-only-safe and always advertised. It accepts
`{sequenceId?, file?, structuralOnly?, checks?[], skip?[], failOn?}` and returns
the same report document the CLI prints — so an MCP client gets the fix loop
without shelling out. `file` must be inside the project directory, so render
into the project before verifying.

## 9. Environment variables

| Variable                        | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `OPENREELIO_CLI_BINARY`         | Absolute path to a CLI binary; bypasses npm package lookup   |
| `OPENREELIO_FFMPEG_PATH`        | Explicit FFmpeg binary (highest precedence)                  |
| `OPENREELIO_FFPROBE_PATH`       | Explicit FFprobe binary                                      |
| `OPENREELIO_MCP_APPROVAL_TOKEN` | Host-issued single-call write approval for the MCP server    |

## 10. See also

- [`AGENT_PERCEPTION_CLI_PLAN.md`](./AGENT_PERCEPTION_CLI_PLAN.md) — design
  rationale and accepted deviations for the perception and verify surfaces
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture
- [`COMMAND_REFERENCE.md`](./COMMAND_REFERENCE.md) — backend edit commands
- [`API_SPEC.md`](./API_SPEC.md) — IPC/API specifications
