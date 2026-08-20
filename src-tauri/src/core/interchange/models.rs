//! Interchange Data Models
//!
//! Shared types for NLE interchange format export/import.
//! Provides timecode conversion utilities and format-agnostic event representation.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::borrow::Cow;
use std::fmt;
use std::fmt::Write;

use crate::core::Ratio;

// =============================================================================
// Export Format Enum
// =============================================================================

/// Supported interchange export formats
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum InterchangeFormat {
    /// CMX 3600 Edit Decision List
    Edl,
    /// Final Cut Pro XML (FCPXML v1.11)
    Fcpxml,
    /// OpenTimelineIO cut interchange
    Otio,
}

impl fmt::Display for InterchangeFormat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InterchangeFormat::Edl => write!(f, "EDL"),
            InterchangeFormat::Fcpxml => write!(f, "FCPXML"),
            InterchangeFormat::Otio => write!(f, "OTIO"),
        }
    }
}

// =============================================================================
// Timecode
// =============================================================================

/// SMPTE timecode representation (HH:MM:SS:FF)
///
/// Supports both drop-frame and non-drop-frame timecodes.
/// Drop-frame is used for 29.97fps and 59.94fps to maintain sync
/// with wall-clock time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Timecode {
    pub hours: u32,
    pub minutes: u32,
    pub seconds: u32,
    pub frames: u32,
    pub drop_frame: bool,
}

impl Timecode {
    /// Creates a timecode from seconds and frame rate.
    ///
    /// Automatically detects drop-frame for 29.97fps (30000/1001)
    /// and 59.94fps (60000/1001).
    pub fn from_seconds(seconds: f64, fps: &Ratio) -> Self {
        let fps_float = fps.as_f64();
        if fps_float <= 0.0 {
            return Self::zero(false);
        }

        let is_drop_frame = is_drop_frame_rate(fps);

        if is_drop_frame {
            Self::from_seconds_drop_frame(seconds, fps_float)
        } else {
            Self::from_seconds_non_drop(seconds, fps_float)
        }
    }

    /// Creates a zero timecode
    pub fn zero(drop_frame: bool) -> Self {
        Self {
            hours: 0,
            minutes: 0,
            seconds: 0,
            frames: 0,
            drop_frame,
        }
    }

    /// Converts seconds to non-drop-frame timecode
    fn from_seconds_non_drop(seconds: f64, fps: f64) -> Self {
        let total_frames = (seconds * fps).round() as u64;
        let fps_int = fps.round() as u64;
        if fps_int == 0 {
            return Self::zero(false);
        }

        let frames = (total_frames % fps_int) as u32;
        let total_seconds = total_frames / fps_int;
        let secs = (total_seconds % 60) as u32;
        let total_minutes = total_seconds / 60;
        let mins = (total_minutes % 60) as u32;
        let hrs = (total_minutes / 60) as u32;

        Self {
            hours: hrs,
            minutes: mins,
            seconds: secs,
            frames,
            drop_frame: false,
        }
    }

    /// Converts seconds to drop-frame timecode (29.97fps / 59.94fps)
    ///
    /// Drop-frame skips frame numbers 0 and 1 at the start of each minute,
    /// except every 10th minute, to keep timecode in sync with wall-clock time.
    fn from_seconds_drop_frame(seconds: f64, fps: f64) -> Self {
        let nominal_fps = fps.round() as u64; // 30 or 60
        let drop_count = if nominal_fps == 60 { 4u64 } else { 2u64 };

        let total_frames = (seconds * fps).round() as u64;

        // Frames per 10-minute block
        let frames_per_10min = nominal_fps * 60 * 10 - drop_count * 9;

        let d = total_frames / frames_per_10min;
        let m = total_frames % frames_per_10min;

        // Within the 10-minute block, figure out which minute
        let frames_per_min = nominal_fps * 60 - drop_count;
        let first_min_frames = nominal_fps * 60; // first minute of 10-min block has no drops

        let adjusted = if m < first_min_frames {
            // Within the first minute of the 10-minute block (no drops)
            total_frames + drop_count * 9 * d
        } else {
            let remaining = m - first_min_frames;
            let extra_mins = remaining / frames_per_min;
            total_frames + drop_count * 9 * d + drop_count * (extra_mins + 1)
        };

        let frames = (adjusted % nominal_fps) as u32;
        let secs = ((adjusted / nominal_fps) % 60) as u32;
        let mins = (((adjusted / nominal_fps) / 60) % 60) as u32;
        let hrs = (((adjusted / nominal_fps) / 60) / 60) as u32;

        Self {
            hours: hrs,
            minutes: mins,
            seconds: secs,
            frames,
            drop_frame: true,
        }
    }

