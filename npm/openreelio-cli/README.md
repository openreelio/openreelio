<!-- mcp-name: io.github.openreelio/openreelio -->

# openreelio-cli

Headless, agent-native video editing. `openreelio-cli` gives an AI agent (or a
script) a real non-linear editor over the command line: an event-sourced
timeline, media analysis, captions, deterministic QC and rendering — instead of
hand-assembling `ffmpeg` filtergraphs and hoping the result is watchable.

Every command prints a single JSON object on stdout. Progress and diagnostics go
to stderr. Every edit is a command appended to an append-only op log, so the
whole session is inspectable, undoable and replayable.

## Install

```bash
npm install -g openreelio-cli
# or, without installing:
npx openreelio-cli --help
```

npm downloads this package and the one platform package matching your `os`/`cpu`;
no install script downloads the binary. It ships as content of that
platform-specific optional dependency, so installs also work with lifecycle
scripts disabled (`--ignore-scripts`).

| Platform          | Package                        | Release target             |
| ----------------- | ------------------------------ | -------------------------- |
| Windows x64       | `@openreelio/cli-win32-x64`    | `x86_64-pc-windows-msvc`   |
| macOS Intel       | `@openreelio/cli-darwin-x64`   | `x86_64-apple-darwin`      |
| macOS Apple Sili. | `@openreelio/cli-darwin-arm64` | `aarch64-apple-darwin`     |
| Linux x64 (glibc) | `@openreelio/cli-linux-x64`    | `x86_64-unknown-linux-gnu` |

