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
openreelio-cli project create --name "Demo" --path ./demo
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
END=$(openreelio-cli timeline clips --path ./demo \
  | pick '.clips.reduce((m, c) => Math.max(m, c.timelineInSec + c.durationSec), 0)')
openreelio-cli frame extract --path ./demo --grid 3x2 --between 0 "$END" --out ./frames/sheet.jpg
openreelio-cli render start --path ./demo --proxy --output ./out/proxy.mp4 --progress

# 5. Prove it is deliverable
openreelio-cli verify --path ./demo --file ./out/proxy.mp4
```

Clip-scoped verbs (`split`, `trim`, `move`, `speed`, `remove`) all need
`--track` as well as `--clip`; `timeline clips` prints both.

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
sheets **inline** as MCP `image` blocks, and `openreelio.verify` returns the
deterministic QC report. Both are available without any write grant.

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
