//! Rendered-file measurement pass for QC
//!
//! Runs a single FFmpeg analysis pass over a rendered file and turns the filter
//! log into [`RenderMeasurements`]. Structural rules can read the timeline, but
//! black frames, freezes, loudness, and peaks only exist in the pixels and
//! samples that were actually written, so they are measured here once and
//! shared with every rule through the QC context.
//!
//! Every parser in this module is a pure function over FFmpeg stderr text so it
//! can be tested against captured output without invoking FFmpeg.

use std::path::Path;
use std::time::Duration;

use super::context::RenderMeasurements;
use crate::core::analysis::audio::parse_silence_regions;
use crate::core::ffmpeg::FFmpegRunner;
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Options
// =============================================================================

/// Default minimum black duration to report, in seconds.
const DEFAULT_BLACK_MIN_DURATION: f64 = 0.1;

/// Default minimum freeze duration to report, in seconds.
const DEFAULT_FREEZE_MIN_DURATION: f64 = 2.0;

/// Default silence threshold in dBFS.
const DEFAULT_SILENCE_THRESHOLD_DB: f64 = -50.0;

/// Default minimum silence duration to report, in seconds.
const DEFAULT_SILENCE_MIN_DURATION: f64 = 1.5;

/// Default watchdog timeout for the measurement pass.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);

/// Luma threshold (fraction of pixels below the pixel threshold) for black detection.
const BLACK_PICTURE_THRESHOLD: f64 = 0.98;

/// Per-pixel luma threshold for black detection.
const BLACK_PIXEL_THRESHOLD: f64 = 0.10;

/// Noise tolerance for freeze detection, in dB.
const FREEZE_NOISE_DB: f64 = -60.0;

/// Tuning for the measurement pass.
#[derive(Debug, Clone)]
pub struct MeasureOptions {
    /// Minimum black duration reported, in seconds.
    pub black_min_duration: f64,
    /// Minimum freeze duration reported, in seconds.
    pub freeze_min_duration: f64,
    /// Silence threshold in dBFS (negative).
    pub silence_threshold_db: f64,
    /// Minimum silence duration reported, in seconds.
    pub silence_min_duration: f64,
    /// Watchdog timeout for the whole pass.
    pub timeout: Duration,
}

