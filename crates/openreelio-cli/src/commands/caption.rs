//! Caption and subtitle commands: add, update, remove, list, import, export.

use crate::output;
use crate::validate;
use clap::Subcommand;
use openreelio_core::captions::{parse_srt, parse_vtt, Caption};
use openreelio_core::commands::*;
use openreelio_core::timeline::{Sequence, TrackKind};
use openreelio_core::ActiveProject;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Subcommand)]
pub enum CaptionAction {
    /// Add a caption to a caption track
    Add {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Optional track ID (must be a caption track, auto-created when omitted)
        #[arg(long)]
        track: Option<String>,

        /// Caption text content
        #[arg(long)]
        text: String,

        /// Start time in seconds
        #[arg(long)]
        start: f64,

        /// End time in seconds
        #[arg(long)]
        end: f64,

        /// Optional caption style JSON object
        #[arg(long = "style-json")]
        style_json: Option<String>,

        /// Optional position preset: top, center, bottom
        #[arg(long)]
        position: Option<String>,

        /// Optional caption position JSON object
        #[arg(long = "position-json")]
        position_json: Option<String>,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Update a caption's text, timing, and style
    Update {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Caption ID to update
        #[arg(long)]
        id: String,

        /// Optional track ID containing the caption (auto-resolved when omitted)
        #[arg(long)]
        track: Option<String>,

        /// New text (optional)
        #[arg(long)]
        text: Option<String>,

        /// Optional new start time in seconds
        #[arg(long)]
        start: Option<f64>,

        /// Optional new end time in seconds
        #[arg(long)]
        end: Option<f64>,

        /// Optional caption style JSON object
        #[arg(long = "style-json")]
        style_json: Option<String>,

        /// Optional position preset: top, center, bottom
        #[arg(long)]
        position: Option<String>,

        /// Optional caption position JSON object
        #[arg(long = "position-json")]
        position_json: Option<String>,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Remove a caption
    Remove {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Caption ID to remove
        #[arg(long)]
        id: String,

        /// Optional track ID containing the caption (auto-resolved when omitted)
        #[arg(long)]
        track: Option<String>,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// List all captions in the sequence
    List {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Import captions from an SRT, VTT, or transcription JSON file
    Import {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Subtitle file path
        #[arg(long)]
        file: PathBuf,

        /// Optional track ID (must be a caption track, auto-created when omitted)
        #[arg(long)]
        track: Option<String>,

        /// Optional explicit format: srt, vtt, or transcript-json (auto-detected from extension when omitted)
        #[arg(long)]
        format: Option<String>,

        /// Optional caption style JSON object applied to every imported caption
        #[arg(long = "style-json")]
        style_json: Option<String>,

        /// Optional position preset: top, center, bottom
        #[arg(long)]
        position: Option<String>,

        /// Optional caption position JSON object applied to every imported caption
        #[arg(long = "position-json")]
        position_json: Option<String>,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Export captions to SRT or VTT format
    Export {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Output format: srt or vtt
        #[arg(long)]
        format: String,

        /// Output file path
        #[arg(long)]
        output: PathBuf,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },
}

fn parse_style_json(style_json: Option<String>) -> anyhow::Result<Option<serde_json::Value>> {
    let Some(style_json) = style_json else {
        return Ok(None);
    };

    let value: serde_json::Value = serde_json::from_str(&style_json)
        .map_err(|e| anyhow::anyhow!("Invalid --style-json payload: {}", e))?;

    if value.is_null() {
        return Ok(Some(value));
    }

    if !value.is_object() {
        return Err(anyhow::anyhow!(
            "--style-json must be a JSON object or null, for example '{{\"fontSize\": 42}}'"
        ));
    }

    validate_caption_style_json(&value)?;

    Ok(Some(value))
}

fn style_field<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| object.get(*key))
}

fn json_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(raw) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn json_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::String(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Some(true),
            "false" | "0" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn validate_style_number(
    object: &Map<String, Value>,
    keys: &[&str],
    label: &str,
    min: f64,
    max: f64,
) -> anyhow::Result<()> {
    let Some(value) = style_field(object, keys) else {
        return Ok(());
    };

    let Some(number) = json_number(value) else {
        return Err(anyhow::anyhow!(
            "--style-json {} must be a number between {} and {}",
            label,
            min,
            max
        ));
    };

    if !number.is_finite() || number < min || number > max {
        return Err(anyhow::anyhow!(
            "--style-json {} must be between {} and {}",
            label,
            min,
            max
        ));
    }

    Ok(())
}

fn validate_style_bool(
    object: &Map<String, Value>,
    keys: &[&str],
    label: &str,
) -> anyhow::Result<()> {
    let Some(value) = style_field(object, keys) else {
        return Ok(());
    };

    if json_bool(value).is_none() {
        return Err(anyhow::anyhow!("--style-json {} must be a boolean", label));
    }

    Ok(())
}

fn validate_hex_color(raw: &str) -> bool {
    let hex = raw.trim().trim_start_matches('#');
    matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn validate_color_component(value: Option<&Value>, field: &str) -> anyhow::Result<()> {
    let Some(value) = value else {
        return Err(anyhow::anyhow!(
            "--style-json {} color component is required",
            field
        ));
    };
    let Some(number) = json_number(value) else {
        return Err(anyhow::anyhow!(
            "--style-json {} color component must be a number between 0 and 255",
            field
        ));
    };
    if !number.is_finite() || !(0.0..=255.0).contains(&number) {
        return Err(anyhow::anyhow!(
            "--style-json {} color component must be between 0 and 255",
            field
        ));
    }

    Ok(())
}

fn validate_style_color(
    object: &Map<String, Value>,
    keys: &[&str],
    label: &str,
) -> anyhow::Result<()> {
    let Some(value) = style_field(object, keys) else {
        return Ok(());
    };

    if let Some(raw) = value.as_str() {
        if validate_hex_color(raw) {
            return Ok(());
        }
        return Err(anyhow::anyhow!(
            "--style-json {} must be a hex color (#RGB, #RGBA, #RRGGBB, or #RRGGBBAA)",
            label
        ));
    }

    let Some(color) = value.as_object() else {
        return Err(anyhow::anyhow!(
            "--style-json {} must be a hex string or an object with r, g, b, and optional a",
            label
        ));
    };

    validate_color_component(
        color.get("r").or_else(|| color.get("red")),
        &format!("{}.r", label),
    )?;
    validate_color_component(
        color.get("g").or_else(|| color.get("green")),
        &format!("{}.g", label),
    )?;
    validate_color_component(
        color.get("b").or_else(|| color.get("blue")),
        &format!("{}.b", label),
    )?;
    if let Some(alpha) = color.get("a").or_else(|| color.get("alpha")) {
        validate_color_component(Some(alpha), &format!("{}.a", label))?;
    }

    Ok(())
}

fn validate_caption_style_json(style: &Value) -> anyhow::Result<()> {
    let object = style
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("--style-json must be a JSON object"))?;

    if let Some(font_family) = style_field(object, &["fontFamily", "font_family"]) {
        let valid = font_family
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();
        if !valid {
            return Err(anyhow::anyhow!(
                "--style-json fontFamily must be a non-empty string"
            ));
        }
    }

    validate_style_number(object, &["fontSize", "font_size"], "fontSize", 1.0, 500.0)?;
    validate_style_number(object, &["opacity"], "opacity", 0.0, 1.0)?;
    validate_style_number(
        object,
        &["backgroundPadding", "background_padding"],
        "backgroundPadding",
        0.0,
        500.0,
    )?;
    validate_style_number(
        object,
        &["outlineWidth", "outline_width"],
        "outlineWidth",
        0.0,
        100.0,
    )?;
    validate_style_number(
        object,
        &["shadowOffset", "shadow_offset"],
        "shadowOffset",
        -500.0,
        500.0,
    )?;
    validate_style_number(
        object,
        &["shadowOffsetX", "shadow_offset_x", "shadowX", "shadow_x"],
        "shadowOffsetX",
        -500.0,
        500.0,
    )?;
    validate_style_number(
        object,
        &["shadowOffsetY", "shadow_offset_y", "shadowY", "shadow_y"],
        "shadowOffsetY",
        -500.0,
        500.0,
    )?;
    validate_style_number(
        object,
        &["shadowBlur", "shadow_blur"],
        "shadowBlur",
        0.0,
        500.0,
    )?;
    validate_style_number(
        object,
        &["lineHeight", "line_height"],
        "lineHeight",
        0.5,
        5.0,
    )?;
    validate_style_number(
        object,
        &["letterSpacing", "letter_spacing"],
        "letterSpacing",
        -100.0,
        200.0,
    )?;

    validate_style_bool(object, &["bold"], "bold")?;
    validate_style_bool(object, &["italic"], "italic")?;
    validate_style_bool(object, &["underline"], "underline")?;

    if let Some(font_weight) = style_field(object, &["fontWeight", "font_weight"]) {
        if let Some(weight) = json_number(font_weight) {
            if !weight.is_finite() || !(100.0..=900.0).contains(&weight) {
                return Err(anyhow::anyhow!(
                    "--style-json fontWeight must be between 100 and 900"
                ));
            }
        } else if let Some(raw) = font_weight.as_str() {
            let normalized = raw.trim().to_ascii_lowercase();
            let valid = matches!(
                normalized.as_str(),
                "normal" | "light" | "bold" | "semibold" | "black" | "heavy"
            );
            if !valid {
                return Err(anyhow::anyhow!(
                    "--style-json fontWeight must be normal, light, bold, semibold, black, heavy, or a number from 100 to 900"
                ));
            }
        } else {
            return Err(anyhow::anyhow!(
                "--style-json fontWeight must be a string or number"
            ));
        }
    }

    if let Some(alignment) = style_field(object, &["alignment", "textAlign", "text_align"]) {
        if !matches!(alignment.as_str(), Some("left" | "center" | "right")) {
            return Err(anyhow::anyhow!(
                "--style-json alignment must be left, center, or right"
            ));
        }
    }

    if let Some(vertical) = style_field(object, &["verticalAlign", "vertical_align"]) {
        if !matches!(
            vertical.as_str(),
            Some("top" | "middle" | "center" | "bottom")
        ) {
            return Err(anyhow::anyhow!(
                "--style-json verticalAlign must be top, middle, center, or bottom"
            ));
        }
    }

    validate_style_color(object, &["color"], "color")?;
    validate_style_color(
        object,
        &["backgroundColor", "background_color"],
        "backgroundColor",
    )?;
    validate_style_color(object, &["outlineColor", "outline_color"], "outlineColor")?;
    validate_style_color(object, &["shadowColor", "shadow_color"], "shadowColor")?;

    Ok(())
}

fn parse_position_preset(position: Option<String>) -> anyhow::Result<Option<serde_json::Value>> {
    let Some(position) = position else {
        return Ok(None);
    };

    let vertical = match position.to_lowercase().as_str() {
        "top" => "top",
        "center" => "center",
        "bottom" => "bottom",
        other => {
            return Err(anyhow::anyhow!(
                "Unsupported caption position '{}'. Use: top, center, bottom",
                other
            ))
        }
    };

    Ok(Some(serde_json::json!({
        "type": "preset",
        "vertical": vertical,
        "marginPercent": 5,
    })))
}

fn parse_position_json(position_json: Option<String>) -> anyhow::Result<Option<serde_json::Value>> {
    let Some(position_json) = position_json else {
        return Ok(None);
    };

    let value: serde_json::Value = serde_json::from_str(&position_json)
        .map_err(|e| anyhow::anyhow!("Invalid --position-json payload: {}", e))?;

    if value.is_null() {
        return Ok(Some(value));
    }

    let Some(object) = value.as_object() else {
        return Err(anyhow::anyhow!(
            "--position-json must be a JSON object or null, for example '{{\"type\":\"custom\",\"xPercent\":50,\"yPercent\":88}}'"
        ));
    };

    let position_type = object
        .get("type")
        .and_then(|kind| kind.as_str())
        .unwrap_or("custom");
    match position_type {
        "preset" => {
            let vertical = object
                .get("vertical")
                .and_then(|vertical| vertical.as_str())
                .ok_or_else(|| anyhow::anyhow!("--position-json preset requires vertical"))?;
            if !matches!(vertical, "top" | "center" | "bottom") {
                return Err(anyhow::anyhow!(
                    "--position-json preset vertical must be top, center, or bottom"
                ));
            }
        }
        "custom" => {
            let x = object.get("xPercent").or_else(|| object.get("x"));
            let y = object.get("yPercent").or_else(|| object.get("y"));
            let (Some(x), Some(y)) = (x, y) else {
                return Err(anyhow::anyhow!(
                    "--position-json custom position requires xPercent and yPercent"
                ));
            };
            validate_custom_position_coordinate("xPercent", x)?;
            validate_custom_position_coordinate("yPercent", y)?;
        }
        other => {
            return Err(anyhow::anyhow!(
                "--position-json type '{}' is unsupported. Use preset or custom.",
                other
            ));
        }
    }

    Ok(Some(value))
}

fn validate_custom_position_coordinate(
    field: &str,
    value: &serde_json::Value,
) -> anyhow::Result<()> {
    let Some(number) = value.as_f64() else {
        return Err(anyhow::anyhow!(
            "--position-json custom {} must be a number between 0 and 100",
            field
        ));
    };

    if !(0.0..=100.0).contains(&number) {
        return Err(anyhow::anyhow!(
            "--position-json custom {} must be between 0 and 100",
            field
        ));
    }

    Ok(())
}

fn parse_caption_position(
    position: Option<String>,
    position_json: Option<String>,
) -> anyhow::Result<Option<serde_json::Value>> {
    if position.is_some() && position_json.is_some() {
        return Err(anyhow::anyhow!(
            "Use either --position or --position-json, not both."
        ));
    }

    let parsed_json = parse_position_json(position_json)?;
    if parsed_json.is_some() {
        return Ok(parsed_json);
    }

    parse_position_preset(position)
}

fn get_sequence<'a>(project: &'a ActiveProject, sequence_id: &str) -> anyhow::Result<&'a Sequence> {
    project
        .state
        .sequences
        .get(sequence_id)
        .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", sequence_id))
}

fn ensure_caption_track(
    project: &mut ActiveProject,
    sequence_id: &str,
    explicit_track_id: Option<&str>,
) -> anyhow::Result<(String, bool)> {
    let sequence = get_sequence(project, sequence_id)?;

    if let Some(track_id) = explicit_track_id {
        let track = sequence
            .tracks
            .iter()
            .find(|track| track.id == track_id)
            .ok_or_else(|| anyhow::anyhow!("Track '{}' not found", track_id))?;

        if track.kind != TrackKind::Caption {
            return Err(anyhow::anyhow!(
                "Track '{}' is not a caption track",
                track_id
            ));
        }

        return Ok((track_id.to_string(), false));
    }

    let caption_tracks = sequence
        .tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Caption)
        .collect::<Vec<_>>();

    match caption_tracks.as_slice() {
        [track] => return Ok((track.id.clone(), false)),
        [] => {}
        _ => {
            return Err(anyhow::anyhow!(
                "Multiple caption tracks exist in sequence '{}'. Pass --track to choose one explicitly.",
                sequence_id
            ));
        }
    }

    let cmd = AddTrackCommand::new(sequence_id, "Captions", TrackKind::Caption);
    let result = project
        .executor
        .execute(Box::new(cmd), &mut project.state)
        .map_err(|e| anyhow::anyhow!("Create caption track failed: {}", e))?;

    let track_id = result
        .created_ids
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Create caption track did not return a track ID"))?;

    Ok((track_id, true))
}

fn resolve_caption_track_id(
    sequence: &Sequence,
    caption_id: &str,
    explicit_track_id: Option<&str>,
) -> anyhow::Result<String> {
    if let Some(track_id) = explicit_track_id {
        let track = sequence
            .tracks
            .iter()
            .find(|track| track.id == track_id)
            .ok_or_else(|| anyhow::anyhow!("Track '{}' not found", track_id))?;

        if track.kind != TrackKind::Caption {
            return Err(anyhow::anyhow!(
                "Track '{}' is not a caption track",
                track_id
            ));
        }

        return Ok(track_id.to_string());
    }

    let caption_tracks: Vec<_> = sequence
        .tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Caption)
        .collect();

