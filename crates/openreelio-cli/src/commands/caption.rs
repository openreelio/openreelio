//! Caption and subtitle commands: add, update, remove, list, import, export.

use crate::output;
use crate::validate;
use clap::Subcommand;
use openreelio_core::captions::{parse_srt, parse_vtt, Caption};
use openreelio_core::commands::*;
use openreelio_core::timeline::{Sequence, TrackKind};
use openreelio_core::ActiveProject;
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

    /// Import captions from an SRT or VTT file
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

        /// Optional explicit format: srt or vtt (auto-detected from extension when omitted)
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

    if !value.is_object() {
        return Err(anyhow::anyhow!(
            "--style-json must be a JSON object, for example '{{\"fontSize\": 42}}'"
        ));
    }

    Ok(Some(value))
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

    if !value.is_object() {
        return Err(anyhow::anyhow!(
            "--position-json must be a JSON object, for example '{{\"type\":\"custom\",\"xPercent\":50,\"yPercent\":88}}'"
        ));
    }

    let object = value.as_object().expect("checked above");
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
            let has_x = object.get("xPercent").or_else(|| object.get("x")).is_some();
            let has_y = object.get("yPercent").or_else(|| object.get("y")).is_some();
            if !has_x || !has_y {
                return Err(anyhow::anyhow!(
                    "--position-json custom position requires xPercent and yPercent"
                ));
            }
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
}

impl CaptionFileFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Srt => "srt",
            Self::Vtt => "vtt",
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
            other => Err(anyhow::anyhow!(
                "Unsupported caption format '{}'. Use 'srt' or 'vtt'.",
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
        _ => Err(anyhow::anyhow!(
            "Could not detect subtitle format from '{}'. Provide --format srt|vtt.",
            path.display()
        )),
    }
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
