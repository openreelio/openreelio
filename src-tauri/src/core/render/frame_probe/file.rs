//! Extraction from an already rendered file.
//!
//! This is the cheap judging path: the frames come from the artifact that was
//! actually produced, so no per-cell timeline render is involved and what the
//! judge sees is exactly what `verify --file` measured. All times are in the
//! file's own timebase.

use super::sampler::{Sample, SampleReason, SamplerOutcome, SamplerReport, CUT_LEAD_FRAMES};
use super::sheet::{build_contact_sheet, grid_cell_extract_width, resolve_cell_size, CellStaging};
use super::{
    batch_frame_name, create_batch_output_dir, ensure_frame_written, remove_stale_output,
    resolve_sampled_grid, resolve_single_output_path, FileFrameEntry, FileGridCell,
    FrameProbeError, FrameProbeRequest, FrameProbeResult, GridLayout, Selection, DEFAULT_MAX_WIDTH,
};
use crate::core::ffmpeg::{FFmpegRunner, FrameExtractOptions};
use crate::core::render::{probed_image_dimensions, ImageFormat};
use crate::core::TimeRange;
use std::path::{Path, PathBuf};

/// Frame rate assumed when a rendered file declares an unusable one.
///
/// Only used to size the one-frame tolerance of the declared-range check, so a
/// wrong guess widens or narrows a warning rather than changing a picture.
const FALLBACK_FPS: f64 = 25.0;

/// Slack on the one-frame tolerance, so a divergence of exactly one frame is
/// still one frame after the subtractions that produced it (1 microsecond).
const TIME_EPSILON: f64 = 1e-6;

/// A rendered file used as the extraction source, with the facts needed to
/// validate requests against it.
pub(super) struct FileSource {
    path: PathBuf,
    duration_sec: f64,
    /// Duration of the video stream, when the file declares one.
    ///
    /// This is what bounds the requestable range: `duration_sec` is the
    /// container duration, i.e. the maximum across all streams, so a file whose
    /// audio outlasts its video advertises seconds that hold no picture.
    video_duration_sec: Option<f64>,
    /// Frame rate the file declares, when it declares a usable one.
    fps: Option<f64>,
}

impl FileSource {
    /// Probes `file` and rejects anything a still cannot be taken from.
    async fn probe(runner: &FFmpegRunner, file: &Path) -> FrameProbeResult<Self> {
        if !file.exists() {
            return Err(FrameProbeError::new(format!(
                "Render file '{}' not found",
                file.display()
            )));
        }

        let info = runner.probe(file).await.map_err(|error| {
            FrameProbeError::new(format!("Failed to probe '{}': {}", file.display(), error))
        })?;
        if info.video.is_none() {
            return Err(FrameProbeError::new(format!(
                "'{}' has no video stream, so there is no frame to extract",
                file.display()
            )));
        }
        if !info.duration_sec.is_finite() || info.duration_sec <= 0.0 {
            return Err(FrameProbeError::new(format!(
                "'{}' reports no duration, so there is no frame to extract",
                file.display()
            )));
        }

        // Containers that carry no per-stream duration fall back to the
        // container's: a slightly loose guard is still better than none, and
        // `ensure_frame_written` catches whatever slips through it.
        let video_duration_sec = runner
            .probe_video_duration(file)
            .await
            .ok()
            .flatten()
            .filter(|value| value.is_finite() && *value > 0.0);

        let fps = info
            .video
            .as_ref()
            .map(|video| video.fps)
            .filter(|fps| fps.is_finite() && *fps > 0.0);

        Ok(Self {
            path: file.to_path_buf(),
            duration_sec: info.duration_sec,
            video_duration_sec,
            fps,
        })
    }

    /// Last time the file can still be asked for a picture at.
    fn video_end_sec(&self) -> f64 {
        self.video_duration_sec.unwrap_or(self.duration_sec)
    }

    /// One frame of this file, in seconds.
    fn frame_sec(&self) -> f64 {
        1.0 / self.fps.unwrap_or(FALLBACK_FPS)
    }

