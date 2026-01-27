//! Strict job payload parsing and validation.
//!
//! IPC is a trust boundary. The WebView can be compromised, so any payload coming from the
//! frontend must be treated as untrusted input. This module provides:
//! - Per-job typed payloads (serde `deny_unknown_fields`)
//! - Size limits to mitigate JSON payload DoS
//! - Lightweight semantic validation (lengths, ranges)

use serde::{Deserialize, Serialize};

use crate::core::{fs::validate_path_id_component, AssetId, ClipId, SequenceId, TimeSec, TrackId};

const MAX_JOB_PAYLOAD_BYTES: usize = 256 * 1024; // 256KiB

fn json_size_bytes(value: &serde_json::Value) -> Result<usize, String> {
    serde_json::to_vec(value)
        .map(|b| b.len())
        .map_err(|e| format!("Failed to serialize payload for size check: {e}"))
}

fn enforce_payload_limits(value: &serde_json::Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("Job payload must be a JSON object".to_string());
    }
    let size = json_size_bytes(value)?;
    if size > MAX_JOB_PAYLOAD_BYTES {
        return Err(format!(
            "Job payload too large ({} bytes > {} bytes)",
            size, MAX_JOB_PAYLOAD_BYTES
        ));
    }
    Ok(())
}

fn validate_string_len(label: &str, value: &str, max: usize) -> Result<(), String> {
    if value.len() > max {
        return Err(format!("{label} is too long (max {max} chars)"));
    }
    Ok(())
}

fn validate_id(label: &str, id: &str) -> Result<(), String> {
    validate_path_id_component(id, label)?;
    validate_string_len(label, id, 256)?;
    Ok(())
}

fn validate_time_non_negative(label: &str, t: TimeSec) -> Result<(), String> {
    if t.is_nan() || t.is_infinite() {
        return Err(format!("{label} must be a finite number"));
    }
    if t < 0.0 {
        return Err(format!("{label} cannot be negative"));
    }
    Ok(())
}

