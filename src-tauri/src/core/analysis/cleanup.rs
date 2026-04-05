//! Audio Cleanup Detection Module
//!
//! Pure functions for detecting silence regions and filler words in transcripts.
//! Used by the transcript-based editing cleanup workflow (S35-002).
//!
//! ## Design
//!
//! - Filler word detection is entirely pure (no I/O): takes transcript words
//!   and returns matches.
//! - Silence filtering operates on existing `SilenceRegion` data or can be
//!   re-detected with custom parameters via `AudioProfiler`.
//! - Region padding preserves natural breath sounds at boundaries.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::types::SilenceRegion;
use crate::core::annotations::models::TranscriptWord;

// =============================================================================
// Constants
// =============================================================================

/// Default filler words for English content
pub const DEFAULT_FILLER_WORDS_EN: &[&str] = &[
    "um",
    "uh",
    "uhm",
    "umm",
    "er",
    "err",
    "ah",
    "ahh",
    "like",
    "you know",
    "i mean",
    "sort of",
    "kind of",
    "basically",
    "actually",
    "literally",
    "right",
    "so",
    "well",
];

/// Default padding in seconds applied to removal boundaries to avoid audio pops
pub const DEFAULT_PADDING_SEC: f64 = 0.05;

/// Threshold used when cached silence regions are generated.
pub const DEFAULT_SILENCE_THRESHOLD_DB: f64 = -40.0;

/// Minimum duration used when cached silence regions are generated.
pub const DEFAULT_SILENCE_MIN_DURATION_SEC: f64 = 0.5;

const SILENCE_PARAMETER_EPSILON: f64 = 0.001;

/// Minimum region duration (seconds) worth removing — shorter regions
/// produce more artifacts than benefit
pub const MIN_REMOVABLE_DURATION_SEC: f64 = 0.15;

// =============================================================================
// Types
// =============================================================================

/// A detected filler word occurrence with its time range
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FillerWordMatch {
    /// The matched filler word text (as it appears in transcript)
    pub text: String,
    /// Start time in seconds (source-relative)
    pub start_sec: f64,
    /// End time in seconds (source-relative)
    pub end_sec: f64,
    /// Index of the word in the transcript word list
    pub word_index: usize,
    /// The canonical filler pattern that matched (e.g., "um" for "Um")
    pub pattern: String,
}

/// A time region detected for potential removal
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectedRegion {
    /// Start time in seconds (source-relative)
    pub start_sec: f64,
    /// End time in seconds (source-relative)
    pub end_sec: f64,
    /// Classification of the region
    pub region_type: RegionType,
    /// Human-readable label (e.g., "um", "silence")
    pub label: String,
}

/// Classification of a detected cleanup region
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RegionType {
    /// Detected silence
    Silence,
    /// Detected filler word
    FillerWord,
}

// =============================================================================
// Filler Word Detection
// =============================================================================