    /// Rejects requested times the file has no frame at.
    ///
    /// The message names where the *video* ends: a judge working from a partial
    /// render, or from a file whose audio runs past its picture, needs to see
    /// that the range it asked for does not exist rather than a decoder error.
    fn ensure_times_inside(&self, times: &[f64]) -> FrameProbeResult<()> {
        if let Some(before) = times.iter().find(|time| **time < 0.0) {
            return Err(FrameProbeError::new(format!(
                "Requested time {:.3}s is before the start of '{}'",
                before,
                self.path.display()
            )));
        }
        let video_end_sec = self.video_end_sec();
        if let Some(past_end) = times.iter().find(|time| **time >= video_end_sec) {
            return Err(FrameProbeError::new(format!(
                "Requested time {:.3}s is at or past the end of the video in '{}' ({:.3}s). Ask for a time inside the file.",
                past_end,
                self.path.display(),
                video_end_sec
            )));
        }

        Ok(())
    }

    /// Fast-seeks to `time_sec` and writes the frame, reporting its size.
    async fn extract(
        &self,
        runner: &FFmpegRunner,
        time_sec: f64,
        output_path: &Path,
        max_width: u32,
    ) -> FrameProbeResult<(u32, u32)> {
        // Clear the target first so the check below can tell a fresh frame from
        // a leftover one. FFmpeg exits 0 and writes nothing when the seek lands
        // past the last decodable frame, and it does not truncate what is
        // already there, so without this a previous candidate's image survives
        // and gets probed and reported as the frame just requested.
        remove_stale_output(output_path)?;

        runner
            .extract_frame_with_options(
                &self.path,
                time_sec,
                output_path,
                &FrameExtractOptions {
                    overwrite: true,
                    max_width: Some(max_width),
                    quality: None,
                },
            )
            .await
            .map_err(|error| FrameProbeError::new(format!("Frame extraction failed: {}", error)))?;
        ensure_frame_written(output_path, time_sec, &self.path)?;

        Ok(probed_image_dimensions(runner, output_path)
            .await
            .unwrap_or((0, 0)))
    }

    /// Describes the source, echoing the timeline range it was declared to cover.
    ///
    /// The declared range is reported even when nothing was translated with it,
    /// because it is the caller's own claim about what the file holds and the
    /// payload is what that claim is checked against.
    fn describe(&self, timeline_range: Option<&TimeRange>) -> serde_json::Value {
        let mut described = serde_json::json!({
            "path": self.path.display().to_string(),
            "durationSec": self.duration_sec,
            "videoDurationSec": self.video_end_sec(),
        });

        if let (Some(range), Some(object)) = (timeline_range, described.as_object_mut()) {
            object.insert(
                "timelineRange".to_string(),
                serde_json::json!([range.start_sec, range.end_sec]),
            );
        }

        described
    }

    /// Warns when the declared range and the file disagree about their length.
    ///
    /// Not an error: a draft render is routinely a frame long or short of the
    /// range asked for, and refusing that would make the whole feature unusable.
    /// Over one frame of divergence, though, every translated time is off by the
    /// difference, and a judge reading `timelineSec` has to know that before it
    /// reports which second of the edit it looked at.
    fn declared_range_warning(&self, range: &TimeRange) -> Option<String> {
        let declared_sec = range.end_sec - range.start_sec;
        let measured_sec = self.video_end_sec();
        let divergence_sec = (declared_sec - measured_sec).abs();
        if divergence_sec <= self.frame_sec() + TIME_EPSILON {
            return None;
        }

        Some(format!(
            "The declared range {:.3}s-{:.3}s is {:.3}s long, but the video in '{}' runs {:.3}s — a divergence of {:.3}s, more than one frame. Every reported timelineSec is offset by that much; re-render the range, or pass the range this file was actually rendered from.",
            range.start_sec,
            range.end_sec,
            declared_sec,
            self.path.display(),
            measured_sec,
            divergence_sec
        ))
    }
}

/// One sampled timeline time, translated into a rendered file's own timebase.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct TranslatedSample {
    /// Time inside the file, in seconds.
    pub file_sec: f64,
    /// Timeline time it was translated from, in seconds.
    pub timeline_sec: f64,
    /// Why the sampler chose it.
    pub reason: SampleReason,
}

