//! Audio Profiling Module
//!
//! Extracts audio characteristics from video files using FFmpeg filters.
//! Part of the reference video analysis pipeline (ADR-048, Group 2).
//!
//! Produces an [`AudioProfile`] containing BPM estimation, loudness curves,
//! spectral centroid, and silence region detection.

use std::path::{Path, PathBuf};
use std::time::Duration;

use uuid::Uuid;
use webrtc_vad::{SampleRate as VadSampleRate, Vad, VadMode};

use super::ducking::invert_silence_to_speech;
use super::loudness::{
    audible_momentary_readings, loudness_filter_chain, parse_astats_overall,
    parse_loudness_summary, parse_momentary_loudness, per_second_loudness_profile,
    MOMENTARY_SAMPLES_PER_SECOND,
};
use super::types::{
    AudioProfile, SilenceRegion, SpeechRegion, AUDIO_MEASUREMENT_VERSION, SILENCE_FLOOR_DB,
};
use crate::core::captions::audio::{extract_audio_for_transcription_async, load_audio_samples_i16};
use crate::core::ffmpeg::{capture_filter_stderr, FFmpegError, FilterMode};
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Constants
// =============================================================================

/// Silence detection noise floor threshold in dB
const SILENCE_THRESHOLD_DB: &str = "-40dB";

/// Minimum silence duration in seconds
const SILENCE_MIN_DURATION: &str = "0.5";

/// Peak detection threshold in dB: a sample must exceed both neighbors by
/// at least this amount to be considered a rhythmic onset.
const PEAK_THRESHOLD_DB: f64 = 3.0;

/// Approximate sampling rate of FFmpeg `ebur128` momentary loudness output.
const LOUDNESS_SAMPLES_PER_SECOND: f64 = MOMENTARY_SAMPLES_PER_SECOND;

/// Minimum number of detected peaks required for BPM estimation.
const MIN_PEAKS_FOR_BPM: usize = 4;

/// Minimum valid BPM (clamp lower bound)
const MIN_BPM: f64 = 30.0;

/// Maximum valid BPM (clamp upper bound)
const MAX_BPM: f64 = 300.0;

/// Number of tail lines to keep from FFmpeg stderr for error reporting.
const STDERR_TAIL_SIZE: usize = 20;

/// Watchdog timeout for a single FFmpeg analysis pass.
///
/// Matches the analysis job budget elsewhere in the pipeline; without it a
/// stalled decoder would hang the calling job forever.
const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(600);

/// VAD frame size in milliseconds.
const VAD_FRAME_MS: usize = 30;

/// VAD frame size in samples at 16 kHz.
const VAD_FRAME_SAMPLES: usize = 480;

/// Merge adjacent voiced regions separated by short gaps.
const VAD_MAX_GAP_SEC: f64 = 0.25;

/// Drop very short speech regions that are likely false positives.
const VAD_MIN_SPEECH_SEC: f64 = 0.18;

// =============================================================================
// AudioProfiler
// =============================================================================

/// Analyzes audio tracks in video files using FFmpeg filters.
///
/// Runs multiple FFmpeg filter passes (silence detection, EBU R128 loudness,
/// spectral centroid) and combines the results into a single [`AudioProfile`].
pub struct AudioProfiler {
    ffmpeg_path: PathBuf,
}

impl AudioProfiler {
    /// Creates a new audio profiler with the given FFmpeg binary path.
    pub fn new(ffmpeg_path: PathBuf) -> Self {
        Self { ffmpeg_path }
    }

    /// Analyzes the audio track of a video file and returns a complete audio profile.
    ///
    /// Runs silence detection, loudness metering, and spectral analysis in
    /// parallel via `tokio::join!`. If the video has no audio stream, returns
    /// [`AudioProfile::silent`] instead.
    pub async fn analyze(&self, video_path: &Path, duration_sec: f64) -> CoreResult<AudioProfile> {
        // Run all three analysis passes in parallel
        let (silence_result, loudness_result, spectral_result) = tokio::join!(
            self.detect_silence(video_path),
            self.extract_loudness_and_peak(video_path),
            self.extract_spectral_centroid(video_path),
        );

        // If all three fail with a "no audio stream" indicator, return silent profile
        let silence_no_audio = is_no_audio_error(&silence_result);
        let loudness_no_audio = is_no_audio_error(&loudness_result);
        let spectral_no_audio = is_no_audio_error(&spectral_result);

        if silence_no_audio && loudness_no_audio && spectral_no_audio {
            tracing::debug!(
                "No audio stream detected in {}, returning silent profile",
                video_path.display()
            );
            return Ok(AudioProfile::silent(duration_sec));
        }

        let silence_regions = silence_result?;
        let loudness = loudness_result?;
        let spectral_centroid_hz = spectral_result.unwrap_or_else(|err| {
            tracing::debug!(
                "Spectral centroid extraction failed, defaulting to 0.0: {}",
                err
            );
            0.0
        });

        // Onset detection runs over the audible readings: the momentary series
        // keeps its silence windows so the per-second profile stays addressable
        // by the second, but a stretch of floor readings is a pair of artificial
        // jumps rather than a beat.
        let onset_samples = audible_momentary_readings(&loudness.momentary_lufs);
        let bpm = Self::estimate_bpm_from_samples(&onset_samples, LOUDNESS_SAMPLES_PER_SECOND)
            .or_else(|| Self::estimate_bpm(&loudness.loudness_profile));
        let speech_regions = match self
            .detect_speech_regions_vad(video_path, duration_sec)
            .await
        {
            Ok(regions) => regions,
            Err(err) => {
                tracing::debug!(
                    "Speech VAD failed, falling back to silence inversion: {}",
                    err
                );
                derive_speech_regions_from_silence(&silence_regions, duration_sec)
            }
        };

        let peak_db = loudness.peak_db();

        Ok(AudioProfile {
            measurement_version: AUDIO_MEASUREMENT_VERSION,
            bpm,
            spectral_centroid_hz,
            loudness_profile: loudness.loudness_profile,
            peak_db,
            integrated_lufs: loudness.integrated_lufs,
            loudness_range_lu: loudness.loudness_range_lu,
            true_peak_dbtp: loudness.true_peak_dbtp,
            silence_regions,
            speech_regions,
        })
    }

    // =========================================================================
    // Silence Detection
    // =========================================================================

    /// Detects regions of silence using FFmpeg's `silencedetect` filter.
    ///
    /// Parses stderr for `silence_start` and `silence_end` markers.
    async fn detect_silence(&self, video_path: &Path) -> CoreResult<Vec<SilenceRegion>> {
        let filter = format!(
            "silencedetect=n={}:d={}",
            SILENCE_THRESHOLD_DB, SILENCE_MIN_DURATION
        );
        let capture = self.run_ffmpeg_filter(video_path, &filter).await?;
        Ok(parse_silence_regions(&capture.stderr))
    }

