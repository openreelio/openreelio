//! Audio Ducking — speech-region detection and duck-keyframe generation.
//!
//! Provides pure functions for:
//! 1. Inverting silence regions to speech regions
//! 2. Merging overlapping/adjacent speech regions
//! 3. Generating volume-automation keyframes that duck music during speech
//!
//! The heavy FFmpeg analysis (silence detection) is performed in the IPC layer;
//! this module only transforms the results into keyframes.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::analysis::types::SilenceRegion;
use crate::core::timeline::{AudioKeyframe, KeyframeInterpolation};

/// Tolerance in seconds for detecting keyframe time collisions.
/// Two keyframes closer than this are considered co-located.
const KEYFRAME_COLLISION_TOLERANCE_SEC: f64 = 0.01;

// =============================================================================
// Types
// =============================================================================

/// Parameters for audio ducking.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioDuckingParams {
    /// Loudness threshold in dB below which audio is considered silent.
    /// Used by FFmpeg `silencedetect` in the IPC layer. Default: -30.0
    pub threshold_db: f64,
    /// Amount to reduce music volume in dB (negative = quieter). Default: -15.0
    pub duck_amount_db: f64,
    /// Ramp-down time in milliseconds when ducking starts. Default: 200
    pub attack_ms: f64,
    /// Ramp-up time in milliseconds when ducking ends. Default: 500
    pub release_ms: f64,
}

impl Default for AudioDuckingParams {
    fn default() -> Self {
        Self {
            threshold_db: -30.0,
            duck_amount_db: -15.0,
            attack_ms: 200.0,
            release_ms: 500.0,
        }
    }
}

/// A detected speech region (non-silence) on the timeline.
#[derive(Clone, Debug, PartialEq)]
pub struct SpeechRegion {
    /// Start time in seconds (timeline-relative or clip-relative, depending on context)
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
}

impl SpeechRegion {
    pub fn new(start_sec: f64, end_sec: f64) -> Self {
        Self { start_sec, end_sec }
    }

    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }
}

// =============================================================================
// Public API
// =============================================================================

/// Invert silence regions to produce speech regions within a given duration.
///
/// Given a list of silence regions and the total duration, returns the
/// complementary intervals (non-silence = speech).
pub fn invert_silence_to_speech(
    silence_regions: &[SilenceRegion],
    total_duration: f64,
) -> Vec<SpeechRegion> {
    if total_duration <= 0.0 {
        return Vec::new();
    }

    let mut sorted: Vec<&SilenceRegion> = silence_regions.iter().collect();
    sorted.sort_by(|a, b| a.start_sec.partial_cmp(&b.start_sec).unwrap_or(std::cmp::Ordering::Equal));

    let mut speech = Vec::new();
    let mut cursor = 0.0;

    for silence in &sorted {
        let silence_start = silence.start_sec.max(0.0);
        let silence_end = silence.end_sec.min(total_duration);

        if silence_start > cursor {
            speech.push(SpeechRegion::new(cursor, silence_start));
        }
        cursor = silence_end.max(cursor);
    }

    // Remaining tail after last silence
    if cursor < total_duration {
        speech.push(SpeechRegion::new(cursor, total_duration));
    }

    speech
}

/// Merge overlapping or adjacent speech regions.
///
/// Regions closer than `(attack_sec + release_sec)` are merged to prevent
/// rapid volume oscillation. A hard minimum of 0.3 s is also enforced.
pub fn merge_speech_regions(
    regions: &[SpeechRegion],
    attack_sec: f64,
    release_sec: f64,
) -> Vec<SpeechRegion> {
    if regions.is_empty() {
        return Vec::new();
    }

    let min_gap = (attack_sec + release_sec).max(0.3);

    let mut sorted = regions.to_vec();
    sorted.sort_by(|a, b| a.start_sec.partial_cmp(&b.start_sec).unwrap_or(std::cmp::Ordering::Equal));

    let mut merged = vec![sorted[0].clone()];
    for region in &sorted[1..] {
        let last = merged.last_mut().expect("merged is non-empty");
        if region.start_sec <= last.end_sec + min_gap {
            last.end_sec = last.end_sec.max(region.end_sec);
        } else {
            merged.push(region.clone());
        }
    }

    merged
}