/// Translates timeline samples into a file that starts at `range_start_sec`.
///
/// Returns the samples the file can actually show, in order, alongside how many
/// were dropped for falling outside it. Dropping rather than clamping is the
/// point: a sample nudged to the nearest frame the file happens to hold would
/// come back labelled with the timeline second it was *supposed* to show, which
/// is the one mistake a judging tool must not make.
///
/// The bound is the last *decodable* time, a frame and a half back from the end
/// of the video, not the end itself. FFmpeg's seek resolves forward, so a
/// request inside the final frame interval lands past the last frame, exits 0
/// and writes nothing — which reached the caller as a hard extraction failure
/// on an otherwise correct render. Those times are counted as dropped like any
/// other the file does not hold, which is what `droppedOutsideFile` reports.
pub(super) fn translate_samples(
    samples: &[Sample],
    range_start_sec: f64,
    video_end_sec: f64,
    frame_sec: f64,
) -> (Vec<TranslatedSample>, usize) {
    let mut translated = Vec::with_capacity(samples.len());
    let mut dropped = 0_usize;
    // Never negative: a file shorter than the backoff still holds its first
    // frame, and refusing every sample of it would be a worse answer than
    // letting the extraction report what it found.
    let last_decodable_sec = (video_end_sec - frame_sec * CUT_LEAD_FRAMES).max(0.0);

    for sample in samples {
        let file_sec = sample.time_sec - range_start_sec;
        if !file_sec.is_finite() || file_sec < 0.0 || file_sec > last_decodable_sec + TIME_EPSILON {
            dropped += 1;
            continue;
        }
        translated.push(TranslatedSample {
            file_sec,
            timeline_sec: sample.time_sec,
            reason: sample.reason,
        });
    }

    (translated, dropped)
}

/// Extracts stills or a contact sheet from a rendered file rather than the
/// project timeline.
/// `timeline_range` is the caller's declaration of which timeline seconds the
/// file holds. Nothing on this path is translated with it — `--time`, `--times`
/// and `--between` stay file-relative, which is what those flags have always
/// meant — but it is echoed on the payload, so a sheet of a partial render can
/// be read against the edit it came from.
pub(super) async fn run_file_mode(
    runner: &FFmpegRunner,
    file: &Path,
    request: &FrameProbeRequest,
    format: ImageFormat,
    selection: &Selection,
    timeline_range: Option<&TimeRange>,
) -> FrameProbeResult<serde_json::Value> {
    let source = FileSource::probe(runner, file).await?;
    let max_width = request.max_width.unwrap_or(DEFAULT_MAX_WIDTH);
    let warnings = timeline_range
        .and_then(|range| source.declared_range_warning(range))
        .into_iter()
        .collect::<Vec<String>>();

    match selection {
        Selection::AssetTime { .. } => Err(FrameProbeError::new(format!(
            "{} reads a rendered video, so it cannot be combined with {}",
            request.names.file, request.names.asset
        ))),
        // Unreachable through `resolve_selection`, which routes a sampled file
        // to `run_file_sampled_mode` and refuses one that declares no range up
        // front; restated here so the refusal survives a future caller that
        // builds a `Selection` some other way.
        Selection::Sampled { .. } => Err(FrameProbeError::new(format!(
            "{} reads a rendered video and has no timeline of its own to sample. Declare the timeline range it covers with {}, and the samplers read the timeline over that range and translate every time into the file.",
            request.names.file,
            request.names.file_range_values()
        ))),
        Selection::SingleTime(time) => {
            source.ensure_times_inside(std::slice::from_ref(time))?;
            let output_path = resolve_single_output_path(&request.out, *time, format)?;
            let (width, height) = source
                .extract(runner, *time, &output_path, max_width)
                .await?;

            file_frames_payload(
                &source,
                timeline_range,
                vec![FileFrameEntry {
                    index: 0,
                    file_sec: *time,
                    timeline_sec: None,
                    reason: None,
                    path: output_path.display().to_string(),
                    width,
                    height,
                }],
                warnings,
                None,
            )
        }
        Selection::BatchTimes(times) => {
            source.ensure_times_inside(times)?;
            create_batch_output_dir(&request.out)?;

            let mut frames = Vec::with_capacity(times.len());
            for (index, time) in times.iter().enumerate() {
                let output_path = request.out.join(batch_frame_name(*time, &format));
                let (width, height) = source
                    .extract(runner, *time, &output_path, max_width)
                    .await?;
                frames.push(FileFrameEntry {
                    index,
                    file_sec: *time,
                    timeline_sec: None,
                    reason: None,
                    path: output_path.display().to_string(),
                    width,
                    height,
                });
            }

            file_frames_payload(&source, timeline_range, frames, warnings, None)
        }
        Selection::Grid {
            columns,
            rows,
            times,
        } => {
            let cells = times
                .iter()
                .map(|time| TranslatedCell {
                    file_sec: *time,
                    timeline_sec: None,
                    reason: None,
                })
                .collect::<Vec<_>>();
            run_file_grid_mode(
                runner,
                &source,
                request,
                format,
                *columns,
                *rows,
                &cells,
                timeline_range,
                warnings,
                None,
            )
            .await
        }
    }
}