/// Detects filler words in transcript word list.
///
/// Performs case-insensitive matching against the provided filler word patterns.
/// Multi-word patterns (e.g., "you know") are matched by checking consecutive
/// words in the transcript.
///
/// Returns matches sorted by start time.
pub fn detect_filler_words(
    words: &[TranscriptWord],
    filler_patterns: &[&str],
) -> Vec<FillerWordMatch> {
    if words.is_empty() || filler_patterns.is_empty() {
        return Vec::new();
    }

    let mut matches = Vec::new();

    // Separate single-word and multi-word patterns
    let (multi_word, single_word): (Vec<&&str>, Vec<&&str>) =
        filler_patterns.iter().partition(|p| p.contains(' '));

    // Track which word indices are consumed by multi-word matches to avoid
    // overlapping single-word detections on the same positions.
    let mut consumed: Vec<bool> = vec![false; words.len()];

    // Multi-word matches first (higher specificity takes priority)
    for (idx, word) in words.iter().enumerate() {
        if consumed[idx] {
            continue;
        }
        for pattern in &multi_word {
            let pattern_words: Vec<&str> = pattern.split_whitespace().collect();
            let pattern_len = pattern_words.len();

            if idx + pattern_len > words.len() {
                continue;
            }

            let mut all_match = true;
            for (offset, pat_word) in pattern_words.iter().enumerate() {
                let candidate = words[idx + offset].text.to_lowercase();
                let candidate_cleaned = candidate.trim_matches(|c: char| c.is_ascii_punctuation());
                if candidate_cleaned != *pat_word {
                    all_match = false;
                    break;
                }
            }

            if all_match {
                let last_word = &words[idx + pattern_len - 1];
                matches.push(FillerWordMatch {
                    text: words[idx..idx + pattern_len]
                        .iter()
                        .map(|w| w.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                    start_sec: word.start_sec,
                    end_sec: last_word.end_sec,
                    word_index: idx,
                    pattern: pattern.to_string(),
                });
                for offset in 0..pattern_len {
                    consumed[idx + offset] = true;
                }
                break;
            }
        }
    }

    // Single-word matches (skip indices already consumed by multi-word matches)
    for (idx, word) in words.iter().enumerate() {
        if consumed[idx] {
            continue;
        }
        let lower = word.text.to_lowercase();
        // Strip common punctuation for matching
        let cleaned = lower.trim_matches(|c: char| c.is_ascii_punctuation());

        for pattern in &single_word {
            if cleaned == **pattern {
                matches.push(FillerWordMatch {
                    text: word.text.clone(),
                    start_sec: word.start_sec,
                    end_sec: word.end_sec,
                    word_index: idx,
                    pattern: pattern.to_string(),
                });
                break;
            }
        }
    }

    // Sort by start time (should already be sorted, but ensure)
    matches.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
    matches
}

// =============================================================================
// Region Conversion & Processing
// =============================================================================

/// Converts silence regions to detected regions for the unified cleanup workflow.
pub fn silence_to_detected_regions(regions: &[SilenceRegion]) -> Vec<DetectedRegion> {
    regions
        .iter()
        .map(|r| DetectedRegion {
            start_sec: r.start_sec,
            end_sec: r.end_sec,
            region_type: RegionType::Silence,
            label: "silence".to_string(),
        })
        .collect()
}

/// Converts filler word matches to detected regions for the unified cleanup workflow.
pub fn fillers_to_detected_regions(matches: &[FillerWordMatch]) -> Vec<DetectedRegion> {
    matches
        .iter()
        .map(|m| DetectedRegion {
            start_sec: m.start_sec,
            end_sec: m.end_sec,
            region_type: RegionType::FillerWord,
            label: m.text.clone(),
        })
        .collect()
}

/// Filters silence regions by custom threshold and minimum duration.
///
/// This is a pure filter on pre-existing silence data. For re-detection
/// with a different FFmpeg threshold, use `AudioProfiler::detect_silence_custom`.
pub fn filter_silence_regions(
    regions: &[SilenceRegion],
    min_duration_sec: f64,
) -> Vec<SilenceRegion> {
    regions
        .iter()
        .filter(|r| r.duration() >= min_duration_sec)
        .cloned()
        .collect()
}

/// Returns whether cached silence regions can be safely reused.
///
/// Cached regions are computed at a fixed threshold of -40dB and a minimum
/// duration of 0.5s. Because individual region loudness is not stored, the
/// cache is only safe to reuse when the caller requests the same threshold and
/// an equal or longer minimum duration that can be derived by filtering.
pub fn can_reuse_cached_silence_regions(threshold_db: f64, min_duration_sec: f64) -> bool {
    (threshold_db - DEFAULT_SILENCE_THRESHOLD_DB).abs() <= SILENCE_PARAMETER_EPSILON
        && min_duration_sec + SILENCE_PARAMETER_EPSILON >= DEFAULT_SILENCE_MIN_DURATION_SEC
}

/// Applies inward padding to regions, shrinking them to avoid audio pops
/// at removal boundaries.
///
/// Regions that become too short after padding (< `MIN_REMOVABLE_DURATION_SEC`)
/// are dropped entirely.
pub fn apply_padding(
    regions: &[DetectedRegion],
    padding_sec: f64,
    min_time_sec: f64,
    max_time_sec: f64,
) -> Vec<DetectedRegion> {
    let lower_bound = min_time_sec.min(max_time_sec);
    let upper_bound = min_time_sec.max(max_time_sec);

    regions
        .iter()
        .filter_map(|r| {
            let padded_start = (r.start_sec + padding_sec).clamp(lower_bound, upper_bound);
            let padded_end = (r.end_sec - padding_sec).clamp(lower_bound, upper_bound);

            if padded_end <= padded_start {
                return None;
            }

            let duration = padded_end - padded_start;
            if duration < MIN_REMOVABLE_DURATION_SEC {
                return None;
            }

            Some(DetectedRegion {
                start_sec: padded_start,
                end_sec: padded_end,
                region_type: r.region_type.clone(),
                label: r.label.clone(),
            })
        })
        .collect()
}

/// Merges overlapping or adjacent detected regions.
///
/// Two regions are considered adjacent if the gap between them is
/// less than `gap_threshold_sec`.
pub fn merge_adjacent_regions(
    regions: &[DetectedRegion],
    gap_threshold_sec: f64,
) -> Vec<DetectedRegion> {
    if regions.is_empty() {
        return Vec::new();
    }

    let mut sorted: Vec<DetectedRegion> = regions.to_vec();
    sorted.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));

    let mut merged = vec![sorted[0].clone()];

    for region in sorted.iter().skip(1) {
        let last = merged.last_mut().unwrap();
        if region.start_sec <= last.end_sec + gap_threshold_sec {
            // Merge: extend the end time
            last.end_sec = last.end_sec.max(region.end_sec);
            // Keep the label of the first region in merged group
        } else {
            merged.push(region.clone());
        }
    }

    merged
}

