# Verify

Deterministic quality control. `verify` is how you answer "is this deliverable?"
with a measurement instead of a guess.

```bash
openreelio-cli verify --path ./demo                       # structural only
openreelio-cli verify --path ./demo --file ./proxy.mp4    # + rendered measurements
openreelio-cli verify --path ./demo --file ./excerpt.mp4 \
  --file-range 10 40                                      # a partial render
openreelio-cli verify --path ./demo --file ./proxy.mp4 \
  --target-lufs=-14 --max-true-peak=-1 --fail-on error [--json-pretty]
```

Without `--file`, only structural checks run and FFmpeg is never invoked.
`--structural-only` states that explicitly and conflicts with `--file`.

Negative numbers need the `=` form: `--target-lufs=-14`, `--max-true-peak=-1`.

## Verifying a partial render

`--file` alone expects a render of the whole sequence from timeline zero. For an
excerpt - anything `render start --start/--end` produced - add
`--file-range START END`, the timeline seconds the file holds (the same pair
`frame extract --file-range` takes):

```bash
openreelio-cli render start --path ./demo --proxy --start 10 --end 40 \
  --output ./excerpt.mp4
openreelio-cli verify --path ./demo --file ./excerpt.mp4 --file-range 10 40
```

The rendered checks then grade the file against that window instead of the whole
sequence, and every detection span is translated before any check sees it, so
**every `timeRange` in the report is a timeline second** whatever was rendered
(`measurements.timebase` is `"timeline"`; `measurements.fileRange` and
`target.fileRange` repeat the declaration). Without it a 30-second excerpt of a
90-second edit reads as a truncated deliverable and `render.duration_mismatch`
fails the run.

`START` must be non-negative and less than `END`, and `--file-range` requires
`--file`; anything else is exit `2`. A file whose own length disagrees with the
declared window by more than a frame adds a `warnings` line rather than failing,
and `render.duration_mismatch` grades a windowed run at warning: the window is
your own claim about a file you rendered on purpose, not a missing
deliverable.

A window that lies entirely *past* the end of the edit is refused outright. It
clips to nothing, so every rendered check would grade an empty span, report
`passed`, and exit `0` on a file nobody looked at - a verdict no `--fail-on`
setting could catch, because there is no violation to grade. It is an impossible
claim about the file, so it is refused like any other bad argument: exit `2`,
before a frame is measured, naming `--file-range` and saying the window "lies
outside the sequence". A window that merely *overhangs* the end still holds real
timeline and stays a `warnings` line.

## Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | Ran and did not breach the `--fail-on` threshold                      |
| `1`  | Ran and breached the threshold                                        |
| `2`  | The tool itself failed (bad arguments, unreadable file, FFmpeg error) |

`--fail-on info|warning|error|critical` defaults to `error`. Taste-adjacent
findings stay at warning/info; `error` is reserved for objectively broken output.
Exit `2` is never "the video is bad" — it means the verdict is unknown.

## Checks

**structural** — `sequence.empty`, `timeline.gap`, `clip.orphan`,
`clip.missing_asset`, `clip.aspect_ratio`, `audio.silent_clip`,
`caption.overlap`, `caption.reading_rate`, `caption.out_of_bounds`,
`caption.safe_area`, `shot.length_stats`, `shot.cut_rhythm`,
`transition.no_handles`, plus opt-in `asset.license` and `sequence.duration`.

`transition.no_handles` (warning) reports every stored dissolve, wipe or slide
the render will degrade to a hard cut, and why — a boundary that is not a
boundary, a clip with no unused source media to blend from, a transition longer
than the shots it joins, a second transition on a clip that already has one. It
needs no rendered file: it asks the same planner the export asks, so the finding
and the file cannot disagree. Each violation carries a `RemoveEffect` fix that
makes the project say what the render will show; repairing the edit instead —
trimming the clips back to free a handle, or shortening the transition — is left
to the caller, because the material to do it with is a judgement call.

**rendered** (require `--file`) — `render.duration_mismatch`,
`render.missing_video`, `render.resolution_mismatch`, `render.black_frames`,
`render.frozen`, `audio.peak`, `audio.clipping`, `audio.loudness`,
`caption.contrast`.

