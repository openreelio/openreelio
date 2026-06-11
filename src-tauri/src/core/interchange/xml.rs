//! FCPXML Export
//!
//! Generates Final Cut Pro XML (FCPXML v1.11) for interoperability
//! with Final Cut Pro, DaVinci Resolve, and other NLEs.
//!
//! ## Format Overview
//!
//! FCPXML uses a resource-based model:
//! - `<resources>` section declares formats and media assets
//! - `<library>/<event>/<project>` contains the timeline
//! - `<sequence>/<spine>` contains clips in linear order
//! - Time is expressed as rational fractions (e.g., "10/1s" = 10 seconds)
//!
//! ## Limitations
//!
//! - Only basic clip placement and source ranges are exported
//! - Effects, keyframes, and color grading are not mapped
//! - Complex multi-track compositing is simplified to spine + lane offsets
//! - Audio keyframes are not exported (volume/pan only at clip level)

use std::collections::HashMap;
use std::fmt::Write;

use crate::core::assets::Asset;
use crate::core::timeline::{Sequence, Track, TrackKind};
use crate::core::Ratio;

use super::models::{InterchangeExportResult, InterchangeFormat};

// =============================================================================
// Public API
// =============================================================================

/// Exports a sequence to FCPXML v1.11 format string.
///
/// Generates a complete FCPXML document with:
/// - Format resource matching the sequence resolution and frame rate
/// - Asset resources for all referenced media files
/// - A project with spine-based timeline containing all clips
///
/// # Arguments
/// * `sequence` - The sequence to export
/// * `assets` - Asset map for resolving clip source metadata
///
/// # Returns
/// A tuple of (fcpxml_content, event_count, track_count)
pub fn export_fcpxml(
    sequence: &Sequence,
    assets: &HashMap<String, Asset>,
) -> Result<(String, u32, u32), String> {
    let mut output = String::with_capacity(8192);
    let fps = &sequence.format.fps;

    // XML declaration and DOCTYPE
    writeln!(output, r#"<?xml version="1.0" encoding="UTF-8"?>"#).map_err(|e| e.to_string())?;
    writeln!(output, "<!DOCTYPE fcpxml>").map_err(|e| e.to_string())?;
    writeln!(output, r#"<fcpxml version="1.11">"#).map_err(|e| e.to_string())?;

    // Resources section
    write_resources(&mut output, sequence, assets, fps)?;

    // Library > Event > Project > Sequence
    let (event_count, track_count) = write_library(&mut output, sequence, assets, fps)?;

    writeln!(output, "</fcpxml>").map_err(|e| e.to_string())?;

    Ok((output, event_count, track_count))
}

/// Builds an `InterchangeExportResult` from the export output.
pub fn build_export_result(
    output_path: &str,
    event_count: u32,
    track_count: u32,
    duration_sec: f64,
) -> InterchangeExportResult {
    InterchangeExportResult {
        output_path: output_path.to_string(),
        format: InterchangeFormat::Fcpxml,
        event_count,
        track_count,
        duration_sec,
    }
}

// =============================================================================
// Internal: Time Formatting
// =============================================================================

/// Converts seconds to FCPXML rational time format.
///
/// FCPXML uses rational time strings like "10/1s", "5005/2500s", etc.
/// We use the sequence frame rate denominator to maintain precision.
fn rational_time(seconds: f64, fps: &Ratio) -> String {
    if seconds == 0.0 {
        return "0/1s".to_string();
    }

    if fps.num <= 0 || fps.den <= 0 {
        return "0/1s".to_string();
    }

    // Quantize to the nearest timeline frame so fractional frame rates
    // like 30000/1001 remain frame-accurate in the exported XML.
    let total_frames = (seconds * fps.num as f64 / fps.den as f64).round() as i64;
    let numerator = total_frames * fps.den as i64;
    let denominator = fps.num as i64;

    // Simplify fraction
    let g = gcd(numerator.unsigned_abs(), denominator.unsigned_abs());
    if g > 0 {
        format!("{}/{}s", numerator / g as i64, denominator / g as i64)
    } else {
        format!("{}/{}s", numerator, denominator)
    }
}

/// Converts seconds to FCPXML duration format using the frame rate numerator.
/// For frame-accurate durations, we express in terms of fps timebase.
fn frame_duration(fps: &Ratio) -> String {
    // Single frame duration: den/num seconds
    // e.g., 24fps → "100/2400s", 30000/1001 → "1001/30000s"
    let num = fps.den as i64;
    let den = fps.num as i64;
    let g = gcd(num.unsigned_abs(), den.unsigned_abs());
    if g > 0 {
        format!("{}/{}s", num / g as i64, den / g as i64)
    } else {
        format!("{}/{}s", num, den)
    }
}

/// Greatest common divisor (Euclidean algorithm)
fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = b;
        b = a % b;
        a = t;
    }
    a
}

