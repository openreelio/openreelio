//! Speech-to-text transcription commands.

use crate::output;
use clap::Subcommand;
use openreelio_core::assets::AssetKind;
use openreelio_core::captions::{
    audio::{
        extract_audio_for_transcription, load_audio_samples, mix_sequence_audio_for_transcription,
    },
    whisper::{
        default_models_dir, download_whisper_model_blocking, is_whisper_available,
        subtitle_ready_segments, TranscriptionOptions, WhisperEngine, WhisperModel,
    },
};
use openreelio_core::commands::{
    GeneratedCaptionSegment, ImportGeneratedCaptionsCommand, RemoveTrackCommand,
};
use openreelio_core::ActiveProject;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Subcommand)]
pub enum TranscriptionAction {
    /// Show local Whisper transcription readiness and installed model status
    Status,

    /// Download and install a local Whisper model
    Install {
        /// Whisper model: tiny, base, small, medium, large, large-v3, or large-v3-turbo
        #[arg(long, default_value = "large-v3-turbo")]
        model: String,

        /// Replace an existing model file
        #[arg(long)]
        force: bool,
    },

    /// Generate speech-to-text transcript segments for an audio or video asset
    Generate {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Asset ID to transcribe
        #[arg(long)]
        asset: String,

        /// Language code, or auto for detection
        #[arg(long, default_value = "auto")]
        language: String,

        /// Whisper model, or auto to use the best installed model
        #[arg(long, default_value = "auto")]
        model: String,

        /// Translate recognized speech to English when supported
        #[arg(long)]
        translate: bool,

        /// Write transcript JSON to this file in addition to stdout
        #[arg(long)]
        output: Option<PathBuf>,

        /// Import generated captions into the active or selected sequence
        #[arg(long = "import")]
        import_to_timeline: bool,

        /// Caption track ID for import; auto-created when omitted and no caption track exists
        #[arg(long)]
        track: Option<String>,

        /// Sequence ID for import; defaults to active sequence
        #[arg(long)]
        sequence: Option<String>,

        /// Replace existing captions on the target caption track during import
        #[arg(long)]
        replace_existing: bool,
    },