    if let Some(track) = caption_tracks
        .iter()
        .find(|track| track.clips.iter().any(|clip| clip.id == caption_id))
    {
        return Ok(track.id.clone());
    }

    if caption_tracks.len() == 1 {
        return Ok(caption_tracks[0].id.clone());
    }

    Err(anyhow::anyhow!(
        "Could not resolve caption track for '{}'. Provide --track explicitly.",
        caption_id
    ))
}

#[derive(Clone, Copy)]
enum CaptionFileFormat {
    Srt,
    Vtt,
    TranscriptJson,
}

impl CaptionFileFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Srt => "srt",
            Self::Vtt => "vtt",
            Self::TranscriptJson => "transcript-json",
        }
    }
}

fn detect_caption_file_format(
    path: &Path,
    explicit_format: Option<&str>,
) -> anyhow::Result<CaptionFileFormat> {
    if let Some(format) = explicit_format {
        return match format.to_lowercase().as_str() {
            "srt" => Ok(CaptionFileFormat::Srt),
            "vtt" => Ok(CaptionFileFormat::Vtt),
            "json" | "transcript-json" | "transcription-json" => {
                Ok(CaptionFileFormat::TranscriptJson)
            }
            other => Err(anyhow::anyhow!(
                "Unsupported caption format '{}'. Use 'srt', 'vtt', or 'transcript-json'.",
                other
            )),
        };
    }

    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase())
        .as_deref()
    {
        Some("srt") => Ok(CaptionFileFormat::Srt),
        Some("vtt") => Ok(CaptionFileFormat::Vtt),
        Some("json") => Ok(CaptionFileFormat::TranscriptJson),
        _ => Err(anyhow::anyhow!(
            "Could not detect subtitle format from '{}'. Provide --format srt|vtt|transcript-json.",
            path.display()
        )),
    }
}