    /// Converts timecode to total seconds at the given frame rate
    pub fn to_seconds(&self, fps: &Ratio) -> f64 {
        let fps_float = fps.as_f64();
        if fps_float <= 0.0 {
            return 0.0;
        }

        let nominal_fps = fps_float.round() as u64;
        if nominal_fps == 0 {
            return 0.0;
        }

        let total_frames_simple = (self.hours as u64) * 3600 * nominal_fps
            + (self.minutes as u64) * 60 * nominal_fps
            + (self.seconds as u64) * nominal_fps
            + (self.frames as u64);

        if self.drop_frame {
            let drop_count = if nominal_fps == 60 { 4u64 } else { 2u64 };
            let total_minutes = (self.hours as u64) * 60 + (self.minutes as u64);
            let ten_min_blocks = total_minutes / 10;
            let dropped = drop_count * (total_minutes - ten_min_blocks);
            let actual_frames = total_frames_simple - dropped;
            actual_frames as f64 / fps_float
        } else {
            total_frames_simple as f64 / fps_float
        }
    }
}

impl fmt::Display for Timecode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let separator = if self.drop_frame { ';' } else { ':' };
        write!(
            f,
            "{:02}:{:02}:{:02}{}{:02}",
            self.hours, self.minutes, self.seconds, separator, self.frames
        )
    }
}

// =============================================================================
// EDL Event (used by edl.rs)
// =============================================================================

/// Edit type in an EDL event
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EditType {
    /// Standard cut (no transition)
    Cut,
    /// Dissolve transition with duration in frames
    Dissolve(u32),
    /// Wipe with SMPTE wipe code and duration in frames
    Wipe(u32, u32),
}

impl fmt::Display for EditType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EditType::Cut => write!(f, "C"),
            EditType::Dissolve(dur) => write!(f, "D    {:03}", dur),
            EditType::Wipe(code, dur) => write!(f, "W{:03} {:03}", code, dur),
        }
    }
}

/// Channel assignment for an EDL event
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EdlChannel {
    /// Video only
    Video,
    /// Audio channel(s)
    Audio(Vec<u8>),
    /// Both video and audio
    Both(Vec<u8>),
    /// No specific channel
    None,
}

impl fmt::Display for EdlChannel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EdlChannel::Video => write!(f, "V"),
            EdlChannel::Audio(channels) => {
                write!(f, "A")?;
                for ch in channels {
                    write!(f, "{}", ch)?;
                }
                Ok(())
            }
            EdlChannel::Both(channels) => {
                write!(f, "B")?;
                for ch in channels {
                    write!(f, "{}", ch)?;
                }
                Ok(())
            }
            EdlChannel::None => write!(f, "NONE"),
        }
    }
}

