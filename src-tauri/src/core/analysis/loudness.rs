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
/// **Every frame line yields exactly one reading**, with no exceptions:
/// "is a frame line" ([`is_ebur128_frame_line`]) and "yields a slot"
/// ([`momentary_reading`]) are the same predicate. The series is positional —
/// [`per_second_loudness_profile`] chunks it back into seconds and consumers
/// index the resulting profile by the integer second — so a dropped line pulls
/// every later reading into an earlier second and silently misaligns the whole
/// profile with the audio.
///
/// What the meter prints for a window with no signal is not one spelling.
/// FFmpeg 9 reports `-120.7` for the first 300 ms while the momentary window
/// fills, and for a window of digital silence prints either a number far below
/// the floor (`-157.4`, `-163.5`, `-166.2` — the figure depends on the decoder)
/// or the literal `nan`, which is what an mp3 decode of the same silence
/// produces. They all mean the same thing and all become [`SILENCE_FLOOR_DB`]:
/// a silent slot that holds its position. Where the silence is genuinely
/// uninteresting, filter afterwards with [`audible_momentary_readings`].
pub fn parse_momentary_loudness(stderr: &str) -> Vec<f64> {
    parse_momentary_series(stderr).readings
}

/// The momentary series of one meter log, with the lines it could not read.
///
/// Separating the two answers the question a total parser cannot: every frame
/// line yields a reading, so a log of pure garbage and a log of pure silence
/// produce the same `readings`. Only [`Self::unreadable`] tells them apart.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MomentarySeries {
    /// One reading per frame line, in order, silent slots included.
    pub readings: Vec<f64>,
    /// How many of those readings stand in for a token that could not be read.
    ///
    /// Not the same as "silent": the meter's spellings of silence - the
    /// `-120.7` warm-up sentinel, a value far below the floor, `nan`, `-inf` -
    /// are all counted as read. This counts only a token that is not a number
    /// at all, which means the log is not the one this parser was written for.
    pub unreadable: usize,
}

/// Parses the momentary series and counts the frame lines it could not read.
///
/// Same series as [`parse_momentary_loudness`]; see that function for the
/// positional contract every reader depends on.
pub fn parse_momentary_series(stderr: &str) -> MomentarySeries {
    let mut series = MomentarySeries::default();

    for line in stderr.lines().filter(|line| is_ebur128_frame_line(line)) {
        match momentary_token(line) {
            MomentaryToken::Level(value) => series.readings.push(value),
            MomentaryToken::Silence => series.readings.push(SILENCE_FLOOR_DB),
            MomentaryToken::Unreadable => {
                series.readings.push(SILENCE_FLOOR_DB);
                series.unreadable += 1;
            }
        }
    }

    series
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
        .filter(|value| is_audible(*value))
        .collect()
}

/// Returns whether a reading measured audible content rather than silence.
///
/// A reading at or below [`SILENCE_FLOOR_DB`] is the floor sentinel, and a
/// non-finite one is a value no averaging step can use. Both mean "no signal
/// in this window", and every statistic taken over a loudness series has to
/// agree on that: a sentinel that survives into a mean, a median or a standard
/// deviation is read back as a level the audio actually reached.
pub fn is_audible(value: f64) -> bool {
    value.is_finite() && value > SILENCE_FLOOR_DB
}