    /// Detects silence regions with custom threshold and minimum duration.
    ///
    /// Unlike `detect_silence()` which uses fixed defaults (-40dB / 0.5s),
    /// this allows callers to specify sensitivity for cleanup workflows.
    pub async fn detect_silence_custom(
        &self,
        video_path: &Path,
        threshold_db: f64,
        min_duration_sec: f64,
    ) -> CoreResult<Vec<SilenceRegion>> {
        if !threshold_db.is_finite() || !min_duration_sec.is_finite() {
            return Err(CoreError::ValidationError(
                "threshold_db and min_duration_sec must be finite values".to_string(),
            ));
        }

        let threshold = format!("{}dB", threshold_db.clamp(-90.0, 0.0));
        let duration = format!("{:.3}", min_duration_sec.clamp(0.01, 30.0));
        let filter = format!("silencedetect=n={}:d={}", threshold, duration);
        let capture = self.run_ffmpeg_filter(video_path, &filter).await?;
        Ok(parse_silence_regions(&capture.stderr))
    }

    /// Detect speech regions using a lightweight WebRTC VAD pass.
    async fn detect_speech_regions_vad(
        &self,
        video_path: &Path,
        duration_sec: f64,
    ) -> CoreResult<Vec<SpeechRegion>> {
        let temp_audio_path =
            std::env::temp_dir().join(format!("openreelio-vad-{}.wav", Uuid::new_v4()));
        let temp_audio_path_for_cleanup = temp_audio_path.clone();
        let ffmpeg_path = self.ffmpeg_path.to_string_lossy().to_string();

        let result = async {
            extract_audio_for_transcription_async(video_path, &temp_audio_path, Some(&ffmpeg_path))
                .await
                .map_err(map_audio_extraction_error)?;

            let audio_path_for_task = temp_audio_path.clone();
            tokio::task::spawn_blocking(move || {
                let samples = load_audio_samples_i16(&audio_path_for_task)
                    .map_err(map_audio_extraction_error)?;
                detect_speech_regions_from_pcm(&samples, duration_sec)
            })
            .await
            .map_err(|error| {
                CoreError::AnalysisFailed(format!("Speech VAD task panicked: {}", error))
            })?
        }
        .await;

        let _ = tokio::fs::remove_file(&temp_audio_path_for_cleanup).await;
        result
    }

    // =========================================================================
    // Loudness & Peak Extraction
    // =========================================================================

    /// Measures loudness and peak with the shared EBU R128 / true-peak pass.
    ///
    /// The filter chain comes from [`super::loudness`], so this profile and the
    /// rendered-file QC measurement agree by construction. Momentary readings
    /// drive the per-second profile and BPM estimation; the summary block
    /// supplies the program-level numbers.
    async fn extract_loudness_and_peak(
        &self,
        video_path: &Path,
    ) -> CoreResult<LoudnessMeasurement> {
        let capture = self
            .run_ffmpeg_filter(video_path, &loudness_filter_chain())
            .await?;
        measure_loudness(&capture.stderr)
    }

    // =========================================================================
    // Spectral Centroid
    // =========================================================================

    /// Extracts the average spectral centroid frequency in Hz.
    ///
    /// Uses FFmpeg's `aspectralstats` filter to compute per-frame spectral
    /// centroids and averages them. Returns 0.0 gracefully if the filter is
    /// unavailable in the current FFmpeg build.
    async fn extract_spectral_centroid(&self, video_path: &Path) -> CoreResult<f64> {
        let filter =
            "aspectralstats=measure=centroid,ametadata=mode=print:key=lavfi.aspectralstats.1.centroid";

        match self.run_ffmpeg_filter(video_path, filter).await {
            Ok(capture) => Ok(parse_spectral_centroid(&capture.stderr)),
            Err(err) => {
                let msg = err.to_string();
                // Only swallow explicit missing-filter errors; other failures propagate.
                if msg.contains("No such filter") || msg.contains("Unknown filter") {
                    tracing::debug!("aspectralstats filter unavailable, returning 0.0 Hz");
                    Ok(0.0)
                } else {
                    Err(err)
                }
            }
        }
    }

    // =========================================================================
    // BPM Estimation (Pure Function)
    // =========================================================================

    /// Estimates beats per minute from a per-second loudness profile.
    ///
    /// Detects local peaks in the loudness data (values exceeding both
    /// neighbors by more than [`PEAK_THRESHOLD_DB`]) and computes the
    /// median inter-onset interval. Returns `None` if fewer than
    /// [`MIN_PEAKS_FOR_BPM`] peaks are detected. The result is clamped
    /// to the 30-300 BPM range.
    pub fn estimate_bpm(loudness_profile: &[f64]) -> Option<f64> {
        Self::estimate_bpm_from_samples(loudness_profile, 1.0)
    }

    /// Estimates beats per minute from a sampled loudness series.
    fn estimate_bpm_from_samples(loudness_samples: &[f64], samples_per_second: f64) -> Option<f64> {
        if loudness_samples.len() < 3
            || samples_per_second <= 0.0
            || !samples_per_second.is_finite()
        {
            return None;
        }

        // Find local peak indices
        let mut peak_indices: Vec<usize> = Vec::new();
        for i in 1..loudness_samples.len() - 1 {
            let current = loudness_samples[i];
            let prev = loudness_samples[i - 1];
            let next = loudness_samples[i + 1];

            if current - prev > PEAK_THRESHOLD_DB && current - next > PEAK_THRESHOLD_DB {
                peak_indices.push(i);
            }
        }

        if peak_indices.len() < MIN_PEAKS_FOR_BPM {
            return None;
        }

        // Calculate inter-onset intervals in seconds from sample indices.
        let mut ioi: Vec<f64> = Vec::with_capacity(peak_indices.len() - 1);
        for pair in peak_indices.windows(2) {
            ioi.push((pair[1] - pair[0]) as f64 / samples_per_second);
        }

        if ioi.is_empty() {
            return None;
        }

        // Sort for median calculation
        ioi.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median_ioi = ioi[ioi.len() / 2];

        if median_ioi <= 0.0 {
            return None;
        }

        let bpm = 60.0 / median_ioi;
        Some(bpm.clamp(MIN_BPM, MAX_BPM))
    }

    // =========================================================================
    // FFmpeg Helper
    // =========================================================================

