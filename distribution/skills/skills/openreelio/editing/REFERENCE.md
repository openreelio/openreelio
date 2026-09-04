# Editing

Every edit is a command appended to the project's op log. Nothing mutates state
outside that path, which is why undo and replay always work.

## Timeline verbs

```bash
openreelio-cli timeline info    --path ./demo
openreelio-cli timeline tracks  --path ./demo
openreelio-cli timeline clips   --path ./demo [--track <TRACK_ID>]

openreelio-cli timeline insert  --path ./demo --asset <ASSET_ID> --track <TRACK_ID> --at 0.0
openreelio-cli timeline trim    --path ./demo --clip <CLIP_ID> --track <TRACK_ID> \
                                --source-in 0 --source-out 12
openreelio-cli timeline split   --path ./demo --clip <CLIP_ID> --track <TRACK_ID> --at 6.0
openreelio-cli timeline move    --path ./demo --clip <CLIP_ID> --track <TRACK_ID> --to 10.0 \
                                [--new-track <TRACK_ID>]
openreelio-cli timeline speed   --path ./demo --clip <CLIP_ID> --track <TRACK_ID> \
                                --speed 2.0 [--reverse]
openreelio-cli timeline remove  --path ./demo --clip <CLIP_ID> --track <TRACK_ID>

openreelio-cli timeline add-track    --path ./demo --kind video --name "Video 2"
openreelio-cli timeline remove-track --path ./demo --track <TRACK_ID>

openreelio-cli timeline set-format --path ./demo --fps 25 --width 1080 --height 1920
```

The trim flags are `--source-in` and `--source-out` (source-media in/out points),
not `--in` / `--out`.

> **`timeline insert` places a 10-second clip.** `asset import` records no probed
> duration, so the length is the default regardless of the file, and a second
> `timeline insert --at 4.0` is refused as an overlap. Trim each clip to its real
> length — `analysis shots` gives `totalDurationSec` — before inserting after it.

`timeline set-format` changes the sequence's frame rate, canvas size and audio
format. Every option is optional and at least one is required; the rest keep
their current value. A decimal `--fps` snaps to the exact broadcast rational
(`29.97` → `30000/1001`, `23.976` → `24000/1001`); canvas edges must be even and
within `16..=16384`. Changing the frame rate re-times nothing — the timeline is
stored in seconds — and changing the canvas leaves clip transforms alone, because
they are canvas-relative; what changes is how each source fits the new frame.
`timeline info` reports the result as `fps`, `fpsRatio` and `canvas`.

`timeline clips` returns each clip's `id`, `trackId`, `assetId`,
`timelineInSec`, `durationSec`, `sourceInSec`, `sourceOutSec`, and `speed` —
enough to plan the next edit without dumping full state.

## Every backend command: `command execute`

The convenience verbs cover the common cuts. The full editor surface — 79
command types including effects, masks, keyframes, compound clips, adjustment
layers, audio ducking, blend modes, markers, freeze frames, time remapping — is
reachable directly.

```bash
openreelio-cli command schema                                    # list all 80 types
openreelio-cli command validate --type RenameTrack --payload '{…}'
openreelio-cli command execute  --path ./demo --type SplitClip \
  --payload '{"sequenceId":"…","trackId":"…","clipId":"…","splitTime":5}'
```

Payloads are camelCase JSON objects matching the IPC payload format. Use
`--payload-file <FILE>` when the JSON is large or shell quoting is awkward.
`command validate` runs the same strict parser without touching the project —
check before you execute.

## Framing a clip: transform and opacity

`SetClipTransform` places a clip on the canvas with normalized coordinates, and
`SetClipOpacity` fades it. Both render in the final export, not just the preview:

```bash
openreelio-cli command execute --path ./demo --type SetClipTransform \
  --payload '{"sequenceId":"…","trackId":"…","clipId":"…","transform":{
    "position":{"x":0.25,"y":0.25},"scale":{"x":0.5,"y":0.5},
    "rotationDeg":0,"anchor":{"x":0.5,"y":0.5}}}'

openreelio-cli command execute --path ./demo --type SetClipOpacity \
  --payload '{"sequenceId":"…","trackId":"…","clipId":"…","opacity":0.5}'
```

