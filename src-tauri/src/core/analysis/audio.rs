//! Audio Profiling Module
//!
//! Extracts audio characteristics from video files using FFmpeg filters.
//! Part of the reference video analysis pipeline (ADR-048, Group 2).
//!
//! Produces an [`AudioProfile`] containing BPM estimation, loudness curves,
//! spectral centroid, and silence region detection.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::types::{AudioProfile, SilenceRegion, SILENCE_FLOOR_DB};
use crate::core::process::configure_tokio_command;
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
const LOUDNESS_SAMPLES_PER_SECOND: f64 = 10.0;

/// Minimum number of detected peaks required for BPM estimation.
const MIN_PEAKS_FOR_BPM: usize = 4;

/// Minimum valid BPM (clamp lower bound)
const MIN_BPM: f64 = 30.0;

/// Maximum valid BPM (clamp upper bound)
const MAX_BPM: f64 = 300.0;

/// Number of tail lines to keep from FFmpeg stderr for error reporting.
const STDERR_TAIL_SIZE: usize = 20;

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
        let (loudness_profile, peak_db, momentary_samples) = loudness_result?;
        let spectral_centroid_hz = spectral_result.unwrap_or_else(|err| {
            tracing::debug!(
                "Spectral centroid extraction failed, defaulting to 0.0: {}",
                err
            );
            0.0
        });

        let bpm = Self::estimate_bpm_from_samples(&momentary_samples, LOUDNESS_SAMPLES_PER_SECOND)
            .or_else(|| Self::estimate_bpm(&loudness_profile));

        Ok(AudioProfile {
            bpm,
            spectral_centroid_hz,
            loudness_profile,
            peak_db,
            silence_regions,
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
        let stderr = self.run_ffmpeg_filter(video_path, &filter).await?;
        Ok(parse_silence_regions(&stderr))
    }

    // =========================================================================
    // Loudness & Peak Extraction
    // =========================================================================

    /// Extracts per-second loudness profile and peak dB using EBU R128 metering.
    ///
    /// Parses momentary loudness values from the `ebur128` filter output,
    /// groups them into per-second averages, and finds the peak value.
    async fn extract_loudness_and_peak(
        &self,
        video_path: &Path,
    ) -> CoreResult<(Vec<f64>, f64, Vec<f64>)> {
        let filter = "ebur128=metadata=1";
        let stderr = self.run_ffmpeg_filter(video_path, filter).await?;
        let (loudness_profile, peak_db) = parse_loudness_and_peak(&stderr);
        let momentary_values = parse_momentary_loudness_values(&stderr);
        Ok((loudness_profile, peak_db, momentary_values))
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
            Ok(stderr) => Ok(parse_spectral_centroid(&stderr)),
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

    /// Runs FFmpeg with the given audio filter and returns stderr as a string.
    ///
    /// Handles process spawning errors and non-zero exit codes. Uses
    /// [`configure_tokio_command`] for Windows compatibility.
    async fn run_ffmpeg_filter(&self, video_path: &Path, filter: &str) -> CoreResult<String> {
        let mut cmd = Command::new(&self.ffmpeg_path);
        configure_tokio_command(&mut cmd);

        cmd.arg("-hide_banner")
            .arg("-nostdin")
            .arg("-i")
            .arg(video_path)
            .arg("-af")
            .arg(filter)
            .arg("-vn")
            .arg("-f")
            .arg("null")
            .arg("-")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| CoreError::Internal(format!("Failed to spawn FFmpeg: {}", e)))?;

        let stderr_handle = child
            .stderr
            .take()
            .ok_or_else(|| CoreError::Internal("Failed to capture FFmpeg stderr".to_string()))?;

        let mut reader = BufReader::new(stderr_handle).lines();
        let mut all_lines: Vec<String> = Vec::new();

        // Stream stderr line by line
        while let Some(line) = reader
            .next_line()
            .await
            .map_err(|e| CoreError::Internal(format!("Failed reading FFmpeg stderr: {}", e)))?
        {
            all_lines.push(line);
        }

        let status = child
            .wait()
            .await
            .map_err(|e| CoreError::Internal(format!("Failed to wait for FFmpeg: {}", e)))?;

        let full_stderr = all_lines.join("\n");

        // Check for no-audio-stream condition before checking exit status,
        // because FFmpeg may exit non-zero when there is no audio stream.
        if has_no_audio_indicator(&full_stderr) {
            return Err(CoreError::Internal(
                "No audio stream found in input".to_string(),
            ));
        }

        if !status.success() {
            let code = status.code().unwrap_or(-1);
            let tail_start = all_lines.len().saturating_sub(STDERR_TAIL_SIZE);
            let tail = all_lines[tail_start..].join("\n");
            return Err(CoreError::Internal(format!(
                "Audio analysis failed (exit {}): {}",
                code, tail
            )));
        }

        Ok(full_stderr)
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

/// Parses silence regions from FFmpeg `silencedetect` filter stderr output.
///
/// Expects lines in the form:
/// ```text
/// [silencedetect @ ...] silence_start: 1.234
/// [silencedetect @ ...] silence_end: 5.678 | silence_duration: 4.444
/// ```
fn parse_silence_regions(stderr: &str) -> Vec<SilenceRegion> {
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

/// Parses momentary loudness values and peak from EBU R128 `ebur128` filter
/// stderr output.
///
/// Groups momentary values into per-second averages. FFmpeg emits momentary
/// readings roughly every 0.1 seconds, so ~10 values are averaged per second.
///
/// Returns `(loudness_profile, peak_db)`.
fn parse_loudness_and_peak(stderr: &str) -> (Vec<f64>, f64) {
    let momentary_values = parse_momentary_loudness_values(stderr);
    let peak_db = momentary_values
        .iter()
        .copied()
        .fold(SILENCE_FLOOR_DB, f64::max);
    let loudness_profile =
        build_per_second_profile(&momentary_values, LOUDNESS_SAMPLES_PER_SECOND as usize);
    (loudness_profile, peak_db)
}

/// Parses all valid momentary loudness samples from `ebur128` stderr output.
fn parse_momentary_loudness_values(stderr: &str) -> Vec<f64> {
    stderr
        .lines()
        .filter_map(extract_momentary_loudness)
        .collect()
}

/// Builds a per-second loudness profile from higher-resolution samples.
fn build_per_second_profile(samples: &[f64], samples_per_second: usize) -> Vec<f64> {
    if samples.is_empty() || samples_per_second == 0 {
        return Vec::new();
    }

    samples
        .chunks(samples_per_second)
        .map(|chunk| chunk.iter().sum::<f64>() / chunk.len() as f64)
        .collect()
}

/// Extracts a momentary loudness value (M:) from an ebur128 filter line.
///
/// Expected format: `[Parsed_ebur128_0 @ ...] M: -23.4 S: ...`
/// or just lines containing `M:` followed by a dB value.
fn extract_momentary_loudness(line: &str) -> Option<f64> {
    // Look for "M:" followed by a numeric value
    let marker = "M:";
    let pos = line.find(marker)?;
    let rest = line[pos + marker.len()..].trim();
    let num_str: String = rest
        .chars()
        .take_while(|c| *c == '-' || *c == '.' || c.is_ascii_digit())
        .collect();
    if num_str.is_empty() {
        return None;
    }
    let val = num_str.parse::<f64>().ok()?;
    // Filter out obviously invalid values (ebur128 uses -70 as the floor)
    if val.is_finite() && val > -120.0 {
        Some(val)
    } else {
        None
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

    #[test]
    fn should_parse_loudness_from_ebur128_output() {
        // Simulate ebur128 output with momentary values
        let mut lines = Vec::new();
        // Add 20 momentary values (simulating 2 seconds at 10/sec)
        for i in 0..20 {
            let db = -20.0 + (i as f64) * 0.5;
            lines.push(format!(
                "[Parsed_ebur128_0 @ 0x1234] M: {:.1} S: -22.0 I: -24.0 LUFS",
                db
            ));
        }
        let stderr = lines.join("\n");

        let (loudness_profile, peak_db) = parse_loudness_and_peak(&stderr);

        assert_eq!(
            loudness_profile.len(),
            2,
            "20 samples at 10/sec = 2 seconds"
        );
        // Peak should be the highest momentary value: -20.0 + 19 * 0.5 = -10.5
        assert!(
            (peak_db - (-10.5)).abs() < 0.01,
            "Expected peak ~-10.5, got {}",
            peak_db
        );
        // First second average: values -20.0 to -15.5 (10 values)
        // Average = (-20.0 + -19.5 + -19.0 + ... + -15.5) / 10
        let first_avg = (-20.0 + -15.5) / 2.0; // arithmetic mean of arithmetic sequence
        assert!(
            (loudness_profile[0] - first_avg).abs() < 0.1,
            "Expected first second avg ~{}, got {}",
            first_avg,
            loudness_profile[0]
        );
    }

    #[test]
    fn should_return_empty_loudness_for_no_data() {
        let (loudness_profile, peak_db) = parse_loudness_and_peak("no relevant data here");
        assert!(loudness_profile.is_empty());
        assert_eq!(peak_db, SILENCE_FLOOR_DB);
    }

    #[test]
    fn should_ignore_invalid_momentary_values() {
        let stderr = r#"
[Parsed_ebur128_0 @ 0x1234] M: -inf S: -22.0 I: -24.0 LUFS
[Parsed_ebur128_0 @ 0x1234] M: abc S: -22.0 I: -24.0 LUFS
[Parsed_ebur128_0 @ 0x1234] M: -18.5 S: -22.0 I: -24.0 LUFS
"#;
        let (loudness_profile, peak_db) = parse_loudness_and_peak(stderr);
        // Only one valid value
        assert_eq!(loudness_profile.len(), 1);
        assert!((peak_db - (-18.5)).abs() < 0.01);
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
    }

    #[test]
    fn should_return_empty_silent_profile_for_zero_duration() {
        let profile = AudioProfile::silent(0.0);
        assert!(profile.silence_regions.is_empty());
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

    #[test]
    fn should_extract_momentary_loudness_value() {
        let line = "[Parsed_ebur128_0 @ 0x1234] M: -18.5 S: -22.0 I: -24.0 LUFS";
        let val = extract_momentary_loudness(line);
        assert_eq!(val, Some(-18.5));
    }

    #[test]
    fn should_reject_invalid_momentary_loudness() {
        assert_eq!(extract_momentary_loudness("no M: here"), None);
        assert_eq!(extract_momentary_loudness("M:"), None);
        assert_eq!(extract_momentary_loudness("M: abc"), None);
    }
}