    /// Runs FFmpeg with the given audio filter and returns the whole capture.
    ///
    /// Delegates spawning, bounded stderr retention, and the watchdog timeout to
    /// [`capture_filter_stderr`]; only the audio-specific interpretation of the
    /// result (missing audio stream vs. genuine failure) lives here.
    ///
    /// The [`FilterCapture`] is returned rather than just its text so the
    /// truncation flag is not silently dropped: per-frame filters such as
    /// `aspectralstats` overflow the retention limit on very long inputs, and a
    /// parser fed the surviving tail would average only the end of the file.
    /// Truncation is logged here — the audio profile has no warnings channel to
    /// carry it — so an unexpectedly flat measurement is at least traceable.
    ///
    /// [`FilterCapture`]: crate::core::ffmpeg::FilterCapture
    async fn run_ffmpeg_filter(
        &self,
        video_path: &Path,
        filter: &str,
    ) -> CoreResult<crate::core::ffmpeg::FilterCapture> {
        let capture = capture_filter_stderr(
            &self.ffmpeg_path,
            video_path,
            FilterMode::Audio(filter),
            ANALYSIS_TIMEOUT,
        )
        .await
        .map_err(|error| match error {
            FFmpegError::Timeout => CoreError::Internal(format!(
                "Audio analysis timed out after {}s",
                ANALYSIS_TIMEOUT.as_secs()
            )),
            other => CoreError::Internal(format!("Failed to run FFmpeg: {}", other)),
        })?;

        // Check for no-audio-stream condition before checking exit status,
        // because FFmpeg may exit non-zero when there is no audio stream.
        if has_no_audio_indicator(&capture.stderr) {
            return Err(CoreError::Internal(
                "No audio stream found in input".to_string(),
            ));
        }

        if !capture.success {
            return Err(CoreError::Internal(format!(
                "Audio analysis failed (exit {}): {}",
                capture.exit_code.unwrap_or(-1),
                capture.stderr_tail(STDERR_TAIL_SIZE)
            )));
        }

        if capture.truncated {
            tracing::warn!(
                filter = %filter,
                input = %video_path.display(),
                "FFmpeg filter output exceeded the stderr retention limit; \
                 the parsed result covers only the end of the input"
            );
        }

        Ok(capture)
    }
}

// =============================================================================
// Parsing Helpers (testable without FFmpeg)
// =============================================================================

/// Checks whether an FFmpeg error indicates no audio stream in the input.
fn has_no_audio_indicator(stderr: &str) -> bool {
    stderr.contains("does not contain any stream")
        || stderr.contains("Output file does not contain any stream")
        || (stderr.contains("no audio") && stderr.contains("stream"))
}

/// Returns `true` if the result is an error indicating no audio stream.
fn is_no_audio_error<T>(result: &Result<T, CoreError>) -> bool {
    match result {
        Err(CoreError::Internal(msg)) => {
            msg.contains("No audio stream found") || msg.contains("does not contain any stream")
        }
        _ => false,
    }
}

fn map_audio_extraction_error(
    error: crate::core::captions::audio::AudioExtractionError,
) -> CoreError {
    let message = error.to_string();
    if has_no_audio_indicator(&message) {
        CoreError::Internal("No audio stream found in input".to_string())
    } else {
        CoreError::AnalysisFailed(format!("Speech VAD audio extraction failed: {}", message))
    }
}

fn detect_speech_regions_from_pcm(
    samples: &[i16],
    duration_sec: f64,
) -> CoreResult<Vec<SpeechRegion>> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let mut vad = Vad::new_with_rate_and_mode(VadSampleRate::Rate16kHz, VadMode::LowBitrate);
    let mut voiced_frames = Vec::with_capacity(samples.len() / VAD_FRAME_SAMPLES);

    for frame in samples.chunks(VAD_FRAME_SAMPLES) {
        if frame.len() != VAD_FRAME_SAMPLES {
            break;
        }

        let is_voiced = vad.is_voice_segment(frame).map_err(|_| {
            CoreError::AnalysisFailed("Speech VAD received an invalid frame length".to_string())
        })?;
        voiced_frames.push(is_voiced);
    }

    Ok(speech_regions_from_voiced_flags(
        &voiced_frames,
        duration_sec,
        VAD_FRAME_MS as f64 / 1000.0,
    ))
}

fn speech_regions_from_voiced_flags(
    voiced_frames: &[bool],
    duration_sec: f64,
    frame_duration_sec: f64,
) -> Vec<SpeechRegion> {
    if voiced_frames.is_empty() || duration_sec <= 0.0 || frame_duration_sec <= 0.0 {
        return Vec::new();
    }

    let mut regions = Vec::new();
    let mut active_start: Option<usize> = None;

    for (index, is_voiced) in voiced_frames.iter().copied().enumerate() {
        match (active_start, is_voiced) {
            (None, true) => active_start = Some(index),
            (Some(start_index), false) => {
                regions.push(SpeechRegion::new(
                    start_index as f64 * frame_duration_sec,
                    index as f64 * frame_duration_sec,
                ));
                active_start = None;
            }
            _ => {}
        }
    }

    if let Some(start_index) = active_start {
        regions.push(SpeechRegion::new(
            start_index as f64 * frame_duration_sec,
            voiced_frames.len() as f64 * frame_duration_sec,
        ));
    }

    let mut merged: Vec<SpeechRegion> = Vec::new();
    for region in regions {
        let start_sec = region.start_sec.clamp(0.0, duration_sec);
        let end_sec = region.end_sec.clamp(start_sec, duration_sec);
        if end_sec <= start_sec {
            continue;
        }

        let region = SpeechRegion::new(start_sec, end_sec);
        if let Some(last) = merged.last_mut() {
            if region.start_sec <= last.end_sec + VAD_MAX_GAP_SEC {
                last.end_sec = last.end_sec.max(region.end_sec);
                continue;
            }
        }
        merged.push(region);
    }

    merged
        .into_iter()
        .filter(|region| region.duration() >= VAD_MIN_SPEECH_SEC)
        .collect()
}

fn derive_speech_regions_from_silence(
    silence_regions: &[SilenceRegion],
    duration_sec: f64,
) -> Vec<SpeechRegion> {
    invert_silence_to_speech(silence_regions, duration_sec)
        .into_iter()
        .map(|region| SpeechRegion::new(region.start_sec, region.end_sec))
        .collect()
}

