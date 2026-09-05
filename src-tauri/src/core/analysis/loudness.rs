//! Shared EBU R128 loudness and peak measurement
//!
//! One implementation of the loudness/peak measurement that both the asset
//! audio profile (`analysis audio`, `analyze_asset`) and the rendered-file QC
//! pass (`verify --file`) depend on. Before this module the two surfaces built
//! their own `ebur128` invocations and parsed different parts of its output, so
//! the same audio could be reported as `-16.6 LUFS / -1.9 dBTP` by `verify` and
//! as `-90 dB` by `analysis audio`.
//!
//! The measurement is FFmpeg's: `ebur128` produces the R128 numbers and
//! `astats` the sample peak. What lives here is the filter spelling both
//! callers must use and the parsers for the log it produces. Every parser is a
//! pure function over FFmpeg stderr text, so it is testable without invoking
//! FFmpeg.
//!
//! ## Why the filter spelling matters
//!
//! `ebur128` decides at init time which log level its per-frame lines go to.
//! When `metadata=1` or `video=1` is set and `framelog` is left at its default,
//! it downgrades those lines from INFO to VERBOSE — and the analysis passes run
//! FFmpeg at `-loglevel info`, so the lines never arrive. `framelog=info` is
//! therefore pinned here rather than left to the default. `quiet` is
//! deliberately never passed: FFmpeg 4.4 and 6.1 only accept `info`/`verbose`
//! there and fail option parsing otherwise.

use super::types::SILENCE_FLOOR_DB;

// =============================================================================
// Filter spelling
// =============================================================================

/// `ebur128` filter spec shared by every loudness measurement.
///
/// * `peak=true` enables true-peak metering, which is what the peak numbers
///   reported to users and QC rules are measured against.
/// * `framelog=info` forces the per-frame `M:`/`S:` lines to INFO level so they
///   survive `-loglevel info`; see the module docs for why the default is not
///   good enough.
pub const EBUR128_FILTER: &str = "ebur128=peak=true:framelog=info";

/// `astats` filter spec used for the overall sample peak and flat factor.
///
/// Per-channel measurement is off: the overall section is all either caller
/// reads, and the per-channel block would multiply the log volume for nothing.
pub const ASTATS_FILTER: &str =
    "astats=metadata=0:measure_perchannel=none:measure_overall=Peak_level+Flat_factor";

/// Nominal rate of `ebur128` momentary loudness readings, in samples/second.
///
/// The filter reports momentary loudness every 100 ms.
pub const MOMENTARY_SAMPLES_PER_SECOND: f64 = 10.0;

/// Returns the `ebur128,astats` chain measuring one audio stream.
///
/// Both filters are needed: `ebur128` reports integrated loudness, loudness
/// range and true peak, while `astats` reports the sample peak that stands in
/// for true peak on builds without true-peak support.
pub fn loudness_filter_chain() -> String {
    format!("{EBUR128_FILTER},{ASTATS_FILTER}")
}

// =============================================================================
// Parsed values
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

// =============================================================================
// Parsers
// =============================================================================

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

/// Parses the momentary loudness (`M:`) readings from `ebur128` frame lines.
///
/// Expects lines of the form:
/// ```text
/// [Parsed_ebur128_0 @ 0x1] t: 0.4  TARGET:-23 LUFS  M: -21.5 S:-120.7  I: -21.5 LUFS  LRA: 0.0 LU
/// ```
/// Only lines carrying the `ebur128` frame markers are considered, so an
/// unrelated log line that happens to contain `M:` cannot inject a reading.
///
/// **Every frame line yields exactly one reading.** The series is positional:
/// [`per_second_loudness_profile`] chunks it back into seconds and consumers
/// index the resulting profile by the integer second. A window the meter
/// reports as digital silence (`-120.7`, a sentinel rather than a level) is
/// therefore clamped to [`SILENCE_FLOOR_DB`] instead of being dropped —
/// dropping it would pull every later reading into an earlier second and
/// silently misalign the whole profile with the audio. Where the silence is
/// genuinely uninteresting, filter afterwards with
/// [`audible_momentary_readings`].
///
/// A frame line whose `M:` value cannot be parsed at all is the one case that
/// yields no reading: it is not silence, and there is no honest number to put
/// in its place. FFmpeg does not emit such a line, so the shift it would cause
/// is theoretical.
pub fn parse_momentary_loudness(stderr: &str) -> Vec<f64> {
    stderr
        .lines()
        .filter(|line| is_ebur128_frame_line(line))
        .filter_map(extract_momentary_loudness)
        .collect()
}

