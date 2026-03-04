//! help-json command: outputs the full CLI schema as JSON for agent consumption.
//!
//! This enables AI agents to discover and use the CLI without parsing --help text.
//! The schema includes command names, descriptions, parameters, types, and examples.

use crate::output;

pub fn execute() -> anyhow::Result<()> {
    output::print_json_pretty(&serde_json::json!({
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
                    "path": { "type": "string", "required": true, "desc": "Project directory path" }
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
                    "in": { "type": "number", "required": false, "desc": "New source in point (seconds)" },
                    "out": { "type": "number", "required": false, "desc": "New source out point (seconds)" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli timeline trim --path ./project --clip clip_001 --track track_v1 --in 2.0 --out 8.0"
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
                    "kind": { "type": "string", "required": true, "desc": "Track type: video or audio" },
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
                    "track": { "type": "string", "required": true, "desc": "Track ID" },
                    "text": { "type": "string", "required": true, "desc": "Caption text" },
                    "start": { "type": "number", "required": true, "desc": "Start time in seconds" },
                    "end": { "type": "number", "required": true, "desc": "End time in seconds" },
                    "sequence": { "type": "string", "required": false, "desc": "Sequence ID" }
                },
                "example": "openreelio-cli caption add --path ./project --track track_v1 --text \"Hello\" --start 0.0 --end 3.0"
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
            "plan.execute": {
                "description": "Execute a plan file atomically (rollback on failure)",
                "params": {
                    "path": { "type": "string", "required": true, "desc": "Project directory path" },
                    "file": { "type": "string", "required": true, "desc": "Path to plan JSON file" }
                },
                "example": "openreelio-cli plan execute --path ./project --file edit_plan.json"
            },
            "plan.validate": {
                "description": "Validate a plan file without executing",
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
            "help-json": {
                "description": "Output this command schema as JSON for agent consumption",
                "params": {},
                "example": "openreelio-cli help-json"
            }
        }
    }))
}