/// Extracts a sampler's times from a rendered file rather than the timeline.
///
/// The samplers have already run against the sequence — that is where cuts,
/// captions and changed ranges live — and what happens here is the translation:
/// every timeline time becomes `t - range.start`, and the ones the file does
/// not hold are dropped rather than clamped. The pictures come from the
/// artifact that was actually produced, so this answers "does the render show
/// what I meant" instead of "would a fresh render show it".
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_file_sampled_mode(
    runner: &FFmpegRunner,
    file: &Path,
    request: &FrameProbeRequest,
    format: ImageFormat,
    timeline_range: &TimeRange,
    outcome: SamplerOutcome,
    grid: Option<GridLayout>,
    mut warnings: Vec<String>,
) -> FrameProbeResult<serde_json::Value> {
    let source = FileSource::probe(runner, file).await?;
    let max_width = request.max_width.unwrap_or(DEFAULT_MAX_WIDTH);
    warnings.extend(source.declared_range_warning(timeline_range));

    let (samples, dropped) = translate_samples(
        &outcome.samples,
        timeline_range.start_sec,
        source.video_end_sec(),
        source.frame_sec(),
    );
    if samples.is_empty() {
        return Err(FrameProbeError::new(format!(
            "All {} sampled times fall outside '{}', which holds {:.3}s of picture for the declared range {:.3}s-{:.3}s. Declare the range the file was really rendered from, or sample the timeline directly.",
            dropped,
            source.path.display(),
            source.video_end_sec(),
            timeline_range.start_sec,
            timeline_range.end_sec
        )));
    }

    let mut report = outcome.report;
    // The selection the caller is shown is the one it actually gets: `selected`
    // counted the sampler's own choices, and the file may hold fewer of them.
    report.selected = samples.len();
    report.dropped_outside_file = Some(dropped);

    let Some(layout) = grid else {
        create_batch_output_dir(&request.out)?;

        let mut frames = Vec::with_capacity(samples.len());
        for (index, sample) in samples.iter().enumerate() {
            let output_path = request.out.join(batch_frame_name(sample.file_sec, &format));
            let (width, height) = source
                .extract(runner, sample.file_sec, &output_path, max_width)
                .await?;
            frames.push(FileFrameEntry {
                index,
                file_sec: sample.file_sec,
                timeline_sec: Some(sample.timeline_sec),
                reason: Some(sample.reason),
                path: output_path.display().to_string(),
                width,
                height,
            });
        }

        return file_frames_payload(
            &source,
            Some(timeline_range),
            frames,
            warnings,
            Some(&report),
        );
    };

    let (columns, rows) = resolve_sampled_grid(layout, samples.len(), request)?;
    let cells = samples
        .iter()
        .map(|sample| TranslatedCell {
            file_sec: sample.file_sec,
            timeline_sec: Some(sample.timeline_sec),
            reason: Some(sample.reason),
        })
        .collect::<Vec<_>>();

    run_file_grid_mode(
        runner,
        &source,
        request,
        format,
        columns,
        rows,
        &cells,
        Some(timeline_range),
        warnings,
        Some(&report),
    )
    .await
}

