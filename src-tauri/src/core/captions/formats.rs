//! Caption Format Parsers and Exporters
//!
//! Supports parsing and exporting captions in various formats:
//! - SRT (SubRip)
//! - VTT (WebVTT)
//!
//! # Example
//!
//! ```rust,ignore
//! use crate::core::captions::{parse_srt, export_vtt, CaptionTrack};
//!
//! // Parse SRT file
//! let srt_content = std::fs::read_to_string("subtitles.srt")?;
//! let captions = parse_srt(&srt_content)?;
//!
//! // Export to VTT
//! let vtt_content = export_vtt(&captions);
//! ```

use super::{Caption, CaptionTrack};

// =============================================================================
// Error Types
// =============================================================================

/// Errors that can occur during caption parsing
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Invalid timestamp format
    InvalidTimestamp(String),
    /// Invalid caption format
    InvalidFormat(String),
    /// Missing required data
    MissingData(String),
    /// Unexpected end of input
    UnexpectedEnd,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidTimestamp(s) => write!(f, "Invalid timestamp: {}", s),
            Self::InvalidFormat(s) => write!(f, "Invalid format: {}", s),
            Self::MissingData(s) => write!(f, "Missing data: {}", s),
            Self::UnexpectedEnd => write!(f, "Unexpected end of input"),
        }
    }
}

impl std::error::Error for ParseError {}

// =============================================================================
// SRT Format
// =============================================================================

/// Parses SRT (SubRip) format content into a list of captions
///
/// # SRT Format
///
/// ```text
/// 1
/// 00:00:01,000 --> 00:00:04,000
/// First caption text
///
/// 2
/// 00:00:05,500 --> 00:00:08,000
/// Second caption text
/// with multiple lines
/// ```
pub fn parse_srt(content: &str) -> Result<Vec<Caption>, ParseError> {
    let mut captions = Vec::new();
    let mut lines = content.lines().peekable();
    let mut index = 0;

    while lines.peek().is_some() {
        // Skip empty lines
        while lines.peek().is_some_and(|l| l.trim().is_empty()) {
            lines.next();
        }

        if lines.peek().is_none() {
            break;
        }

        // Parse sequence number (optional validation)
        let _seq = lines.next().ok_or(ParseError::UnexpectedEnd)?;

        // Parse timestamp line
        let timestamp_line = lines.next().ok_or(ParseError::UnexpectedEnd)?;
        let (start_sec, end_sec) = parse_srt_timestamp_line(timestamp_line)?;

        // Parse text (may be multiple lines)
        let mut text_lines = Vec::new();
        while let Some(line) = lines.peek() {
            if line.trim().is_empty() {
                break;
            }
            text_lines.push(lines.next().unwrap().to_string());
        }

        if text_lines.is_empty() {
            return Err(ParseError::MissingData("Caption text".to_string()));
        }

        let text = text_lines.join("\n");
        let id = format!("srt_{}", index);
        captions.push(Caption::new(&id, start_sec, end_sec, &text));
        index += 1;
    }

    Ok(captions)
}

/// Parses an SRT timestamp line (e.g., "00:00:01,000 --> 00:00:04,000")
fn parse_srt_timestamp_line(line: &str) -> Result<(f64, f64), ParseError> {
    let parts: Vec<&str> = line.split("-->").collect();
    if parts.len() != 2 {
        return Err(ParseError::InvalidFormat(format!(
            "Expected 'start --> end' format: {}",
            line
        )));
    }

    let start = parse_srt_timestamp(parts[0].trim())?;
    let end = parse_srt_timestamp(parts[1].trim())?;

    Ok((start, end))
}