- `position` is where the **anchor** lands on the canvas, as a fraction of it —
  `{0.5, 0.5}` is the centre. `anchor` is the point of the picture that gets
  pinned there, also normalized, and rotation turns about it.
- `scale` multiplies the letterbox fit, so `{1, 1}` is "fitted to the canvas"
  and `{0.5, 0.5}` is a quarter of its area.
- The placement is measured against the source's real pixel size, so a 4:3 clip
  in a 16:9 sequence keeps its shape.

Two limits still apply. **Motion keyframes**
(`SetClipMotionKeyframes`) animate in the preview but render static at the
clip's base transform, and `render start` reports a warning saying so.
**Simultaneous layered clips** — two visible video clips overlapping in time,
which is what picture-in-picture needs — and **blend modes** are still rejected
by export validation. A transform is for framing one clip at a time.

## Transitions

Transitions are effects — there is no `AddTransition` command. `AddEffect`
accepts a curated `recipe` instead of an `effectType` plus hand-picked params:

```bash
openreelio-cli packs list --kind transition

openreelio-cli command execute --path ./demo --type AddEffect \
  --payload '{"sequenceId":"…","trackId":"…","clipId":"…","recipe":"dissolve-soft"}'
```

The recipes are `dissolve-soft` / `dissolve-standard` / `dissolve-long`,
`fade-in` / `fade-out`, `wipe-left` / `wipe-right` / `wipe-up` / `wipe-down`,
and `slide-left` / `slide-right`. Each supplies the effect type plus the
duration and direction that go with it, so the choice is one token rather than
four guesses.

Like caption packs, a recipe is a base layer: `params` overrides it key by key
(`{"recipe":"dissolve-soft","params":{"duration":1.5}}`). Naming a recipe *and*
a contradictory `effectType` is rejected rather than silently resolved.
`fade-out` is anchored on the clip's tail when the command executes — it reads
the target clip's duration — so pass `params.start_time` only to put the fade
somewhere else in the clip.

### What actually renders today

| Recipe family | Rendered by `render start` |
| ------------- | -------------------------- |
| `fade-in`, `fade-out` | **Yes.** Single-input filters in the clip's own chain. |
| `dissolve-*`, `wipe-*`, `slide-*` | **Yes, when both clips have handles.** The picture and the sound crossfade together and the file stays exactly as long as the timeline. Otherwise the boundary renders as a hard cut and the render reports a warning naming the clip, the effect and the reason. |

A two-input transition needs the outgoing and incoming pictures at once, and
overlapping them the naive way shortens the video stream while every clip's
audio stays at its absolute timeline position — the render would drift out of
sync and end before the timeline does. So the blend costs the timeline nothing.
Both clips reach into source media the edit is not using instead: the outgoing
clip plays half the transition past its out point, the incoming clip starts half
of it early, and the overlap consumes exactly what they added.

**A transition therefore needs half its length of unused source on each side.**
For a one-second dissolve that is half a second past the outgoing clip's out
point and half a second before the incoming clip's in point. Clips trimmed out
of longer sources have it; a clip using every frame of its source does not — so
trim before you dissolve.

The render falls back to a cut, naming the clip, the effect and the reason, when:

1. the effect is not on a video track — there is no picture to blend;
2. its track is hidden;
3. the clip carrying it is disabled;
4. it is on an adjustment layer, which grades what is beneath it rather than
   contributing a picture;
5. it is on a text clip, which is drawn over the finished picture;
6. no clip starts where the carrier ends on the same track — a gap, or the last
   clip on the track;
7. the clip that does start there contributes no picture either, for any of
   reasons 1-5;
8. the clip already carries another two-input transition — a clip has one out
   point, so the first wins and later ones are refused by name;
9. the `duration` is not positive, or exceeds the **10 s** cap the engine will
   place (a guard against milliseconds arriving where seconds were meant);
10. the duration is **not shorter than both** shots it joins;
11. either clip is frozen, reversed or time-remapped, so its render window has
    no defined reach into source;
12. the outgoing asset's length was never measured, so the handle cannot be
    proven — re-import the asset or run `analysis run`;
13. either side is short of handle — the warning says which side, how much it
    has, and how much was needed.