// =============================================================================
// Internal: XML Escaping
// =============================================================================

/// Escapes special XML characters in attribute values
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&apos;")
}

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

fn asset_src_url(uri: &str) -> String {
    if uri.starts_with("file://") {
        return uri.to_string();
    }

    let normalized = uri.replace('\\', "/");
    let encoded = encode_file_url_path(&normalized);

    if normalized.starts_with('/') {
        format!("file://{}", encoded)
    } else if normalized.as_bytes().get(1) == Some(&b':') {
        format!("file:///{}", encoded)
    } else {
        format!("file://{}", encoded)
    }
}

// =============================================================================
// Internal: Resources Section
// =============================================================================

fn write_resources(
    output: &mut String,
    sequence: &Sequence,
    assets: &HashMap<String, Asset>,
    fps: &Ratio,
) -> Result<(), String> {
    writeln!(output, "  <resources>").map_err(|e| e.to_string())?;

    // Format resource (r1)
    let frame_dur = frame_duration(fps);
    writeln!(
        output,
        r#"    <format id="r1" name="{name}" width="{w}" height="{h}" frameDuration="{fd}"/>"#,
        name = xml_escape(&format!(
            "FFVideoFormat{}x{}p{}",
            sequence.format.canvas.width,
            sequence.format.canvas.height,
            fps.as_f64().round() as u32
        )),
        w = sequence.format.canvas.width,
        h = sequence.format.canvas.height,
        fd = frame_dur,
    )
    .map_err(|e| e.to_string())?;

    // Asset resources (r2, r3, ...)
    // Collect unique asset IDs referenced by clips
    let mut referenced_assets: Vec<&str> = Vec::new();
    for track in &sequence.tracks {
        for clip in &track.clips {
            if clip.enabled && !referenced_assets.contains(&clip.asset_id.as_str()) {
                referenced_assets.push(&clip.asset_id);
            }
        }
    }

    for (i, asset_id) in referenced_assets.iter().enumerate() {
        if let Some(asset) = assets.get(*asset_id) {
            let resource_id = format!("r{}", i + 2); // r2, r3, ...
            let duration = asset
                .duration_sec
                .map(|d| rational_time(d, fps))
                .unwrap_or_else(|| "0/1s".to_string());

            let has_video = asset.video.is_some();
            let has_audio = asset.audio.is_some()
                || matches!(asset.kind, crate::core::assets::AssetKind::Audio);

            writeln!(
                output,
                r#"    <asset id="{rid}" name="{name}" src="{src}" start="0/1s" duration="{dur}" hasVideo="{hv}" hasAudio="{ha}" format="r1"/>"#,
                rid = resource_id,
                name = xml_escape(&asset.name),
                src = xml_escape(&asset_src_url(&asset.uri)),
                dur = duration,
                hv = if has_video { "1" } else { "0" },
                ha = if has_audio { "1" } else { "0" },
            )
            .map_err(|e| e.to_string())?;
        }
    }

    writeln!(output, "  </resources>").map_err(|e| e.to_string())?;

    Ok(())
}

// =============================================================================
// Internal: Library / Project / Sequence
// =============================================================================