Linux builds are glibc only; there is no musl variant yet. On any unlisted
platform, download a standalone archive from the
[releases page](https://github.com/openreelio/openreelio/releases) and set
`OPENREELIO_CLI_BINARY` to its path — the launcher will use it verbatim.

FFmpeg and FFprobe are resolved at runtime (bundled, managed, or from `PATH`).
Run `openreelio-cli ffmpeg info` to see exactly which binaries were picked and
where they came from.

## Quickstart

Every ID is a ULID the CLI hands back — there are no guessable `asset_001`
names. Read them out of the JSON each command prints, or capture them as you go.
Every command below is copy-pasteable; `pick` reads a field out of the JSON on
stdin using the Node you already have from npm:

```bash
pick() { node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8'))$1"; }

# 1. Create a project and import media
#    The sequence defaults to 30fps 1920x1080; --fps/--width/--height create it
#    in the delivery format instead (or change it later with timeline set-format).
openreelio-cli project create --name "Demo" --path ./demo [--fps 25 --width 1080 --height 1920]
openreelio-cli asset import --path ./demo --file ./footage.mp4
# -> {"status":"ok","createdIds":["01KZW64VJ4JPBS5B9YZEA335J8"],...}

ASSET=$(openreelio-cli asset list --path ./demo | pick '.assets[0].id')
TRACK=$(openreelio-cli timeline tracks --path ./demo \
  | pick '.tracks.find(t => t.kind === "Video").id')

# 2. Look before you cut: shots, silence, loudness
openreelio-cli analysis run --path ./demo --id "$ASSET" --progress

# 3. Edit through commands (append-only, undoable)
openreelio-cli timeline insert --path ./demo --asset "$ASSET" --track "$TRACK" --at 0.0
CLIP=$(openreelio-cli timeline clips --path ./demo | pick '.clips[0].id')
openreelio-cli timeline split --path ./demo --clip "$CLIP" --track "$TRACK" --at 5.0
openreelio-cli timeline undo  --path ./demo

# 4. See the result, not just the JSON
#    Contact-sheet times must land inside the sequence, so read its end first.
#    `timeline info` reports it directly, along with fps, editPoints (cut times),
#    markers and transition spans - no reducing over the clip list.
END=$(openreelio-cli timeline info --path ./demo | pick '.durationSec')
openreelio-cli frame extract --path ./demo --grid 3x2 --between 0 "$END" --out ./frames/sheet.jpg
openreelio-cli render start --path ./demo --proxy --output ./out/proxy.mp4 --progress

# 5. Prove it is deliverable
openreelio-cli verify --path ./demo --file ./out/proxy.mp4
```

Clip-scoped verbs (`split`, `trim`, `move`, `speed`, `remove`) all need
`--track` as well as `--clip`; `timeline clips` prints both.

`asset import` records no probed duration, so every clip `timeline insert` places
is 10 seconds long regardless of the file — and a second insert at 4.0s is
refused as an overlap. Read the real length from `analysis shots`
(`totalDurationSec`) and `timeline trim --clip <CLIP> --track <TRACK>
--source-in 0 --source-out <DURATION>` before building on it.

`timeline set-format --fps 25 --width 1080 --height 1920` changes the sequence's
frame rate, canvas and audio format at any time, as a logged and undoable edit. A
decimal `--fps` snaps to the exact broadcast rational (`29.97` → `30000/1001`).
Changing the frame rate re-times nothing (the timeline is stored in seconds), and
changing the canvas leaves clip transforms alone (they are canvas-relative).

Every mutating verb reports where the edit landed. `command execute` and
`plan execute` return `affectedRanges` - a sorted `[{startSec, endSec}]` list
covering everything that moved, ripple shifts included - so the sheet or partial
render that checks the result can be aimed at those seconds instead of the whole
timeline. Hand them straight back, one `--range` per entry:

```bash
openreelio-cli plan execute  --path ./demo --file cut.json   # -> affectedRanges
openreelio-cli frame extract --path ./demo --range 4 9.5 --range 21 24.5 \
  --grid auto --out ./look.jpg
```

The last successful apply's union is also written to
`<project>/.openreelio/cache/agent/last_affected_ranges.json`, which
`frame extract --affected` reads - the shortcut for when you did not keep the
verb's result. That file is a shared slot the app's own interactive edits write
too, so an interactive edit made after yours is what you would look at; pin it
with `--after-op <OP_ID>`, which refuses a record that does not end at your
operation.

`verify --file` expects a render of the whole sequence, which is why step 4
renders without `--start`/`--end`. Add them when you only want to eyeball a
range you just changed.

`verify` exits `0` when checks pass, `1` when a `--fail-on` threshold is
breached, and `2` when it could not run. Violations carry a `suggestedFix`
EditScript that can be fed straight back into `plan execute`.

## Use it from an agent

Start with the machine-readable command schema, then drive the loop:

```bash
openreelio-cli help-json          # full command surface as JSON
openreelio-cli ffmpeg info        # self-diagnosis
```

The perception loop that makes autonomous editing work is: **analyze → edit →
render → look at frames → verify → fix**. `analysis`, `frame extract`,
`render start --proxy` and `verify` exist specifically to close it.

`frame extract` shows the composited edit by default — captions, text,
transforms and blends included, losslessly, reusing a current preview-cache
segment where one exists — and each still reports whether it came from the
`cache`, a fresh `composite` render, or (with the opt-in `--mode fast`) the
clip's own `source` media.

It also picks the times for you, so no cut arithmetic is needed: `--range START
END` (repeatable - the `affectedRanges` an apply just returned), `--affected`
(the last recorded edit, a shared slot - pin it with `--after-op`), `--at-cuts`,
`--at-transitions`, `--at-captions`, `--at-markers`, `--per-shot`,
`--around <SEC>`. Add
`--grid auto` for one contact sheet whose cells carry their timecode and the
`reason` they were sampled, and `--limit <N>` to cap how many frames come back.
Uniform `--between` sampling lands on no event at all — keep it for an overview.

### MCP server

`openreelio-cli` is also an MCP server over stdio, so MCP-capable agents can use
it as a tool provider:

```bash
openreelio-cli mcp --project ./demo --stdio                 # read-only tools
openreelio-cli mcp --project ./demo --stdio --allow-write   # also expose mutating tools (local trust)
```

`--allow-write` drops the per-call approval requirement for mutating tools. Use
it only with a locally trusted client; every mutation still goes through the
command log and stays undoable.

The read tools cover the whole perception loop, so a vision-capable host closes
it without shelling out: `openreelio.frame.extract` returns stills and contact
sheets **inline** as MCP `image` blocks — including the samplers, so
`{ "ranges": [...], "grid": "auto" }` with the `affectedRanges` an apply
returned is one image of exactly what changed — and `openreelio.verify` returns
the deterministic QC report. Both
are available without any write grant.

MCP registry identifier:

```text
mcp-name: io.github.openreelio/openreelio
```

## Environment

| Variable                 | Purpose                                                 |
| ------------------------ | ------------------------------------------------------- |
| `OPENREELIO_CLI_BINARY`  | Absolute path to a CLI binary; bypasses package lookup   |
| `OPENREELIO_FFMPEG_PATH` | Explicit FFmpeg binary (highest precedence)              |
| `OPENREELIO_FFPROBE_PATH`| Explicit FFprobe binary (highest precedence)             |

## Links

- Source and issues: <https://github.com/openreelio/openreelio>
- Full command reference: `openreelio-cli help-json`

## License

MIT © 2026 Junseo5