fn segment_number(segment: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| segment.get(*key).and_then(|value| value.as_f64()))
}

fn segment_text(segment: &serde_json::Value) -> Option<String> {
    segment
        .get("text")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn parse_transcription_json(content: &str) -> anyhow::Result<Vec<Caption>> {
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| anyhow::anyhow!("Failed to parse transcription JSON: {}", e))?;

    let segments = if let Some(segments) = value.as_array() {
        segments
    } else if let Some(segments) = value
        .get("segments")
        .and_then(|segments| segments.as_array())
    {
        segments
    } else {
        return Err(anyhow::anyhow!(
            "Transcription JSON must be an array of segments or an object with a segments array"
        ));
    };

    let mut captions = Vec::new();
    for (index, segment) in segments.iter().enumerate() {
        let start_sec = segment_number(segment, &["startTime", "startSec", "start"])
            .ok_or_else(|| anyhow::anyhow!("Segment {} is missing start time", index + 1))?;
        let end_sec = segment_number(segment, &["endTime", "endSec", "end"])
            .ok_or_else(|| anyhow::anyhow!("Segment {} is missing end time", index + 1))?;
        let text = segment_text(segment)
            .ok_or_else(|| anyhow::anyhow!("Segment {} text cannot be empty", index + 1))?;

        validate::time_range_ordered(start_sec, end_sec, "start", "end")?;

        let mut caption = Caption::create(start_sec, end_sec, &text);
        caption.speaker = segment
            .get("speakerId")
            .or_else(|| segment.get("speaker"))
            .and_then(|value| value.as_str())
            .map(str::to_string);
        if let Some(language) = segment.get("language").and_then(|value| value.as_str()) {
            caption
                .metadata
                .insert("language".to_string(), language.to_string());
        }
        if let Some(confidence) = segment.get("confidence").and_then(|value| value.as_f64()) {
            caption
                .metadata
                .insert("confidence".to_string(), confidence.to_string());
        }
        captions.push(caption);
    }

    captions.sort_by(|left, right| {
        left.start_sec
            .total_cmp(&right.start_sec)
            .then_with(|| left.end_sec.total_cmp(&right.end_sec))
            .then_with(|| left.text.cmp(&right.text))
    });

    Ok(captions)
}

