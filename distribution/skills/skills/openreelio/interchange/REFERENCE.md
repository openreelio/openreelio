# Interchange

Hand a cut to another NLE, or take one back. `otio export` writes
[OpenTimelineIO](https://opentimeline.io/), the Academy Software Foundation's
editorial interchange format; `otio import` reads one back into a sequence.

The reason to care: **DaVinci Resolve imports OTIO natively, on the free tier.**
That makes "assemble headless here, finish there" a real workflow — cut the
program with the CLI, hand the `.otio` file to a colourist, and never ask them to
learn a new tool. `edl` and `fcpxml` exports exist too, through the app rather
than the CLI, and carry less.

## Cut interchange only

This is the part to internalise before you promise anyone a round trip.

**Survives:** video and audio tracks · clips, with their media file and source
in-point · gaps · two-input transitions (cross dissolve, wipe, slide) · sequence
markers.

**Does not survive:** effects and colour grading · transforms, motion keyframes,
opacity, blend modes · caption tracks and text clips · clip audio settings
(levels, pan, fades) · speed, reverse, freeze frames, time remapping · compound
clips and adjustment layers.

Nothing on the second list is dropped quietly. Every export prints `warnings`
(structural changes: skipped tracks, offline media, trimmed overlaps) and
`unsupported` (editorial detail that could not cross), and both arrays are always
present so you can tell "checked and clean" from "not reported". Read them before
you hand the file on.

## Export

```bash
openreelio-cli otio export --path ./demo --out cut.otio [--sequence <SEQUENCE_ID>]
```

```json
{
  "status": "ok",
  "output": "/abs/path/cut.otio",
  "trackCount": 2,
  "clipCount": 4,
  "warnings": ["clip 'c7' is disabled and was exported as a gap"],
  "unsupported": [
    "caption track 'Subtitles' was not exported: OTIO has no caption track kind…",
    "3 clip(s) carry effects that were dropped: c1, c2, c5"
  ]
}
```

Notes that change what you see in Resolve:

- **Gaps are explicit.** An OTIO track is a contiguous child list, so every hole
  becomes a `Gap`. No gap is written *after* the last clip — a track ends where
  its last shot ends, and OTIO tracks are allowed to differ in length.
- **A speed-changed clip keeps its slot, not its speed.** It exports occupying
  the same timeline span from the same source in-point, so every later cut stays
  on its frame, and it plays at unmodified speed in the importing tool. The clip
  is named in `unsupported`.
- **A caption, text, compound or adjustment clip becomes a gap**, so the shots
  around it do not slide.
- **A wipe or slide exports as `"Custom"`**, because OTIO only standardises a
  dissolve. The real type is preserved under `metadata.openreelio`.

## Import

```bash
openreelio-cli otio import --path ./demo --file cut.otio [--sequence <SEQUENCE_ID>] [--dry-run]
```

Import builds an edit plan and runs it through the same machinery as
`plan execute`: one atomic, undoable unit that rolls back on failure, reporting
through the same exit codes — `0` applied and saved, `1` rejected or rolled back
cleanly, `2` tool failure or an incomplete rollback.

**Always dry-run first on a file you did not write.** `--dry-run` prints the plan,
its warnings and the media it would import, and stops without touching the
project:

```bash
openreelio-cli otio import --path ./demo --file foreign.otio --dry-run
```

Media resolution, in order: the asset id in `metadata.openreelio` (our own
files), then the file path, then the file name. Anything still unmatched becomes
an `ImportAsset` step and is listed in `assetImports` — so check that list
before applying a file whose media lives somewhere unexpected.

**Refused outright**, rather than imported approximately: an `OTIO_SCHEMA`
version this build does not read (the error names it), image-sequence
references, and a file needing more plan steps than the cap allows — chunking it
would give up atomicity, so split the timeline instead.

**Reported but not fatal:** nested stacks, non-editorial track kinds, offline
clips, asymmetric transitions (OpenReelio stores one duration, so the blend is
re-centred on the cut), and transitions whose handles cannot be verified.

## Transition handles

A two-input transition needs unused source media on both sides of the cut.
Import checks each boundary against the media it can measure and warns when a
side is short or when the source length is unknown. It warns rather than fails:
the clips are worth having either way, and the render path soft-refuses the
blend instead of failing the export. Treat those warnings as the list of cuts to
re-trim before delivery.

## The `metadata.openreelio` namespace

Our exports stash detail the standard schema cannot carry — exact track kind,
original ids, mute state, the real transition type behind a `"Custom"`, a
marker's exact colour — under `metadata.openreelio` on the relevant node.
Foreign tools ignore it and see ordinary OTIO; our own import reads it to
restore what it can. It is metadata, not a second timeline: it never changes
where a clip sits.

## Verifying a Resolve round trip

CI cannot run Resolve, so this is a manual check. Export, then in Resolve use
**File → Import → Timeline → Import AAF, EDL, XML…** and pick the `.otio` file.
Confirm the track count, that each cut lands on the frame the export named, that
media links resolve, and that any dissolve sits on the boundary it was reported
on. Anything in `unsupported` will be missing — that is the format, not a bug.
