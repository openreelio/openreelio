//! Extraction from an already rendered file.
//!
//! This is the cheap judging path: the frames come from the artifact that was
//! actually produced, so no per-cell timeline render is involved and what the
//! judge sees is exactly what `verify --file` measured. All times are in the
//! file's own timebase.

use super::sheet::{build_contact_sheet, grid_cell_extract_width, resolve_cell_size, CellStaging};
use super::{
    batch_frame_name, create_batch_output_dir, ensure_frame_written, remove_stale_output,
    resolve_single_output_path, FileFrameEntry, FileGridCell, FrameProbeError, FrameProbeRequest,
    FrameProbeResult, Selection, DEFAULT_MAX_WIDTH,
};
use crate::core::ffmpeg::{FFmpegRunner, FrameExtractOptions};
use crate::core::render::{probed_image_dimensions, ImageFormat};
use std::path::{Path, PathBuf};

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

        Ok(Self {
            path: file.to_path_buf(),
            duration_sec: info.duration_sec,
            video_duration_sec,
        })
    }

    /// Last time the file can still be asked for a picture at.
    fn video_end_sec(&self) -> f64 {
        self.video_duration_sec.unwrap_or(self.duration_sec)
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

    fn describe(&self) -> serde_json::Value {
        serde_json::json!({
            "path": self.path.display().to_string(),
            "durationSec": self.duration_sec,
            "videoDurationSec": self.video_end_sec(),
        })
    }
}

/// Extracts stills or a contact sheet from a rendered file rather than the
/// project timeline.
pub(super) async fn run_file_mode(
    runner: &FFmpegRunner,
    file: &Path,
    request: &FrameProbeRequest,
    format: ImageFormat,
    selection: &Selection,
) -> FrameProbeResult<serde_json::Value> {
    let source = FileSource::probe(runner, file).await?;
    let max_width = request.max_width.unwrap_or(DEFAULT_MAX_WIDTH);

    match selection {
        Selection::AssetTime { .. } => Err(FrameProbeError::new(
            "--file reads a rendered video, so it cannot be combined with --asset".to_string(),
        )),
        // Unreachable through `resolve_selection`, which refuses the pair up
        // front; restated here so the refusal survives a future caller that
        // builds a `Selection` some other way.
        Selection::Sampled { .. } => Err(FrameProbeError::new(
            "--file reads a rendered video and has no timeline to sample, so it cannot be combined with --at-cuts, --at-transitions, --at-captions, --at-markers, --per-shot, --around or --affected. Sample the timeline instead, or pass --times/--between for the file."
                .to_string(),
        )),
        Selection::SingleTime(time) => {
            source.ensure_times_inside(std::slice::from_ref(time))?;
            let output_path = resolve_single_output_path(&request.out, *time, format)?;
            let (width, height) = source
                .extract(runner, *time, &output_path, max_width)
                .await?;

            Ok(file_frames_payload(
                &source,
                vec![FileFrameEntry {
                    index: 0,
                    file_sec: *time,
                    path: output_path.display().to_string(),
                    width,
                    height,
                }],
            ))
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
                    path: output_path.display().to_string(),
                    width,
                    height,
                });
            }

            Ok(file_frames_payload(&source, frames))
        }
        Selection::Grid {
            columns,
            rows,
            times,
        } => run_file_grid_mode(runner, &source, request, format, *columns, *rows, times).await,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_file_grid_mode(
    runner: &FFmpegRunner,
    source: &FileSource,
    request: &FrameProbeRequest,
    format: ImageFormat,
    columns: usize,
    rows: usize,
    times: &[f64],
) -> FrameProbeResult<serde_json::Value> {
    source.ensure_times_inside(times)?;
    let cell = resolve_cell_size(request);
    let staging = CellStaging::new(cell, request.label_cells)?;
    let extract_width = grid_cell_extract_width(request, cell);

    let mut cell_paths = Vec::with_capacity(times.len());
    let mut cells = Vec::with_capacity(times.len());
    for (index, time) in times.iter().enumerate() {
        source
            .extract(runner, *time, &staging.extract_path(index), extract_width)
            .await?;
        cell_paths.push(staging.finish(runner, index, *time).await?);
        cells.push(FileGridCell {
            index,
            row: index / columns,
            col: index % columns,
            file_sec: *time,
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

    Ok(serde_json::json!({
        "status": "ok",
        "mode": "file",
        "source": source.describe(),
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
        // always empty - it is present so every frame probe payload has the
        // same shape and a caller never has to branch on the mode.
        "warnings": Vec::<String>::new(),
    }))
}

fn file_frames_payload(source: &FileSource, frames: Vec<FileFrameEntry>) -> serde_json::Value {
    serde_json::json!({
        "status": "ok",
        "mode": "file",
        "source": source.describe(),
        "count": frames.len(),
        "frames": frames,
        // Always empty: see `run_file_grid_mode`.
        "warnings": Vec::<String>::new(),
    })
}