fn load_caption_file(path: &Path, format: CaptionFileFormat) -> anyhow::Result<Vec<Caption>> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("Failed to read subtitle file '{}': {}", path.display(), e))?;

    match format {
        CaptionFileFormat::Srt => {
            parse_srt(&content).map_err(|e| anyhow::anyhow!("Failed to parse SRT: {}", e))
        }
        CaptionFileFormat::Vtt => {
            parse_vtt(&content).map_err(|e| anyhow::anyhow!("Failed to parse VTT: {}", e))
        }
        CaptionFileFormat::TranscriptJson => parse_transcription_json(&content),
    }
}

fn rollback_import(
    project: &mut ActiveProject,
    sequence_id: &str,
    track_id: &str,
    created_caption_ids: &[String],
    created_track: bool,
) -> Vec<String> {
    let mut rollback_errors = Vec::new();

    for caption_id in created_caption_ids.iter().rev() {
        let cmd = DeleteCaptionCommand::new(sequence_id, track_id, caption_id);
        if let Err(error) = project.executor.execute(Box::new(cmd), &mut project.state) {
            rollback_errors.push(format!("delete caption '{}': {}", caption_id, error));
        }
    }

    if created_track {
        let cmd = RemoveTrackCommand::new(sequence_id, track_id);
        if let Err(error) = project.executor.execute(Box::new(cmd), &mut project.state) {
            rollback_errors.push(format!("remove track '{}': {}", track_id, error));
        }
    }

    rollback_errors
}