/// Parses silence regions from FFmpeg `silencedetect` filter stderr output.
///
/// Expects lines in the form:
/// ```text
/// [silencedetect @ ...] silence_start: 1.234
/// [silencedetect @ ...] silence_end: 5.678 | silence_duration: 4.444
/// ```
pub(crate) fn parse_silence_regions(stderr: &str) -> Vec<SilenceRegion> {
    let mut regions = Vec::new();
    let mut current_start: Option<f64> = None;

    for line in stderr.lines() {
        if let Some(start_val) = extract_silence_start(line) {
            current_start = Some(start_val);
        } else if let Some(end_val) = extract_silence_end(line) {
            if let Some(start) = current_start.take() {
                regions.push(SilenceRegion::new(start, end_val));
            }
        }
    }

    regions
}

/// Extracts the time value from a `silence_start:` line.
fn extract_silence_start(line: &str) -> Option<f64> {
    if !line.contains("silence_start:") {
        return None;
    }
    let marker = "silence_start:";
    let pos = line.find(marker)?;
    let rest = line[pos + marker.len()..].trim();
    // Take characters until whitespace or end of string
    let num_str: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
    num_str.parse::<f64>().ok()
}

/// Extracts the time value from a `silence_end:` line.
fn extract_silence_end(line: &str) -> Option<f64> {
    if !line.contains("silence_end:") {
        return None;
    }
    let marker = "silence_end:";
    let pos = line.find(marker)?;
    let rest = line[pos + marker.len()..].trim();
    let num_str: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
    num_str.parse::<f64>().ok()
}

/// Everything the loudness pass measured for one asset.
///
/// Kept as a struct rather than a tuple because the pass now yields both
/// per-window readings (profile, BPM) and program-level values (integrated
/// loudness, true peak) that callers pick from independently.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct LoudnessMeasurement {
    /// Per-second average of the momentary readings, in LUFS.
    pub loudness_profile: Vec<f64>,
    /// Raw momentary readings at roughly 10 Hz, in LUFS.
    pub momentary_lufs: Vec<f64>,
    /// Integrated program loudness in LUFS, when the summary reported one.
    pub integrated_lufs: Option<f64>,
    /// Loudness range in LU, when the summary reported one.
    pub loudness_range_lu: Option<f64>,
    /// True peak in dBTP, when the FFmpeg build measured one.
    pub true_peak_dbtp: Option<f64>,
    /// Sample peak in dBFS reported by `astats`.
    pub sample_peak_db: Option<f64>,
}

impl LoudnessMeasurement {
    /// Returns the peak level to report, in dB relative to full scale.
    ///
    /// True peak is preferred because it accounts for inter-sample overs; the
    /// `astats` sample peak stands in on builds without true-peak support. The
    /// measured value is reported as measured — a quiet master really can peak
    /// below the silence floor, and clamping it would invent a level the file
    /// does not have. The floor is reached only when both fields are empty,
    /// which for a completed pass means the input was digital silence:
    /// [`measure_loudness`] rejects a pass that measured nothing at all.
    pub fn peak_db(&self) -> f64 {
        self.true_peak_dbtp
            .or(self.sample_peak_db)
            .unwrap_or(SILENCE_FLOOR_DB)
    }
}

/// Number of stderr lines quoted when a measurement pass parsed nothing.
const EMPTY_MEASUREMENT_STDERR_LINES: usize = 3;

/// Turns one `ebur128,astats` filter log into a [`LoudnessMeasurement`].
///
/// Pure over the captured stderr so it is testable without invoking FFmpeg.
///
/// # Errors
///
/// Returns [`CoreError::AnalysisFailed`] when the pass exited successfully but
/// the log carries no momentary readings, no integrated loudness and no peak.
/// A pass that measured *nothing* is a broken pass, not a silent file: even
/// digital silence produces frame lines at the meter's floor. Reporting it as
/// silence is how the `metadata=1` regression stayed invisible for so long, so
/// the numbers a caller cannot trust are refused instead of published.
pub(crate) fn measure_loudness(stderr: &str) -> CoreResult<LoudnessMeasurement> {
    let momentary_lufs = parse_momentary_loudness(stderr);
    let loudness_profile =
        per_second_loudness_profile(&momentary_lufs, LOUDNESS_SAMPLES_PER_SECOND as usize);
    let summary = parse_loudness_summary(stderr);
    let astats = parse_astats_overall(stderr);

    if momentary_lufs.is_empty()
        && summary.integrated_lufs.is_none()
        && astats.sample_peak_db.is_none()
    {
        return Err(CoreError::AnalysisFailed(format!(
            "The `{}` pass completed but measured nothing: no momentary readings, \
             no integrated loudness and no peak. First stderr lines: {}",
            loudness_filter_chain(),
            first_stderr_lines(stderr, EMPTY_MEASUREMENT_STDERR_LINES),
        )));
    }

    Ok(LoudnessMeasurement {
        loudness_profile,
        momentary_lufs,
        integrated_lufs: summary.integrated_lufs,
        loudness_range_lu: summary.loudness_range_lu,
        true_peak_dbtp: summary.true_peak_dbtp,
        sample_peak_db: astats.sample_peak_db,
    })
}

/// Joins the first `limit` non-empty stderr lines into one diagnostic string.
fn first_stderr_lines(stderr: &str, limit: usize) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(limit)
        .collect();

    if lines.is_empty() {
        "<no stderr output>".to_string()
    } else {
        lines.join(" | ")
    }
}

