//! Timeline and asset frame extraction.
//!
//! Turns a timeline time into a still. The default is the picture the export
//! pipeline produces — captions, text, transforms, layered clips and blends all
//! included — served in three tiers, cheapest first:
//!
//! 1. **Cache** — a preview-cache segment already covering the requested time.
//!    Those segments are written by the export pipeline in a lossless intra
//!    codec, so a frame decoded out of one *is* the export composite, at the
//!    cost of a single seek.
//! 2. **Composite** — a minimal window rendered here and now through the same
//!    stack, in the same lossless profile.
//! 3. **Source** — `fast` mode only, and only on explicit request: the topmost
//!    clip's own media, which shows the footage but not the edit.

use super::sampler::{SampleReason, SamplerReport};
use super::sheet::{build_contact_sheet, grid_cell_extract_width, resolve_cell_size, CellStaging};
use super::{
    batch_frame_name, create_batch_output_dir, ensure_times_inside_sequence, remove_stale_output,
    resolve_sequence, resolve_single_output_path, FrameEntry, FrameProbeError, FrameProbeProject,
    FrameProbeRequest, FrameProbeResult, GridCell, TimelineMode, DEFAULT_MAX_WIDTH,
};
use crate::core::assets::Asset;
use crate::core::effects::Effect;
use crate::core::ffmpeg::{FFmpegRunner, FrameExtractOptions};
use crate::core::render::cache::transition_effect_reach_sec;
use crate::core::render::export::effective_blend_mode_for_clip;
use crate::core::render::{
    build_render_graph, build_render_plan, clip_needs_transform_composition, clip_source_time_at,
    is_text_clip, manifest_for_profile, preview_profile_hash, probed_image_dimensions,
    profile_cache_dir, refresh_manifest_plan_fingerprints, resolve_cached_segment_path,
    scaled_frame_dimensions, source_dimensions_from_audio_info, source_durations_from_audio_info,
    track_included_in_export, validate_export_settings_with_dimensions, ExportEngine,
    ExportSettings, ExportValidation, FrameExportSettings, ImageFormat, RenderCacheConfig,
    RenderCacheManifest, RenderCacheSegment, RenderGraph, SourceDimensionMap,
};
use crate::core::timeline::{BlendMode, Canvas, Clip, Sequence, TrackKind};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Shortest composited window that FFmpeg can still render.
///
/// `normalize_output_time_range` rejects zero-length ranges, so a single
/// composited frame is rendered as a tiny non-zero window.
pub const MIN_COMPOSITE_WINDOW_SEC: f64 = 0.05;

/// Container the composited window is rendered into.
///
/// Ut Video — the lossless codec [`ExportSettings::preview_cache`] encodes with,
/// and the one the render cache stores — cannot be carried in MP4, so the
/// extension has to agree with the profile or FFmpeg refuses the mux.
const COMPOSITE_RENDER_EXTENSION: &str = "mov";

/// Slack subtracted from a cached segment's end when the frame rate is unusable.
///
/// Only a fallback: with a real frame rate the end clamp is the segment's final
/// stored frame (see [`cache_frame_offset_sec`]), because the decoder addresses
/// by nearest frame and errors out of range rather than saturating. Without a
/// frame rate there is no frame count to clamp to, so a sliver of a second is
/// taken off the segment's wall-clock length instead.
const CACHE_SEGMENT_END_EPSILON_SEC: f64 = 0.001;

/// Where a still's pixels came from.
///
/// Reported on every timeline still so a caller can tell an export-accurate
/// picture from footage: `cache` and `composite` are both the composited edit
/// and are interchangeable, `source` is the raw clip with the edit stripped off.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameSource {
    /// Decoded out of a fresh preview-cache segment the export pipeline wrote.
    Cache,
    /// Rendered here and now through the full composite stack.
    Composite,
    /// Read straight from the topmost clip's own media, in `fast` mode.
    Source,
}

/// How many stills of a contact sheet came from each tier.
#[derive(Default, Serialize)]
struct FrameSourceCounts {
    cache: usize,
    composite: usize,
    source: usize,
}

impl FrameSourceCounts {
    fn record(&mut self, source: FrameSource) {
        match source {
            FrameSource::Cache => self.cache += 1,
            FrameSource::Composite => self.composite += 1,
            FrameSource::Source => self.source += 1,
        }
    }
}

/// What a sampler decided, for the payload the extraction reports.
///
/// `reasons` runs parallel to the times it was built from, so entry `n` explains
/// frame `n`. Kept beside the times rather than folded into them because every
/// other path through this module has no reason to report at all.
pub(super) struct SamplerContext<'a> {
    /// Why each time was chosen, in the same order as the times.
    pub reasons: &'a [SampleReason],
    /// The sampler run's own arithmetic.
    pub report: &'a SamplerReport,
}

impl SamplerContext<'_> {
    /// The reason for the nth extracted time, if there is one.
    fn reason(&self, index: usize) -> Option<SampleReason> {
        self.reasons.get(index).copied()
    }
}

/// Adds the sampler report to a finished payload.
fn attach_sampler_report(
    payload: &mut serde_json::Value,
    sampler: Option<&SamplerContext<'_>>,
) -> FrameProbeResult<()> {
    let Some(sampler) = sampler else {
        return Ok(());
    };
    let Some(object) = payload.as_object_mut() else {
        return Ok(());
    };
    let report = serde_json::to_value(sampler.report).map_err(|error| {
        FrameProbeError::new(format!("Failed to report the sampler result: {}", error))
    })?;
    object.insert("sampler".to_string(), report);

    Ok(())
}

/// Extracts a single still from an asset's own media timebase.
pub(super) async fn run_asset_mode(
    project: &FrameProbeProject<'_>,
    runner: &FFmpegRunner,
    asset_id: &str,
    source_time: f64,
    out: &Path,
    format: ImageFormat,
    max_width: Option<u32>,
) -> FrameProbeResult<serde_json::Value> {
    let asset = project
        .state
        .assets
        .get(asset_id)
        .ok_or_else(|| FrameProbeError::new(format!("Asset '{}' not found", asset_id)))?;
    let media_path = asset.resolved_path(project.path);

    let output_path = resolve_single_output_path(out, source_time, format)?;
    runner
        .extract_frame_with_options(
            &media_path,
            source_time,
            &output_path,
            &FrameExtractOptions {
                overwrite: true,
                max_width,
                quality: None,
            },
        )
        .await
        .map_err(|error| FrameProbeError::new(format!("Frame extraction failed: {}", error)))?;

    let (width, height) = probed_image_dimensions(runner, &output_path)
        .await
        .unwrap_or_else(|| {
            asset
                .video
                .as_ref()
                .map(|video| scaled_frame_dimensions(video.width, video.height, max_width))
                .unwrap_or((0, 0))
        });

    let frame = FrameEntry {
        index: 0,
        time_sec: source_time,
        source_time_sec: Some(source_time),
        clip_id: None,
        asset_id: Some(asset_id.to_string()),
        path: output_path.display().to_string(),
        width,
        height,
        // The request named the asset's own media, so the media is the answer.
        source: FrameSource::Source,
        fell_back_to_composite: None,
        // An asset time is named by the caller, never derived by a sampler.
        reason: None,
    };

    Ok(serde_json::json!({
        "status": "ok",
        "mode": "asset",
        "frames": [frame],
        "count": 1,
        // A single asset is extracted from its own media, with no sequence to
        // validate; the field is present for a uniform payload shape.
        "warnings": Vec::<String>::new(),
    }))
}

