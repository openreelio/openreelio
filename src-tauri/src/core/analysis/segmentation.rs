//! Content Segmentation Module (ADR-051)
//!
//! Heuristic-based content segmentation that classifies consecutive time ranges
//! into content types using audio features, shot frequency, and simple heuristics.
//! No ML models required.

use serde_json::json;

use super::types::{AudioProfile, ContentSegment, SegmentType, SilenceRegion};
use crate::core::annotations::models::{ShotResult, TranscriptSegment};
use crate::core::{CoreError, CoreResult};

// =============================================================================
// WindowFeatures (private)
// =============================================================================

/// Aggregated feature values for a single analysis window.
struct WindowFeatures {
    /// Start time in seconds
    start_sec: f64,
    /// End time in seconds
    end_sec: f64,
    /// Average loudness in dB within this window
    avg_loudness: f64,
    /// Variance of loudness values within this window
    loudness_variance: f64,
    /// Number of shot boundaries per second in this window
    cut_frequency: f64,
    /// Spectral centroid in Hz (from audio profile)
    spectral_centroid: f64,
    /// Estimated spoken words per second in this window
    speech_density: f64,
    /// Whether this window overlaps with a silence region
    is_silent: bool,
    /// Whether this window sits at the start or end boundary of the video
    is_boundary_window: bool,
    /// Whether all overlapping shots are shorter than montage threshold
    all_short_shots: bool,
    /// Longest overlapping shot duration in seconds
    longest_shot_duration: f64,
}

/// Aggregate loudness thresholds used for relative classification.
struct LoudnessStats {
    median_db: f64,
    std_dev_db: f64,
}

// =============================================================================
// ContentSegmenter
// =============================================================================

/// Heuristic-based content segmenter.
///
/// Classifies video content into typed segments using audio features
/// and shot frequency data. No ML models required (ADR-051).
pub struct ContentSegmenter {
    /// Window size in seconds for analysis
    window_sec: f64,
    /// Minimum segment duration in seconds
    min_segment_sec: f64,
}

impl ContentSegmenter {
    /// Creates a new segmenter with default settings.
    ///
    /// Defaults: `window_sec = 5.0`, `min_segment_sec = 2.0`.
    pub fn new() -> Self {
        Self {
            window_sec: 5.0,
            min_segment_sec: 2.0,
        }
    }

    /// Sets the analysis window size in seconds (builder pattern).
    pub fn with_window(mut self, window_sec: f64) -> Self {
        self.window_sec = window_sec;
        self
    }

    /// Sets the minimum segment duration in seconds (builder pattern).
    pub fn with_min_segment(mut self, min_segment_sec: f64) -> Self {
        self.min_segment_sec = min_segment_sec;
        self
    }

    /// Segments a video into typed content regions.
    ///
    /// Divides the video into analysis windows, computes audio and shot features
    /// for each window, classifies each window by content type, merges adjacent
    /// same-type windows, and filters out segments shorter than `min_segment_sec`.
    ///
    /// # Arguments
    /// * `duration_sec` - Total video duration in seconds
    /// * `shots` - Shot boundary detection results
    /// * `audio` - Audio profile with loudness and spectral data
    ///
    /// # Errors
    /// Returns `CoreError::ValidationError` if `duration_sec` is not positive.
    pub fn segment(
        &self,
        duration_sec: f64,
        shots: &[ShotResult],
        audio: &AudioProfile,
    ) -> CoreResult<Vec<ContentSegment>> {
        self.segment_with_transcript(duration_sec, shots, audio, None)
    }

