//! help-json command: outputs the full CLI schema as JSON for agent consumption.
//!
//! This enables AI agents to discover and use the CLI without parsing --help text.
//! The schema includes command names, descriptions, parameters, types, and examples.

use crate::output;

pub fn execute() -> anyhow::Result<()> {
    output::print_json_pretty(&build_schema())
}

pub(crate) fn build_schema() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "description": "OpenReelio CLI — Headless AI agent-driven video editing",
        "commands": {
            "project.create": {
                "description": "Create a new project",
                "params": {
                    "name": { "type": "string", "required": true, "desc": "Project name" },
                    "path": { "type": "string", "required": true, "desc": "Project directory path" }
                },
                "example": "openreelio-cli project create --name \"My Project\" --path ./project"
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
                "description": "Display timeline structure (tracks, clip counts)",
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
                    "style-json": { "type": "string", "required": false, "desc": "Caption style override JSON object" },
                    "position": { "type": "string", "required": false, "desc": "Position preset: top, center, bottom" },
                    "position-json": { "type": "string", "required": false, "desc": "Caption position JSON object" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli caption add --path ./project --text \"Hello\" --start 0.0 --end 3.0"
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
                    "style-json": { "type": "string", "required": false, "desc": "Caption style override JSON object applied to all cues" },
                    "position": { "type": "string", "required": false, "desc": "Position preset: top, center, bottom" },
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
                    "model": { "type": "string", "required": false, "desc": "Whisper model: tiny, base, small, medium, large, large-v3, or large-v3-turbo. Defaults to large-v3-turbo" },
                    "force": { "type": "boolean", "required": false, "desc": "Replace an existing model file" }
                },
                "example": "openreelio-cli transcription install --model large-v3-turbo"
            },
            "transcription.generate": {
                "description": "Generate speech-to-text transcript segments for an audio or video asset, with optional caption import",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "asset": { "type": "string", "required": true, "desc": "Asset ID to transcribe" },
                    "language": { "type": "string", "required": false, "desc": "Language code, or auto for detection" },
                    "model": { "type": "string", "required": false, "desc": "Whisper model, or auto to use the best installed model" },
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
                    "model": { "type": "string", "required": false, "desc": "Whisper model, or auto to use the best installed model" },
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
                    "style-json": { "type": "string", "required": false, "desc": "Caption style override JSON object" },
                    "position": { "type": "string", "required": false, "desc": "Position preset: top, center, bottom" },
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
                    "preset": { "type": "string", "required": false, "desc": "default, title, centered-title, epic-title, chapter-title, lower-third, lower-third-news, lower-third-name-role, subtitle, callout, callout-stat, credits, credit-line, logo-bug, social-handle, quote, watermark, or countdown" },
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
                "description": "Execute a plan file atomically. The whole plan is validated before anything is mutated, so an invalid payload never takes the project through a rollback. Exits 0 when applied and saved, 1 when the plan was rejected or a step failed and the rollback completed cleanly, and 2 when the tool could not run, the rollback was incomplete ('rollbackIncomplete': true, with 'rollbackFailures'), or the plan applied but could not be saved ('appliedNotSaved': true). An 'appliedNotSaved' report means the steps are already durable: re-running the plan would apply it twice. A failure report names 'failedStep' and 'error'. Plans are capped at 1000 steps",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "file": { "type": "string", "required": true, "desc": "Path to plan JSON file" }
                },
                "example": "openreelio-cli plan execute --path ./project --file edit_plan.json"
            },
            "plan.validate": {
                "description": "Validate a plan file without executing. Checks duplicate and missing step ids, dependency cycles, the 1000-step cap, and parses every step payload. Exits 0 with the findings in 'status' and 'errors' whenever the plan file parses; exits nonzero with empty stdout when the tool itself cannot run, such as an unreadable plan file, malformed plan JSON, or a project that will not open",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "file": { "type": "string", "required": true, "desc": "Path to plan JSON file" }
                },
                "example": "openreelio-cli plan validate --path ./project --file edit_plan.json"
            },
            "plan.template": {
                "description": "Generate a plan template for common operations",
                "params": {
                    "type": { "type": "string", "required": true, "desc": "Template type: split-and-move, multi-trim" }
                },
                "example": "openreelio-cli plan template --type split-and-move"
            },
            "command.execute": {
                "description": "Execute any supported backend edit command using the shared CommandPayload parser",
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
                "example": "openreelio-cli command validate --type RenameTrack --payload '{\"sequenceId\":\"seq_1\",\"trackId\":\"track_v1\",\"name\":\"Main Video\"}'"
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
                "description": "Extract still frames for visual inspection: one asset-time frame, one or many timeline-time frames, or a contact sheet grid. Timeline 'fast' mode captures the topmost file-backed clip only (no effects, text, or compositing) and falls back to 'composite' automatically when no such clip covers the requested time, including over a gap, where a black frame is the correct result. Timeline times must fall inside the sequence; one at or past the end is rejected with the sequence duration in the message.",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "out": { "type": "string", "required": true, "desc": "Output image file; must be a directory when --times is used. A .png/.jpg extension selects the format and is written as given." },
                    "asset": { "type": "string", "required": false, "desc": "Asset ID to extract from; requires --source-time and cannot be combined with timeline selectors" },
                    "source-time": { "type": "number", "required": false, "desc": "Time in seconds inside the asset's own media; requires --asset" },
                    "time": { "type": "number", "required": false, "desc": "Timeline time in seconds for a single still" },
                    "times": { "type": "string", "required": false, "desc": "Comma-separated timeline times in seconds; --out must be a directory and files are named frame_<ms>.<ext>" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID (defaults to active)" },
                    "mode": { "type": "string", "required": false, "desc": "Timeline extraction mode: fast (default, topmost clip only) or composite (full render of a minimal window; decodes from timeline zero so cost grows with the timestamp)" },
                    "max-width": { "type": "number", "required": false, "desc": "Maximum output width in pixels, aspect ratio preserved and never upscaled (default: 1280 for timeline modes, native for --asset)" },
                    "format": { "type": "string", "required": false, "desc": "Output image format: png or jpeg. Defaults to the --out extension, falling back to png for directories and extensionless paths; a value that contradicts a .png/.jpg extension is rejected. Grid cells are always JPEG; the sheet itself uses this format." },
                    "grid": { "type": "string", "required": false, "desc": "Contact sheet layout as COLSxROWS (e.g. 3x2), at most 100 cells; requires --between" },
                    "between": { "type": "string", "required": false, "desc": "Timeline range sampled by --grid, given as two values: START END" },
                    "count": { "type": "number", "required": false, "desc": "Number of grid samples (default: columns * rows; must not exceed the grid capacity). Rows no sample reaches are dropped, so the reported rows can be fewer than --grid asked for." }
                },
                "example": "openreelio-cli frame extract --path ./project --time 12.5 --out frame.png"
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
    use super::build_schema;
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
}