/// Extracts one or many timeline stills.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_timeline_mode(
    project: &FrameProbeProject<'_>,
    runner: &FFmpegRunner,
    request: &FrameProbeRequest,
    format: ImageFormat,
    mode: TimelineMode,
    times: &[f64],
    batch: bool,
    sampler: Option<&SamplerContext<'_>>,
) -> FrameProbeResult<serde_json::Value> {
    let (sequence_id, sequence) = resolve_sequence(project, request.sequence.clone())?;
    ensure_times_inside_sequence(sequence, times)?;
    let mut context = TimelineFrameContext::new(
        runner,
        project,
        sequence,
        &sequence_id,
        format.clone(),
        request.max_width.unwrap_or(DEFAULT_MAX_WIDTH),
        mode,
    );
    context.measure_sources().await;

    if batch {
        create_batch_output_dir(&request.out)?;
    }

    let mut frames = Vec::with_capacity(times.len());
    for (index, time) in times.iter().enumerate() {
        let output_path = if batch {
            request.out.join(batch_frame_name(*time, &format))
        } else {
            resolve_single_output_path(&request.out, *time, format.clone())?
        };
        let mut frame = context.extract(index, *time, &output_path).await?;
        frame.reason = sampler.and_then(|sampler| sampler.reason(index));
        frames.push(frame);
    }

    let mut payload = serde_json::json!({
        "status": "ok",
        "mode": mode.label(),
        "frames": frames,
        "count": frames.len(),
        "warnings": context.warnings(),
    });
    attach_sampler_report(&mut payload, sampler)?;

    Ok(payload)
}

/// Builds a contact sheet from timeline times.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_grid_mode(
    project: &FrameProbeProject<'_>,
    runner: &FFmpegRunner,
    request: &FrameProbeRequest,
    format: ImageFormat,
    mode: TimelineMode,
    columns: usize,
    rows: usize,
    times: &[f64],
    sampler: Option<&SamplerContext<'_>>,
) -> FrameProbeResult<serde_json::Value> {
    let (sequence_id, sequence) = resolve_sequence(project, request.sequence.clone())?;
    ensure_times_inside_sequence(sequence, times)?;
    let cell = resolve_cell_size(request);
    let mut context = TimelineFrameContext::new(
        runner,
        project,
        sequence,
        &sequence_id,
        // Contact sheet cells are always JPEG: FFmpeg reads them back as a
        // `%d.jpg` image sequence.
        ImageFormat::Jpeg,
        grid_cell_extract_width(request, cell),
        mode,
    );
    context.measure_sources().await;

    let staging = CellStaging::new(cell, request.label_cells)?;

    let mut cell_paths = Vec::with_capacity(times.len());
    let mut cells = Vec::with_capacity(times.len());
    let mut sources = FrameSourceCounts::default();
    for (index, time) in times.iter().enumerate() {
        let entry = context
            .extract(index, *time, &staging.extract_path(index))
            .await?;
        sources.record(entry.source);
        cell_paths.push(staging.finish(runner, index, *time).await?);
        cells.push(GridCell {
            index,
            row: index / columns,
            col: index % columns,
            timeline_sec: *time,
            reason: sampler.and_then(|sampler| sampler.reason(index)),
        });
    }

    let sheet = build_contact_sheet(
        runner,
        &request.out,
        &format,
        &cell_paths,
        columns,
        rows,
        cell,
    )
    .await?;

    let mut payload = serde_json::json!({
        "status": "ok",
        "mode": "grid",
        "sheet": {
            "path": sheet.path,
            "cols": sheet.columns,
            "rows": sheet.rows,
            "cellWidth": cell.width,
            "cellHeight": cell.height,
            "labeled": request.label_cells,
            // Where the cells came from. A sheet served entirely out of the
            // cache costs one seek per cell; one that is all `composite` paid
            // for a render each, which is what a caller watching its own budget
            // needs to see.
            "sources": sources,
            "cells": cells,
        },
        "warnings": context.warnings(),
    });
    attach_sampler_report(&mut payload, sampler)?;

    Ok(payload)
}

/// The preview render cache, as far as a read-only probe is concerned.
struct CacheProbe {
    /// Directory holding this profile's segment files.
    profile_dir: PathBuf,
    /// Manifest as stored, never written back.
    manifest: RenderCacheManifest,
}

/// A cached segment file and the offset inside it that holds the wanted frame.
struct CachedSegmentFrame {
    offset_sec: f64,
    path: PathBuf,
}

/// Everything needed to turn a timeline time into a still image.
struct TimelineFrameContext<'a> {
    engine: ExportEngine,
    runner: &'a FFmpegRunner,
    project: &'a FrameProbeProject<'a>,
    sequence: &'a Sequence,
    sequence_id: &'a str,
    format: ImageFormat,
    max_width: u32,
    mode: TimelineMode,
    /// Render graph for this sequence, built at most once per invocation.
    ///
    /// Both the composite render and the cache freshness check need it, and it
    /// is the same graph for every frame of one sequence.
    graph: Option<RenderGraph>,
    /// The preview cache, looked up at most once per invocation.
    ///
    /// `None` means "not looked at yet"; `Some(None)` means there is nothing
    /// usable to look at, which is the ordinary state of a project the GUI has
    /// never opened.
    cache: Option<Option<CacheProbe>>,
    /// Source sizes measured once for the whole invocation.
    ///
    /// Export validation measures every transformed clip's source with FFprobe.
    /// The composite path validates the render it is about to run, so without a
    /// shared measurement a 4x4 contact sheet over five assets meant 160 FFprobe
    /// spawns instead of five.
    source_dimensions: SourceDimensionMap,
    /// Export validation for this sequence, run once for the whole invocation.
    ///
    /// Nothing validation inspects changes between frames of the same sequence,
    /// so running it per frame would only repeat the answer. Its warnings ride
    /// out with the payload: a still is rendered through the same path an
    /// export is, so styling the render drops - a line height libass ignores, a
    /// font nothing on the machine can supply - is missing from the picture an
    /// agent is about to judge, and nothing else would say so.
    validation: Option<ExportValidation>,
    /// Warnings raised by individual stills rather than by the sequence.
    per_frame_warnings: Vec<String>,
}

