---
name: openreelio
description: Edit, analyze, and render video from the command line with the openreelio CLI — import media, cut/trim/split a timeline, add captions and text, detect shots and silence, extract frames to inspect results, and render. Use for any video editing, video analysis, or video rendering task.
---

# OpenReelio

`openreelio-cli` is a headless non-linear editor. It keeps a real project on disk
and exposes editing, media analysis, captioning, rendering, and deterministic
quality control as subcommands that print a single JSON object on stdout.

## Why openreelio rather than raw ffmpeg

- **The project is editable, not baked.** Every edit is a command appended to an
  event-sourced op log; project state is a replayable snapshot of that log. You
  can revise a decision from ten steps ago instead of rebuilding a filtergraph.
- **Undo and replay are first-class.** `timeline undo` / `timeline redo` walk the
  log, and `state ops` shows exactly what happened.
- **Validation happens before the render.** `command validate` and
  `plan validate` reject a bad edit up front, and `plan execute` is atomic —
  a failing step rolls the whole batch back.
- **There is a QC loop.** `verify` measures the sequence and the rendered file
  (gaps, black frames, freezes, caption overlaps, EBU R128 loudness, true peak)
  and returns executable fixes, so "is this deliverable?" is a command rather
  than a judgement call.

Reach for ffmpeg directly only for one-off transcodes with no editorial decisions
in them.

## The CLI is self-describing

Treat the binary as the source of truth, not this skill.
`openreelio-cli help-json` prints the entire command schema as JSON, and
`openreelio-cli <verb> --help` is authoritative for any single verb. `help-json`
is roughly 68 KB — fetch per-verb help instead of loading all of it. Use
`openreelio-cli command schema` for the 80 backend command types
(`--type <CommandType>` for one payload's JSON Schema — fields, types, what is
required, and the spellings each field accepts; read it before composing a
payload), and
`openreelio-cli packs list` for the curated caption styles, transition
recipes, text presets, and pacing profiles
(`--kind caption|transition|text|pacing`).

Its *examples* are not copy-paste ready: IDs are readable placeholders
(`asset_001`) rather than the ULIDs the CLI actually returns, and some spell a
negative option in the spaced form (`--target-lufs -14`) that argument parsing
rejects. Check an example against
[the conventions](./setup/REFERENCE.md#conventions-that-apply-everywhere) and the
verb's own `--help` before running it.

## Never full-render to check your work

A full export is the most expensive way to answer "did that cut land?". Use
`frame extract` for stills and contact sheets, or `render start --proxy
--start/--end` for a 480p draft of just the range under review. Full-quality
renders are for delivery.

`frame extract` shows the **composited** edit by default — captions, text,
transforms and blends, exactly what export produces — and reuses an already
rendered preview-cache segment when one covers the time. `--mode fast` is the
opt-in cheap look at the raw footage; it shows none of the edit.

**Do not compute the times yourself.** `frame extract` samples the edit's own
events: `--range START END` (repeatable) for ranges you name, `--at-cuts` for
both sides of every cut, `--at-transitions`, `--at-captions`, `--at-markers`,
`--per-shot`, `--around <SEC>`. Add `--grid auto` and the whole answer comes
back as one contact sheet whose cells name their timecode and the reason they
were chosen; `--limit <N>` caps how many frames that is. Uniform `--between`
sampling lands on no event at all — keep it for a whole-render overview.

**The post-apply step is `--range`, with the ranges the verb just returned.**
Every mutating verb answers with `affectedRanges` and its op ids; pass one
`--range` per entry and no hand-off file is read.

```bash
openreelio-cli plan execute  --path ./demo --file cut.json     # → affectedRanges
openreelio-cli frame extract --path ./demo --range 4 9.5 --range 21 24.5 \
  --grid auto --label-cells --out ./look.jpg
```

`--affected` is the shortcut for when you did not keep that result: it reads the
last recorded edit, which is a slot the app's own interactive edits also write,
so pin it with `--after-op <OP_ID>`.

## Setup

Install the CLI, point it at a project, and confirm the media toolchain.
Load [Setup](./setup/REFERENCE.md).

Two things about a fresh project that will otherwise cost you a render:
`project create` makes a **30fps 1920x1080** sequence whatever the media is —
pass `--fps/--width/--height`, or run `timeline set-format` — and `asset import`
records **no probed duration**, so every clip `timeline insert` places is 10
seconds long and a second insert at 4.0s is refused as an overlap. Trim to the
real length (`analysis shots` → `totalDurationSec`) before building on it.

## Perception

Find out what is actually in the footage: shots, silence, loudness, and frames
you can look at. Load [Perception](./perception/REFERENCE.md).

## Editing

Place, trim, split, move, and speed-change clips; add transitions from curated
recipes (fades, dissolves, wipes and slides all render — a two-input transition
needs unused source media on both sides of the cut, and the render says so when
a boundary has none); cut a whole asset to a curated pacing profile; reach every
backend command; run atomic batches. Load [Editing](./editing/REFERENCE.md).

## Captions and text

Add subtitles with curated caption packs and text overlays with curated text
presets, import/export SRT and VTT, and generate transcripts locally. Load
[Captions](./captions/REFERENCE.md).

## Render

List presets, render a fast proxy or a delivery file, stream progress, and limit
the render to a range. Load [Render](./render/REFERENCE.md).

## Interchange

Hand a cut to DaVinci Resolve or another NLE, or take one back, with
OpenTimelineIO — a cut-only exchange that reports everything it cannot carry.
Load [Interchange](./interchange/REFERENCE.md).

## Verify

Run deterministic quality control over the sequence and the rendered file, then
feed the suggested fixes back as an edit plan. Load [Verify](./verify/REFERENCE.md).

## Judging

Try N candidate edits, score each rendered result against a fixed rubric, and
keep the best — contact sheets from the render, history jumps between
candidates. Load [Judging](./judging/REFERENCE.md).