// =============================================================================
// Payloads
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThumbnailJobPayload {
    pub asset_id: AssetId,
    pub input_path: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl ThumbnailJobPayload {
    pub fn validate(&self) -> Result<(), String> {
        validate_id("assetId", &self.asset_id)?;
        validate_string_len("inputPath", &self.input_path, 4096)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyJobPayload {
    pub asset_id: AssetId,
    pub input_path: String,
}

impl ProxyJobPayload {
    pub fn validate(&self) -> Result<(), String> {
        validate_id("assetId", &self.asset_id)?;
        validate_string_len("inputPath", &self.input_path, 4096)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaveformJobPayload {
    pub asset_id: AssetId,
    pub input_path: String,
    pub samples_per_second: Option<u32>,
}

impl WaveformJobPayload {
    pub fn validate(&self) -> Result<(), String> {
        validate_id("assetId", &self.asset_id)?;
        validate_string_len("inputPath", &self.input_path, 4096)?;
        if let Some(sps) = self.samples_per_second {
            if !(10..=10_000).contains(&sps) {
                return Err("samplesPerSecond must be between 10 and 10000".to_string());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptionOptionsWire {
    pub model: Option<String>,
    pub language: Option<String>,
    pub translate: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptionJobPayloadWire {
    pub asset_id: AssetId,
    pub input_path: Option<String>,
    pub model: Option<String>,
    pub language: Option<String>,
    pub translate: Option<bool>,
    pub options: Option<TranscriptionOptionsWire>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptionJobPayload {
    pub asset_id: AssetId,
    pub input_path: Option<String>,
    pub model: String,
    pub language: Option<String>,
    pub translate: bool,
}

impl TranscriptionJobPayload {
    fn from_wire(w: TranscriptionJobPayloadWire) -> Self {
        let model = w
            .model
            .or_else(|| w.options.as_ref().and_then(|o| o.model.clone()))
            .unwrap_or_else(|| "base".to_string());
        let language = w
            .language
            .or_else(|| w.options.as_ref().and_then(|o| o.language.clone()));
        let translate = w
            .translate
            .or_else(|| w.options.as_ref().and_then(|o| o.translate))
            .unwrap_or(false);
        Self {
            asset_id: w.asset_id,
            input_path: w.input_path,
            model,
            language,
            translate,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_id("assetId", &self.asset_id)?;
        if let Some(p) = &self.input_path {
            validate_string_len("inputPath", p, 4096)?;
        }
        validate_string_len("model", &self.model, 128)?;
        if let Some(lang) = &self.language {
            validate_string_len("language", lang, 64)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptSegmentPayload {
    pub text: String,
    pub start_time: Option<TimeSec>,
    pub end_time: Option<TimeSec>,
    pub language: Option<String>,
}

impl TranscriptSegmentPayload {
    pub fn validate(&self) -> Result<(), String> {
        validate_string_len("transcriptSegments.text", &self.text, 20_000)?;
        if let Some(t) = self.start_time {
            validate_time_non_negative("transcriptSegments.startTime", t)?;
        }
        if let Some(t) = self.end_time {
            validate_time_non_negative("transcriptSegments.endTime", t)?;
        }
        if let (Some(a), Some(b)) = (self.start_time, self.end_time) {
            if a > b {
                return Err("transcriptSegments.startTime must be <= endTime".to_string());
            }
        }
        if let Some(lang) = &self.language {
            validate_string_len("transcriptSegments.language", lang, 64)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexingJobPayload {
    pub asset_id: AssetId,
    pub name: Option<String>,
    pub path: Option<String>,
    pub kind: Option<String>,
    pub duration: Option<TimeSec>,
    pub project_id: Option<String>,
    pub transcript_segments: Option<Vec<TranscriptSegmentPayload>>,
}

impl IndexingJobPayload {
    pub fn validate(&self) -> Result<(), String> {
        validate_id("assetId", &self.asset_id)?;
        if let Some(v) = &self.name {
            validate_string_len("name", v, 512)?;
        }
        if let Some(v) = &self.path {
            validate_string_len("path", v, 4096)?;
        }
        if let Some(v) = &self.kind {
            validate_string_len("kind", v, 64)?;
        }
        if let Some(d) = self.duration {
            validate_time_non_negative("duration", d)?;
        }
        if let Some(v) = &self.project_id {
            validate_string_len("projectId", v, 256)?;
        }
        if let Some(segs) = &self.transcript_segments {
            if segs.len() > 10_000 {
                return Err("transcriptSegments too large".to_string());
            }
            for seg in segs {
                seg.validate()?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRenderJobPayload {
    pub sequence_id: SequenceId,
    pub start_time: Option<TimeSec>,
    pub end_time: Option<TimeSec>,
}

impl PreviewRenderJobPayload {
    pub fn validate(&self) -> Result<(), String> {
        validate_id("sequenceId", &self.sequence_id)?;
        if let Some(t) = self.start_time {
            validate_time_non_negative("startTime", t)?;
        }
        if let Some(t) = self.end_time {
            validate_time_non_negative("endTime", t)?;
        }
        if let (Some(start), Some(end)) = (self.start_time, self.end_time) {
            if start >= end {
                return Err("Invalid time range: startTime must be < endTime".to_string());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalRenderJobPayload {
    pub sequence_id: SequenceId,
    pub output_path: String,
    pub preset: Option<String>,
}

impl FinalRenderJobPayload {
    pub fn validate(&self) -> Result<(), String> {
        validate_id("sequenceId", &self.sequence_id)?;
        validate_string_len("outputPath", &self.output_path, 4096)?;
        if let Some(p) = &self.preset {
            validate_string_len("preset", p, 64)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AICompletionJobPayload {
    pub prompt: String,
    pub timeline_duration: Option<TimeSec>,
    pub asset_ids: Option<Vec<AssetId>>,
    pub track_ids: Option<Vec<TrackId>>,
    pub selected_clips: Option<Vec<ClipId>>,
    pub playhead_position: Option<TimeSec>,
    pub transcript_context: Option<String>,
}

impl AICompletionJobPayload {
    pub fn validate(&self) -> Result<(), String> {
        validate_string_len("prompt", &self.prompt, 20_000)?;
        if let Some(d) = self.timeline_duration {
            validate_time_non_negative("timelineDuration", d)?;
        }
        if let Some(p) = self.playhead_position {
            validate_time_non_negative("playheadPosition", p)?;
        }
        if let Some(ids) = &self.asset_ids {
            if ids.len() > 50_000 {
                return Err("assetIds too large".to_string());
            }
            for id in ids {
                validate_id("assetIds[]", id)?;
            }
        }
        if let Some(ids) = &self.track_ids {
            if ids.len() > 50_000 {
                return Err("trackIds too large".to_string());
            }
            for id in ids {
                validate_id("trackIds[]", id)?;
            }
        }
        if let Some(ids) = &self.selected_clips {
            if ids.len() > 50_000 {
                return Err("selectedClips too large".to_string());
            }
            for id in ids {
                validate_id("selectedClips[]", id)?;
            }
        }
        if let Some(t) = &self.transcript_context {
            validate_string_len("transcriptContext", t, 200_000)?;
        }
        Ok(())
    }
}

// =============================================================================
// Parser
// =============================================================================

#[derive(Debug, Clone)]
pub enum ValidatedJobPayload {
    Thumbnail(ThumbnailJobPayload),
    Proxy(ProxyJobPayload),
    Waveform(WaveformJobPayload),
    Transcription(TranscriptionJobPayload),
    Indexing(IndexingJobPayload),
    PreviewRender(PreviewRenderJobPayload),
    FinalRender(FinalRenderJobPayload),
    AICompletion(AICompletionJobPayload),
}

impl ValidatedJobPayload {
    pub fn parse(
        job_type: &crate::core::jobs::JobType,
        payload: serde_json::Value,
    ) -> Result<Self, String> {
        enforce_payload_limits(&payload)?;

        match job_type {
            crate::core::jobs::JobType::ThumbnailGeneration => {
                let p: ThumbnailJobPayload = serde_json::from_value(payload)
                    .map_err(|e| format!("Invalid thumbnail_generation payload: {e}"))?;
                p.validate()?;
                Ok(Self::Thumbnail(p))
            }
            crate::core::jobs::JobType::ProxyGeneration => {
                let p: ProxyJobPayload = serde_json::from_value(payload)
                    .map_err(|e| format!("Invalid proxy_generation payload: {e}"))?;
                p.validate()?;
                Ok(Self::Proxy(p))
            }
            crate::core::jobs::JobType::WaveformGeneration => {
                let p: WaveformJobPayload = serde_json::from_value(payload)
                    .map_err(|e| format!("Invalid waveform_generation payload: {e}"))?;
                p.validate()?;
                Ok(Self::Waveform(p))
            }
            crate::core::jobs::JobType::Transcription => {
                let w: TranscriptionJobPayloadWire = serde_json::from_value(payload)
                    .map_err(|e| format!("Invalid transcription payload: {e}"))?;
                let p = TranscriptionJobPayload::from_wire(w);
                p.validate()?;
                Ok(Self::Transcription(p))
            }
            crate::core::jobs::JobType::Indexing => {
                let p: IndexingJobPayload = serde_json::from_value(payload)
                    .map_err(|e| format!("Invalid indexing payload: {e}"))?;
                p.validate()?;
                Ok(Self::Indexing(p))
            }
            crate::core::jobs::JobType::PreviewRender => {
                let p: PreviewRenderJobPayload = serde_json::from_value(payload)
                    .map_err(|e| format!("Invalid preview_render payload: {e}"))?;
                p.validate()?;
                Ok(Self::PreviewRender(p))
            }
            crate::core::jobs::JobType::FinalRender => {
                let p: FinalRenderJobPayload = serde_json::from_value(payload)
                    .map_err(|e| format!("Invalid final_render payload: {e}"))?;
                p.validate()?;
                Ok(Self::FinalRender(p))
            }
            crate::core::jobs::JobType::AICompletion => {
                let p: AICompletionJobPayload = serde_json::from_value(payload)
                    .map_err(|e| format!("Invalid ai_completion payload: {e}"))?;
                p.validate()?;
                Ok(Self::AICompletion(p))
            }
        }
    }

    pub fn into_value(self) -> serde_json::Value {
        match self {
            Self::Thumbnail(p) => serde_json::to_value(p).unwrap_or_else(|_| serde_json::json!({})),
            Self::Proxy(p) => serde_json::to_value(p).unwrap_or_else(|_| serde_json::json!({})),
            Self::Waveform(p) => serde_json::to_value(p).unwrap_or_else(|_| serde_json::json!({})),
            Self::Transcription(p) => {
                serde_json::to_value(p).unwrap_or_else(|_| serde_json::json!({}))
            }
            Self::Indexing(p) => serde_json::to_value(p).unwrap_or_else(|_| serde_json::json!({})),
            Self::PreviewRender(p) => {
                serde_json::to_value(p).unwrap_or_else(|_| serde_json::json!({}))
            }
            Self::FinalRender(p) => {
                serde_json::to_value(p).unwrap_or_else(|_| serde_json::json!({}))
            }
            Self::AICompletion(p) => {
                serde_json::to_value(p).unwrap_or_else(|_| serde_json::json!({}))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::jobs::JobType;

    #[test]
    fn rejects_non_object_payloads() {
        let err = ValidatedJobPayload::parse(&JobType::PreviewRender, serde_json::json!(123))
            .unwrap_err();
        assert!(err.contains("must be a JSON object"));
    }

    #[test]
    fn rejects_unknown_fields() {
        let payload = serde_json::json!({
            "assetId": "asset_001",
            "inputPath": "C:\\\\a.mp4",
            "__proto__": {"pollute": true}
        });
        let err = ValidatedJobPayload::parse(&JobType::ProxyGeneration, payload).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("unknown field"));
    }

    #[test]
    fn enforces_time_range_validation() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "startTime": 10.0,
            "endTime": 10.0
        });
        let err = ValidatedJobPayload::parse(&JobType::PreviewRender, payload).unwrap_err();
        assert!(err.contains("startTime must be < endTime"));
    }

    #[test]
    fn canonicalizes_transcription_options() {
        let payload = serde_json::json!({
            "assetId": "asset_001",
            "options": { "model": "tiny", "translate": true }
        });
        let parsed = ValidatedJobPayload::parse(&JobType::Transcription, payload).unwrap();
        match parsed {
            ValidatedJobPayload::Transcription(p) => {
                assert_eq!(p.model, "tiny");
                assert!(p.translate);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn rejects_oversized_payloads() {
        let huge = "a".repeat(300 * 1024);
        let payload = serde_json::json!({
            "prompt": huge
        });
        let err = ValidatedJobPayload::parse(&JobType::AICompletion, payload).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("too large") || err.contains("too long"));
    }
}