impl<'a> TimelineFrameContext<'a> {
    fn new(
        runner: &'a FFmpegRunner,
        project: &'a FrameProbeProject<'a>,
        sequence: &'a Sequence,
        sequence_id: &'a str,
        format: ImageFormat,
        max_width: u32,
        mode: TimelineMode,
    ) -> Self {
        Self {
            engine: ExportEngine::new(runner.clone()),
            runner,
            project,
            sequence,
            sequence_id,
            format,
            max_width,
            mode,
            graph: None,
            cache: None,
            source_dimensions: SourceDimensionMap::new(),
            validation: None,
            per_frame_warnings: Vec::new(),
        }
    }

    fn assets(&self) -> &HashMap<String, Asset> {
        &self.project.state.assets
    }

    fn effects(&self) -> &HashMap<String, Effect> {
        &self.project.state.effects
    }

    fn canvas(&self) -> &Canvas {
        &self.sequence.format.canvas
    }

    /// Measures every asset once, then validates the sequence against it.
    ///
    /// Both are per-invocation, not per-frame: without the shared measurement a
    /// 4x4 contact sheet over five assets meant 160 FFprobe spawns instead of
    /// five, and the validation that consumes it answers the same for every
    /// frame of one sequence.
    async fn measure_sources(&mut self) {
        let audio_info = self
            .engine
            .probe_assets_for_audio(self.sequence, self.assets())
            .await;
        self.source_dimensions = source_dimensions_from_audio_info(&audio_info);
        let source_durations = source_durations_from_audio_info(&audio_info);

        // Validated against the profile the stills are actually produced with —
        // the lossless preview-cache profile at the sequence canvas — and with
        // no time window, since nothing this reports varies across the frames of
        // one sequence. Validating a different frame size would describe a
        // render that never happens: font sizes, stroke widths and blur radii
        // are absolute pixels, so they only mean what they mean at the canvas
        // the picture is actually drawn on.
        let settings = ExportSettings::preview_cache(
            PathBuf::from("frame-extract").with_extension(COMPOSITE_RENDER_EXTENSION),
            self.canvas(),
            None,
            None,
        );

        self.validation = Some(validate_export_settings_with_dimensions(
            self.sequence,
            self.assets(),
            self.effects(),
            &settings,
            Some(&self.source_dimensions),
            Some(&source_durations),
        ));
    }

    /// Warnings the caller should see alongside the stills.
    fn warnings(&self) -> Vec<String> {
        let mut warnings = self
            .validation
            .as_ref()
            .map(|validation| validation.warnings.clone())
            .unwrap_or_default();
        warnings.extend(self.per_frame_warnings.iter().cloned());
        warnings
    }

    /// Builds the sequence's render graph, reusing it across frames.
    fn graph(&mut self) -> FrameProbeResult<&RenderGraph> {
        if self.graph.is_none() {
            let graph =
                build_render_graph(self.project.state, self.sequence_id).map_err(|error| {
                    FrameProbeError::new(format!("Failed to build render graph: {}", error))
                })?;
            self.graph = Some(graph);
        }

        self.graph
            .as_ref()
            .ok_or_else(|| FrameProbeError::new("Render graph unavailable".to_string()))
    }

    /// Extracts one timeline still.
    ///
    /// `fast` mode reads the topmost clip's own media and is only reached when
    /// the caller asked for it; everything else is the composited edit, served
    /// from the render cache when it holds the requested instant.
    async fn extract(
        &mut self,
        index: usize,
        time_sec: f64,
        output_path: &Path,
    ) -> FrameProbeResult<FrameEntry> {
        if self.mode == TimelineMode::Fast {
            // Fast mode reads the topmost clip's source file directly, so a clip
            // that is moved, scaled, rotated or faded would come back looking
            // untouched — an agent checking its own transform edit would see no
            // change. Compositing is the only way to show it.
            let fast_clip = self
                .engine
                .find_topmost_clip_at_time(self.sequence, self.assets(), time_sec)
                .filter(|(clip, _)| !clip_needs_transform_composition(clip));

            if let Some((clip, _)) = fast_clip {
                let settings = FrameExportSettings {
                    time_sec,
                    format: self.format.clone(),
                    output_path: output_path.to_path_buf(),
                    quality: None,
                    max_width: Some(self.max_width),
                };
                let result = self
                    .engine
                    .export_frame(self.sequence, self.assets(), self.project.path, &settings)
                    .await
                    .map_err(|error| {
                        FrameProbeError::new(format!("Frame export failed: {}", error))
                    })?;

                let entry = FrameEntry {
                    index,
                    time_sec,
                    source_time_sec: Some(clip_source_time_at(clip, time_sec)),
                    clip_id: Some(clip.id.clone()),
                    asset_id: Some(clip.asset_id.clone()),
                    path: result.output_path.display().to_string(),
                    width: result.width,
                    height: result.height,
                    source: FrameSource::Source,
                    fell_back_to_composite: Some(false),
                    reason: None,
                };
                self.warn_if_fast_mode_hides_content(time_sec);

                return Ok(entry);
            }
        }

        let fell_back = self.mode == TimelineMode::Fast;
        let (source, width, height) = self.render_composited(time_sec, output_path).await?;

        Ok(FrameEntry {
            index,
            time_sec,
            source_time_sec: None,
            clip_id: None,
            asset_id: None,
            path: output_path.display().to_string(),
            width,
            height,
            source,
            fell_back_to_composite: fell_back.then_some(true),
            reason: None,
        })
    }

    /// Records what a `fast` still at `time_sec` is not showing.
    ///
    /// A caller who asked for `fast` accepted footage instead of the edit, but
    /// "footage instead of the edit" is invisible in the picture itself: a still
    /// with no caption on it looks exactly like a still whose caption was never
    /// drawn. Naming the time and the causes [`HiddenContent`] actually found
    /// makes the omission checkable.
    fn warn_if_fast_mode_hides_content(&mut self, time_sec: f64) {
        let reasons = fast_mode_hidden_content(
            self.sequence,
            self.assets(),
            self.effects(),
            self.canvas(),
            &self.source_dimensions,
            time_sec,
        )
        .reasons();
        if reasons.is_empty() {
            return;
        }

        self.per_frame_warnings.push(format!(
            "fast mode shows the source clip only; at {:.3}s it omits: {}",
            time_sec,
            reasons.join(", ")
        ));
    }

    /// Produces the composited picture at `time_sec`, cache first.
    ///
    /// Returns the tier that served it alongside the still's dimensions.
    async fn render_composited(
        &mut self,
        time_sec: f64,
        output_path: &Path,
    ) -> FrameProbeResult<(FrameSource, u32, u32)> {
        if let Some((width, height)) = self.extract_from_cache(time_sec, output_path).await? {
            return Ok((FrameSource::Cache, width, height));
        }

        let (width, height) = self.render_composite(time_sec, output_path).await?;
        Ok((FrameSource::Composite, width, height))
    }

