# Audit Remediation Plan — 2026-08 Agent-Native Delta

**Source**: no-trust adversarial audit (48 agents, 8 lenses) of everything since `7f256808` — PRs #785 (perception/verify), #786 (distribution), the release/npm pipeline, and the unmerged `feature/external-edit-safety` (PR #788). 38 confirmed findings: 3 CRITICAL, 14 HIGH, 18 MEDIUM, 2 LOW.

## Engineering principle for this remediation

Do not patch 38 symptoms. The findings collapse into **8 root causes**; each root cause gets one *altitude-correct* fix plus one *guard test* that makes the whole class non-recurring. The recurring failure of the original work was that subagent "tests pass" meant "my test passes my code", never "the contract holds" — so every fix here must prove the real contract (e.g. a suggested fix actually parses through `CommandPayload::parse`).

---

## Root causes and altitude-correct fixes

### RC-A — QC suggested-fixes were never validated against the command parser
*Findings: C0 (AspectRatioRule `SetTransform`), #3 (BlackFrameRule `trimStart`), #6 (head-gap CloseGap desync).*
The rules hand-write JSON command objects that no `CommandPayload` variant accepts (`deny_unknown_fields`), so `verify`'s headline "agent-executable fix" is rejected 100% of the time.
- **Altitude fix**: one parametrized test that takes *every* `suggestedFix` a rule can emit and asserts it round-trips `CommandPayload::parse`. Correct or drop each broken fix (a violation with no fix is honest; a broken fix is worse).
- **Batch 2 (in flight).**

### RC-B — `verify`'s verdict conflates "no error-severity violation" with "good deliverable"
*Findings: #4 (black render passes), #5 (stale/truncated file graded as deliverable), #16 (`passed:true` with warnings), #18 (empty sequence passes).*
Verify is subtractive ("found nothing at Error") instead of affirmative ("this render corresponds to this timeline and is watchable"). A fully-black render exits 0.
- **Altitude fix**: (1) affirmatively check the rendered file corresponds to the sequence (duration match) — a render that doesn't match the timeline is the top-level failure, not a buried Info; (2) black covering a large fraction of the program stays Error regardless of gap overlap; (3) unambiguous per-check state (passed / warned / failed) so an agent can act; (4) empty sequence is at least a Warning.
- **Batch 2 (in flight).**

