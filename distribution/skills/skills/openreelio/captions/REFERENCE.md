# Captions and text

Captions are timed subtitle entries on a caption track. Text clips are styled
overlays with position, transform, and effects. Both are ordinary commands in the
op log, so both are undoable.

## Captions

```bash
openreelio-cli caption add    --path ./demo --text "Hello" --start 0.5 --end 3.0 \
                              [--track <TRACK_ID>] [--style-pack <PACK_ID>] \
                              [--position <POS>] [--style-json '{…}']
openreelio-cli caption update --path ./demo --id <CAPTION_ID> [--text "Updated"] \
                              [--start 1.0] [--end 4.0] [--style-pack <PACK_ID>] \
                              [--style-json '{…}']
openreelio-cli caption list   --path ./demo
openreelio-cli caption remove --path ./demo --id <CAPTION_ID>
```

`caption add` returns `{"status","opId","createdIds":[<CAPTION_ID>],"trackId"}`
and creates a caption track if none exists. `caption list` returns
`captions[{id,trackId,text,startSec,endSec,durationSec,position,style}]`.

Import and export:

```bash
openreelio-cli caption import --path ./demo --file subs.srt \
                              [--format srt|vtt|transcript-json] [--language en]
openreelio-cli caption export --path ./demo --format srt --output subs.srt
```

`--format` is auto-detected from the file extension on import when omitted.
Export supports `srt` and `vtt`.

## Caption style packs

Packs are the quality floor — reach for free-form styling only when a pack
cannot express the brief. A pack is a named, checked pairing of typography and
anchor: every one is verified to draw zero `caption.safe_area` violations on both
a 1920x1080 and a 1080x1920 canvas — exactly the check `verify` runs, and it
measures the text block against each canvas rather than only comparing margins.
Hand-assembled styling gets no such guarantee.

```bash
openreelio-cli packs list --kind caption
```

| Pack | Use it for |
|------|-----------|
| `standard-outline` | The default. White text, thin black outline, soft shadow. |
| `clean-minimal` | No outline or shadow — controlled, consistently dark footage only. |
| `boxed-contrast` | Translucent black box; survives busy or bright backgrounds. |
| `yellow-classic` | Legacy broadcast yellow; reads as dialogue subtitling. |
| `shorts-bold-outline` | Large bold with thick outline, lifted clear of vertical-platform UI. |
| `broadcast-lower` | Left-aligned boxed name plate anchored in the lower-left third. |
| `high-contrast-accessible` | Oversized bold on a near-opaque box; highest legibility floor. |
| `caption-top` | Top-anchored, for shots whose lower half is already busy. |

Ids tolerate `_` and spaces and case (`clean_minimal`, `Clean Minimal`), and each
pack carries short aliases (`minimal`, `boxed`, `shorts`, `accessible`) that
`packs list` prints.

A pack is a **base layer, not a lock**. Anything you also pass overrides it key
by key, so this is the boxed pack at 96pt with everything else intact:

```bash
openreelio-cli caption add --path ./demo --text "Hello" --start 0 --end 3 \
  --style-pack boxed-contrast --style-json '{"fontSize":96}'
```

`--position top|center|bottom` names a vertical anchor only, so combining it
with a pack keeps the pack's checked margin instead of replacing it.

`--style-pack` on `caption update` restyles an existing caption in one flag and
leaves it where it is — an update replaces whatever position it carries, so the
pack's own anchor deliberately stays out of it. Pass `--position` when the
caption should move as well. `caption import` applies a pack to every cue it
writes. The same field is available on the backend commands as `stylePack`, so
`command execute --type CreateCaption|UpdateCaption|ImportGeneratedCaptions`
takes it too. An unknown id is rejected with the full list of valid ids.

## Text overlays

```bash
openreelio-cli text add       --path ./demo --text "Title" --start 0 --duration 3 \
                              [--preset credits] [--font-size 72] [--color "#ffffff"] \
                              [--x 0.5] [--y 0.5] [--align center] [--bold]
openreelio-cli text update    --path ./demo --id <CLIP_ID> --text "New" [--font-weight 600]
openreelio-cli text transform --path ./demo --id <CLIP_ID> --x 0.38 --y 0.42 \
                              --scale-x 1.2 --scale-y 1.2 --rotation 8
openreelio-cli text list      --path ./demo
openreelio-cli text remove    --path ./demo --id <CLIP_ID>
```

`text add` and `text update` accept a long list of styling flags plus escape
hatches (`--style-json`, `--text-json`, `--position-json`, `--outline-json`,
`--shadow-json`). Run `openreelio-cli text add --help` for the current set rather
than guessing — the flag list is the largest in the CLI.

Positions are normalized (`0.0`–`1.0`) fractions of the canvas.

### Text presets

`--preset` is the text equivalent of a caption pack: one id supplies typography,
anchor, starter copy, and a suggested duration (used when `--duration` is
omitted). The catalog is one registry shared by the CLI, the MCP tools, the
agent tools, and the app — the CLI, the prompts, and the UI no longer disagree
about which ids exist, so `quote`, `watermark`, `countdown`, `label`,
`tech-style`, `callout-warning`, `subtitle-outline`, `end-card-title`, and
`lower-third-minimal` all work where they were previously advertised and
rejected.

```bash
openreelio-cli packs list --kind text
```

Each entry prints its `category`, `defaultDurationSec`, aliases, and the full
`clip` it produces, so nothing has to be guessed. Categories group the catalog:
`lower-third`, `title`, `subtitle`, `callout`, `credit`, `brand`, `creative`.
Ids tolerate `_`, spaces, and case (`lower_third`, `Lower Third`), and short
aliases (`title`, `credits`, `stat`, `timer`, `handle`) resolve too. `default`
means "no preset".

A preset is a **base layer, not a lock** — explicit flags override it:

```bash
openreelio-cli text add --path ./demo --text '"Cut the noise"' --start 12 \
  --preset quote --font-size 96
```

The same catalog is reachable from the backend command as `preset`, which fills
in everything `textData` leaves out:

```bash
openreelio-cli command execute --path ./demo --type AddTextClip --payload \
  '{"sequenceId":"seq_1","trackId":"v2","timelineIn":90,"duration":6,
    "preset":"logo-bug","textData":{"content":"OPENREELIO"}}'
```

The op log records the concrete values the preset produced, never the id, so a
project replays identically even if the catalog later changes. An unknown id is
rejected with the full list of valid ids.

## Transcription

Speech-to-text runs locally with Whisper. Check readiness first; the model is a
multi-hundred-megabyte download.

```bash
openreelio-cli transcription status
openreelio-cli transcription install --model large-v3-turbo [--force]
openreelio-cli transcription generate --path ./demo --asset <ASSET_ID> \
                                      [--language auto] [--model auto] [--import] \
                                      [--track <TRACK_ID>] [--replace-existing] [--translate]
openreelio-cli transcription generate-sequence --path ./demo [--sequence <SEQ_ID>] --import
```

`transcription status` returns `{featureAvailable, ready, modelsDir,
defaultModel, installedCount, models[…]}`. `--import` writes the result straight
into a caption track; without it, use `--output <FILE>` and import later.
`generate-sequence` transcribes the audible mix of a sequence instead of a single
asset.

After generating captions, run `verify` — `caption.overlap`,
`caption.out_of_bounds`, `caption.reading_rate`, and `caption.safe_area` catch
the failures auto-generated subtitles actually produce. See
[Verify](../verify/REFERENCE.md).