/// A single EDL event (one line in CMX 3600 format)
#[derive(Clone, Debug)]
pub struct EdlEvent {
    /// Event number (001-999)
    pub event_number: u32,
    /// Reel name (max 8 chars for CMX 3600, derived from asset name)
    pub reel_name: String,
    /// Channel assignment
    pub channel: EdlChannel,
    /// Edit type (Cut, Dissolve, Wipe)
    pub edit_type: EditType,
    /// Source in timecode
    pub source_in: Timecode,
    /// Source out timecode
    pub source_out: Timecode,
    /// Record in timecode (timeline position)
    pub record_in: Timecode,
    /// Record out timecode (timeline position)
    pub record_out: Timecode,
    /// Optional clip name comment
    pub clip_name: Option<String>,
    /// Optional source file comment
    pub source_file: Option<String>,
    /// Speed change (if not 100%)
    pub speed: Option<f32>,
}

// =============================================================================
// Export Result
// =============================================================================

/// Result of an interchange format export operation
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InterchangeExportResult {
    /// Output file path
    pub output_path: String,
    /// Format exported
    pub format: InterchangeFormat,
    /// Number of events/clips exported
    pub event_count: u32,
    /// Number of tracks processed
    pub track_count: u32,
    /// Sequence duration in seconds
    pub duration_sec: f64,
    /// Structural notes about what the export had to change: skipped tracks,
    /// missing media, trimmed overlaps.
    ///
    /// Empty for formats that report nothing; never omitted, so a caller can
    /// tell "checked and clean" from "not reported".
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Editorial detail the format cannot carry.
    ///
    /// Interchange is lossy by nature, and a caller that hands the file to
    /// another tool needs to know what will not arrive with it.
    #[serde(default)]
    pub unsupported: Vec<String>,
}

// =============================================================================
// Helpers
// =============================================================================

/// Determines if a frame rate is drop-frame (29.97fps or 59.94fps).
///
/// Drop-frame rates are identified by their rational representation:
/// - 30000/1001 (≈29.97)
/// - 60000/1001 (≈59.94)
pub fn is_drop_frame_rate(fps: &Ratio) -> bool {
    fps.den == 1001 && (fps.num == 30000 || fps.num == 60000)
}

/// Percent-encodes a path for use inside a `file://` URL.
///
/// Path separators and the Windows drive colon are left intact; everything
/// outside the unreserved set is escaped.
fn encode_file_url_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());

    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                encoded.push(byte as char)
            }
            _ => {
                let _ = write!(encoded, "%{:02X}", byte);
            }
        }
    }

    encoded
}

/// Strips the Windows extended-length ("verbatim") prefix from a path.
///
/// `std::fs::canonicalize` returns verbatim paths on Windows, so an imported
/// asset's URI routinely reads `\\?\C:\media\clip.mp4`. That prefix is
/// meaningful to the Win32 API and meaningless to every NLE that reads a
/// `file://` URL — left in place it percent-encodes to `file:////%3F/C:/…`,
/// which resolves to nothing and shows up as offline media in the other tool.
///
/// `\\?\UNC\server\share` is the verbatim spelling of the share `\\server\share`
/// and is restored to it.
pub fn strip_verbatim_prefix(path: &str) -> Cow<'_, str> {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return Cow::Owned(format!(r"\\{rest}"));
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return Cow::Borrowed(rest);
    }
    Cow::Borrowed(path)
}

/// Converts an asset URI into the `file://` URL every interchange format wants.
///
/// Shared by FCPXML's `src` attribute and OTIO's `ExternalReference.target_url`
/// so the two formats name the same media the same way. A URI that is already a
/// `file://` URL is passed through untouched.
pub fn asset_src_url(uri: &str) -> String {
    if uri.starts_with("file://") {
        return uri.to_string();
    }

    let plain = strip_verbatim_prefix(uri);
    let normalized = plain.replace('\\', "/");
    let encoded = encode_file_url_path(&normalized);

    if let Some(share) = normalized.strip_prefix("//") {
        // A UNC share is the one case where a file URL carries an authority:
        // `\\server\share\x` is `file://server/share/x`.
        format!("file://{}", encode_file_url_path(share))
    } else if normalized.starts_with('/') {
        format!("file://{}", encoded)
    } else if normalized.as_bytes().get(1) == Some(&b':') {
        format!("file:///{}", encoded)
    } else {
        format!("file://{}", encoded)
    }
}

