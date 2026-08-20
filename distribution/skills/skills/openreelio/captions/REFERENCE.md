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
`clip` it produces, so nothing has to be guessed. Categories group the catalog
and decide placement: `lower-third`, `title`, `subtitle`, and `callout` may be
moved by smart placement, while `credit`, `brand`, and `creative` keep the
anchor the preset chose.
Ids tolerate `_`, spaces, and case (`lower_third`, `Lower Third`), and short
aliases (`title`, `credits`, `stat`, `timer`, `handle`) resolve too. `default`
means "no preset".

A preset is a **base layer, not a lock** — explicit flags override it:

```bash
openreelio-cli text add --path ./demo --text '"Cut the noise"' --start 12 \
  --preset quote --font-size 96
```

The same catalog is reachable from the backend command as `preset`, which fills
in everything `textData` leaves out — including all of it, when `textData` is
omitted:

```bash
openreelio-cli command execute --path ./demo --type AddTextClip --payload \
  '{"sequenceId":"seq_1","trackId":"v2","timelineIn":90,"duration":6,
    "preset":"logo-bug","textData":{"content":"OPENREELIO"}}'
```

Nested layers merge key by key, so `{"style":{"bold":false}}` un-bolds a bold
preset and `{"shadow":{"offsetX":2}}` nudges the shadow without restating it —
on every preset, including those that declare no shadow of their own.

The op log records the concrete values the preset produced, never the id, so a
project replays identically even if the catalog later changes. An unknown id is
rejected with the full list of valid ids.

### Three ids changed meaning

Unifying the CLI table onto the app's catalog changed what `title`,
`lower-third`, and `subtitle` produce. Existing projects replay unchanged (the
op log holds concrete values), but a script that names one of these renders
differently than it used to:

| Id | Was | Now |
|----|-----|-----|
| `title` (alias of `centered-title`) | upper third, y=0.15 | frame center, y=0.5 |
| `lower-third` | centered (0.5, 0.80), 36pt, regular, no shadow | left-aligned (0.08, 0.82), 42pt, bold, with shadow |
| `subtitle` | y=0.85, thin outline, background `#000000AA` | y=0.9, no outline, background `#00000099` |

No id reproduces the old layouts; re-anchor with flags where the placement
mattered, e.g. `--preset title --y 0.15`, or
`--preset lower-third --x 0.5 --y 0.8 --align center --font-size 36 --style-json '{"bold":false}'`.
Preset ids are append-only from here on.

## Burn-in behavior

Captions and text clips are burned into the render by libass, from an ASS script
the exporter writes. A few things follow from that, and none of them are visible
until you look at the finished file.

**Only preset caption positions wrap.** A caption at a preset position is
anchored by margins that reserve 10% of the canvas on each side, so an over-long
line wraps inside the remaining 80% instead of running off the frame. Alignment
picks which edge it grows from: `left` anchors on the left margin, `right` on the
right, `center` straddles the middle — the same anchors the preview draws.

**Custom positions and text clips do not wrap at that box.** A caption placed
with `--position-json '{"type":"custom",…}'`, and every text clip, is positioned
exactly; there is no margin box to wrap inside, so the text breaks only where it
meets the frame edge. Use a preset position when the text length is not under
your control.

**A preset margin is a gap to the block's near edge.** "10% from the bottom"
means the bottom of the last line sits a tenth of the frame above the bottom
edge; wrapping onto more lines grows the block *upward*, toward the middle of the
frame, and never eats into the margin you asked for. A custom position works the
other way: the point you give marks the block's centre, so a tall or wrapped
caption overruns it above and below.

**Font size is resolution-independent.** `fontSize` means "pixels at 1080p": the
script is authored 1080 tall with the sequence canvas's aspect regardless of the
export resolution, so the same project burns identical-looking text at 1080p and
at 4K, and at the size the preview shows.

> This is a change. Exports previously authored the script at the output size, so
> the same `fontSize` rendered smaller relative to the frame the larger the
> export, and disagreed with the preview on any canvas that was not 1080 tall. A
> project whose canvas is not 1080 tall will burn its text at a different size
> than it did before — the new size is the one the preview has always shown.

**`lineHeight` is not honored.** ASS has no line-spacing control; libass spaces
lines from the font's own metrics. A caption or text clip whose `lineHeight`
deviates from the 1.2 default draws a render warning naming the clip. Only the
`drawtext` fallback, which an export takes when FFmpeg has no `subtitles`
filter, honors it.

**Fonts are bundled.** These families are compiled into the binary and embedded
into the script, so they render identically on a machine that has never
installed them:

`TikTok Sans`, `Montserrat`, `Anton`, `Archivo Black`, `Bebas Neue`, `Poppins`,
`Bangers`, `Luckiest Guy`

Caption styles also carry `underline`, `letterSpacing` and `shadowBlur` into the
burn-in; the `drawtext` fallback has no equivalent for any of them and ignores
them as before.

A family that is not bundled is resolved against the host's installed fonts, and
is only as reproducible as that host. One available in neither is replaced with
`TikTok Sans` — itself bundled, so the fallback is deterministic too — and
reported as a render warning. libass would otherwise substitute silently, and the
same project would render in a different typeface on every machine.

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

**Caption cue boundaries come from DTW-aligned word timings.** Cue starts and
ends — including on a cue short enough to need no splitting — are derived from
whisper.cpp's dynamic-time-warping alignment of decoder cross-attention rather
than Whisper's cheap heuristic token timestamps. This covers caption cues only:
the transcript editor and the analysis word surfaces still estimate word times by
dividing each segment equally among its words.

Supported on `tiny`, `base`, `small`, `medium`, `large-v3`, `large-v3-turbo` and
their quantized variants. A model file OpenReelio does not recognize by name runs
without DTW — that is the usual skip. `large` (`ggml-large.bin`) is deliberately
excluded because the plain filename is version-ambiguous upstream. The filename
is trusted, not verified: weights renamed to a same-shaped model pass the bounds
check and misalign silently. A preset that does not match the loaded weights is
caught when whisper.cpp creates its first state; the engine probes for that up
front and falls back to heuristic timings with a warning rather than failing the
transcription. Flash attention stays off globally because it disables DTW.

A deterministic repair pass then runs **on every transcription, DTW or not** —
DTW improves its input rather than replacing it. The first word's start is
recovered from the audio (DTW stamps where the alignment *leaves* a token, so the
first token has an end and no start, and Whisper's fallback for it is just the
segment start — silence, when the segment opens before anyone speaks). Starts
stay ordered, non-overlapping and inside their segment; collapsed words are grown
back toward at least 40 ms where the surrounding audio allows (a dense run with
no room to give is spread evenly and stays under 40 ms); a word that would
otherwise span a pause is released after at most 350 ms per syllable-ish unit,
except the segment's last word, whose end anchors the tail cue; and starts are
snapped to the nearest short-time-energy onset within 80 ms when that neither
reorders nor starves a neighbour.

Accuracy is indicative, not contractual: on English and Korean test clips whose
speech is preceded by silence, the leading cue edge landed on the hand-measured
onset to within the 10 ms analysis hop. That is clean speech with a clear attack.
Do not treat cue boundaries as frame-exact. Nothing here changes the CLI surface
— there are no timing knobs to pass.

After generating captions, run `verify` — `caption.overlap`,
`caption.out_of_bounds`, `caption.reading_rate`, and `caption.safe_area` catch
the failures auto-generated subtitles actually produce. See
[Verify](../verify/REFERENCE.md).