/// Averages higher-resolution momentary readings into one value per second.
///
/// `samples_per_second` is the nominal reading rate; a value of zero or a
/// non-positive count yields an empty profile rather than a division by zero.
///
/// The result is positional: entry `i` covers the readings taken during second
/// `i`, which is the contract [`super::segmentation`] and [`super::esd`] rely
/// on when they address the profile by time.
///
/// Only the audible readings of a chunk are averaged. The floor sentinel is
/// not a level — it sits far below anything the meter would call quiet — so
/// averaging it in drags a second down in proportion to how much of it the
/// meter had not yet measured. Two windows make that concrete: the meter's
/// first 300 ms read the floor while the momentary window fills, and the
/// 400 ms after a silence read it again as the window refills over the join. A
/// chunk with no audible reading at all is a silent second and reads
/// [`SILENCE_FLOOR_DB`].
pub fn per_second_loudness_profile(samples: &[f64], samples_per_second: usize) -> Vec<f64> {
    if samples.is_empty() || samples_per_second == 0 {
        return Vec::new();
    }

    samples
        .chunks(samples_per_second)
        .map(|chunk| {
            let mut audible_count = 0usize;
            let mut audible_sum = 0.0;
            for value in chunk.iter().copied().filter(|value| is_audible(*value)) {
                audible_count += 1;
                audible_sum += value;
            }

            if audible_count == 0 {
                SILENCE_FLOOR_DB
            } else {
                audible_sum / audible_count as f64
            }
        })
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

/// What one frame line's momentary token turned out to be.
///
/// All three variants occupy a slot in the series - the positional contract
/// admits no gaps - but they are not the same news about the log.
enum MomentaryToken {
    /// A level this parser read and that measured audible content.
    Level(f64),
    /// Silence, in one of the spellings the meter uses for it.
    Silence,
    /// A token that is not a number at all, so the log is not what we expect.
    Unreadable,
}

/// Classifies the momentary token of one `ebur128` frame line.
///
/// Total by construction: every frame line yields a variant, and everything the
/// meter prints for "no signal" is [`MomentaryToken::Silence`]. That covers the
/// warm-up sentinel (`-120.7`) and a digital-silence window (a number far below
/// the floor, or the literal `nan` or `-inf` depending on the decoder).
/// Returning nothing for any of them would shorten the series and shift every
/// later second.
///
/// [`parse_leading_f64`] keeps rejecting non-finite tokens on purpose: in the
/// summary block a `nan` integrated loudness means "not measured", and only
/// here does it mean "silence".
fn momentary_token(line: &str) -> MomentaryToken {
    let marker = " M:";
    // Unreachable for a line `is_ebur128_frame_line` accepted; the function is
    // written to be total rather than to trust that the caller checked.
    let Some(position) = line.find(marker) else {
        return MomentaryToken::Unreadable;
    };

    let text = &line[position + marker.len()..];
    match parse_leading_f64(text) {
        Some(value) if is_audible(value) => MomentaryToken::Level(value),
        // A finite number at or below the floor: the warm-up sentinel, or a
        // digital-silence window read by a decoder that prints a figure.
        Some(_) => MomentaryToken::Silence,
        None if is_non_finite_token(text) => MomentaryToken::Silence,
        None => MomentaryToken::Unreadable,
    }
}

/// Returns whether the leading token spells a non-finite number.
///
/// `parse_leading_f64` rejects these on purpose - in the summary block `nan`
/// means "not measured" - but a per-frame `nan` or `-inf` is what an mp3 decode
/// of digital silence prints, so here it is silence rather than a log this
/// parser cannot read.
fn is_non_finite_token(text: &str) -> bool {
    let token = text.split_whitespace().next().unwrap_or("");
    let magnitude = token.trim_start_matches(['-', '+']).to_ascii_lowercase();
    matches!(magnitude.as_str(), "nan" | "inf" | "infinity")
}

/// Parses the first numeric token of `text`, ignoring trailing units.
///
/// Returns `None` for a non-finite token (`nan`, `-inf`) as well as for one
/// that is not a number at all: in the summary block both mean the value was
/// not measured. The per-frame path wants "silence" rather than "unmeasured",
/// so [`momentary_token`] maps `None` onto silence itself.
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

    /// Verbatim `ebur128` log of a 3 s mp3 whose middle second is digital
    /// silence, captured from the bundled FFmpeg 9.0.1 with the filter spelling
    /// this module pins.
    ///
    /// It carries every spelling of "no signal" the meter uses in one file:
    /// the `-120.7` warm-up while the momentary window fills (t < 0.4), the
    /// literal `nan` of a fully silent window (t 1.5–1.9), and the deep
    /// negative of a window that is only partly silent (`-102.4` at t 2.0).
    const EBUR128_REAL_MP3_LOG: &str = "\
[Parsed_ebur128_0 @ 00000152e352cec0] t: 0.0999792  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -18.4 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 0.199979   TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 0.299979   TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 0.399979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -22.2 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 0.499979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -22.2 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 0.599979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -22.2 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 0.699979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -22.2 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 0.799979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -22.2 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 0.899979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -22.2 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 0.999979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -22.2 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 1.099979   TARGET:-23 LUFS    M: -23.5 S:-120.7     I: -22.3 LUFS       LRA:   0.0 LU  FTPK: -20.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 1.199979   TARGET:-23 LUFS    M: -25.2 S:-120.7     I: -22.6 LUFS       LRA:   0.0 LU  FTPK:  -inf dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 1.299979   TARGET:-23 LUFS    M: -28.2 S:-120.7     I: -22.9 LUFS       LRA:   0.0 LU  FTPK:  -inf dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 1.399979   TARGET:-23 LUFS    M: -59.4 S:-120.7     I: -22.9 LUFS       LRA:   0.0 LU  FTPK:  -inf dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 1.499979   TARGET:-23 LUFS    M:   nan S:-120.7     I: -22.9 LUFS       LRA:   0.0 LU  FTPK:  -inf dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 1.599979   TARGET:-23 LUFS    M:   nan S:-120.7     I: -22.9 LUFS       LRA:   0.0 LU  FTPK:  -inf dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 1.699979   TARGET:-23 LUFS    M:   nan S:-120.7     I: -22.9 LUFS       LRA:   0.0 LU  FTPK:  -inf dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 1.799979   TARGET:-23 LUFS    M:   nan S:-120.7     I: -22.9 LUFS       LRA:   0.0 LU  FTPK:  -inf dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 1.899979   TARGET:-23 LUFS    M:   nan S:-120.7     I: -22.9 LUFS       LRA:   0.0 LU  FTPK:  -inf dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 1.999979   TARGET:-23 LUFS    M:-102.4 S:-120.7     I: -22.9 LUFS       LRA:   0.0 LU  FTPK: -80.3 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 2.099979   TARGET:-23 LUFS    M: -28.2 S:-120.7     I: -23.2 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 2.199979   TARGET:-23 LUFS    M: -25.2 S:-120.7     I: -23.3 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 2.299979   TARGET:-23 LUFS    M: -23.5 S:-120.7     I: -23.3 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 2.399979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -23.3 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 2.499979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -23.2 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 2.599979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -23.1 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 2.699979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -23.1 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 2.799979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -23.0 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 2.899979   TARGET:-23 LUFS    M: -22.2 S:-120.7     I: -23.0 LUFS       LRA:   0.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] t: 2.999979   TARGET:-23 LUFS    M: -22.2 S: -24.0     I: -22.9 LUFS       LRA:  20.0 LU  FTPK: -18.5 dBFS  TPK: -18.4 dBFS
[Parsed_ebur128_0 @ 00000152e352cec0] Summary:";

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
    /// Scenario: a frame line reports the meter warm-up sentinel
    ///   Given three frame lines, the last one at `-120.7`
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
    /// Scenario: a frame line carries a value that is not a finite number
    ///   Given frame lines whose `M:` values read `nan`, `-inf` and `abc`
    ///   When the momentary readings are parsed
    ///   Then each still yields one slot, at the silence floor
    ///
    /// `nan` is not hypothetical: it is what FFmpeg 9 prints for a window of
    /// digital silence decoded from mp3. Dropping those lines shortened the
    /// series and shifted every second after the silence.
    #[test]
    fn should_report_silence_when_a_frame_line_carries_a_non_finite_value() {
        let non_finite = "\
[Parsed_ebur128_0 @ 0x1] t: 0.1 M:   nan S: -22.0 I: -24.0 LUFS
[Parsed_ebur128_0 @ 0x1] t: 0.2 M: -inf S: -22.0 I: -24.0 LUFS
[Parsed_ebur128_0 @ 0x1] t: 0.3 M: abc S: -22.0 I: -24.0 LUFS
[Parsed_ebur128_0 @ 0x1] t: 0.4 M: -18.5 S: -22.0 I: -24.0 LUFS";

        assert_eq!(
            parse_momentary_loudness(non_finite),
            vec![SILENCE_FLOOR_DB, SILENCE_FLOOR_DB, SILENCE_FLOOR_DB, -18.5]
        );
    }

    /// Feature: momentary loudness parsing
    /// Scenario: telling an unreadable log apart from a silent one
    ///   Given frame lines spelling silence as `nan`, `-inf` and `-120.7`
    ///   And one frame line whose value is not a number at all
    ///   When the series is parsed
    ///   Then only the last one counts as unreadable
    ///
    /// Every line yields a floor reading either way, so the count is the only
    /// thing that separates "this file is silent" from "this log is not the one
    /// the parser was written for" — the distinction `measure_loudness` refuses
    /// a whole pass on.
    #[test]
    fn should_count_only_unreadable_tokens_rather_than_silent_ones() {
        let log = "[Parsed_ebur128_0 @ 0x1] t: 0.1 M:   nan S: -22.0
[Parsed_ebur128_0 @ 0x1] t: 0.2 M: -inf S: -22.0
[Parsed_ebur128_0 @ 0x1] t: 0.3 M: -120.7 S: -22.0
[Parsed_ebur128_0 @ 0x1] t: 0.4 M: ????? S: -22.0";

        let series = parse_momentary_series(log);

        assert_eq!(series.readings, vec![SILENCE_FLOOR_DB; 4]);
        assert_eq!(series.unreadable, 1);
    }

    /// Feature: momentary loudness parsing
    /// Scenario: a real FFmpeg 9 log of loud / digital silence / loud
    ///   Given the captured log of a 3 s mp3 whose middle second is silent
    ///   When the readings are parsed and folded into a per-second profile
    ///   Then there are 30 readings and 3 seconds, silent in the middle
    ///
    /// The regression this pins is the whole point of the module: the log
    /// carries six `nan` lines and three `-120.7` warm-up lines, and the parser
    /// that dropped them produced a 24-reading series that folded into two
    /// seconds — so second 2 of the audio was reported at index 1.
    #[test]
    fn should_stay_second_indexed_on_a_real_log_with_nan_and_warmup_lines() {
        let readings = parse_momentary_loudness(EBUR128_REAL_MP3_LOG);

        assert_eq!(readings.len(), 30, "a 3 s file must yield 30 frame slots");
        assert_eq!(readings[0], SILENCE_FLOOR_DB, "warm-up reads the floor");
        assert_eq!(readings[15], SILENCE_FLOOR_DB, "`nan` reads the floor");

        let profile = per_second_loudness_profile(&readings, 10);

        assert_eq!(profile.len(), 3, "a 3 s file must yield 3 profile entries");
        // Second 0 is loud despite its three warm-up readings: the floor
        // sentinel is excluded from the average rather than dragging it down.
        assert!(
            (profile[0] - (-22.2)).abs() < 0.3,
            "second 0 must read the tone, got {}",
            profile[0]
        );
        // Second 1 is the transition into the silence. Its `nan` readings drop
        // out of the average and what is left is the meter's 400 ms decay, so
        // it reads far below the tone without reaching the floor; a second
        // wholly inside the silence does reach it (see the real-FFmpeg test in
        // `super::super::audio`).
        assert!(
            profile[1] < profile[0] - 8.0,
            "second 1 must fall away from the tone, got {} against {}",
            profile[1],
            profile[0]
        );
        // Second 2 opens with the meter climbing back out of the silence, so
        // it sits a little under the tone rather than exactly on it.
        assert!(
            (profile[2] - (-22.2)).abs() < 1.5,
            "second 2 must read the tone again, got {}",
            profile[2]
        );
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
    ///   Given thirty frame lines whose middle ten print `nan`
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
            let momentary = if (10..20).contains(&index) {
                "  nan".to_string()
            } else {
                format!("{:.1}", -16.4)
            };
            log.push_str(&format!(
                "[Parsed_ebur128_0 @ 0x1] t: {:.1}   TARGET:-23 LUFS    M: {} S:-120.7\n",
                index as f64 / 10.0,
                momentary,
            ));
        }

        let profile = per_second_loudness_profile(&parse_momentary_loudness(&log), 10);

        assert_eq!(profile.len(), 3, "a 3 s signal must yield 3 entries");
        assert!((profile[0] - (-16.4)).abs() < 0.05);
        assert_eq!(profile[1], SILENCE_FLOOR_DB);
        assert!((profile[2] - (-16.4)).abs() < 0.05);
    }

    /// Feature: per-second loudness profile
    /// Scenario: a second is only partly measured
    ///   Given a second whose first three readings are the meter warm-up
    ///   When the profile is built
    ///   Then the second reads the level of its audible readings alone
    ///
    /// The warm-up is not a quiet part of the audio, it is the 300 ms before
    /// the momentary window has filled. Averaging it in put the opening second
    /// of every measured file tens of LU below the rest of the file.
    #[test]
    fn should_average_only_the_audible_readings_of_a_partly_silent_second() {
        let mut second = vec![SILENCE_FLOOR_DB; 3];
        second.extend(vec![-16.0; 7]);

        let profile = per_second_loudness_profile(&second, 10);

        assert_eq!(profile, vec![-16.0]);
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