/// One contact-sheet cell's times, before it has been extracted.
struct TranslatedCell {
    file_sec: f64,
    timeline_sec: Option<f64>,
    reason: Option<SampleReason>,
}

#[allow(clippy::too_many_arguments)]
async fn run_file_grid_mode(
    runner: &FFmpegRunner,
    source: &FileSource,
    request: &FrameProbeRequest,
    format: ImageFormat,
    columns: usize,
    rows: usize,
    requested: &[TranslatedCell],
    timeline_range: Option<&TimeRange>,
    warnings: Vec<String>,
    sampler: Option<&SamplerReport>,
) -> FrameProbeResult<serde_json::Value> {
    let times: Vec<f64> = requested.iter().map(|cell| cell.file_sec).collect();
    source.ensure_times_inside(&times)?;
    let cell = resolve_cell_size(request);
    let staging = CellStaging::new(cell, request.label_cells)?;
    let extract_width = grid_cell_extract_width(request, cell);

    let mut cell_paths = Vec::with_capacity(requested.len());
    let mut cells = Vec::with_capacity(requested.len());
    for (index, requested_cell) in requested.iter().enumerate() {
        let time = requested_cell.file_sec;
        source
            .extract(runner, time, &staging.extract_path(index), extract_width)
            .await?;
        // A translated cell is labelled with the second of the *timeline* it
        // shows, not with its offset into the file: the file's own timebase is
        // an artefact of where the render started, and a judge quoting a burnt-in
        // number has to be quoting one that means something in the edit. The
        // file-relative time is still reported as `fileSec` in the JSON.
        cell_paths.push(
            staging
                .finish(
                    runner,
                    index,
                    time,
                    requested_cell.timeline_sec.unwrap_or(time),
                )
                .await?,
        );
        cells.push(FileGridCell {
            index,
            row: index / columns,
            col: index % columns,
            file_sec: time,
            timeline_sec: requested_cell.timeline_sec,
            reason: requested_cell.reason,
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
        "mode": "file",
        "source": source.describe(timeline_range),
        "sheet": {
            "path": sheet.path,
            "cols": sheet.columns,
            "rows": sheet.rows,
            "cellWidth": cell.width,
            "cellHeight": cell.height,
            "labeled": request.label_cells,
            "cells": cells,
        },
        // A rendered file carries no project styling to drop, so this is
        // empty unless the declared range disagrees with the file - it is
        // present so every frame probe payload has the same shape and a
        // caller never has to branch on the mode.
        "warnings": warnings,
    });
    attach_sampler_report(&mut payload, sampler)?;

    Ok(payload)
}

fn file_frames_payload(
    source: &FileSource,
    timeline_range: Option<&TimeRange>,
    frames: Vec<FileFrameEntry>,
    warnings: Vec<String>,
    sampler: Option<&SamplerReport>,
) -> FrameProbeResult<serde_json::Value> {
    let mut payload = serde_json::json!({
        "status": "ok",
        "mode": "file",
        "source": source.describe(timeline_range),
        "count": frames.len(),
        "frames": frames,
        // See `run_file_grid_mode`.
        "warnings": warnings,
    });
    attach_sampler_report(&mut payload, sampler)?;

    Ok(payload)
}

/// Adds a sampler report to a finished file payload.
///
/// The same `sampler` block the timeline path attaches, so a caller reads the
/// kinds, candidate count and budget the same way whichever timebase the
/// pictures came from.
fn attach_sampler_report(
    payload: &mut serde_json::Value,
    sampler: Option<&SamplerReport>,
) -> FrameProbeResult<()> {
    let (Some(sampler), Some(object)) = (sampler, payload.as_object_mut()) else {
        return Ok(());
    };
    let report = serde_json::to_value(sampler).map_err(|error| {
        FrameProbeError::new(format!("Failed to report the sampler result: {}", error))
    })?;
    object.insert("sampler".to_string(), report);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 25fps frame the fixtures are built around.
    const FRAME_SEC: f64 = 0.04;

    fn sample(time_sec: f64, reason: SampleReason) -> Sample {
        Sample {
            time_sec,
            reason,
            group: None,
        }
    }

    fn source(video_duration_sec: f64, fps: Option<f64>) -> FileSource {
        FileSource {
            path: PathBuf::from("proxy.mp4"),
            duration_sec: video_duration_sec,
            video_duration_sec: Some(video_duration_sec),
            fps,
        }
    }

    #[test]
    fn translate_samples_should_subtract_the_declared_range_start() {
        let samples = [
            sample(3.94, SampleReason::CutBefore),
            sample(4.0, SampleReason::CutAfter),
        ];

        let (translated, dropped) = translate_samples(&samples, 2.0, 4.0, FRAME_SEC);

        assert_eq!(dropped, 0);
        assert_eq!(translated.len(), 2);
        assert!((translated[0].file_sec - 1.94).abs() < 1e-9);
        assert_eq!(translated[0].timeline_sec, 3.94);
        assert_eq!(translated[0].reason, SampleReason::CutBefore);
        assert!((translated[1].file_sec - 2.0).abs() < 1e-9);
        assert_eq!(translated[1].timeline_sec, 4.0);
        assert_eq!(translated[1].reason, SampleReason::CutAfter);
    }

    #[test]
    fn translate_samples_should_drop_times_the_file_does_not_hold() {
        let samples = [
            // Before the file starts.
            sample(1.5, SampleReason::ShotMid),
            sample(3.0, SampleReason::ShotMid),
            // At the file's end, which holds no frame: seeks resolve forward.
            sample(6.0, SampleReason::ShotMid),
            // Inside the file's LAST frame interval. FFmpeg's forward seek lands
            // past the final frame here and writes nothing, so this used to fail
            // the whole extraction on an otherwise correct render.
            sample(5.95, SampleReason::ShotMid),
            // Past it.
            sample(9.0, SampleReason::ShotMid),
        ];

        let (translated, dropped) = translate_samples(&samples, 2.0, 4.0, FRAME_SEC);

        assert_eq!(
            translated
                .iter()
                .map(|sample| sample.timeline_sec)
                .collect::<Vec<_>>(),
            vec![3.0],
            "only the sample the file can still be decoded at survives"
        );
        assert_eq!(dropped, 4);
    }

    #[test]
    fn declared_range_warning_should_stay_quiet_within_one_frame() {
        let source = source(4.0, Some(25.0));

        assert!(source
            .declared_range_warning(&TimeRange {
                start_sec: 2.0,
                end_sec: 6.0,
            })
            .is_none());
        assert!(
            source
                .declared_range_warning(&TimeRange {
                    start_sec: 2.0,
                    end_sec: 6.0 - FRAME_SEC,
                })
                .is_none(),
            "a draft render a frame short of the range asked for is normal"
        );
    }

    #[test]
    fn declared_range_warning_should_name_a_divergence_over_one_frame() {
        let warning = source(4.0, Some(25.0))
            .declared_range_warning(&TimeRange {
                start_sec: 2.0,
                end_sec: 8.0,
            })
            .expect("two seconds is far more than one frame");

        assert!(warning.contains("2.000s"), "{warning}");
        assert!(
            warning.contains("timelineSec"),
            "the warning must say what the divergence costs the caller: {warning}"
        );
    }

    #[test]
    fn declared_range_warning_should_fall_back_to_a_default_frame_rate() {
        // A file that declares no usable rate still gets a tolerance rather
        // than a division by zero.
        let source = source(4.0, None);

        assert!(source
            .declared_range_warning(&TimeRange {
                start_sec: 0.0,
                end_sec: 4.0 + FRAME_SEC / 2.0,
            })
            .is_none());
        assert!(source
            .declared_range_warning(&TimeRange {
                start_sec: 0.0,
                end_sec: 5.0,
            })
            .is_some());
    }

    #[test]
    fn describe_should_echo_the_declared_timeline_range() {
        let source = source(4.0, Some(25.0));

        assert!(
            source.describe(None)["timelineRange"].is_null(),
            "a file nobody declared a range for must not claim one"
        );
        assert_eq!(
            source.describe(Some(&TimeRange {
                start_sec: 2.0,
                end_sec: 6.0,
            }))["timelineRange"],
            serde_json::json!([2.0, 6.0])
        );
    }
}
