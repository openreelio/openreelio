//! Semantic enrichment for timeline clip frame evidence.
//!
//! Precision clip analysis answers where a sampled timeline frame comes from.
//! This module adds what the frame appears to contain while keeping semantic
//! perception as derived cache data beside the deterministic clip bundle.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use async_trait::async_trait;
#[cfg(feature = "ai-providers")]
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::analysis::clip_analysis::{
    analyze_timeline_clip_bundle, inspect_timeline_range_bundles,
    load_clip_analysis_bundle_optional, ClipAnalysisBundle, ClipAnalysisOptions,
    FrameExtractionStatus, FrameSample, TimelineRangeSelection,
};
use crate::core::analysis::types::{AnalysisBundle, FrameObservation, PerceptionProviderMetadata};
use crate::core::analysis::AnalysisJobRunner;
use crate::core::ffmpeg::FFmpegRunner;
use crate::core::project::ProjectState;
use crate::core::{CoreError, CoreResult};

const CLIP_PERCEPTION_SCHEMA_VERSION: u32 = 1;
const CLIP_PERCEPTION_PROMPT_VERSION: u32 = 1;
const DEFAULT_MAX_PERCEPTION_FRAMES: u32 = 12;
const MAX_PERCEPTION_FRAMES: u32 = 24;
const SOURCE_OBSERVATION_TOLERANCE_SEC: f64 = 0.25;

/// Stem of the contact sheet built for a clip's sampled frames.
///
/// The file lives beside the perception bundles of the same clip fingerprint,
/// and its name carries a digest of the frames it tiles — see
/// [`perception_contact_sheet_file`]. The clip fingerprint alone is not enough:
/// which of a clip's frames reach the provider also depends on `maxFrames` and
/// on how many a source bundle already covered, so a single name per clip
/// handed a narrower request a sheet of moments its own prompt never listed.
const PERCEPTION_CONTACT_SHEET_FILE_PREFIX: &str = "contact-sheet";

/// Directory the sampled frames are staged into before tiling.
///
/// The contact-sheet builder reads its inputs as an FFmpeg image sequence —
/// `<dir>/%d.jpg` from zero — while clip frames are named `f0001.jpg` and share
/// their directory with frames the sheet does not include. Copies under the
/// expected names are the cheapest way to bridge the two, and the directory is
/// removed again once the sheet exists.
const PERCEPTION_CONTACT_SHEET_STAGING_DIR: &str = "contact-sheet-frames";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipPerceptionDetail {
    #[default]
    Low,
    Auto,
    High,
}