pub fn execute(action: CaptionAction) -> anyhow::Result<()> {
    match action {
        CaptionAction::Add {
            path,
            track,
            text,
            start,
            end,
            style_json,
            position,
            position_json,
            sequence,
        } => {
            validate::non_empty(&text, "text")?;
            validate::time_range_ordered(start, end, "start", "end")?;

            let style = parse_style_json(style_json)?;
            let position = parse_caption_position(position, position_json)?;

            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let (track_id, _created_track) =
                ensure_caption_track(&mut project, &seq_id, track.as_deref())?;

            let cmd = CreateCaptionCommand::new(&seq_id, &track_id, start, end)
                .with_text(&text)
                .with_style(style)
                .with_position(position);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Add caption failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "createdIds": result.created_ids,
                "trackId": track_id,
            }))
        }

        CaptionAction::Update {
            path,
            id,
            track,
            text,
            start,
            end,
            style_json,
            position,
            position_json,
            sequence,
        } => {
            validate::non_empty(&id, "id")?;
            if let Some(ref value) = text {
                validate::non_empty(value, "text")?;
            }

            if let (Some(start), Some(end)) = (start, end) {
                validate::time_range_ordered(start, end, "start", "end")?;
            }

            let style = parse_style_json(style_json)?;
            let position = parse_caption_position(position, position_json)?;

            if text.is_none()
                && start.is_none()
                && end.is_none()
                && style.is_none()
                && position.is_none()
            {
                return Err(anyhow::anyhow!(
                    "No update requested. Provide one of --text, --start, --end, --style-json, --position, or --position-json."
                ));
            }

            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let track_id = {
                let sequence = get_sequence(&project, &seq_id)?;
                resolve_caption_track_id(sequence, &id, track.as_deref())?
            };

            let cmd = UpdateCaptionCommand::new(&seq_id, &track_id, &id)
                .with_text(text)
                .with_time_range(start, end)
                .with_style(style)
                .with_position(position);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Update caption failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "trackId": track_id,
            }))
        }

        CaptionAction::Remove {
            path,
            id,
            track,
            sequence,
        } => {
            validate::non_empty(&id, "id")?;

            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let track_id = {
                let sequence = get_sequence(&project, &seq_id)?;
                resolve_caption_track_id(sequence, &id, track.as_deref())?
            };

            let cmd = DeleteCaptionCommand::new(&seq_id, &track_id, &id);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Remove caption failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "deletedIds": result.deleted_ids,
                "trackId": track_id,
            }))
        }

        CaptionAction::List { path, sequence } => {
            let project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let seq = get_sequence(&project, &seq_id)?;

            let mut captions = Vec::new();
            for track in &seq.tracks {
                if track.kind != TrackKind::Caption {
                    continue;
                }

                for clip in &track.clips {
                    captions.push(serde_json::json!({
                        "id": clip.id,
                        "trackId": track.id,
                        "text": clip.label,
                        "startSec": clip.place.timeline_in_sec,
                        "endSec": clip.place.timeline_in_sec + clip.place.duration_sec,
                        "durationSec": clip.place.duration_sec,
                        "style": clip.caption_style,
                        "position": clip.caption_position,
                    }));
                }
            }

            output::print_json_pretty(&serde_json::json!({
                "sequenceId": seq_id,
                "captions": captions,
                "count": captions.len(),
            }))
        }

        CaptionAction::Import {
            path,
            file,
            track,
            format,
            style_json,
            position,
            position_json,
            sequence,
        } => {
            let subtitle_path = std::fs::canonicalize(&file).map_err(|e| {
                anyhow::anyhow!("Subtitle file '{}' not found: {}", file.display(), e)
            })?;
            let format = detect_caption_file_format(&subtitle_path, format.as_deref())?;
            let captions = load_caption_file(&subtitle_path, format)?;
            let style = parse_style_json(style_json)?;
            let position = parse_caption_position(position, position_json)?;

            if captions.is_empty() {
                return Err(anyhow::anyhow!(
                    "Subtitle file '{}' did not contain any caption cues",
                    subtitle_path.display()
                ));
            }

            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let (track_id, created_track) =
                ensure_caption_track(&mut project, &seq_id, track.as_deref())?;

            let mut created_ids = Vec::new();
            if matches!(format, CaptionFileFormat::TranscriptJson) {
                let segments = captions
                    .iter()
                    .map(|caption| {
                        GeneratedCaptionSegment::new(
                            caption.start_sec,
                            caption.end_sec,
                            caption.text.clone(),
                        )
                    })
                    .collect();
                let cmd = ImportGeneratedCaptionsCommand::new(&seq_id, &track_id, segments)
                    .with_style(style.clone())
                    .with_position(position.clone());

                match project.executor.execute(Box::new(cmd), &mut project.state) {
                    Ok(result) => {
                        created_ids = result.created_ids;
                    }
                    Err(error) => {
                        if created_track {
                            let cmd = RemoveTrackCommand::new(&seq_id, &track_id);
                            let _ = project.executor.execute(Box::new(cmd), &mut project.state);
                        }
                        return Err(anyhow::anyhow!("Caption import failed: {}", error));
                    }
                }
            } else {
                for caption in captions {
                    let cmd = CreateCaptionCommand::new(
                        &seq_id,
                        &track_id,
                        caption.start_sec,
                        caption.end_sec,
                    )
                    .with_text(&caption.text)
                    .with_style(style.clone())
                    .with_position(position.clone());

                    match project.executor.execute(Box::new(cmd), &mut project.state) {
                        Ok(result) => {
                            if let Some(created_id) = result.created_ids.first() {
                                created_ids.push(created_id.clone());
                            }
                        }
                        Err(error) => {
                            let rollback_errors = rollback_import(
                                &mut project,
                                &seq_id,
                                &track_id,
                                &created_ids,
                                created_track,
                            );
                            let rollback_suffix = if rollback_errors.is_empty() {
                                String::new()
                            } else {
                                format!(" Rollback errors: {}", rollback_errors.join("; "))
                            };
                            return Err(anyhow::anyhow!(
                                "Caption import failed after {} caption(s): {}.{}",
                                created_ids.len(),
                                error,
                                rollback_suffix
                            ));
                        }
                    }
                }
            }

            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "trackId": track_id,
                "createdIds": created_ids,
                "importedCount": created_ids.len(),
                "format": format.as_str(),
                "source": subtitle_path.display().to_string(),
            }))
        }

        CaptionAction::Export {
            path,
            format,
            output: output_path,
            sequence,
        } => {
            let project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let seq = get_sequence(&project, &seq_id)?;

            let mut caption_data = Vec::new();
            for track in &seq.tracks {
                if track.kind != TrackKind::Caption {
                    continue;
                }

                for clip in &track.clips {
                    caption_data.push(Caption {
                        id: clip.id.clone(),
                        start_sec: clip.place.timeline_in_sec,
                        end_sec: clip.place.timeline_in_sec + clip.place.duration_sec,
                        text: clip.label.clone().unwrap_or_default(),
                        style_override: None,
                        position_override: None,
                        speaker: None,
                        metadata: Default::default(),
                    });
                }
            }

            let content = match format.to_lowercase().as_str() {
                "srt" => openreelio_core::captions::export_srt(&caption_data),
                "vtt" => openreelio_core::captions::export_vtt(&caption_data),
                _ => {
                    return Err(anyhow::anyhow!(
                        "Unsupported format: '{}'. Use 'srt' or 'vtt'.",
                        format
                    ))
                }
            };

            std::fs::write(&output_path, content)?;
            output::print_json(&serde_json::json!({
                "status": "ok",
                "message": "Captions exported",
                "format": format,
                "output": output_path.display().to_string(),
                "captionCount": caption_data.len(),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_position_json_accepts_custom_coordinate_aliases() {
        let parsed = parse_position_json(Some(r#"{"type":"custom","x":25,"y":75}"#.to_string()))
            .expect("position json should parse")
            .expect("position json should be present");

        assert_eq!(parsed["x"], 25);
        assert_eq!(parsed["y"], 75);
    }

    #[test]
    fn parse_position_json_rejects_non_numeric_custom_coordinates() {
        let error = parse_position_json(Some(
            r#"{"type":"custom","xPercent":"50","yPercent":75}"#.to_string(),
        ))
        .expect_err("non-numeric xPercent should fail");

        assert!(
            error.to_string().contains("xPercent must be a number"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn parse_position_json_rejects_out_of_range_custom_coordinates() {
        let error = parse_position_json(Some(
            r#"{"type":"custom","xPercent":101,"yPercent":75}"#.to_string(),
        ))
        .expect_err("out-of-range xPercent should fail");

        assert!(
            error
                .to_string()
                .contains("xPercent must be between 0 and 100"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn detect_caption_file_format_accepts_transcript_json() {
        let path = Path::new("transcript.json");

        assert!(matches!(
            detect_caption_file_format(path, None).unwrap(),
            CaptionFileFormat::TranscriptJson
        ));
        assert!(matches!(
            detect_caption_file_format(path, Some("transcription-json")).unwrap(),
            CaptionFileFormat::TranscriptJson
        ));
    }

    #[test]
    fn parse_transcription_json_accepts_result_and_segment_aliases() {
        let captions = parse_transcription_json(
            r#"{
                "language": "en",
                "segments": [
                    { "startTime": 1.0, "endTime": 2.5, "text": " World ", "speakerId": "A" },
                    { "startSec": 0.0, "endSec": 0.8, "text": "Hello", "confidence": 0.91 }
                ],
                "fullText": "Hello World"
            }"#,
        )
        .expect("transcription JSON should parse");

        assert_eq!(captions.len(), 2);
        assert_eq!(captions[0].text, "Hello");
        assert_eq!(
            captions[0].metadata.get("confidence").map(String::as_str),
            Some("0.91")
        );
        assert_eq!(captions[1].text, "World");
        assert_eq!(captions[1].speaker.as_deref(), Some("A"));
    }
}
