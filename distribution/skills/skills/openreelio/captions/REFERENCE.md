# Captions and text

Captions are timed subtitle entries on a caption track. Text clips are styled
overlays with position, transform, and effects. Both are ordinary commands in the
op log, so both are undoable.

## Captions

```bash
openreelio-cli caption add    --path ./demo --text "Hello" --start 0.5 --end 3.0 \
                              [--track <TRACK_ID>] [--position <POS>] [--style-json '{…}']
openreelio-cli caption update --path ./demo --id <CAPTION_ID> [--text "Updated"] \
                              [--start 1.0] [--end 4.0] [--style-json '{…}']
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