    /// Serves `time_sec` out of the preview render cache, if it can.
    ///
    /// A cached segment is written by the export pipeline in a lossless
    /// all-keyframe codec, so a frame decoded out of one is the export composite
    /// rather than an approximation of it — and it costs a single seek instead
    /// of a render. Every reason this cannot be done is an ordinary miss —
    /// `Ok(None)`, and the composite tier answers instead: an absent cache is
    /// the normal state of a project the GUI has never opened. Only a
    /// filesystem that will not let the output path be replaced is an error,
    /// because from there no tier can write the still that was asked for.
    async fn extract_from_cache(
        &mut self,
        time_sec: f64,
        output_path: &Path,
    ) -> FrameProbeResult<Option<(u32, u32)>> {
        let Some(segment) = self.current_cached_segment(time_sec) else {
            return Ok(None);
        };

        // An image an earlier run left at this path is indistinguishable from
        // one this extraction wrote, and the seek below is allowed to write
        // nothing at all — so the old file has to be gone before "did FFmpeg
        // write a frame?" can be asked. Without this the miss below reads the
        // previous picture as a cache hit and hands back a still of another
        // instant, or of another edit entirely.
        remove_stale_output(output_path)?;

        if self
            .runner
            .extract_frame_with_options(
                &segment.path,
                segment.offset_sec,
                output_path,
                &FrameExtractOptions {
                    overwrite: true,
                    // The segment is stored at the sequence canvas, so the
                    // caller's width cap is applied on the way out, exactly as
                    // it is for a freshly composited window.
                    max_width: Some(self.max_width),
                    quality: None,
                },
            )
            .await
            .is_err()
        {
            return Ok(None);
        }

        // FFmpeg reports success for a seek that lands past the last decodable
        // frame and simply writes nothing, so an unwritten file means the cache
        // could not answer after all and the composite must.
        if !is_nonempty_file(output_path) {
            return Ok(None);
        }

        Ok(probed_image_dimensions(self.runner, output_path).await)
    }

    /// Locates a cached segment file whose picture is still current at `time_sec`.
    fn current_cached_segment(&mut self, time_sec: f64) -> Option<CachedSegmentFrame> {
        // The graph is needed to re-fingerprint, and building it can fail on a
        // sequence the composite path would reject anyway.
        let graph = self.graph().ok()?.clone();
        let fps = self.sequence.format.fps.as_f64();

        let (segment, manifest, path) = {
            let cache = self.ensure_cache_probe()?;
            let segment = find_segment_for_time(&cache.manifest.segments, time_sec)?;
            // `is_valid_cache` is `Cached` plus a recorded file, which already
            // implies `needs_render()` is false. Segment *flags* deliberately do
            // not gate this: a flag says how wrong a live canvas guess would be,
            // not whether the stored pixels are current — see
            // `src/utils/cacheFrameSource.ts`, which serves flagged segments too.
            if !segment.is_valid_cache() {
                return None;
            }
            let cached_file = segment.cached_file.as_deref()?;
            let path = resolve_cached_segment_path(&cache.profile_dir, cached_file)?;
            (segment.clone(), cache.manifest.clone(), path)
        };

        if !is_nonempty_file(&path) {
            return None;
        }
        if !self.segment_matches_current_plan(&manifest, &segment, &graph) {
            return None;
        }

        Some(CachedSegmentFrame {
            offset_sec: cache_frame_offset_sec(&segment, time_sec, fps),
            path,
        })
    }

    /// Loads the stored cache manifest for this sequence's preview profile.
    ///
    /// Read-only throughout: the manifest on disk belongs to the GUI's cache
    /// fill, and a probe that rewrote it could retire a segment that fill is
    /// about to accept.
    fn ensure_cache_probe(&mut self) -> Option<&CacheProbe> {
        if self.cache.is_none() {
            self.cache = Some(self.load_cache_probe());
        }

        self.cache.as_ref().and_then(|probe| probe.as_ref())
    }

    fn load_cache_probe(&self) -> Option<CacheProbe> {
        let profile_hash = preview_profile_hash(self.canvas());
        let profile_dir =
            profile_cache_dir(self.project.path, self.sequence_id, &profile_hash).ok()?;
        // A manifest written for another encode profile is replaced here by a
        // fresh, empty one, which holds nothing to serve — the right answer for
        // a probe. Pruning the files it left behind is the render path's job.
        let loaded = manifest_for_profile(
            self.project.path,
            self.sequence_id,
            &profile_hash,
            self.sequence.duration(),
            RenderCacheConfig::default().segment_duration_sec,
        )
        .ok()?;

        Some(CacheProbe {
            profile_dir,
            manifest: loaded.manifest,
        })
    }

    /// Whether `segment`'s stored picture still describes the current edit.
    ///
    /// Re-fingerprinting a *clone* is what keeps the probe read-only, and the
    /// clone carries only the one segment under test: the refresh derives the
    /// transition reach and the content prelude from the sequence rather than
    /// from neighbouring segments, so a single-segment manifest fingerprints
    /// exactly as the full one would — and answering one frame does not cost a
    /// render plan for every segment of a two-hour timeline.
    fn segment_matches_current_plan(
        &self,
        manifest: &RenderCacheManifest,
        segment: &RenderCacheSegment,
        graph: &RenderGraph,
    ) -> bool {
        let mut probe = manifest.clone();
        probe.segments = vec![segment.clone()];

        // `refresh_manifest_plan_fingerprints` demotes a `Cached` segment to
        // `Stale` exactly when its fingerprint moved, so the state it leaves
        // behind is the answer.
        if refresh_manifest_plan_fingerprints(
            &mut probe,
            self.project.path,
            self.sequence,
            graph,
            self.assets(),
            self.effects(),
        )
        .is_err()
        {
            return false;
        }

        probe
            .segments
            .first()
            .map(|segment| segment.is_valid_cache())
            .unwrap_or(false)
    }