/// Recovers the filesystem path from a `file://` URL produced by
/// [`asset_src_url`].
///
/// Import needs this to match a foreign `target_url` against the assets already
/// in the project. Returns `None` for anything that is not a `file://` URL,
/// including the remote URLs OTIO also permits.
pub fn file_url_to_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;

    match rest.strip_prefix('/') {
        // `file:///C:/x` — a Windows drive letter follows the slash.
        Some(after) if after.as_bytes().get(1) == Some(&b':') => Some(percent_decode(after)),
        // `file:///media/x` — a POSIX absolute path; the slash is part of it.
        Some(_) => Some(percent_decode(rest)),
        // `file://server/share/x` — an authority, so a UNC share.
        None => Some(format!("//{}", percent_decode(rest))),
    }
}

/// Reverses [`encode_file_url_path`]. Invalid escapes are kept verbatim.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &input[index + 1..index + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

/// Truncates a string to fit within a maximum byte length,
/// ensuring no partial UTF-8 characters.
pub fn truncate_reel_name(name: &str, max_len: usize) -> String {
    // CMX 3600 reel names: max 8 characters, uppercase, alphanumeric + underscore
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(max_len)
        .collect();

    if cleaned.is_empty() {
        "AX".to_string()
    } else {
        cleaned.to_uppercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // Timecode Tests
    // =========================================================================

    #[test]
    fn should_convert_zero_seconds_to_zero_timecode() {
        let fps = Ratio::new(24, 1);
        let tc = Timecode::from_seconds(0.0, &fps);
        assert_eq!(tc.to_string(), "00:00:00:00");
    }

    #[test]
    fn should_convert_one_second_to_correct_timecode_at_24fps() {
        let fps = Ratio::new(24, 1);
        let tc = Timecode::from_seconds(1.0, &fps);
        assert_eq!(tc.to_string(), "00:00:01:00");
    }

    #[test]
    fn should_convert_one_hour_to_correct_timecode() {
        let fps = Ratio::new(30, 1);
        let tc = Timecode::from_seconds(3600.0, &fps);
        assert_eq!(tc.to_string(), "01:00:00:00");
    }

    #[test]
    fn should_handle_fractional_frames_at_25fps() {
        let fps = Ratio::new(25, 1);
        // 1.04 seconds = 1 second + 1 frame at 25fps
        let tc = Timecode::from_seconds(1.04, &fps);
        assert_eq!(tc.hours, 0);
        assert_eq!(tc.minutes, 0);
        assert_eq!(tc.seconds, 1);
        assert_eq!(tc.frames, 1);
    }

    #[test]
    fn should_use_semicolon_separator_for_drop_frame() {
        let fps = Ratio::new(30000, 1001);
        let tc = Timecode::from_seconds(0.0, &fps);
        assert!(tc.drop_frame);
        assert!(tc.to_string().contains(';'));
    }

    #[test]
    fn should_use_colon_separator_for_non_drop_frame() {
        let fps = Ratio::new(24, 1);
        let tc = Timecode::from_seconds(0.0, &fps);
        assert!(!tc.drop_frame);
        assert!(!tc.to_string().contains(';'));
    }

    #[test]
    fn should_handle_zero_fps_gracefully() {
        let fps = Ratio::new(0, 1);
        let tc = Timecode::from_seconds(10.0, &fps);
        assert_eq!(tc.to_string(), "00:00:00:00");
    }

    #[test]
    fn should_roundtrip_timecode_at_24fps() {
        let fps = Ratio::new(24, 1);
        let original_seconds = 3661.5; // 1h 1m 1s + 12 frames
        let tc = Timecode::from_seconds(original_seconds, &fps);
        let recovered = tc.to_seconds(&fps);
        assert!((original_seconds - recovered).abs() < 0.05);
    }

    // =========================================================================
    // Reel Name Tests
    // =========================================================================

    #[test]
    fn should_truncate_reel_name_to_max_length() {
        let result = truncate_reel_name("MyLongVideoFileName", 8);
        assert_eq!(result.len(), 8);
        assert_eq!(result, "MYLONGVI");
    }

    #[test]
    fn should_strip_special_characters_from_reel_name() {
        let result = truncate_reel_name("my video (1).mp4", 8);
        assert_eq!(result, "MYVIDEO1");
    }

    #[test]
    fn should_return_ax_for_empty_reel_name() {
        let result = truncate_reel_name("", 8);
        assert_eq!(result, "AX");
    }

    // =========================================================================
    // Media URL Tests
    // =========================================================================

    #[test]
    fn should_encode_asset_paths_as_file_urls() {
        assert_eq!(
            asset_src_url("/media/My Clip #1.mp4"),
            "file:///media/My%20Clip%20%231.mp4"
        );
        assert_eq!(
            asset_src_url(r#"C:\Projects\My Clip.mp4"#),
            "file:///C:/Projects/My%20Clip.mp4"
        );
    }

    #[test]
    fn should_pass_through_a_uri_that_is_already_a_file_url() {
        assert_eq!(
            asset_src_url("file:///media/clip.mp4"),
            "file:///media/clip.mp4"
        );
    }

    #[test]
    fn should_recover_the_original_path_from_a_file_url() {
        for path in [
            "/media/My Clip #1.mp4",
            r#"C:\Projects\My Clip.mp4"#,
            "/media/한글.mp4",
            r#"\\server\share\My Clip.mp4"#,
        ] {
            let url = asset_src_url(path);
            let recovered = file_url_to_path(&url).expect("a file URL should decode");
            assert_eq!(recovered, path.replace('\\', "/"));
        }
    }

    #[test]
    fn should_drop_the_windows_verbatim_prefix_from_a_media_url() {
        // Given: the path shape `std::fs::canonicalize` returns on Windows,
        // which is what an imported asset's URI actually holds
        let verbatim = r#"\\?\C:\Media\My Clip.mp4"#;

        // Then: the URL names the file, not the Win32 escape hatch. Left in,
        // `\\?\` encodes to `file:////%3F/C:/…` and every NLE reads it as
        // offline media.
        assert_eq!(asset_src_url(verbatim), "file:///C:/Media/My%20Clip.mp4");
        assert_eq!(
            file_url_to_path(&asset_src_url(verbatim)).as_deref(),
            Some("C:/Media/My Clip.mp4")
        );
    }

    #[test]
    fn should_restore_a_share_from_the_verbatim_unc_spelling() {
        assert_eq!(
            asset_src_url(r#"\\?\UNC\server\share\clip.mp4"#),
            "file://server/share/clip.mp4"
        );
        assert_eq!(
            file_url_to_path("file://server/share/clip.mp4").as_deref(),
            Some("//server/share/clip.mp4")
        );
    }

    #[test]
    fn should_leave_a_path_without_a_verbatim_prefix_alone() {
        assert_eq!(strip_verbatim_prefix("/media/clip.mp4"), "/media/clip.mp4");
        assert_eq!(
            strip_verbatim_prefix(r#"C:\Media\clip.mp4"#),
            r#"C:\Media\clip.mp4"#
        );
    }

    #[test]
    fn should_not_decode_a_non_file_url() {
        assert_eq!(file_url_to_path("https://example.com/clip.mp4"), None);
    }

    #[test]
    fn should_detect_drop_frame_rates() {
        assert!(is_drop_frame_rate(&Ratio::new(30000, 1001)));
        assert!(is_drop_frame_rate(&Ratio::new(60000, 1001)));
        assert!(!is_drop_frame_rate(&Ratio::new(24, 1)));
        assert!(!is_drop_frame_rate(&Ratio::new(25, 1)));
        assert!(!is_drop_frame_rate(&Ratio::new(30, 1)));
    }
}