    /// Generate transcript segments from the audible audio mix of a sequence
    GenerateSequence {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID; defaults to active sequence
        #[arg(long)]
        sequence: Option<String>,

        /// Language code, or auto for detection
        #[arg(long, default_value = "auto")]
        language: String,

        /// Whisper model, or auto to use the best installed model
        #[arg(long, default_value = "auto")]
        model: String,

        /// Translate recognized speech to English when supported
        #[arg(long)]
        translate: bool,

        /// Write transcript JSON to this file in addition to stdout
        #[arg(long)]
        output: Option<PathBuf>,

        /// Import generated captions into the selected sequence
        #[arg(long = "import")]
        import_to_timeline: bool,

        /// Caption track ID for import; auto-created when omitted and no caption track exists
        #[arg(long)]
        track: Option<String>,

        /// Replace existing captions on the target caption track during import
        #[arg(long)]
        replace_existing: bool,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionCliOutput {
    pub status: String,
    pub asset_id: String,
    pub asset_name: String,
    pub language: String,
    pub model: String,
    pub duration_sec: f64,
    pub segment_count: usize,
    pub full_text: String,
    pub segments: Vec<TranscriptionSegmentJson>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SequenceTranscriptionCliOutput {
    pub status: String,
    pub sequence_id: String,
    pub language: String,
    pub model: String,
    pub duration_sec: f64,
    pub segment_count: usize,
    pub full_text: String,
    pub segments: Vec<TranscriptionSegmentJson>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionSegmentJson {
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionCliStatus {
    pub feature_available: bool,
    pub ready: bool,
    pub models_dir: String,
    pub default_model: String,
    pub installed_count: usize,
    pub models: Vec<TranscriptionCliModelStatus>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionCliModelStatus {
    pub id: String,
    pub display_name: String,
    pub filename: String,
    pub installed: bool,
    pub path: String,
    pub size_bytes: Option<u64>,
    pub is_default: bool,
    pub recommended: bool,
    pub download_url: String,
    pub estimated_size_bytes: u64,
    pub source: String,
    pub license: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionInstallOutput {
    pub status: String,
    pub model: TranscriptionCliModelStatus,
}

pub fn execute(action: TranscriptionAction) -> anyhow::Result<()> {
    match action {
        TranscriptionAction::Status => output::print_json_pretty(&build_transcription_status()),
        TranscriptionAction::Install { model, force } => {
            output::print_json_pretty(&install_transcription_model(&model, force, true)?)
        }
        TranscriptionAction::Generate {
            path,
            asset,
            language,
            model,
            translate,
            output,
            import_to_timeline,
            track,
            sequence,
            replace_existing,
        } => {
            let mut project = super::load_project(&path)?;
            let transcription =
                generate_asset_transcription(&project, &asset, &language, &model, translate)?;
            let mut response = serde_json::to_value(&transcription)?;

            if let Some(output_path) = output {
                write_json_file(&output_path, &transcription)?;
                response["outputPath"] =
                    serde_json::Value::String(output_path.display().to_string());
            }

            if import_to_timeline {
                let import_result = import_generated_captions(
                    &mut project,
                    sequence,
                    track,
                    replace_existing,
                    &transcription,
                )?;
                super::save_project(&mut project)?;
                response["importResult"] = import_result;
            }

            output::print_json_pretty(&response)
        }
        TranscriptionAction::GenerateSequence {
            path,
            sequence,
            language,
            model,
            translate,
            output,
            import_to_timeline,
            track,
            replace_existing,
        } => {
            let mut project = super::load_project(&path)?;
            let sequence_id = super::resolve_sequence_id(&project, sequence)?;
            let transcription = generate_sequence_transcription(
                &project,
                &sequence_id,
                &language,
                &model,
                translate,
            )?;
            let mut response = serde_json::to_value(&transcription)?;

            if let Some(output_path) = output {
                write_json_file(&output_path, &transcription)?;
                response["outputPath"] =
                    serde_json::Value::String(output_path.display().to_string());
            }

            if import_to_timeline {
                let import_result = import_generated_captions(
                    &mut project,
                    Some(sequence_id),
                    track,
                    replace_existing,
                    &TranscriptionCliOutput {
                        status: transcription.status.clone(),
                        asset_id: "sequence-audio".to_string(),
                        asset_name: "Sequence audio mix".to_string(),
                        language: transcription.language.clone(),
                        model: transcription.model.clone(),
                        duration_sec: transcription.duration_sec,
                        segment_count: transcription.segment_count,
                        full_text: transcription.full_text.clone(),
                        segments: transcription.segments.clone(),
                    },
                )?;
                super::save_project(&mut project)?;
                response["importResult"] = import_result;
            }

            output::print_json_pretty(&response)
        }
    }
}

pub(crate) fn install_transcription_model(
    model: &str,
    force: bool,
    print_progress: bool,
) -> anyhow::Result<TranscriptionInstallOutput> {
    let model = parse_install_whisper_model(model)?;
    let installed_path = download_whisper_model_blocking(model, force, |progress| {
        if print_progress {
            let percent = progress
                .percent()
                .map(|value| format!("{value:.1}%"))
                .unwrap_or_else(|| "unknown".to_string());
            eprintln!(
                "Installing {}: {} ({}/{:?}, {})",
                progress.model.name(),
                progress.stage,
                progress.downloaded_bytes,
                progress.total_bytes,
                percent
            );
        }
    })
    .map_err(|error| anyhow::anyhow!("{}", error))?;
    let models_dir = default_models_dir();
    let default_model = WhisperModel::default_for_dir(&models_dir);
    let status = build_model_status(model, &models_dir, default_model);
    if status.path != installed_path.display().to_string() {
        return Err(anyhow::anyhow!(
            "Installed model path mismatch: expected {}, got {}",
            status.path,
            installed_path.display()
        ));
    }

    Ok(TranscriptionInstallOutput {
        status: "ok".to_string(),
        model: status,
    })
}

fn parse_whisper_model(model: &str) -> anyhow::Result<WhisperModel> {
    model
        .parse()
        .map_err(|error| anyhow::anyhow!("Invalid Whisper model '{}': {}", model, error))
}

fn parse_install_whisper_model(model: &str) -> anyhow::Result<WhisperModel> {
    let normalized = model.trim().to_lowercase();
    if normalized.is_empty() || matches!(normalized.as_str(), "auto" | "default" | "best") {
        return Ok(WhisperModel::recommended_default());
    }
    parse_whisper_model(model)
}

fn resolve_whisper_model(model: &str) -> anyhow::Result<WhisperModel> {
    let models_dir = default_models_dir();
    WhisperModel::resolve_requested_or_default(Some(model), &models_dir)
        .map_err(|error| anyhow::anyhow!("Invalid Whisper model '{}': {}", model, error))
}

fn build_model_status(
    model: WhisperModel,
    models_dir: &Path,
    default_model: WhisperModel,
) -> TranscriptionCliModelStatus {
    let path = models_dir.join(model.filename());
    let metadata = std::fs::metadata(&path).ok();
    let installed = metadata
        .as_ref()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);

    TranscriptionCliModelStatus {
        id: model.name().to_string(),
        display_name: model.display_name().to_string(),
        filename: model.filename().to_string(),
        installed,
        path: path.display().to_string(),
        size_bytes: metadata.map(|metadata| metadata.len()),
        is_default: model == default_model,
        recommended: matches!(
            model,
            WhisperModel::Base
                | WhisperModel::Small
                | WhisperModel::LargeV3
                | WhisperModel::LargeV3Turbo
        ),
        download_url: model.download_url().to_string(),
        estimated_size_bytes: model.estimated_size_bytes(),
        source: model.source().to_string(),
        license: model.license().to_string(),
    }
}

pub(crate) fn build_transcription_status() -> TranscriptionCliStatus {
    let feature_available = is_whisper_available();
    let models_dir = default_models_dir();
    let default_model = WhisperModel::default_for_dir(&models_dir);
    let models = WhisperModel::all()
        .iter()
        .map(|model| build_model_status(*model, &models_dir, default_model))
        .collect::<Vec<_>>();
    let installed_count = models.iter().filter(|model| model.installed).count();

    TranscriptionCliStatus {
        feature_available,
        ready: feature_available && installed_count > 0,
        models_dir: models_dir.display().to_string(),
        default_model: default_model.name().to_string(),
        installed_count,
        models,
    }
}

pub(crate) fn generate_asset_transcription(
    project: &ActiveProject,
    asset_id: &str,
    language: &str,
    model: &str,
    translate: bool,
) -> anyhow::Result<TranscriptionCliOutput> {
    if !is_whisper_available() {
        return Err(anyhow::anyhow!(
            "Whisper transcription is not available. Rebuild openreelio-cli with the whisper feature enabled."
        ));
    }

    let asset = project
        .state
        .assets
        .get(asset_id)
        .ok_or_else(|| anyhow::anyhow!("Asset '{}' not found", asset_id))?;

    if !matches!(asset.kind, AssetKind::Audio | AssetKind::Video) {
        return Err(anyhow::anyhow!(
            "Asset '{}' is {:?}; transcription requires an audio or video asset",
            asset_id,
            asset.kind
        ));
    }

    let model_size = resolve_whisper_model(model)?;
    let model_path = default_models_dir().join(model_size.filename());
    if !model_path.exists() {
        return Err(anyhow::anyhow!(
            "Whisper model '{}' is not installed at '{}'. Download {} into the OpenReelio models/whisper directory.",
            model_size.name(),
            model_path.display(),
            model_size.filename()
        ));
    }

    let asset_path = PathBuf::from(&asset.uri);
    let temp_dir = std::env::temp_dir()
        .join("openreelio")
        .join("cli-transcription");
    std::fs::create_dir_all(&temp_dir)?;
    let temp_path = temp_dir.join(format!(
        "{}-{}.wav",
        std::process::id(),
        sanitize_path_component(asset_id)
    ));
    let _guard = TempFileGuard(temp_path.clone());

    extract_audio_for_transcription(&asset_path, &temp_path, None)
        .map_err(|error| anyhow::anyhow!("Audio extraction failed: {}", error))?;
    let samples = load_audio_samples(&temp_path)
        .map_err(|error| anyhow::anyhow!("Failed to load extracted audio: {}", error))?;
    let engine = WhisperEngine::new(&model_path)
        .map_err(|error| anyhow::anyhow!("Failed to load Whisper model: {}", error))?;
    let options = TranscriptionOptions {
        language: Some(language.trim().to_string()),
        translate,
        threads: 0,
        initial_prompt: None,
    };
    let result = engine
        .transcribe(&samples, &options)
        .map_err(|error| anyhow::anyhow!("Transcription failed: {}", error))?;
    let full_text = result.full_text();
    let subtitle_segments = subtitle_ready_segments(&result.segments);
    let segments = subtitle_segments
        .into_iter()
        .filter_map(|segment| {
            let text = segment.text.trim().to_string();
            if text.is_empty() || segment.end_time <= segment.start_time {
                return None;
            }

            Some(TranscriptionSegmentJson {
                start_time: segment.start_time,
                end_time: segment.end_time,
                text,
            })
        })
        .collect::<Vec<_>>();

    Ok(TranscriptionCliOutput {
        status: "ok".to_string(),
        asset_id: asset.id.clone(),
        asset_name: asset.name.clone(),
        language: result.language,
        model: model_size.name().to_string(),
        duration_sec: result.duration,
        segment_count: segments.len(),
        full_text,
        segments,
    })
}

pub(crate) fn generate_sequence_transcription(
    project: &ActiveProject,
    sequence_id: &str,
    language: &str,
    model: &str,
    translate: bool,
) -> anyhow::Result<SequenceTranscriptionCliOutput> {
    if !is_whisper_available() {
        return Err(anyhow::anyhow!(
            "Whisper transcription is not available. Rebuild openreelio-cli with the whisper feature enabled."
        ));
    }

    if !project.state.sequences.contains_key(sequence_id) {
        return Err(anyhow::anyhow!("Sequence '{}' not found", sequence_id));
    }

    let model_size = resolve_whisper_model(model)?;
    let model_path = default_models_dir().join(model_size.filename());
    if !model_path.exists() {
        return Err(anyhow::anyhow!(
            "Whisper model '{}' is not installed at '{}'. Download {} into the OpenReelio models/whisper directory.",
            model_size.name(),
            model_path.display(),
            model_size.filename()
        ));
    }

    let temp_dir = std::env::temp_dir()
        .join("openreelio")
        .join("cli-transcription");
    std::fs::create_dir_all(&temp_dir)?;
    let temp_path = temp_dir.join(format!(
        "{}-sequence-{}.wav",
        std::process::id(),
        sanitize_path_component(sequence_id)
    ));
    let _guard = TempFileGuard(temp_path.clone());

    mix_sequence_audio_for_transcription(&project.state, sequence_id, &temp_path, None)
        .map_err(|error| anyhow::anyhow!("Sequence audio mixdown failed: {}", error))?;
    let samples = load_audio_samples(&temp_path)
        .map_err(|error| anyhow::anyhow!("Failed to load mixed sequence audio: {}", error))?;
    let engine = WhisperEngine::new(&model_path)
        .map_err(|error| anyhow::anyhow!("Failed to load Whisper model: {}", error))?;
    let options = TranscriptionOptions {
        language: Some(language.trim().to_string()),
        translate,
        threads: 0,
        initial_prompt: None,
    };
    let result = engine
        .transcribe(&samples, &options)
        .map_err(|error| anyhow::anyhow!("Transcription failed: {}", error))?;
    let full_text = result.full_text();
    let subtitle_segments = subtitle_ready_segments(&result.segments);
    let segments = subtitle_segments
        .into_iter()
        .map(|segment| TranscriptionSegmentJson {
            start_time: segment.start_time,
            end_time: segment.end_time,
            text: segment.text,
        })
        .collect::<Vec<_>>();

    Ok(SequenceTranscriptionCliOutput {
        status: "ok".to_string(),
        sequence_id: sequence_id.to_string(),
        language: result.language,
        model: model_size.name().to_string(),
        duration_sec: result.duration,
        segment_count: segments.len(),
        full_text,
        segments,
    })
}

fn import_generated_captions(
    project: &mut ActiveProject,
    sequence: Option<String>,
    track: Option<String>,
    replace_existing: bool,
    transcription: &TranscriptionCliOutput,
) -> anyhow::Result<serde_json::Value> {
    if transcription.segments.is_empty() {
        return Err(anyhow::anyhow!(
            "Transcription did not produce any caption segments to import"
        ));
    }

    let sequence_id = super::resolve_sequence_id(project, sequence)?;
    let (track_id, created_track) =
        super::caption::ensure_caption_track(project, &sequence_id, track.as_deref())?;
    let segments = transcription
        .segments
        .iter()
        .map(|segment| {
            GeneratedCaptionSegment::new(segment.start_time, segment.end_time, segment.text.clone())
        })
        .collect::<Vec<_>>();
    let command = ImportGeneratedCaptionsCommand::new(&sequence_id, &track_id, segments)
        .replace_existing(replace_existing);

    match project
        .executor
        .execute(Box::new(command), &mut project.state)
    {
        Ok(result) => Ok(serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "opId": result.op_id,
            "createdIds": result.created_ids,
            "deletedIds": result.deleted_ids,
            "replaceExisting": replace_existing
        })),
        Err(error) => {
            if created_track {
                let command = RemoveTrackCommand::new(&sequence_id, &track_id);
                let _ = project
                    .executor
                    .execute(Box::new(command), &mut project.state);
            }
            Err(anyhow::anyhow!("Caption import failed: {}", error))
        }
    }
}

fn write_json_file<T: Serialize>(path: &Path, output: &T) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let bytes = serde_json::to_vec_pretty(output)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

fn sanitize_path_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .collect::<String>();
    if sanitized.is_empty() {
        "asset".to_string()
    } else {
        sanitized
    }
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}
