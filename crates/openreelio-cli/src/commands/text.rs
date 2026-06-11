//! Editable text overlay commands: add, update, transform, remove, list.

use crate::output;
use crate::validate;
use clap::Subcommand;
use openreelio_core::commands::{
    get_text_data, is_text_clip, AddTextClipCommand, AddTrackCommand, MoveClipCommand,
    RemoveTextClipCommand, SetClipTransformCommand, TrimClipCommand, UpdateTextCommand,
};
use openreelio_core::timeline::{Sequence, Track, TrackKind, Transform};
use openreelio_core::{
    text::{TextAlignment, TextClipData, TextOutline, TextPosition, TextShadow, TextStyle},
    ActiveProject, Point2D,
};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum TextAction {
    /// Add an editable text overlay clip, auto-creating a video track when needed
    Add {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Optional target video or overlay track ID
        #[arg(long)]
        track: Option<String>,

        /// Text content
        #[arg(long)]
        text: String,

        /// Timeline start time in seconds
        #[arg(long)]
        start: f64,

        /// Clip duration in seconds
        #[arg(long)]
        duration: Option<f64>,

        /// Preset: default, title, lower-third, subtitle, callout, credits, credit-line, logo-bug, social-handle
        #[arg(long)]
        preset: Option<String>,

        /// Full TextClipData JSON object. CLI flags are applied after this object.
        #[arg(long = "text-json")]
        text_json: Option<String>,

        /// Partial TextStyle JSON object
        #[arg(long = "style-json")]
        style_json: Option<String>,

        /// Position JSON object, for example {"x":0.5,"y":0.85}
        #[arg(long = "position-json")]
        position_json: Option<String>,

        /// Shadow JSON object, or null with --clear-shadow
        #[arg(long = "shadow-json")]
        shadow_json: Option<String>,

        /// Outline JSON object, or null with --clear-outline
        #[arg(long = "outline-json")]
        outline_json: Option<String>,

        #[arg(long = "font-family")]
        font_family: Option<String>,
        #[arg(long = "font-size")]
        font_size: Option<u32>,
        #[arg(long = "font-weight")]
        font_weight: Option<u16>,
        #[arg(long)]
        color: Option<String>,
        #[arg(long = "background-color")]
        background_color: Option<String>,
        #[arg(long = "background-padding")]
        background_padding: Option<u32>,
        #[arg(long)]
        bold: bool,
        #[arg(long)]
        italic: bool,
        #[arg(long)]
        underline: bool,
        #[arg(long)]
        align: Option<String>,
        #[arg(long = "line-height")]
        line_height: Option<f64>,
        #[arg(long = "letter-spacing")]
        letter_spacing: Option<i32>,
        #[arg(long)]
        x: Option<f64>,
        #[arg(long)]
        y: Option<f64>,
        #[arg(long)]
        rotation: Option<f64>,
        #[arg(long)]
        opacity: Option<f64>,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Update text content, style, timing, position, and effects
    Update {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Text clip ID
        #[arg(long)]
        id: String,

        /// Optional track ID containing the text clip
        #[arg(long)]
        track: Option<String>,

        /// New text content
        #[arg(long)]
        text: Option<String>,

        /// Optional new timeline start time in seconds
        #[arg(long)]
        start: Option<f64>,

        /// Optional new clip duration in seconds
        #[arg(long)]
        duration: Option<f64>,

        /// Full TextClipData JSON object. CLI flags are applied after this object.
        #[arg(long = "text-json")]
        text_json: Option<String>,

        /// Partial TextStyle JSON object
        #[arg(long = "style-json")]
        style_json: Option<String>,

        /// Position JSON object, for example {"x":0.5,"y":0.85}
        #[arg(long = "position-json")]
        position_json: Option<String>,

        /// Shadow JSON object
        #[arg(long = "shadow-json")]
        shadow_json: Option<String>,

        /// Outline JSON object
        #[arg(long = "outline-json")]
        outline_json: Option<String>,

        #[arg(long = "clear-shadow")]
        clear_shadow: bool,
        #[arg(long = "clear-outline")]
        clear_outline: bool,
        #[arg(long = "clear-background")]
        clear_background: bool,

        #[arg(long = "font-family")]
        font_family: Option<String>,
        #[arg(long = "font-size")]
        font_size: Option<u32>,
        #[arg(long = "font-weight")]
        font_weight: Option<u16>,
        #[arg(long)]
        color: Option<String>,
        #[arg(long = "background-color")]
        background_color: Option<String>,
        #[arg(long = "background-padding")]
        background_padding: Option<u32>,
        #[arg(long)]
        bold: Option<bool>,
        #[arg(long)]
        italic: Option<bool>,
        #[arg(long)]
        underline: Option<bool>,
        #[arg(long)]
        align: Option<String>,
        #[arg(long = "line-height")]
        line_height: Option<f64>,
        #[arg(long = "letter-spacing")]
        letter_spacing: Option<i32>,
        #[arg(long)]
        x: Option<f64>,
        #[arg(long)]
        y: Option<f64>,
        #[arg(long)]
        rotation: Option<f64>,
        #[arg(long)]
        opacity: Option<f64>,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Move, scale, rotate, or re-anchor a text clip in normalized preview space
    Transform {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Text clip ID
        #[arg(long)]
        id: String,

        /// Optional track ID containing the text clip
        #[arg(long)]
        track: Option<String>,

        #[arg(long)]
        x: Option<f64>,
        #[arg(long)]
        y: Option<f64>,
        #[arg(long = "scale-x")]
        scale_x: Option<f64>,
        #[arg(long = "scale-y")]
        scale_y: Option<f64>,
        #[arg(long)]
        rotation: Option<f64>,
        #[arg(long = "anchor-x")]
        anchor_x: Option<f64>,
        #[arg(long = "anchor-y")]
        anchor_y: Option<f64>,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Remove an editable text overlay clip
    Remove {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Text clip ID
        #[arg(long)]
        id: String,

        /// Optional track ID containing the text clip
        #[arg(long)]
        track: Option<String>,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// List editable text overlay clips in the sequence
    List {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },
}

#[derive(Default)]
struct TextPatch {
    text_json: Option<String>,
    style_json: Option<String>,
    position_json: Option<String>,
    shadow_json: Option<String>,
    outline_json: Option<String>,
    clear_shadow: bool,
    clear_outline: bool,
    clear_background: bool,
    font_family: Option<String>,
    font_size: Option<u32>,
    font_weight: Option<u16>,
    color: Option<String>,
    background_color: Option<String>,
    background_padding: Option<u32>,
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    align: Option<String>,
    line_height: Option<f64>,
    letter_spacing: Option<i32>,
    x: Option<f64>,
    y: Option<f64>,
    rotation: Option<f64>,
    opacity: Option<f64>,
}

fn get_sequence<'a>(project: &'a ActiveProject, sequence_id: &str) -> anyhow::Result<&'a Sequence> {
    project
        .state
        .sequences
        .get(sequence_id)
        .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", sequence_id))
}

fn track_supports_text(track: &Track) -> bool {
    matches!(track.kind, TrackKind::Video | TrackKind::Overlay)
}

fn track_has_overlap(track: &Track, timeline_in: f64, duration: f64) -> bool {
    let candidate_end = timeline_in + duration;
    track.clips.iter().any(|clip| {
        let clip_start = clip.place.timeline_in_sec;
        let clip_end = clip_start + clip.place.duration_sec;
        timeline_in < clip_end && candidate_end > clip_start
    })
}

fn ensure_text_track(
    project: &mut ActiveProject,
    sequence_id: &str,
    explicit_track_id: Option<&str>,
    timeline_in: f64,
    duration: f64,
) -> anyhow::Result<(String, bool)> {
    let sequence = get_sequence(project, sequence_id)?;

    if let Some(track_id) = explicit_track_id {
        let track = sequence
            .tracks
            .iter()
            .find(|track| track.id == track_id)
            .ok_or_else(|| anyhow::anyhow!("Track '{}' not found", track_id))?;
        if !track_supports_text(track) {
            return Err(anyhow::anyhow!(
                "Track '{}' is not a video or overlay track",
                track_id
            ));
        }
        return Ok((track_id.to_string(), false));
    }

    if let Some(track) = sequence.tracks.iter().find(|track| {
        track.kind == TrackKind::Video
            && !track.locked
            && !track_has_overlap(track, timeline_in, duration)
    }) {
        return Ok((track.id.clone(), false));
    }

    let cmd = AddTrackCommand::new(sequence_id, "Text", TrackKind::Video);
    let result = project
        .executor
        .execute(Box::new(cmd), &mut project.state)
        .map_err(|e| anyhow::anyhow!("Create text track failed: {}", e))?;
    let track_id = result
        .created_ids
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Create text track did not return a track ID"))?;
    Ok((track_id, true))
}

fn resolve_text_track_id(
    project: &ActiveProject,
    sequence_id: &str,
    clip_id: &str,
    explicit_track_id: Option<&str>,
) -> anyhow::Result<String> {
    let sequence = get_sequence(project, sequence_id)?;

    if let Some(track_id) = explicit_track_id {
        let track = sequence
            .tracks
            .iter()
            .find(|track| track.id == track_id)
            .ok_or_else(|| anyhow::anyhow!("Track '{}' not found", track_id))?;
        let clip = track
            .clips
            .iter()
            .find(|clip| clip.id == clip_id)
            .ok_or_else(|| {
                anyhow::anyhow!("Clip '{}' not found on track '{}'", clip_id, track_id)
            })?;
        if !is_text_clip(clip) {
            return Err(anyhow::anyhow!("Clip '{}' is not a text clip", clip_id));
        }
        return Ok(track_id.to_string());
    }

    for track in &sequence.tracks {
        if track
            .clips
            .iter()
            .any(|clip| clip.id == clip_id && is_text_clip(clip))
        {
            return Ok(track.id.clone());
        }
    }

    Err(anyhow::anyhow!(
        "Could not resolve text track for '{}'. Provide --track explicitly.",
        clip_id
    ))
}

fn find_text_clip<'a>(
    project: &'a ActiveProject,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
) -> anyhow::Result<&'a openreelio_core::timeline::Clip> {
    let sequence = get_sequence(project, sequence_id)?;
    let track = sequence
        .tracks
        .iter()
        .find(|track| track.id == track_id)
        .ok_or_else(|| anyhow::anyhow!("Track '{}' not found", track_id))?;
    let clip = track
        .clips
        .iter()
        .find(|clip| clip.id == clip_id)
        .ok_or_else(|| anyhow::anyhow!("Clip '{}' not found", clip_id))?;
    if !is_text_clip(clip) {
        return Err(anyhow::anyhow!("Clip '{}' is not a text clip", clip_id));
    }
    Ok(clip)
}