impl Default for MeasureOptions {
    fn default() -> Self {
        Self {
            black_min_duration: DEFAULT_BLACK_MIN_DURATION,
            freeze_min_duration: DEFAULT_FREEZE_MIN_DURATION,
            silence_threshold_db: DEFAULT_SILENCE_THRESHOLD_DB,
            silence_min_duration: DEFAULT_SILENCE_MIN_DURATION,
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

// =============================================================================
// Result
// =============================================================================

/// Outcome of a measurement pass, including what could not be measured.
///
/// [`RenderMeasurements`] alone cannot express "there was nothing to measure":
/// an empty silence list means the same thing whether the file was loud
/// throughout or carried no audio at all. The extra fields here let callers
/// report untestable checks as skipped instead of passed.
#[derive(Debug, Clone)]
pub struct MeasurementReport {
    /// Values extracted from the filter log.
    pub measurements: RenderMeasurements,
    /// Duration of the measured file in seconds, as reported by ffprobe.
    pub duration_sec: f64,
    /// Whether the video detection chain ran.
    pub video_measured: bool,
    /// Whether the audio detection chain ran.
    pub audio_measured: bool,
    /// Human-readable remarks about degraded or skipped measurements.
    pub notes: Vec<String>,
}

// =============================================================================
// Measurement pass
// =============================================================================

/// Measures a rendered file and returns the values QC rules consume.
///
/// See [`measure_rendered_file_detailed`] when the caller also needs to know
/// which parts of the file could be measured at all.
pub async fn measure_rendered_file(
    runner: &FFmpegRunner,
    file: &Path,
    opts: &MeasureOptions,
) -> CoreResult<RenderMeasurements> {
    measure_rendered_file_detailed(runner, file, opts)
        .await
        .map(|report| report.measurements)
}

/// Measures a rendered file, reporting what was measured alongside the values.
///
/// The pass probes the file first so the filtergraph only references streams
/// that exist (an `[0:a]` chain against a silent-film render fails the whole
/// invocation), then runs one FFmpeg pass and parses its log.
pub async fn measure_rendered_file_detailed(
    runner: &FFmpegRunner,
    file: &Path,
    opts: &MeasureOptions,
) -> CoreResult<MeasurementReport> {
    if !file.exists() {
        return Err(CoreError::FileNotFound(file.display().to_string()));
    }

    let media = runner
        .probe(file)
        .await
        .map_err(|error| CoreError::FFprobeError(format!("Failed to probe {file:?}: {error}")))?;

    let has_video = media.video.is_some();
    let has_audio = media.audio.is_some();

    if !has_video && !has_audio {
        return Err(CoreError::ValidationError(format!(
            "File '{}' has neither a video nor an audio stream to measure",
            file.display()
        )));
    }

    let mut notes = Vec::new();
    if !has_video {
        notes.push("File has no video stream; picture checks were not run".to_string());
    }
    if !has_audio {
        notes.push("File has no audio stream; audio checks were not run".to_string());
    }

    let (graph, maps) = build_filter_graph(opts, has_video, has_audio);
    let map_refs: Vec<&str> = maps.iter().map(String::as_str).collect();

    let capture = runner
        .run_filter_capture_stderr(file, &graph, &map_refs, opts.timeout)
        .await
        .map_err(|error| {
            CoreError::AnalysisFailed(format!("Rendered-file measurement failed: {error}"))
        })?;

    // Filters report their findings at FFmpeg's INFO level. If not a single
    // INFO line came back, the log level was overridden somewhere and "no
    // detections" would be indistinguishable from "detection never ran". The
    // flag is recorded while streaming, so a long pass that evicts the header
    // lines from the retained text still answers correctly.
    if !capture.saw_info_output {
        return Err(CoreError::AnalysisFailed(
            "FFmpeg produced no INFO-level output, so detection results cannot be trusted"
                .to_string(),
        ));
    }

    if capture.truncated {
        notes.push(
            "Filter output exceeded the stderr retention limit; detections near the start of \
             the file may be missing"
                .to_string(),
        );
    }

    let stderr = capture.stderr;
    let duration_sec = media.duration_sec;
    // Carried into the measurements so rules can compare the file against the
    // sequence; a probe that reported no usable duration stays `None` rather
    // than claiming a zero-length file.
    let mut measurements = RenderMeasurements {
        file_duration_sec: (duration_sec.is_finite() && duration_sec > 0.0).then_some(duration_sec),
        ..Default::default()
    };

    if has_video {
        measurements.black_ranges = parse_black_ranges(&stderr, duration_sec)
            .into_iter()
            .filter(|(start, end)| end - start >= opts.black_min_duration)
            .collect();
        measurements.freeze_ranges = parse_freeze_ranges(&stderr, duration_sec)
            .into_iter()
            .filter(|(start, end)| end - start >= opts.freeze_min_duration)
            .collect();
    }

    if has_audio {
        measurements.silence_ranges = parse_silence_regions(&stderr)
            .into_iter()
            .map(|region| (region.start_sec, region.end_sec))
            .collect();

        let loudness = parse_loudness_summary(&stderr);
        measurements.integrated_lufs = loudness.integrated_lufs;
        measurements.loudness_range_lu = loudness.loudness_range_lu;
        measurements.true_peak_dbtp = loudness.true_peak_dbtp;

        let astats = parse_astats_overall(&stderr);
        measurements.sample_peak_db = astats.sample_peak_db;
        measurements.flat_factor = astats.flat_factor;

        if measurements.integrated_lufs.is_none() {
            notes.push(
                "EBU R128 summary was not reported; loudness could not be measured".to_string(),
            );
        }
        if measurements.true_peak_dbtp.is_none() {
            if measurements.sample_peak_db.is_some() {
                notes.push(
                    "True peak was not reported; peak checks fall back to sample peak, which \
                     under-reports inter-sample overs"
                        .to_string(),
                );
            } else {
                notes.push("Neither true peak nor sample peak could be measured".to_string());
            }
        }
    }

    Ok(MeasurementReport {
        measurements,
        duration_sec,
        video_measured: has_video,
        audio_measured: has_audio,
        notes,
    })
}

/// Builds the single-pass filtergraph and the output labels to map.
fn build_filter_graph(
    opts: &MeasureOptions,
    has_video: bool,
    has_audio: bool,
) -> (String, Vec<String>) {
    let mut chains: Vec<String> = Vec::new();
    let mut maps: Vec<String> = Vec::new();

    if has_video {
        chains.push(format!(
            "[0:v]blackdetect=d={black_d:.3}:pic_th={pic_th:.2}:pix_th={pix_th:.2},\
             freezedetect=n={freeze_n}dB:d={freeze_d:.3}[v]",
            black_d = opts.black_min_duration.clamp(0.01, 60.0),
            pic_th = BLACK_PICTURE_THRESHOLD,
            pix_th = BLACK_PIXEL_THRESHOLD,
            freeze_n = FREEZE_NOISE_DB,
            freeze_d = opts.freeze_min_duration.clamp(0.01, 600.0),
        ));
        maps.push("[v]".to_string());
    }

    if has_audio {
        // `framelog` is deliberately left at its default: FFmpeg 4.4 and 6.1
        // only accept `info`/`verbose` there, so passing `quiet` fails option
        // parsing on the builds most users have. The per-frame lines it would
        // have suppressed carry the `[Parsed_ebur128` marker, so the bounded
        // filter buffer absorbs them, and the Summary block still prints.
        chains.push(format!(
            "[0:a]ebur128=peak=true,\
             silencedetect=n={silence_n:.1}dB:d={silence_d:.3},\
             astats=metadata=0:measure_perchannel=none:measure_overall=Peak_level+Flat_factor[a]",
            silence_n = opts.silence_threshold_db.clamp(-90.0, 0.0),
            silence_d = opts.silence_min_duration.clamp(0.01, 600.0),
        ));
        maps.push("[a]".to_string());
    }

    (chains.join(";"), maps)
}

// =============================================================================
// Parsers (pure, testable without FFmpeg)
// =============================================================================

/// Loudness values read from the `ebur128` summary block.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoudnessSummary {
    /// Integrated program loudness in LUFS.
    pub integrated_lufs: Option<f64>,
    /// Loudness range in LU.
    pub loudness_range_lu: Option<f64>,
    /// True peak in dBTP.
    pub true_peak_dbtp: Option<f64>,
}

/// Overall values read from the `astats` summary.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AstatsOverall {
    /// Sample peak in dBFS.
    pub sample_peak_db: Option<f64>,
    /// Flatness factor (high values indicate a clipped or flat signal).
    pub flat_factor: Option<f64>,
}

/// Parses `blackdetect` ranges from FFmpeg stderr.
///
/// Expects lines of the form:
/// ```text
/// [blackdetect @ 0x1] black_start:12.5 black_end:13.75 black_duration:1.25
/// ```
/// A range left open at end of file is closed at `duration_sec` when known.
pub fn parse_black_ranges(stderr: &str, duration_sec: f64) -> Vec<(f64, f64)> {
    let mut ranges = Vec::new();
    let mut open_start: Option<f64> = None;

    for line in stderr.lines() {
        if !line.contains("black_start") && !line.contains("black_end") {
            continue;
        }

        let start = extract_marker_value(line, "black_start");
        let end = extract_marker_value(line, "black_end");

        match (start, end) {
            (Some(start), Some(end)) => push_range(&mut ranges, start, end),
            (Some(start), None) => open_start = Some(start),
            (None, Some(end)) => {
                if let Some(start) = open_start.take() {
                    push_range(&mut ranges, start, end);
                }
            }
            (None, None) => {}
        }
    }

    if let Some(start) = open_start {
        if duration_sec > start {
            push_range(&mut ranges, start, duration_sec);
        }
    }

    ranges
}

/// Parses `freezedetect` ranges from FFmpeg stderr.
///
/// Expects lines of the form:
/// ```text
/// [freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 2.502
/// [freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 5.508
/// ```
/// `freezedetect` does not always emit a closing marker at end of file, so an
/// open range is closed at `duration_sec` when known.
pub fn parse_freeze_ranges(stderr: &str, duration_sec: f64) -> Vec<(f64, f64)> {
    let mut ranges = Vec::new();
    let mut open_start: Option<f64> = None;

    for line in stderr.lines() {
        if let Some(start) = extract_marker_value(line, "freeze_start") {
            open_start = Some(start);
        } else if let Some(end) = extract_marker_value(line, "freeze_end") {
            if let Some(start) = open_start.take() {
                push_range(&mut ranges, start, end);
            }
        }
    }

    if let Some(start) = open_start {
        if duration_sec > start {
            push_range(&mut ranges, start, duration_sec);
        }
    }

    ranges
}

/// Parses the `ebur128` summary block.
///
/// The block is emitted once at end of stream and its values sit on indented
/// continuation lines, so parsing keys off the labels rather than the layout:
/// ```text
/// [Parsed_ebur128_0 @ 0x1] Summary:
///
///   Integrated loudness:
///     I:         -23.0 LUFS
///     Threshold: -33.6 LUFS
///
///   Loudness range:
///     LRA:         5.2 LU
///
///   True peak:
///     Peak:       -1.2 dBFS
/// ```
/// A build without true-peak support simply omits the last section; the caller
/// then falls back to the sample peak reported by `astats`.
pub fn parse_loudness_summary(stderr: &str) -> LoudnessSummary {
    let mut summary = LoudnessSummary::default();
    let mut in_true_peak_section = false;

    for line in stderr.lines() {
        let content = strip_log_prefix(line).trim();

        if content.starts_with("True peak") {
            in_true_peak_section = true;
            continue;
        }
        if content.starts_with("Integrated loudness") || content.starts_with("Loudness range") {
            in_true_peak_section = false;
            continue;
        }

        if let Some(rest) = content.strip_prefix("I:") {
            if let Some(value) = parse_leading_f64(rest) {
                summary.integrated_lufs = Some(value);
            }
        } else if let Some(rest) = content.strip_prefix("LRA:") {
            if let Some(value) = parse_leading_f64(rest) {
                summary.loudness_range_lu = Some(value);
            }
        } else if in_true_peak_section {
            if let Some(rest) = content.strip_prefix("Peak:") {
                if let Some(value) = parse_leading_f64(rest) {
                    summary.true_peak_dbtp = Some(value);
                }
            }
        }
    }

    summary
}

/// Parses the overall `astats` summary.
///
/// Expects lines of the form:
/// ```text
/// [Parsed_astats_2 @ 0x1] Peak level dB: -1.234567
/// [Parsed_astats_2 @ 0x1] Flat factor: 0.000000
/// ```
/// A digital-silence pass reports `-inf`, which is returned as `None` rather
/// than a numeric floor so callers can tell it apart from a measured level.
pub fn parse_astats_overall(stderr: &str) -> AstatsOverall {
    let mut overall = AstatsOverall::default();

    for line in stderr.lines() {
        let content = strip_log_prefix(line).trim();

        if let Some(rest) = content.strip_prefix("Peak level dB:") {
            if let Some(value) = parse_leading_f64(rest) {
                overall.sample_peak_db = Some(value);
            }
        } else if let Some(rest) = content.strip_prefix("Flat factor:") {
            if let Some(value) = parse_leading_f64(rest) {
                overall.flat_factor = Some(value);
            }
        }
    }

    overall
}

/// Appends a range, ignoring degenerate or non-finite values.
fn push_range(ranges: &mut Vec<(f64, f64)>, start: f64, end: f64) {
    if start.is_finite() && end.is_finite() && end > start {
        ranges.push((start, end));
    }
}

/// Extracts the number following `marker` (with an optional `:` and spaces).
fn extract_marker_value(line: &str, marker: &str) -> Option<f64> {
    let position = line.find(marker)?;
    let rest = line[position + marker.len()..].trim_start();
    let rest = rest.strip_prefix(':').unwrap_or(rest);
    parse_leading_f64(rest)
}

/// Parses the first numeric token of `text`, ignoring trailing units.
fn parse_leading_f64(text: &str) -> Option<f64> {
    let trimmed = text.trim_start();
    let token: String = trimmed
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '+' || *c == '.' || *c == 'e')
        .collect();

