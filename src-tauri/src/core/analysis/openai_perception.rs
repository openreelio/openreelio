//! OpenAI-backed perception helpers for source video analysis.
//!
//! This module is intentionally kept out of the core FFmpeg pipeline. The worker
//! pipeline remains local and deterministic; cloud perception is an optional
//! post-processing pass that enriches an `AnalysisBundle` with semantic frame
//! observations and speaker-aware transcript detail.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose, Engine as _};
use reqwest::multipart;
use serde::Deserialize;
use tokio::process::Command;

use crate::core::annotations::models::{estimate_word_timings, ShotResult, TranscriptSegment};
use crate::core::process::configure_tokio_command;
use crate::core::{CoreError, CoreResult};

use super::types::{
    CameraAngle, FrameAnalysis, FrameObservation, MotionDirection, PerceptionProviderMetadata,
    SpeakerSegment, SubjectPosition, TranscriptDetail,
};

const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_VISION_MODEL: &str = "gpt-4.1-mini";
const DEFAULT_TRANSCRIPT_MODEL: &str = "gpt-4o-transcribe-diarize";
const MAX_VISION_FRAMES_PER_REQUEST: usize = 24;
const AUDIO_CHUNK_SECONDS: u32 = 600;
const AUDIO_CHUNK_BITRATE: &str = "64k";

/// OpenAI perception configuration resolved from app settings and credential vault.
#[derive(Clone, Debug)]
pub struct OpenAiPerceptionConfig {
    pub api_key: String,
    pub vision_model: String,
    pub transcript_model: String,
    pub base_url: String,
}

impl OpenAiPerceptionConfig {
    pub fn new(api_key: String, vision_model: Option<String>) -> Self {
        Self {
            api_key,
            vision_model: vision_model.unwrap_or_else(|| DEFAULT_VISION_MODEL.to_string()),
            transcript_model: DEFAULT_TRANSCRIPT_MODEL.to_string(),
            base_url: OPENAI_BASE_URL.to_string(),
        }
    }
}