    /// Renders a minimal composited window at `time_sec` and grabs its first
    /// frame.
    ///
    /// The window is chosen by [`composite_window`], which snaps its start onto
    /// the frame grid so the frame grabbed at offset zero is the frame the
    /// timeline holds at `time_sec`, and keeps it one frame short of the
    /// sequence end so the render range is never empty.
    ///
    /// The window is rendered with [`ExportSettings::preview_cache`]: lossless
    /// Ut Video at the sequence canvas and the sequence frame rate, the same
    /// profile the render cache stores, so the still is the export composite
    /// rather than a re-encode of it. Any width cap is applied when the still is
    /// cut out of the rendered window, never to the render itself — font sizes,
    /// stroke widths and blur radii are absolute pixels and do not survive being
    /// composited at a smaller frame.
    ///
    /// Cost tracks the *in-clip offset*, not the timeline position: since the
    /// windowed-render rework the graph's own clock starts at the window and
    /// each input is cut with `trim=start_frame` after decode, so a window late
    /// on the timeline over a clip that starts near its own head stays cheap.
    async fn render_composite(
        &mut self,
        time_sec: f64,
        output_path: &Path,
    ) -> FrameProbeResult<(u32, u32)> {
        let window = composite_window(
            time_sec,
            // The window the plan is built for is clamped to the length the
            // export writes, so the grid this snaps to has to be that same
            // length — see `normalize_output_time_range`.
            self.sequence.output_duration(),
            self.sequence.format.fps.as_f64(),
        );

        let temp_dir = tempfile::tempdir().map_err(|error| {
            FrameProbeError::new(format!(
                "Failed to create temporary render directory: {error}"
            ))
        })?;
        let temp_render = temp_dir
            .path()
            .join("composite")
            .with_extension(COMPOSITE_RENDER_EXTENSION);

        let canvas = self.canvas().clone();
        let (width, height) =
            scaled_frame_dimensions(canvas.width, canvas.height, Some(self.max_width));

        let settings = ExportSettings::preview_cache(
            temp_render.clone(),
            &canvas,
            Some(window.start_sec),
            Some(window.end_sec),
        );

        // The compositing path is the one an invalid sequence would actually
        // break, so the stored verdict is only enforced here - a fast-mode
        // still of one untouched clip is unaffected by, say, a layered overlap
        // elsewhere on the timeline and is still worth handing back.
        if let Some(validation) = self.validation.as_ref() {
            if !validation.is_valid {
                return Err(FrameProbeError::new(format!(
                    "Composite render validation failed: {}",
                    validation.errors.join("; ")
                )));
            }
        }

        let graph = self.graph()?.clone();
        let render_plan = build_render_plan(&graph, self.assets(), self.effects(), &settings);
        if !render_plan.validation.is_valid {
            return Err(FrameProbeError::new(format!(
                "Composite render plan validation failed: {}",
                render_plan.validation.errors.join("; ")
            )));
        }

        self.engine
            .export_sequence_with_effects_for_plan(
                self.sequence,
                self.assets(),
                self.effects(),
                &settings,
                &render_plan,
                None,
                None,
            )
            .await
            .map_err(|error| FrameProbeError::new(format!("Composite render failed: {}", error)))?;

        self.runner
            .extract_frame_with_options(
                &temp_render,
                0.0,
                output_path,
                &FrameExtractOptions {
                    overwrite: true,
                    max_width: Some(self.max_width),
                    quality: None,
                },
            )
            .await
            .map_err(|error| {
                FrameProbeError::new(format!(
                    "Frame extraction from composite render failed: {}",
                    error
                ))
            })?;

        Ok(probed_image_dimensions(self.runner, output_path)
            .await
            .unwrap_or((width, height)))
    }
}

/// The render range a single composited still is cut out of.
#[derive(Clone, Copy, Debug, PartialEq)]
struct CompositeWindow {
    /// First instant of the render — the frame the still is grabbed from.
    start_sec: f64,
    /// End of the render, at least two frames after the start.
    end_sec: f64,
}

/// Picks the shortest render range whose first frame is the wanted still.
///
/// The renderer addresses its output range by frame — `round(t * fps)` at both
/// ends — and rejects a range whose two ends land on the same frame. Rendering
/// `[t, t + window]` therefore fails outright inside the sequence's last frame:
/// on a 5s/25fps sequence `--time 4.99` asks for `[4.99, 5.0]`, both bounds
/// round to frame 125, the plan comes back empty and an ordinary request is
/// refused. Snapping the start onto the grid and holding it one frame short of
/// the end answers with the last real frame — 124, at 4.96s — instead.
///
/// Snapping is worth having on its own: the still is grabbed from offset zero of
/// the render, which is the frame the renderer put there, so a start that sits
/// between two frames describes a picture the timeline never shows.
fn composite_window(time_sec: f64, duration_sec: f64, fps: f64) -> CompositeWindow {
    // Without a usable frame rate there is no grid to snap to, so the window is
    // the plain span it always was and the renderer's own clamp is left to it.
    if !fps.is_finite() || fps <= 0.0 {
        let start_sec = time_sec.max(0.0);
        return CompositeWindow {
            start_sec,
            end_sec: start_sec + MIN_COMPOSITE_WINDOW_SEC,
        };
    }

    // Two frames, so the range always spans a frame boundary; the floor keeps it
    // renderable at frame rates where two frames is a shorter span than the
    // range normalisation accepts.
    let window_sec = (2.0 / fps).max(MIN_COMPOSITE_WINDOW_SEC);
    let last_frame = ((duration_sec.max(0.0) * fps).round() - 1.0).max(0.0);
    let start_sec = (time_sec.max(0.0) * fps).round().min(last_frame) / fps;

    CompositeWindow {
        start_sec,
        end_sec: start_sec + window_sec,
    }
}

/// Whether `path` is a file with bytes in it.
fn is_nonempty_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false)
}

/// Finds the segment covering `time_sec`, regardless of what it holds.
///
/// Segments tile the sequence as half-open ranges `[start_sec, end_sec)`. The
/// one exception is the very end of the timeline: a request can land exactly on
/// the final segment's `end_sec` and there is no later segment to own that
/// instant, so it is clamped back into the last segment.
///
/// Mirrors `findSegmentForTime` in `src/utils/cacheFrameSource.ts`; the two
/// surfaces must not disagree about which segment holds a given instant.
fn find_segment_for_time(
    segments: &[RenderCacheSegment],
    time_sec: f64,
) -> Option<&RenderCacheSegment> {
    if !time_sec.is_finite() || segments.is_empty() {
        return None;
    }

    let mut last: Option<&RenderCacheSegment> = None;
    for segment in segments {
        if time_sec >= segment.start_sec && time_sec < segment.end_sec {
            return Some(segment);
        }
        if last.is_none_or(|previous| segment.end_sec > previous.end_sec) {
            last = Some(segment);
        }
    }

    last.filter(|segment| time_sec == segment.end_sec)
}