/// Returns only the readings that measured audible content.
///
/// Onset and BPM detection looks for local maxima, and a run of silence-floor
/// readings between two spoken phrases is a pair of enormous artificial jumps
/// rather than a beat. The result is *not* positional — removing readings
/// shifts the ones after them — so it must never be turned into a per-second
/// profile.
pub fn audible_momentary_readings(samples: &[f64]) -> Vec<f64> {
    samples
        .iter()
        .copied()
        .filter(|value| *value > SILENCE_FLOOR_DB)
        .collect()
}

/// Averages higher-resolution momentary readings into one value per second.
///
/// `samples_per_second` is the nominal reading rate; a value of zero or a
/// non-positive count yields an empty profile rather than a division by zero.
///
/// The result is positional: entry `i` averages the readings taken during
/// second `i`, which is the contract [`super::segmentation`] and [`super::esd`]
/// rely on when they address the profile by time.
pub fn per_second_loudness_profile(samples: &[f64], samples_per_second: usize) -> Vec<f64> {
    if samples.is_empty() || samples_per_second == 0 {
        return Vec::new();
    }

    samples
        .chunks(samples_per_second)
        .map(|chunk| chunk.iter().sum::<f64>() / chunk.len() as f64)
        .collect()
}

/// Returns `true` when the line is an `ebur128` per-frame log line.
///
/// The gate is the filter tag plus the momentary marker, and explicitly not
/// `TARGET:`: FFmpeg prints that column only on some builds, and requiring it
/// made the parser skip every frame line on the others. The summary block is
/// excluded by name because its header shares the filter tag.
fn is_ebur128_frame_line(line: &str) -> bool {
    line.contains("[Parsed_ebur128") && line.contains(" M:") && !line.contains("Summary")
}

/// Extracts the momentary loudness value from one `ebur128` frame line.
///
/// A reading at the filter's digital-silence sentinel is reported as
/// [`SILENCE_FLOOR_DB`], so the caller still gets one value per frame line.
fn extract_momentary_loudness(line: &str) -> Option<f64> {
    let marker = " M:";
    let position = line.find(marker)?;
    let value = parse_leading_f64(&line[position + marker.len()..])?;
    Some(value.max(SILENCE_FLOOR_DB))
}

/// Parses the first numeric token of `text`, ignoring trailing units.
pub(crate) fn parse_leading_f64(text: &str) -> Option<f64> {
    let trimmed = text.trim_start();
    let token: String = trimmed
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '+' || *c == '.' || *c == 'e')
        .collect();

    token.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// Removes a leading `[filter @ 0x…]` log prefix, if present.