    /// Segments a video into typed content regions with optional transcript support.
    pub fn segment_with_transcript(
        &self,
        duration_sec: f64,
        shots: &[ShotResult],
        audio: &AudioProfile,
        transcript: Option<&[TranscriptSegment]>,
    ) -> CoreResult<Vec<ContentSegment>> {
        if duration_sec <= 0.0 {
            return Err(CoreError::ValidationError(
                "Duration must be positive for segmentation".to_string(),
            ));
        }

        let loudness_stats = Self::compute_loudness_stats(&audio.loudness_profile);

        // Step a: Divide video into windows
        let windows = self.compute_windows(duration_sec, shots, audio, transcript);

        // Step b-c: Classify each window
        let raw_segments: Vec<ContentSegment> = windows
            .iter()
            .map(|w| {
                let (segment_type, confidence) = self.classify_window(w, &loudness_stats);
                let features = json!({
                    "avgLoudness": w.avg_loudness,
                    "loudnessVariance": w.loudness_variance,
                    "cutFrequency": w.cut_frequency,
                    "spectralCentroid": w.spectral_centroid,
                    "speechDensity": w.speech_density,
                    "isSilent": w.is_silent,
                    "isBoundaryWindow": w.is_boundary_window,
                    "allShortShots": w.all_short_shots,
                    "longestShotDuration": w.longest_shot_duration,
                });
                ContentSegment::new(w.start_sec, w.end_sec, segment_type, confidence)
                    .with_features(features)
            })
            .collect();

        // Step d: Merge adjacent same-type segments
        let merged = Self::merge_segments(&raw_segments);

        // Step e: Filter out segments shorter than min_segment_sec
        let filtered: Vec<ContentSegment> = merged
            .into_iter()
            .filter(|s| s.duration() >= self.min_segment_sec)
            .collect();

        Ok(filtered)
    }

    /// Computes feature vectors for each analysis window.
    fn compute_windows(
        &self,
        duration_sec: f64,
        shots: &[ShotResult],
        audio: &AudioProfile,
        transcript: Option<&[TranscriptSegment]>,
    ) -> Vec<WindowFeatures> {
        let mut windows = Vec::new();
        let mut start = 0.0;

        while start < duration_sec {
            let end = (start + self.window_sec).min(duration_sec);

            let avg_loudness = Self::compute_avg_loudness(start, end, &audio.loudness_profile);
            let loudness_variance =
                Self::compute_loudness_variance(start, end, &audio.loudness_profile, avg_loudness);
            let cut_frequency = Self::compute_cut_frequency(start, end, shots);
            let spectral_centroid = audio.spectral_centroid_hz;
            let speech_density = Self::compute_speech_density(start, end, transcript);
            let is_silent = Self::check_silence_overlap(start, end, &audio.silence_regions);
            let (all_short_shots, longest_shot_duration) =
                Self::compute_shot_shape(start, end, shots);
            let is_boundary_window = start <= f64::EPSILON || (duration_sec - end) <= f64::EPSILON;

            windows.push(WindowFeatures {
                start_sec: start,
                end_sec: end,
                avg_loudness,
                loudness_variance,
                cut_frequency,
                spectral_centroid,
                speech_density,
                is_silent,
                is_boundary_window,
                all_short_shots,
                longest_shot_duration,
            });

            start = end;
        }

        windows
    }

    /// Computes the average loudness (in dB) for samples within a time window.
    ///
    /// The loudness profile is assumed to have one sample per second, indexed by
    /// the integer part of the time in seconds.
    fn compute_avg_loudness(start_sec: f64, end_sec: f64, loudness_profile: &[f64]) -> f64 {
        if loudness_profile.is_empty() {
            return f64::NEG_INFINITY;
        }

        let first_idx = start_sec.floor() as usize;
        let last_idx = (end_sec.ceil() as usize).min(loudness_profile.len());

        if first_idx >= last_idx {
            return f64::NEG_INFINITY;
        }

        let slice = &loudness_profile[first_idx..last_idx];
        let sum: f64 = slice.iter().sum();
        sum / slice.len() as f64
    }

    /// Computes the variance of loudness values within a time window.
    fn compute_loudness_variance(
        start_sec: f64,
        end_sec: f64,
        loudness_profile: &[f64],
        avg_loudness: f64,
    ) -> f64 {
        if loudness_profile.is_empty() || avg_loudness.is_infinite() {
            return 0.0;
        }

        let first_idx = start_sec.floor() as usize;
        let last_idx = (end_sec.ceil() as usize).min(loudness_profile.len());

        if first_idx >= last_idx {
            return 0.0;
        }

        let slice = &loudness_profile[first_idx..last_idx];
        let sum_sq: f64 = slice.iter().map(|v| (v - avg_loudness).powi(2)).sum();
        sum_sq / slice.len() as f64
    }