/// Converts a timeline time into an offset inside a cached segment's file.
///
/// A segment's declared bounds are wall-clock seconds, but the renderer snaps
/// its window to the frame grid (`round(t * fps)`) and rebases the written
/// file's timestamps to zero. At a non-integer rate — 29.97, 23.976, 59.94 — a
/// bound like 15.000s does not sit on a frame, so file frame 0 is up to half a
/// frame away from `start_sec`. Differencing the two grid positions reproduces
/// exactly the frame the renderer wrote; subtracting seconds naively would land
/// on its neighbour for a large share of positions in later segments.
///
/// The end clamp is the segment's *final stored frame*, for the same reason:
/// the file holds `round(end * fps) - round(start * fps)` frames numbered from
/// zero, and the decoder addresses by nearest frame and errors out of range
/// rather than saturating. Clamping to wall-clock seconds instead — the
/// segment's length less half a frame — lands past that last frame whenever the
/// length is not a whole number of frames: a 0-5s segment at 25fps holds its
/// last frame at 4.96s, and the seconds clamp would ask for 4.98s.
///
/// Mirrors `cacheFrameOffsetSec` in `src/utils/cacheFrameSource.ts`, which still
/// carries the seconds clamp on the GUI's preview path.
fn cache_frame_offset_sec(segment: &RenderCacheSegment, time_sec: f64, fps: f64) -> f64 {
    if !fps.is_finite() || fps <= 0.0 {
        let duration_sec = (segment.end_sec - segment.start_sec).max(0.0);
        let fallback_last_sec = (duration_sec - CACHE_SEGMENT_END_EPSILON_SEC).max(0.0);
        return (time_sec - segment.start_sec)
            .max(0.0)
            .min(fallback_last_sec);
    }

    let frame_sec = 1.0 / fps;
    let start_frame = (segment.start_sec * fps).round();
    // What the renderer wrote: the same grid difference the offset itself is
    // built from, so a segment holding a single frame — or none at all — clamps
    // every request onto the start of the file.
    let stored_frames = (segment.end_sec * fps).round() - start_frame;
    let last_addressable_sec = (stored_frames - 1.0).max(0.0) * frame_sec;
    let grid_offset_frames = (time_sec * fps).round() - start_frame;

    (grid_offset_frames * frame_sec)
        .max(0.0)
        .min(last_addressable_sec)
}

/// What a `fast` still at one instant leaves out.
///
/// One flag per way the composited picture can differ from the topmost clip's
/// own media, so the warning can name the causes it actually found. A single
/// boolean would force the warning to list every cause there is, and a caller
/// told "captions/text/effects" on a timeline with no captions cannot tell a
/// dropped title from a canvas fit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct HiddenContent {
    /// A caption track draws over the picture at this instant.
    captions: bool,
    /// A text clip draws over the picture at this instant.
    text: bool,
    /// An enabled single-input effect changes what a clip's source holds.
    effects: bool,
    /// A two-input transition is blending across a cut at this instant.
    transition: bool,
    /// A clip or its track composites with a non-normal blend mode.
    blend: bool,
    /// A source's pixels do not fill the canvas, so the compositor fits and pads.
    canvas_fit: bool,
}

impl HiddenContent {
    /// The causes that were found, in the order the warning names them.
    ///
    /// Empty when a `fast` still is the composited picture after all, which is
    /// what the caller checks instead of a separate emptiness test.
    fn reasons(&self) -> Vec<&'static str> {
        [
            (self.captions, "caption"),
            (self.text, "text"),
            (self.effects, "effect"),
            (self.transition, "transition"),
            (self.blend, "blend"),
            (self.canvas_fit, "canvas fit"),
        ]
        .into_iter()
        .filter_map(|(found, reason)| found.then_some(reason))
        .collect()
    }
}

/// Everything a `fast` still at `time_sec` would leave out of the export's
/// picture.
///
/// Every condition here is a way for the composited picture to differ from the
/// topmost clip's own media: something drawn *over* it (a caption, a text clip),
/// something applied *to* it (an effect, a transition), something that mixes it
/// with what is under it (a blend mode), or something that reframes it (a source
/// whose pixels do not fill the canvas, which the compositor fits and pads).
///
/// The scan covers exactly the tracks the renderer draws — see
/// [`track_included_in_export`] — because content on a track the export leaves
/// out is missing from *both* pictures and is nothing for a `fast` still to be
/// warned about.
fn fast_mode_hidden_content(
    sequence: &Sequence,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
    canvas: &Canvas,
    source_dimensions: &SourceDimensionMap,
    time_sec: f64,
) -> HiddenContent {
    let fps = sequence.format.fps.as_f64();
    let mut hidden = HiddenContent::default();

    for track in sequence
        .tracks
        .iter()
        .filter(|track| track.kind != TrackKind::Audio && track_included_in_export(track))
    {
        for clip in track.clips.iter().filter(|clip| clip.enabled) {
            let cut_sec = clip.place.timeline_out_sec();
            let covers = time_sec >= clip.place.timeline_in_sec && time_sec < cut_sec;

            for effect in clip
                .effects
                .iter()
                .filter_map(|effect_id| effects.get(effect_id))
                .filter(|effect| effect.enabled)
            {
                // A two-input transition is an effect on the *outgoing* clip
                // that is rendered across the cut, so it is the one thing here
                // judged against a span the clip does not own: it changes
                // nothing at the clip's head and everything just past its tail.
                if effect.effect_type.is_two_input_transition() {
                    let reach_sec = transition_effect_reach_sec(effect, fps);
                    if reach_sec > 0.0 && (time_sec - cut_sec).abs() <= reach_sec {
                        hidden.transition = true;
                    }
                    continue;
                }
                // A colour grade, a blur, a fade: a single-input effect changes
                // what the source file holds, for as long as the clip is on.
                if covers {
                    hidden.effects = true;
                }
            }

            if !covers {
                continue;
            }

            // Captions and text clips are drawn over the picture, never in it.
            if track.kind == TrackKind::Caption {
                hidden.captions = true;
            }
            if is_text_clip(clip) {
                hidden.text = true;
            }

            // A non-normal blend mode mixes the clip with the canvas under it,
            // which the raw source cannot show even where the clip is alone.
            if effective_blend_mode_for_clip(clip, track) != BlendMode::Normal {
                hidden.blend = true;
            }

            // A source that is not the canvas size is fitted and padded by the
            // compositor; the raw file shows neither the fit nor the padding.
            if let Some((width, height)) = clip_source_dimensions(clip, assets, source_dimensions) {
                if width != canvas.width || height != canvas.height {
                    hidden.canvas_fit = true;
                }
            }
        }
    }

    hidden
}