#[derive(Debug)]
struct VisionInputFrame {
    shot_index: usize,
    time_sec: f64,
    image_path: PathBuf,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<OpenAiChatChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatChoice {
    message: OpenAiChatMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VisionJsonEnvelope {
    frames: Vec<VisionJsonFrame>,
}

#[derive(Debug, Deserialize)]
struct VisionJsonFrame {
    shot_index: usize,
    #[serde(default)]
    camera_angle: Option<String>,
    #[serde(default)]
    subject_position: Option<String>,
    #[serde(default)]
    motion_direction: Option<String>,
    #[serde(default)]
    visual_complexity: Option<f64>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    subjects: Vec<String>,
    #[serde(default)]
    actions: Vec<String>,
    #[serde(default)]
    setting: Option<String>,
    #[serde(default)]
    visible_text: Vec<String>,
    #[serde(default)]
    objects: Vec<String>,
    #[serde(default)]
    edit_usefulness: Option<String>,
    #[serde(default)]
    confidence: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct DiarizedTranscriptResponse {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    segments: Vec<DiarizedTranscriptSegment>,
}

#[derive(Debug, Deserialize)]
struct DiarizedTranscriptSegment {
    start: f64,
    end: f64,
    text: String,
    #[serde(default)]
    speaker: Option<String>,
    #[serde(default)]
    confidence: Option<f64>,
}

/// Runs OpenAI vision over extracted shot keyframes and returns legacy frame
/// classifications plus v2 semantic frame observations.
pub async fn analyze_keyframes_with_openai(
    config: &OpenAiPerceptionConfig,
    shots: &[ShotResult],
    contact_sheet_path: Option<&Path>,
) -> CoreResult<(Vec<FrameAnalysis>, Vec<FrameObservation>)> {
    let inputs = collect_vision_inputs(shots);
    if inputs.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }

    let response_text = request_openai_vision(config, &inputs, contact_sheet_path).await?;
    parse_openai_vision_response(&response_text, shots, &inputs, config)
}

/// Runs OpenAI speaker diarization transcription on compressed audio chunks.
pub async fn transcribe_with_openai(
    config: &OpenAiPerceptionConfig,
    video_path: &Path,
    output_dir: &Path,
    ffmpeg_path: &Path,
) -> CoreResult<(Vec<TranscriptSegment>, TranscriptDetail)> {
    let chunk_dir = output_dir.join("openai-audio-chunks");
    let chunk_paths = extract_audio_chunks(video_path, &chunk_dir, ffmpeg_path).await?;
    if chunk_paths.is_empty() {
        return Err(CoreError::AnalysisFailed(
            "OpenAI transcription could not extract any audio chunks".to_string(),
        ));
    }

    let mut segments = Vec::new();
    let mut speaker_segments = Vec::new();

    for (index, chunk_path) in chunk_paths.iter().enumerate() {
        let offset_sec = index as f64 * AUDIO_CHUNK_SECONDS as f64;
        let chunk_response = request_openai_diarized_transcript(config, chunk_path).await?;
        let (chunk_segments, chunk_speaker_segments) =
            parse_diarized_transcript_response(&chunk_response, offset_sec);
        segments.extend(chunk_segments);
        speaker_segments.extend(chunk_speaker_segments);
    }

    if segments.is_empty() {
        return Err(CoreError::AnalysisFailed(
            "OpenAI transcription returned no timed segments".to_string(),
        ));
    }

    let full = segments
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let words = estimate_word_timings(&segments);
    let detail = TranscriptDetail {
        full,
        words,
        speaker_segments,
        provider: Some(PerceptionProviderMetadata::new(
            "openai",
            &config.transcript_model,
        )),
    };

    Ok((segments, detail))
}

fn collect_vision_inputs(shots: &[ShotResult]) -> Vec<VisionInputFrame> {
    shots
        .iter()
        .enumerate()
        .filter_map(|(shot_index, shot)| {
            let image_path = shot.keyframe_path.as_ref().map(PathBuf::from)?;
            if !image_path.is_file() {
                return None;
            }

            Some(VisionInputFrame {
                shot_index,
                time_sec: (shot.start_sec + shot.end_sec) / 2.0,
                image_path,
            })
        })
        .take(MAX_VISION_FRAMES_PER_REQUEST)
        .collect()
}

async fn request_openai_vision(
    config: &OpenAiPerceptionConfig,
    inputs: &[VisionInputFrame],
    contact_sheet_path: Option<&Path>,
) -> CoreResult<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| CoreError::Internal(format!("Failed to create OpenAI client: {error}")))?;

    let mut content = vec![serde_json::json!({
        "type": "text",
        "text": build_vision_prompt(inputs),
    })];

    for input in inputs {
        content.push(build_openai_image_content(&input.image_path, "keyframe").await?);
    }

    if let Some(path) = contact_sheet_path.filter(|path| path.is_file()) {
        content.push(build_openai_image_content(path, "contact sheet").await?);
    }

    let body = serde_json::json!({
        "model": config.vision_model,
        "messages": [
            {
                "role": "system",
                "content": "You analyze video source keyframes for a professional editing agent. Return compact, valid JSON only."
            },
            {
                "role": "user",
                "content": content
            }
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0
    });

    let response = client
        .post(format!("{}/chat/completions", config.base_url))
        .bearer_auth(&config.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            CoreError::AIRequestFailed(format!("OpenAI vision request failed: {error}"))
        })?;

    let status = response.status();
    let body = response.text().await.map_err(|error| {
        CoreError::AIRequestFailed(format!("OpenAI vision response read failed: {error}"))
    })?;
    if !status.is_success() {
        return Err(CoreError::AIRequestFailed(format!(
            "OpenAI vision request failed with status {status}: {body}"
        )));
    }

    let parsed: OpenAiChatResponse = serde_json::from_str(&body).map_err(|error| {
        CoreError::AnalysisFailed(format!(
            "OpenAI vision response was not valid JSON: {error}"
        ))
    })?;
    parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_deref())
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            CoreError::AnalysisFailed("OpenAI vision response did not include content".to_string())
        })
}

async fn build_openai_image_content(path: &Path, label: &str) -> CoreResult<serde_json::Value> {
    let bytes = tokio::fs::read(path).await.map_err(|error| {
        CoreError::AnalysisFailed(format!(
            "Failed to read {label} {}: {}",
            path.display(),
            error
        ))
    })?;
    let encoded = general_purpose::STANDARD.encode(bytes);

    Ok(serde_json::json!({
        "type": "image_url",
        "image_url": {
            "url": format!("data:image/jpeg;base64,{encoded}"),
            "detail": "low"
        }
    }))
}

