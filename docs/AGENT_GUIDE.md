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
Steps run in dependency order and the whole plan rolls back if any step fails.
`plan execute` returns `{"status","planId","stepsExecuted","stepResults":[…]}`.

```bash
openreelio-cli plan template --template-type split-and-move   # note: --template-type
openreelio-cli plan validate --path ./demo --file plan.json
openreelio-cli plan execute  --path ./demo --file plan.json
```

### Undo and history

`timeline undo` / `timeline redo` walk the op log. `state ops --last N` shows
recent operations, `state dump` the full derived state, `state snapshot` forces
a snapshot write.

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
  array naming the stores written: `["indexDb","bundle","annotations"]`. Cut on
  shot boundaries instead of round numbers.
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
- `--max-width` caps the output (default 1280 px, aspect preserved, never
  upscaled); `--format png|jpeg`.
- `--grid COLSxROWS --between START END [--count N]` writes one contact sheet
  and returns `sheet.cells[{index,row,col,timelineSec}]`, which maps every cell
  a vision model comments on back to a timecode. Grids are capped at 100 cells.

Single and batch extraction return
`frames[{index,timeSec,sourceTimeSec,clipId,assetId,path,width,height}]`.

### Draft renders

```bash
openreelio-cli render start --path ./demo --proxy --output proxy.mp4 \
  --start 0 --end 30 --progress
```

`--proxy` is an alias for the `proxy_480p` preset: 854x480, CRF 30, H.264 +
AAC, `ultrafast`. Combine it with `--start` / `--end` to render only the range
under review. `--output` is required. `--progress` streams
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

Eighteen checks in two categories. **structural**: `sequence.empty`,
`timeline.gap`, `clip.orphan`, `clip.missing_asset`, `clip.aspect_ratio`,
`audio.silent_clip`, `caption.overlap`, `caption.reading_rate`,
`caption.out_of_bounds`, `caption.safe_area`, `shot.length_stats`,
`shot.cut_rhythm`, plus the opt-in `asset.license` and `sequence.duration`.
**rendered**: `render.duration_mismatch`, `render.black_frames`, `audio.peak`,
`audio.loudness`. The two opt-ins run only when named in `--checks`; narrow any
run with `--checks a,b` or `--skip a,b`.

`render.duration_mismatch` asks the question the other rendered checks assume
an answer to: is the measured file this sequence at all? A stale or truncated
render measures perfectly well and is still not the deliverable, so a file
shorter than the timeline is an error.

The report always lists every check that ran, was skipped, or errored — so
"checked and clean" is distinguishable from "never looked". Each entry carries
`id`, `category`, `status`, `violationCount`, `timeRanges`, `metrics`,
`autoFixable` and, when the rule knows the repair, `suggestedFix`.
`measurements` holds the file-level numbers: `blackRanges`, `freezeRanges`,
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
otherwise require; the policy block then reports `"mode": "read-write-local"`.
Every mutation still goes through the command log and stays undoable, but use it
only with a locally trusted client. Without the flag, a host can still authorize
a single call by supplying `OPENREELIO_MCP_APPROVAL_TOKEN`.

**`openreelio.verify`** is read-only-safe and always advertised. It accepts
`{sequenceId?, file?, structuralOnly?, checks?[], skip?[], failOn?}` and returns
the same report document the CLI prints — so an MCP client gets the fix loop
without shelling out.

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