The caption checks report **one violation per caption track**, not one per cue.
`caption.safe_area`, `caption.out_of_bounds` and `caption.reading_rate` list
every offending cue under `metrics.cues` (`clipId`, `startSec`, `endSec` and
that cue's own numbers) and in `entities`, publish those cue windows again as
`metrics.timeRanges` (the violation's own `timeRange` spans the first cue to the
last, which is usually the whole track - hand `metrics.timeRanges` to
`frame extract --ranges` instead), and their `suggestedFix` is a single
plan that repairs all of them - a machine transcript anchored two percent too
low is one mistake, not forty-one, and the fix loop runs once instead of once
per caption. A plan is capped at 200 steps; past that the finding splits into
violations carrying `part`/`partCount`. `autoFixable` is true only when the
steps finish the job: `caption.reading_rate` extends a cue into the following
gap when the gap is long enough (`repair: "extend"`), and otherwise proposes a
split at the nearest word boundary (`repair: "split"`, an `UpdateCaption` +
`CreateCaption` pair whose new half carries the original cue's `style` and
`position`) that a human still has to accept - so that group reports
`autoFixable: false` while still carrying the plan to read.

`render.duration_mismatch` compares the measured file against the length a
full-range render of the sequence writes — clips the export drops (disabled, or
on a muted track) are not counted — and errors when the file is shorter: a stale
or truncated render measures perfectly well and is still not the deliverable.
The tolerance is 0.5s (or two frames, when that is longer) whatever the running
time; `--duration-tolerance-sec` sets it explicitly and is honoured exactly.

`render.missing_video` errors when a sequence that puts something on screen
rendered a file with no video stream. The picture checks read detection lists,
and empty lists cannot tell "clean picture" from "no picture", so
`render.black_frames` and `render.frozen` report `skipped` on such a file
instead of passing over it.

`render.resolution_mismatch` compares the written frame against the canvas: a
different shape errors (the composition was cropped or padded into a frame it
was never composed for), the same shape at a different size is info (a proxy,
or a delivery size), and a resampled frame rate warns.

`render.frozen` reports how much of the program never moves. Held frames,
stills and title cards are info; a program frozen for most of its length is an
error. `render.black_frames` grades on the **total** black in the program the
same way, so a render broken into several dark stretches cannot pass by keeping
each one under half the running time.

`caption.contrast` (warning) asks whether the words can be read, which no
structural check can answer. For each caption cue the file covers it decodes one
frame at the cue's midpoint, measures the luminance of the band the words occupy
and compares it with the text colour. A cue is "already protected" - and never
decoded - only when the export would actually draw the protection: an
`outlineColor` with a non-zero width, or a `backgroundColor` with a non-zero
alpha. An `outlineWidth` with no colour renders bare, and so does a cue with no
style at all, so those are graded like any other bare cue.

Two numbers decide it. A bare cue within `0.35` luminance of its background is
reported (`fault: "lowContrast"`), and so is one whose band varies by more than
`0.2` (`fault: "mixedBackground"`) - a band that is half sky and half shadow has
a comfortable mean and is still half unreadable. Either way the finding carries
`{bandLuminance, bandLuminanceStddev, textLuminance, contrast, minContrast,
maxBandStddev, fault, hasBox, hasOutline}` and an `UpdateCaption` fix applying
the `standard-outline` pack - not `boxed-contrast`, because an outline survives
any background including a mixed one.

The pass is bounded: at most 60 frames per run (spread evenly across the file),
`--timeout-sec` as the budget for the whole pass, and no seek past the end of
the file that was measured. Anything it could not look at is reported as one
`info` finding - "Caption contrast: N of M cue(s) not measured (…)" - so a run
that decoded nothing never reads as `passed`, and `warnings` says the same in
prose. The pass only runs when the check is selected, so `--skip
caption.contrast` really does skip the decodes. Without `--file` the check emits
a single `info` finding - "not measured" - instead of passing over a picture
nobody looked at.

`audio.clipping` reports the flat-topped samples `astats` measures, at warning
— a master limited on purpose measures the same way, and `audio.peak` keeps the
objectively broken half.

`asset.license` and `sequence.duration` run only when named in `--checks`.
Narrow any run with `--checks a,b` or `--skip a,b`.

## Report shape

```json
{
  "status": "warning", "passed": true, "checkedAt": "…", "durationMs": 812,
  "target": { "sequenceId": "…", "renderedFile": "…", "fileRange": null, "measured": true, "selectedChecks": ["…"] },
  "summary": { "critical": 0, "error": 0, "warning": 1, "info": 1, "skipped": 2 },
  "checks": [ { "id": "audio.loudness", "category": "rendered", "status": "warned",
                "passed": false, "severity": "warning", "violationCount": 1, "timeRanges": [],
                "metrics": { }, "autoFixable": true, "suggestedFix": { } } ],
  "measurements": { "measured": true, "fileRange": null, "timebase": "timeline", "durationSec": 12.0,
                    "videoStream": { "width": 1920, "height": 1080, "fps": 30.0 },
                    "blackRanges": [], "freezeRanges": [], "silenceRanges": [],
                    "integratedLufs": -21.8, "loudnessRangeLu": 0.0,
                    "truePeakDbtp": -13.4, "samplePeakDb": -13.4, "flatFactor": 0.0 },
  "warnings": [], "errors": []
}
```

Every check that ran, was skipped, or errored appears in `checks` — so "checked
and clean" is distinguishable from "never looked".

## Reading `passed`

The word means something different at each level, and both are load-bearing.

| Field                | True when                                                          |
| -------------------- | ------------------------------------------------------------------ |
| `checks[].passed`    | The check ran and found **nothing at all**                          |
| top-level `passed`   | No error-or-worse finding anywhere, and no tool error               |

Per check, `status` is `passed` (ran, clean), `warned` (ran, found only
warning/info issues), `failed` (ran, found error or critical), `skipped` (with
`skipReason`), or `errored`. `checks[].passed` is true only for `passed` — a
`warned` check reports `passed: false` and lets `severity` say how loudly.

The top level is the verdict and follows severity alone, so a report can be
`"passed": true` while individual checks are `warned`. Treat `warned` checks as
findings to read, not as failures to fix before shipping.

## The fix loop

`suggestedFix` is `{"description","confidence","steps":[…]}`, and the steps are
already in edit-plan shape. Wrap them in a plan envelope and execute:

```bash
openreelio-cli verify --path ./demo --file ./proxy.mp4 --fail-on warning > report.json
# build fix.json as {"id":"fix_plan","steps": <report.checks[].suggestedFix.steps>}
openreelio-cli plan validate --path ./demo --file fix.json
openreelio-cli plan execute  --path ./demo --file fix.json
openreelio-cli render start  --path ./demo --proxy --output proxy.mp4
openreelio-cli verify --path ./demo --file ./proxy.mp4 --fail-on warning
```

That is the whole loop: **analyze → edit → proxy render → look at frames →
verify → fix → verify again.** Do not declare a job done until `verify` passes at
the threshold you chose.
