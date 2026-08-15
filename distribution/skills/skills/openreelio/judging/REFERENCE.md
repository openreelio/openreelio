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
openreelio-cli render start  --path ./demo --proxy --output ./judge/a.mp4 --progress
openreelio-cli frame extract --path ./demo --file ./judge/a.mp4 \
  --grid 4x3 --between 0 <RENDER_END> --label-cells --out ./judge/a-sheet.jpg
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
A timeline sheet in fast mode omits effects, text, and compositing — exactly
the things being judged — and a composite sheet re-renders per cell. The
`--file` sheet is cheap (fast seeks into an existing render) and shows the same
pixels `verify --file` measured, so scores and measurements describe one
artifact. In `--file` mode cells map back as `fileSec` (the render's own
timebase).

Cut-boundary sheets beat uniform sheets for continuity judging: read each
clip's `timelineInSec` from `timeline clips`, and sample the frame **before**
each cut at `cut − 1.5/fps` and the frame **after** it at the cut time itself.

The offsets are asymmetric on purpose. `frame extract` seeks with `-ss` before
`-i`, which resolves **forward**: it returns the first frame whose PTS is ≥ the
requested time. So the cut time itself already gives the incoming shot, while
`cut − 1.5/fps` is the only offset guaranteed to land on the last outgoing frame
at every timebase. A symmetric `±0.04 s` is not: at 24 fps one frame is 0.0417 s,
so `cut − 0.04` resolves forward across the cut and both cells show the incoming
shot — a sheet that looks like a valid before/after and is not.

At 25 fps (1.5/fps = 0.06) with cuts at 5.0 / 9.2 / 14.2:

```bash
openreelio-cli timeline clips --path ./demo    # cut times = clip starts > 0
openreelio-cli frame extract  --path ./demo --file ./judge/a.mp4 \
  --grid 6x2 --times 4.94,5.0,9.14,9.2,14.14,14.2 \
  --label-cells --out ./judge/a-cuts.jpg
```

`--label-cells` burns the **requested** time, not the decoded frame's PTS, so a
label is proof of which cell you are looking at, never proof that the frame came
from the side of the cut you wanted. Derive the offsets from the render's real
fps (`verify --file` reports it) rather than reusing these numbers.

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

```jsonc
// tools/call → openreelio.frame.extract
{ "file": "judge/a.mp4", "grid": "4x3", "between": [0, 90], "labelCells": true }
```

Two differences from the CLI form:

- The render must be **inside the project directory** — `file` is confined
  there, so write candidate renders under the project rather than to a scratch
  path outside it.
- There is no `out`: images land in `.openreelio/cache/frames/<timestamp>/` and
  the written path comes back in the JSON. The cache keeps only its 16 newest
  entries and drops the entry an extraction failed in, so a long judge loop does
  not accumulate inside the project.
- The caps are on cells **and** on pixels: at most 100 cells, at most 12 stills
  in a `times` batch, cells of 64–1024 px, a finished sheet no larger than
  8000 px on either edge, and `maxWidth` at most 3840 px. Anything past those is
  refused as an argument error before a frame is extracted. Prefer a sheet — it
  costs one image whatever its cell count.

The Bash + Read path above remains correct for CLI agents; nothing about the
rubric or the offsets changes.

## The rubric

Score each dimension 1–5, in this order. The first two rows are deterministic —
read them from the reports before looking at any image, and let them anchor
the visual scores.

| Dimension   | Source | What 5 means |
| ----------- | ------ | ------------ |
| Deliverable | `verify --file` | Gate, not a score: any error-or-worse finding disqualifies the candidate before judging. |
| Pacing      | `shot.length_stats` (median, p90, count) + `shot.cut_rhythm` | Shot lengths match the brief's tempo; no unmotivated outliers. |
| Hook        | First-row cells of the sheet | Something happens in the first seconds: motion, a face, a claim — not a slate or dead air. |
| Continuity  | Cut-boundary sheet | Cuts land on action or rest; no jump-cut jitter, no mid-gesture amputation. |
| Readability | ≥640-wide cells | Captions and text legible, inside safe areas, not fighting the background. |
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
| timeline sheet (`--grid`, fast mode) | cheap | rough structure before rendering anything |
| `render start --proxy --start/--end` + `--file` sheet | moderate | judging one range of one candidate |
| full proxy render + `--file` sheet + `verify --file` | the judging unit | scoring a candidate |

Two or three strong candidates judged well beat six judged carelessly. Spend
candidates on genuinely different editorial approaches, not parameter jitter.