/// Parses an SRT timestamp (e.g., "00:01:23,456") into seconds
fn parse_srt_timestamp(ts: &str) -> Result<f64, ParseError> {
    // Format: HH:MM:SS,mmm or HH:MM:SS.mmm
    let normalized = ts.replace(',', ".");
    let parts: Vec<&str> = normalized.split(':').collect();

    if parts.len() != 3 {
        return Err(ParseError::InvalidTimestamp(ts.to_string()));
    }

    let hours: f64 = parts[0]
        .parse()
        .map_err(|_| ParseError::InvalidTimestamp(ts.to_string()))?;
    let minutes: f64 = parts[1]
        .parse()
        .map_err(|_| ParseError::InvalidTimestamp(ts.to_string()))?;
    let seconds: f64 = parts[2]
        .parse()
        .map_err(|_| ParseError::InvalidTimestamp(ts.to_string()))?;

    Ok(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// Exports captions to SRT format
pub fn export_srt(captions: &[Caption]) -> String {
    let mut output = String::new();

    for (index, caption) in captions.iter().enumerate() {
        // Sequence number
        output.push_str(&format!("{}\n", index + 1));

        // Timestamps
        let start = format_srt_timestamp(caption.start_sec);
        let end = format_srt_timestamp(caption.end_sec);
        output.push_str(&format!("{} --> {}\n", start, end));

        // Text
        output.push_str(&caption.text);
        output.push_str("\n\n");
    }

    output.trim_end().to_string()
}

/// Formats seconds as SRT timestamp (00:00:00,000)
fn format_srt_timestamp(seconds: f64) -> String {
    let total_ms = (seconds * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_secs = total_ms / 1000;
    let secs = total_secs % 60;
    let total_mins = total_secs / 60;
    let mins = total_mins % 60;
    let hours = total_mins / 60;

    format!("{:02}:{:02}:{:02},{:03}", hours, mins, secs, ms)
}

// =============================================================================
// VTT Format
// =============================================================================

/// Parses WebVTT format content into a list of captions
///
/// # VTT Format
///
/// ```text
/// WEBVTT
///
/// 00:00:01.000 --> 00:00:04.000
/// First caption text
///
/// 00:00:05.500 --> 00:00:08.000
/// Second caption text
/// ```
pub fn parse_vtt(content: &str) -> Result<Vec<Caption>, ParseError> {
    let mut captions = Vec::new();
    let mut lines = content.lines().peekable();
    let mut index = 0;

    // Skip WEBVTT header
    if let Some(first_line) = lines.next() {
        if !first_line.starts_with("WEBVTT") {
            return Err(ParseError::InvalidFormat(
                "VTT file must start with WEBVTT".to_string(),
            ));
        }
    }

    // Skip any header metadata (lines before first blank line after WEBVTT)
    while lines.peek().is_some_and(|l| !l.trim().is_empty()) {
        lines.next();
    }

    while lines.peek().is_some() {
        // Skip empty lines
        while lines.peek().is_some_and(|l| l.trim().is_empty()) {
            lines.next();
        }

        if lines.peek().is_none() {
            break;
        }

        // Check if this is a cue identifier (optional in VTT)
        let first_line = lines.next().ok_or(ParseError::UnexpectedEnd)?;

        let timestamp_line = if first_line.contains("-->") {
            first_line
        } else {
            // This was a cue identifier, next line should be timestamp
            lines.next().ok_or(ParseError::UnexpectedEnd)?
        };

        // Parse timestamp line
        let (start_sec, end_sec) = parse_vtt_timestamp_line(timestamp_line)?;

        // Parse text (may be multiple lines)
        let mut text_lines = Vec::new();
        while let Some(line) = lines.peek() {
            if line.trim().is_empty() {
                break;
            }
            text_lines.push(lines.next().unwrap().to_string());
        }

        if text_lines.is_empty() {
            return Err(ParseError::MissingData("Caption text".to_string()));
        }

        // Remove VTT tags from text
        let text = text_lines
            .iter()
            .map(|l| strip_vtt_tags(l))
            .collect::<Vec<_>>()
            .join("\n");

        let id = format!("vtt_{}", index);
        captions.push(Caption::new(&id, start_sec, end_sec, &text));
        index += 1;
    }

    Ok(captions)
}

/// Parses a VTT timestamp line (e.g., "00:00:01.000 --> 00:00:04.000")
fn parse_vtt_timestamp_line(line: &str) -> Result<(f64, f64), ParseError> {
    let parts: Vec<&str> = line.split("-->").collect();
    if parts.len() != 2 {
        return Err(ParseError::InvalidFormat(format!(
            "Expected 'start --> end' format: {}",
            line
        )));
    }

    // Handle optional cue settings after end timestamp
    let start_str = parts[0].trim();
    let end_part = parts[1].trim();
    let end_str = end_part.split_whitespace().next().unwrap_or(end_part);

    let start = parse_vtt_timestamp(start_str)?;
    let end = parse_vtt_timestamp(end_str)?;

    Ok((start, end))
}

/// Parses a VTT timestamp (e.g., "00:01:23.456" or "01:23.456") into seconds
fn parse_vtt_timestamp(ts: &str) -> Result<f64, ParseError> {
    let parts: Vec<&str> = ts.split(':').collect();

    match parts.len() {
        // MM:SS.mmm format
        2 => {
            let minutes: f64 = parts[0]
                .parse()
                .map_err(|_| ParseError::InvalidTimestamp(ts.to_string()))?;
            let seconds: f64 = parts[1]
                .parse()
                .map_err(|_| ParseError::InvalidTimestamp(ts.to_string()))?;
            Ok(minutes * 60.0 + seconds)
        }
        // HH:MM:SS.mmm format
        3 => {
            let hours: f64 = parts[0]
                .parse()
                .map_err(|_| ParseError::InvalidTimestamp(ts.to_string()))?;
            let minutes: f64 = parts[1]
                .parse()
                .map_err(|_| ParseError::InvalidTimestamp(ts.to_string()))?;
            let seconds: f64 = parts[2]
                .parse()
                .map_err(|_| ParseError::InvalidTimestamp(ts.to_string()))?;
            Ok(hours * 3600.0 + minutes * 60.0 + seconds)
        }
        _ => Err(ParseError::InvalidTimestamp(ts.to_string())),
    }
}

/// Strips VTT formatting tags from text
fn strip_vtt_tags(text: &str) -> String {
    // Simple regex-free approach: remove <...> tags
    let mut result = String::new();
    let mut in_tag = false;

    for c in text.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(c),
            _ => {}
        }
    }

    result
}

/// Exports captions to WebVTT format
pub fn export_vtt(captions: &[Caption]) -> String {
    let mut output = String::from("WEBVTT\n\n");

    for caption in captions {
        // Timestamps
        let start = format_vtt_timestamp(caption.start_sec);
        let end = format_vtt_timestamp(caption.end_sec);
        output.push_str(&format!("{} --> {}\n", start, end));

        // Text
        output.push_str(&caption.text);
        output.push_str("\n\n");
    }

    output.trim_end().to_string()
}

/// Formats seconds as VTT timestamp (00:00:00.000)
fn format_vtt_timestamp(seconds: f64) -> String {
    let total_ms = (seconds * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_secs = total_ms / 1000;
    let secs = total_secs % 60;
    let total_mins = total_secs / 60;
    let mins = total_mins % 60;
    let hours = total_mins / 60;

    format!("{:02}:{:02}:{:02}.{:03}", hours, mins, secs, ms)
}

// =============================================================================
// Track Utilities
// =============================================================================

/// Creates a CaptionTrack from parsed captions
pub fn captions_to_track(captions: Vec<Caption>, name: &str, language: &str) -> CaptionTrack {
    let mut track = CaptionTrack::create(name, language);
    for caption in captions {
        track.add_caption(caption);
    }
    track
}

/// Exports a CaptionTrack to SRT format
pub fn track_to_srt(track: &CaptionTrack) -> String {
    export_srt(&track.captions)
}

/// Exports a CaptionTrack to VTT format
pub fn track_to_vtt(track: &CaptionTrack) -> String {
    export_vtt(&track.captions)
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // SRT Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_srt_basic() {
        let srt = r#"1
00:00:01,000 --> 00:00:04,000
Hello World

2
00:00:05,500 --> 00:00:08,000
Second caption
"#;

        let captions = parse_srt(srt).unwrap();
        assert_eq!(captions.len(), 2);

        assert_eq!(captions[0].start_sec, 1.0);
        assert_eq!(captions[0].end_sec, 4.0);
        assert_eq!(captions[0].text, "Hello World");

        assert_eq!(captions[1].start_sec, 5.5);
        assert_eq!(captions[1].end_sec, 8.0);
        assert_eq!(captions[1].text, "Second caption");
    }

    #[test]
    fn test_parse_srt_multiline() {
        let srt = r#"1
00:00:00,000 --> 00:00:05,000
Line one
Line two
Line three
"#;

        let captions = parse_srt(srt).unwrap();
        assert_eq!(captions.len(), 1);
        assert_eq!(captions[0].text, "Line one\nLine two\nLine three");
    }

    #[test]
    fn test_parse_srt_timestamp() {
        assert_eq!(parse_srt_timestamp("00:00:01,500").unwrap(), 1.5);
        assert_eq!(parse_srt_timestamp("00:01:30,000").unwrap(), 90.0);
        assert_eq!(parse_srt_timestamp("01:30:00,000").unwrap(), 5400.0);
        assert_eq!(parse_srt_timestamp("00:00:00,100").unwrap(), 0.1);
    }

    #[test]
    fn test_format_srt_timestamp() {
        assert_eq!(format_srt_timestamp(0.0), "00:00:00,000");
        assert_eq!(format_srt_timestamp(1.5), "00:00:01,500");
        assert_eq!(format_srt_timestamp(90.0), "00:01:30,000");
        assert_eq!(format_srt_timestamp(5400.0), "01:30:00,000");
    }

    #[test]
    fn test_export_srt() {
        let captions = vec![
            Caption::new("1", 1.0, 4.0, "Hello World"),
            Caption::new("2", 5.5, 8.0, "Second caption"),
        ];

        let srt = export_srt(&captions);
        assert!(srt.contains("00:00:01,000 --> 00:00:04,000"));
        assert!(srt.contains("Hello World"));
        assert!(srt.contains("00:00:05,500 --> 00:00:08,000"));
    }

    // -------------------------------------------------------------------------
    // VTT Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_vtt_basic() {
        let vtt = r#"WEBVTT

00:00:01.000 --> 00:00:04.000
Hello World

00:00:05.500 --> 00:00:08.000
Second caption
"#;

        let captions = parse_vtt(vtt).unwrap();
        assert_eq!(captions.len(), 2);

        assert_eq!(captions[0].start_sec, 1.0);
        assert_eq!(captions[0].end_sec, 4.0);
        assert_eq!(captions[0].text, "Hello World");
    }

    #[test]
    fn test_parse_vtt_with_cue_identifiers() {
        let vtt = r#"WEBVTT

cue1
00:00:01.000 --> 00:00:04.000
First cue

cue2
00:00:05.000 --> 00:00:08.000
Second cue
"#;

        let captions = parse_vtt(vtt).unwrap();
        assert_eq!(captions.len(), 2);
    }

    #[test]
    fn test_parse_vtt_with_tags() {
        let vtt = r#"WEBVTT

00:00:01.000 --> 00:00:04.000
<v Speaker>Hello World</v>

00:00:05.000 --> 00:00:08.000
<b>Bold</b> and <i>italic</i>
"#;

        let captions = parse_vtt(vtt).unwrap();
        assert_eq!(captions[0].text, "Hello World");
        assert_eq!(captions[1].text, "Bold and italic");
    }

    #[test]
    fn test_parse_vtt_short_timestamp() {
        let vtt = r#"WEBVTT

01:23.456 --> 02:34.567
Short format
"#;

        let captions = parse_vtt(vtt).unwrap();
        assert_eq!(captions[0].start_sec, 83.456);
    }

    #[test]
    fn test_format_vtt_timestamp() {
        assert_eq!(format_vtt_timestamp(0.0), "00:00:00.000");
        assert_eq!(format_vtt_timestamp(1.5), "00:00:01.500");
        assert_eq!(format_vtt_timestamp(90.0), "00:01:30.000");
    }

    #[test]
    fn test_export_vtt() {
        let captions = vec![
            Caption::new("1", 1.0, 4.0, "Hello World"),
            Caption::new("2", 5.5, 8.0, "Second caption"),
        ];

        let vtt = export_vtt(&captions);
        assert!(vtt.starts_with("WEBVTT"));
        assert!(vtt.contains("00:00:01.000 --> 00:00:04.000"));
        assert!(vtt.contains("Hello World"));
    }

    // -------------------------------------------------------------------------
    // Roundtrip Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_srt_roundtrip() {
        let original = vec![
            Caption::new("1", 1.0, 4.0, "First caption"),
            Caption::new("2", 5.5, 8.5, "Second\nMultiline"),
        ];

        let srt = export_srt(&original);
        let parsed = parse_srt(&srt).unwrap();

        assert_eq!(parsed.len(), original.len());
        assert_eq!(parsed[0].start_sec, original[0].start_sec);
        assert_eq!(parsed[0].end_sec, original[0].end_sec);
        assert_eq!(parsed[0].text, original[0].text);
        assert_eq!(parsed[1].text, original[1].text);
    }

    #[test]
    fn test_vtt_roundtrip() {
        let original = vec![
            Caption::new("1", 1.0, 4.0, "First caption"),
            Caption::new("2", 5.5, 8.5, "Second caption"),
        ];

        let vtt = export_vtt(&original);
        let parsed = parse_vtt(&vtt).unwrap();

        assert_eq!(parsed.len(), original.len());
        assert_eq!(parsed[0].start_sec, original[0].start_sec);
        assert_eq!(parsed[0].text, original[0].text);
    }

    // -------------------------------------------------------------------------
    // Track Utility Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_captions_to_track() {
        let captions = vec![
            Caption::new("1", 0.0, 2.0, "First"),
            Caption::new("2", 3.0, 5.0, "Second"),
        ];

        let track = captions_to_track(captions, "English", "en");
        assert_eq!(track.name, "English");
        assert_eq!(track.language, "en");
        assert_eq!(track.len(), 2);
    }

    // -------------------------------------------------------------------------
    // Error Handling Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_srt_invalid_timestamp() {
        let srt = r#"1
00:00:invalid --> 00:00:04,000
Hello
"#;

        let result = parse_srt(srt);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            ParseError::InvalidTimestamp(_)
        ));
    }

    #[test]
    fn test_parse_vtt_missing_header() {
        let vtt = r#"00:00:01.000 --> 00:00:04.000
Hello
"#;

        let result = parse_vtt(vtt);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), ParseError::InvalidFormat(_)));
    }
}