/// Generate ducking keyframes from speech regions.
///
/// For each speech region that overlaps the music clip, generates:
/// 1. Hold at original volume → ramp-down (attack)
/// 2. Hold at ducked volume during speech
/// 3. Ramp-up (release) → original volume
///
/// All `time_offset` values in the returned keyframes are **relative to the
/// music clip start** (0 … clip_duration_sec).
///
/// # Arguments
///
/// * `speech_regions` — detected speech regions in **timeline** time
/// * `params` — ducking parameters (duck amount, attack, release)
/// * `clip_timeline_start` — music clip start on the timeline (seconds)
/// * `clip_duration_sec` — music clip duration (seconds)
/// * `original_volume_db` — the clip's base volume in dB
pub fn generate_duck_keyframes(
    speech_regions: &[SpeechRegion],
    params: &AudioDuckingParams,
    clip_timeline_start: f64,
    clip_duration_sec: f64,
    original_volume_db: f64,
) -> Vec<AudioKeyframe> {
    if speech_regions.is_empty() || clip_duration_sec <= 0.0 {
        return Vec::new();
    }

    let attack_sec = params.attack_ms / 1000.0;
    let release_sec = params.release_ms / 1000.0;
    let duck_db = original_volume_db + params.duck_amount_db;
    let clip_end = clip_timeline_start + clip_duration_sec;

    // Pre-merge close regions
    let merged = merge_speech_regions(speech_regions, attack_sec, release_sec);

    // Filter to regions that overlap the music clip
    let overlapping: Vec<&SpeechRegion> = merged
        .iter()
        .filter(|r| r.end_sec > clip_timeline_start && r.start_sec < clip_end)
        .collect();

    if overlapping.is_empty() {
        return Vec::new();
    }

    let mut keyframes: Vec<AudioKeyframe> = Vec::new();

    // Helper: timeline → clip-local, clamped to [0, clip_duration_sec]
    let to_local = |t: f64| -> f64 { (t - clip_timeline_start).clamp(0.0, clip_duration_sec) };

    // Start at original volume
    keyframes.push(AudioKeyframe::new(
        0.0,
        original_volume_db,
        KeyframeInterpolation::Linear,
    ));

    for region in &overlapping {
        let speech_start = region.start_sec.max(clip_timeline_start);
        let speech_end = region.end_sec.min(clip_end);

        // Ramp-down anchor (original volume, just before duck)
        let ramp_down_start = to_local(speech_start - attack_sec);
        // Duck start
        let duck_start = to_local(speech_start);
        // Duck end
        let duck_end = to_local(speech_end);
        // Ramp-up end (back to original volume)
        let ramp_up_end = to_local(speech_end + release_sec);

        // Only add pre-duck anchor if it doesn't collide with the previous keyframe
        if let Some(last) = keyframes.last() {
            if (ramp_down_start - last.time_offset).abs() > KEYFRAME_COLLISION_TOLERANCE_SEC
                && ramp_down_start > last.time_offset
            {
                keyframes.push(AudioKeyframe::new(
                    ramp_down_start,
                    original_volume_db,
                    KeyframeInterpolation::Linear,
                ));
            }
        }

        // Duck start
        keyframes.push(AudioKeyframe::new(
            duck_start,
            duck_db,
            KeyframeInterpolation::Linear,
        ));

        // Duck end (hold at duck level) — only if there's a meaningful hold period
        if (duck_end - duck_start) > KEYFRAME_COLLISION_TOLERANCE_SEC {
            keyframes.push(AudioKeyframe::new(
                duck_end,
                duck_db,
                KeyframeInterpolation::Linear,
            ));
        }

        // Ramp-up to original volume
        keyframes.push(AudioKeyframe::new(
            ramp_up_end,
            original_volume_db,
            KeyframeInterpolation::Linear,
        ));
    }

    // Ensure final keyframe at clip end
    if let Some(last) = keyframes.last() {
        if (last.time_offset - clip_duration_sec).abs() > KEYFRAME_COLLISION_TOLERANCE_SEC {
            keyframes.push(AudioKeyframe::new(
                clip_duration_sec,
                original_volume_db,
                KeyframeInterpolation::Linear,
            ));
        }
    }

    // Sort by time (should already be sorted, but safety)
    AudioKeyframe::sort_by_time(&mut keyframes);
    keyframes
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── BDD: invert_silence_to_speech ───────────────────────────────────

    #[test]
    fn should_return_full_duration_as_speech_when_no_silence() {
        // Given no silence regions in a 10-second clip
        let silence: Vec<SilenceRegion> = vec![];

        // When inverting
        let speech = invert_silence_to_speech(&silence, 10.0);

        // Then the entire duration is speech
        assert_eq!(speech.len(), 1);
        assert!((speech[0].start_sec - 0.0).abs() < f64::EPSILON);
        assert!((speech[0].end_sec - 10.0).abs() < f64::EPSILON);
    }

    #[test]
    fn should_return_empty_when_entire_clip_is_silent() {
        // Given silence covering the entire 10-second clip
        let silence = vec![SilenceRegion::new(0.0, 10.0)];

        // When inverting
        let speech = invert_silence_to_speech(&silence, 10.0);

        // Then no speech regions
        assert!(speech.is_empty());
    }

    #[test]
    fn should_detect_speech_between_silence_regions() {
        // Given silence at 0-2s and 5-8s in a 10-second clip
        let silence = vec![
            SilenceRegion::new(0.0, 2.0),
            SilenceRegion::new(5.0, 8.0),
        ];

        // When inverting
        let speech = invert_silence_to_speech(&silence, 10.0);

        // Then speech at 2-5s and 8-10s
        assert_eq!(speech.len(), 2);
        assert!((speech[0].start_sec - 2.0).abs() < f64::EPSILON);
        assert!((speech[0].end_sec - 5.0).abs() < f64::EPSILON);
        assert!((speech[1].start_sec - 8.0).abs() < f64::EPSILON);
        assert!((speech[1].end_sec - 10.0).abs() < f64::EPSILON);
    }

    #[test]
    fn should_handle_silence_not_starting_at_zero() {
        // Given silence only at 3-7s in a 10-second clip
        let silence = vec![SilenceRegion::new(3.0, 7.0)];

        // When inverting
        let speech = invert_silence_to_speech(&silence, 10.0);

        // Then speech at 0-3s and 7-10s
        assert_eq!(speech.len(), 2);
        assert!((speech[0].start_sec - 0.0).abs() < f64::EPSILON);
        assert!((speech[0].end_sec - 3.0).abs() < f64::EPSILON);
        assert!((speech[1].start_sec - 7.0).abs() < f64::EPSILON);
        assert!((speech[1].end_sec - 10.0).abs() < f64::EPSILON);
    }

    #[test]
    fn should_return_empty_when_duration_is_zero() {
        let speech = invert_silence_to_speech(&[], 0.0);
        assert!(speech.is_empty());
    }

    // ── BDD: merge_speech_regions ───────────────────────────────────────

    #[test]
    fn should_merge_overlapping_regions() {
        // Given two overlapping speech regions
        let regions = vec![
            SpeechRegion::new(1.0, 5.0),
            SpeechRegion::new(4.0, 8.0),
        ];

        // When merging with 200ms attack + 500ms release
        let merged = merge_speech_regions(&regions, 0.2, 0.5);

        // Then they merge into one
        assert_eq!(merged.len(), 1);
        assert!((merged[0].start_sec - 1.0).abs() < f64::EPSILON);
        assert!((merged[0].end_sec - 8.0).abs() < f64::EPSILON);
    }

    #[test]
    fn should_merge_adjacent_regions_within_gap_threshold() {
        // Given two regions 0.5s apart (less than attack + release = 0.7s)
        let regions = vec![
            SpeechRegion::new(1.0, 3.0),
            SpeechRegion::new(3.5, 6.0),
        ];

        // When merging
        let merged = merge_speech_regions(&regions, 0.2, 0.5);

        // Then they merge (gap 0.5s < threshold 0.7s)
        assert_eq!(merged.len(), 1);
        assert!((merged[0].start_sec - 1.0).abs() < f64::EPSILON);
        assert!((merged[0].end_sec - 6.0).abs() < f64::EPSILON);
    }

    #[test]
    fn should_keep_distant_regions_separate() {
        // Given two regions 3s apart (greater than any reasonable threshold)
        let regions = vec![
            SpeechRegion::new(1.0, 3.0),
            SpeechRegion::new(6.0, 9.0),
        ];

        // When merging
        let merged = merge_speech_regions(&regions, 0.2, 0.5);

        // Then they remain separate
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn should_return_empty_for_empty_input() {
        let merged = merge_speech_regions(&[], 0.2, 0.5);
        assert!(merged.is_empty());
    }

    // ── BDD: generate_duck_keyframes ────────────────────────────────────

    #[test]
    fn should_generate_duck_keyframes_for_single_speech_region() {
        // Given a speech region at 5-10s on the timeline
        let speech = vec![SpeechRegion::new(5.0, 10.0)];
        let params = AudioDuckingParams {
            threshold_db: -30.0,
            duck_amount_db: -15.0,
            attack_ms: 200.0,
            release_ms: 500.0,
        };

        // When generating keyframes for a music clip at 0-20s, volume 0dB
        let keyframes = generate_duck_keyframes(&speech, &params, 0.0, 20.0, 0.0);

        // Then keyframes should contain:
        // 0.0s = 0dB (start)
        // 4.8s = 0dB (pre-duck anchor)
        // 5.0s = -15dB (duck start)
        // 10.0s = -15dB (duck end)
        // 10.5s = 0dB (release end)
        // 20.0s = 0dB (clip end)
        assert!(keyframes.len() >= 5, "expected at least 5 keyframes, got {}", keyframes.len());

        // Verify duck happens
        let duck_kf = keyframes.iter().find(|kf| (kf.value_db - (-15.0)).abs() < 0.01);
        assert!(duck_kf.is_some(), "should have a keyframe at -15dB");

        // Verify original volume restored after release
        let post_release = keyframes.iter().find(|kf| kf.time_offset > 10.0 && (kf.value_db - 0.0).abs() < 0.01);
        assert!(post_release.is_some(), "should restore to 0dB after release");
    }

    #[test]
    fn should_produce_smooth_attack_and_release_transitions() {
        // Given speech at 5-10s, attack=200ms, release=500ms
        let speech = vec![SpeechRegion::new(5.0, 10.0)];
        let params = AudioDuckingParams {
            threshold_db: -30.0,
            duck_amount_db: -12.0,
            attack_ms: 200.0,
            release_ms: 500.0,
        };

        // When generating keyframes for music clip at 0-20s
        let keyframes = generate_duck_keyframes(&speech, &params, 0.0, 20.0, 0.0);

        // Then attack ramp: 4.8s (0dB) → 5.0s (-12dB) = 200ms ramp
        let pre_duck = keyframes.iter().find(|kf| (kf.time_offset - 4.8).abs() < 0.05 && (kf.value_db - 0.0).abs() < 0.01);
        let duck_start = keyframes.iter().find(|kf| (kf.time_offset - 5.0).abs() < 0.05 && (kf.value_db - (-12.0)).abs() < 0.01);
        assert!(pre_duck.is_some(), "should have pre-duck anchor at 4.8s");
        assert!(duck_start.is_some(), "should have duck start at 5.0s");

        // Then release ramp: 10.0s (-12dB) → 10.5s (0dB) = 500ms ramp
        let duck_end = keyframes.iter().find(|kf| (kf.time_offset - 10.0).abs() < 0.05 && (kf.value_db - (-12.0)).abs() < 0.01);
        let release_end = keyframes.iter().find(|kf| (kf.time_offset - 10.5).abs() < 0.05 && (kf.value_db - 0.0).abs() < 0.01);
        assert!(duck_end.is_some(), "should have duck end at 10.0s");
        assert!(release_end.is_some(), "should have release end at 10.5s");
    }

    #[test]
    fn should_return_empty_when_no_speech_regions() {
        let params = AudioDuckingParams::default();
        let keyframes = generate_duck_keyframes(&[], &params, 0.0, 20.0, 0.0);
        assert!(keyframes.is_empty());
    }

    #[test]
    fn should_skip_speech_regions_outside_music_clip() {
        // Given speech at 25-30s but music clip only 0-20s
        let speech = vec![SpeechRegion::new(25.0, 30.0)];
        let params = AudioDuckingParams::default();

        let keyframes = generate_duck_keyframes(&speech, &params, 0.0, 20.0, 0.0);

        // Then no keyframes generated (speech is outside clip)
        assert!(keyframes.is_empty());
    }

    #[test]
    fn should_handle_speech_at_clip_start_without_attack_room() {
        // Given speech starting at 0s (no room for 200ms attack ramp)
        let speech = vec![SpeechRegion::new(0.0, 5.0)];
        let params = AudioDuckingParams {
            duck_amount_db: -10.0,
            attack_ms: 200.0,
            release_ms: 500.0,
            ..Default::default()
        };

        // When generating keyframes for music clip starting at 0s
        let keyframes = generate_duck_keyframes(&speech, &params, 0.0, 20.0, 0.0);

        // Then first keyframe is at 0.0 and ducking still happens
        assert!(!keyframes.is_empty());
        assert!((keyframes[0].time_offset - 0.0).abs() < 0.01);

        // There should be a duck keyframe
        let has_duck = keyframes.iter().any(|kf| (kf.value_db - (-10.0)).abs() < 0.01);
        assert!(has_duck, "should still duck even without attack room");
    }

    #[test]
    fn should_handle_speech_at_clip_end_without_release_room() {
        // Given speech ending at 20s (clip end, no room for 500ms release)
        let speech = vec![SpeechRegion::new(15.0, 20.0)];
        let params = AudioDuckingParams {
            duck_amount_db: -10.0,
            attack_ms: 200.0,
            release_ms: 500.0,
            ..Default::default()
        };

        // When generating keyframes for music clip 0-20s
        let keyframes = generate_duck_keyframes(&speech, &params, 0.0, 20.0, 0.0);

        // Then keyframes are clamped to clip duration
        assert!(!keyframes.is_empty());
        for kf in &keyframes {
            assert!(kf.time_offset <= 20.0, "keyframe should not exceed clip duration");
        }
    }

    #[test]
    fn should_handle_multiple_speech_regions() {
        // Given two separate speech regions
        let speech = vec![
            SpeechRegion::new(2.0, 4.0),
            SpeechRegion::new(8.0, 12.0),
        ];
        let params = AudioDuckingParams {
            duck_amount_db: -15.0,
            attack_ms: 200.0,
            release_ms: 500.0,
            ..Default::default()
        };

        // When generating keyframes
        let keyframes = generate_duck_keyframes(&speech, &params, 0.0, 20.0, 0.0);

        // Then there should be two duck regions
        let duck_keyframes: Vec<_> = keyframes.iter().filter(|kf| (kf.value_db - (-15.0)).abs() < 0.01).collect();
        assert!(duck_keyframes.len() >= 2, "should have at least 2 duck keyframes for 2 speech regions");
    }

    #[test]
    fn should_use_clip_base_volume_for_original_level() {
        // Given a clip with base volume of -6dB and duck amount of -10dB
        let speech = vec![SpeechRegion::new(5.0, 10.0)];
        let params = AudioDuckingParams {
            duck_amount_db: -10.0,
            ..Default::default()
        };

        // When generating keyframes with original_volume_db = -6.0
        let keyframes = generate_duck_keyframes(&speech, &params, 0.0, 20.0, -6.0);

        // Then original keyframes are at -6dB, ducked keyframes at -16dB
        let original = keyframes.iter().filter(|kf| (kf.value_db - (-6.0)).abs() < 0.01).count();
        let ducked = keyframes.iter().filter(|kf| (kf.value_db - (-16.0)).abs() < 0.01).count();
        assert!(original >= 2, "should have original volume keyframes at -6dB");
        assert!(ducked >= 1, "should have ducked keyframes at -16dB");
    }

    #[test]
    fn should_produce_keyframes_sorted_by_time() {
        let speech = vec![
            SpeechRegion::new(8.0, 12.0),
            SpeechRegion::new(2.0, 4.0),
        ];
        let params = AudioDuckingParams::default();

        let keyframes = generate_duck_keyframes(&speech, &params, 0.0, 20.0, 0.0);

        // Then keyframes are sorted ascending by time_offset
        for window in keyframes.windows(2) {
            assert!(
                window[0].time_offset <= window[1].time_offset,
                "keyframes should be sorted: {} <= {}",
                window[0].time_offset,
                window[1].time_offset
            );
        }
    }

    #[test]
    fn should_use_linear_interpolation_for_all_keyframes() {
        let speech = vec![SpeechRegion::new(5.0, 10.0)];
        let params = AudioDuckingParams::default();

        let keyframes = generate_duck_keyframes(&speech, &params, 0.0, 20.0, 0.0);

        for kf in &keyframes {
            assert_eq!(kf.interpolation, KeyframeInterpolation::Linear);
        }
    }

    #[test]
    fn should_handle_music_clip_offset_on_timeline() {
        // Given music clip starts at 10s on timeline, speech at 12-15s
        let speech = vec![SpeechRegion::new(12.0, 15.0)];
        let params = AudioDuckingParams {
            duck_amount_db: -15.0,
            attack_ms: 200.0,
            release_ms: 500.0,
            ..Default::default()
        };

        // When generating keyframes for clip starting at 10s with 20s duration
        let keyframes = generate_duck_keyframes(&speech, &params, 10.0, 20.0, 0.0);

        // Then keyframes use clip-local time (speech starts at 2.0 in local time)
        let duck_kf = keyframes.iter().find(|kf| (kf.value_db - (-15.0)).abs() < 0.01);
        assert!(duck_kf.is_some());
        let duck_time = duck_kf.unwrap().time_offset;
        assert!(
            (duck_time - 2.0).abs() < 0.05,
            "duck should start at 2.0s local time (12.0 - 10.0), got {}",
            duck_time
        );
    }
}
