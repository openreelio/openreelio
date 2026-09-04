# Setup

## Install

```bash
npm install -g openreelio-cli     # global install
npx openreelio-cli --help         # or run without installing
```

The npm package downloads nothing at install time. The binary ships in a
platform-specific optional dependency (`@openreelio/cli-win32-x64`,
`@openreelio/cli-darwin-x64`, `@openreelio/cli-darwin-arm64`,
`@openreelio/cli-linux-x64`) that npm resolves from `os`/`cpu`, so installs work
with lifecycle scripts disabled. Linux builds are glibc only.

**Standalone archive.** Releases publish
`openreelio-cli-<version>-<target-triple>.zip` (Windows) and
`openreelio-cli-<version>-<target-triple>.tar.gz` (macOS, Linux) at
<https://github.com/openreelio/openreelio/releases>. On macOS, clear the
quarantine attribute before running the extracted binary:

```bash
xattr -d com.apple.quarantine ./openreelio-cli
```

**App-bundled sidecar.** The OpenReelio desktop app ships the same binary at
`<app-dir>/binaries/openreelio-cli[.exe]` (Windows, Linux) or
`OpenReelio.app/Contents/Resources/binaries/openreelio-cli` (macOS).

**`OPENREELIO_CLI_BINARY`** — set this to an absolute path and the npm launcher
uses that binary verbatim, bypassing package lookup. Use it to run a standalone
or app-bundled build through `npx openreelio-cli`.

## Confirm the media toolchain

```bash
openreelio-cli ffmpeg info
```

Returns `{status, ffmpegPath, ffprobePath, version, source}`. `source` is one of
`explicit`, `env`, `bundled`, `managed`, `dev`, `system` — that is also the
resolution order. Run this first whenever a media verb fails for no obvious
reason.

Override the toolchain with `OPENREELIO_FFMPEG_PATH` and
`OPENREELIO_FFPROBE_PATH`; both outrank every bundled or system install.

## Create or open a project

```bash
openreelio-cli project create --name "Demo" --path ./demo
openreelio-cli project create --name "Vertical" --path ./vertical \
                              --fps 25 --width 1080 --height 1920
openreelio-cli project info   --path ./demo
openreelio-cli asset import   --path ./demo --file ./footage.mp4 [--name "A-roll"]
openreelio-cli asset list     --path ./demo
```

`project create` makes the directory and a default sequence with one video and
one audio track. `asset import` returns
`{"status","opId","createdIds":[<ASSET_ID>],"assetName","uri"}`.

**Set the delivery format at creation.** The sequence defaults to 30fps
1920x1080 no matter what the media is. Pass `--fps`, `--width` and `--height` to
create it as the format you are delivering — 25fps, vertical, whatever — or fix
it later with `timeline set-format`. Both run the same logged, undoable
`SetSequenceFormat` command, so neither is a hidden property of how the project
was made. A decimal `--fps` snaps to the exact broadcast rational (`29.97` →
`30000/1001`); canvas edges must be even and within `16..=16384`.

> **`asset import` records no probed duration.** Every clip `timeline insert`
> places is therefore 10 seconds long regardless of the file, so a second
> `timeline insert --at 4.0` is refused as an overlap. Get the real length from
> perception — `analysis shots` returns `totalDurationSec`, `analysis audio`
> returns `durationSec` — and `timeline trim` the clip to it before inserting
> anything after it.

## Conventions that apply everywhere

- **stdout is one JSON object.** Parse stdout; never parse stderr.
- **stderr carries progress and diagnostics.** `--progress` streams NDJSON there.
- **`--path <PROJECT_DIR>` is required on every project verb.** There is no
  ambient current project. Only `help-json`, `command schema`, `plan template`,
  `render presets`, `ffmpeg info`, `transcription status` and
  `transcription install` omit it.
- **`--sequence` is always optional** and defaults to the active sequence.
- **IDs are ULIDs** like `01KZW64VJ4JPBS5B9YZEA335J8`, not `asset_001`. Read them
  from `createdIds` in a command result, or from `asset list`,
  `timeline tracks`, `timeline clips`.
- **Negative numbers need `=`**: write `--target-lufs=-14`, not
  `--target-lufs -14`. (`analysis silence --threshold-db -40` and
  `state jump --index -1` are the exceptions that also accept the spaced form;
  the `=` form works for every option, so use it everywhere.)
- **Exit codes**: `0` success, `1` failure. `verify` and `plan execute` have
  richer contracts — see [Verify](../verify/REFERENCE.md) and
  [Editing](../editing/REFERENCE.md#atomic-batches-plan-execute).