/// Parses spectral centroid values from FFmpeg `aspectralstats` / `ametadata`
/// filter stderr and returns the average in Hz.
///
/// Looks for lines matching:
/// ```text
/// lavfi.aspectralstats.1.centroid=1234.56
/// ```
fn parse_spectral_centroid(stderr: &str) -> f64 {
    let mut values: Vec<f64> = Vec::new();
    let marker = "lavfi.aspectralstats.1.centroid=";

    for line in stderr.lines() {
        if let Some(pos) = line.find(marker) {
            let rest = &line[pos + marker.len()..];
            let num_str: String = rest
                .chars()
                .take_while(|c| *c == '-' || *c == '.' || c.is_ascii_digit())
                .collect();
            if let Ok(val) = num_str.parse::<f64>() {
                if val.is_finite() && val >= 0.0 {
                    values.push(val);
                }
            }
        }
    }

    if values.is_empty() {
        return 0.0;
    }

    values.iter().sum::<f64>() / values.len() as f64
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // BPM Estimation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_detect_bpm_when_music_present() {
        // Build a loudness profile with regular peaks at 0.5s intervals (120 BPM).
        // Since loudness_profile is per-second, peaks every 0.5s means
        // two peaks per second. We simulate this by creating peaks at
        // alternating seconds: peak at even indices, valley at odd.
        // But estimate_bpm works at per-second granularity, so we space
        // peaks 1 second apart → 60 BPM or 2 seconds apart → 30 BPM.
        //
        // For 120 BPM we need peaks every 0.5s, but since our resolution
        // is 1 second, we cannot represent 120 BPM directly. Instead,
        // we test with peaks every 1 second → 60 BPM.
        let mut loudness: Vec<f64> = Vec::new();
        // Create 20 seconds of data with peaks every 1 second
        for _ in 0..20 {
            loudness.push(-10.0); // peak
        }

        // That gives all peaks — no valleys. Let's do alternating instead:
        // peak, valley, peak, valley, ...
        loudness.clear();
        for i in 0..20 {
            if i % 2 == 0 {
                loudness.push(-10.0); // peak
            } else {
                loudness.push(-25.0); // valley
            }
        }

        let bpm = AudioProfiler::estimate_bpm(&loudness);
        assert!(bpm.is_some(), "BPM should be detected");
        let bpm_val = bpm.unwrap();
        // Peaks at indices 0,2,4,6,8,10,12,14,16,18 → IOI = 2s → BPM = 30
        assert!(
            (bpm_val - 30.0).abs() < 1.0,
            "Expected ~30 BPM, got {}",
            bpm_val
        );
    }

    #[test]
    fn should_detect_bpm_from_evenly_spaced_peaks() {
        // Place peaks at indices 5, 7, 9, 11, 13 (2-second intervals → 30 BPM).
        // Each peak must exceed BOTH neighbors by > PEAK_THRESHOLD_DB (3.0 dB),
        // so valleys at -30.0 and peaks at -5.0 give a 25 dB difference.
        let mut loudness = vec![-30.0; 20];
        for &idx in &[5, 7, 9, 11, 13] {
            loudness[idx] = -5.0;
        }

        let bpm = AudioProfiler::estimate_bpm(&loudness);
        assert!(bpm.is_some());
        let bpm_val = bpm.unwrap();
        assert!(
            (bpm_val - 30.0).abs() < 1.0,
            "Expected ~30 BPM, got {}",
            bpm_val
        );
    }

    #[test]
    fn should_detect_120_bpm_from_half_second_loudness_samples() {
        let mut loudness = vec![-30.0; 40];
        for &idx in &[5, 10, 15, 20, 25, 30, 35] {
            loudness[idx] = -5.0;
        }

        let bpm = AudioProfiler::estimate_bpm_from_samples(&loudness, LOUDNESS_SAMPLES_PER_SECOND);
        assert!(bpm.is_some());
        assert!((bpm.unwrap() - 120.0).abs() < 1.0);
    }

    #[test]
    fn should_return_none_bpm_when_insufficient_peaks() {
        // Flat loudness profile — no peaks
        let loudness = vec![-20.0; 30];
        let bpm = AudioProfiler::estimate_bpm(&loudness);
        assert!(bpm.is_none(), "BPM should be None for flat profile");
    }

    #[test]
    fn should_return_none_bpm_when_profile_too_short() {
        let loudness = vec![-20.0, -15.0];
        let bpm = AudioProfiler::estimate_bpm(&loudness);
        assert!(bpm.is_none(), "BPM should be None for < 3 samples");
    }

    #[test]
    fn should_clamp_bpm_to_valid_range() {
        // Create peaks very close together → very high BPM → should clamp to 300
        // This is hard with integer indices; minimum IOI = 1 → 60 BPM.
        // Instead verify clamping logic directly via edge case:
        // all adjacent samples are peaks, IOI = 1, BPM = 60 (within range)
        let mut loudness = Vec::new();
        for i in 0..20 {
            loudness.push(if i % 2 == 0 { -5.0 } else { -30.0 });
        }
        let bpm = AudioProfiler::estimate_bpm(&loudness);
        if let Some(val) = bpm {
            assert!(
                (MIN_BPM..=MAX_BPM).contains(&val),
                "BPM {} out of range",
                val
            );
        }
    }

    // -------------------------------------------------------------------------
    // Silence Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_parse_silence_regions_from_ffmpeg_output() {
        let ffmpeg_stderr = r#"