    token.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// Removes a leading `[filter @ 0x…]` log prefix, if present.
fn strip_log_prefix(line: &str) -> &str {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('[') {
        return line;
    }
    match trimmed.find(']') {
        Some(end) => &trimmed[end + 1..],
        None => line,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `blackdetect` output from a clip that fades from black.
    const BLACKDETECT_LOG: &str = "\
[Parsed_blackdetect_0 @ 000001f3f6c0] black_start:0 black_end:1.04 black_duration:1.04
[Parsed_blackdetect_0 @ 000001f3f6c0] black_start:12.52 black_end:12.6 black_duration:0.08";

    /// Real `freezedetect` output for one frozen stretch.
    const FREEZEDETECT_LOG: &str = "\
[Parsed_freezedetect_1 @ 000001f3f6c0] lavfi.freezedetect.freeze_start: 2.502
[Parsed_freezedetect_1 @ 000001f3f6c0] lavfi.freezedetect.freeze_duration: 3.006
[Parsed_freezedetect_1 @ 000001f3f6c0] lavfi.freezedetect.freeze_end: 5.508";

    /// Real `ebur128` summary block with true peak enabled.
    const EBUR128_SUMMARY: &str = "\
[Parsed_ebur128_0 @ 000001f3f7a0] Summary:

  Integrated loudness:
    I:         -18.3 LUFS
    Threshold: -28.6 LUFS

  Loudness range:
    LRA:         7.4 LU
    Threshold:  -38.8 LUFS
    LRA low:    -22.8 LUFS
    LRA high:   -15.4 LUFS

  True peak:
    Peak:       -1.2 dBFS";

    /// Real `ebur128` per-frame lines, which print whenever `framelog` is left
    /// at its default (the only portable setting across FFmpeg builds).
    const EBUR128_PER_FRAME: &str = "\
[Parsed_ebur128_0 @ 000001f3f7a0] t: 0.19999   M: -21.4 S:-120.7     I: -21.4 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 000001f3f7a0] t: 0.29999   M: -19.8 S:-120.7     I: -20.3 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 000001f3f7a0] t: 0.39999   M: -18.9 S: -21.1     I: -19.6 LUFS       LRA:   1.2 LU";

    /// Real `astats` overall section with per-channel measurement disabled.
    const ASTATS_LOG: &str = "\
[Parsed_astats_2 @ 000001f3f8c0] Overall
[Parsed_astats_2 @ 000001f3f8c0] Peak level dB: -1.234567
[Parsed_astats_2 @ 000001f3f8c0] Flat factor: 0.000000";

    const SILENCEDETECT_LOG: &str = "\
[silencedetect @ 000001f3f9e0] silence_start: 4.5
[silencedetect @ 000001f3f9e0] silence_end: 7.25 | silence_duration: 2.75";

    const INFO_HEADER: &str = "\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'render.mp4':
Stream mapping:
  Stream #0:0 -> #0:0 (h264 (native) -> wrapped_avframe (native))
Output #0, null, to 'pipe:':";

    // ========================================================================
    // blackdetect
    // ========================================================================

    #[test]
    fn test_parse_black_ranges_should_read_start_and_end_pairs() {
        let ranges = parse_black_ranges(BLACKDETECT_LOG, 20.0);

        assert_eq!(ranges.len(), 2);
        assert!((ranges[0].0 - 0.0).abs() < 1e-9);
        assert!((ranges[0].1 - 1.04).abs() < 1e-9);
        assert!((ranges[1].0 - 12.52).abs() < 1e-9);
        assert!((ranges[1].1 - 12.6).abs() < 1e-9);
    }

    #[test]
    fn test_parse_black_ranges_should_close_an_open_range_at_the_file_end() {
        let log = "[Parsed_blackdetect_0 @ 0x1] black_start:8.5";

        let ranges = parse_black_ranges(log, 10.0);

        assert_eq!(ranges.len(), 1);
        assert!((ranges[0].1 - 10.0).abs() < 1e-9);
    }

    #[test]
    fn test_parse_black_ranges_should_ignore_unrelated_output() {
        assert!(parse_black_ranges(INFO_HEADER, 10.0).is_empty());
    }

    // ========================================================================
    // freezedetect
    // ========================================================================

    #[test]
    fn test_parse_freeze_ranges_should_pair_start_and_end_markers() {
        let ranges = parse_freeze_ranges(FREEZEDETECT_LOG, 20.0);

        assert_eq!(ranges.len(), 1);
        assert!((ranges[0].0 - 2.502).abs() < 1e-9);
        assert!((ranges[0].1 - 5.508).abs() < 1e-9);
    }

    #[test]
    fn test_parse_freeze_ranges_should_close_an_open_range_at_the_file_end() {
        let log = "[Parsed_freezedetect_1 @ 0x1] lavfi.freezedetect.freeze_start: 6";

        let ranges = parse_freeze_ranges(log, 9.5);

        assert_eq!(ranges, vec![(6.0, 9.5)]);
    }

    #[test]
    fn test_parse_freeze_ranges_should_ignore_duration_markers() {
        let log = "[Parsed_freezedetect_1 @ 0x1] lavfi.freezedetect.freeze_duration: 3.006";

        assert!(parse_freeze_ranges(log, 10.0).is_empty());
    }

    // ========================================================================
    // ebur128 summary
    // ========================================================================

    #[test]
    fn test_parse_loudness_summary_should_read_integrated_range_and_true_peak() {
        let summary = parse_loudness_summary(EBUR128_SUMMARY);

        assert_eq!(summary.integrated_lufs, Some(-18.3));
        assert_eq!(summary.loudness_range_lu, Some(7.4));
        assert_eq!(summary.true_peak_dbtp, Some(-1.2));
    }

    #[test]
    fn test_parse_loudness_summary_should_not_confuse_thresholds_with_values() {
        let summary = parse_loudness_summary(EBUR128_SUMMARY);

        // "LRA low"/"LRA high"/"Threshold" lines must not overwrite LRA or I.
        assert_eq!(summary.loudness_range_lu, Some(7.4));
        assert_eq!(summary.integrated_lufs, Some(-18.3));
    }

    #[test]
    fn test_parse_loudness_summary_should_degrade_when_true_peak_is_absent() {
        let without_true_peak = "\
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -23.0 LUFS

  Loudness range:
    LRA:         2.0 LU";

        let summary = parse_loudness_summary(without_true_peak);

        assert_eq!(summary.integrated_lufs, Some(-23.0));
        assert_eq!(summary.true_peak_dbtp, None);
    }

    #[test]
    fn test_parse_loudness_summary_should_ignore_per_frame_lines() {
        let per_frame =
            "[Parsed_ebur128_0 @ 0x1] t: 1.19967   M: -22.9 S:-120.7     I: -30.0 LUFS  LRA: 0.0 LU";

        let summary = parse_loudness_summary(per_frame);

        assert_eq!(summary.integrated_lufs, None);
        assert_eq!(summary.loudness_range_lu, None);
    }

    /// Feature: EBU R128 measurement without `framelog=quiet`
    /// Scenario: should read the summary out of a log full of per-frame lines
    #[test]
    fn test_parse_loudness_summary_should_read_the_summary_after_per_frame_lines() {
        let log = format!("{EBUR128_PER_FRAME}\n{EBUR128_SUMMARY}");

        let summary = parse_loudness_summary(&log);

        assert_eq!(summary.integrated_lufs, Some(-18.3));
        assert_eq!(summary.loudness_range_lu, Some(7.4));
        assert_eq!(summary.true_peak_dbtp, Some(-1.2));
    }

    // ========================================================================
    // astats
    // ========================================================================

    #[test]
    fn test_parse_astats_overall_should_read_peak_and_flat_factor() {
        let overall = parse_astats_overall(ASTATS_LOG);

        assert_eq!(overall.sample_peak_db, Some(-1.234567));
        assert_eq!(overall.flat_factor, Some(0.0));
    }

    #[test]
    fn test_parse_astats_overall_should_return_none_for_digital_silence() {
        let silent = "[Parsed_astats_2 @ 0x1] Peak level dB: -inf";

        let overall = parse_astats_overall(silent);

        assert_eq!(overall.sample_peak_db, None);
    }

    // ========================================================================
    // Shared helpers
    // ========================================================================

    #[test]
    fn test_silence_parser_reuse_on_a_combined_log() {
        let combined = format!("{INFO_HEADER}\n{SILENCEDETECT_LOG}\n{EBUR128_SUMMARY}");

        let regions = parse_silence_regions(&combined);

        assert_eq!(regions.len(), 1);
        assert!((regions[0].start_sec - 4.5).abs() < 1e-9);
        assert!((regions[0].end_sec - 7.25).abs() < 1e-9);
    }

    #[test]
    fn test_strip_log_prefix() {
        assert_eq!(
            strip_log_prefix("[Parsed_x @ 0x1] I: -5.0").trim(),
            "I: -5.0"
        );
        assert_eq!(strip_log_prefix("    I: -5.0").trim(), "I: -5.0");
    }

    // ========================================================================
    // Filter graph
    // ========================================================================

    #[test]
    fn test_build_filter_graph_should_include_both_chains_when_both_streams_exist() {
        let (graph, maps) = build_filter_graph(&MeasureOptions::default(), true, true);

        assert!(graph.contains("[0:v]blackdetect="));
        assert!(graph.contains("freezedetect="));
        assert!(graph.contains("[0:a]ebur128=peak=true,"));
        assert!(
            !graph.contains("framelog"),
            "framelog is unsupported on FFmpeg 4.4/6.1 and must stay off the graph: {graph}"
        );
        assert!(graph.contains("silencedetect="));
        assert!(graph.contains("astats=metadata=0"));
        assert_eq!(maps, vec!["[v]".to_string(), "[a]".to_string()]);
    }

    #[test]
    fn test_build_filter_graph_should_drop_the_audio_chain_without_audio() {
        let (graph, maps) = build_filter_graph(&MeasureOptions::default(), true, false);

        assert!(!graph.contains("[0:a]"));
        assert_eq!(maps, vec!["[v]".to_string()]);
    }

    #[test]
    fn test_build_filter_graph_should_drop_the_video_chain_without_video() {
        let (graph, maps) = build_filter_graph(&MeasureOptions::default(), false, true);

        assert!(!graph.contains("[0:v]"));
        assert_eq!(maps, vec!["[a]".to_string()]);
    }

    #[test]
    fn test_build_filter_graph_should_clamp_out_of_range_options() {
        let opts = MeasureOptions {
            black_min_duration: -5.0,
            freeze_min_duration: 0.0,
            silence_threshold_db: -500.0,
            silence_min_duration: 100_000.0,
            timeout: Duration::from_secs(1),
        };

        let (graph, _) = build_filter_graph(&opts, true, true);

        assert!(graph.contains("blackdetect=d=0.010"));
        assert!(graph.contains("d=0.010[v]"));
        assert!(graph.contains("silencedetect=n=-90.0dB:d=600.000"));
    }
}
