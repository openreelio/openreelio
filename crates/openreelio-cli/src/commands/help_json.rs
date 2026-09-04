//! help-json command: outputs the full CLI schema as JSON for agent consumption.
//!
//! This enables AI agents to discover and use the CLI without parsing --help text.
//! The schema includes command names, descriptions, parameters, types, and examples.

use openreelio_core::style::{pacing_profile_ids, text_preset_ids, NO_TEXT_PRESET, TEXT_PRESETS};

use crate::output;

pub fn execute() -> anyhow::Result<()> {
    output::print_json_pretty(&build_schema())
}

/// Every accepted `text add --preset` value, in registry order.
///
/// Built from the core registry rather than restated, because a hand-kept list
/// here is exactly how the schema came to advertise `quote`, `watermark`, and
/// `countdown` while the parser rejected all three.
fn text_preset_enum() -> Vec<String> {
    std::iter::once(NO_TEXT_PRESET.to_string())
        .chain(text_preset_ids().into_iter().map(str::to_string))
        .collect()
}

/// Every accepted `plan from-profile --profile` value, in registry order.
///
/// Built from the core registry for the same reason the text presets are: a
/// hand-kept copy drifts, and the first symptom is a schema that advertises an
/// id the resolver rejects.
fn pacing_profile_enum() -> Vec<String> {
    pacing_profile_ids()
        .into_iter()
        .map(str::to_string)
        .collect()
}

/// One-line `--preset` description naming the registry as the source of ids.
fn text_preset_desc() -> String {
    format!(
        "Curated text preset id or alias, or '{}' for none. {} presets; each supplies typography, \
         anchor, starter copy, and a default duration. Run 'packs list --kind text' for the full \
         entries",
        NO_TEXT_PRESET,
        TEXT_PRESETS.len()
    )
}