fn build_vision_prompt(inputs: &[VisionInputFrame]) -> String {
    let shot_map = inputs
        .iter()
        .map(|input| {
            format!(
                "- shot_index {} at {:.3}s",
                input.shot_index, input.time_sec
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "Analyze the attached keyframes. They correspond to these source-video shots:\n{shot_map}\n\nA final contact sheet image may also be attached for global context; do not invent extra shot indexes from it.\n\nReturn exactly this JSON shape:\n{{\"frames\":[{{\"shot_index\":0,\"camera_angle\":\"wide|medium|close|extreme_close|unknown\",\"subject_position\":\"center|left|right|top|bottom|unknown\",\"motion_direction\":\"static|pan_left|pan_right|tilt_up|tilt_down|zoom_in|zoom_out|unknown\",\"visual_complexity\":0.0,\"description\":\"one sentence\",\"subjects\":[\"person\"],\"actions\":[\"speaking\"],\"setting\":\"studio\",\"visible_text\":[\"text\"],\"objects\":[\"microphone\"],\"edit_usefulness\":\"how an editor could use it\",\"confidence\":0.0}}]}}\nUse the provided shot_index values. Keep arrays short and omit guesses when uncertain."
    )
}

fn parse_openai_vision_response(
    response_text: &str,
    shots: &[ShotResult],
    inputs: &[VisionInputFrame],
    config: &OpenAiPerceptionConfig,
) -> CoreResult<(Vec<FrameAnalysis>, Vec<FrameObservation>)> {
    let json_text = extract_json_object(response_text).unwrap_or(response_text);
    let parsed: VisionJsonEnvelope = serde_json::from_str(json_text).map_err(|error| {
        CoreError::AnalysisFailed(format!("OpenAI vision JSON did not match schema: {error}"))
    })?;
    let input_by_shot = inputs
        .iter()
        .map(|input| (input.shot_index, input))
        .collect::<std::collections::HashMap<_, _>>();
    let provider = PerceptionProviderMetadata::new("openai", &config.vision_model);
    let mut frame_analysis = shots
        .iter()
        .enumerate()
        .map(|(index, _)| FrameAnalysis::local_fallback(index, 0.5))
        .collect::<Vec<_>>();
    let mut observations = Vec::new();

    for frame in parsed.frames {
        if frame.shot_index >= shots.len() {
            continue;
        }

        let input = match input_by_shot.get(&frame.shot_index) {
            Some(input) => *input,
            None => continue,
        };
        let confidence = frame.confidence.unwrap_or(0.75).clamp(0.0, 1.0);
        frame_analysis[frame.shot_index] = FrameAnalysis {
            shot_index: frame.shot_index,
            camera_angle: parse_camera_angle(frame.camera_angle.as_deref()),
            subject_position: parse_subject_position(frame.subject_position.as_deref()),
            motion_direction: parse_motion_direction(frame.motion_direction.as_deref()),
            visual_complexity: frame.visual_complexity.unwrap_or(0.5).clamp(0.0, 1.0),
        };
        observations.push(FrameObservation {
            shot_index: frame.shot_index,
            time_sec: input.time_sec,
            image_path: input.image_path.to_string_lossy().to_string(),
            description: normalize_optional_text(frame.description)
                .unwrap_or_else(|| "No reliable visual description returned.".to_string()),
            subjects: normalize_string_vec(frame.subjects, 8),
            actions: normalize_string_vec(frame.actions, 8),
            setting: normalize_optional_text(frame.setting),
            visible_text: normalize_string_vec(frame.visible_text, 12),
            objects: normalize_string_vec(frame.objects, 12),
            edit_usefulness: normalize_optional_text(frame.edit_usefulness),
            confidence,
            provider: provider.clone(),
        });
    }

    Ok((frame_analysis, observations))
}

async fn extract_audio_chunks(
    video_path: &Path,
    chunk_dir: &Path,
    ffmpeg_path: &Path,
) -> CoreResult<Vec<PathBuf>> {
    if chunk_dir.exists() {
        tokio::fs::remove_dir_all(chunk_dir)
            .await
            .map_err(|error| {
                CoreError::AnalysisFailed(format!(
                    "Failed to clear stale OpenAI audio chunk directory {}: {}",
                    chunk_dir.display(),
                    error
                ))
            })?;
    }
    tokio::fs::create_dir_all(chunk_dir).await?;
    let output_pattern = chunk_dir.join("chunk-%03d.mp3");

    let mut cmd = Command::new(ffmpeg_path);
    configure_tokio_command(&mut cmd);
    cmd.arg("-hide_banner")
        .arg("-nostdin")
        .arg("-y")
        .arg("-i")
        .arg(video_path)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-b:a")
        .arg(AUDIO_CHUNK_BITRATE)
        .arg("-f")
        .arg("segment")
        .arg("-segment_time")
        .arg(AUDIO_CHUNK_SECONDS.to_string())
        .arg("-reset_timestamps")
        .arg("1")
        .arg(output_pattern)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

    let output = cmd.output().await.map_err(|error| {
        CoreError::Internal(format!(
            "Failed to spawn FFmpeg for audio chunking: {error}"
        ))
    })?;
    if !output.status.success() {
        return Err(CoreError::AnalysisFailed(format!(
            "FFmpeg audio chunk extraction failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let mut paths = Vec::new();
    let mut entries = tokio::fs::read_dir(chunk_dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("mp3") {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

async fn request_openai_diarized_transcript(
    config: &OpenAiPerceptionConfig,
    chunk_path: &Path,
) -> CoreResult<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|error| CoreError::Internal(format!("Failed to create OpenAI client: {error}")))?;
    let bytes = tokio::fs::read(chunk_path).await.map_err(|error| {
        CoreError::AnalysisFailed(format!(
            "Failed to read audio chunk {}: {}",
            chunk_path.display(),
            error
        ))
    })?;
    let filename = chunk_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("chunk.mp3")
        .to_string();
    let file_part = multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str("audio/mpeg")
        .map_err(|error| CoreError::Internal(format!("Invalid multipart MIME type: {error}")))?;
    let form = multipart::Form::new()
        .part("file", file_part)
        .text("model", config.transcript_model.clone())
        .text("response_format", "diarized_json")
        .text("chunking_strategy", "auto");

    let response = client
        .post(format!("{}/audio/transcriptions", config.base_url))
        .bearer_auth(&config.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            CoreError::AIRequestFailed(format!("OpenAI transcription request failed: {error}"))
        })?;
    let status = response.status();
    let body = response.text().await.map_err(|error| {
        CoreError::AIRequestFailed(format!(
            "OpenAI transcription response read failed: {error}"
        ))
    })?;
    if !status.is_success() {
        return Err(CoreError::AIRequestFailed(format!(
            "OpenAI transcription failed with status {status}: {body}"
        )));
    }

    Ok(body)
}

fn parse_diarized_transcript_response(
    response_text: &str,
    offset_sec: f64,
) -> (Vec<TranscriptSegment>, Vec<SpeakerSegment>) {
    let parsed = match serde_json::from_str::<DiarizedTranscriptResponse>(response_text) {
        Ok(parsed) => parsed,
        Err(_) => return (Vec::new(), Vec::new()),
    };
    let mut segments = Vec::new();
    let mut speaker_segments = Vec::new();

    for (index, segment) in parsed.segments.into_iter().enumerate() {
        let speaker = segment
            .speaker
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("speaker_{}", index + 1));
        let confidence = segment.confidence.unwrap_or(0.9).clamp(0.0, 1.0);
        let start_sec = offset_sec + segment.start.max(0.0);
        let end_sec = offset_sec + segment.end.max(segment.start);
        let transcript_segment =
            TranscriptSegment::new(start_sec, end_sec, &segment.text, confidence)
                .with_speaker(&speaker);

        speaker_segments.push(SpeakerSegment {
            start_sec,
            end_sec,
            speaker_id: speaker,
            text: segment.text,
            confidence: Some(confidence),
        });
        segments.push(transcript_segment);
    }

    if segments.is_empty() {
        if let Some(text) = parsed
            .text
            .and_then(|text| normalize_optional_text(Some(text)))
        {
            let segment = TranscriptSegment::new(offset_sec, offset_sec, &text, 0.5);
            segments.push(segment);
        }
    }

    (segments, speaker_segments)
}

fn parse_camera_angle(value: Option<&str>) -> CameraAngle {
    match value
        .unwrap_or("unknown")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "wide" => CameraAngle::Wide,
        "medium" => CameraAngle::Medium,
        "close" => CameraAngle::Close,
        "extreme_close" => CameraAngle::ExtremeClose,
        _ => CameraAngle::Unknown,
    }
}

fn parse_subject_position(value: Option<&str>) -> SubjectPosition {
    match value
        .unwrap_or("unknown")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "center" => SubjectPosition::Center,
        "left" => SubjectPosition::Left,
        "right" => SubjectPosition::Right,
        "top" => SubjectPosition::Top,
        "bottom" => SubjectPosition::Bottom,
        _ => SubjectPosition::Unknown,
    }
}

fn parse_motion_direction(value: Option<&str>) -> MotionDirection {
    match value
        .unwrap_or("unknown")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "static" => MotionDirection::Static,
        "pan_left" => MotionDirection::PanLeft,
        "pan_right" => MotionDirection::PanRight,
        "tilt_up" => MotionDirection::TiltUp,
        "tilt_down" => MotionDirection::TiltDown,
        "zoom_in" => MotionDirection::ZoomIn,
        "zoom_out" => MotionDirection::ZoomOut,
        _ => MotionDirection::Unknown,
    }
}

fn normalize_string_vec(values: Vec<String>, limit: usize) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        if let Some(text) = normalize_optional_text(Some(value)) {
            if !normalized.contains(&text) {
                normalized.push(text);
            }
        }
        if normalized.len() >= limit {
            break;
        }
    }
    normalized
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if start <= end {
        Some(&text[start..=end])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_parse_vision_json_into_frame_observations() {
        let shots = vec![ShotResult::new(0.0, 4.0, 0.9)];
        let inputs = vec![VisionInputFrame {
            shot_index: 0,
            time_sec: 2.0,
            image_path: PathBuf::from("/tmp/keyframe.jpg"),
        }];
        let config = OpenAiPerceptionConfig::new("sk-test".to_string(), None);
        let response = r#"```json
        {
          "frames": [{
            "shot_index": 0,
            "camera_angle": "medium",
            "subject_position": "center",
            "motion_direction": "static",
            "visual_complexity": 0.4,
            "description": "A presenter speaks to camera.",
            "subjects": ["presenter"],
            "actions": ["speaking"],
            "setting": "studio",
            "visible_text": ["LIVE"],
            "objects": ["microphone"],
            "edit_usefulness": "Good explanatory beat.",
            "confidence": 0.87
          }]
        }
        ```"#;

        let (frames, observations) =
            parse_openai_vision_response(response, &shots, &inputs, &config).unwrap();

        assert_eq!(frames[0].camera_angle, CameraAngle::Medium);
        assert_eq!(observations[0].description, "A presenter speaks to camera.");
        assert_eq!(observations[0].visible_text, vec!["LIVE"]);
        assert_eq!(observations[0].provider.provider, "openai");
    }

    #[test]
    fn should_parse_diarized_transcript_with_offset() {
        let response = r#"{
          "text": "Hello there",
          "segments": [
            { "start": 1.0, "end": 2.5, "speaker": "speaker_a", "text": "Hello there", "confidence": 0.91 }
          ]
        }"#;

        let (segments, speaker_segments) = parse_diarized_transcript_response(response, 600.0);

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start_sec, 601.0);
        assert_eq!(segments[0].speaker_id.as_deref(), Some("speaker_a"));
        assert_eq!(speaker_segments[0].end_sec, 602.5);
    }

    #[test]
    fn should_estimate_words_for_openai_transcript_detail() {
        let segments =
            vec![TranscriptSegment::new(0.0, 2.0, "Hello there", 0.9).with_speaker("speaker_a")];
        let words = estimate_word_timings(&segments);

        assert_eq!(words.len(), 2);
        assert_eq!(words[0].speaker_id.as_deref(), Some("speaker_a"));
    }
}