fn text_data_for_clip(
    project: &ActiveProject,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
) -> anyhow::Result<TextClipData> {
    let clip = find_text_clip(project, sequence_id, track_id, clip_id)?;
    get_text_data(clip, &project.state)
        .ok_or_else(|| anyhow::anyhow!("TextOverlay effect not found on clip '{}'", clip_id))
}

fn normalize_text_preset_key(preset: Option<&str>) -> String {
    preset.unwrap_or("default").to_lowercase().replace('_', "-")
}

fn text_preset_default_duration(preset: Option<&str>) -> f64 {
    match normalize_text_preset_key(preset).as_str() {
        "lower-third"
        | "lowerthird"
        | "lower-third-name-role"
        | "interview-lower-third"
        | "speaker-id"
        | "name-role"
        | "credit-line"
        | "source-credit"
        | "attribution"
        | "social-handle"
        | "handle"
        | "social" => 5.0,
        "lower-third-news"
        | "broadcast-lower-third"
        | "news-lower-third"
        | "end-card-title"
        | "end-card"
        | "outro-title" => 6.0,
        "credits" | "credits-block" | "credit-block" | "end-credits" => 8.0,
        "logo-bug" | "bug" | "channel-bug" | "brand-bug" => 10.0,
        "countdown" | "timer" => 1.0,
        "title" | "centered-title" | "tech-style" | "tech" | "terminal" => 4.0,
        _ => 3.0,
    }
}