A transition that *does* render can still draw a warning: a blend across a
**razor split**, where the outgoing clip's out point is the incoming clip's in
point in the same source, mixes every frame with itself and cannot be seen. It
renders, and the render says it will be invisible. Trim material at the boundary
first.

**Audio on a separate track is not crossfaded.** Only the sound travelling with
the two blended clips is faded. Detached audio, a music bed or a separate
narration take keeps whatever fades it was authored with, so a hard edit there
is still heard as a hard edit under a dissolving picture — author
`fade_in_sec`/`fade_out_sec` on those clips to match.

An eligible transition produces no warning at all. Where handles are impossible,
`fade-out` on the outgoing clip plus `fade-in` on the incoming one still gives a
soft-looking cut.

`verify` reports the same refusals as the structural check
`transition.no_handles`, with no rendered file needed: it asks the same planner
the render asks, and carries a `RemoveEffect` fix for each transition that will
not survive.

## Atomic batches: `plan execute`

An edit plan is:

```json
{
  "id": "plan_001",
  "steps": [
    { "id": "step_1", "commandType": "SplitClip", "payload": { }, "dependsOn": [] },
    { "id": "step_2", "commandType": "MoveClip",  "payload": { }, "dependsOn": ["step_1"] }
  ]
}
```

Steps run in dependency order, and the whole plan rolls back if any step fails.
The whole plan is validated before anything mutates; plans are capped at 1000
steps.

```bash
openreelio-cli plan template --type split-and-move
openreelio-cli plan validate --path ./demo --file plan.json
openreelio-cli plan execute  --path ./demo --file plan.json
```

`plan execute` returns `{"status","planId","stepsExecuted","stepResults":[…]}`
and has its own exit codes: `0` applied and saved, `1` rejected or failed and
rolled back cleanly, `2` the tool failed, the rollback was incomplete
(`rollbackIncomplete: true`), or the plan applied but could not be saved
(`appliedNotSaved: true`). On `appliedNotSaved` the work is already durable —
do **not** re-run the plan; re-running is a double apply.

Prefer a plan over a sequence of individual commands whenever the steps only make
sense together — a half-applied multi-step edit is worse than none.

## Pacing profiles: `plan from-profile`

A curated pacing profile is one name for the decisions an automated cut has to
make — mean shot length, how far shots swing either side of it, and whether cuts
land on detected shot changes. `plan from-profile` turns that name into an edit
plan over one asset.

Every shipped profile cuts hard. `transitionRecipe` and `transitionEveryN` stay
in the schema, still reserved — but not for want of handles. A profile cuts one
asset into many clips, so every boundary it makes is a razor split: both sides
have all the unused source media a blend could want, and the renderer would
blend each one happily. Both sides are also the *same* footage at the *same*
frame, so the blend mixes every frame with itself and renders identically to the
cut it replaced. A profile that advertised a dissolve would be advertising an
effect the file cannot show. Producing boundaries with material to blend
between — different shots, or clips trimmed back at the cut — is a separate
piece of work.

```bash
openreelio-cli packs list --kind pacing
```

| Profile | Target shot | Variance | Tempo | Snaps to shot changes |
| ------- | ----------- | -------- | ----- | --------------------- |
| `shorts-hook-fast` | 1.8 s | 0.6 s | fast | yes |
| `music-montage` | 1.5 s | 0.2 s | fast | no |
| `dynamic-social` | 2.5 s | 1.0 s | moderate | yes |
| `steady-documentary` | 4.5 s | 1.5 s | moderate | yes |
| `calm-longform` | 7.0 s | 2.0 s | slow | yes |

Each listed entry carries `id`, `aliases`, `tempo`, `targetShotSec`,
`shotVarianceSec`, `transitionRecipe` (always `null` today), `transitionEveryN`
(always `0`), and `respectShotBoundaries`. Ids resolve case- and
separator-insensitively and accept the aliases (`shorts`, `montage`, `social`,
`doc`, `calm`, …).

Run analysis first. The plan needs the source duration, and shot boundaries are
what let cuts land on real shot changes rather than on the profile's own grid.
With no cached bundle the command fails and names `analysis run`.