    /// Computes the cut (shot boundary) frequency within a time window.
    ///
    /// Counts how many shot boundaries fall within `[start_sec, end_sec)` and
    /// divides by the window duration to get cuts per second.
    fn compute_cut_frequency(start_sec: f64, end_sec: f64, shots: &[ShotResult]) -> f64 {
        let window_duration = end_sec - start_sec;
        if window_duration <= 0.0 {
            return 0.0;
        }

        // Count shot boundaries (start_sec of each shot) that fall within the window,
        // excluding the very first shot boundary at 0.0 since that is not a "cut".
        let boundary_count = shots
            .iter()
            .filter(|shot| {
                shot.start_sec > 0.0 && shot.start_sec >= start_sec && shot.start_sec < end_sec
            })
            .count();

        boundary_count as f64 / window_duration
    }

    /// Checks whether a time window overlaps with any silence region.
    fn check_silence_overlap(
        start_sec: f64,
        end_sec: f64,
        silence_regions: &[SilenceRegion],
    ) -> bool {
        silence_regions.iter().any(|sr| {
            // Overlap exists when neither region is entirely before or after the other
            sr.start_sec < end_sec && sr.end_sec > start_sec
        })
    }

    /// Computes transcript speech density as overlapping words per second.
    fn compute_speech_density(
        start_sec: f64,
        end_sec: f64,
        transcript: Option<&[TranscriptSegment]>,
    ) -> f64 {
        let Some(transcript) = transcript else {
            return 0.0;
        };

        let window_duration = end_sec - start_sec;
        if window_duration <= 0.0 {
            return 0.0;
        }

        let mut weighted_words = 0.0;
        for segment in transcript {
            let overlap_start = segment.start_sec.max(start_sec);
            let overlap_end = segment.end_sec.min(end_sec);
            let overlap_duration = overlap_end - overlap_start;
            let segment_duration = segment.duration();

            if overlap_duration <= 0.0 || segment_duration <= 0.0 {
                continue;
            }

            let word_count = segment.text.split_whitespace().count() as f64;
            weighted_words += word_count * (overlap_duration / segment_duration);
        }

        weighted_words / window_duration
    }

    /// Computes whether overlapping shots are all short and the longest shot duration.
    fn compute_shot_shape(start_sec: f64, end_sec: f64, shots: &[ShotResult]) -> (bool, f64) {
        let overlapping: Vec<&ShotResult> = shots
            .iter()
            .filter(|shot| shot.start_sec < end_sec && shot.end_sec > start_sec)
            .collect();

        if overlapping.is_empty() {
            return (false, 0.0);
        }

        let longest = overlapping
            .iter()
            .map(|shot| shot.duration())
            .fold(0.0, f64::max);
        let all_short = overlapping.iter().all(|shot| shot.duration() < 1.5);
        (all_short, longest)
    }

    /// Computes median and standard deviation for finite loudness samples.
    fn compute_loudness_stats(loudness_profile: &[f64]) -> LoudnessStats {
        let mut finite_values: Vec<f64> = loudness_profile
            .iter()
            .copied()
            .filter(|value| value.is_finite())
            .collect();

        if finite_values.is_empty() {
            return LoudnessStats {
                median_db: 0.0,
                std_dev_db: 0.0,
            };
        }

        finite_values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median_db = if finite_values.len() % 2 == 0 {
            let upper = finite_values.len() / 2;
            (finite_values[upper - 1] + finite_values[upper]) / 2.0
        } else {
            finite_values[finite_values.len() / 2]
        };

        let mean = finite_values.iter().sum::<f64>() / finite_values.len() as f64;
        let variance = finite_values
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / finite_values.len() as f64;

        LoudnessStats {
            median_db,
            std_dev_db: variance.sqrt(),
        }
    }

