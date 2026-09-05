# Judging

Best-of-N candidate selection. `verify` answers "is this deliverable?"; judging
answers "which of these edits is *better*?" — a question `verify` cannot decide,
because taste dimensions (pacing, hook, continuity) are warnings at most.

Use it when the brief has editorial freedom: several defensible cut patterns,
several caption placements, several pacing targets. For a single fully
constrained edit, the verify fix loop alone is cheaper and sufficient.

## The loop (one project directory, linear rewind)

The op log is linear — there are no branches. Candidates are tried in sequence
and unwound with `state jump`; the winner is re-applied from its plan JSON.

```bash
# 0. Baseline: note currentIndex — that is where every candidate rewinds to
openreelio-cli state history --path ./demo

# For each candidate plan (candidate-a.json, candidate-b.json, …):
openreelio-cli plan execute  --path ./demo --file candidate-a.json
# Look at what the plan actually changed, before spending a render on it:
# one --range per entry in the affectedRanges the plan just reported
openreelio-cli frame extract --path ./demo --range <START> <END> --grid auto \
  --label-cells --out ./judge/a-affected.jpg
openreelio-cli render start  --path ./demo --proxy --output ./judge/a.mp4 --progress
openreelio-cli frame extract --path ./demo --file ./judge/a.mp4 \
  --file-range 0 <SEQUENCE_END> --at-cuts --grid auto \
  --label-cells --out ./judge/a-sheet.jpg
openreelio-cli verify        --path ./demo --file ./judge/a.mp4 > ./judge/a-verify.json
openreelio-cli state history --path ./demo    # re-read before rewinding, see below
openreelio-cli state jump    --path ./demo --index <BASELINE_INDEX>

# After scoring every candidate: re-apply the winner's plan
openreelio-cli plan execute  --path ./demo --file candidate-b.json
```

Re-apply the winner from its **plan JSON**, never via redo: any new mutating
command after a jump clears the redo branch, so an unwound candidate is
unreachable except through its plan file. Keep every candidate's plan file until
the winner is applied.

**The baseline index goes stale.** A render plus a verify takes minutes, and the
index space is recomputed on every invocation from the ops log — so if anything
else wrote to the project meanwhile, its ops are adopted as history and sit
*above* your baseline. Rewinding to the baseline then unwinds them too, and the
next `plan execute` clears them from the redo branch for good. So:

- Re-read `state history` immediately before jumping and confirm every entry
  above the baseline index is one your own candidate produced.
- Read `unwound` on the jump's response: it lists `{opId, commandType}` for
  every entry the rewind removed, in order. Anything in there you did not apply
  is another writer's work, and it is now only in the append-only op log.
- `adopted` on the same response counts ops this invocation folded in from the
  log at open time — a non-zero value means a second writer was here.

The external-edit guard does not cover this. It refuses two writers whose
*sessions overlap*; sequential invocations minutes apart each open cleanly and
build on whatever they find. To run candidates in parallel, copy the project
directory once per candidate.

## Judge the render, not the timeline