pub(crate) fn strip_log_prefix(line: &str) -> &str {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('[') {
        return line;
    }
    match trimmed.find(']') {
        Some(end) => &trimmed[end + 1..],
        None => line,
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `ebur128` summary block with true peak enabled.
    const EBUR128_SUMMARY: &str = "\
[Parsed_ebur128_0 @ 000001f3f7a0] Summary:

  Integrated loudness:
    I:          -6.7 LUFS
    Threshold: -16.7 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold: -26.7 LUFS
    LRA low:    -6.7 LUFS
    LRA high:   -6.7 LUFS

  True peak:
    Peak:       -6.0 dBFS";

    /// Real `ebur128` per-frame output produced with `peak=true:framelog=info`.
    const EBUR128_FRAMES: &str = "\
[Parsed_ebur128_0 @ 000001f3f7a0] t: 0.399979   TARGET:-23 LUFS    M:  -6.7 S:-120.7     I:  -6.7 LUFS       LRA:   0.0 LU  FTPK:  -6.0  -6.0 dBFS  TPK:  -6.0  -6.0 dBFS
[Parsed_ebur128_0 @ 000001f3f7a0] t: 0.499979   TARGET:-23 LUFS    M:  -6.5 S:  -6.6     I:  -6.6 LUFS       LRA:   0.0 LU  FTPK:  -6.0  -6.0 dBFS  TPK:  -6.0  -6.0 dBFS
[Parsed_ebur128_0 @ 000001f3f7a0] t: 0.599979   TARGET:-23 LUFS    M:-120.7 S:-120.7     I:  -6.6 LUFS       LRA:   0.0 LU  FTPK:-120.7 -120.7 dBFS  TPK:  -6.0  -6.0 dBFS";

    /// Real `astats` overall section with per-channel measurement disabled.
    const ASTATS_OVERALL: &str = "\
[Parsed_astats_1 @ 000001f3f800] Overall
[Parsed_astats_1 @ 000001f3f800] Peak level dB: -6.020600
[Parsed_astats_1 @ 000001f3f800] Flat factor: 0.000000";

    #[test]
    fn should_read_integrated_loudness_and_true_peak_when_summary_is_present() {
        let summary = parse_loudness_summary(EBUR128_SUMMARY);

        assert_eq!(summary.integrated_lufs, Some(-6.7));
        assert_eq!(summary.loudness_range_lu, Some(0.0));
        assert_eq!(summary.true_peak_dbtp, Some(-6.0));
    }

    #[test]
    fn should_leave_true_peak_unset_when_the_build_omits_the_section() {
        let without_true_peak = "\
[Parsed_ebur128_0 @ 1] Summary:

  Integrated loudness:
    I:         -18.3 LUFS

  Loudness range:
    LRA:         7.4 LU";

        let summary = parse_loudness_summary(without_true_peak);

        assert_eq!(summary.integrated_lufs, Some(-18.3));
        assert_eq!(summary.true_peak_dbtp, None);
    }

    #[test]
    fn should_read_sample_peak_and_flat_factor_when_astats_reported_them() {
        let overall = parse_astats_overall(ASTATS_OVERALL);

        assert_eq!(overall.sample_peak_db, Some(-6.0206));
        assert_eq!(overall.flat_factor, Some(0.0));
    }

    #[test]
    fn should_report_no_sample_peak_when_astats_measured_digital_silence() {
        let overall = parse_astats_overall("[Parsed_astats_1 @ 1] Peak level dB: -inf");

        assert_eq!(overall.sample_peak_db, None);
    }

    /// Feature: momentary loudness parsing
    /// Scenario: a frame line reports digital silence
    ///   Given three frame lines, the last one at the meter's silence sentinel
    ///   When the momentary readings are parsed
    ///   Then all three are returned, the silent one clamped to the floor
    ///
    /// One reading per frame line is what makes the per-second profile
    /// addressable by the second; see [`parse_momentary_loudness`].
    #[test]
    fn should_collect_momentary_readings_when_frame_lines_are_present() {
        let readings = parse_momentary_loudness(EBUR128_FRAMES);

        assert_eq!(readings, vec![-6.7, -6.5, SILENCE_FLOOR_DB]);
    }

    /// Feature: momentary loudness parsing
    /// Scenario: an older FFmpeg build omits the `TARGET:` column
    ///   Given a frame line in the pre-TARGET layout
    ///   When the momentary readings are parsed
    ///   Then the reading is still collected
    #[test]
    fn should_collect_readings_from_frame_lines_without_the_target_column() {
        let older_build =
            "[Parsed_ebur128_0 @ 0x1] t: 0.19999   M: -21.4 S:-120.7 I: -21.4 LUFS LRA: 0.0 LU";

        assert_eq!(parse_momentary_loudness(older_build), vec![-21.4]);
    }

    /// Feature: momentary loudness parsing
    /// Scenario: a frame line carries a value that is not a number
    ///   Given frame lines whose `M:` values read `-inf` and `abc`
    ///   When the momentary readings are parsed
    ///   Then only the numeric reading survives
    #[test]
    fn should_skip_frame_lines_whose_momentary_value_is_malformed() {
        let malformed = "\
[Parsed_ebur128_0 @ 0x1] t: 0.1 M: -inf S: -22.0 I: -24.0 LUFS
[Parsed_ebur128_0 @ 0x1] t: 0.2 M: abc S: -22.0 I: -24.0 LUFS
[Parsed_ebur128_0 @ 0x1] t: 0.3 M: -18.5 S: -22.0 I: -24.0 LUFS";

        assert_eq!(parse_momentary_loudness(malformed), vec![-18.5]);
    }

    #[test]
    fn should_ignore_lines_that_merely_contain_the_momentary_marker() {
        let noise = "\
Stream mapping: M: not a reading
[Parsed_ebur128_0 @ 1] Summary:
    I:          -6.7 LUFS";

        assert!(parse_momentary_loudness(noise).is_empty());
    }

    /// Feature: onset detection input
    /// Scenario: silence sits between two audible passages
    ///   Given a reading series with a silent stretch in the middle
    ///   When the audible readings are selected
    ///   Then only the measured levels remain
    #[test]
    fn should_drop_silence_from_the_onset_series_only() {
        let readings = vec![-6.7, SILENCE_FLOOR_DB, -6.5];

        assert_eq!(audible_momentary_readings(&readings), vec![-6.7, -6.5]);
        // The positional series keeps it, so the profile stays aligned.
        assert_eq!(per_second_loudness_profile(&readings, 3).len(), 1);
    }

    #[test]
    fn should_average_momentary_readings_into_one_value_per_second() {
        let samples: Vec<f64> = vec![-10.0; 10].into_iter().chain(vec![-20.0; 10]).collect();

        let profile = per_second_loudness_profile(&samples, 10);

        assert_eq!(profile, vec![-10.0, -20.0]);
    }

    /// Feature: per-second loudness profile
    /// Scenario: the middle second of a three-second signal is digital silence
    ///   Given thirty frame lines whose middle ten sit at the silence sentinel
    ///   When the profile is built
    ///   Then it has one entry per second and the middle entry is the floor
    ///
    /// This is the regression: dropping the silent readings left a two-entry
    /// profile, so second 2 of the audio was reported at second 1's index and
    /// every consumer that addresses the profile by time read the wrong value.
    #[test]
    fn should_keep_one_profile_entry_per_second_when_a_second_is_silent() {
        let mut log = String::new();
        for index in 0..30 {
            let level = if (10..20).contains(&index) {
                -120.7
            } else {
                -16.4
            };
            log.push_str(&format!(
                "[Parsed_ebur128_0 @ 0x1] t: {:.1}   TARGET:-23 LUFS    M: {:.1} S: {:.1}\n",
                index as f64 / 10.0,
                level,
                level,
            ));
        }

        let profile = per_second_loudness_profile(&parse_momentary_loudness(&log), 10);

        assert_eq!(profile.len(), 3, "a 3 s signal must yield 3 entries");
        assert!((profile[0] - (-16.4)).abs() < 0.05);
        assert_eq!(profile[1], SILENCE_FLOOR_DB);
        assert!((profile[2] - (-16.4)).abs() < 0.05);
    }

    #[test]
    fn should_return_an_empty_profile_when_there_are_no_readings() {
        assert!(per_second_loudness_profile(&[], 10).is_empty());
        assert!(per_second_loudness_profile(&[-10.0], 0).is_empty());
    }

    #[test]
    fn should_strip_the_filter_log_prefix_from_a_line() {
        assert_eq!(
            strip_log_prefix("[Parsed_x @ 0x1] I: -5.0").trim(),
            "I: -5.0"
        );
        assert_eq!(strip_log_prefix("    I: -5.0").trim(), "I: -5.0");
    }

    #[test]
    fn should_pin_framelog_so_readings_survive_the_info_log_level() {
        // The default framelog is what produced `loudnessSampleCount: 0` on
        // real footage; the chain must keep saying so explicitly.
        assert!(EBUR128_FILTER.contains("framelog=info"));
        assert!(EBUR128_FILTER.contains("peak=true"));
        assert_eq!(
            loudness_filter_chain(),
            format!("{EBUR128_FILTER},{ASTATS_FILTER}")
        );
    }
}