fn parse_text_preset(preset: Option<String>, content: &str) -> anyhow::Result<TextClipData> {
    let normalized = normalize_text_preset_key(preset.as_deref());

    match normalized.as_str() {
        "default" => Ok(TextClipData::new(content)),
        "title" => Ok(TextClipData::title(content)),
        "centered-title" => Ok(TextClipData {
            content: content.to_string(),
            style: TextStyle::default().with_font_size(72).with_bold(true),
            position: TextPosition::new(0.5, 0.5),
            shadow: Some(TextShadow {
                color: "#000000".to_string(),
                offset_x: 3,
                offset_y: 3,
                blur: 8,
            }),
            outline: None,
            rotation: 0.0,
            opacity: 1.0,
        }),
        "epic-title" | "impact-title" | "hero-title" => Ok(TextClipData {
            content: content.to_string(),
            style: TextStyle::default()
                .with_font_family("Impact")
                .with_font_size(96)
                .with_bold(true),
            position: TextPosition::new(0.5, 0.5),
            shadow: Some(TextShadow {
                color: "#000000".to_string(),
                offset_x: 4,
                offset_y: 4,
                blur: 12,
            }),
            outline: Some(TextOutline {
                color: "#000000".to_string(),
                width: 3,
            }),
            rotation: 0.0,
            opacity: 1.0,
        }),
        "chapter-title" | "chapter" | "chapter-card" | "section-title" => Ok(TextClipData {
            content: content.to_string(),
            style: TextStyle {
                font_family: "Georgia".to_string(),
                font_size: 62,
                font_weight: 700,
                color: "#F8FAFC".to_string(),
                background_color: None,
                background_padding: 0,
                alignment: TextAlignment::Center,
                bold: true,
                italic: false,
                underline: false,
                line_height: 1.18,
                letter_spacing: 2,
            },
            position: TextPosition::new(0.5, 0.45),
            shadow: Some(TextShadow {
                color: "#00000099".to_string(),
                offset_x: 2,
                offset_y: 3,
                blur: 8,
            }),
            outline: None,
            rotation: 0.0,
            opacity: 1.0,
        }),
        "lower-third" | "lowerthird" => Ok(TextClipData::lower_third(content)),
        "lower-third-news" | "broadcast-lower-third" | "news-lower-third" => Ok(TextClipData {
            content: content.to_string(),
            style: TextStyle {
                font_family: "Arial".to_string(),
                font_size: 40,
                font_weight: 700,
                color: "#FFFFFF".to_string(),
                background_color: Some("#123E7CCC".to_string()),
                background_padding: 14,
                alignment: TextAlignment::Left,
                bold: true,
                italic: false,
                underline: false,
                line_height: 1.15,
                letter_spacing: 1,
            },
            position: TextPosition::new(0.07, 0.78),
            shadow: Some(TextShadow {
                color: "#00000080".to_string(),
                offset_x: 1,
                offset_y: 2,
                blur: 3,
            }),
            outline: None,
            rotation: 0.0,
            opacity: 1.0,
        }),
        "lower-third-name-role" | "interview-lower-third" | "speaker-id" | "name-role" => {
            Ok(TextClipData {
                content: content.to_string(),
                style: TextStyle {
                    font_family: "Helvetica".to_string(),
                    font_size: 38,
                    font_weight: 700,
                    color: "#F8FAFC".to_string(),
                    background_color: Some("#111827D9".to_string()),
                    background_padding: 10,
                    alignment: TextAlignment::Left,
                    bold: true,
                    italic: false,
                    underline: false,
                    line_height: 1.25,
                    letter_spacing: 1,
                },
                position: TextPosition::new(0.08, 0.84),
                shadow: None,
                outline: Some(TextOutline {
                    color: "#00000066".to_string(),
                    width: 1,
                }),
                rotation: 0.0,
                opacity: 1.0,
            })
        }
        "subtitle" => Ok(TextClipData::subtitle(content)),
        "callout" | "emphasis" => Ok(TextClipData {
            content: content.to_string(),
            style: TextStyle::default()
                .with_font_size(48)
                .with_font_weight(700)
                .with_color("#FFD700"),
            position: TextPosition::new(0.5, 0.35),
            shadow: Some(TextShadow {
                color: "#000000".to_string(),
                offset_x: 2,
                offset_y: 2,
                blur: 6,
            }),
            outline: Some(TextOutline {
                color: "#000000".to_string(),
                width: 2,
            }),
            rotation: 0.0,
            opacity: 1.0,
        }),
        "callout-stat" | "stat" | "number-callout" | "price-callout" => Ok(TextClipData {
            content: content.to_string(),
            style: TextStyle::default()
                .with_font_size(82)
                .with_font_weight(700)
                .with_color("#38BDF8"),
            position: TextPosition::new(0.5, 0.42),
            shadow: Some(TextShadow {
                color: "#000000".to_string(),
                offset_x: 3,
                offset_y: 4,
                blur: 8,
            }),
            outline: Some(TextOutline {
                color: "#082F49".to_string(),
                width: 2,
            }),
            rotation: 0.0,
            opacity: 1.0,
        }),
        "credits" | "credits-block" | "credit-block" | "end-credits" => Ok(TextClipData {
            content: content.to_string(),
            style: TextStyle {
                font_family: "Georgia".to_string(),
                font_size: 34,
                font_weight: 400,
                color: "#F8FAFC".to_string(),
                background_color: None,
                background_padding: 0,
                alignment: TextAlignment::Center,
                bold: false,
                italic: false,
                underline: false,
                line_height: 1.45,
                letter_spacing: 1,
            },
            position: TextPosition::new(0.5, 0.52),
            shadow: Some(TextShadow {
                color: "#000000AA".to_string(),
                offset_x: 1,
                offset_y: 2,
                blur: 5,
            }),
            outline: None,
            rotation: 0.0,
            opacity: 1.0,
        }),
        "credit-line" | "source-credit" | "attribution" => Ok(TextClipData {
            content: content.to_string(),
            style: TextStyle {
                font_family: "Arial".to_string(),
                font_size: 24,
                font_weight: 400,
                color: "#E5E7EB".to_string(),
                background_color: Some("#00000080".to_string()),
                background_padding: 6,
                alignment: TextAlignment::Right,
                bold: false,
                italic: false,
                underline: false,
                line_height: 1.2,
                letter_spacing: 0,
            },
            position: TextPosition::new(0.94, 0.92),
            shadow: None,
            outline: None,
            rotation: 0.0,
            opacity: 0.9,
        }),
        "logo-bug" | "bug" | "channel-bug" | "brand-bug" => Ok(TextClipData {
            content: content.to_string(),
            style: TextStyle {
                font_family: "Arial".to_string(),
                font_size: 24,
                font_weight: 700,
                color: "#FFFFFF".to_string(),
                background_color: Some("#0F766ECC".to_string()),
                background_padding: 8,
                alignment: TextAlignment::Right,
                bold: true,
                italic: false,
                underline: false,
                line_height: 1.15,
                letter_spacing: 1,
            },
            position: TextPosition::new(0.94, 0.08),
            shadow: None,
            outline: None,
            rotation: 0.0,
            opacity: 0.85,
        }),
        "social-handle" | "handle" | "social" => Ok(TextClipData {
            content: content.to_string(),
            style: TextStyle {
                font_family: "Arial".to_string(),
                font_size: 30,
                font_weight: 700,
                color: "#FFFFFF".to_string(),
                background_color: Some("#7C3AEDCC".to_string()),
                background_padding: 10,
                alignment: TextAlignment::Left,
                bold: true,
                italic: false,
                underline: false,
                line_height: 1.2,
                letter_spacing: 0,
            },
            position: TextPosition::new(0.07, 0.91),
            shadow: Some(TextShadow {
                color: "#00000099".to_string(),
                offset_x: 1,
                offset_y: 2,
                blur: 4,
            }),
            outline: None,
            rotation: 0.0,
            opacity: 1.0,
        }),
        other => Err(anyhow::anyhow!(
            "Unsupported text preset '{}'. Use: default, title, centered-title, epic-title, chapter-title, lower-third, lower-third-news, lower-third-name-role, subtitle, callout, callout-stat, credits, credit-line, logo-bug, social-handle",
            other
        )),
    }
}