impl ClipPerceptionDetail {
    fn as_api_value(&self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Auto => "auto",
            Self::High => "high",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPerceptionOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub detail: ClipPerceptionDetail,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_frames: Option<u32>,
    #[serde(default = "default_reuse_source_analysis")]
    pub reuse_source_analysis: bool,
    #[serde(default)]
    pub allow_cloud: bool,
    #[serde(default)]
    pub force_refresh: bool,
    /// Send the provider a contact sheet of the clip's sampled frames as well
    /// as the frames themselves.
    ///
    /// Only a provider call reads it, so it has no effect unless `allow_cloud`
    /// is set and a provider is configured. See
    /// [`resolve_perception_contact_sheet`] for how the sheet is obtained and
    /// what is recorded when it cannot be.
    #[serde(default)]
    pub include_contact_sheet: bool,
}

impl Default for ClipPerceptionOptions {
    fn default() -> Self {
        Self {
            provider: None,
            model: None,
            detail: ClipPerceptionDetail::Low,
            max_frames: None,
            reuse_source_analysis: default_reuse_source_analysis(),
            allow_cloud: false,
            force_refresh: false,
            include_contact_sheet: false,
        }
    }
}

fn default_reuse_source_analysis() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipPerceptionEvidenceSource {
    SourceAnalysis,
    ProviderVision,
    LocalFallback,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipPerceptionBundleSource {
    Cached,
    Generated,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipPerceptionQualityStatus {
    Ready,
    Partial,
    Insufficient,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipSemanticCoverage {
    Semantic,
    SourceReuse,
    LocalFallback,
    Missing,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPerceptionQuality {
    pub status: ClipPerceptionQualityStatus,
    pub semantic_coverage: ClipSemanticCoverage,
    pub matched_observation_count: u32,
    pub provider_observation_count: u32,
    pub fallback_observation_count: u32,
    pub missing_sample_ids: Vec<String>,
    pub recommended_actions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipSemanticObservation {
    pub sample_id: String,
    pub timeline_sec: f64,
    pub source_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_index: Option<u64>,
    pub image_path: String,
    pub description: String,
    #[serde(default)]
    pub subjects: Vec<String>,
    #[serde(default)]
    pub actions: Vec<String>,
    #[serde(default)]
    pub visible_text: Vec<String>,
    #[serde(default)]
    pub objects: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setting: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit_usefulness: Option<String>,
    pub confidence: f64,
    pub evidence_source: ClipPerceptionEvidenceSource,
    pub provider: PerceptionProviderMetadata,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPerceptionBundle {
    pub schema_version: u32,
    pub perception_fingerprint: String,
    pub clip_fingerprint: String,
    pub sequence_id: String,
    pub track_id: String,
    pub clip_id: String,
    pub asset_id: String,
    pub source: ClipPerceptionBundleSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub prompt_version: u32,
    pub options: ClipPerceptionOptions,
    pub observations: Vec<ClipSemanticObservation>,
    pub quality: ClipPerceptionQuality,
    pub errors: Vec<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPerceptionResponse {
    pub source: ClipPerceptionBundleSource,
    pub bundle: ClipPerceptionBundle,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipEvidenceSearchHit {
    pub perception_fingerprint: String,
    pub clip_fingerprint: String,
    pub sequence_id: String,
    pub track_id: String,
    pub clip_id: String,
    pub asset_id: String,
    pub sample_id: String,
    pub timeline_sec: f64,
    pub source_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_index: Option<u64>,
    pub image_path: String,
    pub description: String,
    pub confidence: f64,
    pub evidence_source: ClipPerceptionEvidenceSource,
    pub matched_fields: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClipPerceptionProviderSample {
    pub sample_id: String,
    pub timeline_sec: f64,
    pub source_sec: f64,
    pub frame_index: Option<u64>,
    pub image_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClipPerceptionProviderRequest {
    pub clip_fingerprint: String,
    pub asset_id: String,
    pub samples: Vec<ClipPerceptionProviderSample>,
    pub detail: ClipPerceptionDetail,
    /// Overview image tiling the clip's sampled frames in timeline order.
    ///
    /// Present only when the caller asked for it with
    /// [`ClipPerceptionOptions::include_contact_sheet`] and one could be
    /// produced. The individual frames are sent as well; the sheet is what lets
    /// a model see them side by side, so it can answer about continuity and
    /// motion across the clip rather than about each frame alone.
    pub contact_sheet_path: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClipPerceptionProviderObservation {
    pub sample_id: String,
    pub description: String,
    pub subjects: Vec<String>,
    pub actions: Vec<String>,
    pub visible_text: Vec<String>,
    pub objects: Vec<String>,
    pub setting: Option<String>,
    pub edit_usefulness: Option<String>,
    pub confidence: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClipPerceptionProviderResponse {
    pub provider: PerceptionProviderMetadata,
    pub observations: Vec<ClipPerceptionProviderObservation>,
}

#[async_trait]
pub trait ClipPerceptionProvider: Send + Sync {
    async fn analyze_clip_samples(
        &self,
        request: ClipPerceptionProviderRequest,
    ) -> CoreResult<ClipPerceptionProviderResponse>;
}

#[cfg(feature = "ai-providers")]
pub struct OpenAiResponsesClipPerceptionProvider {
    api_key: String,
    model: String,
    base_url: String,
}

#[cfg(feature = "ai-providers")]
impl OpenAiResponsesClipPerceptionProvider {
    pub fn new(api_key: String, model: String, base_url: String) -> Self {
        Self {
            api_key,
            model,
            base_url,
        }
    }
}

#[cfg(feature = "ai-providers")]
#[async_trait]
impl ClipPerceptionProvider for OpenAiResponsesClipPerceptionProvider {
    async fn analyze_clip_samples(
        &self,
        request: ClipPerceptionProviderRequest,
    ) -> CoreResult<ClipPerceptionProviderResponse> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|error| {
                CoreError::Internal(format!("Failed to create OpenAI client: {error}"))
            })?;
        let mut content = vec![serde_json::json!({
            "type": "input_text",
            "text": build_provider_prompt(&request),
        })];

        // The sheet goes first so the model reads the clip as a whole before it
        // reads the frames one by one, which is the order the prompt describes.
        if let Some(contact_sheet) = request
            .contact_sheet_path
            .as_deref()
            .filter(|path| path.is_file())
        {
            content.push(
                build_openai_responses_image_input(contact_sheet, request.detail.as_api_value())
                    .await?,
            );
        }

        for sample in &request.samples {
            content.push(
                build_openai_responses_image_input(
                    &sample.image_path,
                    request.detail.as_api_value(),
                )
                .await?,
            );
        }

        let body = serde_json::json!({
            "model": self.model,
            "input": [
                {
                    "role": "user",
                    "content": content
                }
            ],
            "text": {
                "format": { "type": "json_object" }
            },
            "temperature": 0
        });

        let response = client
            .post(format!("{}/responses", self.base_url.trim_end_matches('/')))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                CoreError::AIRequestFailed(format!(
                    "OpenAI clip perception request failed: {error}"
                ))
            })?;
        let status = response.status();
        let response_body = response.text().await.map_err(|error| {
            CoreError::AIRequestFailed(format!(
                "OpenAI clip perception response read failed: {error}"
            ))
        })?;
        if !status.is_success() {
            return Err(CoreError::AIRequestFailed(format!(
                "OpenAI clip perception failed with status {status}: {response_body}"
            )));
        }

        let text = extract_openai_responses_text(&response_body)?;
        parse_clip_perception_provider_json(
            &text,
            PerceptionProviderMetadata::new("openai", &self.model),
        )
    }
}

pub async fn enrich_clip_perception_bundle(
    project_path: &Path,
    clip_fingerprint: &str,
    options: ClipPerceptionOptions,
    provider: Option<&(dyn ClipPerceptionProvider + Send + Sync)>,
) -> CoreResult<ClipPerceptionResponse> {
    validate_cache_key(clip_fingerprint, "clip analysis fingerprint")?;
    let clip_bundle = load_clip_analysis_bundle_optional(project_path, clip_fingerprint)?
        .ok_or_else(|| CoreError::AnalysisBundleNotFound(clip_fingerprint.to_string()))?;
    // No FFmpeg runner reaches this entry point, so a contact sheet can only be
    // reused here, never built — see [`resolve_perception_contact_sheet`].
    enrich_loaded_clip_perception_bundle(project_path, clip_bundle, options, provider, None).await
}

pub struct TimelineClipPerceptionInput<'a> {
    pub sequence_id: &'a str,
    pub track_id: &'a str,
    pub clip_id: &'a str,
    pub analysis_options: ClipAnalysisOptions,
    pub perception_options: ClipPerceptionOptions,
}

pub struct TimelineRangePerceptionInput<'a> {
    pub selection: TimelineRangeSelection<'a>,
    pub analysis_options: ClipAnalysisOptions,
    pub perception_options: ClipPerceptionOptions,
}

pub async fn describe_timeline_clip_perception(
    project_path: &Path,
    state: &ProjectState,
    ffmpeg: &FFmpegRunner,
    input: TimelineClipPerceptionInput<'_>,
    provider: Option<&(dyn ClipPerceptionProvider + Send + Sync)>,
) -> CoreResult<ClipPerceptionResponse> {
    let analysis = analyze_timeline_clip_bundle(
        project_path,
        state,
        ffmpeg,
        input.sequence_id,
        input.track_id,
        input.clip_id,
        input.analysis_options,
    )
    .await?;
    enrich_loaded_clip_perception_bundle(
        project_path,
        analysis.bundle,
        input.perception_options,
        provider,
        Some(ffmpeg.info().ffmpeg_path.as_path()),
    )
    .await
}

pub async fn describe_timeline_range_perception(
    project_path: &Path,
    state: &ProjectState,
    ffmpeg: &FFmpegRunner,
    input: TimelineRangePerceptionInput<'_>,
    provider: Option<&(dyn ClipPerceptionProvider + Send + Sync)>,
) -> CoreResult<Vec<ClipPerceptionResponse>> {
    let responses = inspect_timeline_range_bundles(
        project_path,
        state,
        ffmpeg,
        input.selection,
        input.analysis_options,
    )
    .await?;
    let mut perception = Vec::new();
    for response in responses {
        perception.push(
            enrich_loaded_clip_perception_bundle(
                project_path,
                response.bundle,
                input.perception_options.clone(),
                provider,
                Some(ffmpeg.info().ffmpeg_path.as_path()),
            )
            .await?,
        );
    }
    Ok(perception)
}

/// Adds semantic observations to a loaded clip bundle and caches the result.
///
/// `ffmpeg_path` is the binary a contact sheet would be built with when the
/// caller asked for one and none exists yet; an entry point that holds no
/// runner passes `None` and can then only reuse a sheet already on disk.
async fn enrich_loaded_clip_perception_bundle(
    project_path: &Path,
    clip_bundle: ClipAnalysisBundle,
    options: ClipPerceptionOptions,
    provider: Option<&(dyn ClipPerceptionProvider + Send + Sync)>,
    ffmpeg_path: Option<&Path>,
) -> CoreResult<ClipPerceptionResponse> {
    let policy = resolve_perception_policy(&options);
    let source_bundle = if policy.reuse_source_analysis {
        AnalysisJobRunner::new(project_path).load_bundle_optional(&clip_bundle.asset_id)?
    } else {
        None
    };
    let perception_fingerprint =
        build_clip_perception_fingerprint(&clip_bundle, source_bundle.as_ref(), &policy);

    if !policy.force_refresh {
        if let Some(bundle) = load_clip_perception_bundle_for_clip(
            project_path,
            &clip_bundle.fingerprint,
            &perception_fingerprint,
        )? {
            return Ok(ClipPerceptionResponse {
                source: ClipPerceptionBundleSource::Cached,
                bundle: ClipPerceptionBundle {
                    source: ClipPerceptionBundleSource::Cached,
                    ..bundle
                },
            });
        }
    }

    let mut errors = Vec::new();
    let ready_samples = clip_bundle
        .samples
        .iter()
        .filter(|sample| sample.extraction_status == FrameExtractionStatus::Ready)
        .cloned()
        .collect::<Vec<_>>();
    let mut observations = Vec::new();
    let mut covered_sample_ids = BTreeSet::new();

    if let Some(source_bundle) = source_bundle.as_ref() {
        let source_observations = source_bundle.frame_observations.as_deref().unwrap_or(&[]);
        for sample in &ready_samples {
            if let Some(source_observation) =
                find_nearest_source_observation(sample, source_observations)
            {
                observations.push(observation_from_source(sample, source_observation));
                covered_sample_ids.insert(sample.sample_id.clone());
            }
        }
    }

    if policy.allow_cloud {
        if let Some(provider) = provider {
            // Held as frames rather than mapped straight to provider samples:
            // the contact sheet has to tile exactly this set. Tiling every
            // ready frame instead put shots on the sheet that no sample_id in
            // the request named, which is the one thing the prompt promises it
            // will not do.
            let requested_frames = ready_samples
                .iter()
                .filter(|sample| !covered_sample_ids.contains(&sample.sample_id))
                .take(policy.max_frames.unwrap_or(DEFAULT_MAX_PERCEPTION_FRAMES) as usize)
                .cloned()
                .collect::<Vec<_>>();
            let request_samples = requested_frames
                .iter()
                .map(provider_sample_from_frame_sample)
                .collect::<Vec<_>>();
            if !request_samples.is_empty() {
                let contact_sheet_path = if policy.include_contact_sheet {
                    match resolve_perception_contact_sheet(
                        project_path,
                        &clip_bundle.fingerprint,
                        &requested_frames,
                        ffmpeg_path,
                    )
                    .await
                    {
                        Ok(path) => Some(path),
                        Err(reason) => {
                            errors.push(reason);
                            None
                        }
                    }
                } else {
                    None
                };

                match provider
                    .analyze_clip_samples(ClipPerceptionProviderRequest {
                        clip_fingerprint: clip_bundle.fingerprint.clone(),
                        asset_id: clip_bundle.asset_id.clone(),
                        samples: request_samples,
                        detail: policy.detail.clone(),
                        contact_sheet_path,
                    })
                    .await
                {
                    Ok(provider_response) => {
                        append_provider_observations(
                            &ready_samples,
                            provider_response,
                            &mut observations,
                            &mut covered_sample_ids,
                        );
                    }
                    Err(error) => {
                        errors.push(format!("Provider clip perception failed: {error}"));
                    }
                }
            }
        } else {
            errors.push(
                "Cloud clip perception was requested, but no compatible provider is configured."
                    .to_string(),
            );
        }
    }

    for sample in &ready_samples {
        if !covered_sample_ids.contains(&sample.sample_id) {
            observations.push(local_fallback_observation(sample));
            covered_sample_ids.insert(sample.sample_id.clone());
        }
    }

    let quality = build_perception_quality(&ready_samples, &observations);
    let bundle = ClipPerceptionBundle {
        schema_version: CLIP_PERCEPTION_SCHEMA_VERSION,
        perception_fingerprint,
        clip_fingerprint: clip_bundle.fingerprint.clone(),
        sequence_id: clip_bundle.sequence_id,
        track_id: clip_bundle.track_id,
        clip_id: clip_bundle.clip_id,
        asset_id: clip_bundle.asset_id,
        source: ClipPerceptionBundleSource::Generated,
        provider: policy.provider.clone(),
        model: policy.model.clone(),
        prompt_version: CLIP_PERCEPTION_PROMPT_VERSION,
        options: policy,
        observations,
        quality,
        errors,
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    save_clip_perception_bundle(project_path, &bundle)?;

    Ok(ClipPerceptionResponse {
        source: ClipPerceptionBundleSource::Generated,
        bundle,
    })
}

pub fn load_clip_perception_bundle_optional(
    project_path: &Path,
    perception_fingerprint: &str,
) -> CoreResult<Option<ClipPerceptionBundle>> {
    validate_cache_key(perception_fingerprint, "clip perception fingerprint")?;
    let root = clip_analysis_root_dir(project_path);
    if !root.exists() {
        return Ok(None);
    }

    let entries = std::fs::read_dir(root)?;
    for entry in entries {
        let entry = entry?;
        let clip_dir = entry.path();
        if !clip_dir.is_dir() {
            continue;
        }
        let path = clip_dir
            .join("perception")
            .join(format!("{perception_fingerprint}.json"));
        if path.exists() {
            let content = std::fs::read_to_string(path)?;
            return Ok(Some(serde_json::from_str(&content)?));
        }
    }
    Ok(None)
}

pub fn search_clip_perception_bundles(
    project_path: &Path,
    query: &str,
    limit: usize,
    sequence_id: Option<&str>,
) -> CoreResult<Vec<ClipEvidenceSearchHit>> {
    let query = query.trim().to_ascii_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    for bundle in list_clip_perception_bundles(project_path)? {
        if sequence_id.is_some_and(|id| id != bundle.sequence_id) {
            continue;
        }
        for observation in &bundle.observations {
            let matched_fields = matched_observation_fields(observation, &query);
            if matched_fields.is_empty() {
                continue;
            }
            hits.push(ClipEvidenceSearchHit {
                perception_fingerprint: bundle.perception_fingerprint.clone(),
                clip_fingerprint: bundle.clip_fingerprint.clone(),
                sequence_id: bundle.sequence_id.clone(),
                track_id: bundle.track_id.clone(),
                clip_id: bundle.clip_id.clone(),
                asset_id: bundle.asset_id.clone(),
                sample_id: observation.sample_id.clone(),
                timeline_sec: observation.timeline_sec,
                source_sec: observation.source_sec,
                frame_index: observation.frame_index,
                image_path: observation.image_path.clone(),
                description: observation.description.clone(),
                confidence: observation.confidence,
                evidence_source: observation.evidence_source.clone(),
                matched_fields,
            });
        }
    }
    hits.sort_by(|left, right| {
        right
            .confidence
            .partial_cmp(&left.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(limit.max(1));
    Ok(hits)
}

fn load_clip_perception_bundle_for_clip(
    project_path: &Path,
    clip_fingerprint: &str,
    perception_fingerprint: &str,
) -> CoreResult<Option<ClipPerceptionBundle>> {
    let path = clip_perception_bundle_path(project_path, clip_fingerprint, perception_fingerprint)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str(&content)?))
}

fn save_clip_perception_bundle(
    project_path: &Path,
    bundle: &ClipPerceptionBundle,
) -> CoreResult<()> {
    let path = clip_perception_bundle_path(
        project_path,
        &bundle.clip_fingerprint,
        &bundle.perception_fingerprint,
    )?;
    crate::core::fs::atomic_write_json_pretty(&path, bundle)
}

fn clip_perception_bundle_path(
    project_path: &Path,
    clip_fingerprint: &str,
    perception_fingerprint: &str,
) -> CoreResult<PathBuf> {
    let directory = clip_perception_dir(project_path, clip_fingerprint)?;
    validate_cache_key(perception_fingerprint, "clip perception fingerprint")?;
    Ok(directory.join(format!("{perception_fingerprint}.json")))
}

/// Directory holding one clip's perception artefacts.
fn clip_perception_dir(project_path: &Path, clip_fingerprint: &str) -> CoreResult<PathBuf> {
    validate_cache_key(clip_fingerprint, "clip analysis fingerprint")?;
    Ok(clip_analysis_root_dir(project_path)
        .join(clip_fingerprint)
        .join("perception"))
}

/// Produces the contact sheet a provider request carries, building it if needed.
///
/// Answers [`ClipPerceptionOptions::include_contact_sheet`]: the model already
/// receives every sampled frame on its own, and the sheet is what lets it see
/// them side by side in timeline order, so it can speak to continuity and
/// motion across the clip instead of frame by frame.
///
/// The sheet is keyed by the clip fingerprint *and* by the exact set of samples
/// it tiles, so an existing file is reused instead of re-encoded while a
/// different selection — a lower `maxFrames`, or frames a source bundle has
/// since covered — gets its own sheet rather than silently inheriting one
/// tiling other moments. `Err` carries the reason in the caller's own terms; it
/// is recorded on the bundle rather than failing the perception run, because a
/// missing overview image degrades the answer without invalidating it.
async fn resolve_perception_contact_sheet(
    project_path: &Path,
    clip_fingerprint: &str,
    samples: &[FrameSample],
    ffmpeg_path: Option<&Path>,
) -> Result<PathBuf, String> {
    let directory = clip_perception_dir(project_path, clip_fingerprint)
        .map_err(|error| format!("Contact sheet context was requested, but {error}"))?;
    let sheet_path = directory.join(perception_contact_sheet_file(samples));
    // Length as well as existence: a run killed mid-encode leaves a zero-byte
    // file behind, and reusing that hands the provider an unreadable image
    // instead of the overview it was promised.
    if std::fs::metadata(&sheet_path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false)
    {
        return Ok(sheet_path);
    }

    let Some(ffmpeg_path) = ffmpeg_path else {
        return Err(
            "Contact sheet context was requested, but this clip has no contact sheet yet and this \
             request cannot build one. Ask for perception through a timeline clip or range call, \
             which can."
                .to_string(),
        );
    };

    let staging_dir = directory.join(PERCEPTION_CONTACT_SHEET_STAGING_DIR);
    let staged = stage_contact_sheet_frames(samples, &staging_dir)
        .await
        .map_err(|error| format!("Contact sheet context was requested, but {error}"))?;

    let result =
        if staged.is_empty() {
            Err("Contact sheet context was requested, but none of the sampled frames could be read \
             from disk."
            .to_string())
        } else {
            let (columns, rows) = contact_sheet_layout(staged.len());
            crate::core::analysis::visual::VisualAnalyzer::new(ffmpeg_path.to_path_buf())
                .generate_contact_sheet_with_layout(&staged, &sheet_path, Some((columns, rows)))
                .await
                .map_err(|error| format!("Contact sheet generation failed: {error}"))
                .and_then(|artifact| {
                    artifact.map(|_| sheet_path.clone()).ok_or_else(|| {
                        "Contact sheet generation produced no sheet for this clip.".to_string()
                    })
                })
        };

    // Staged copies exist only to feed one FFmpeg invocation; leaving them
    // behind would double the on-disk cost of every analysed clip.
    let _ = tokio::fs::remove_dir_all(&staging_dir).await;

    result
}

/// Names the contact sheet after the exact set of frames it tiles.
///
/// The digest covers each sample's id and its extraction status, in sheet
/// order: those are what decide which frames get staged, so two requests that
/// agree on them get the same sheet and anything else gets its own. Sample ids
/// are the analysis bundle's own (`f0001`), so the digest is what keeps the
/// name a safe path component whatever they turn out to be.
fn perception_contact_sheet_file(samples: &[FrameSample]) -> String {
    let basis = samples
        .iter()
        .take(MAX_PERCEPTION_FRAMES as usize)
        .map(|sample| {
            serde_json::json!({
                "sampleId": sample.sample_id,
                "status": sample.extraction_status,
            })
        })
        .collect::<Vec<_>>();
    format!(
        "{PERCEPTION_CONTACT_SHEET_FILE_PREFIX}-{:016x}.jpg",
        stable_hash64(serde_json::Value::from(basis).to_string().as_bytes())
    )
}

/// Copies the sampled frames into `staging_dir` under the names FFmpeg expects.
///
/// The contact-sheet builder reads `<dir>/%d.jpg` from zero, so the copies are
/// numbered contiguously in sample order. A frame that cannot be read is
/// skipped rather than numbered, because a gap in the sequence would silently
/// truncate the sheet at the hole. At most [`MAX_PERCEPTION_FRAMES`] frames are
/// staged, which is the same ceiling a provider request itself carries and what
/// keeps a densely sampled clip from tiling a sheet nobody can read. Returns
/// the staged paths in sheet order.
async fn stage_contact_sheet_frames(
    samples: &[FrameSample],
    staging_dir: &Path,
) -> std::io::Result<Vec<PathBuf>> {
    if staging_dir.exists() {
        tokio::fs::remove_dir_all(staging_dir).await?;
    }
    tokio::fs::create_dir_all(staging_dir).await?;

    let mut staged = Vec::new();
    for sample in samples {
        if staged.len() >= MAX_PERCEPTION_FRAMES as usize {
            break;
        }
        let destination = staging_dir.join(format!("{}.jpg", staged.len()));
        if tokio::fs::copy(&sample.image_path, &destination)
            .await
            .is_ok()
        {
            staged.push(destination);
        }
    }
    Ok(staged)
}

/// Picks the squarest grid that holds `frame_count` cells.
fn contact_sheet_layout(frame_count: usize) -> (usize, usize) {
    let frame_count = frame_count.max(1);
    let columns = (frame_count as f64).sqrt().ceil() as usize;
    let columns = columns.max(1);
    let rows = frame_count.div_ceil(columns);
    (columns, rows.max(1))
}

fn clip_analysis_root_dir(project_path: &Path) -> PathBuf {
    project_path
        .join(".openreelio")
        .join("analysis")
        .join("clips")
}

fn list_clip_perception_bundles(project_path: &Path) -> CoreResult<Vec<ClipPerceptionBundle>> {
    let root = clip_analysis_root_dir(project_path);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut bundles = Vec::new();
    for clip_entry in std::fs::read_dir(root)? {
        let clip_dir = clip_entry?.path();
        let perception_dir = clip_dir.join("perception");
        if !perception_dir.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(perception_dir)? {
            let path = entry?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let content = std::fs::read_to_string(path)?;
            bundles.push(serde_json::from_str(&content)?);
        }
    }
    Ok(bundles)
}

fn validate_cache_key(value: &str, label: &str) -> CoreResult<()> {
    if value.is_empty() {
        return Err(CoreError::ValidationError(format!(
            "{label} must not be empty"
        )));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(CoreError::ValidationError(format!(
            "{label} contains unsafe characters: {value}"
        )));
    }
    Ok(())
}

fn resolve_perception_policy(options: &ClipPerceptionOptions) -> ClipPerceptionOptions {
    ClipPerceptionOptions {
        max_frames: Some(
            options
                .max_frames
                .unwrap_or(DEFAULT_MAX_PERCEPTION_FRAMES)
                .clamp(1, MAX_PERCEPTION_FRAMES),
        ),
        ..options.clone()
    }
}

fn build_clip_perception_fingerprint(
    clip_bundle: &ClipAnalysisBundle,
    source_bundle: Option<&AnalysisBundle>,
    options: &ClipPerceptionOptions,
) -> String {
    let sample_basis = clip_bundle
        .samples
        .iter()
        .map(|sample| {
            serde_json::json!({
                "sampleId": sample.sample_id,
                "timelineSecBits": sample.timeline_sec.to_bits(),
                "sourceSecBits": sample.source_sec.to_bits(),
                "frameIndex": sample.frame_index,
                "imagePath": sample.image_path,
                "status": sample.extraction_status,
            })
        })
        .collect::<Vec<_>>();
    let source_revision = source_bundle.map(|bundle| {
        serde_json::json!({
            "analyzedAt": bundle.analyzed_at,
            "observationCount": bundle.frame_observations.as_ref().map(Vec::len).unwrap_or(0),
        })
    });
    let basis = serde_json::json!({
        "schemaVersion": CLIP_PERCEPTION_SCHEMA_VERSION,
        "promptVersion": CLIP_PERCEPTION_PROMPT_VERSION,
        "clipFingerprint": clip_bundle.fingerprint,
        "assetId": clip_bundle.asset_id,
        "samples": sample_basis,
        "provider": options.provider,
        "model": options.model,
        "detail": options.detail.as_api_value(),
        "maxFrames": options.max_frames,
        "reuseSourceAnalysis": options.reuse_source_analysis,
        "allowCloud": options.allow_cloud,
        "includeContactSheet": options.include_contact_sheet,
        "sourceRevision": source_revision,
    });

    format!(
        "perception_{:016x}",
        stable_hash64(basis.to_string().as_bytes())
    )
}

fn stable_hash64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn find_nearest_source_observation<'a>(
    sample: &FrameSample,
    observations: &'a [FrameObservation],
) -> Option<&'a FrameObservation> {
    observations
        .iter()
        .filter_map(|observation| {
            let distance = (observation.time_sec - sample.source_sec).abs();
            (distance <= SOURCE_OBSERVATION_TOLERANCE_SEC).then_some((distance, observation))
        })
        .min_by(|left, right| {
            left.0
                .partial_cmp(&right.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(_, observation)| observation)
}

fn observation_from_source(
    sample: &FrameSample,
    source: &FrameObservation,
) -> ClipSemanticObservation {
    ClipSemanticObservation {
        sample_id: sample.sample_id.clone(),
        timeline_sec: sample.timeline_sec,
        source_sec: sample.source_sec,
        frame_index: sample.frame_index,
        image_path: sample.image_path.clone(),
        description: source.description.clone(),
        subjects: source.subjects.clone(),
        actions: source.actions.clone(),
        visible_text: source.visible_text.clone(),
        objects: source.objects.clone(),
        setting: source.setting.clone(),
        edit_usefulness: source.edit_usefulness.clone(),
        confidence: source.confidence.clamp(0.0, 1.0),
        evidence_source: ClipPerceptionEvidenceSource::SourceAnalysis,
        provider: source.provider.clone(),
    }
}

fn provider_sample_from_frame_sample(sample: &FrameSample) -> ClipPerceptionProviderSample {
    ClipPerceptionProviderSample {
        sample_id: sample.sample_id.clone(),
        timeline_sec: sample.timeline_sec,
        source_sec: sample.source_sec,
        frame_index: sample.frame_index,
        image_path: PathBuf::from(&sample.image_path),
    }
}

fn append_provider_observations(
    samples: &[FrameSample],
    provider_response: ClipPerceptionProviderResponse,
    observations: &mut Vec<ClipSemanticObservation>,
    covered_sample_ids: &mut BTreeSet<String>,
) {
    let sample_by_id = samples
        .iter()
        .map(|sample| (sample.sample_id.as_str(), sample))
        .collect::<HashMap<_, _>>();
    for provider_observation in provider_response.observations {
        let sample = match sample_by_id.get(provider_observation.sample_id.as_str()) {
            Some(sample) => *sample,
            None => continue,
        };
        if covered_sample_ids.contains(&sample.sample_id) {
            continue;
        }
        observations.push(ClipSemanticObservation {
            sample_id: sample.sample_id.clone(),
            timeline_sec: sample.timeline_sec,
            source_sec: sample.source_sec,
            frame_index: sample.frame_index,
            image_path: sample.image_path.clone(),
            description: provider_observation.description,
            subjects: provider_observation.subjects,
            actions: provider_observation.actions,
            visible_text: provider_observation.visible_text,
            objects: provider_observation.objects,
            setting: provider_observation.setting,
            edit_usefulness: provider_observation.edit_usefulness,
            confidence: provider_observation.confidence.clamp(0.0, 1.0),
            evidence_source: ClipPerceptionEvidenceSource::ProviderVision,
            provider: provider_response.provider.clone(),
        });
        covered_sample_ids.insert(sample.sample_id.clone());
    }
}

fn local_fallback_observation(sample: &FrameSample) -> ClipSemanticObservation {
    ClipSemanticObservation {
        sample_id: sample.sample_id.clone(),
        timeline_sec: sample.timeline_sec,
        source_sec: sample.source_sec,
        frame_index: sample.frame_index,
        image_path: sample.image_path.clone(),
        description: format!(
            "Frame sample {} maps timeline {:.3}s to source {:.3}s; no semantic visual description is available yet.",
            sample.sample_id, sample.timeline_sec, sample.source_sec
        ),
        subjects: Vec::new(),
        actions: Vec::new(),
        visible_text: Vec::new(),
        objects: Vec::new(),
        setting: None,
        edit_usefulness: Some(
            "Use this as timing evidence only, or run semantic perception before making meaning-based edits."
                .to_string(),
        ),
        confidence: 0.35,
        evidence_source: ClipPerceptionEvidenceSource::LocalFallback,
        provider: PerceptionProviderMetadata::new("local", "clip-analysis-timing"),
    }
}

fn build_perception_quality(
    samples: &[FrameSample],
    observations: &[ClipSemanticObservation],
) -> ClipPerceptionQuality {
    let observed_sample_ids = observations
        .iter()
        .map(|observation| observation.sample_id.as_str())
        .collect::<BTreeSet<_>>();
    let missing_sample_ids = samples
        .iter()
        .filter(|sample| !observed_sample_ids.contains(sample.sample_id.as_str()))
        .map(|sample| sample.sample_id.clone())
        .collect::<Vec<_>>();
    let matched_observation_count = observations
        .iter()
        .filter(|observation| {
            observation.evidence_source == ClipPerceptionEvidenceSource::SourceAnalysis
        })
        .count() as u32;
    let provider_observation_count = observations
        .iter()
        .filter(|observation| {
            observation.evidence_source == ClipPerceptionEvidenceSource::ProviderVision
        })
        .count() as u32;
    let fallback_observation_count = observations
        .iter()
        .filter(|observation| {
            observation.evidence_source == ClipPerceptionEvidenceSource::LocalFallback
        })
        .count() as u32;
    let semantic_coverage = if provider_observation_count > 0 {
        ClipSemanticCoverage::Semantic
    } else if matched_observation_count > 0 && fallback_observation_count == 0 {
        ClipSemanticCoverage::SourceReuse
    } else if fallback_observation_count > 0 {
        ClipSemanticCoverage::LocalFallback
    } else {
        ClipSemanticCoverage::Missing
    };
    let status = if observations.is_empty() {
        ClipPerceptionQualityStatus::Insufficient
    } else if missing_sample_ids.is_empty() && fallback_observation_count == 0 {
        ClipPerceptionQualityStatus::Ready
    } else {
        ClipPerceptionQualityStatus::Partial
    };
    let mut recommended_actions = Vec::new();
    if fallback_observation_count > 0 {
        recommended_actions.push(
            "Run source analysis or enable a vision provider before relying on subject/action/OCR semantics."
                .to_string(),
        );
    }
    if !missing_sample_ids.is_empty() {
        recommended_actions.push(format!(
            "{} frame sample(s) have no semantic observation.",
            missing_sample_ids.len()
        ));
    }

    ClipPerceptionQuality {
        status,
        semantic_coverage,
        matched_observation_count,
        provider_observation_count,
        fallback_observation_count,
        missing_sample_ids,
        recommended_actions,
    }
}

fn matched_observation_fields(observation: &ClipSemanticObservation, query: &str) -> Vec<String> {
    let mut fields = Vec::new();
    push_match(&mut fields, "description", &observation.description, query);
    push_match_vec(&mut fields, "subjects", &observation.subjects, query);
    push_match_vec(&mut fields, "actions", &observation.actions, query);
    push_match_vec(&mut fields, "visibleText", &observation.visible_text, query);
    push_match_vec(&mut fields, "objects", &observation.objects, query);
    if let Some(setting) = &observation.setting {
        push_match(&mut fields, "setting", setting, query);
    }
    if let Some(edit_usefulness) = &observation.edit_usefulness {
        push_match(&mut fields, "editUsefulness", edit_usefulness, query);
    }
    fields
}

fn push_match(fields: &mut Vec<String>, field: &str, value: &str, query: &str) {
    if value.to_ascii_lowercase().contains(query) {
        fields.push(field.to_string());
    }
}

fn push_match_vec(fields: &mut Vec<String>, field: &str, values: &[String], query: &str) {
    if values
        .iter()
        .any(|value| value.to_ascii_lowercase().contains(query))
    {
        fields.push(field.to_string());
    }
}

#[derive(Debug, Deserialize)]
struct ProviderJsonEnvelope {
    #[serde(default, alias = "frames")]
    observations: Vec<ProviderJsonObservation>,
}

#[derive(Debug, Deserialize)]
struct ProviderJsonObservation {
    #[serde(alias = "sampleId")]
    sample_id: String,
    description: Option<String>,
    #[serde(default)]
    subjects: Vec<String>,
    #[serde(default)]
    actions: Vec<String>,
    #[serde(default, alias = "visibleText")]
    visible_text: Vec<String>,
    #[serde(default)]
    objects: Vec<String>,
    setting: Option<String>,
    #[serde(alias = "editUsefulness")]
    edit_usefulness: Option<String>,
    confidence: Option<f64>,
}

pub fn parse_clip_perception_provider_json(
    response_text: &str,
    provider: PerceptionProviderMetadata,
) -> CoreResult<ClipPerceptionProviderResponse> {
    let json_text = extract_json_object(response_text).unwrap_or(response_text);
    let parsed: ProviderJsonEnvelope = serde_json::from_str(json_text).map_err(|error| {
        CoreError::AnalysisFailed(format!(
            "Clip perception provider JSON did not match schema: {error}"
        ))
    })?;
    let observations = parsed
        .observations
        .into_iter()
        .filter_map(|observation| {
            let description = normalize_optional_text(observation.description)?;
            Some(ClipPerceptionProviderObservation {
                sample_id: observation.sample_id,
                description,
                subjects: normalize_string_vec(observation.subjects, 8),
                actions: normalize_string_vec(observation.actions, 8),
                visible_text: normalize_string_vec(observation.visible_text, 12),
                objects: normalize_string_vec(observation.objects, 12),
                setting: normalize_optional_text(observation.setting),
                edit_usefulness: normalize_optional_text(observation.edit_usefulness),
                confidence: observation.confidence.unwrap_or(0.75).clamp(0.0, 1.0),
            })
        })
        .collect();

    Ok(ClipPerceptionProviderResponse {
        provider,
        observations,
    })
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
    (start <= end).then_some(&text[start..=end])
}

#[cfg(feature = "ai-providers")]
fn build_provider_prompt(request: &ClipPerceptionProviderRequest) -> String {
    let sample_map = request
        .samples
        .iter()
        .map(|sample| {
            format!(
                "- sample_id {} timeline {:.6}s source {:.6}s frame {}",
                sample.sample_id,
                sample.timeline_sec,
                sample.source_sec,
                sample
                    .frame_index
                    .map(|frame| frame.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let contact_sheet_note = if request.contact_sheet_path.is_some() {
        "\nThe first image is a contact sheet of the clip's sampled frames in timeline order, for continuity across the clip; the images after it are the samples listed above, one per image.\n"
    } else {
        ""
    };
    format!(
        "Analyze these timeline clip frame samples for a video editing agent.\n{sample_map}\n{contact_sheet_note}\nReturn compact JSON only with this shape:\n{{\"observations\":[{{\"sampleId\":\"f0001\",\"description\":\"one sentence\",\"subjects\":[\"person\"],\"actions\":[\"speaking\"],\"visibleText\":[\"text\"],\"objects\":[\"microphone\"],\"setting\":\"studio\",\"editUsefulness\":\"how this frame helps an edit\",\"confidence\":0.0}}]}}\nUse only provided sample IDs. Keep arrays short. Do not infer uncertain identity."
    )
}

#[cfg(feature = "ai-providers")]
async fn build_openai_responses_image_input(
    path: &Path,
    detail: &str,
) -> CoreResult<serde_json::Value> {
    let bytes = tokio::fs::read(path).await.map_err(|error| {
        CoreError::AnalysisFailed(format!(
            "Failed to read frame {}: {}",
            path.display(),
            error
        ))
    })?;
    let encoded = general_purpose::STANDARD.encode(bytes);
    let mime = match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("png") => "image/png",
        Some(ext) if ext.eq_ignore_ascii_case("webp") => "image/webp",
        _ => "image/jpeg",
    };

    Ok(serde_json::json!({
        "type": "input_image",
        "image_url": format!("data:{mime};base64,{encoded}"),
        "detail": detail,
    }))
}

#[cfg(feature = "ai-providers")]
fn extract_openai_responses_text(response_body: &str) -> CoreResult<String> {
    let value: serde_json::Value = serde_json::from_str(response_body).map_err(|error| {
        CoreError::AnalysisFailed(format!(
            "OpenAI clip perception response was not valid JSON: {error}"
        ))
    })?;
    if let Some(text) = value.get("output_text").and_then(|value| value.as_str()) {
        return Ok(text.to_string());
    }

    let output = value
        .get("output")
        .and_then(|value| value.as_array())
        .ok_or_else(|| {
            CoreError::AnalysisFailed(
                "OpenAI clip perception response did not include output items".to_string(),
            )
        })?;
    for item in output {
        if let Some(content) = item.get("content").and_then(|value| value.as_array()) {
            for part in content {
                if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                    return Ok(text.to_string());
                }
            }
        }
    }

    Err(CoreError::AnalysisFailed(
        "OpenAI clip perception response did not include output text".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::analysis::clip_analysis::{
        ClipAnalysisMode, ClipAnalysisQuality, ClipAnalysisQualityStatus, ClipPlaybackSummary,
        ClipSamplePolicy, SourceRangeSummary, TimelineRangeSummary,
    };
    use crate::core::analysis::types::{AnalysisBundle, VideoMetadata};

    fn sample(sample_id: &str, source_sec: f64) -> FrameSample {
        FrameSample {
            sample_id: sample_id.to_string(),
            index: 0,
            timeline_sec: source_sec + 10.0,
            timeline_offset_sec: source_sec,
            source_sec,
            frame_index: Some((source_sec * 30.0).floor() as u64),
            image_path: format!("/tmp/{sample_id}.jpg"),
            width: Some(1920),
            height: Some(1080),
            sampling_reason: "test".to_string(),
            extraction_status: FrameExtractionStatus::Ready,
            error: None,
            signals: crate::core::analysis::clip_analysis::FrameSampleSignals {
                clip_progress: 0.5,
                source_progress: 0.5,
                nearest_boundary: "middle".to_string(),
                visual_complexity: None,
                adjacent_difference: None,
            },
        }
    }

    fn clip_bundle(samples: Vec<FrameSample>) -> ClipAnalysisBundle {
        ClipAnalysisBundle {
            schema_version: 1,
            fingerprint: "clip_test".to_string(),
            sequence_id: "seq-1".to_string(),
            track_id: "track-1".to_string(),
            clip_id: "clip-1".to_string(),
            asset_id: "asset-1".to_string(),
            asset_name: "source.mp4".to_string(),
            asset_hash: "sha256:test".to_string(),
            source_range: SourceRangeSummary {
                source_in_sec: 0.0,
                source_out_sec: 10.0,
                duration_sec: 10.0,
            },
            timeline_range: TimelineRangeSummary {
                timeline_in_sec: 10.0,
                timeline_out_sec: 20.0,
                duration_sec: 10.0,
            },
            playback: ClipPlaybackSummary {
                speed: 1.0,
                reverse: false,
                freeze_frame: false,
                has_time_remap: false,
            },
            sample_policy: ClipSamplePolicy {
                mode: ClipAnalysisMode::Dense,
                target_interval_sec: 0.1,
                max_samples: samples.len() as u32,
                include_edges: true,
                requested_timeline_start_sec: 10.0,
                requested_timeline_end_sec: 20.0,
                effective_timeline_start_sec: 10.0,
                effective_timeline_end_sec: 20.0,
            },
            mapping: Vec::new(),
            samples,
            windows: Vec::new(),
            quality: ClipAnalysisQuality {
                status: ClipAnalysisQualityStatus::Ready,
                score: 100,
                critical_signals: Vec::new(),
                missing_signals: Vec::new(),
                degraded_signals: Vec::new(),
                recommended_actions: Vec::new(),
            },
            artifact_dir: "/tmp/clip".to_string(),
            errors: Vec::new(),
            analyzed_at: "2026-05-29T00:00:00Z".to_string(),
        }
    }

    fn source_observation(time_sec: f64, description: &str) -> FrameObservation {
        FrameObservation {
            shot_index: 0,
            time_sec,
            image_path: "/tmp/source.jpg".to_string(),
            description: description.to_string(),
            subjects: vec!["speaker".to_string()],
            actions: vec!["pointing".to_string()],
            setting: Some("studio".to_string()),
            visible_text: vec!["Q4".to_string()],
            objects: vec!["chart".to_string()],
            edit_usefulness: Some("Use for chart reference.".to_string()),
            confidence: 0.9,
            provider: PerceptionProviderMetadata::new("openai", "test-model"),
        }
    }

    fn source_bundle(observations: Vec<FrameObservation>) -> AnalysisBundle {
        let mut bundle = AnalysisBundle::new("asset-1", VideoMetadata::new(10.0));
        bundle.frame_observations = Some(observations);
        bundle.analyzed_at = "2026-05-29T00:00:00Z".to_string();
        bundle
    }

    #[test]
    fn matches_nearest_source_observation_within_tolerance() {
        let frame = sample("f0001", 2.0);
        let observations = vec![
            source_observation(1.7, "Too far"),
            source_observation(2.08, "Speaker points at a chart."),
        ];

        let matched = find_nearest_source_observation(&frame, &observations).unwrap();

        assert_eq!(matched.description, "Speaker points at a chart.");
    }

    #[test]
    fn matches_exact_source_observation() {
        let frame = sample("f0001", 2.0);
        let observations = vec![source_observation(2.0, "Exact semantic match.")];

        let matched = find_nearest_source_observation(&frame, &observations).unwrap();

        assert_eq!(matched.description, "Exact semantic match.");
    }

    #[test]
    fn rejects_source_observation_outside_tolerance() {
        let frame = sample("f0001", 2.0);
        let observations = vec![source_observation(2.4, "Too far")];

        assert!(find_nearest_source_observation(&frame, &observations).is_none());
    }

    #[test]
    fn builds_source_reuse_observation_with_clip_timing() {
        let frame = sample("f0001", 2.0);
        let observation = observation_from_source(
            &frame,
            &source_observation(2.02, "Speaker points at a chart."),
        );

        assert_eq!(observation.sample_id, "f0001");
        assert_eq!(observation.timeline_sec, 12.0);
        assert_eq!(observation.source_sec, 2.0);
        assert_eq!(
            observation.evidence_source,
            ClipPerceptionEvidenceSource::SourceAnalysis
        );
        assert_eq!(observation.visible_text, vec!["Q4"]);
    }

    #[test]
    fn quality_marks_local_fallback_as_partial() {
        let samples = vec![sample("f0001", 2.0)];
        let observations = vec![local_fallback_observation(&samples[0])];

        let quality = build_perception_quality(&samples, &observations);

        assert_eq!(quality.status, ClipPerceptionQualityStatus::Partial);
        assert_eq!(
            quality.semantic_coverage,
            ClipSemanticCoverage::LocalFallback
        );
        assert_eq!(quality.fallback_observation_count, 1);
    }

    #[test]
    fn quality_records_missing_sample_ids_when_observations_are_absent() {
        let samples = vec![sample("f0001", 2.0)];

        let quality = build_perception_quality(&samples, &[]);

        assert_eq!(quality.status, ClipPerceptionQualityStatus::Insufficient);
        assert_eq!(quality.semantic_coverage, ClipSemanticCoverage::Missing);
        assert_eq!(quality.missing_sample_ids, vec!["f0001"]);
    }

    #[test]
    fn fingerprint_is_stable_and_changes_with_source_revision() {
        let bundle = clip_bundle(vec![sample("f0001", 2.0)]);
        let options = ClipPerceptionOptions::default();
        let source = source_bundle(vec![source_observation(2.0, "Speaker")]);

        let left = build_clip_perception_fingerprint(&bundle, Some(&source), &options);
        let right = build_clip_perception_fingerprint(&bundle, Some(&source), &options);
        let mut changed = source.clone();
        changed.analyzed_at = "2026-05-30T00:00:00Z".to_string();
        let changed_hash = build_clip_perception_fingerprint(&bundle, Some(&changed), &options);

        assert_eq!(left, right);
        assert_ne!(left, changed_hash);
        assert!(left.starts_with("perception_"));
    }

    #[test]
    fn rejects_unsafe_perception_fingerprints() {
        let project_dir = Path::new("/tmp/project");

        let result = load_clip_perception_bundle_optional(project_dir, "../outside");

        assert!(result.is_err());
    }

    #[test]
    fn saves_loads_and_searches_perception_bundle() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle = ClipPerceptionBundle {
            schema_version: CLIP_PERCEPTION_SCHEMA_VERSION,
            perception_fingerprint: "perception_cache".to_string(),
            clip_fingerprint: "clip_cache".to_string(),
            sequence_id: "seq-1".to_string(),
            track_id: "track-1".to_string(),
            clip_id: "clip-1".to_string(),
            asset_id: "asset-1".to_string(),
            source: ClipPerceptionBundleSource::Generated,
            provider: None,
            model: None,
            prompt_version: CLIP_PERCEPTION_PROMPT_VERSION,
            options: ClipPerceptionOptions::default(),
            observations: vec![observation_from_source(
                &sample("f0001", 2.0),
                &source_observation(2.0, "Speaker points at a chart."),
            )],
            quality: ClipPerceptionQuality {
                status: ClipPerceptionQualityStatus::Ready,
                semantic_coverage: ClipSemanticCoverage::SourceReuse,
                matched_observation_count: 1,
                provider_observation_count: 0,
                fallback_observation_count: 0,
                missing_sample_ids: Vec::new(),
                recommended_actions: Vec::new(),
            },
            errors: Vec::new(),
            created_at: "2026-05-29T00:00:00Z".to_string(),
        };

        save_clip_perception_bundle(temp_dir.path(), &bundle).unwrap();
        let loaded = load_clip_perception_bundle_optional(temp_dir.path(), "perception_cache")
            .unwrap()
            .unwrap();
        let hits = search_clip_perception_bundles(temp_dir.path(), "chart", 10, None).unwrap();

        assert_eq!(loaded.perception_fingerprint, "perception_cache");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].sample_id, "f0001");
    }

    /// Records the request it was handed so a test can assert on the plumbing.
    ///
    /// Nothing here reaches the network: the response is fixed.
    #[derive(Default)]
    struct RecordingProvider {
        request: std::sync::Mutex<Option<ClipPerceptionProviderRequest>>,
    }

    impl RecordingProvider {
        fn captured(&self) -> ClipPerceptionProviderRequest {
            self.request
                .lock()
                .expect("recorded request")
                .clone()
                .expect("provider was called")
        }
    }

    #[async_trait]
    impl ClipPerceptionProvider for RecordingProvider {
        async fn analyze_clip_samples(
            &self,
            request: ClipPerceptionProviderRequest,
        ) -> CoreResult<ClipPerceptionProviderResponse> {
            *self.request.lock().expect("record request") = Some(request);
            Ok(ClipPerceptionProviderResponse {
                provider: PerceptionProviderMetadata::new("mock", "mock-model"),
                observations: Vec::new(),
            })
        }
    }

    fn cloud_options(include_contact_sheet: bool) -> ClipPerceptionOptions {
        ClipPerceptionOptions {
            allow_cloud: true,
            reuse_source_analysis: false,
            include_contact_sheet,
            ..ClipPerceptionOptions::default()
        }
    }

    /// Places a readable sheet at the name the given sample set keys.
    fn write_existing_contact_sheet(
        project_path: &Path,
        clip_fingerprint: &str,
        samples: &[FrameSample],
    ) -> PathBuf {
        write_contact_sheet_bytes(project_path, clip_fingerprint, samples, b"sheet")
    }

    fn write_contact_sheet_bytes(
        project_path: &Path,
        clip_fingerprint: &str,
        samples: &[FrameSample],
        bytes: &[u8],
    ) -> PathBuf {
        let directory =
            clip_perception_dir(project_path, clip_fingerprint).expect("perception dir");
        std::fs::create_dir_all(&directory).expect("create perception dir");
        let sheet = directory.join(perception_contact_sheet_file(samples));
        std::fs::write(&sheet, bytes).expect("write contact sheet");
        sheet
    }

    /// Feature: Clip perception contact sheet
    /// Scenario: should hand the provider an existing sheet when one is asked for
    #[tokio::test]
    async fn sends_the_contact_sheet_when_the_option_is_set() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let samples = vec![sample("f0001", 1.0)];
        let bundle = clip_bundle(samples.clone());
        let sheet = write_existing_contact_sheet(temp_dir.path(), &bundle.fingerprint, &samples);
        let provider = RecordingProvider::default();

        let response = enrich_loaded_clip_perception_bundle(
            temp_dir.path(),
            bundle,
            cloud_options(true),
            Some(&provider),
            None,
        )
        .await
        .expect("perception runs");

        assert_eq!(provider.captured().contact_sheet_path, Some(sheet));
        assert!(
            response.bundle.errors.is_empty(),
            "reusing an existing sheet reports nothing: {:?}",
            response.bundle.errors
        );
    }

    /// Feature: Clip perception contact sheet
    /// Scenario: should send no sheet when the option is not set
    #[tokio::test]
    async fn omits_the_contact_sheet_when_the_option_is_unset() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let samples = vec![sample("f0001", 1.0)];
        let bundle = clip_bundle(samples.clone());
        write_existing_contact_sheet(temp_dir.path(), &bundle.fingerprint, &samples);
        let provider = RecordingProvider::default();

        let response = enrich_loaded_clip_perception_bundle(
            temp_dir.path(),
            bundle,
            cloud_options(false),
            Some(&provider),
            None,
        )
        .await
        .expect("perception runs");

        assert_eq!(provider.captured().contact_sheet_path, None);
        assert!(response.bundle.errors.is_empty());
    }

    /// Feature: Clip perception contact sheet
    /// Scenario: should record why no sheet could be attached
    #[tokio::test]
    async fn reports_when_a_requested_contact_sheet_cannot_be_built() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let bundle = clip_bundle(vec![sample("f0001", 1.0)]);
        let provider = RecordingProvider::default();

        let response = enrich_loaded_clip_perception_bundle(
            temp_dir.path(),
            bundle,
            cloud_options(true),
            Some(&provider),
            None,
        )
        .await
        .expect("perception runs");

        assert_eq!(provider.captured().contact_sheet_path, None);
        assert!(
            response
                .bundle
                .errors
                .iter()
                .any(|error| error.contains("Contact sheet context was requested")),
            "the reason is recorded on the bundle: {:?}",
            response.bundle.errors
        );
    }

    /// Feature: Clip perception contact sheet
    /// Scenario: should tile exactly the frames the provider request names
    #[tokio::test]
    async fn keys_the_contact_sheet_to_the_samples_the_request_carries() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let all = vec![
            sample("f0001", 1.0),
            sample("f0002", 2.0),
            sample("f0003", 3.0),
        ];
        let bundle = clip_bundle(all.clone());
        // The budget stops the request at two frames, so a sheet of all three
        // would show the model a shot no sample_id in the prompt names.
        let sheet_of_everything =
            write_existing_contact_sheet(temp_dir.path(), &bundle.fingerprint, &all);
        let requested =
            write_existing_contact_sheet(temp_dir.path(), &bundle.fingerprint, &all[..2]);
        let provider = RecordingProvider::default();

        let response = enrich_loaded_clip_perception_bundle(
            temp_dir.path(),
            bundle,
            ClipPerceptionOptions {
                max_frames: Some(2),
                ..cloud_options(true)
            },
            Some(&provider),
            None,
        )
        .await
        .expect("perception runs");

        let captured = provider.captured();
        assert_eq!(
            captured
                .samples
                .iter()
                .map(|sample| sample.sample_id.as_str())
                .collect::<Vec<_>>(),
            vec!["f0001", "f0002"]
        );
        assert_eq!(captured.contact_sheet_path, Some(requested));
        assert_ne!(captured.contact_sheet_path, Some(sheet_of_everything));
        assert!(response.bundle.errors.is_empty());
    }

    /// Feature: Clip perception contact sheet
    /// Scenario: should not reuse a sheet a killed run left empty
    #[tokio::test]
    async fn rebuilds_a_contact_sheet_that_was_left_behind_empty() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let samples = vec![sample("f0001", 1.0)];
        let bundle = clip_bundle(samples.clone());
        write_contact_sheet_bytes(temp_dir.path(), &bundle.fingerprint, &samples, b"");
        let provider = RecordingProvider::default();

        let response = enrich_loaded_clip_perception_bundle(
            temp_dir.path(),
            bundle,
            cloud_options(true),
            Some(&provider),
            // No runner, so a rebuild is refused — which is how the test can
            // see that the zero-byte file was not simply handed over.
            None,
        )
        .await
        .expect("perception runs");

        assert_eq!(provider.captured().contact_sheet_path, None);
        assert!(
            response
                .bundle
                .errors
                .iter()
                .any(|error| error.contains("Contact sheet context was requested")),
            "an empty sheet must be rebuilt, not reused: {:?}",
            response.bundle.errors
        );
    }

    /// Feature: Clip perception contact sheet
    /// Scenario: should stage readable frames as a contiguous image sequence
    #[tokio::test]
    async fn stages_only_readable_frames_under_sequential_names() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let frames_dir = temp_dir.path().join("frames");
        std::fs::create_dir_all(&frames_dir).expect("create frames dir");

        let mut present = sample("f0001", 1.0);
        present.image_path = frames_dir.join("f0001.jpg").to_string_lossy().to_string();
        std::fs::write(&present.image_path, b"jpg").expect("write frame");
        let mut missing = sample("f0002", 2.0);
        missing.image_path = frames_dir.join("f0002.jpg").to_string_lossy().to_string();
        let mut last = sample("f0003", 3.0);
        last.image_path = frames_dir.join("f0003.jpg").to_string_lossy().to_string();
        std::fs::write(&last.image_path, b"jpg").expect("write frame");

        let staging = temp_dir.path().join("staging");
        let staged = stage_contact_sheet_frames(&[present, missing, last], &staging)
            .await
            .expect("staging runs");

        assert_eq!(staged, vec![staging.join("0.jpg"), staging.join("1.jpg")]);
    }

    /// Feature: Clip perception contact sheet
    /// Scenario: should tell the model what the first image is
    #[cfg(feature = "ai-providers")]
    #[test]
    fn prompt_names_the_contact_sheet_only_when_one_is_attached() {
        let request = ClipPerceptionProviderRequest {
            clip_fingerprint: "clip_test".to_string(),
            asset_id: "asset-1".to_string(),
            samples: vec![provider_sample_from_frame_sample(&sample("f0001", 1.0))],
            detail: ClipPerceptionDetail::Low,
            contact_sheet_path: None,
        };

        assert!(!build_provider_prompt(&request).contains("contact sheet"));
        assert!(build_provider_prompt(&ClipPerceptionProviderRequest {
            contact_sheet_path: Some(PathBuf::from("sheet.jpg")),
            ..request
        })
        .contains("contact sheet"));
    }

    #[test]
    fn parses_provider_json_observations() {
        let provider = PerceptionProviderMetadata::new("openai", "gpt-test");
        let response = r#"```json
        {
          "observations": [
            {
              "sampleId": "f0001",
              "description": "A speaker points at a chart.",
              "subjects": [" speaker ", "speaker"],
              "actions": ["pointing"],
              "visibleText": ["Q4"],
              "objects": ["chart"],
              "setting": "studio",
              "editUsefulness": "Use as a chart cutaway.",
              "confidence": 1.2
            }
          ]
        }
        ```"#;

        let parsed = parse_clip_perception_provider_json(response, provider).unwrap();

        assert_eq!(parsed.observations.len(), 1);
        assert_eq!(parsed.observations[0].sample_id, "f0001");
        assert_eq!(parsed.observations[0].subjects, vec!["speaker"]);
        assert_eq!(parsed.observations[0].confidence, 1.0);
    }
}
