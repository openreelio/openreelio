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