fn parse_json_object<T>(label: &str, raw: &str) -> anyhow::Result<T>
where
    T: serde::de::DeserializeOwned,
{
    serde_json::from_str(raw).map_err(|e| anyhow::anyhow!("Invalid {} JSON: {}", label, e))
}

fn json_number<T>(value: &serde_json::Value, field: &str) -> anyhow::Result<T>
where
    T: TryFrom<u64>,
{
    let number = value
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("--style-json {} must be an unsigned number", field))?;
    T::try_from(number).map_err(|_| anyhow::anyhow!("--style-json {} is out of range", field))
}

fn json_i32(value: &serde_json::Value, field: &str) -> anyhow::Result<i32> {
    let number = value
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("--style-json {} must be a number", field))?;
    i32::try_from(number).map_err(|_| anyhow::anyhow!("--style-json {} is out of range", field))
}

fn json_f64(value: &serde_json::Value, field: &str) -> anyhow::Result<f64> {
    value
        .as_f64()
        .ok_or_else(|| anyhow::anyhow!("--style-json {} must be a number", field))
}

fn json_bool(value: &serde_json::Value, field: &str) -> anyhow::Result<bool> {
    value
        .as_bool()
        .ok_or_else(|| anyhow::anyhow!("--style-json {} must be a boolean", field))
}