    /// Classifies a single analysis window into a segment type with confidence.
    ///
    /// Classification rules are applied in priority order:
    /// 1. Silent windows => Transition
    /// 2. High cut frequency => Montage
    /// 3. Loud + high spectral centroid => Performance
    /// 4. Moderate loudness + high variance => Talk
    /// 5. Very low cut frequency + long window => Establishing
    /// 6. Moderate loudness + low variance => Reaction
    /// 7. Default => Talk
    fn classify_window(
        &self,
        features: &WindowFeatures,
        loudness_stats: &LoudnessStats,
    ) -> (SegmentType, f64) {
        // Rule 1: Silent => Transition
        if features.is_silent {
            return (SegmentType::Transition, 0.9);
        }

        // Rule 2: Opening/closing long takes => Establishing
        if features.is_boundary_window
            && features.longest_shot_duration >= 5.0
            && features.cut_frequency <= 0.05
            && features.speech_density < 0.25
        {
            return (SegmentType::Establishing, 0.9);
        }

        // Rule 3: Short consecutive shots => Montage
        if features.all_short_shots && features.cut_frequency >= 0.3 {
            return (SegmentType::Montage, 0.9);
        }

        // Rule 4: Loud music-like sections with sparse speech => Performance
        let loudness_threshold = loudness_stats.median_db + (loudness_stats.std_dev_db * 0.5);
        if features.avg_loudness >= loudness_threshold
            && features.speech_density < 0.5
            && features.spectral_centroid >= 1800.0
        {
            let confidence = if features.avg_loudness >= loudness_threshold
                && features.spectral_centroid >= 2200.0
            {
                0.9
            } else {
                0.75
            };
            return (SegmentType::Performance, confidence);
        }

        // Rule 5: Dense speech and relaxed cutting => Talk
        if features.speech_density > 1.0 && features.cut_frequency < 0.05 {
            return (SegmentType::Talk, 0.9);
        }

        // Rule 6: Rapid cutaways without strong music signal => Reaction
        if features.cut_frequency > 0.2 && features.speech_density <= 1.0 {
            return (SegmentType::Reaction, 0.6);
        }

        // Rule 7: Low-cut windows with speech-like variability => Talk fallback
        if features.cut_frequency < 0.1 && features.loudness_variance >= 2.0 {
            return (SegmentType::Talk, 0.7);
        }

        // Rule 8: Default
        (SegmentType::Talk, 0.6)
    }

    /// Merges adjacent segments that share the same type.
    ///
    /// The merged segment's confidence is a duration-weighted average of its
    /// constituents. The features map is taken from the longest constituent.
    fn merge_segments(segments: &[ContentSegment]) -> Vec<ContentSegment> {
        if segments.is_empty() {
            return Vec::new();
        }

        let mut merged: Vec<ContentSegment> = Vec::new();

        for segment in segments {
            let should_merge = merged
                .last()
                .is_some_and(|last| last.segment_type == segment.segment_type);

            if should_merge {
                let Some(last) = merged.last_mut() else {
                    merged.push(segment.clone());
                    continue;
                };

                // Weighted average confidence
                let last_duration = last.duration();
                let seg_duration = segment.duration();
                let total_duration = last_duration + seg_duration;

                if total_duration > 0.0 {
                    last.confidence = (last.confidence * last_duration
                        + segment.confidence * seg_duration)
                        / total_duration;
                }

                // Keep features from the longer constituent
                if seg_duration > last_duration {
                    last.features = segment.features.clone();
                }

                // Extend the end time
                last.end_sec = segment.end_sec;
            } else {
                merged.push(segment.clone());
            }
        }

        merged
    }
}

