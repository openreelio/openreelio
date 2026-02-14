//! Shared input normalization and validation for video-generation IPC.

use crate::core::generative::video::{VideoGenMode, VideoQuality};

/// Normalize enum-like string inputs from the frontend.
pub fn normalize_enum_input(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

/// Parse a user-facing generation mode string into a typed enum.
pub fn parse_mode(mode: &str) -> Result<VideoGenMode, String> {
    match mode {
        "text_to_video" => Ok(VideoGenMode::TextToVideo),
        "image_to_video" => Ok(VideoGenMode::ImageToVideo),
        "multimodal" => Ok(VideoGenMode::Multimodal),
        _ => Err(format!(
            "Invalid video generation mode: '{}'. Valid: text_to_video, image_to_video, multimodal",
            mode
        )),
    }
}

/// Parse a user-facing quality string into a typed enum.
pub fn parse_quality(quality: &str) -> Result<VideoQuality, String> {
    match quality {
        "basic" => Ok(VideoQuality::Basic),
        "pro" => Ok(VideoQuality::Pro),
        "cinema" => Ok(VideoQuality::Cinema),
        _ => Err(format!(
            "Invalid video quality: '{}'. Valid: basic, pro, cinema",
            quality
        )),
    }
}

/// Convert quality enum to stable wire string.
pub fn quality_to_wire_value(quality: VideoQuality) -> &'static str {
    match quality {
        VideoQuality::Basic => "basic",
        VideoQuality::Pro => "pro",
        VideoQuality::Cinema => "cinema",
    }
}

/// Validate and normalize Seedance base URL.
///
/// - Requires http/https
/// - Trims whitespace
/// - Removes trailing slash
pub fn validate_base_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Base URL cannot be empty".to_string());
    }

    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|e| format!("Invalid base URL '{}': {}", trimmed, e))?;

    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.trim_end_matches('/').to_string()),
        scheme => Err(format!(
            "Invalid base URL scheme '{}'. Use http or https.",
            scheme
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_enum_input_trims_and_lowercases() {
        assert_eq!(normalize_enum_input("  PRO  "), "pro");
        assert_eq!(normalize_enum_input("Image_To_Video"), "image_to_video");
    }

    #[test]
    fn parse_mode_rejects_invalid_values() {
        assert!(parse_mode("unsupported").is_err());
    }

    #[test]
    fn parse_quality_rejects_invalid_values() {
        assert!(parse_quality("ultra").is_err());
    }

    #[test]
    fn quality_to_wire_value_maps_expected_values() {
        assert_eq!(quality_to_wire_value(VideoQuality::Basic), "basic");
        assert_eq!(quality_to_wire_value(VideoQuality::Pro), "pro");
        assert_eq!(quality_to_wire_value(VideoQuality::Cinema), "cinema");
    }

    #[test]
    fn validate_base_url_accepts_http_and_https() {
        assert_eq!(
            validate_base_url("https://api.example.com/").unwrap(),
            "https://api.example.com"
        );
        assert_eq!(
            validate_base_url("http://localhost:8080").unwrap(),
            "http://localhost:8080"
        );
    }

    #[test]
    fn validate_base_url_rejects_invalid_scheme() {
        assert!(validate_base_url("file:///tmp/test").is_err());
    }

    #[test]
    fn validate_base_url_rejects_empty() {
        assert!(validate_base_url("   ").is_err());
    }
}
