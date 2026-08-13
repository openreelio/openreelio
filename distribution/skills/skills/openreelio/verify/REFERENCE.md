# Verify

Deterministic quality control. `verify` is how you answer "is this deliverable?"
with a measurement instead of a guess.

```bash
openreelio-cli verify --path ./demo                       # structural only
openreelio-cli verify --path ./demo --file ./proxy.mp4    # + rendered measurements
openreelio-cli verify --path ./demo --file ./proxy.mp4 \
  --target-lufs=-14 --max-true-peak=-1 --fail-on error [--json-pretty]
```

Without `--file`, only structural checks run and FFmpeg is never invoked.
`--structural-only` states that explicitly and conflicts with `--file`.

Negative numbers need the `=` form: `--target-lufs=-14`, `--max-true-peak=-1`.

Measured times are file-relative while structural findings are
timeline-relative, so `--file` expects a render of the whole sequence from zero.

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

**structural** — `timeline.gap`, `clip.orphan`, `clip.missing_asset`,
`clip.aspect_ratio`, `audio.silent_clip`, `caption.overlap`,
`caption.reading_rate`, `caption.out_of_bounds`, `caption.safe_area`,
`shot.length_stats`, `shot.cut_rhythm`, plus opt-in `asset.license` and
`sequence.duration`.

**rendered** (require `--file`) — `render.black_frames`, `audio.peak`,
`audio.loudness`.

`asset.license` and `sequence.duration` run only when named in `--checks`.
Narrow any run with `--checks a,b` or `--skip a,b`.

## Report shape

```json
{
  "status": "warning", "passed": true, "checkedAt": "…", "durationMs": 812,
  "target": { "sequenceId": "…", "renderedFile": "…", "measured": true, "selectedChecks": ["…"] },
  "summary": { "critical": 0, "error": 0, "warning": 1, "info": 1, "skipped": 2 },
  "checks": [ { "id": "audio.loudness", "category": "rendered", "status": "failed",
                "severity": "warning", "violationCount": 1, "timeRanges": [],
                "metrics": { }, "autoFixable": true, "suggestedFix": { } } ],
  "measurements": { "measured": true, "durationSec": 12.0,
                    "blackRanges": [], "freezeRanges": [], "silenceRanges": [],
                    "integratedLufs": -21.8, "loudnessRangeLu": 0.0,
                    "truePeakDbtp": -13.4, "samplePeakDb": -13.4, "flatFactor": 0.0 },
  "warnings": [], "errors": []
}
```

Every check that ran, was skipped, or errored appears in `checks` — so "checked
and clean" is distinguishable from "never looked". `status` per check is
`passed`, `failed`, `skipped`, or `errored`, with `skipReason` when skipped.

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
