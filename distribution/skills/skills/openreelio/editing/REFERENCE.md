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
```

The trim flags are `--source-in` and `--source-out` (source-media in/out points),
not `--in` / `--out`.

`timeline clips` returns each clip's `id`, `trackId`, `assetId`,
`timelineInSec`, `durationSec`, `sourceInSec`, `sourceOutSec`, and `speed` —
enough to plan the next edit without dumping full state.

## Every backend command: `command execute`

The convenience verbs cover the common cuts. The full editor surface — 79
command types including effects, masks, keyframes, compound clips, adjustment
layers, audio ducking, blend modes, markers, freeze frames, time remapping — is
reachable directly.

```bash
openreelio-cli command schema                                    # list all 79 types
openreelio-cli command validate --type RenameTrack --payload '{…}'
openreelio-cli command execute  --path ./demo --type SplitClip \
  --payload '{"sequenceId":"…","trackId":"…","clipId":"…","splitTime":5}'
```

Payloads are camelCase JSON objects matching the IPC payload format. Use
`--payload-file <FILE>` when the JSON is large or shell quoting is awkward.
`command validate` runs the same strict parser without touching the project —
check before you execute.

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

A curated pacing profile is one name for the four decisions an automated cut has
to make — mean shot length, how far shots swing either side of it, which
transition to place, and how often. `plan from-profile` turns that name into an
edit plan over one asset.

```bash
openreelio-cli packs list --kind pacing
```

| Profile | Target shot | Variance | Tempo | Transition | Snaps to shot changes |
| ------- | ----------- | -------- | ----- | ---------- | --------------------- |
| `shorts-hook-fast` | 1.8 s | 0.6 s | fast | none, hard cuts | yes |
| `music-montage` | 1.5 s | 0.2 s | fast | none, hard cuts | no |
| `dynamic-social` | 2.5 s | 1.0 s | moderate | `dissolve-soft` every 4 cuts | yes |
| `steady-documentary` | 4.5 s | 1.5 s | moderate | `dissolve-standard` every 3 cuts | yes |
| `calm-longform` | 7.0 s | 2.0 s | slow | `dissolve-long` every 2 cuts | yes |

Each listed entry carries `id`, `aliases`, `tempo`, `targetShotSec`,
`shotVarianceSec`, `transitionRecipe`, `transitionEveryN`, and
`respectShotBoundaries`. Ids resolve case- and separator-insensitively and accept
the aliases (`shorts`, `montage`, `social`, `doc`, `calm`, …). `transitionEveryN`
counts cut boundaries from the first, so `3` places one on the 1st, 4th, and 7th
cut.

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
`transitionRecipe`, `fidelityScore`, `warnings`, `errors`, `outputPath`, and the
plan inlined under `plan` — and writes the bare plan to `--out`. `--track-name`
defaults to `Pacing: <profile>`.

The plan file is ordinary JSON: read it, move a split time, drop a step, then
validate. It builds its own video track (`AddTrack`), inserts the asset
(`InsertClip`), splits it (`SplitClip` per cut), and adds any transitions
(`AddEffect`). Steps reference ids that earlier steps create —
`{"$fromStep": "step-0", "$path": "createdIds.0"}` — so the plan has to run whole
through `plan execute`, not step by step through `command execute`.
`plan validate` rejects a reference whose target step is not ordered behind it
via `dependsOn`.

Then render and look: `render start --proxy`, a `frame extract --grid` contact
sheet, and the pointwise rubric in [Judging](../judging/REFERENCE.md). A profile
is also a natural axis for best-of-N — two profiles are two candidates.

## What a pacing profile does not decide

A profile decides pace and transition cadence. Nothing else.

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
