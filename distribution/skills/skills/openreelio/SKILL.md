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
`openreelio-cli command schema` for the 79 backend command types, and
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

## Setup

Install the CLI, point it at a project, and confirm the media toolchain.
Load [Setup](./setup/REFERENCE.md).

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

## Verify

Run deterministic quality control over the sequence and the rendered file, then
feed the suggested fixes back as an edit plan. Load [Verify](./verify/REFERENCE.md).

## Judging

Try N candidate edits, score each rendered result against a fixed rubric, and
keep the best — contact sheets from the render, history jumps between
candidates. Load [Judging](./judging/REFERENCE.md).