```bash
openreelio-cli analysis run      --path ./demo --id <ASSET_ID> --shots
openreelio-cli plan from-profile --path ./demo --profile dynamic-social \
  --asset <ASSET_ID> [--sequence <SEQUENCE_ID>] [--track-name "Cut"] --out plan.json
openreelio-cli plan validate     --path ./demo --file plan.json
openreelio-cli plan execute      --path ./demo --file plan.json
openreelio-cli verify            --path ./demo --structural-only
```

`from-profile` mutates nothing. It prints one JSON object — `status`, `planId`,
`profile`, `assetId`, `sequenceId`, `stepCount`, `cutCount`, `transitionCount`,
`transitionRecipe`, `fidelityScore`, `warnings`, `errors`, `stepsWithReferences`,
`outputPath`, and `plan`. With `--out` the plan goes to that file and `plan` is
`null` on stdout — the summary plus the path, not a second copy of a file you can
read; without `--out` the plan is inlined instead. `--track-name` defaults to
`Pacing: <profile>`.

A source too short to cut is not a failure: the plan still creates the track and
places the clip, `cutCount` is `0`, and `warnings` says why — a source under 1.5x
the target shot rounds to a single shot. Read `warnings` before drawing any
conclusion from a low `cutCount`.

The plan file is ordinary JSON: read it, move a split time, drop a step, then
validate. It builds its own video track (`AddTrack`), inserts the asset
(`InsertClip`) and splits it (`SplitClip` per cut). Steps reference ids that
earlier steps create —
`{"$fromStep": "step-0", "$path": "createdIds.0"}` — so the plan has to run whole
through `plan execute`, not step by step through `command execute`.
`plan validate` rejects a reference whose target step is not ordered behind it
via `dependsOn`, and lists every step carrying one under `stepsWithReferences`:
those payloads are only fully checked once the reference resolves at execute.

Then render and look: `render start --proxy`, a `frame extract --grid` contact
sheet, and the pointwise rubric in [Judging](../judging/REFERENCE.md). A profile
is also a natural axis for best-of-N — two profiles are two candidates.

## What a pacing profile does not decide

A profile decides pace. Nothing else.

- **No transitions.** Every shipped profile cuts hard. A dissolve added by hand
  does render, given handles on both sides of the boundary — the planner just
  does not place one for you.
- **No beat sync.** The analysis bundle carries BPM as a single average scalar,
  not a beat grid. `music-montage` is metronomic, not beat-locked. Cutting on the
  beat needs analysis that does not exist yet.
- **No content awareness beyond shot boundaries.** The planner does not know what
  is in frame, whether a sentence finished, or whether a face is mid-blink.
  `respectShotBoundaries` snapping — a cut moves at most half a target shot to
  reach a detected shot change — is the whole of it, and it does nothing without
  cached shot detection.
- **No randomness.** Shot lengths alternate deterministically, half a variance
  either side of the target, then scale to fill the source. The same profile on
  the same source always yields the same plan. That is what makes reviewing the
  plan worth doing; it is not a claim of variety.
- **`fidelityScore` is not a quality score.** It measures how close the mean
  generated shot is to the profile's target and says nothing about whether the
  edit is any good. That judgement is the judging loop's job.

## Undo and history

```bash
openreelio-cli timeline undo  --path ./demo
openreelio-cli timeline redo  --path ./demo
openreelio-cli state ops      --path ./demo --last 20
openreelio-cli state history  --path ./demo [--last 20]
openreelio-cli state jump     --path ./demo --index 4
openreelio-cli state dump     --path ./demo [--sequence <SEQUENCE_ID>]
openreelio-cli state snapshot --path ./demo
```

`state ops` is the cheapest way to see what actually happened; `state dump` is
the full derived state and can be large.

`state history` lists the persisted edit history as one index space —
`{appliedCount, redoCount, currentIndex, entries:[{index, opId, commandType,
timestamp}]}` — where `currentIndex` is the last applied entry (`-1` when
everything is undone). `state jump --index N` repositions history after entry
`N` in one step (`--index=-1` undoes everything) and persists the move. Any new
mutating command after a jump clears the redo branch — to return to an unwound
state, re-apply its plan JSON rather than counting on redo.