fn write_library(
    output: &mut String,
    sequence: &Sequence,
    assets: &HashMap<String, Asset>,
    fps: &Ratio,
) -> Result<(u32, u32), String> {
    let total_duration = rational_time(sequence.duration(), fps);

    writeln!(output, "  <library>").map_err(|e| e.to_string())?;
    writeln!(
        output,
        r#"    <event name="{}">"#,
        xml_escape(&sequence.name)
    )
    .map_err(|e| e.to_string())?;
    writeln!(
        output,
        r#"      <project name="{}">"#,
        xml_escape(&sequence.name)
    )
    .map_err(|e| e.to_string())?;
    writeln!(
        output,
        r#"        <sequence format="r1" duration="{}" tcStart="0/1s" tcFormat="{}">"#,
        total_duration,
        if crate::core::interchange::models::is_drop_frame_rate(fps) {
            "DF"
        } else {
            "NDF"
        }
    )
    .map_err(|e| e.to_string())?;

    // Build asset ID → resource ID mapping
    let mut asset_resource_map: HashMap<&str, String> = HashMap::new();
    let mut resource_idx = 2usize;
    for track in &sequence.tracks {
        for clip in &track.clips {
            if clip.enabled
                && !asset_resource_map.contains_key(clip.asset_id.as_str())
                && assets.contains_key(&clip.asset_id)
            {
                asset_resource_map.insert(&clip.asset_id, format!("r{}", resource_idx));
                resource_idx += 1;
            }
        }
    }

    let (event_count, track_count) = write_spine(output, sequence, &asset_resource_map, fps)?;

    writeln!(output, "        </sequence>").map_err(|e| e.to_string())?;
    writeln!(output, "      </project>").map_err(|e| e.to_string())?;
    writeln!(output, "    </event>").map_err(|e| e.to_string())?;
    writeln!(output, "  </library>").map_err(|e| e.to_string())?;

    Ok((event_count, track_count))
}

// =============================================================================
// Internal: Spine (Timeline)
// =============================================================================