fn json_string(value: &serde_json::Value, field: &str) -> anyhow::Result<String> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("--style-json {} must be a string", field))
}

fn style_field<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    camel: &str,
    snake: &str,
) -> Option<&'a serde_json::Value> {
    object.get(camel).or_else(|| object.get(snake))
}

fn merge_style(base: &mut TextStyle, style_json: &str) -> anyhow::Result<()> {
    let value: serde_json::Value = parse_json_object("--style-json", style_json)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("--style-json must be a JSON object"))?;

    if let Some(value) = style_field(object, "fontFamily", "font_family") {
        base.font_family = json_string(value, "fontFamily")?;
    }
    if let Some(value) = style_field(object, "fontSize", "font_size") {
        base.font_size = json_number(value, "fontSize")?;
    }
    if let Some(value) = style_field(object, "fontWeight", "font_weight") {
        base.font_weight = json_number::<u16>(value, "fontWeight")?.clamp(100, 900);
        base.bold = base.font_weight >= 600;
    }
    if let Some(value) = object.get("color") {
        base.color = json_string(value, "color")?;
    }
    if let Some(value) = style_field(object, "backgroundColor", "background_color") {
        base.background_color = if value.is_null() {
            None
        } else {
            Some(json_string(value, "backgroundColor")?)
        };
    }
    if let Some(value) = style_field(object, "backgroundPadding", "background_padding") {
        base.background_padding = json_number(value, "backgroundPadding")?;
    }
    if let Some(value) = object.get("alignment") {
        base.alignment = parse_alignment(&json_string(value, "alignment")?)?;
    }
    if let Some(value) = object.get("bold") {
        base.bold = json_bool(value, "bold")?;
        base.font_weight = if base.bold { 700 } else { 400 };
    }
    if let Some(value) = object.get("italic") {
        base.italic = json_bool(value, "italic")?;
    }
    if let Some(value) = object.get("underline") {
        base.underline = json_bool(value, "underline")?;
    }
    if let Some(value) = style_field(object, "lineHeight", "line_height") {
        base.line_height = json_f64(value, "lineHeight")?;
    }
    if let Some(value) = style_field(object, "letterSpacing", "letter_spacing") {
        base.letter_spacing = json_i32(value, "letterSpacing")?;
    }

    Ok(())
}

