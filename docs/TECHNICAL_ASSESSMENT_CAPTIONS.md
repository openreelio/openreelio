# Captions: Technical Assessment & QA Report

## Scope

This report covers the captions command flow and replay integrity across:

- Frontend command emission (`UpdateCaption`)
- Backend IPC parsing/execution (`execute_command`)
- Event-sourcing persistence (`ops.jsonl`)
- Replay into state (`ProjectState::apply_operation`)
- Caption data models serialization compatibility

## Key Findings

### 1) Functional defect: `UpdateCaption` was emitted but not supported

- The frontend emits `execute_command` with `commandType: "UpdateCaption"`.
- The backend IPC command parser (`CommandPayload`) did not support `UpdateCaption`.
- Result: caption edits from the Inspector could not be applied and would fail at runtime.

### 2) Event-sourcing integrity defect: caption ops were no-ops on replay

- `OpKind::{CaptionAdd, CaptionRemove, CaptionUpdate}` existed.
- `ProjectState::apply_caption_*` were placeholders that did nothing.
- Result: even if caption operations were logged, reloading/replaying would lose caption changes.

### 3) Cross-layer serialization mismatch (caption positioning)

- `CaptionPosition` was tagged `type` but used `snake_case` field renaming, producing `margin_percent`.
- The frontend type expects `marginPercent`.
- Result: future IPC/state serialization would be brittle and type-unsafe.

### 4) Tooling quality gate: TypeScript type-check was failing

- `tsc --noEmit` failed due to unused imports/variables in a test file.
- Result: CI/type-safety gate would be red even without code changes.

## Implemented Fixes

### A) IPC parsing: add `UpdateCaption` payload support

- Added `CommandPayload::UpdateCaption` (camelCase fields, `clipId` alias supported).
- Accepted forward-compatible fields (`style`, `position`) to avoid rejecting UI/QC payloads.

### B) Core commands: implement caption commands

- Added `CreateCaptionCommand`, `DeleteCaptionCommand`, `UpdateCaptionCommand`.
- Caption edits update clips on `TrackKind::Caption` tracks (caption text stored in `Clip.label`).
- Defensive validation:
  - Time range must be finite, non-negative, and `start < end`.
  - Caption clips force `speed = 1.0` to avoid division-by-zero or drift in computed durations.

### C) Event replay: implement caption operation handlers

- Implemented `ProjectState::{apply_caption_add, apply_caption_remove, apply_caption_update}`.
- Replay now updates caption clips deterministically based on op payload.

### D) Serialization: align `CaptionPosition` with frontend expectations

- `CaptionPosition` now uses `camelCase` field renaming.
- Added an alias for legacy `margin_percent` during deserialization.

### E) Diagnostics: add lightweight tracing

- `ipc::execute_command` logs completion with elapsed time and op id at `debug` level.
- `UpdateCaptionCommand` logs key identifiers and which fields are being updated at `debug` level.

### F) TypeScript hygiene: unblock `tsc --noEmit`

- Removed unused imports/variables in `SearchBar.test.tsx`.

## QA: Destructive Test Scenarios

### Covered by automated tests

- **Invalid IPC payload variant**: `UpdateCaption` must be parseable (unit test).
- **Replay correctness**: `CaptionUpdate` modifies label and time range (unit test).
- **Invalid time range**: end-before-start is rejected (unit test).
- **Negative timestamps**: rejected as validation error (unit test).

### Recommended additional scenarios (not yet automated here)

- **Large caption text**: verify UI responsiveness and storage limits if needed.
- **Rapid consecutive edits**: consider command coalescing/merging to reduce ops spam.
- **Corrupt ops lines**: ensure replay fails fast with actionable errors, or quarantines invalid ops.
- **Mixed legacy fields**: ensure both `captionId` and `clipId` are accepted where applicable.

## Security Review Notes

- **Injection/XSS**: caption text is treated as plain text (React escapes by default). Avoid
  `dangerouslySetInnerHTML` when rendering captions; if ever required, sanitize explicitly.
- **Input validation**: caption time updates now validate finiteness and ordering.
- **Privilege leakage**: no new filesystem/network or privileged APIs were introduced.

## Performance Notes

- `UpdateCaption` may be called frequently (typing). Logging remains at `debug` level to avoid
  production spam by default.
- If caption editing becomes chatty, implement command merging/coalescing at the executor layer.

## Residual Risks

- Captions are currently represented as timeline clips. Until a dedicated caption model is wired
  end-to-end, style/position fields remain forward-compatible inputs but are not applied to state.
- The frontend refreshes full project state after every command; this can become a bottleneck for
  large projects and may require incremental state updates or event streaming.