/// The clip's source picture size, preferring what FFprobe measured.
///
/// Stored asset metadata is written at import and can outlive the file it
/// describes: a relink to a differently sized source leaves it behind, and a
/// canvas-fit warning built on it then describes the previous file. The probe
/// the composite path already ran measured the file as it is now, so the stored
/// size is only the fallback for an asset the probe could not size at all.
fn clip_source_dimensions(
    clip: &Clip,
    assets: &HashMap<String, Asset>,
    source_dimensions: &SourceDimensionMap,
) -> Option<(u32, u32)> {
    if let Some(dimensions) = source_dimensions.get(&clip.asset_id) {
        return Some(*dimensions);
    }

    assets
        .get(&clip.asset_id)
        .and_then(|asset| asset.video.as_ref())
        .map(|video| (video.width, video.height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::VideoInfo;
    use crate::core::effects::{EffectType, ParamValue};
    use crate::core::timeline::{SequenceFormat, Track};

    fn segment(index: u32, start_sec: f64, end_sec: f64) -> RenderCacheSegment {
        RenderCacheSegment::new(index, start_sec, end_sec)
    }

    #[test]
    fn find_segment_for_time_should_treat_segments_as_half_open_ranges() {
        let segments = vec![segment(0, 0.0, 5.0), segment(1, 5.0, 10.0)];

        assert_eq!(
            find_segment_for_time(&segments, 4.999).map(|s| s.index),
            Some(0)
        );
        assert_eq!(
            find_segment_for_time(&segments, 5.0).map(|s| s.index),
            Some(1),
            "A boundary belongs to the segment it opens"
        );
    }

    #[test]
    fn find_segment_for_time_should_clamp_the_very_end_into_the_last_segment() {
        let segments = vec![segment(0, 0.0, 5.0), segment(1, 5.0, 10.0)];

        assert_eq!(
            find_segment_for_time(&segments, 10.0).map(|s| s.index),
            Some(1),
            "There is no later segment to own the final instant"
        );
        assert!(find_segment_for_time(&segments, 10.001).is_none());
        assert!(find_segment_for_time(&segments, f64::NAN).is_none());
        assert!(find_segment_for_time(&[], 1.0).is_none());
    }

    #[test]
    fn cache_frame_offset_sec_should_difference_the_frame_grid_not_the_seconds() {
        // 29.97 fps: the segment bound does not sit on a frame, so subtracting
        // seconds would land on the neighbouring frame.
        let fps = 30000.0 / 1001.0;
        let later = segment(3, 15.0, 20.0);

        let offset = cache_frame_offset_sec(&later, 16.0, fps);
        let expected = ((16.0 * fps).round() - (15.0 * fps).round()) / fps;

        assert!(
            (offset - expected).abs() < 1e-9,
            "Offset must reproduce the frame the renderer wrote, got {offset}"
        );
    }

    #[test]
    fn cache_frame_offset_sec_should_clamp_the_final_instant_onto_the_last_stored_frame() {
        // 0-5s at 25fps is 125 frames numbered 0..=124, so the last one the file
        // holds sits at 4.96s. The old wall-clock clamp allowed 4.98s, which
        // rounds to frame 125 and is past the end of the file.
        let only = segment(0, 0.0, 5.0);

        let offset = cache_frame_offset_sec(&only, 5.0, 25.0);

        assert!(
            (offset - 4.96).abs() < 1e-9,
            "The final instant must address the last frame the file holds, got {offset}"
        );
        assert_eq!(
            (offset * 25.0).round(),
            124.0,
            "The clamped offset must not round onto a frame past the file"
        );
    }

    #[test]
    fn cache_frame_offset_sec_should_fall_back_to_seconds_without_a_frame_rate() {
        let only = segment(0, 2.0, 6.0);

        assert_eq!(cache_frame_offset_sec(&only, 3.5, 0.0), 1.5);
        assert_eq!(
            cache_frame_offset_sec(&only, 6.0, f64::NAN),
            4.0 - CACHE_SEGMENT_END_EPSILON_SEC
        );
    }

    #[test]
    fn cache_frame_offset_sec_should_address_the_only_frame_of_a_sub_frame_segment() {
        let sliver = segment(9, 10.0, 10.01);

        assert_eq!(cache_frame_offset_sec(&sliver, 10.005, 25.0), 0.0);
    }

    // ── Composite window ────────────────────────────────────────────────

    #[test]
    fn composite_window_should_snap_the_start_onto_the_frame_grid() {
        // 3.11s at 25fps is frame 78, which starts at 3.12s. The still is cut
        // from offset zero of the render, so an unsnapped start would describe a
        // picture between two frames.
        let window = composite_window(3.11, 10.0, 25.0);

        assert!((window.start_sec - 3.12).abs() < 1e-9, "{window:?}");
        assert!(
            window.end_sec - window.start_sec >= 2.0 / 25.0 - 1e-9,
            "The range must still span two frames: {window:?}"
        );
    }

    #[test]
    fn composite_window_should_hold_the_start_one_frame_short_of_the_sequence_end() {
        // Regression: `[4.99, 5.0]` on a 5s/25fps sequence rounds both bounds to
        // frame 125, so the render plan came back empty and the request failed
        // instead of answering with the last frame.
        let window = composite_window(4.99, 5.0, 25.0);

        assert!(
            (window.start_sec - 4.96).abs() < 1e-9,
            "The last frame of the sequence is 124, at 4.96s: {window:?}"
        );
        assert!(
            (window.end_sec * 25.0).round() > (window.start_sec * 25.0).round(),
            "The two bounds must land on different frames: {window:?}"
        );
    }

    #[test]
    fn composite_window_should_fall_back_to_a_plain_span_without_a_frame_rate() {
        let window = composite_window(2.5, 5.0, 0.0);

        assert_eq!(window.start_sec, 2.5);
        assert_eq!(window.end_sec, 2.5 + MIN_COMPOSITE_WINDOW_SEC);
    }

    // ── Fast-mode omissions ─────────────────────────────────────────────

    const CANVAS_WIDTH: u32 = 1920;
    const CANVAS_HEIGHT: u32 = 1080;

    /// A clip of `duration_sec` placed at `at_sec`, reading `asset_id`.
    fn clip_at(asset_id: &str, at_sec: f64, duration_sec: f64) -> Clip {
        Clip::new(asset_id)
            .with_source_range(0.0, duration_sec)
            .place_at(at_sec)
    }

    /// A 1920x1080 25fps sequence holding one canvas-sized clip from 0s to 10s.
    fn probe_sequence() -> Sequence {
        let mut sequence = Sequence::new(
            "Probe",
            SequenceFormat::new(CANVAS_WIDTH, CANVAS_HEIGHT, 25, 1, 48_000),
        );
        let mut track = Track::new_video("Video 1");
        track.add_clip(clip_at("asset-1", 0.0, 10.0));
        sequence.add_track(track);
        sequence
    }

    /// The one asset [`probe_sequence`] reads, sized exactly like the canvas.
    fn probe_assets() -> HashMap<String, Asset> {
        let video = VideoInfo {
            width: CANVAS_WIDTH,
            height: CANVAS_HEIGHT,
            ..VideoInfo::default()
        };
        let mut asset = Asset::new_video("asset-1.mp4", "/fixtures/asset-1.mp4", video);
        asset.id = "asset-1".to_string();

        HashMap::from([(asset.id.clone(), asset)])
    }

    fn hidden_at(sequence: &Sequence, time_sec: f64) -> HiddenContent {
        fast_mode_hidden_content(
            sequence,
            &probe_assets(),
            &HashMap::new(),
            &sequence.format.canvas,
            &SourceDimensionMap::new(),
            time_sec,
        )
    }

    #[test]
    fn fast_mode_hidden_content_should_find_nothing_on_a_plain_canvas_sized_clip() {
        assert_eq!(
            hidden_at(&probe_sequence(), 5.0).reasons(),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn fast_mode_hidden_content_should_name_a_caption_drawn_over_the_still() {
        let mut sequence = probe_sequence();
        let mut captions = Track::new_caption("Captions");
        captions.add_clip(clip_at("caption-asset", 4.0, 2.0));
        sequence.add_track(captions);

        assert_eq!(hidden_at(&sequence, 5.0).reasons(), vec!["caption"]);
        assert_eq!(
            hidden_at(&sequence, 7.0).reasons(),
            Vec::<&str>::new(),
            "A caption that has ended is in neither picture"
        );
    }

    #[test]
    fn fast_mode_hidden_content_should_name_a_text_clip_on_another_track() {
        let mut sequence = probe_sequence();
        let mut titles = Track::new_video("Video 2");
        titles.add_clip(clip_at("__text__title", 4.0, 2.0));
        sequence.add_track(titles);

        assert_eq!(hidden_at(&sequence, 5.0).reasons(), vec!["text"]);
    }

    #[test]
    fn fast_mode_hidden_content_should_name_an_ordinary_effect_for_the_whole_clip() {
        let mut sequence = probe_sequence();
        let blur = Effect::with_id("fx-blur", EffectType::GaussianBlur);
        sequence.tracks[0].clips[0].effects.push(blur.id.clone());
        let effects = HashMap::from([(blur.id.clone(), blur)]);

        let hidden = |time_sec| {
            fast_mode_hidden_content(
                &sequence,
                &probe_assets(),
                &effects,
                &sequence.format.canvas,
                &SourceDimensionMap::new(),
                time_sec,
            )
        };

        assert_eq!(hidden(1.0).reasons(), vec!["effect"]);
        assert_eq!(
            hidden(9.9).reasons(),
            vec!["effect"],
            "A single-input effect applies for as long as the clip is on"
        );
    }

    #[test]
    fn fast_mode_hidden_content_should_name_a_transition_only_around_its_cut() {
        // A dissolve is an effect on the outgoing clip that renders across the
        // cut, so it changes nothing at the clip's head and everything just past
        // its tail — the span the old whole-clip rule got wrong at both ends.
        let mut sequence = probe_sequence();
        sequence.tracks[0].add_clip(clip_at("asset-1", 10.0, 5.0));

        let mut dissolve = Effect::with_id("fx-dissolve", EffectType::CrossDissolve);
        dissolve.set_param("duration", ParamValue::Float(1.0));
        sequence.tracks[0].clips[0]
            .effects
            .push(dissolve.id.clone());
        let effects = HashMap::from([(dissolve.id.clone(), dissolve)]);

        let hidden = |time_sec| {
            fast_mode_hidden_content(
                &sequence,
                &probe_assets(),
                &effects,
                &sequence.format.canvas,
                &SourceDimensionMap::new(),
                time_sec,
            )
        };

        assert_eq!(
            hidden(1.0).reasons(),
            Vec::<&str>::new(),
            "The head of a dissolving clip is untouched footage"
        );
        assert_eq!(
            hidden(9.8).reasons(),
            vec!["transition"],
            "The blend starts before the cut"
        );
        assert_eq!(
            hidden(10.25).reasons(),
            vec!["transition"],
            "And carries on past it, over a clip that has already ended"
        );
    }

    #[test]
    fn fast_mode_hidden_content_should_name_a_non_normal_blend_mode() {
        let mut sequence = probe_sequence();
        sequence.tracks[0].clips[0].blend_mode = BlendMode::Screen;

        assert_eq!(
            hidden_at(&sequence, 5.0).reasons(),
            vec!["blend"],
            "A blended clip is composited against the canvas even alone"
        );

        let mut from_track = probe_sequence();
        from_track.tracks[0].blend_mode = BlendMode::Multiply;

        assert_eq!(
            hidden_at(&from_track, 5.0).reasons(),
            vec!["blend"],
            "A track's blend mode reaches the clips that do not override it"
        );
    }

    #[test]
    fn fast_mode_hidden_content_should_ignore_a_track_the_export_leaves_out() {
        let mut sequence = probe_sequence();
        let mut captions = Track::new_caption("Captions");
        captions.muted = true;
        captions.add_clip(clip_at("caption-asset", 4.0, 2.0));
        sequence.add_track(captions);

        assert_eq!(
            hidden_at(&sequence, 5.0).reasons(),
            Vec::<&str>::new(),
            "A muted track is in neither picture, so there is nothing to warn about"
        );
    }

    #[test]
    fn fast_mode_hidden_content_should_prefer_probed_dimensions_over_stale_metadata() {
        let sequence = probe_sequence();
        let canvas = sequence.format.canvas.clone();

        // Stored metadata still describes the canvas-sized file the project was
        // imported with; the relinked source is smaller and gets fitted.
        let probed = SourceDimensionMap::from([("asset-1".to_string(), (1280, 720))]);
        assert_eq!(
            fast_mode_hidden_content(
                &sequence,
                &probe_assets(),
                &HashMap::new(),
                &canvas,
                &probed,
                5.0
            )
            .reasons(),
            vec!["canvas fit"]
        );

        // And the other way round: stale metadata must not invent a fit the
        // measured file does not need.
        let mut stale_assets = probe_assets();
        if let Some(video) = stale_assets
            .get_mut("asset-1")
            .and_then(|asset| asset.video.as_mut())
        {
            video.width = 1280;
            video.height = 720;
        }
        let probed =
            SourceDimensionMap::from([("asset-1".to_string(), (CANVAS_WIDTH, CANVAS_HEIGHT))]);
        assert_eq!(
            fast_mode_hidden_content(
                &sequence,
                &stale_assets,
                &HashMap::new(),
                &canvas,
                &probed,
                5.0
            )
            .reasons(),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn fast_mode_hidden_content_should_fall_back_to_stored_metadata_when_unprobed() {
        let sequence = probe_sequence();
        let mut assets = probe_assets();
        if let Some(video) = assets
            .get_mut("asset-1")
            .and_then(|asset| asset.video.as_mut())
        {
            video.width = 1280;
            video.height = 720;
        }

        assert_eq!(
            fast_mode_hidden_content(
                &sequence,
                &assets,
                &HashMap::new(),
                &sequence.format.canvas,
                &SourceDimensionMap::new(),
                5.0
            )
            .reasons(),
            vec!["canvas fit"]
        );
    }
}