### RC-C — The external-edit guard was bolted onto call sites, not the append chokepoint
*Findings: C2 (guard on 1 of ~25 mutation IPCs), #14 (`execute_agent_plan` unguarded — the headline AI path), #17 (workspace auto-registration self-corrupts), #34 (reload baseline race), #35 (frontend agent-tool path shows no reload affordance).*
`ensure_no_external_changes()` was sprinkled into `execute_command` only. Every other mutation (asset import/remove, sequence create, AI plan, transcript edits, source-monitor insert) appends blind. The feature ships **false safety**.
- **Altitude fix**: move the check INTO the single append chokepoint — `CommandExecutor::execute` / `ActiveProject`'s append path — so all 25 paths are covered *by construction*, not by remembering to call a helper. Guard test: a representative spread of IPC mutations all reject after an external append. Fix the reload baseline race (read baseline under the same lock/critical section) and map the typed error to the reload banner on the agent-tool frontend path too.
- **Round 2, on the `feature/external-edit-safety` branch (PR #788 — do not merge until this lands).**

### RC-D — Concurrency primitives applied per-caller instead of at the resource
*Findings: #8 (bundle lock on 1 of 4 writers), #19 (SQLITE_BUSY retry wraps the wrong call, no `busy_timeout`/WAL), #21 (TOCTOU on unlocked profile read), #34 (reload baseline race — shared with RC-C).*
Locks and retries were added at the CLI call site that prompted them, leaving the GUI writers of the same resource unprotected.
- **Altitude fix**: push locking to the resource. Bundle read-modify-write acquires the advisory lock *inside* the shared writer (`analyze_full_with_metadata` and the merge path both), not only in `merge_bundle_update`. `IndexDb::open` sets `busy_timeout` + WAL so every connection tolerates contention and the retry becomes a backstop, not the mechanism. Close the silence-profile TOCTOU by taking the lock before the existence read.
- **Batch 3.**

### RC-E — CLI/MCP trust boundary is undefined
*Findings: C1 (CWD binary trust — DONE batch 1), #11 (`verify --file` unconfined path = disk oracle + outbound-SMB), #26 (`plan.apply` ignores `approval_project_id`), #27 (empty approval token counts as a grant), #28 (policy blocks misreport `--allow-write`).*
The MCP server never defined what filesystem/project scope it is allowed to touch, so each tool improvised.
- **Altitude fix**: define the server's scope once — file arguments confined to the project directory (reject absolute/UNC/`..`-escaping paths uniformly), approval tokens validated for project scope on *every* mutating tool (not just `media.insert`), empty token treated as absent, and the policy document telling the truth about what `--allow-write` grants. C1 already established the "CWD is not trusted" half.
- **Batch 4.**

### RC-F — Persistence writes clobber position-indexed dependent data
*Findings: #7 (replacing `bundle.shots` orphans `frame_analysis`/`contact_sheet`; backfill restores stale ones), #22 (`analysis shots` overwrites rows with `keyframe_path:None`, destroying prior keyframes).*
Shot writes treat the shot list as independent when other slots are indexed by shot position.
- **Altitude fix**: a shots write either preserves/reconciles the dependent slots or explicitly invalidates them (never silently mismatches); never overwrite a populated `keyframe_path` with `None`.
- **Batch 3 (with RC-D — same files).**

### RC-G — Release/publish pipeline gaps
*Findings: #12 (no `--tag` → a prerelease republishes `latest`), #13 (checksum verifies a different file than the one packaged), #29 (`gh api` asset list without `--paginate`, 30-item cap, now 26 assets), #36 (`plugin.json` version drift, not a sync target).*
- **Altitude fix**: derive npm dist-tag from the tag's prerelease component; make the generator hash the exact bytes it packages; paginate all release asset lookups; register `plugin.json` in `sync-version.ts`.
- **Batch 5.**

### RC-H — Docs drift with no enforcement
*Findings: #15 (composite fallback hard-errors on the cases docs advertise), #20 (`analysis shots` exit-code contract), #32 (`.jpg`→`.png` silent rewrite breaks documented contact-sheet examples), #33 (npm README quickstart invalid), #37 (proxy docs say fixed 854x480, code fits canvas).*
- **Altitude fix**: correct docs to match *post-fix* behavior (so this batch runs LAST), fix the one real behavior bug in #15/#32 (composite fallback + extension rewrite), and add a doc-example smoke test where cheap.
- **Batch 6 (last — after code behavior is final).**

---

## Execution sequence (strictly sequential — no concurrent tree-modifying agents)

Each batch: one commit, `cargo fmt --check` + `clippy -D warnings` (cli/core + gui lib) + relevant `cargo test` green, contract/guard test present, before the next batch.

1. **Batch 1 — RC-E(C1) + ffmpeg hardening** — DONE (`de0d2956`).
2. **Batch 2 — RC-A + RC-B** (QC/verify) — in flight.
3. **Batch 3 — RC-D + RC-F** (persistence/concurrency).
4. **Batch 4 — RC-E rest** (MCP trust boundary).
5. **Batch 5 — RC-G** (supply chain).
6. **Batch 6 — RC-H** (docs, last).
7. **Round 2 — RC-C** (external-edit guard centralization, on PR #788 branch).
8. **Final — re-audit** the fixed surfaces to confirm the classes are closed and no regressions introduced.

Batches 1–6 land as one PR (`fix/audit-remediation-round1`) off main. RC-C lands on PR #788. PR #788 stays unmerged until RC-C is done.