[silencedetect @ 0x55f1234] silence_start: 0.000000
[silencedetect @ 0x55f1234] silence_end: 1.500000 | silence_duration: 1.500000
[silencedetect @ 0x55f1234] silence_start: 5.200000
[silencedetect @ 0x55f1234] silence_end: 7.800000 | silence_duration: 2.600000
[silencedetect @ 0x55f1234] silence_start: 12.100000
[silencedetect @ 0x55f1234] silence_end: 14.300000 | silence_duration: 2.200000
size=N/A time=00:00:20.00 bitrate=N/A speed=50.0x
"#;

        let regions = parse_silence_regions(ffmpeg_stderr);
        assert_eq!(regions.len(), 3, "Should detect 3 silence regions");

        assert!((regions[0].start_sec - 0.0).abs() < 0.001);
        assert!((regions[0].end_sec - 1.5).abs() < 0.001);

        assert!((regions[1].start_sec - 5.2).abs() < 0.001);
        assert!((regions[1].end_sec - 7.8).abs() < 0.001);

        assert!((regions[2].start_sec - 12.1).abs() < 0.001);
        assert!((regions[2].end_sec - 14.3).abs() < 0.001);
    }

    #[test]
    fn should_handle_unpaired_silence_start() {
        // silence_start without a matching silence_end should be ignored
        let ffmpeg_stderr = r#"
[silencedetect @ 0x55f1234] silence_start: 0.000000
[silencedetect @ 0x55f1234] silence_end: 1.500000 | silence_duration: 1.500000
[silencedetect @ 0x55f1234] silence_start: 5.200000
"#;

        let regions = parse_silence_regions(ffmpeg_stderr);
        assert_eq!(regions.len(), 1, "Unpaired start should not produce region");
    }

    #[test]
    fn should_handle_empty_silence_output() {
        let regions = parse_silence_regions("");
        assert!(regions.is_empty());
    }

    // -------------------------------------------------------------------------
    // Loudness Parsing Tests
    // -------------------------------------------------------------------------

    /// One second of `ebur128` frame lines at a steady level, as the shared
    /// chain prints them (`peak=true:framelog=info`).
    fn ebur128_frames(level_lufs: f64, count: usize) -> String {
        (0..count)
            .map(|index| {
                format!(
                    "[Parsed_ebur128_0 @ 0x1] t: {:.6}   TARGET:-23 LUFS    M: {:.1} \
                     S: {:.1}     I: {:.1} LUFS       LRA:   0.0 LU  \
                     FTPK: -6.0 -6.0 dBFS  TPK: -6.0 -6.0 dBFS",
                    index as f64 / 10.0,
                    level_lufs,
                    level_lufs,
                    level_lufs,
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The summary block ends every measurement pass.
    fn ebur128_summary(integrated_lufs: f64, true_peak_dbtp: f64) -> String {
        format!(
            "[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    \
             I:  {integrated_lufs:.1} LUFS\n    Threshold: -30.0 LUFS\n\n  \
             Loudness range:\n    LRA:  0.0 LU\n\n  True peak:\n    \
             Peak:  {true_peak_dbtp:.1} dBFS"
        )
    }

    #[test]
    fn should_measure_loudness_and_peak_from_a_full_filter_log() {
        let log = format!(
            "{}\n{}\n[Parsed_astats_1 @ 0x1] Peak level dB: -6.020600",
            ebur128_frames(-6.7, 20),
            ebur128_summary(-6.7, -6.0),
        );

        let measurement = measure_loudness(&log).expect("a full log must measure");

        assert_eq!(
            measurement.loudness_profile.len(),
            2,
            "20 readings at 10/sec is 2 seconds"
        );
        assert!((measurement.loudness_profile[0] - (-6.7)).abs() < 0.05);
        assert_eq!(measurement.integrated_lufs, Some(-6.7));
        assert_eq!(measurement.true_peak_dbtp, Some(-6.0));
        assert_eq!(measurement.sample_peak_db, Some(-6.0206));
        assert!((measurement.peak_db() - (-6.0)).abs() < 0.01);
    }

    /// Feature: audio profile peak reporting
    /// Scenario: the FFmpeg build measures no true peak
    ///   Given a filter log whose summary omits the true-peak section
    ///   When the loudness pass is parsed
    ///   Then the reported peak is the `astats` sample peak
    #[test]
    fn should_fall_back_to_the_sample_peak_when_true_peak_is_unavailable() {
        let log = "\
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:  -16.4 LUFS

  Loudness range:
    LRA:  5.0 LU
[Parsed_astats_1 @ 0x1] Peak level dB: -1.900000";

        let measurement = measure_loudness(log).expect("a summary with a peak must measure");

        assert_eq!(measurement.true_peak_dbtp, None);
        assert!((measurement.peak_db() - (-1.9)).abs() < 0.01);
    }

    /// Feature: audio loudness measurement
    /// Scenario: the filter pass runs but its output carries no measurement
    ///   Given a capture with no frame lines, no summary and no astats block
    ///   When the loudness pass is parsed
    ///   Then it fails, naming the filter and quoting the start of the log
    ///
    /// The old behaviour folded this into `-90 dB` and reported it as a
    /// successful measurement of silence, which is how a pass that measured
    /// nothing shipped as a number users acted on.
    #[test]
    fn should_fail_when_a_successful_pass_measured_nothing() {
        let error = measure_loudness("Stream #0:0: Audio: aac\nno relevant data here")
            .expect_err("a pass that measured nothing must not report silence");

        let message = error.to_string();
        assert!(
            message.contains("ebur128"),
            "the error must name the filter: {message}"
        );
        assert!(
            message.contains("Stream #0:0"),
            "the error must quote the start of the log: {message}"
        );
    }

    /// Feature: audio loudness measurement
    /// Scenario: the input really is digital silence
    ///   Given frame lines at the meter's silence sentinel and an astats peak
    ///   When the loudness pass is parsed
    ///   Then it succeeds with a floor-level profile
    #[test]
    fn should_measure_digital_silence_rather_than_rejecting_it() {
        let log = "\
[Parsed_ebur128_0 @ 0x1] t: 0.4 TARGET:-23 LUFS M:-120.7 S:-120.7
[Parsed_ebur128_0 @ 0x1] t: 0.5 TARGET:-23 LUFS M:-120.7 S:-120.7";

        let measurement = measure_loudness(log).expect("digital silence is a measurement");

        assert_eq!(measurement.momentary_lufs.len(), 2);
        assert_eq!(measurement.loudness_profile, vec![SILENCE_FLOOR_DB]);
        assert_eq!(measurement.peak_db(), SILENCE_FLOOR_DB);
    }

    /// Feature: audio profile peak reporting
    /// Scenario: a very quiet master peaks below the silence floor
    ///   Given an astats peak of -95 dBFS
    ///   When the peak is reported
    ///   Then the measured value survives instead of being clamped
    #[test]
    fn should_report_a_measured_peak_below_the_silence_floor_as_measured() {
        let log = "\
[Parsed_ebur128_0 @ 0x1] t: 0.4 TARGET:-23 LUFS M: -96.0 S: -96.0
[Parsed_astats_1 @ 0x1] Peak level dB: -95.000000";

        let measurement = measure_loudness(log).expect("a measured peak is a measurement");

        assert!((measurement.peak_db() - (-95.0)).abs() < 0.01);
    }

    /// Feature: audio profile loudness measurement
    /// Scenario: a real talk is profiled
    ///   Given a filter log carrying readings around -16 LUFS
    ///   When the loudness pass is parsed
    ///   Then the profile is populated instead of collapsing to the floor
    ///
    /// This is the regression: `ebur128=metadata=1` demoted its per-frame log
    /// to VERBOSE, so a 14-minute talk reported `peakDb: -90` with zero
    /// loudness samples while `verify --file` measured -16.6 LUFS / -1.9 dBTP.
    #[test]
    fn should_not_collapse_to_the_silence_floor_for_audible_content() {
        let log = format!(
            "{}\n{}\n[Parsed_astats_1 @ 0x1] Peak level dB: -1.900000",
            ebur128_frames(-16.4, 30),
            ebur128_summary(-16.4, -1.9),
        );

        let measurement = measure_loudness(&log).expect("audible content must measure");

        assert!(
            !measurement.loudness_profile.is_empty(),
            "loudnessSampleCount must not be zero for audible content"
        );
        assert!(measurement.peak_db() > SILENCE_FLOOR_DB + 1.0);
        assert!((measurement.integrated_lufs.unwrap_or_default() - (-16.4)).abs() < 0.05);
    }

    // -------------------------------------------------------------------------
    // Spectral Centroid Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_parse_spectral_centroid_from_ffmpeg_output() {
        let stderr = r#"
frame:0    pts:0       pts_time:0
lavfi.aspectralstats.1.centroid=2500.0
frame:1    pts:1024    pts_time:0.023
lavfi.aspectralstats.1.centroid=3000.0
frame:2    pts:2048    pts_time:0.046
lavfi.aspectralstats.1.centroid=2800.0
"#;

        let centroid = parse_spectral_centroid(stderr);
        let expected = (2500.0 + 3000.0 + 2800.0) / 3.0;
        assert!(
            (centroid - expected).abs() < 0.1,
            "Expected centroid ~{}, got {}",
            expected,
            centroid
        );
    }

    #[test]
    fn should_return_zero_centroid_when_no_data() {
        let centroid = parse_spectral_centroid("no spectral data here");
        assert_eq!(centroid, 0.0);
    }

    #[test]
    fn should_ignore_negative_centroid_values() {
        let stderr =
            "lavfi.aspectralstats.1.centroid=-100.0\nlavfi.aspectralstats.1.centroid=2000.0\n";
        let centroid = parse_spectral_centroid(stderr);
        // Only the positive value should be included
        assert!((centroid - 2000.0).abs() < 0.1);
    }

    // -------------------------------------------------------------------------
    // Silent Profile Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_return_silent_profile_when_no_audio() {
        let profile = AudioProfile::silent(10.0);

        assert!(profile.bpm.is_none());
        assert_eq!(profile.spectral_centroid_hz, 0.0);
        assert!(profile.loudness_profile.is_empty());
        assert_eq!(profile.peak_db, SILENCE_FLOOR_DB);
        assert_eq!(profile.silence_regions.len(), 1);
        assert_eq!(profile.silence_regions[0].start_sec, 0.0);
        assert_eq!(profile.silence_regions[0].end_sec, 10.0);
        assert!(profile.speech_regions.is_empty());
    }

    #[test]
    fn should_return_empty_silent_profile_for_zero_duration() {
        let profile = AudioProfile::silent(0.0);
        assert!(profile.silence_regions.is_empty());
        assert!(profile.speech_regions.is_empty());
    }

    #[test]
    fn should_derive_speech_regions_from_silence_regions() {
        let silence = vec![SilenceRegion::new(1.0, 2.0), SilenceRegion::new(4.0, 5.0)];

        let speech = derive_speech_regions_from_silence(&silence, 6.0);

        assert_eq!(speech.len(), 3);
        assert_eq!(speech[0], SpeechRegion::new(0.0, 1.0));
        assert_eq!(speech[1], SpeechRegion::new(2.0, 4.0));
        assert_eq!(speech[2], SpeechRegion::new(5.0, 6.0));
    }

    #[test]
    fn should_merge_short_unvoiced_gaps_between_voiced_frames() {
        let voiced_frames = vec![true, true, false, false, true, true];

        let speech = speech_regions_from_voiced_flags(&voiced_frames, 0.18, 0.03);

        assert_eq!(speech.len(), 1);
        assert!((speech[0].start_sec - 0.0).abs() < f64::EPSILON);
        assert!((speech[0].end_sec - 0.18).abs() < 1e-6);
    }

    #[test]
    fn should_filter_short_voiced_blips_from_vad_regions() {
        let voiced_frames = vec![false, true, false, false];

        let speech = speech_regions_from_voiced_flags(&voiced_frames, 0.12, 0.03);

        assert!(speech.is_empty());
    }

    // -------------------------------------------------------------------------
    // No-Audio Detection Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_detect_no_audio_stream_indicator() {
        assert!(has_no_audio_indicator(
            "Output file does not contain any stream"
        ));
        assert!(has_no_audio_indicator(
            "Error: file does not contain any stream matching the input"
        ));
        assert!(!has_no_audio_indicator("Normal processing output"));
    }

    #[test]
    fn should_detect_no_audio_error_in_result() {
        let err: Result<Vec<SilenceRegion>, CoreError> = Err(CoreError::Internal(
            "No audio stream found in input".to_string(),
        ));
        assert!(is_no_audio_error(&err));

        let ok: Result<Vec<SilenceRegion>, CoreError> = Ok(vec![]);
        assert!(!is_no_audio_error(&ok));
    }

    // -------------------------------------------------------------------------
    // Edge Case Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_handle_silence_with_extra_whitespace() {
        let stderr = "[silencedetect @ 0x1] silence_start:   2.500  \n[silencedetect @ 0x1] silence_end:  4.000 | silence_duration: 1.500\n";
        let regions = parse_silence_regions(stderr);
        assert_eq!(regions.len(), 1);
        assert!((regions[0].start_sec - 2.5).abs() < 0.001);
        assert!((regions[0].end_sec - 4.0).abs() < 0.001);
    }

    /// Feature: audio profile measurement versioning
    /// Scenario: a profile is produced by the current measurement
    ///   Given a freshly constructed profile
    ///   When its measurement version is read
    ///   Then it carries the current version, so the loader will not drop it
    #[test]
    fn should_stamp_a_freshly_measured_profile_with_the_current_version() {
        let profile = AudioProfile::silent(10.0);

        assert_eq!(profile.measurement_version, AUDIO_MEASUREMENT_VERSION);
    }

    // -------------------------------------------------------------------------
    // FFmpeg-backed measurement
    //
    // These drive a real FFmpeg over a signal whose level is known exactly, so
    // what they assert is the number a user would see rather than the number a
    // hand-written log says. They are `#[ignore]`d because the binary may be
    // missing, and every one starts at `require_or_skip_ffmpeg`, which fails
    // instead of skipping when `REQUIRE_FFMPEG_TESTS` says the run was supposed
    // to have one.
    // -------------------------------------------------------------------------

    use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

    /// Peak level of the synthesized tone, in dBFS.
    const FIXTURE_PEAK_DBFS: f64 = -6.0;

    /// Expected integrated loudness of the stereo fixture, in LUFS.
    ///
    /// A sine of amplitude `A` has mean square `A^2 / 2`, so a -6 dBFS tone
    /// carries `0.5012^2 / 2 = 0.1256` per channel. R128 sums the two
    /// unity-weighted channels and applies its -0.691 LU offset:
    /// `-0.691 + 10 * log10(2 * 0.1256) = -6.7 LUFS`. K-weighting sits within a
    /// few tenths of a dB of unity at 440 Hz, which the tolerance absorbs.
    const FIXTURE_STEREO_LUFS: f64 = -6.7;

    /// Cost of folding a correlated stereo pair to one channel, in LU.
    ///
    /// R128 sums channel powers before taking the logarithm, so the downmix
    /// measures exactly `10 * log10(2)` lower even though it sounds identical.
    /// "The same LUFS" is the wrong expectation for a mono downmix.
    const MONO_DOWNMIX_PENALTY_LU: f64 = 3.01;

    /// Length of the synthesized fixtures, in seconds.
    const FIXTURE_DURATION_SEC: f64 = 4.0;

    /// Tolerance on a measured peak, in dB.
    const PEAK_TOLERANCE_DB: f64 = 0.5;

    /// Tolerance on a measured integrated loudness, in LU.
    const LOUDNESS_TOLERANCE_LU: f64 = 1.0;

    /// Tolerance on the stereo-to-mono loudness relationship, in LU.
    ///
    /// Tighter than [`LOUDNESS_TOLERANCE_LU`] because both sides come from the
    /// same measurement of the same signal, so only the downmix itself can move
    /// the difference.
    const DOWNMIX_TOLERANCE_LU: f64 = 0.5;

    /// Amplitude of the synthesized tone, as a linear sample value.
    ///
    /// `10^(-6/20)`, spelled out so the fixture expression carries the exact
    /// number rather than depending on a filter's rounding.
    const FIXTURE_AMPLITUDE: &str = "0.501187";

    /// Writes a 440 Hz stereo sine at -6 dBFS, 48 kHz, to `path`.
    ///
    /// The tone is written by `aevalsrc` rather than the `sine` source because
    /// `sine` has no amplitude option and emits at a fixed level well below
    /// full scale (-21 dBFS on the bundled FFmpeg 9 build), which would make
    /// the expected loudness a property of the FFmpeg build instead of the
    /// signal. PCM in a WAV container for the same reason: a lossy encoder
    /// would move both the peak and the loudness unpredictably.
    ///
    /// Both channels carry the identical expression, so the pair is fully
    /// correlated and its expected loudness is computable.
    fn write_stereo_sine_fixture(ffmpeg: &Path, path: &Path) -> bool {
        let channel = format!("{FIXTURE_AMPLITUDE}*sin(2*PI*440*t)");
        let source =
            format!("aevalsrc=exprs={channel}|{channel}:s=48000:d={FIXTURE_DURATION_SEC}:c=stereo");

        run_ffmpeg(
            ffmpeg,
            &["-f", "lavfi", "-i", source.as_str(), "-c:a", "pcm_s16le"],
            path,
        )
    }

    /// Folds `source` to a single channel, leaving the level untouched.
    fn write_mono_downmix(ffmpeg: &Path, source: &Path, path: &Path) -> bool {
        let Some(source) = source.to_str() else {
            return false;
        };

        run_ffmpeg(
            ffmpeg,
            &["-i", source, "-ac", "1", "-c:a", "pcm_s16le"],
            path,
        )
    }

    /// Runs FFmpeg with the shared quiet flags and reports whether `path` was written.
    fn run_ffmpeg(ffmpeg: &Path, args: &[&str], path: &Path) -> bool {
        let mut command = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut command);
        command
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(args)
            .arg(path);

        matches!(command.status(), Ok(status) if status.success()) && path.exists()
    }

    /// Feature: asset audio loudness measurement
    /// Scenario: a tone of known level is profiled
    ///   Given a 440 Hz sine at -6 dBFS, stereo, 48 kHz
    ///   When the audio profiler measures it
    ///   Then the peak, the integrated loudness and the sample count all match
    ///   the synthesized signal
    ///
    /// This is the regression the shared measurement fixed: the old pass ran
    /// `ebur128=metadata=1`, which demotes the per-frame log to VERBOSE while
    /// the pass reads it at `-loglevel info`, so audible content came back as
    /// `peak_db: -90` with an empty loudness profile.
    #[tokio::test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    async fn should_measure_a_synthesized_tone_within_tolerance() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let fixture = dir.path().join("sine_stereo.wav");
        if !write_stereo_sine_fixture(&ffmpeg, &fixture) {
            skip_without_ffmpeg("ffmpeg could not synthesize the stereo sine fixture");
            return;
        }

        let profile = AudioProfiler::new(ffmpeg)
            .analyze(&fixture, FIXTURE_DURATION_SEC)
            .await
            .expect("the profiler must measure a decodable tone");

        assert!(
            !profile.loudness_profile.is_empty(),
            "loudnessSampleCount must be above zero for audible content"
        );
        assert_eq!(profile.measurement_version, AUDIO_MEASUREMENT_VERSION);
        assert!(
            (profile.peak_db - FIXTURE_PEAK_DBFS).abs() <= PEAK_TOLERANCE_DB,
            "peak {} dB is further than {PEAK_TOLERANCE_DB} dB from the synthesized \
             {FIXTURE_PEAK_DBFS} dBFS",
            profile.peak_db
        );

        let integrated = profile
            .integrated_lufs
            .expect("the summary block must report integrated loudness");
        assert!(
            (integrated - FIXTURE_STEREO_LUFS).abs() <= LOUDNESS_TOLERANCE_LU,
            "integrated loudness {integrated} LUFS is further than \
             {LOUDNESS_TOLERANCE_LU} LU from the expected {FIXTURE_STEREO_LUFS} LUFS"
        );
    }

    /// Feature: asset audio loudness measurement
    /// Scenario: the same tone is measured as stereo and as its mono downmix
    ///   Given a stereo fixture and a one-channel fold of it
    ///   When both are profiled
    ///   Then their peaks agree and their loudness differs only by the R128
    ///   channel-summation term
    ///
    /// The relationship is asserted rather than equality because equality is
    /// what a broken pass would satisfy: a measurement that reads nothing
    /// reports the silence floor for both files.
    #[tokio::test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    async fn should_track_the_signal_rather_than_the_channel_count() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let stereo_path = dir.path().join("sine_stereo.wav");
        let mono_path = dir.path().join("sine_mono.wav");
        if !write_stereo_sine_fixture(&ffmpeg, &stereo_path)
            || !write_mono_downmix(&ffmpeg, &stereo_path, &mono_path)
        {
            skip_without_ffmpeg("ffmpeg could not synthesize the sine fixtures");
            return;
        }

        let profiler = AudioProfiler::new(ffmpeg);
        let stereo = profiler
            .analyze(&stereo_path, FIXTURE_DURATION_SEC)
            .await
            .expect("the profiler must measure the stereo fixture");
        let mono = profiler
            .analyze(&mono_path, FIXTURE_DURATION_SEC)
            .await
            .expect("the profiler must measure the mono downmix");

        assert!(
            (stereo.peak_db - mono.peak_db).abs() <= PEAK_TOLERANCE_DB,
            "peak is a per-sample quantity and must survive the downmix: stereo {} dB \
             against mono {} dB",
            stereo.peak_db,
            mono.peak_db
        );

        let stereo_lufs = stereo
            .integrated_lufs
            .expect("the stereo summary must report integrated loudness");
        let mono_lufs = mono
            .integrated_lufs
            .expect("the mono summary must report integrated loudness");
        assert!(
            ((stereo_lufs - mono_lufs) - MONO_DOWNMIX_PENALTY_LU).abs() <= DOWNMIX_TOLERANCE_LU,
            "the downmix must sit {MONO_DOWNMIX_PENALTY_LU} LU below the stereo source: \
             stereo {stereo_lufs} LUFS against mono {mono_lufs} LUFS"
        );
    }
}