impl Default for ContentSegmenter {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: create a simple audio profile with uniform loudness
    fn make_audio_profile(
        duration_sec: usize,
        loudness_db: f64,
        spectral_centroid_hz: f64,
    ) -> AudioProfile {
        AudioProfile {
            bpm: None,
            spectral_centroid_hz,
            loudness_profile: vec![loudness_db; duration_sec],
            peak_db: loudness_db,
            silence_regions: Vec::new(),
        }
    }

    /// Helper: create shots at evenly spaced boundaries
    fn make_evenly_spaced_shots(duration_sec: f64, count: usize) -> Vec<ShotResult> {
        if count == 0 {
            return Vec::new();
        }
        let interval = duration_sec / count as f64;
        (0..count)
            .map(|i| {
                let start = i as f64 * interval;
                let end = ((i + 1) as f64 * interval).min(duration_sec);
                ShotResult::new(start, end, 0.9)
            })
            .collect()
    }

    // -------------------------------------------------------------------------
    // Test 1
    // -------------------------------------------------------------------------

    #[test]
    fn should_classify_talk_and_performance_alternating() {
        // Given: 20s video
        // - Shots at [0, 5, 10, 15, 20]
        // - Low loudness 0-10s, high loudness 10-20s
        let shots = vec![
            ShotResult::new(0.0, 5.0, 0.9),
            ShotResult::new(5.0, 10.0, 0.9),
            ShotResult::new(10.0, 15.0, 0.9),
            ShotResult::new(15.0, 20.0, 0.9),
        ];

        let mut loudness_profile = Vec::new();
        // 0-10s: low loudness with some variance (talk-like)
        for i in 0..10 {
            loudness_profile.push(-22.0 + (i as f64 % 3.0) * 2.0);
        }
        // 10-20s: high loudness (performance-like)
        for _ in 10..20 {
            loudness_profile.push(-10.0);
        }

        let audio = AudioProfile {
            bpm: None,
            spectral_centroid_hz: 3000.0,
            loudness_profile,
            peak_db: -5.0,
            silence_regions: Vec::new(),
        };

        let segmenter = ContentSegmenter::new();
        let segments = segmenter.segment(20.0, &shots, &audio).unwrap();

        // Then: At least 2 segments
        assert!(
            segments.len() >= 2,
            "Expected at least 2 segments, got {}",
            segments.len()
        );

        // First segment(s) should be talk-like (not performance)
        let first = &segments[0];
        assert_ne!(
            first.segment_type,
            SegmentType::Performance,
            "First segment should not be performance (low loudness region)"
        );

        // Last segment should be performance-like (high loudness + high spectral centroid)
        let last = &segments[segments.len() - 1];
        assert_eq!(
            last.segment_type,
            SegmentType::Performance,
            "Last segment should be performance (high loudness + high spectral centroid)"
        );
    }

    // -------------------------------------------------------------------------
    // Test 2
    // -------------------------------------------------------------------------

    #[test]
    fn should_produce_single_segment_for_uniform_content() {
        // Given: 10s video, single shot, uniform moderate loudness
        let shots = vec![ShotResult::new(0.0, 10.0, 0.95)];
        let audio = make_audio_profile(10, -20.0, 1500.0);

        let segmenter = ContentSegmenter::new().with_window(10.0);
        let segments = segmenter.segment(10.0, &shots, &audio).unwrap();

        // Then: Returns exactly 1 segment spanning the full duration
        assert_eq!(
            segments.len(),
            1,
            "Expected exactly 1 segment for uniform content"
        );
        assert!((segments[0].start_sec - 0.0).abs() < 0.01);
        assert!((segments[0].end_sec - 10.0).abs() < 0.01);
    }

    // -------------------------------------------------------------------------
    // Test 3
    // -------------------------------------------------------------------------