fn parse_alignment(value: &str) -> anyhow::Result<TextAlignment> {
    match value.to_lowercase().as_str() {
        "left" => Ok(TextAlignment::Left),
        "center" => Ok(TextAlignment::Center),
        "right" => Ok(TextAlignment::Right),
        other => Err(anyhow::anyhow!(
            "Unsupported alignment '{}'. Use: left, center, right",
            other
        )),
    }
}

fn apply_patch(mut text_data: TextClipData, patch: TextPatch) -> anyhow::Result<TextClipData> {
    if let Some(raw) = patch.text_json {
        text_data = parse_json_object("--text-json", &raw)?;
    }
    if let Some(raw) = patch.style_json {
        merge_style(&mut text_data.style, &raw)?;
    }
    if let Some(raw) = patch.position_json {
        text_data.position = parse_json_object("--position-json", &raw)?;
    }
    if let Some(raw) = patch.shadow_json {
        text_data.shadow = Some(parse_json_object("--shadow-json", &raw)?);
    }
    if let Some(raw) = patch.outline_json {
        text_data.outline = Some(parse_json_object("--outline-json", &raw)?);
    }
    if patch.clear_shadow {
        text_data.shadow = None;
    }
    if patch.clear_outline {
        text_data.outline = None;
    }
    if patch.clear_background {
        text_data.style.background_color = None;
    }

    if let Some(value) = patch.font_family {
        validate::non_empty(&value, "font-family")?;
        text_data.style.font_family = value;
    }
    if let Some(value) = patch.font_size {
        text_data.style.font_size = value;
    }
    if let Some(value) = patch.font_weight {
        text_data.style.font_weight = value.clamp(100, 900);
        text_data.style.bold = text_data.style.font_weight >= 600;
    }
    if let Some(value) = patch.color {
        text_data.style.color = value;
    }
    if let Some(value) = patch.background_color {
        text_data.style.background_color = Some(value);
    }
    if let Some(value) = patch.background_padding {
        text_data.style.background_padding = value;
    }
    if let Some(value) = patch.bold {
        text_data.style.bold = value;
        text_data.style.font_weight = if value { 700 } else { 400 };
    }
    if let Some(value) = patch.italic {
        text_data.style.italic = value;
    }
    if let Some(value) = patch.underline {
        text_data.style.underline = value;
    }
    if let Some(value) = patch.align {
        text_data.style.alignment = parse_alignment(&value)?;
    }
    if let Some(value) = patch.line_height {
        text_data.style.line_height = value;
    }
    if let Some(value) = patch.letter_spacing {
        text_data.style.letter_spacing = value;
    }
    if patch.x.is_some() || patch.y.is_some() {
        text_data.position = TextPosition::new(
            patch.x.unwrap_or(text_data.position.x),
            patch.y.unwrap_or(text_data.position.y),
        );
    }
    if let Some(value) = patch.rotation {
        text_data.rotation = value;
    }
    if let Some(value) = patch.opacity {
        text_data.opacity = value;
    }

    text_data.validate().map_err(anyhow::Error::msg)?;
    Ok(text_data)
}

fn patch_has_text_changes(patch: &TextPatch, text: &Option<String>) -> bool {
    text.is_some()
        || patch.text_json.is_some()
        || patch.style_json.is_some()
        || patch.position_json.is_some()
        || patch.shadow_json.is_some()
        || patch.outline_json.is_some()
        || patch.clear_shadow
        || patch.clear_outline
        || patch.clear_background
        || patch.font_family.is_some()
        || patch.font_size.is_some()
        || patch.font_weight.is_some()
        || patch.color.is_some()
        || patch.background_color.is_some()
        || patch.background_padding.is_some()
        || patch.bold.is_some()
        || patch.italic.is_some()
        || patch.underline.is_some()
        || patch.align.is_some()
        || patch.line_height.is_some()
        || patch.letter_spacing.is_some()
        || patch.x.is_some()
        || patch.y.is_some()
        || patch.rotation.is_some()
        || patch.opacity.is_some()
}

fn build_transform(existing: &Transform, args: TransformArgs) -> anyhow::Result<Transform> {
    if args.x.is_none()
        && args.y.is_none()
        && args.scale_x.is_none()
        && args.scale_y.is_none()
        && args.rotation.is_none()
        && args.anchor_x.is_none()
        && args.anchor_y.is_none()
    {
        return Err(anyhow::anyhow!(
            "No transform requested. Provide at least one transform option."
        ));
    }

    Ok(Transform {
        position: Point2D::new(
            args.x.unwrap_or(existing.position.x),
            args.y.unwrap_or(existing.position.y),
        ),
        scale: Point2D::new(
            args.scale_x.unwrap_or(existing.scale.x),
            args.scale_y.unwrap_or(existing.scale.y),
        ),
        rotation_deg: args.rotation.unwrap_or(existing.rotation_deg),
        anchor: Point2D::new(
            args.anchor_x.unwrap_or(existing.anchor.x),
            args.anchor_y.unwrap_or(existing.anchor.y),
        ),
    })
}