Score the sheet extracted from the rendered file (`frame extract --file`).
A timeline sheet does show the composited edit now — that is the default — but a
cell the render cache cannot serve is re-rendered per cell, and `--mode fast`
omits effects, text and compositing outright, which are exactly the things being
judged. The `--file` sheet is cheap (fast seeks into an existing render) and
shows the same pixels `verify --file` measured, so scores and measurements
describe one artifact. In `--file` mode cells map back as `fileSec` (the
render's own timebase), and with `--file-range` they carry `timelineSec` too.

## Let the sampler choose the times

Cut-boundary sheets beat uniform sheets for continuity judging — and you no
longer assemble one by hand. `frame extract` takes **event samplers** that read
the sequence and pick the times themselves — on the timeline, and on a rendered
file once `--file-range START END` says which timeline seconds that file holds:

```bash
# Exactly the seconds the apply reported changing — the post-apply look
openreelio-cli frame extract --path ./demo --range <START> <END> --grid auto \
  --label-cells --out ./judge/a-affected.jpg

# Both sides of every cut, at the right offsets, in one call
openreelio-cli frame extract --path ./demo --at-cuts --grid auto \
  --label-cells --out ./judge/a-cuts.jpg

# Captions and titles, on the frame they are settled in
openreelio-cli frame extract --path ./demo --at-captions --grid auto \
  --cell-width 640 --out ./judge/a-captions.jpg

# A rendered range, swept evenly. This is the first look at any draft: it always
# has something to show, while a sampler over a range that happens to hold no cut
# is an error rather than an empty sheet.
openreelio-cli render start  --path ./demo --proxy --start 2 --end 6   --output ./judge/a-range.mp4
openreelio-cli frame extract --path ./demo --file ./judge/a-range.mp4   --between 0 <DURATION_SEC> --grid 4x3 --label-cells   --out ./judge/a-range-sweep.jpg

# The same samplers, reading the RENDER, when the range DOES hold cuts, captions
# or transitions: --file-range is the range you rendered - its start plus the
# durationSec the render reported - so every cell carries fileSec and timelineSec
# and you compute no offsets
openreelio-cli render start  --path ./demo --proxy --start 2 --end 6 \
  --output ./judge/a-range.mp4
openreelio-cli frame extract --path ./demo --file ./judge/a-range.mp4 \
  --file-range 2 6 --at-cuts --grid auto --label-cells \
  --out ./judge/a-range-cuts.jpg
```

| Sampler | Picks | Reasons reported |
| ------- | ----- | ---------------- |
| `--range START END` (repeatable) | every range you name — the `affectedRanges` the apply returned: start, middle, last frame, and both sides of each cut inside it | `affectedStart` `affectedMid` `affectedEnd` `cutBefore` `cutAfter` |
| `--affected` | the same, over the last *recorded* edit's ranges rather than ranges you name | `affectedStart` `affectedMid` `affectedEnd` `cutBefore` `cutAfter` |
| `--at-cuts` | both sides of every cut | `cutBefore` `cutAfter` |
| `--at-transitions` | each blend's start, cut and end | `transitionStart` `transitionCut` `transitionEnd` |
| `--at-captions` | the middle of every caption and text span | `captionMid` `textMid` |
| `--at-markers` | every sequence marker | `marker` |
| `--per-shot` | the middle of every shot | `shotMid` |
| `--around <SEC>` | a window around one time (`--span`, `--around-count`) | `around` |

Samplers combine as a union, are deduplicated and sorted, and every frame or
cell carries its `reason`. The payload also gains a `sampler` block —
`{kinds, candidates, selected, limited, affectedRanges?}` — so a thinned
selection is visible rather than looking like a short timeline. `--grid auto`
sizes the sheet from the sample count (1 column for a single sample, 2 for two,
3 up to 9, 4 up to 16, then 6), which is why none of the calls above states a
layout.

Every mutating verb — `command execute`, `plan execute`, and the `timeline`,
`text` and `caption` edit verbs — reports `affectedRanges` and its op ids on its
own response, so `--range` needs nothing from disk. `--affected` reads
`<project>/.openreelio/cache/agent/last_affected_ranges.json` instead, which
those verbs write **and so does the app's own edit path**: it is a shared slot,
so an interactive edit made in the timeline between your apply and your look
replaces it. Such a record is still served, with a warning that the ranges belong
to an interactive edit — pass `--after-op <OP_ID>` (your `command execute`'s
`opId`, or the last of `plan execute`'s `operationIds`) to have it refused
instead, naming both operations. In a best-of-N loop the app may well be open on
the same project, so that pin matters here. If nothing has been applied to the
sequence yet, or the record does not end at the project's current operation
(an undo, a redo, an edit applied by something that records no hand-off), the
sampler says so rather than guessing — re-apply, or fall back to `--between`.

### Sampling a render

A rendered file has its own timebase starting at zero, so on its own it has no
timeline to sample. `--file-range START END` supplies the missing half: the
timeline seconds that file covers — the `--start`/`--end` you rendered, or `0`
and the sequence end for a full render. The samplers then read the timeline over
that range and translate every time they choose into the file as `t − START`, so:

- every frame and cell carries **both** `fileSec` and `timelineSec`, plus its
  `reason`;
- `source.timelineRange` echoes what you declared, so a sheet can be checked
  against the seconds it claims to be of;
- a sample the file turns out not to hold is **dropped**, not clamped, and
  counted as `sampler.droppedOutsideFile` — a non-zero count means your declared
  range and the file disagree;
- `--range` and `--affected` are clipped to the declared range too, so the
  post-apply look works on a partial render;
- a declared length more than one frame off the file's own is a **warning**, not
  a refusal, because a draft render is routinely a frame short.

Without a sampler, `--file-range` changes nothing: `--time`, `--times` and
`--between` stay file-relative, and the range is only recorded. A sampled
`--file` reads the **active** sequence, since `--sequence` is not accepted
alongside `--file`.

`timeline info` still reports the raw signals (`durationSec`,
`outputDurationSec`, `fps`/`fpsRatio`, `canvas`, `cuts`, `editPoints`,
`markers`, `transitions`, `captionSpans`, `textSpans` and the `inspectionHints`
counts derived from them). You need them when you
sheet a render you cannot state a timeline range for — one produced somewhere
else — where `--times` is still the way in. Take the cut times from `cuts` — the
boundaries where the picture changes — not from `editPoints`, which also lists
the head, the tail, and caption and audio boundaries. A transition listed with
`rendersAsCut: true` will not be blended in the file, so judge that boundary as
a cut.

**Why the cut offsets are asymmetric.** `frame extract` seeks with `-ss` before
`-i`, which resolves **forward**: it returns the first frame whose PTS is ≥ the
requested time. So the cut time itself already gives the incoming shot, while
`cut − 1.5/fps` is the only offset guaranteed to land on the last outgoing frame
at every timebase. A symmetric `±0.04 s` is not: at 24 fps one frame is 0.0417 s,
so `cut − 0.04` resolves forward across the cut and both cells show the incoming
shot — a sheet that looks like a valid before/after and is not. `--at-cuts`
applies the correct offset from the sequence's own fps, on a `--file-range`
sheet as much as on a timeline one; only when you compute times by hand for a
render you cannot declare a range for do you need the fps from the render itself
(`verify --file` reports it) rather than assuming one.

`--label-cells` burns the **requested** time, not the decoded frame's PTS, so a
label is proof of which cell you are looking at, never proof that the frame came
from the side of the cut you wanted. On a `--file-range` sheet the number burnt
in is the **timeline** second the cell shows, not its offset into the file — the
file's timebase is an artefact of where the render started, so a judgement has to
quote the timeline. The file offset is still reported as `cells[].fileSec`.

### How many frames

1. **Event-driven first.** A sampler returns as many frames as the edit has
   events — usually few, always on something. Start there.
2. **`--limit <N>` for a budget.** Over the limit the list is thinned evenly,
   keeping its first and last entry, and `sampler.limited` reports it. Use it on
   `--per-shot` and `--at-cuts` over a long sequence.
3. **`--between` last.** Evenly spaced midpoints land on no event at all. They
   answer "what is the overall shape", which is exactly what the whole-render
   overview sheet is for — not continuity, not readability, not "what changed".

A sheet costs one image whatever its cell count, so prefer `--grid auto` over a
batch of separate stills whenever more than a couple of frames come back.

Use `--cell-width 640 --cell-height 360` when captions or fine composition must
be legible; the default 320×180 cells are for structure, not for reading text.
Passing one dimension alone derives the other at 16:9, so `--cell-width 640` is
already a 640×360 cell — cells are fitted with `force_original_aspect_ratio`, so
a 640×180 cell would only add black bars around the same 320×180 picture.

### Over MCP

An MCP-connected agent does not need Bash and a file-reading tool for any of
this: `openreelio.frame.extract` takes the same selectors and returns the sheet
**inline** as an MCP `image` block, followed by the usual JSON metadata. It is a
read tool, available without `--allow-write`.

`openreelio.render.range` draws the draft without shelling out:
`{start, end, preset?}` writes into `.openreelio/cache/renders/agent/`, keeps
only the 8 newest drafts, covers at most 300 s of timeline per call, and returns
`{outputPath, durationSec, fileSize, encodingTimeSec, warnings, timelineRange,
nextStep}` — `nextStep` names the `frame.extract` follow-ups below and
`verify {file, fileRange}`. A draft is an excerpt, so pass its
`fileRange: [start, start + durationSec]` — without it the draft reads as a
truncated deliverable and `render.duration_mismatch` fails the candidate.

```jsonc
// tools/call → openreelio.render.range — draw the draft
{ "start": 2, "end": 6 }

// tools/call → openreelio.frame.extract — the draft, swept evenly (first look)
{ "file": "judge/a-range.mp4", "between": [0, 4], "grid": "4x3",
  "labelCells": true }

// tools/call → openreelio.frame.extract — every cut inside a rendered range,
// when the range holds any: a sampler over a range with no such event errors
{ "file": "judge/a-range.mp4", "fileRange": [2, 6], "atCuts": true,
  "grid": "auto", "labelCells": true }

// tools/call → openreelio.frame.extract — the whole render, as one uniform sheet
{ "file": "judge/a.mp4", "grid": "4x3", "between": [0, 90], "labelCells": true }

// tools/call → openreelio.frame.extract — the ranges plan.apply just reported
{ "ranges": [{ "startSec": 4, "endSec": 9.5 }], "grid": "auto", "labelCells": true }

// tools/call → openreelio.frame.extract — the last recorded edit, pinned to your op
{ "affected": true, "afterOp": "<OP_ID>", "grid": "auto", "labelCells": true }

// tools/call → openreelio.frame.extract — continuity at every cut
{ "atCuts": true, "grid": "auto", "limit": 12, "labelCells": true }
```

The samplers carry the same names in camelCase — `ranges`
(`[{startSec, endSec}]`, exactly what `openreelio.plan.apply` returns as
`affectedRanges`), `affected` (with `afterOp`), `atCuts`, `atTransitions`,
`atCaptions`, `atMarkers`, `perShot`, `around` (with `span` and `aroundCount`),
plus `limit` and `grid: "auto"`.

Two differences from the CLI form:

- The render must be **inside the project directory** — `file` is confined
  there, so write candidate renders under the project rather than to a scratch
  path outside it.
- There is no `out`: images land in `.openreelio/cache/frames/<timestamp>/` and
  the written path comes back in the JSON. The cache keeps only its 16 newest
  entries and drops the entry an extraction failed in, so a long judge loop does
  not accumulate inside the project.
- The caps are on cells **and** on pixels: at most 100 cells, at most 12 stills
  in a `times` batch or a sampler batch without `grid`, cells of 64–1024 px, a
  finished sheet no larger than 8000 px on either edge, and `maxWidth` at most
  3840 px. Anything past those is refused as an argument error before a frame is
  extracted. Prefer a sheet — it costs one image whatever its cell count, and
  `grid: "auto"` keeps a sampler to one image however many events it found.

The Bash + Read path above remains correct for CLI agents; nothing about the
rubric or the offsets changes.

## The rubric

Score each dimension 1–5, in this order. The first two rows are deterministic —
read them from the reports before looking at any image, and let them anchor
the visual scores.

| Dimension   | Source | What 5 means |
| ----------- | ------ | ------------ |
| Deliverable | `verify --file` (add `--file-range START END` for a partial render) | Gate, not a score: any error-or-worse finding disqualifies the candidate before judging. |
| Pacing      | `shot.length_stats` (median, p90, count) + `shot.cut_rhythm` | Shot lengths match the brief's tempo; no unmotivated outliers. |
| Hook        | First-row cells of the sheet | Something happens in the first seconds: motion, a face, a claim — not a slate or dead air. |
| Continuity  | `--at-cuts --grid auto` sheet | Cuts land on action or rest; no jump-cut jitter, no mid-gesture amputation. |
| Readability | `--at-captions --grid auto --cell-width 640`, plus `caption.contrast` from `verify --file` | Captions and text legible, inside safe areas, not fighting the background. The check measures the picture behind each bare cue, so read it before scoring by eye. |
| Composition | Full sheet | Subjects framed intentionally; no accidental crops; a consistent look across cells. |

Judge pointwise against this rubric — score each candidate alone, then compare
totals. If two candidates tie, re-judge just those two side by side, and
re-check in the reverse order: position bias is real.

## Persist the judgement

Nothing persists a judgement for you. Write one JSON per session so the choice
survives and the next agent can audit it:

```json
{
  "rubricVersion": 1,
  "baselineIndex": 12,
  "candidates": [
    { "plan": "candidate-a.json", "render": "judge/a.mp4", "sheet": "judge/a-sheet.jpg",
      "verifyPassed": true,
      "scores": { "pacing": 4, "hook": 2, "continuity": 4, "readability": 5, "composition": 4 },
      "notes": "opens on 3s of empty room" },
    { "plan": "candidate-b.json", "render": "judge/b.mp4", "sheet": "judge/b-sheet.jpg",
      "verifyPassed": true,
      "scores": { "pacing": 4, "hook": 5, "continuity": 3, "readability": 5, "composition": 4 },
      "notes": "hard cut at 14.2s lands mid-gesture" }
  ],
  "winner": "candidate-b.json",
  "why": "hook outweighs one rough cut; fix the 14.2s cut after applying"
}
```

The winner's weaknesses become the next fix loop's worklist.

## Cost ladder

| Step | Cost | Use for |
| ---- | ---- | ------- |
| `verify --structural-only` | free, no FFmpeg | pacing stats; disqualifying broken candidates early |
| `frame extract --range START END --grid auto` | cheap | seeing what an apply just did, before rendering |
| timeline sheet (`--grid`, fast mode) | cheap | rough structure before rendering anything |
| `render start --proxy --start/--end` + `--file --file-range` sampler sheet + `verify --file --file-range` | moderate | judging one range of one candidate |
| full proxy render + `--file` sheet + `verify --file` | the judging unit | scoring a candidate |

Two or three strong candidates judged well beat six judged carelessly. Spend
candidates on genuinely different editorial approaches, not parameter jitter.