    #[test]
    fn should_detect_montage_from_high_cut_frequency() {
        // Given: 10s video, many shots (>15), moderate loudness
        let shots = make_evenly_spaced_shots(10.0, 20);
        let audio = make_audio_profile(10, -20.0, 1500.0);

        let segmenter = ContentSegmenter::new();
        let segments = segmenter.segment(10.0, &shots, &audio).unwrap();

        // Then: Contains montage segment(s)
        let has_montage = segments
            .iter()
            .any(|s| s.segment_type == SegmentType::Montage);
        assert!(
            has_montage,
            "Expected at least one montage segment with >15 cuts in 10s. Got: {:?}",
            segments
                .iter()
                .map(|s| format!("{}: {:.1}-{:.1}s", s.segment_type, s.start_sec, s.end_sec))
                .collect::<Vec<_>>()
        );
    }

    // -------------------------------------------------------------------------
    // Test 4
    // -------------------------------------------------------------------------

    #[test]
    fn should_detect_establishing_from_single_long_shot() {
        // Given: 15s video, single shot, low loudness
        let shots = vec![ShotResult::new(0.0, 15.0, 0.95)];
        let audio = make_audio_profile(15, -35.0, 800.0);

        // Use a window > 5s to trigger the establishing rule
        let segmenter = ContentSegmenter::new().with_window(8.0);
        let segments = segmenter.segment(15.0, &shots, &audio).unwrap();

        // Then: Contains establishing segment
        let has_establishing = segments
            .iter()
            .any(|s| s.segment_type == SegmentType::Establishing);
        assert!(
            has_establishing,
            "Expected establishing segment for single long shot with low loudness. Got: {:?}",
            segments
                .iter()
                .map(|s| format!("{}: {:.1}-{:.1}s", s.segment_type, s.start_sec, s.end_sec))
                .collect::<Vec<_>>()
        );
    }

    // -------------------------------------------------------------------------
    // Test 5
    // -------------------------------------------------------------------------

    #[test]
    fn should_merge_adjacent_same_type_segments() {
        // Given: Multiple consecutive windows classified as the same type
        let seg_a = ContentSegment::new(0.0, 5.0, SegmentType::Talk, 0.8).with_features(json!({
            "avgLoudness": -20.0,
        }));
        let seg_b = ContentSegment::new(5.0, 10.0, SegmentType::Talk, 0.6).with_features(json!({
            "avgLoudness": -22.0,
        }));
        let seg_c =
            ContentSegment::new(10.0, 15.0, SegmentType::Performance, 0.9).with_features(json!({
                "avgLoudness": -10.0,
            }));

        // When: merge_segments
        let merged = ContentSegmenter::merge_segments(&[seg_a, seg_b, seg_c]);

        // Then: The two talk segments are merged, performance stays separate
        assert_eq!(merged.len(), 2, "Expected 2 segments after merging");
        assert_eq!(merged[0].segment_type, SegmentType::Talk);
        assert!((merged[0].start_sec - 0.0).abs() < 0.001);
        assert!((merged[0].end_sec - 10.0).abs() < 0.001);
        assert_eq!(merged[1].segment_type, SegmentType::Performance);

        // Confidence should be duration-weighted average: (0.8*5 + 0.6*5) / 10 = 0.7
        assert!(
            (merged[0].confidence - 0.7).abs() < 0.01,
            "Weighted confidence should be ~0.7, got {}",
            merged[0].confidence
        );
    }

    // -------------------------------------------------------------------------
    // Test 6
    // -------------------------------------------------------------------------

    #[test]
    fn should_handle_empty_shots_gracefully() {
        // Given: Empty shots array
        let shots: Vec<ShotResult> = Vec::new();
        let audio = make_audio_profile(10, -20.0, 1500.0);

        // When: segment()
        let segmenter = ContentSegmenter::new();
        let result = segmenter.segment(10.0, &shots, &audio);

        // Then: Returns segments without panicking (defaults to low cut frequency)
        assert!(result.is_ok(), "Should not panic with empty shots");
        let segments = result.unwrap();
        assert!(
            !segments.is_empty(),
            "Should produce at least one segment even with no shots"
        );

        // All segments should have 0 cut frequency
        for seg in &segments {
            if let Some(cut_freq) = seg.features.get("cutFrequency") {
                let freq = cut_freq.as_f64().unwrap_or(0.0);
                assert!(
                    freq.abs() < 0.001,
                    "Cut frequency should be 0 with no shots, got {}",
                    freq
                );
            }
        }
    }

