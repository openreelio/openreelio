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

/// Lowest momentary loudness reading treated as a real measurement, in LUFS.
///
/// `ebur128` prints `-120.7` for a window it considers digital silence. Those
/// readings are not measurements of anything and would drag a per-second
/// average to the floor, so they are dropped.
const MOMENTARY_FLOOR_LUFS: f64 = -120.0;

/// Parses the momentary loudness (`M:`) readings from `ebur128` frame lines.
///
/// Expects lines of the form:
/// ```text
/// [Parsed_ebur128_0 @ 0x1] t: 0.4  TARGET:-23 LUFS  M: -21.5 S:-120.7  I: -21.5 LUFS  LRA: 0.0 LU
/// ```
/// Only lines carrying the `ebur128` frame markers are considered, so an
/// unrelated log line that happens to contain `M:` cannot inject a reading.
/// Readings at the filter's digital-silence floor are dropped.
pub fn parse_momentary_loudness(stderr: &str) -> Vec<f64> {
    stderr
        .lines()
        .filter(|line| is_ebur128_frame_line(line))
        .filter_map(extract_momentary_loudness)
        .collect()
}

/// Averages higher-resolution momentary readings into one value per second.
///
/// `samples_per_second` is the nominal reading rate; a value of zero or a
/// non-positive count yields an empty profile rather than a division by zero.
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
fn is_ebur128_frame_line(line: &str) -> bool {
    line.contains("[Parsed_ebur128") && line.contains("TARGET:")
}

/// Extracts the momentary loudness value from one `ebur128` frame line.
fn extract_momentary_loudness(line: &str) -> Option<f64> {
    let marker = "M:";
    let position = line.find(marker)?;
    let value = parse_leading_f64(&line[position + marker.len()..])?;
    (value > MOMENTARY_FLOOR_LUFS).then_some(value)
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

    #[test]
    fn should_collect_momentary_readings_when_frame_lines_are_present() {
        let readings = parse_momentary_loudness(EBUR128_FRAMES);

        // The third line's reading sits at the digital-silence floor and is dropped.
        assert_eq!(readings, vec![-6.7, -6.5]);
    }

    #[test]
    fn should_ignore_lines_that_merely_contain_the_momentary_marker() {
        let noise = "\
Stream mapping: M: not a reading
[Parsed_ebur128_0 @ 1] Summary:
    I:          -6.7 LUFS";

        assert!(parse_momentary_loudness(noise).is_empty());
    }

    #[test]
    fn should_average_momentary_readings_into_one_value_per_second() {
        let samples: Vec<f64> = vec![-10.0; 10].into_iter().chain(vec![-20.0; 10]).collect();

        let profile = per_second_loudness_profile(&samples, 10);

        assert_eq!(profile, vec![-10.0, -20.0]);
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