/// Writes the spine element containing all clips.
///
/// FCPXML uses a "spine" as the primary timeline container.
/// The first video track becomes the spine; additional tracks use lane offsets.
/// Audio tracks are attached as audio-only clips or embedded in video clips.
fn write_spine(
    output: &mut String,
    sequence: &Sequence,
    asset_resource_map: &HashMap<&str, String>,
    fps: &Ratio,
) -> Result<(u32, u32), String> {
    writeln!(output, "          <spine>").map_err(|e| e.to_string())?;

    let mut event_count: u32 = 0;
    let mut track_count: u32 = 0;

    // Process all tracks — video/overlay first, then audio
    let mut video_tracks: Vec<(usize, &Track)> = Vec::new();
    let mut audio_tracks: Vec<(usize, &Track)> = Vec::new();

    for (i, track) in sequence.tracks.iter().enumerate() {
        match track.kind {
            TrackKind::Video | TrackKind::Overlay => video_tracks.push((i, track)),
            TrackKind::Audio => audio_tracks.push((i, track)),
            TrackKind::Caption => {} // Skip captions
        }
    }

    // First video track goes directly in spine (lane 0)
    // Additional video tracks get lane offsets (1, 2, ...)
    for (lane_idx, (_track_idx, track)) in video_tracks.iter().enumerate() {
        let mut clips: Vec<_> = track.clips.iter().filter(|c| c.enabled).collect();
        clips.sort_by(|a, b| {
            a.place
                .timeline_in_sec
                .partial_cmp(&b.place.timeline_in_sec)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        if clips.is_empty() {
            continue;
        }
        track_count += 1;

        // Fill gaps with gap elements for the primary spine (lane 0)
        let mut current_time = 0.0f64;

        for clip in &clips {
            // Insert gap if there's space before this clip
            if lane_idx == 0 && clip.place.timeline_in_sec > current_time + 0.001 {
                let gap_duration = clip.place.timeline_in_sec - current_time;
                writeln!(
                    output,
                    r#"            <gap offset="{}" duration="{}" start="0/1s"/>"#,
                    rational_time(current_time, fps),
                    rational_time(gap_duration, fps),
                )
                .map_err(|e| e.to_string())?;
            }

            write_clip_element(output, clip, asset_resource_map, fps, lane_idx)?;
            event_count += 1;
            current_time = clip.place.timeline_out_sec();
        }
    }

    // Audio tracks: when no video tracks exist, the first audio track becomes the
    // primary spine (lane 0 with gap handling). Remaining audio tracks use lane offsets.
    let first_audio_is_primary = video_tracks.is_empty();

    for (lane_offset, (_track_idx, track)) in audio_tracks.iter().enumerate() {
        let mut clips: Vec<_> = track.clips.iter().filter(|c| c.enabled).collect();
        clips.sort_by(|a, b| {
            a.place
                .timeline_in_sec
                .partial_cmp(&b.place.timeline_in_sec)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        if clips.is_empty() {
            continue;
        }
        track_count += 1;

        if first_audio_is_primary && lane_offset == 0 {
            // Primary spine: insert gaps and emit clips without explicit lane attribute
            let mut current_time = 0.0f64;
            for clip in &clips {
                if clip.place.timeline_in_sec > current_time + 0.001 {
                    let gap_duration = clip.place.timeline_in_sec - current_time;
                    writeln!(
                        output,
                        r#"            <gap offset="{}" duration="{}" start="0/1s"/>"#,
                        rational_time(current_time, fps),
                        rational_time(gap_duration, fps),
                    )
                    .map_err(|e| e.to_string())?;
                }
                write_clip_element(output, clip, asset_resource_map, fps, 0)?;
                event_count += 1;
                current_time = clip.place.timeline_out_sec();
            }
        } else {
            let lane = if first_audio_is_primary {
                lane_offset // lanes 1, 2, ... (primary is lane 0)
            } else {
                video_tracks.len() + lane_offset // after video lanes
            };
            for clip in &clips {
                write_audio_clip_element(output, clip, asset_resource_map, fps, lane)?;
                event_count += 1;
            }
        }
    }

    writeln!(output, "          </spine>").map_err(|e| e.to_string())?;

    Ok((event_count, track_count))
}

fn resolve_asset_resource_ref<'a>(
    clip: &crate::core::timeline::Clip,
    asset_resource_map: &'a HashMap<&str, String>,
) -> Result<&'a str, String> {
    asset_resource_map
        .get(clip.asset_id.as_str())
        .map(|resource_id| resource_id.as_str())
        .ok_or_else(|| {
            format!(
                "Clip '{}' references missing asset '{}'",
                clip.id, clip.asset_id
            )
        })
}

/// Writes a single video/overlay clip element
fn write_clip_element(
    output: &mut String,
    clip: &crate::core::timeline::Clip,
    asset_resource_map: &HashMap<&str, String>,
    fps: &Ratio,
    lane: usize,
) -> Result<(), String> {
    let resource_ref = resolve_asset_resource_ref(clip, asset_resource_map)?;

    let name = clip.label.as_deref().unwrap_or(&clip.id);

    let offset = rational_time(clip.place.timeline_in_sec, fps);
    let duration = rational_time(clip.place.duration_sec, fps);
    let start = rational_time(clip.range.source_in_sec, fps);

    let lane_attr = if lane > 0 {
        format!(r#" lane="{}""#, lane)
    } else {
        String::new()
    };

    let tc_format = if super::models::is_drop_frame_rate(fps) {
        "DF"
    } else {
        "NDF"
    };

    writeln!(
        output,
        r#"            <clip name="{name}" ref="{rref}" offset="{offset}" duration="{dur}" start="{start}" tcFormat="{tc_format}"{lane}/>"#,
        name = xml_escape(name),
        rref = resource_ref,
        offset = offset,
        dur = duration,
        start = start,
        tc_format = tc_format,
        lane = lane_attr,
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Writes a single audio clip element
fn write_audio_clip_element(
    output: &mut String,
    clip: &crate::core::timeline::Clip,
    asset_resource_map: &HashMap<&str, String>,
    fps: &Ratio,
    lane: usize,
) -> Result<(), String> {
    let resource_ref = resolve_asset_resource_ref(clip, asset_resource_map)?;

    let name = clip.label.as_deref().unwrap_or(&clip.id);

    let offset = rational_time(clip.place.timeline_in_sec, fps);
    let duration = rational_time(clip.place.duration_sec, fps);
    let start = rational_time(clip.range.source_in_sec, fps);

    let tc_format = if super::models::is_drop_frame_rate(fps) {
        "DF"
    } else {
        "NDF"
    };

    writeln!(
        output,
        r#"            <clip name="{name}" ref="{rref}" offset="{offset}" duration="{dur}" start="{start}" lane="{lane}" tcFormat="{tc_format}"/>"#,
        name = xml_escape(name),
        rref = resource_ref,
        offset = offset,
        dur = duration,
        start = start,
        lane = lane,
        tc_format = tc_format,
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{Asset, AssetKind, LicenseInfo, ProxyStatus};
    use crate::core::timeline::{
        AudioSettings, BlendMode, Clip, ClipPlace, ClipRange, Sequence, SequenceFormat, Track,
        Transform,
    };

    /// Creates a test asset
    fn make_asset(id: &str, name: &str, uri: &str) -> Asset {
        Asset {
            id: id.to_string(),
            kind: AssetKind::Video,
            name: name.to_string(),
            uri: uri.to_string(),
            hash: "abc123".to_string(),
            duration_sec: Some(60.0),
            file_size: 1024,
            imported_at: "2026-01-01T00:00:00Z".to_string(),
            video: None,
            audio: None,
            license: LicenseInfo::default(),
            tags: vec![],
            thumbnail_url: None,
            proxy_status: ProxyStatus::NotNeeded,
            proxy_url: None,
            bin_id: None,
            relative_path: None,
            workspace_managed: false,
            missing: false,
        }
    }

    /// Creates a test clip
    fn make_clip(
        id: &str,
        asset_id: &str,
        src_in: f64,
        src_out: f64,
        tl_in: f64,
        duration: f64,
    ) -> Clip {
        Clip {
            id: id.to_string(),
            asset_id: asset_id.to_string(),
            range: ClipRange::new(src_in, src_out),
            place: ClipPlace::new(tl_in, duration),
            transform: Transform::default(),
            motion_keyframes: Vec::new(),
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            speed: 1.0,
            reverse: false,
            freeze_frame: false,
            time_remap: None,
            slow_motion_interpolation: crate::core::timeline::SlowMotionInterpolation::Nearest,
            effects: vec![],
            audio: AudioSettings::default(),
            label: None,
            color: None,
            caption_style: None,
            caption_position: None,
            enabled: true,
            link_group_id: None,
            compound_sequence_id: None,
            is_adjustment_layer: false,
            group_id: None,
        }
    }

    fn make_sequence(name: &str, fps_num: i32, fps_den: i32) -> Sequence {
        Sequence::new(
            name,
            SequenceFormat::new(1920, 1080, fps_num, fps_den, 48000),
        )
    }

    // =========================================================================
    // BDD Tests
    // =========================================================================

    #[test]
    fn should_produce_valid_xml_structure() {
        // Given: an empty sequence
        let seq = make_sequence("Test Project", 24, 1);
        let assets = HashMap::new();

        // When: exporting to FCPXML
        let (xml, _, _) = export_fcpxml(&seq, &assets).expect("FCPXML export should succeed");

        // Then: should have valid XML structure
        assert!(xml.contains(r#"<?xml version="1.0" encoding="UTF-8"?>"#));
        assert!(xml.contains("<!DOCTYPE fcpxml>"));
        assert!(xml.contains(r#"<fcpxml version="1.11">"#));
        assert!(xml.contains("</fcpxml>"));
        assert!(xml.contains("<resources>"));
        assert!(xml.contains("</resources>"));
        assert!(xml.contains("<library>"));
        assert!(xml.contains("</library>"));
        assert!(xml.contains("<spine>"));
        assert!(xml.contains("</spine>"));
    }

    #[test]
    fn should_include_format_resource_matching_sequence() {
        // Given: a 1920x1080 24fps sequence
        let seq = make_sequence("HD Project", 24, 1);
        let assets = HashMap::new();

        // When: exporting to FCPXML
        let (xml, _, _) = export_fcpxml(&seq, &assets).expect("FCPXML export should succeed");

        // Then: format resource should match sequence properties
        assert!(xml.contains(r#"id="r1""#));
        assert!(xml.contains(r#"width="1920""#));
        assert!(xml.contains(r#"height="1080""#));
        assert!(xml.contains("frameDuration="));
    }

    #[test]
    fn should_include_asset_resources_for_referenced_media() {
        // Given: a sequence with a clip referencing an asset
        let mut seq = make_sequence("Asset Test", 24, 1);
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0));
        seq.add_track(track);

        let mut assets = HashMap::new();
        assets.insert(
            "a1".to_string(),
            make_asset("a1", "interview.mp4", "/media/interview.mp4"),
        );

        // When: exporting to FCPXML
        let (xml, _, _) = export_fcpxml(&seq, &assets).expect("FCPXML export should succeed");

        // Then: asset resource should be declared
        assert!(xml.contains(r#"<asset id="r2""#));
        assert!(xml.contains(r#"name="interview.mp4""#));
        assert!(xml.contains(r#"src="file:///media/interview.mp4""#));
    }

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
    fn should_export_clip_with_correct_offset_and_duration() {
        // Given: a clip at timeline 2.0s with duration 3.0s
        let mut seq = make_sequence("Clip Test", 24, 1);
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 1.0, 4.0, 2.0, 3.0));
        seq.add_track(track);

        let mut assets = HashMap::new();
        assets.insert("a1".to_string(), make_asset("a1", "clip.mp4", "/clip.mp4"));

        // When: exporting to FCPXML
        let (xml, event_count, track_count) =
            export_fcpxml(&seq, &assets).expect("FCPXML export should succeed");

        // Then: clip element should have correct timing attributes
        assert_eq!(event_count, 1);
        assert_eq!(track_count, 1);
        assert!(xml.contains(r#"<clip "#));
        assert!(xml.contains(r#"ref="r2""#));
        // Verify rational time values are present (exact format depends on fps)
        assert!(xml.contains("offset="));
        assert!(xml.contains("duration="));
        assert!(xml.contains("start="));
    }

    #[test]
    fn should_export_multiple_tracks_with_lane_offsets() {
        // Given: a sequence with two video tracks
        let mut seq = make_sequence("Multi Track", 24, 1);

        let mut v1 = Track::new_video("V1");
        v1.add_clip(make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0));
        seq.add_track(v1);

        let mut v2 = Track::new_video("V2");
        v2.add_clip(make_clip("c2", "a1", 0.0, 3.0, 1.0, 3.0));
        seq.add_track(v2);

        let mut assets = HashMap::new();
        assets.insert("a1".to_string(), make_asset("a1", "clip.mp4", "/clip.mp4"));

        // When: exporting to FCPXML
        let (xml, event_count, track_count) =
            export_fcpxml(&seq, &assets).expect("FCPXML export should succeed");

        // Then: second track clips should have lane attribute
        assert_eq!(event_count, 2);
        assert_eq!(track_count, 2);
        assert!(xml.contains(r#"lane="1""#));
    }

    #[test]
    fn should_escape_xml_special_characters_in_names() {
        // Given: a sequence with special characters in name
        let mut seq = make_sequence("Test & <Project>", 24, 1);
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0));
        seq.add_track(track);

        let mut assets = HashMap::new();
        assets.insert(
            "a1".to_string(),
            make_asset("a1", "my \"clip\".mp4", "/path/my \"clip\".mp4"),
        );

        // When: exporting to FCPXML
        let (xml, _, _) = export_fcpxml(&seq, &assets).expect("FCPXML export should succeed");

        // Then: special characters should be escaped
        assert!(xml.contains("Test &amp; &lt;Project&gt;"));
        assert!(xml.contains("my &quot;clip&quot;.mp4"));
    }

    #[test]
    fn should_skip_disabled_clips() {
        // Given: an enabled and a disabled clip
        let mut seq = make_sequence("Disabled Test", 24, 1);
        let mut track = Track::new_video("V1");

        track.add_clip(make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0));

        let mut disabled = make_clip("c2", "a1", 5.0, 10.0, 5.0, 5.0);
        disabled.enabled = false;
        track.add_clip(disabled);

        seq.add_track(track);

        let mut assets = HashMap::new();
        assets.insert("a1".to_string(), make_asset("a1", "clip.mp4", "/clip.mp4"));

        // When: exporting to FCPXML
        let (_, event_count, _) =
            export_fcpxml(&seq, &assets).expect("FCPXML export should succeed");

        // Then: only enabled clip exported
        assert_eq!(event_count, 1);
    }

    #[test]
    fn should_export_audio_tracks_with_separate_lane() {
        // Given: a video track and an audio track
        let mut seq = make_sequence("AV Test", 24, 1);

        let mut v1 = Track::new_video("V1");
        v1.add_clip(make_clip("vc1", "a1", 0.0, 5.0, 0.0, 5.0));
        seq.add_track(v1);

        let mut a1 = Track::new_audio("A1");
        a1.add_clip(make_clip("ac1", "a2", 0.0, 5.0, 0.0, 5.0));
        seq.add_track(a1);

        let mut assets = HashMap::new();
        assets.insert(
            "a1".to_string(),
            make_asset("a1", "video.mp4", "/video.mp4"),
        );
        assets.insert(
            "a2".to_string(),
            make_asset("a2", "audio.wav", "/audio.wav"),
        );

        // When: exporting to FCPXML
        let (xml, event_count, track_count) =
            export_fcpxml(&seq, &assets).expect("FCPXML export should succeed");

        // Then: audio clip should be in a separate lane
        assert_eq!(event_count, 2);
        assert_eq!(track_count, 2);
        // Audio lane = number of video tracks (1)
        assert!(xml.contains(r#"lane="1""#));
    }

    #[test]
    fn should_insert_gap_elements_for_timeline_gaps() {
        // Given: a clip that starts at 5.0s (gap from 0-5s)
        let mut seq = make_sequence("Gap Test", 24, 1);
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("c1", "a1", 0.0, 5.0, 5.0, 5.0));
        seq.add_track(track);

        let mut assets = HashMap::new();
        assets.insert("a1".to_string(), make_asset("a1", "clip.mp4", "/clip.mp4"));

        // When: exporting to FCPXML
        let (xml, _, _) = export_fcpxml(&seq, &assets).expect("FCPXML export should succeed");

        // Then: a gap element should precede the clip
        assert!(xml.contains("<gap "));
    }

    #[test]
    fn should_use_ndf_tc_format_for_24fps() {
        // Given: a 24fps sequence
        let seq = make_sequence("NDF Test", 24, 1);
        let assets = HashMap::new();

        // When: exporting to FCPXML
        let (xml, _, _) = export_fcpxml(&seq, &assets).expect("FCPXML export should succeed");

        // Then: tcFormat should be NDF
        assert!(xml.contains(r#"tcFormat="NDF""#));
    }

    #[test]
    fn should_use_df_tc_format_for_29_97fps() {
        // Given: a 29.97fps sequence
        let seq = make_sequence("DF Test", 30000, 1001);
        let assets = HashMap::new();

        // When: exporting to FCPXML
        let (xml, _, _) = export_fcpxml(&seq, &assets).expect("FCPXML export should succeed");

        // Then: tcFormat should be DF
        assert!(xml.contains(r#"tcFormat="DF""#));
    }

    #[test]
    fn should_fail_when_clip_references_missing_asset() {
        let mut seq = make_sequence("Missing Asset", 24, 1);
        let mut track = Track::new_video("V1");
        track.add_clip(make_clip("clip-1", "missing-asset", 0.0, 5.0, 0.0, 5.0));
        seq.add_track(track);

        let err = export_fcpxml(&seq, &HashMap::new()).unwrap_err();

        assert!(err.contains("missing asset"));
        assert!(err.contains("clip-1"));
    }

    // =========================================================================
    // Helper Tests
    // =========================================================================

    #[test]
    fn should_format_rational_time_correctly() {
        let fps24 = Ratio::new(24, 1);
        assert_eq!(rational_time(0.0, &fps24), "0/1s");

        let fps30 = Ratio::new(30, 1);
        let rt = rational_time(1.0, &fps30);
        // 1 second at 30fps timebase = 30/30s = 1/1s
        assert_eq!(rt, "1/1s");
    }

    #[test]
    fn should_format_frame_accurate_rational_time_for_29_97fps() {
        let fps2997 = Ratio::new(30000, 1001);

        assert_eq!(rational_time(1001.0 / 30000.0, &fps2997), "1001/30000s");
        assert_eq!(
            rational_time(2.0 * 1001.0 / 30000.0, &fps2997),
            "1001/15000s"
        );
    }

    #[test]
    fn should_escape_xml_characters() {
        assert_eq!(xml_escape("test & <value>"), "test &amp; &lt;value&gt;");
        assert_eq!(xml_escape(r#"he said "hi""#), "he said &quot;hi&quot;");
    }

    #[test]
    fn should_compute_gcd_correctly() {
        assert_eq!(gcd(12, 8), 4);
        assert_eq!(gcd(7, 3), 1);
        assert_eq!(gcd(0, 5), 5);
        assert_eq!(gcd(1001, 30000), 1);
    }
}