/// Sorts regions in reverse chronological order for safe sequential removal.
///
/// Removing regions from end-to-start ensures earlier regions' positions
/// remain valid after each removal.
pub fn sort_regions_for_removal(regions: &mut [DetectedRegion]) {
    regions.sort_by(|a, b| b.start_sec.total_cmp(&a.start_sec));
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // Helper: create transcript words
    // -------------------------------------------------------------------------

    fn make_word(text: &str, start: f64, end: f64, idx: usize) -> TranscriptWord {
        TranscriptWord {
            text: text.to_string(),
            start_sec: start,
            end_sec: end,
            segment_index: 0,
            word_index: idx,
            confidence: 0.9,
            speaker_id: None,
            speaker_turn_id: None,
        }
    }

    fn make_words(items: &[(&str, f64, f64)]) -> Vec<TranscriptWord> {
        items
            .iter()
            .enumerate()
            .map(|(idx, (text, start, end))| make_word(text, *start, *end, idx))
            .collect()
    }

    // -------------------------------------------------------------------------
    // Feature: Filler Word Detection
    // -------------------------------------------------------------------------

    #[test]
    fn should_detect_single_filler_words_case_insensitive() {
        // Given a transcript with mixed-case filler words
        let words = make_words(&[
            ("Hello", 0.0, 0.5),
            ("Um", 0.5, 0.8),
            ("this", 0.8, 1.2),
            ("is", 1.2, 1.4),
            ("uh", 1.4, 1.7),
            ("great", 1.7, 2.0),
        ]);

        // When detecting fillers with default patterns
        let fillers = &["um", "uh"];
        let matches = detect_filler_words(&words, fillers);

        // Then both filler words are detected
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].text, "Um");
        assert_eq!(matches[0].pattern, "um");
        assert_eq!(matches[0].start_sec, 0.5);
        assert_eq!(matches[1].text, "uh");
        assert_eq!(matches[1].pattern, "uh");
    }

    #[test]
    fn should_detect_multi_word_filler_patterns() {
        // Given a transcript with multi-word fillers
        let words = make_words(&[
            ("I", 0.0, 0.3),
            ("you", 0.3, 0.6),
            ("know", 0.6, 0.9),
            ("think", 0.9, 1.2),
            ("I", 1.2, 1.5),
            ("mean", 1.5, 1.8),
        ]);

        // When detecting multi-word patterns
        let fillers = &["you know", "i mean"];
        let matches = detect_filler_words(&words, fillers);

        // Then both multi-word fillers are detected
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].text, "you know");
        assert_eq!(matches[0].start_sec, 0.3);
        assert_eq!(matches[0].end_sec, 0.9);
        assert_eq!(matches[1].text, "I mean");
        assert_eq!(matches[1].start_sec, 1.2);
        assert_eq!(matches[1].end_sec, 1.8);
    }

    #[test]
    fn should_strip_punctuation_when_matching_fillers() {
        // Given words with trailing punctuation
        let words = make_words(&[
            ("Well,", 0.0, 0.4),
            ("um...", 0.4, 0.7),
            ("okay.", 0.7, 1.0),
        ]);

        // When detecting fillers
        let fillers = &["um", "well"];
        let matches = detect_filler_words(&words, fillers);

        // Then punctuation is ignored during matching
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].text, "Well,");
        assert_eq!(matches[0].pattern, "well");
        assert_eq!(matches[1].text, "um...");
        assert_eq!(matches[1].pattern, "um");
    }

    #[test]
    fn should_return_empty_when_no_filler_words_found() {
        // Given a clean transcript
        let words = make_words(&[
            ("The", 0.0, 0.3),
            ("project", 0.3, 0.8),
            ("is", 0.8, 1.0),
            ("complete", 1.0, 1.5),
        ]);

        // When detecting fillers
        let matches = detect_filler_words(&words, &["um", "uh"]);

        // Then no matches are returned
        assert!(matches.is_empty());
    }

    #[test]
    fn should_return_empty_for_empty_inputs() {
        // Empty words
        assert!(detect_filler_words(&[], &["um"]).is_empty());

        // Empty patterns
        let words = make_words(&[("um", 0.0, 0.5)]);
        assert!(detect_filler_words(&words, &[]).is_empty());
    }

    #[test]
    fn should_not_match_partial_words() {
        // Given words that contain filler patterns as substrings
        let words = make_words(&[
            ("umbrella", 0.0, 0.5),
            ("medium", 0.5, 1.0),
            ("likely", 1.0, 1.5),
        ]);

        // When detecting fillers
        let matches = detect_filler_words(&words, &["um", "like"]);

        // Then substring matches are NOT returned (exact match only)
        assert!(matches.is_empty());
    }

    // -------------------------------------------------------------------------
    // Feature: Silence Region Filtering
    // -------------------------------------------------------------------------

    #[test]
    fn should_filter_silence_regions_by_min_duration() {
        // Given silence regions of varying durations
        let regions = vec![
            SilenceRegion::new(0.0, 0.3),  // 0.3s — too short
            SilenceRegion::new(1.0, 2.5),  // 1.5s — long enough
            SilenceRegion::new(5.0, 5.1),  // 0.1s — too short
            SilenceRegion::new(8.0, 10.0), // 2.0s — long enough
        ];

        // When filtering with 0.5s minimum
        let filtered = filter_silence_regions(&regions, 0.5);

        // Then only regions >= 0.5s remain
        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].start_sec, 1.0);
        assert_eq!(filtered[1].start_sec, 8.0);
    }

    // -------------------------------------------------------------------------
    // Feature: Region Padding
    // -------------------------------------------------------------------------

    #[test]
    fn should_apply_inward_padding_to_regions() {
        // Given a silence region from 2.0s to 4.0s
        let regions = vec![DetectedRegion {
            start_sec: 2.0,
            end_sec: 4.0,
            region_type: RegionType::Silence,
            label: "silence".to_string(),
        }];

        // When applying 0.1s padding
        let padded = apply_padding(&regions, 0.1, 0.0, 10.0);

        // Then the region is shrunk inward
        assert_eq!(padded.len(), 1);
        assert!((padded[0].start_sec - 2.1).abs() < 0.001);
        assert!((padded[0].end_sec - 3.9).abs() < 0.001);
    }

    #[test]
    fn should_drop_regions_too_short_after_padding() {
        // Given a very short region
        let regions = vec![DetectedRegion {
            start_sec: 5.0,
            end_sec: 5.2,
            region_type: RegionType::FillerWord,
            label: "um".to_string(),
        }];

        // When applying 0.1s padding (region becomes 0.0s)
        let padded = apply_padding(&regions, 0.1, 0.0, 10.0);

        // Then the region is dropped (too short to remove safely)
        assert!(padded.is_empty());
    }

    #[test]
    fn should_clamp_padded_region_to_valid_bounds() {
        // Given a region near the boundaries
        let regions = vec![DetectedRegion {
            start_sec: 0.0,
            end_sec: 1.0,
            region_type: RegionType::Silence,
            label: "silence".to_string(),
        }];

        // When applying 0.05s padding with 1.0s total duration
        let padded = apply_padding(&regions, 0.05, 0.0, 1.0);

        // Then start is padded inward, end is padded inward
        assert_eq!(padded.len(), 1);
        assert!((padded[0].start_sec - 0.05).abs() < 0.001);
        assert!((padded[0].end_sec - 0.95).abs() < 0.001);
    }

    #[test]
    fn should_apply_padding_with_non_zero_source_bounds() {
        let regions = vec![DetectedRegion {
            start_sec: 10.0,
            end_sec: 12.0,
            region_type: RegionType::Silence,
            label: "silence".to_string(),
        }];

        let padded = apply_padding(&regions, 0.1, 10.0, 20.0);

        assert_eq!(padded.len(), 1);
        assert!((padded[0].start_sec - 10.1).abs() < 0.001);
        assert!((padded[0].end_sec - 11.9).abs() < 0.001);
    }

    // -------------------------------------------------------------------------
    // Feature: Region Merging
    // -------------------------------------------------------------------------

    #[test]
    fn should_merge_overlapping_regions() {
        // Given overlapping regions
        let regions = vec![
            DetectedRegion {
                start_sec: 1.0,
                end_sec: 2.0,
                region_type: RegionType::Silence,
                label: "silence".to_string(),
            },
            DetectedRegion {
                start_sec: 1.5,
                end_sec: 3.0,
                region_type: RegionType::FillerWord,
                label: "um".to_string(),
            },
        ];

        // When merging with 0.0s gap threshold
        let merged = merge_adjacent_regions(&regions, 0.0);

        // Then they are combined into one
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].start_sec, 1.0);
        assert_eq!(merged[0].end_sec, 3.0);
    }

    #[test]
    fn should_merge_adjacent_regions_within_gap_threshold() {
        // Given two close but non-overlapping regions
        let regions = vec![
            DetectedRegion {
                start_sec: 1.0,
                end_sec: 2.0,
                region_type: RegionType::Silence,
                label: "silence".to_string(),
            },
            DetectedRegion {
                start_sec: 2.1,
                end_sec: 3.0,
                region_type: RegionType::Silence,
                label: "silence".to_string(),
            },
        ];

        // When merging with 0.2s gap threshold
        let merged = merge_adjacent_regions(&regions, 0.2);

        // Then they merge (gap 0.1s < threshold 0.2s)
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].end_sec, 3.0);
    }

    #[test]
    fn should_keep_separate_regions_beyond_gap_threshold() {
        // Given two distant regions
        let regions = vec![
            DetectedRegion {
                start_sec: 1.0,
                end_sec: 2.0,
                region_type: RegionType::Silence,
                label: "silence".to_string(),
            },
            DetectedRegion {
                start_sec: 5.0,
                end_sec: 6.0,
                region_type: RegionType::Silence,
                label: "silence".to_string(),
            },
        ];

        // When merging with 0.5s gap threshold
        let merged = merge_adjacent_regions(&regions, 0.5);

        // Then they remain separate (gap 3.0s > threshold 0.5s)
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn should_return_empty_when_merging_empty_list() {
        let merged = merge_adjacent_regions(&[], 0.5);
        assert!(merged.is_empty());
    }

    // -------------------------------------------------------------------------
    // Feature: Reverse Sort for Safe Removal
    // -------------------------------------------------------------------------

    #[test]
    fn should_sort_regions_in_reverse_chronological_order() {
        // Given regions in forward order
        let mut regions = vec![
            DetectedRegion {
                start_sec: 1.0,
                end_sec: 2.0,
                region_type: RegionType::Silence,
                label: "s1".to_string(),
            },
            DetectedRegion {
                start_sec: 5.0,
                end_sec: 6.0,
                region_type: RegionType::Silence,
                label: "s2".to_string(),
            },
            DetectedRegion {
                start_sec: 3.0,
                end_sec: 4.0,
                region_type: RegionType::FillerWord,
                label: "um".to_string(),
            },
        ];

        // When sorting for removal
        sort_regions_for_removal(&mut regions);

        // Then regions are in reverse order (last-to-first for safe deletion)
        assert_eq!(regions[0].start_sec, 5.0);
        assert_eq!(regions[1].start_sec, 3.0);
        assert_eq!(regions[2].start_sec, 1.0);
    }

    #[test]
    fn should_reuse_cached_silence_only_for_matching_threshold() {
        assert!(can_reuse_cached_silence_regions(-40.0, 0.5));
        assert!(can_reuse_cached_silence_regions(-40.0, 0.8));
        assert!(!can_reuse_cached_silence_regions(-35.0, 0.5));
        assert!(!can_reuse_cached_silence_regions(-40.0, 0.3));
    }

    // -------------------------------------------------------------------------
    // Feature: Type Conversions
    // -------------------------------------------------------------------------

    #[test]
    fn should_convert_silence_regions_to_detected_regions() {
        let silence = vec![SilenceRegion::new(1.0, 2.5), SilenceRegion::new(5.0, 6.0)];

        let detected = silence_to_detected_regions(&silence);

        assert_eq!(detected.len(), 2);
        assert_eq!(detected[0].region_type, RegionType::Silence);
        assert_eq!(detected[0].start_sec, 1.0);
        assert_eq!(detected[0].end_sec, 2.5);
        assert_eq!(detected[0].label, "silence");
    }

    #[test]
    fn should_convert_filler_matches_to_detected_regions() {
        let fillers = vec![FillerWordMatch {
            text: "Um".to_string(),
            start_sec: 0.5,
            end_sec: 0.8,
            word_index: 1,
            pattern: "um".to_string(),
        }];

        let detected = fillers_to_detected_regions(&fillers);

        assert_eq!(detected.len(), 1);
        assert_eq!(detected[0].region_type, RegionType::FillerWord);
        assert_eq!(detected[0].label, "Um");
    }

    // -------------------------------------------------------------------------
    // Feature: JSON Round-trip
    // -------------------------------------------------------------------------

    #[test]
    fn should_roundtrip_detected_region_via_json() {
        let region = DetectedRegion {
            start_sec: 2.5,
            end_sec: 4.0,
            region_type: RegionType::Silence,
            label: "silence".to_string(),
        };

        let json = serde_json::to_string(&region).unwrap();
        assert!(json.contains("\"startSec\":2.5"));
        assert!(json.contains("\"regionType\":\"silence\""));

        let parsed: DetectedRegion = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, region);
    }

    #[test]
    fn should_roundtrip_filler_word_match_via_json() {
        let m = FillerWordMatch {
            text: "you know".to_string(),
            start_sec: 1.0,
            end_sec: 1.8,
            word_index: 3,
            pattern: "you know".to_string(),
        };

        let json = serde_json::to_string(&m).unwrap();
        let parsed: FillerWordMatch = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, m);
    }
}