pub(crate) fn build_schema() -> serde_json::Value {
    let pacing_profile_enum = pacing_profile_enum();

    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "description": "OpenReelio CLI — Headless AI agent-driven video editing",
        "commands": {
            "project.create": {
                "description": "Create a new project. The sequence defaults to 30fps 1920x1080; pass --fps/--width/--height to match the delivery format, which is applied through the same logged, undoable 'SetSequenceFormat' command 'timeline set-format' runs. When any of the three is given the result carries a nested 'sequenceFormat' object holding that command's own report — its 'status', 'opId', 'sequenceId', 'fps', 'fpsRatio', 'canvas', 'audioSampleRate', 'audioChannels' and whole-timeline 'affectedRanges' — exactly as 'timeline set-format' prints them at the top level; the key is absent when none was given",
                "params": {
                    "name": { "type": "string", "required": true, "desc": "Project name" },
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "fps": { "type": "number", "required": false, "desc": "Sequence frame rate, e.g. 25, 29.97, 23.976. Decimals snap to the exact broadcast rational (29.97 becomes 30000/1001). Default 30" },
                    "width": { "type": "number", "required": false, "desc": "Canvas width in pixels; even, 16..=16384. Default 1920" },
                    "height": { "type": "number", "required": false, "desc": "Canvas height in pixels; even, 16..=16384. Default 1080" }
                },
                "example": "openreelio-cli project create --name \"My Project\" --path ./project --fps 25 --width 1080 --height 1920"
            },
            "project.open": {
                "description": "Open an existing project and display metadata",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" }
                },
                "example": "openreelio-cli project open --path ./project"
            },
            "project.info": {
                "description": "Display detailed project information as JSON",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" }
                },
                "example": "openreelio-cli project info --path ./project"
            },
            "project.save": {
                "description": "Save the project state (snapshot + metadata)",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" }
                },
                "example": "openreelio-cli project save --path ./project"
            },
            "asset.import": {
                "description": "Import a media file as a project asset",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "file": { "type": "string", "required": true, "desc": "Path to media file" },
                    "name": { "type": "string", "required": false, "desc": "Display name (defaults to filename)" }
                },
                "example": "openreelio-cli asset import --path ./project --file video.mp4"
            },
            "asset.list": {
                "description": "List all assets in the project",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "format": { "type": "string", "required": false, "desc": "Output format (currently json only)" }
                },
                "example": "openreelio-cli asset list --path ./project"
            },
            "asset.info": {
                "description": "Display detailed asset metadata",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Asset ID" }
                },
                "example": "openreelio-cli asset info --path ./project --id asset_001"
            },
            "asset.remove": {
                "description": "Remove an asset from the project",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Asset ID to remove" }
                },
                "example": "openreelio-cli asset remove --path ./project --id asset_001"
            },
            "analysis.shots": {
                "description": "Detect shot boundaries with FFmpeg scene detection and cache them in index.db, the analysis bundle, and the asset annotation. 'persisted' names the stores written and 'warnings' explains the rest; status is ok, partial, or failed, and the command exits 1 when persistence was requested and every store rejected the write",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Asset ID" },
                    "threshold": { "type": "number", "required": false, "desc": "Scene change threshold 0.0-1.0; lower detects more cuts (default: 0.3)" },
                    "min-shot-duration": { "type": "number", "required": false, "desc": "Minimum shot duration in seconds; shorter shots are merged (default: 0.5)" },
                    "timeout-sec": { "type": "number", "required": false, "desc": "FFmpeg scene-detection timeout in seconds (default: 600)" },
                    "no-persist": { "type": "boolean", "required": false, "desc": "Detect only: skip the index.db, bundle, and annotation writes" }
                },
                "example": "openreelio-cli analysis shots --path ./project --id asset_001 --threshold 0.3 --min-shot-duration 0.5"
            },
            "analysis.silence": {
                "description": "Detect silence regions with FFmpeg; results are cached only at the shared -40dB / 0.5s contract and only when an audio profile already exists, otherwise they are output-only with a 'reason'",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Asset ID" },
                    "threshold-db": { "type": "number", "required": false, "desc": "Silence threshold in dB (default: -40)" },
                    "min-duration": { "type": "number", "required": false, "desc": "Minimum silence duration in seconds (default: 0.5)" }
                },
                "example": "openreelio-cli analysis silence --path ./project --id asset_001 --threshold-db -40 --min-duration 0.5"
            },
            "analysis.audio": {
                "description": "Profile the audio track (silence regions, loudness curve, peak, BPM, speech regions) and cache it in the analysis bundle",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Asset ID" }
                },
                "example": "openreelio-cli analysis audio --path ./project --id asset_001"
            },
            "analysis.run": {
                "description": "Run the local analysis pipeline (shots, audio, segments, optional transcript and visual) and cache the resulting bundle; exits non-zero only when every enabled sub-job fails",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Asset ID" },
                    "shots": { "type": "boolean", "required": false, "desc": "Run shot detection" },
                    "audio": { "type": "boolean", "required": false, "desc": "Run audio profiling" },
                    "segments": { "type": "boolean", "required": false, "desc": "Run content segmentation (requires shots and audio)" },
                    "transcript": { "type": "boolean", "required": false, "desc": "Run transcription (requires an installed Whisper model)" },
                    "visual": { "type": "boolean", "required": false, "desc": "Run local visual frame analysis" },
                    "all": { "type": "boolean", "required": false, "desc": "Run every local sub-job; transcription stays off unless --transcript is given" },
                    "progress": { "type": "boolean", "required": false, "desc": "Stream NDJSON sub-job progress to stderr" }
                },
                "example": "openreelio-cli analysis run --path ./project --id asset_001 --all --progress"
            },
            "analysis.report": {
                "description": "Build a cached source analysis report for one asset as structured JSON plus embedded Markdown, including moments, chapters, and candidate highlights",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Asset ID" }
                },
                "example": "openreelio-cli analysis report --path ./project --id asset_001"
            },
            "analysis.search": {
                "description": "Search source-analysis moments, chapters, highlights, and speaker turns for one asset and return ranked matches",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Asset ID" },
                    "query": { "type": "string", "required": true, "desc": "Search query" },
                    "sections": { "type": "array", "required": false, "desc": "Optional comma-separated sections: moments, chapters, highlights, speakerTurns" },
                    "limit": { "type": "number", "required": false, "desc": "Maximum matches to return (default: 5)" }
                },
                "example": "openreelio-cli analysis search --path ./project --id asset_001 --query \"host question\" --sections speakerTurns,moments --limit 5"
            },
            "analysis.search-library": {
                "description": "Search source-analysis moments, chapters, highlights, and speaker turns across multiple video assets and return ranked matches",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "query": { "type": "string", "required": true, "desc": "Search query" },
                    "ids": { "type": "array", "required": false, "desc": "Optional comma-separated asset IDs to restrict search scope" },
                    "unused-only": { "type": "boolean", "required": false, "desc": "Restrict search to assets not currently used on any timeline" },
                    "sections": { "type": "array", "required": false, "desc": "Optional comma-separated sections: moments, chapters, highlights, speakerTurns" },
                    "limit": { "type": "number", "required": false, "desc": "Maximum matches to return (default: 8)" },
                    "asset-limit": { "type": "number", "required": false, "desc": "Maximum candidate assets to inspect (default: 20)" }
                },
                "example": "openreelio-cli analysis search-library --path ./project --query \"interviewer question\" --sections speakerTurns,moments --limit 8 --asset-limit 20"
            },
            "analysis.build-selects": {
                "description": "Build a selects stringout plan from ranked source matches, including speaker-turn matches when relevant, with optional direct apply to a target video track",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "query": { "type": "string", "required": true, "desc": "Search query" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID (defaults to active sequence)" },
                    "track": { "type": "string", "required": false, "desc": "Optional target video track ID" },
                    "track-name": { "type": "string", "required": false, "desc": "Target track name when creating or reusing a selects track" },
                    "timeline-start": { "type": "number", "required": false, "desc": "Optional timeline start position for the first selects clip" },
                    "ids": { "type": "array", "required": false, "desc": "Optional comma-separated asset IDs to restrict search scope" },
                    "unused-only": { "type": "boolean", "required": false, "desc": "Restrict search to assets not currently used on any timeline" },
                    "sections": { "type": "array", "required": false, "desc": "Optional comma-separated sections: moments, chapters, highlights, speakerTurns" },
                    "limit": { "type": "number", "required": false, "desc": "Maximum final selects to keep (default: 6)" },
                    "asset-limit": { "type": "number", "required": false, "desc": "Maximum candidate assets to inspect (default: 20)" },
                    "padding-sec": { "type": "number", "required": false, "desc": "Extra padding before and after each source range" },
                    "gap-sec": { "type": "number", "required": false, "desc": "Gap between selects on the timeline" },
                    "apply": { "type": "boolean", "required": false, "desc": "Apply the generated selects directly to the target track" }
                },
                "example": "openreelio-cli analysis build-selects --path ./project --query \"crowd cheer\" --track-name \"Source Selects\" --limit 6 --padding-sec 0.25 --gap-sec 0.25 --apply"
            },
            "timeline.info": {
                "description": "Display timeline structure (tracks, clip counts) plus the where-to-look signals for the sequence: 'durationSec' (editing length) and 'outputDurationSec' (render length), 'fps' with the exact 'fpsRatio', 'canvas', 'cuts' (the times the PICTURE changes — enabled clip boundaries on the video tracks the export includes, head and tail excluded; this is what 'frame extract --at-cuts' samples), 'editPoints' (every boundary on every track including 0, the end, captions, audio and disabled clips — the editing view, not the cut list), 'markers', 'transitions' (each stored two-input blend as {clipId,trackId,effectId,effectType,cutSec,startSec,endSec,durationSec,rendersAsCut,refusalReason}, frame-quantised around the cut the way the renderer places it, so its edges are not any clip boundary; 'rendersAsCut': true means the renderer refuses it and the file shows a hard cut, with 'refusalReason' saying why), 'captionSpans' and 'textSpans' with their words, and an 'inspectionHints' count summary whose 'transitionCount' counts only the blends the file will really get and 'refusedTransitionCount' the rest",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID (defaults to active)" }
                },
                "example": "openreelio-cli timeline info --path ./project"
            },
            "timeline.clips": {
                "description": "List all clips with their positions and properties",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" },
                    "track": { "type": "string", "required": false, "desc": "Filter by track ID" }
                },
                "example": "openreelio-cli timeline clips --path ./project"
            },
            "timeline.tracks": {
                "description": "List all tracks with their properties",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli timeline tracks --path ./project"
            },
            "timeline.insert": {
                "description": "Insert a clip onto the timeline from an asset",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "asset": { "type": "string", "required": true, "desc": "Asset ID to insert" },
                    "track": { "type": "string", "required": true, "desc": "Target track ID" },
                    "at": { "type": "number", "required": true, "desc": "Timeline position in seconds" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli timeline insert --path ./project --asset asset_001 --track track_v1 --at 0.0"
            },
            "timeline.remove": {
                "description": "Remove a clip from the timeline",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "clip": { "type": "string", "required": true, "desc": "Clip ID" },
                    "track": { "type": "string", "required": true, "desc": "Track ID" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli timeline remove --path ./project --clip clip_001 --track track_v1"
            },
            "timeline.move": {
                "description": "Move a clip to a new timeline position",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "clip": { "type": "string", "required": true, "desc": "Clip ID" },
                    "to": { "type": "number", "required": true, "desc": "New position in seconds" },
                    "track": { "type": "string", "required": true, "desc": "Current track ID" },
                    "new-track": { "type": "string", "required": false, "desc": "Target track ID for cross-track moves" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli timeline move --path ./project --clip clip_001 --to 10.0 --track track_v1"
            },
            "timeline.trim": {
                "description": "Trim a clip's source in/out points",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "clip": { "type": "string", "required": true, "desc": "Clip ID" },
                    "track": { "type": "string", "required": true, "desc": "Track ID" },
                    "source-in": { "type": "number", "required": false, "desc": "New source in point (seconds)" },
                    "source-out": { "type": "number", "required": false, "desc": "New source out point (seconds)" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli timeline trim --path ./project --clip clip_001 --track track_v1 --source-in 2.0 --source-out 8.0"
            },
            "timeline.split": {
                "description": "Split a clip at a specific timeline position",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "clip": { "type": "string", "required": true, "desc": "Clip ID" },
                    "track": { "type": "string", "required": true, "desc": "Track ID" },
                    "at": { "type": "number", "required": true, "desc": "Split position in seconds" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli timeline split --path ./project --clip clip_001 --track track_v1 --at 5.0"
            },
            "timeline.speed": {
                "description": "Change clip playback speed",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "clip": { "type": "string", "required": true, "desc": "Clip ID" },
                    "track": { "type": "string", "required": true, "desc": "Track ID" },
                    "speed": { "type": "number", "required": true, "desc": "Speed multiplier (e.g. 2.0)" },
                    "reverse": { "type": "boolean", "required": false, "desc": "Reverse playback" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli timeline speed --path ./project --clip clip_001 --track track_v1 --speed 2.0"
            },
            "timeline.add-track": {
                "description": "Add a new track to the timeline",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "kind": { "type": "string", "required": true, "desc": "Track type: video, audio, caption, or overlay" },
                    "name": { "type": "string", "required": true, "desc": "Track name" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli timeline add-track --path ./project --kind video --name \"Video 2\""
            },
            "timeline.remove-track": {
                "description": "Remove a track from the timeline",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "track": { "type": "string", "required": true, "desc": "Track ID" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli timeline remove-track --path ./project --track track_v2"
            },
            "timeline.set-format": {
                "description": "Change the sequence delivery format: frame rate, canvas size, audio. At least one option is required; the rest keep their current value. Changing the frame rate re-times nothing (the timeline is stored in seconds) — it changes the grid the renderer quantises cuts and transitions to. Changing the canvas leaves clip transforms alone, because they are canvas-relative; what changes is how each source fits the new frame. Reports 'affectedRanges' covering the whole timeline, since both changes reach every clip. Verify with 'timeline info', which reports 'fps', 'fpsRatio' and 'canvas'",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "fps": { "type": "number", "required": false, "desc": "Frame rate, e.g. 25, 29.97, 23.976. Decimals snap to the exact broadcast rational (29.97 becomes 30000/1001, 23.976 becomes 24000/1001); a whole number stays n/1" },
                    "width": { "type": "number", "required": false, "desc": "Canvas width in pixels; even, 16..=16384" },
                    "height": { "type": "number", "required": false, "desc": "Canvas height in pixels; even, 16..=16384" },
                    "audio-sample-rate": { "type": "number", "required": false, "desc": "Audio sample rate in Hz: 8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400 or 192000" },
                    "audio-channels": { "type": "number", "required": false, "desc": "Audio channel count: 1 or 2 (the export pipeline mixes to stereo)" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli timeline set-format --path ./project --fps 25 --width 1080 --height 1920"
            },
            "timeline.undo": {
                "description": "Undo the last editing operation",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" }
                },
                "example": "openreelio-cli timeline undo --path ./project"
            },
            "timeline.redo": {
                "description": "Redo the last undone operation",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" }
                },
                "example": "openreelio-cli timeline redo --path ./project"
            },
            "caption.add": {
                "description": "Add a caption to the timeline",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "track": { "type": "string", "required": false, "desc": "Caption track ID (auto-created when omitted)" },
                    "text": { "type": "string", "required": true, "desc": "Caption text" },
                    "start": { "type": "number", "required": true, "desc": "Start time in seconds" },
                    "end": { "type": "number", "required": true, "desc": "End time in seconds" },
                    "style-pack": { "type": "string", "required": false, "desc": "Curated caption pack id from packs.list; the pack is the base layer and --style-json/--position override it key by key" },
                    "style-json": { "type": "string", "required": false, "desc": "Caption style override JSON object" },
                    "position": { "type": "string", "required": false, "desc": "Position preset: top, center, bottom. A vertical anchor only; the margin comes from --style-pack when one is named, else 5%" },
                    "position-json": { "type": "string", "required": false, "desc": "Caption position JSON object" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli caption add --path ./project --text \"Hello\" --start 0.0 --end 3.0"
            },
            "otio.export": {
                "description": "Export a sequence to an OpenTimelineIO (.otio) file. OTIO is the Academy Software Foundation's editorial interchange format and DaVinci Resolve imports it natively on the free tier, so this is the 'assemble headless, finish in Resolve' path. It is a CUT interchange: tracks, clips, gaps, two-input transitions (cross dissolve, wipe, slide) and markers survive. Effects, transforms, captions, text clips, speed/reverse/time-remap, opacity, blend modes and clip audio settings do NOT — every one of them is named in the returned 'unsupported' array rather than dropped quietly, and structural changes (skipped tracks, missing media, trimmed overlaps) are named in 'warnings'. Gaps are synthesised because an OTIO track is a contiguous child list; no gap is written after the last clip. OpenReelio's own detail (track kind, clip ids, the real transition type behind a 'Custom') is stashed under metadata.openreelio so a re-import restores it while foreign tools see standard OTIO.",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "out": { "type": "string", "required": true, "desc": "Output .otio file path (absolute)" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID (defaults to active)" }
                },
                "example": "openreelio-cli otio export --path ./project --out cut.otio"
            },
            "otio.import": {
                "description": "Import an OpenTimelineIO (.otio) file into a sequence. The file is turned into an edit plan and run through the same machinery as 'plan execute', so the whole import is one atomic, undoable unit that rolls back on failure; exit codes follow the same contract (0 applied and saved, 1 rejected or rolled back cleanly, 2 tool failure or incomplete rollback). Media is matched to existing assets by metadata.openreelio.assetId, then by path, then by file name; anything still unmatched is imported first and reported in 'assetImports'. Gaps advance the timeline cursor and emit no step, transitions become an AddEffect on the outgoing clip, and both stack and track markers become sequence markers. Every RationalTime is converted through its own rate, so a file that mixes rates imports correctly, and every timeline position is then snapped to the target sequence's frame grid. Refused outright: image-sequence references, a file over 64 MiB, a file needing more than the plan step cap (chunking it would give up atomicity), media on a network/UNC path, and media outside the project directory unless --allow-external-media is passed. Reported but not fatal: nested stacks, non-editorial track kinds, offline clips, asymmetric transitions, transitions whose handles cannot be verified, transition types that are not two-input blends, unreadable or negative times, clip markers, and the speed/reverse/freeze/time-remap detail the file recorded but the import does not restore.",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "file": { "type": "string", "required": true, "desc": "OpenTimelineIO file to read (max 64 MiB)" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID to import into (defaults to active)" },
                    "dry-run": { "type": "boolean", "required": false, "desc": "Print the plan the file proposes, with its warnings and asset imports, and stop without touching the project or its files" },
                    "allow-external-media": { "type": "boolean", "required": false, "desc": "Import media the file references from outside the project directory. Off by default: an .otio chooses its own media paths, so an unscoped import hands its author a filesystem probe" }
                },
                "example": "openreelio-cli otio import --path ./project --file cut.otio --dry-run"
            },
            "packs.list": {
                "description": "List curated caption style packs, transition recipes, text presets, and pacing profiles. Packs are the quality floor: name one instead of assembling typography, a transition duration, or a cutting rhythm by hand. Every listed id is accepted by caption --style-pack, by stylePack on CreateCaption/UpdateCaption/ImportGeneratedCaptions, by recipe on AddEffect, by text add --preset / preset on AddTextClip, and by plan from-profile --profile",
                "params": {
                    "kind": { "type": "string", "required": false, "desc": "Registry to list: caption, transition, text, pacing, or all (default: all)", "enum": ["caption", "transition", "text", "pacing", "all"] }
                },
                "example": "openreelio-cli packs list --kind caption"
            },
            "caption.list": {
                "description": "List all captions in the sequence",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli caption list --path ./project"
            },
            "caption.export": {
                "description": "Export captions to SRT or VTT format",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "format": { "type": "string", "required": true, "desc": "Output format: srt or vtt" },
                    "output": { "type": "string", "required": true, "desc": "Output file path" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli caption export --path ./project --format srt --output captions.srt"
            },
            "caption.import": {
                "description": "Import captions from an SRT, VTT, or transcription JSON file",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "file": { "type": "string", "required": true, "desc": "Subtitle or transcription JSON file path" },
                    "track": { "type": "string", "required": false, "desc": "Caption track ID (auto-created when omitted)" },
                    "format": { "type": "string", "required": false, "desc": "Subtitle format: srt, vtt, or transcript-json (auto-detected when omitted)" },
                    "language": { "type": "string", "required": false, "desc": "Language code stored on the caption track and generated caption segments" },
                    "style-pack": { "type": "string", "required": false, "desc": "Curated caption pack id from packs.list applied to every imported cue" },
                    "style-json": { "type": "string", "required": false, "desc": "Caption style override JSON object applied to all cues" },
                    "position": { "type": "string", "required": false, "desc": "Position preset: top, center, bottom. A vertical anchor only; the margin comes from --style-pack when one is named, else 5%" },
                    "position-json": { "type": "string", "required": false, "desc": "Caption position JSON object applied to all cues" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli caption import --path ./project --file transcript.json --format transcript-json"
            },
            "transcription.status": {
                "description": "Show local Whisper transcription readiness and installed model status",
                "params": {},
                "example": "openreelio-cli transcription status"
            },
            "transcription.install": {
                "description": "Download and install a local Whisper model",
                "params": {
                    "model": { "type": "string", "required": false, "desc": "Whisper model: tiny, base, small, medium, large, large-v3, large-v3-turbo, large-v3-turbo-q5_0, large-v3-turbo-q8_0, or large-v3-q5_0. Defaults to large-v3-turbo-q5_0. Every model except large gets DTW-aligned word timings; large (ggml-large.bin) does not, because the filename does not pin a version" },
                    "force": { "type": "boolean", "required": false, "desc": "Replace an existing model file" }
                },
                "example": "openreelio-cli transcription install --model large-v3-turbo-q5_0"
            },
            "transcription.generate": {
                "description": "Generate speech-to-text transcript segments for an audio or video asset, with optional caption import",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "asset": { "type": "string", "required": true, "desc": "Asset ID to transcribe" },
                    "language": { "type": "string", "required": false, "desc": "Language code, or auto for detection" },
                    "model": { "type": "string", "required": false, "desc": "Whisper model, or auto to use the best installed model. Prefer any model except large: large keeps Whisper's heuristic word timings instead of DTW-aligned ones" },
                    "translate": { "type": "boolean", "required": false, "desc": "Translate recognized speech to English when supported" },
                    "output": { "type": "string", "required": false, "desc": "Write transcript JSON to this file in addition to stdout" },
                    "import": { "type": "boolean", "required": false, "desc": "Import generated captions into the active or selected sequence" },
                    "track": { "type": "string", "required": false, "desc": "Caption track ID for import" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID for import" },
                    "replace-existing": { "type": "boolean", "required": false, "desc": "Replace existing captions on the target caption track during import" }
                },
                "example": "openreelio-cli transcription generate --path ./project --asset asset_001 --language auto --model auto --import"
            },
            "transcription.generate-sequence": {
                "description": "Generate speech-to-text transcript segments from the audible audio mix of a sequence, with optional caption import",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID; defaults to active sequence" },
                    "language": { "type": "string", "required": false, "desc": "Language code, or auto for detection" },
                    "model": { "type": "string", "required": false, "desc": "Whisper model, or auto to use the best installed model. Prefer any model except large: large keeps Whisper's heuristic word timings instead of DTW-aligned ones" },
                    "translate": { "type": "boolean", "required": false, "desc": "Translate recognized speech to English when supported" },
                    "output": { "type": "string", "required": false, "desc": "Write transcript JSON to this file in addition to stdout" },
                    "import": { "type": "boolean", "required": false, "desc": "Import generated captions into the selected sequence" },
                    "track": { "type": "string", "required": false, "desc": "Caption track ID for import" },
                    "replace-existing": { "type": "boolean", "required": false, "desc": "Replace existing captions on the target caption track during import" }
                },
                "example": "openreelio-cli transcription generate-sequence --path ./project --sequence seq_001 --language auto --model auto --import"
            },
            "caption.update": {
                "description": "Update a caption's text, timing, and style",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Caption ID to update" },
                    "track": { "type": "string", "required": false, "desc": "Caption track ID containing the caption (auto-resolved when omitted)" },
                    "text": { "type": "string", "required": false, "desc": "New caption text" },
                    "start": { "type": "number", "required": false, "desc": "New caption start time in seconds" },
                    "end": { "type": "number", "required": false, "desc": "New caption end time in seconds" },
                    "style-pack": { "type": "string", "required": false, "desc": "Curated caption pack id from packs.list; restyles an existing caption in one flag and leaves its position alone (pass --position to move it)" },
                    "style-json": { "type": "string", "required": false, "desc": "Caption style override JSON object" },
                    "position": { "type": "string", "required": false, "desc": "Position preset: top, center, bottom. A vertical anchor only; the margin comes from --style-pack when one is named, else 5%" },
                    "position-json": { "type": "string", "required": false, "desc": "Caption position JSON object" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli caption update --path ./project --id cap_001 --text \"Updated text\""
            },
            "caption.remove": {
                "description": "Remove a caption from the timeline",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Caption ID to remove" },
                    "track": { "type": "string", "required": false, "desc": "Caption track ID containing the caption (auto-resolved when omitted)" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli caption remove --path ./project --id cap_001"
            },
            "text.add": {
                "description": "Add an editable text overlay clip with full style, effect, position, and timing data",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "track": { "type": "string", "required": false, "desc": "Video or overlay track ID (auto-created when omitted)" },
                    "text": { "type": "string", "required": true, "desc": "Text content" },
                    "start": { "type": "number", "required": true, "desc": "Timeline start time in seconds" },
                    "duration": { "type": "number", "required": false, "desc": "Clip duration in seconds. Defaults to the selected preset's recommended duration." },
                    "preset": { "type": "string", "required": false, "desc": text_preset_desc(), "enum": text_preset_enum() },
                    "text-json": { "type": "string", "required": false, "desc": "Full TextClipData JSON object" },
                    "style-json": { "type": "string", "required": false, "desc": "Full TextStyle JSON object" },
                    "position-json": { "type": "string", "required": false, "desc": "Text position JSON object" },
                    "shadow-json": { "type": "string", "required": false, "desc": "Text shadow JSON object" },
                    "outline-json": { "type": "string", "required": false, "desc": "Text outline JSON object" },
                    "font-family": { "type": "string", "required": false, "desc": "Font family name" },
                    "font-size": { "type": "number", "required": false, "desc": "Font size" },
                    "font-weight": { "type": "number", "required": false, "desc": "Numeric font weight, 100-900" },
                    "color": { "type": "string", "required": false, "desc": "Text color hex" },
                    "background-color": { "type": "string", "required": false, "desc": "Background color hex" },
                    "background-padding": { "type": "number", "required": false, "desc": "Background padding in pixels" },
                    "bold": { "type": "boolean", "required": false, "desc": "Enable bold" },
                    "italic": { "type": "boolean", "required": false, "desc": "Enable italic" },
                    "underline": { "type": "boolean", "required": false, "desc": "Enable underline" },
                    "align": { "type": "string", "required": false, "desc": "left, center, or right" },
                    "line-height": { "type": "number", "required": false, "desc": "Line height multiplier" },
                    "letter-spacing": { "type": "number", "required": false, "desc": "Letter spacing in pixels" },
                    "x": { "type": "number", "required": false, "desc": "Normalized X position, 0-1" },
                    "y": { "type": "number", "required": false, "desc": "Normalized Y position, 0-1" },
                    "rotation": { "type": "number", "required": false, "desc": "Rotation in degrees" },
                    "opacity": { "type": "number", "required": false, "desc": "Opacity, 0-1" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli text add --path ./project --text \"Directed by OpenReelio\" --start 90 --preset credits"
            },
            "text.update": {
                "description": "Update an editable text clip's content, style, position, effects, and timing",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Text clip ID" },
                    "track": { "type": "string", "required": false, "desc": "Track ID containing the text clip" },
                    "text": { "type": "string", "required": false, "desc": "New text content" },
                    "start": { "type": "number", "required": false, "desc": "New timeline start time in seconds" },
                    "duration": { "type": "number", "required": false, "desc": "New duration in seconds" },
                    "text-json": { "type": "string", "required": false, "desc": "Full TextClipData JSON object" },
                    "style-json": { "type": "string", "required": false, "desc": "Full TextStyle JSON object" },
                    "position-json": { "type": "string", "required": false, "desc": "Text position JSON object" },
                    "shadow-json": { "type": "string", "required": false, "desc": "Text shadow JSON object" },
                    "outline-json": { "type": "string", "required": false, "desc": "Text outline JSON object" },
                    "clear-shadow": { "type": "boolean", "required": false, "desc": "Remove shadow" },
                    "clear-outline": { "type": "boolean", "required": false, "desc": "Remove outline" },
                    "clear-background": { "type": "boolean", "required": false, "desc": "Remove background color" },
                    "font-family": { "type": "string", "required": false, "desc": "Font family name" },
                    "font-size": { "type": "number", "required": false, "desc": "Font size" },
                    "font-weight": { "type": "number", "required": false, "desc": "Numeric font weight, 100-900" },
                    "color": { "type": "string", "required": false, "desc": "Text color hex" },
                    "background-color": { "type": "string", "required": false, "desc": "Background color hex" },
                    "background-padding": { "type": "number", "required": false, "desc": "Background padding in pixels" },
                    "bold": { "type": "boolean", "required": false, "desc": "Set bold true or false" },
                    "italic": { "type": "boolean", "required": false, "desc": "Set italic true or false" },
                    "underline": { "type": "boolean", "required": false, "desc": "Set underline true or false" },
                    "align": { "type": "string", "required": false, "desc": "left, center, or right" },
                    "line-height": { "type": "number", "required": false, "desc": "Line height multiplier" },
                    "letter-spacing": { "type": "number", "required": false, "desc": "Letter spacing in pixels" },
                    "x": { "type": "number", "required": false, "desc": "Normalized X position, 0-1" },
                    "y": { "type": "number", "required": false, "desc": "Normalized Y position, 0-1" },
                    "rotation": { "type": "number", "required": false, "desc": "Rotation in degrees" },
                    "opacity": { "type": "number", "required": false, "desc": "Opacity, 0-1" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli text update --path ./project --id clip_001 --text \"Updated\" --font-weight 600 --start 1.25 --duration 4.5"
            },
            "text.transform": {
                "description": "Move, scale, rotate, or re-anchor an editable text clip in preview space",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Text clip ID" },
                    "track": { "type": "string", "required": false, "desc": "Track ID containing the text clip" },
                    "x": { "type": "number", "required": false, "desc": "Normalized X position, 0-1" },
                    "y": { "type": "number", "required": false, "desc": "Normalized Y position, 0-1" },
                    "scale-x": { "type": "number", "required": false, "desc": "Horizontal scale, 1.0 = 100%" },
                    "scale-y": { "type": "number", "required": false, "desc": "Vertical scale, 1.0 = 100%" },
                    "rotation": { "type": "number", "required": false, "desc": "Rotation in degrees" },
                    "anchor-x": { "type": "number", "required": false, "desc": "Normalized anchor X, 0-1" },
                    "anchor-y": { "type": "number", "required": false, "desc": "Normalized anchor Y, 0-1" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli text transform --path ./project --id clip_001 --x 0.38 --y 0.42 --scale-x 1.2 --scale-y 1.2 --rotation 8"
            },
            "text.remove": {
                "description": "Remove an editable text overlay clip",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "id": { "type": "string", "required": true, "desc": "Text clip ID" },
                    "track": { "type": "string", "required": false, "desc": "Track ID containing the text clip" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli text remove --path ./project --id clip_001"
            },
            "text.list": {
                "description": "List editable text overlay clips with full text data, transform, position, and timing",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli text list --path ./project"
            },
            "plan.execute": {
                "description": "Execute a plan file atomically. Every step result and the success envelope report 'affectedRanges' — the [{startSec,endSec}] stretches of timeline the plan changed, measured against 'sequenceId' — and the union is also written to <project>/.openreelio/cache/agent/last_affected_ranges.json. A plan that failed and rolled back CLEANLY reports empty ranges everywhere, because nothing stayed changed; a plan whose rollback did NOT complete ('rollbackIncomplete': true) keeps every applied step's ranges and reports their union at the top level, because the project really is mutated and those seconds are where to look. The whole plan is validated before anything is mutated, so an invalid payload never takes the project through a rollback. Exits 0 when applied and saved, 1 when the plan was rejected or a step failed and the rollback completed cleanly, and 2 when the tool could not run, the rollback was incomplete ('rollbackIncomplete': true, with 'rollbackFailures'), or the plan applied but could not be saved ('appliedNotSaved': true). An 'appliedNotSaved' report means the steps are already durable: re-running the plan would apply it twice. A failure report names 'failedStep' and 'error'. Plans are capped at 1000 steps",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "file": { "type": "string", "required": true, "desc": "Path to plan JSON file" }
                },
                "example": "openreelio-cli plan execute --path ./project --file edit_plan.json"
            },
            "plan.validate": {
                "description": "Validate a plan file without executing. Checks duplicate and missing step ids, dependency cycles, the 1000-step cap, and parses every step payload. A payload carrying a '$fromStep' reference is checked with a stand-in of either JSON type, so a reference into a numeric field (splitTime) validates as readily as one into a string field (clipId); those steps are listed in 'stepsWithReferences' because the referenced value itself is only settled at execute time. Exits 0 with the findings in 'status' and 'errors' whenever the plan file parses; exits nonzero with empty stdout when the tool itself cannot run, such as an unreadable plan file, malformed plan JSON, or a project that will not open",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "file": { "type": "string", "required": true, "desc": "Path to plan JSON file" }
                },
                "example": "openreelio-cli plan validate --path ./project --file edit_plan.json"
            },
            "plan.from-profile": {
                "description": "Build a plan that cuts one asset to a curated pacing profile, and print it without executing. A pacing profile answers the decisions an automated cut has to make — mean shot length and how much shots vary — so 'cut this to shorts-hook-fast' replaces guesses with one checked name. Every shipped profile cuts hard. The renderer does place transitions, and a profile's boundaries always have the source media to blend with — but a profile cuts one asset, so each boundary is a razor split and a blend across one mixes the same footage into itself, rendering identically to the cut it replaced. A profile that advertised a dissolve would advertise an effect the file cannot show. List the profiles with `packs list --kind pacing`. The asset needs a cached analysis bundle (`analysis run`): the source duration is required, and shot boundaries are what let cuts land on real shot changes instead of mid-shot. Output carries 'cutCount', 'fidelityScore' (how close the mean generated shot is to the profile's target), 'stepsWithReferences', and any 'warnings' — including why a source too short to cut produced no cuts. Without --out the plan is inlined under 'plan'; with --out the plan is written to that file and stdout carries the summary and 'outputPath' instead of a second copy. Nothing is mutated — review it, then `plan validate --file` and `plan execute --file`. Steps reference ids created by earlier steps, so run the plan whole rather than step by step",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "profile": { "type": "string", "required": true, "desc": "Pacing profile id from packs list --kind pacing", "enum": pacing_profile_enum },
                    "asset": { "type": "string", "required": true, "desc": "Asset to cut; must already have a cached analysis bundle" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID (defaults to active)" },
                    "track-name": { "type": "string", "required": false, "desc": "Name for the track the plan creates (default: 'Pacing: <profile>')" },
                    "out": { "type": "string", "required": false, "desc": "Write the plan JSON to this file; stdout then carries the summary and outputPath instead of the inlined plan" }
                },
                "example": "openreelio-cli plan from-profile --path ./project --profile dynamic-social --asset asset_123 --out pacing_plan.json"
            },
            "plan.template": {
                "description": "Generate a plan template for common operations",
                "params": {
                    "type": { "type": "string", "required": true, "desc": "Template type: split-and-move, multi-trim" }
                },
                "example": "openreelio-cli plan template --type split-and-move"
            },
            "command.execute": {
                "description": "Execute any supported backend edit command using the shared CommandPayload parser. Curated packs are resolved by that parser, so CreateCaption/UpdateCaption/ImportGeneratedCaptions accept stylePack, AddEffect accepts recipe, and AddTextClip accepts preset (its textData then carries only the overrides); see packs.list for the ids. The result reports 'affectedRanges' — the sorted, merged [{startSec,endSec}] the edit changed, including ripple shifts no id in 'changes' names — alongside the raw 'changes' list and the 'sequenceId' they were measured against, so the next inspection step knows where to look. The same ranges are written to <project>/.openreelio/cache/agent/last_affected_ranges.json. A payload that names no 'sequenceId' but whose command targets the active sequence by design ('SetSequenceFormat') is measured against that sequence and reports it; a payload that names no timeline at all — an asset import, a 'CreateSequence' — reports no sequence, no ranges and writes no hand-off",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "type": { "type": "string", "required": true, "desc": "Backend command type, e.g. SplitClip or AddMask" },
                    "payload": { "type": "string", "required": false, "desc": "Inline JSON object payload" },
                    "payload-file": { "type": "string", "required": false, "desc": "Path to a JSON object payload file" }
                },
                "example": "openreelio-cli command execute --path ./project --type SplitClip --payload '{\"sequenceId\":\"seq_1\",\"trackId\":\"track_v1\",\"clipId\":\"clip_1\",\"splitTime\":5}'"
            },
            "command.validate": {
                "description": "Validate a backend command payload without executing it",
                "params": {
                    "type": { "type": "string", "required": true, "desc": "Backend command type" },
                    "payload": { "type": "string", "required": false, "desc": "Inline JSON object payload" },
                    "payload-file": { "type": "string", "required": false, "desc": "Path to a JSON object payload file" }
                },
                "example": "openreelio-cli command validate --type AddEffect --payload '{\"sequenceId\":\"seq_1\",\"trackId\":\"track_v1\",\"clipId\":\"clip_1\",\"recipe\":\"dissolve-soft\"}'"
            },
            "command.schema": {
                "description": "Print the backend command surface available to headless agents",
                "params": {},
                "example": "openreelio-cli command schema"
            },
            "state.dump": {
                "description": "Dump full project state as JSON",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "sequence": { "type": "string", "required": false, "desc": "Focus on specific sequence" }
                },
                "example": "openreelio-cli state dump --path ./project"
            },
            "state.ops": {
                "description": "Show recent operations from the ops log",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "last": { "type": "number", "required": false, "desc": "Number of recent ops (default: 10)" }
                },
                "example": "openreelio-cli state ops --path ./project --last 20"
            },
            "state.history": {
                "description": "List the edit history and the position the project sits at. 'entries' is one index space: indices 0..appliedCount are applied, the rest are redoable, and 'currentIndex' is the last applied index (-1 when everything is undone). Read-only — it never writes to the project. Pair it with 'state jump' to walk between candidate edits",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "last": { "type": "number", "required": false, "desc": "Show only the most recent N entries (default: all of them). appliedCount plus redoCount always describes the full history, so truncation stays visible." }
                },
                "example": "openreelio-cli state history --path ./project --last 20"
            },
            "state.jump": {
                "description": "Move the project to a position in its edit history and save it there. Index N leaves the history positioned after applied entry N; --index -1 undoes every entry. Out-of-range indices are rejected with the valid range. This is the best-of-N loop's rewind: apply candidate plan A, render and judge it, jump back, apply candidate B, then re-apply the winner's plan. History is linear, so a new edit made after jumping back clears the redo branch — keep the winner's plan JSON rather than relying on redo. Refuses to run when another process has edited the project since this command opened it. The index space is recomputed per invocation, so a baseline read before another writer appended no longer means the same thing: the response reports 'unwound' ([{opId, commandType}] for every applied entry the rewind removed, in order) and 'adopted' (ops this invocation folded in from the log at open). Re-read 'state history' immediately before jumping and check 'unwound' after. If the reposition persists but the save fails, the response is {'status':'error','historyMoved':true,...} with exit code 2 — the move is already durable, so do not retry it expecting the old position",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "index": { "type": "number", "required": true, "desc": "History index to move to, from 'state history'; -1 undoes everything. Negative values also accept the '=' form: --index=-1" }
                },
                "example": "openreelio-cli state jump --path ./project --index 3"
            },
            "state.snapshot": {
                "description": "Force a snapshot save of the current state",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" }
                },
                "example": "openreelio-cli state snapshot --path ./project"
            },
            "render.presets": {
                "description": "List available render presets",
                "params": {},
                "example": "openreelio-cli render presets"
            },
            "render.graph": {
                "description": "Output the renderer-agnostic graph for preview, export, and agent tooling",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli render graph --path ./project"
            },
            "render.start": {
                "description": "Render a sequence to a final output file using the shared FFmpeg export engine",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "output": { "type": "string", "required": true, "desc": "Output file path" },
                    "preset": { "type": "string", "required": false, "desc": "Render preset name (default: mp4_h264_1080p). Use render.presets for the supported list." },
                    "proxy": { "type": "boolean", "required": false, "desc": "Render a fast 480p proxy for inspection (shorthand for --preset proxy_480p); conflicts with --preset and defaults the output extension to .mp4" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" },
                    "start": { "type": "number", "required": false, "desc": "Start of the rendered range in timeline seconds (default: 0)" },
                    "end": { "type": "number", "required": false, "desc": "End of the rendered range in timeline seconds (default: sequence duration); must be greater than --start" },
                    "progress": { "type": "boolean", "required": false, "desc": "Stream NDJSON encode progress to stderr as {\"type\":\"progress\",\"percent\":..,\"frame\":..,\"totalFrames\":..,\"fps\":..,\"etaSeconds\":..}" }
                },
                "example": "openreelio-cli render start --path ./project --proxy --start 0 --end 5 --progress --output proxy.mp4"
            },
            "ffmpeg.info": {
                "description": "Resolve the FFmpeg/FFprobe binaries this CLI will use and report their version and source (explicit, env, bundled, managed, dev, or system)",
                "params": {},
                "example": "openreelio-cli ffmpeg info"
            },
            "frame.extract": {
                "description": "Extract still frames for visual inspection: event-driven samples of the edit, one asset-time frame, one or many timeline-time frames, a contact sheet grid, or — with --file — stills and sheets from an already rendered video. Prefer a SAMPLER over hand-computed times: --range START END looks at exactly the ranges an edit reported changing (the post-apply step, best paired with --grid auto), --affected reads the last recorded edit instead when you do not hold its ranges (pair it with --after-op, since the record is a slot the app's own edits also write), --at-cuts at both sides of every cut, --at-transitions at every blend, --at-captions at every caption and title, --at-markers, --per-shot for coverage, --around <SEC> for one moment in detail. Samplers combine as a union, dedupe, sort ascending, and report why each frame was chosen as frames[].reason / sheet.cells[].reason plus a 'sampler' block (kinds, candidates, selected, limited, affectedRanges — the ranges sampled, however they were named). --limit <N> thins an oversized selection evenly while keeping its first and last. Reach for --between (evenly spaced midpoints, which land on no event at all) only when nothing event-driven fits. Timeline stills default to 'composite': the full stack — captions, text clips, transforms, layered clips and blends — rendered losslessly, served from an already rendered preview-cache segment when one covers the time. Every still reports where its pixels came from as 'source': 'cache' (a fresh cache segment), 'composite' (rendered now) or 'source' (the clip's own media). Timeline 'fast' mode captures the topmost file-backed clip only (no effects, text, or compositing), warns when that hides a caption, text, effect, transition, blend or canvas fit at the sampled time, naming the ones it found, and falls back to 'composite' automatically when no such clip covers the requested time, including over a gap, where a black frame is the correct result. Timeline times must fall inside the sequence; one at or past the end is rejected with the sequence duration in the message. Seeks resolve FORWARD (the first frame at or after the requested time), so the frame before a cut is sampled at cut - 1.5/fps and the frame after it at the cut time itself. Output shapes: --asset gives 'mode':'asset' with 'frames'; timeline stills give 'mode':'fast'|'composite' with 'frames' (each carrying 'timeSec' and 'source'); timeline grids give 'mode':'grid' with 'sheet' (cells carry 'timelineSec', and 'sheet.sources' counts how many cells each tier served); --file gives 'mode':'file' with a 'source' object plus either 'frames' or 'sheet', whose times are named 'fileSec' because they are relative to the file, not the timeline.",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path. Not read in --file mode, which needs no project state." },
                    "out": { "type": "string", "required": true, "desc": "Output image file; must be a directory when --times is used without --grid. A .png/.jpg extension selects the format and is written as given." },
                    "file": { "type": "string", "required": false, "desc": "Rendered video file to extract from instead of the project timeline, using fast seeking in the file's own timebase. Works with --time, --times, and --grid (+ --between or --times). This is the cheap judging path: it sheets the artifact that was actually produced, so no per-cell timeline render happens and the frames match what 'verify --file' measured. Conflicts with --asset, --source-time, --sequence, and --mode. Times are validated against the VIDEO stream's end, reported as source.videoDurationSec, rather than source.durationSec (the container, i.e. the longest stream) — so a file whose audio outlasts its picture is rejected where the picture stops. A seek that produces no frame is reported as an error naming the requested time, never as a success over a stale image at --out." },
                    "asset": { "type": "string", "required": false, "desc": "Asset ID to extract from; requires --source-time and cannot be combined with timeline selectors" },
                    "source-time": { "type": "number", "required": false, "desc": "Time in seconds inside the asset's own media; requires --asset" },
                    "time": { "type": "number", "required": false, "desc": "Timeline time in seconds for a single still" },
                    "times": { "type": "string", "required": false, "desc": "Comma-separated times in seconds. On its own it writes one still per time, so --out must be a directory and files are named frame_<ms>.<ext>. With --grid it becomes the contact sheet's cell list instead, in the order given — that is how cut-boundary sheets are built from 'timeline clips'." },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID (defaults to active)" },
                    "mode": { "type": "string", "required": false, "desc": "Timeline extraction mode: composite (default) renders a minimal window through the full stack in a lossless profile at the sequence canvas, reusing a preview-cache segment when one is current; fast reads the topmost file-backed clip only and shows none of the edit. A composite window costs by in-clip offset, not by timeline position. Irrelevant with --file, which reads finished frames, and rejected there." },
                    "max-width": { "type": "number", "required": false, "desc": "Maximum output width in pixels, 1-3840, aspect ratio preserved and never upscaled (default: 1280 for timeline and --file stills, native for --asset). Out-of-range values are rejected rather than clamped. For grid cells the default is the cell width instead, so passing it only matters when you want an oversampled source." },
                    "format": { "type": "string", "required": false, "desc": "Output image format: png or jpeg. Defaults to the --out extension, falling back to png for directories and extensionless paths; a value that contradicts a .png/.jpg extension is rejected. Grid cells are always JPEG; the sheet itself uses this format." },
                    "grid": { "type": "string", "required": false, "desc": "Contact sheet layout as COLSxROWS (e.g. 3x2), at most 100 cells and at most 8000px on either finished edge (columns * cell width, rows * cell height); an oversized combination is rejected before any cell is extracted. Requires exactly one time source: a sampler, --between to sample a range evenly, or --times to place a specific list of moments. Pass 'auto' to let the layout follow the sample count (1 column for a single sample, 2 for two, 3 up to 9, 4 up to 16, then 6); 'auto' needs a sampler or --times, since --between already fixes its own count." },
                    "at-cuts": { "type": "boolean", "required": false, "desc": "Sample both sides of every cut in 'timeline info'.cuts — enabled clip boundaries on the video tracks the export includes, so a caption or audio boundary never spends a frame: the outgoing shot's last frame at cut - 1.5/fps (seeks resolve forward, so a smaller offset lands on the incoming shot) and the incoming shot's first frame at the cut itself. Reasons cutBefore and cutAfter. Cannot be combined with --time, --times, --between, --count, --asset or --file." },
                    "at-transitions": { "type": "boolean", "required": false, "desc": "Sample the start, the cut and the end of every two-input transition the renderer will really blend. Reasons transitionStart, transitionCut, transitionEnd. None of the three is a clip boundary, so they cannot be derived from 'timeline clips'. A transition 'timeline info' reports with 'rendersAsCut': true is skipped — its three times all name one hard cut, which --at-cuts already covers." },
                    "at-captions": { "type": "boolean", "required": false, "desc": "Sample the middle of every caption span and every text clip — the settled frame, after any animation in. Reasons captionMid and textMid. Pair with --cell-width 640 or more when sheeting, or the words are unreadable." },
                    "at-markers": { "type": "boolean", "required": false, "desc": "Sample every sequence marker. Reason marker." },
                    "per-shot": { "type": "boolean", "required": false, "desc": "Sample the middle of every enabled, non-text clip on the video tracks the export includes. Reason shotMid. Pair with --limit on a long sequence." },
                    "around": { "type": "number", "required": false, "desc": "Sample a window centred on this timeline time in seconds. Reason around." },
                    "span": { "type": "number", "required": false, "desc": "Half-width of the --around window in seconds (default: 0.5). Requires --around." },
                    "around-count": { "type": "number", "required": false, "desc": "Number of --around samples, spread evenly across the window including its edges (default: 5). Requires --around." },
                    "affected": { "type": "boolean", "required": false, "desc": "Sample the timeline ranges the last applied edit changed, read from .openreelio/cache/agent/last_affected_ranges.json: each range's start, its middle, its last frame at end - 1.5/fps, and both sides of every cut inside it. Reasons affectedStart, affectedMid, affectedEnd, cutBefore, cutAfter; the ranges themselves are echoed as sampler.affectedRanges. Every mutating verb records this hand-off — 'command execute', 'plan execute', the 'timeline', 'text' and 'caption' edit verbs, which report the same 'affectedRanges' in their own JSON, and the app's own edit path. That last one makes the file a SHARED slot: an edit made in the app after yours overwrites it, and this sampler would then show that edit instead. Pass --after-op with the opId your own edit reported to have that checked, or --range to skip the record entirely; a record written by the app is reported as a warning on the payload. Errors when no edit has been applied to this project yet, when the record names another sequence, or when the record does not end at the project's current operation (an undo, a redo, or an edit applied by something that records no hand-off) — re-apply the edit, or pass --between." },
                    "after-op": { "type": "string", "required": false, "desc": "Operation id the recorded hand-off must end at, from the 'opId' of your own 'command execute' or the last of 'plan execute's operationIds. Requires --affected. A record ending anywhere else is refused, naming both operations, instead of showing somebody else's seconds as though they were yours." },
                    "range": { "type": "string", "required": false, "desc": "Sample this timeline range, given as two values: START END. Repeat the flag for several ranges. The same samples and reasons --affected produces (affectedStart, affectedMid, affectedEnd, cutBefore, cutAfter) over ranges you name, with sampler.kinds ['ranges'] — no hand-off file is read, so nothing another surface applies in between can redirect the look. Pass the 'affectedRanges' the edit itself reported. Conflicts with --affected; START must be at or before END, and START == END samples that single instant." },
                    "limit": { "type": "number", "required": false, "desc": "Largest number of sampler times to keep. Over the limit the list is thinned evenly, keeping its first and last entry, and sampler.limited reports it. Only shapes a sampler; rejected without one." },
                    "between": { "type": "string", "required": false, "desc": "Range sampled by --grid, given as two values: START END. Requires --grid (and is rejected without it) and conflicts with --times." },
                    "count": { "type": "number", "required": false, "desc": "Number of --between samples (default: columns * rows; must not exceed the grid capacity). Requires --grid and is rejected without it. Rows no sample reaches are dropped, so the reported rows can be fewer than --grid asked for. Meaningless with --times, which already fixes the cell count." },
                    "cell-width": { "type": "number", "required": false, "desc": "Contact sheet cell width in pixels, 64-1024 (default: 320); requires --grid and is rejected without it. Out-of-range values are rejected rather than clamped. Passing it alone derives the height from the default 16:9 cell (--cell-width 640 gives a 640x360 cell), because cells are fitted with force_original_aspect_ratio=decrease: a 640x180 cell would only pad black around the same 320x180 picture. Grid cells are extracted at the cell width, so raising the pair really does buy detail; --max-width overrides the extraction width." },
                    "cell-height": { "type": "number", "required": false, "desc": "Contact sheet cell height in pixels, 64-1024 (default: 180); requires --grid and is rejected without it. Passing it alone derives the width at 16:9 the same way --cell-width does; passing both keeps exactly what was asked for, including a deliberately non-16:9 cell. A derived dimension is clamped into the 64-1024 range. The reported sheet.cellWidth/cellHeight always name the values actually used." },
                    "label-cells": { "type": "boolean", "required": false, "desc": "Burn '<index> | <seconds>s' into the bottom-left of every cell so the sheet.cells mapping is readable from the image itself; requires --grid and is rejected without it. The label carries the REQUESTED time, not the decoded frame's PTS, so it identifies the cell rather than proving which frame was decoded. Costs one extra FFmpeg pass per cell and needs an FFmpeg build with the drawtext filter. The sheet reports 'labeled': true when it was applied." }
                },
                "example": "openreelio-cli frame extract --path ./project --affected --grid auto --label-cells --out sheet.jpg"
            },
            "verify": {
                "description": "Run deterministic quality control over a sequence and, with --file, over a rendered export. Emits one entry per check — including the ones that passed or were skipped — so an agent can tell 'checked and clean' from 'never checked'. Each check reports status passed (ran, found nothing), warned (ran, warning/info findings only), failed (ran, error or critical findings), skipped, or errored; checks[].passed is true only for 'passed', while the top-level status/passed follow severity and stay true when findings are warnings or info. Exit codes: 0 = ran without breaching --fail-on, 1 = threshold breached, 2 = tool failure (bad arguments, unreadable file, FFmpeg failure, or a check that errored).",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID (defaults to active)" },
                    "file": { "type": "string", "required": false, "desc": "Rendered file to measure (black/freeze/silence detection, EBU R128 loudness, peaks). Without it only structural checks run and FFmpeg is never invoked. Measured times are file-relative and are compared against timeline times, so pass a full-sequence render rather than a partial one." },
                    "structural-only": { "type": "boolean", "required": false, "desc": "Run structural checks only and never touch FFmpeg; conflicts with --file" },
                    "checks": { "type": "string", "required": false, "desc": "Comma-separated check IDs to run exclusively (asset.license and sequence.duration are opt-in and only run when named here): sequence.empty, timeline.gap, clip.orphan, clip.missing_asset, audio.silent_clip, caption.overlap, caption.reading_rate, caption.out_of_bounds, caption.safe_area, shot.length_stats, shot.cut_rhythm, clip.aspect_ratio, asset.license, sequence.duration, render.duration_mismatch, render.missing_video, render.resolution_mismatch, render.black_frames, render.frozen, audio.peak, audio.clipping, audio.loudness" },
                    "skip": { "type": "string", "required": false, "desc": "Comma-separated check IDs to disable" },
                    "target-lufs": { "type": "number", "required": false, "desc": "Integrated loudness target in LUFS (default -14). Negative values need the '=' form: --target-lufs=-14. Deviation over 1 LU warns, over 3 LU errors." },
                    "max-true-peak": { "type": "number", "required": false, "desc": "Maximum acceptable true peak in dBTP (default -1). Negative values need the '=' form: --max-true-peak=-1. Sample peak is used when the encoder reports no true peak." },
                    "duration-tolerance-sec": { "type": "number", "required": false, "desc": "Divergence tolerated between the rendered file and the sequence, in seconds (default: 0.5s, or two frames when that is longer). Honoured exactly, so a tighter value really is tighter." },
                    "fail-on": { "type": "string", "required": false, "desc": "Lowest severity that exits 1: info, warning, error (default), critical" },
                    "timeout-sec": { "type": "number", "required": false, "desc": "Timeout for the rendered-file measurement pass in seconds (default: 600)" },
                    "json-pretty": { "type": "boolean", "required": false, "desc": "Pretty-print the JSON output" }
                },
                "example": "openreelio-cli verify --path ./project --file proxy.mp4 --target-lufs=-14 --fail-on error"
            },
            "mcp": {
                "description": "Serve OpenReelio MCP tools for external AI agents. Read-only by default; mutating tools appear with a host-issued approval token or with --allow-write.",
                "params": {
                    "project": { "type": "string", "required": false, "desc": "Project directory path to expose through the MCP tools" },
                    "stdio": { "type": "boolean", "required": false, "desc": "Serve MCP JSON-RPC over stdio" },
                    "allow-write": { "type": "boolean", "required": false, "desc": "Enable the mutating tools (media.insert, plan.apply) without a per-call approval token. For a locally trusted client only; every mutation still goes through the command log and stays undoable." }
                },
                "example": "openreelio-cli mcp --stdio --project ./project"
            },
            "help-json": {
                "description": "Output this command schema as JSON for agent consumption",
                "params": {},
                "example": "openreelio-cli help-json"
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{build_schema, text_preset_ids, NO_TEXT_PRESET};
    use crate::commands::Cli;
    use clap::{Command, CommandFactory};

    fn collect_leaf_paths(command: &Command, prefix: &[String], acc: &mut Vec<String>) {
        let mut has_subcommands = false;

        for subcommand in command.get_subcommands() {
            has_subcommands = true;
            let mut next_prefix = prefix.to_vec();
            next_prefix.push(subcommand.get_name().to_string());
            collect_leaf_paths(subcommand, &next_prefix, acc);
        }

        if !has_subcommands && !prefix.is_empty() {
            acc.push(prefix.join("."));
        }
    }

    #[test]
    fn build_schema_covers_all_clap_leaf_commands() {
        let schema = build_schema();
        let schema_commands = schema["commands"]
            .as_object()
            .expect("schema commands must be an object");

        let mut clap_paths = Vec::new();
        collect_leaf_paths(&Cli::command(), &[], &mut clap_paths);
        clap_paths.sort();

        let mut schema_paths: Vec<String> = schema_commands.keys().cloned().collect();
        schema_paths.sort();

        assert_eq!(schema_paths, clap_paths);
    }

    #[test]
    fn build_schema_documents_richer_caption_surface() {
        let schema = build_schema();
        let commands = schema["commands"]
            .as_object()
            .expect("schema commands must be an object");

        assert!(commands.contains_key("caption.import"));
        assert!(commands.contains_key("transcription.status"));
        assert!(commands.contains_key("transcription.install"));
        assert!(commands.contains_key("transcription.generate"));
        assert!(commands.contains_key("transcription.generate-sequence"));
        assert!(commands["caption.update"]["params"]["start"].is_object());
        assert!(commands["caption.update"]["params"]["style-json"].is_object());
        assert!(commands["caption.update"]["params"]["position-json"].is_object());
        assert!(commands["caption.add"]["params"]["track"]["required"] == false);
        assert!(commands.contains_key("text.add"));
        assert!(commands.contains_key("text.update"));
        assert!(commands.contains_key("text.transform"));
        assert!(commands["text.add"]["params"]["font-weight"].is_object());
        assert!(commands["text.update"]["params"]["duration"].is_object());
        assert!(commands["text.transform"]["params"]["scale-x"].is_object());
        assert!(commands.contains_key("analysis.shots"));
        assert!(commands.contains_key("analysis.silence"));
        assert!(commands.contains_key("analysis.audio"));
        assert!(commands.contains_key("analysis.run"));
        assert!(commands["analysis.shots"]["params"]["no-persist"].is_object());
        assert!(commands["analysis.silence"]["params"]["threshold-db"].is_object());
        assert!(commands["analysis.run"]["params"]["progress"].is_object());
        assert!(commands.contains_key("analysis.report"));
        assert!(commands.contains_key("analysis.search"));
        assert!(commands.contains_key("analysis.search-library"));
        assert!(commands.contains_key("analysis.build-selects"));
        assert!(commands.contains_key("render.graph"));
    }

    #[test]
    fn build_schema_documents_the_curated_pack_surface() {
        let schema = build_schema();
        let commands = schema["commands"]
            .as_object()
            .expect("schema commands must be an object");

        assert!(commands.contains_key("packs.list"));
        assert!(commands["packs.list"]["params"]["kind"].is_object());

        for verb in ["caption.add", "caption.update", "caption.import"] {
            assert!(
                commands[verb]["params"]["style-pack"].is_object(),
                "{verb} --style-pack must be documented"
            );
        }

        // `command execute` inherits the payload fields, so its description has
        // to say so or an agent will only ever find them through the CLI flags.
        let execute_description = commands["command.execute"]["description"]
            .as_str()
            .expect("description");
        assert!(
            execute_description.contains("stylePack"),
            "{execute_description}"
        );
        assert!(
            execute_description.contains("recipe"),
            "{execute_description}"
        );
        assert!(
            execute_description.contains("preset"),
            "{execute_description}"
        );
    }

    #[test]
    fn build_schema_advertises_exactly_the_text_presets_the_parser_accepts() {
        // The bug this replaces: the schema listed quote, watermark, and
        // countdown while `text add --preset quote` answered "Unsupported text
        // preset". A hand-kept list cannot be checked, so there is none.
        let schema = build_schema();
        let advertised: Vec<String> = schema["commands"]["text.add"]["params"]["preset"]["enum"]
            .as_array()
            .expect("preset enum must be an array")
            .iter()
            .map(|value| value.as_str().expect("preset id").to_string())
            .collect();

        let mut expected = vec![NO_TEXT_PRESET.to_string()];
        expected.extend(text_preset_ids().into_iter().map(str::to_string));
        assert_eq!(advertised, expected);

        for id in &advertised {
            assert!(
                crate::commands::text::preset_is_accepted(id),
                "advertised preset '{id}' must be accepted by text add --preset"
            );
        }
    }

    #[test]
    fn build_schema_documents_the_judge_loop_surface() {
        let schema = build_schema();
        let commands = schema["commands"]
            .as_object()
            .expect("schema commands must be an object");

        // Judging a render: sheet the artifact, sized and labelled to be read.
        let frame_params = &commands["frame.extract"]["params"];
        for flag in ["file", "cell-width", "cell-height", "label-cells"] {
            assert!(
                frame_params[flag].is_object(),
                "frame extract --{flag} must be documented"
            );
        }
        assert!(
            commands["frame.extract"]["description"]
                .as_str()
                .expect("description")
                .contains("fileSec"),
            "The --file payload names its times differently; the schema must say so"
        );
        assert!(
            frame_params["times"]["desc"]
                .as_str()
                .expect("desc")
                .contains("--grid"),
            "--times doubles as the grid's cell list and must document it"
        );

        // Walking between candidates.
        assert!(commands.contains_key("state.history"));
        assert!(commands.contains_key("state.jump"));
        assert!(commands["state.history"]["params"]["last"].is_object());
        assert!(commands["state.jump"]["params"]["index"]["required"] == true);
        assert!(
            commands["state.jump"]["description"]
                .as_str()
                .expect("description")
                .contains("redo"),
            "The jump verb must warn that a new edit clears the redo branch"
        );
    }
}