    #[test]
    fn should_classify_talk_when_transcript_shows_dense_speech() {
        let shots = vec![ShotResult::new(0.0, 10.0, 0.95)];
        let audio = make_audio_profile(10, -22.0, 1200.0);
        let transcript = vec![
            TranscriptSegment::new(0.0, 5.0, "one two three four five six seven eight", 0.9),
            TranscriptSegment::new(5.0, 10.0, "nine ten eleven twelve thirteen fourteen", 0.9),
        ];

        let segmenter = ContentSegmenter::new().with_window(10.0);
        let segments = segmenter
            .segment_with_transcript(10.0, &shots, &audio, Some(&transcript))
            .unwrap();

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].segment_type, SegmentType::Talk);
        assert!(segments[0].confidence >= 0.9);
    }

    // -------------------------------------------------------------------------
    // Additional edge case tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_return_error_for_zero_duration() {
        let segmenter = ContentSegmenter::new();
        let result = segmenter.segment(0.0, &[], &AudioProfile::silent(0.0));
        assert!(result.is_err());
    }

    #[test]
    fn should_return_error_for_negative_duration() {
        let segmenter = ContentSegmenter::new();
        let result = segmenter.segment(-5.0, &[], &AudioProfile::silent(0.0));
        assert!(result.is_err());
    }

    #[test]
    fn should_detect_transition_from_silence() {
        // Given: 10s video with silence from 3-7s
        let shots = vec![ShotResult::new(0.0, 10.0, 0.95)];
        let mut audio = make_audio_profile(10, -20.0, 1500.0);
        audio.silence_regions = vec![SilenceRegion::new(0.0, 10.0)];

        let segmenter = ContentSegmenter::new();
        let segments = segmenter.segment(10.0, &shots, &audio).unwrap();

        // Then: All segments should be transition (entire duration is silent)
        let has_transition = segments
            .iter()
            .any(|s| s.segment_type == SegmentType::Transition);
        assert!(
            has_transition,
            "Expected transition segment when silence covers the window"
        );
    }

    #[test]
    fn should_respect_min_segment_filter() {
        // Given: very short segments that should be filtered out
        let shots = vec![ShotResult::new(0.0, 3.0, 0.9)];
        let audio = make_audio_profile(3, -20.0, 1500.0);

        // Use a window size of 1s and min_segment of 5s
        let segmenter = ContentSegmenter::new()
            .with_window(1.0)
            .with_min_segment(5.0);
        let segments = segmenter.segment(3.0, &shots, &audio).unwrap();

        // All individual 1s windows would be shorter than 5s min,
        // but after merging adjacent same-type they might be long enough.
        // With uniform input, all windows should merge into one 3s segment,
        // which is still < 5s, so it should be filtered out.
        assert!(
            segments.is_empty(),
            "Expected no segments when all are shorter than min_segment_sec=5.0"
        );
    }

    #[test]
    fn should_handle_empty_loudness_profile() {
        let shots = vec![ShotResult::new(0.0, 10.0, 0.9)];
        let audio = AudioProfile {
            bpm: None,
            spectral_centroid_hz: 1500.0,
            loudness_profile: Vec::new(),
            peak_db: f64::NEG_INFINITY,
            silence_regions: Vec::new(),
        };

        let segmenter = ContentSegmenter::new();
        let result = segmenter.segment(10.0, &shots, &audio);
        assert!(
            result.is_ok(),
            "Should handle empty loudness profile without panicking"
        );
    }

    #[test]
    fn should_merge_empty_segments_list() {
        let merged = ContentSegmenter::merge_segments(&[]);
        assert!(merged.is_empty());
    }

    #[test]
    fn should_use_default_trait() {
        let segmenter = ContentSegmenter::default();
        assert!((segmenter.window_sec - 5.0).abs() < 0.001);
        assert!((segmenter.min_segment_sec - 2.0).abs() < 0.001);
    }
}