struct TransformArgs {
    x: Option<f64>,
    y: Option<f64>,
    scale_x: Option<f64>,
    scale_y: Option<f64>,
    rotation: Option<f64>,
    anchor_x: Option<f64>,
    anchor_y: Option<f64>,
}

pub fn execute(action: TextAction) -> anyhow::Result<()> {
    match action {
        TextAction::Add {
            path,
            track,
            text,
            start,
            duration,
            preset,
            text_json,
            style_json,
            position_json,
            shadow_json,
            outline_json,
            font_family,
            font_size,
            font_weight,
            color,
            background_color,
            background_padding,
            bold,
            italic,
            underline,
            align,
            line_height,
            letter_spacing,
            x,
            y,
            rotation,
            opacity,
            sequence,
        } => {
            validate::non_empty(&text, "text")?;
            validate::time_non_negative(start, "start")?;
            let duration =
                duration.unwrap_or_else(|| text_preset_default_duration(preset.as_deref()));
            if duration <= 0.0 || !duration.is_finite() {
                return Err(anyhow::anyhow!("duration must be finite and positive"));
            }

            let base = parse_text_preset(preset, &text)?;
            let text_data = apply_patch(
                base,
                TextPatch {
                    text_json,
                    style_json,
                    position_json,
                    shadow_json,
                    outline_json,
                    font_family,
                    font_size,
                    font_weight,
                    color,
                    background_color,
                    background_padding,
                    bold: if bold { Some(true) } else { None },
                    italic: if italic { Some(true) } else { None },
                    underline: if underline { Some(true) } else { None },
                    align,
                    line_height,
                    letter_spacing,
                    x,
                    y,
                    rotation,
                    opacity,
                    ..Default::default()
                },
            )?;

            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let (track_id, created_track) =
                ensure_text_track(&mut project, &seq_id, track.as_deref(), start, duration)?;
            let cmd = AddTextClipCommand::new(&seq_id, &track_id, start, duration, text_data);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Add text failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "createdIds": result.created_ids,
                "trackId": track_id,
                "createdTrack": created_track,
            }))
        }

        TextAction::Update {
            path,
            id,
            track,
            text,
            start,
            duration,
            text_json,
            style_json,
            position_json,
            shadow_json,
            outline_json,
            clear_shadow,
            clear_outline,
            clear_background,
            font_family,
            font_size,
            font_weight,
            color,
            background_color,
            background_padding,
            bold,
            italic,
            underline,
            align,
            line_height,
            letter_spacing,
            x,
            y,
            rotation,
            opacity,
            sequence,
        } => {
            validate::non_empty(&id, "id")?;
            if let Some(value) = start {
                validate::time_non_negative(value, "start")?;
            }
            if let Some(value) = duration {
                if value <= 0.0 || !value.is_finite() {
                    return Err(anyhow::anyhow!("duration must be finite and positive"));
                }
            }

            let patch = TextPatch {
                text_json,
                style_json,
                position_json,
                shadow_json,
                outline_json,
                clear_shadow,
                clear_outline,
                clear_background,
                font_family,
                font_size,
                font_weight,
                color,
                background_color,
                background_padding,
                bold,
                italic,
                underline,
                align,
                line_height,
                letter_spacing,
                x,
                y,
                rotation,
                opacity,
            };

            if !patch_has_text_changes(&patch, &text) && start.is_none() && duration.is_none() {
                return Err(anyhow::anyhow!(
                    "No update requested. Provide text, style, position, timing, or effect options."
                ));
            }

            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let track_id = resolve_text_track_id(&project, &seq_id, &id, track.as_deref())?;
            let clip_snapshot = find_text_clip(&project, &seq_id, &track_id, &id)?.clone();
            let mut text_op_id: Option<String> = None;

            if patch_has_text_changes(&patch, &text) {
                let mut text_data = text_data_for_clip(&project, &seq_id, &track_id, &id)?;
                if let Some(content) = text {
                    validate::non_empty(&content, "text")?;
                    text_data.content = content;
                }
                text_data = apply_patch(text_data, patch)?;
                let result = project
                    .executor
                    .execute(
                        Box::new(UpdateTextCommand::new(&seq_id, &track_id, &id, text_data)),
                        &mut project.state,
                    )
                    .map_err(|e| anyhow::anyhow!("Update text failed: {}", e))?;
                text_op_id = Some(result.op_id.clone());
                if start.is_none() && duration.is_none() {
                    super::save_project(&mut project)?;
                    return output::print_json(&serde_json::json!({
                        "status": "ok",
                        "opId": result.op_id,
                        "trackId": track_id,
                    }));
                }
            }

            let mut timing_op_ids = Vec::new();
            if let Some(value) = start {
                let result = project
                    .executor
                    .execute(
                        Box::new(MoveClipCommand::new(&seq_id, &track_id, &id, value, None)),
                        &mut project.state,
                    )
                    .map_err(|e| anyhow::anyhow!("Move text failed: {}", e))?;
                timing_op_ids.push(result.op_id);
            }

            if let Some(value) = duration {
                let speed = if clip_snapshot.speed.is_finite() && clip_snapshot.speed > 0.0 {
                    clip_snapshot.speed as f64
                } else {
                    1.0
                };
                let new_source_out = clip_snapshot.range.source_in_sec + value * speed;
                let result = project
                    .executor
                    .execute(
                        Box::new(TrimClipCommand::new(
                            &seq_id,
                            &track_id,
                            &id,
                            None,
                            Some(new_source_out),
                            None,
                        )),
                        &mut project.state,
                    )
                    .map_err(|e| anyhow::anyhow!("Resize text duration failed: {}", e))?;
                timing_op_ids.push(result.op_id);
            }

            super::save_project(&mut project)?;
            output::print_json(&serde_json::json!({
                "status": "ok",
                "trackId": track_id,
                "textOpId": text_op_id,
                "timingOpIds": timing_op_ids,
            }))
        }

        TextAction::Transform {
            path,
            id,
            track,
            x,
            y,
            scale_x,
            scale_y,
            rotation,
            anchor_x,
            anchor_y,
            sequence,
        } => {
            validate::non_empty(&id, "id")?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let track_id = resolve_text_track_id(&project, &seq_id, &id, track.as_deref())?;
            let existing = find_text_clip(&project, &seq_id, &track_id, &id)?
                .transform
                .clone();
            let transform = build_transform(
                &existing,
                TransformArgs {
                    x,
                    y,
                    scale_x,
                    scale_y,
                    rotation,
                    anchor_x,
                    anchor_y,
                },
            )?;
            let result = project
                .executor
                .execute(
                    Box::new(SetClipTransformCommand::new(
                        &seq_id, &track_id, &id, transform,
                    )),
                    &mut project.state,
                )
                .map_err(|e| anyhow::anyhow!("Transform text failed: {}", e))?;
            super::save_project(&mut project)?;
            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "trackId": track_id,
            }))
        }

        TextAction::Remove {
            path,
            id,
            track,
            sequence,
        } => {
            validate::non_empty(&id, "id")?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let track_id = resolve_text_track_id(&project, &seq_id, &id, track.as_deref())?;
            let result = project
                .executor
                .execute(
                    Box::new(RemoveTextClipCommand::new(&seq_id, &track_id, &id)),
                    &mut project.state,
                )
                .map_err(|e| anyhow::anyhow!("Remove text failed: {}", e))?;
            super::save_project(&mut project)?;
            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "deletedIds": result.deleted_ids,
                "trackId": track_id,
            }))
        }

        TextAction::List { path, sequence } => {
            let project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let sequence = get_sequence(&project, &seq_id)?;
            let mut clips = Vec::new();

            for track in &sequence.tracks {
                for clip in &track.clips {
                    if !is_text_clip(clip) {
                        continue;
                    }
                    let text_data = get_text_data(clip, &project.state);
                    clips.push(serde_json::json!({
                        "id": clip.id,
                        "trackId": track.id,
                        "startSec": clip.place.timeline_in_sec,
                        "durationSec": clip.place.duration_sec,
                        "endSec": clip.place.timeline_in_sec + clip.place.duration_sec,
                        "transform": clip.transform,
                        "textData": text_data,
                    }));
                }
            }

            output::print_json_pretty(&serde_json::json!({
                "sequenceId": seq_id,
                "clips": clips,
                "count": clips.len(),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_parse_production_text_presets() {
        let credits =
            parse_text_preset(Some("credits".to_string()), "Directed by OpenReelio").unwrap();
        assert_eq!(credits.style.font_family, "Georgia");
        assert_eq!(credits.style.alignment, TextAlignment::Center);
        assert_eq!(credits.position, TextPosition::new(0.5, 0.52));
        assert_eq!(credits.shadow.as_ref().map(|shadow| shadow.blur), Some(5));

        let logo_bug = parse_text_preset(Some("logo_bug".to_string()), "OPEN").unwrap();
        assert_eq!(
            logo_bug.style.background_color.as_deref(),
            Some("#0F766ECC")
        );
        assert_eq!(logo_bug.position, TextPosition::new(0.94, 0.08));
        assert!((logo_bug.opacity - 0.85).abs() < 0.001);
    }

    #[test]
    fn should_use_template_duration_when_duration_is_omitted() {
        assert_eq!(text_preset_default_duration(Some("title")), 4.0);
        assert_eq!(text_preset_default_duration(Some("credits")), 8.0);
        assert_eq!(text_preset_default_duration(Some("logo_bug")), 10.0);
        assert_eq!(text_preset_default_duration(Some("callout")), 3.0);
        assert_eq!(text_preset_default_duration(None), 3.0);
    }
}
