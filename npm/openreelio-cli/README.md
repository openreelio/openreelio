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

The package downloads nothing at install time. The binary ships in a
platform-specific optional dependency that npm resolves from `os`/`cpu`, so
installs work with lifecycle scripts disabled (the npm v12 default).

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

```bash
# 1. Create a project and import media
openreelio-cli project create --name "Demo" --path ./demo
openreelio-cli asset import --path ./demo --file ./footage.mp4

# 2. Look before you cut: shots, silence, loudness
openreelio-cli analysis run --path ./demo --id <ASSET_ID> --progress

# 3. Edit through commands (append-only, undoable)
openreelio-cli timeline insert --path ./demo --asset asset_001 --track track_v1 --at 0.0
openreelio-cli timeline split  --path ./demo --clip clip_001 --at 5.0
openreelio-cli timeline undo   --path ./demo

# 4. See the result, not just the JSON
openreelio-cli frame extract --path ./demo --grid 3x2 --between 0 30 --out ./frames/sheet.jpg
openreelio-cli render start --path ./demo --proxy --output ./out/proxy.mp4 --start 0 --end 30 --progress

# 5. Prove it is deliverable
openreelio-cli verify --path ./demo --file ./out/proxy.mp4
```

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

MCP registry identifier:

```
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
