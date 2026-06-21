# Caption Agent Sync Fix Plan

Status: implemented on `fix/caption-agent-sync-style`.
Date: 2026-06-21

## Problem

Automatic caption generation could drift away from edited timeline clips when an
agent transcribed a source asset and imported the source-relative segment times
directly onto the timeline. Long CJK or sung captions could also be split by
character proportion instead of real token timing, and non-speech markers such as
`[Music]` could become visible subtitle cues.

## Implemented Scope

1. Timeline-relative caption mapping
   - Sequence transcription remains the default captioning path because it
     returns timeline-relative segments.
   - Source-asset transcription is treated as source-relative.
   - Source segments are mapped through the hosting clip when a `clipId` is
     provided.
   - Constant speed, trims, and timeline offsets are supported.
   - Active time-remap curves are rejected with guidance to transcribe the
     sequence audio mix instead.

2. Word-timed subtitle splitting
   - Whisper token timestamps are collected and grouped into word timings.
   - Long cues split on timed word boundaries.
   - CJK characters are treated as individual word units so Korean, Japanese,
     and Chinese captions can split cleanly.
   - The previous character-proportion splitter remains as a fallback when word
     timing coverage is unavailable or incomplete.

3. Non-speech cue filtering
   - Pure non-speech markers such as `[Music]`, `(music)`, `[Applause]`,
     musical-note glyphs, and localized music annotations are dropped from
     subtitle-ready cues.
   - Inline annotations inside real dialogue are preserved.

4. Robust language detection
   - Automatic language detection samples multiple windows across the audio.
   - Vocal sections can outvote non-speech or instrumental intros.
   - Explicit user language overrides are still honored.

5. Model quality guardrails
   - Quantized large-v3 family models are listed in the local Whisper catalog.
   - `large-v3-turbo-q5_0` is the recommended balanced default.
   - Agent tools auto-provision the recommended model when an implicit weak
     model would otherwise be used.
   - The direct UI path prompts before running with tiny/base/small when the
     recommended model is available but not installed.

6. Caption style consistency
   - Agents can inspect caption style defaults and existing caption overrides.
   - Generated captions can carry style and position metadata.
   - Omitting style keeps the track default.

## Key Files

- `src-tauri/src/core/captions/mapping.rs`
- `src-tauri/src/core/captions/whisper.rs`
- `src-tauri/src/core/commands/caption.rs`
- `src-tauri/src/ipc/commands/transcription.rs`
- `crates/openreelio-cli/src/commands/caption.rs`
- `crates/openreelio-cli/src/commands/transcription.rs`
- `src/agents/tools/captionTools.ts`
- `src/agents/engine/core/orchestrationPlaybooks.ts`
- `src/components/explorer/ProjectExplorer.tsx`
- `src/components/features/transcription/TranscriptionDialog.tsx`
- `src/hooks/transcriptionModelGate.ts`

## Verification Targets

- Rust caption mapping and import tests.
- Whisper subtitle splitting, CJK, non-speech, and model catalog tests.
- IPC transcription status compatibility tests.
- Agent caption tool and playbook tests.
- Transcription dialog and model gate tests.
- TypeScript binding regeneration after IPC DTO changes.
