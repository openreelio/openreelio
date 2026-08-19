//! Display-matrix rotation carried by a container's video stream.
//!
//! A phone shooting in portrait usually records a landscape-coded stream plus a
//! display matrix telling players to turn it. FFmpeg honours that matrix when it
//! decodes (auto-rotation is on unless `-noautorotate` is passed), so the frames
//! a filtergraph sees are already turned: a stream coded 1920x1080 with a quarter
//! turn decodes to 1080x1920.
//!
//! Anything that reasons about "how big is this picture" therefore has to read
//! the matrix too, or it will letterbox and stretch every portrait phone clip.

/// A quarter turn, in degrees.
const QUARTER_TURN_DEG: f64 = 90.0;

/// A half turn, in degrees.
const HALF_TURN_DEG: f64 = 180.0;

/// Slack for comparing a rotation against an exact right angle.
const ROTATION_MATCH_EPSILON_DEG: f64 = 1.0;

/// Folds a raw rotation into `(-180, 180]`.
///
/// Containers report the same turn as `90`, `-270` or `450` depending on who
/// wrote them, and `NaN` shows up in files that were remuxed badly.
pub fn normalize_rotation_deg(raw: f64) -> f64 {
    if !raw.is_finite() {
        return 0.0;
    }

    let mut normalized = raw % (2.0 * HALF_TURN_DEG);
    if normalized > HALF_TURN_DEG {
        normalized -= 2.0 * HALF_TURN_DEG;
    } else if normalized <= -HALF_TURN_DEG {
        normalized += 2.0 * HALF_TURN_DEG;
    }
    normalized
}

/// Whether a rotation turns the picture onto its side.
///
/// Only quarter turns swap the extents; a half turn leaves them alone.
pub fn rotation_swaps_dimensions(rotation_deg: f64) -> bool {
    let normalized = normalize_rotation_deg(rotation_deg).abs();
    (normalized - QUARTER_TURN_DEG).abs() < ROTATION_MATCH_EPSILON_DEG
}

/// The size the decoder actually hands downstream for a coded size plus rotation.
pub fn display_dimensions(width: u32, height: u32, rotation_deg: f64) -> (u32, u32) {
    if rotation_swaps_dimensions(rotation_deg) {
        (height, width)
    } else {
        (width, height)
    }
}

/// Reads the display-matrix rotation off an FFprobe stream object.
///
/// Modern FFprobe reports it as `side_data_list[].rotation`; older builds (and
/// some remuxers) only leave a `tags.rotate` string behind, so both are read.
/// Returns `0.0` when the stream carries neither.
pub fn rotation_from_probe_stream(stream: &serde_json::Value) -> f64 {
    let from_side_data = stream
        .get("side_data_list")
        .and_then(|list| list.as_array())
        .and_then(|entries| {
            entries
                .iter()
                .find_map(|entry| entry.get("rotation").and_then(json_number))
        });

    let raw = from_side_data.or_else(|| {
        stream
            .get("tags")
            .and_then(|tags| tags.get("rotate"))
            .and_then(json_number)
    });

    raw.map(normalize_rotation_deg).unwrap_or(0.0)
}

/// FFprobe writes rotation as a JSON number, but `tags.rotate` is a string.
fn json_number(value: &serde_json::Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        value
            .as_str()
            .and_then(|raw| raw.trim().parse::<f64>().ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feature: Display-matrix rotation
    /// Scenario: equivalent spellings of the same turn normalize together
    #[test]
    fn should_normalize_equivalent_rotations() {
        assert_eq!(normalize_rotation_deg(90.0), 90.0);
        assert_eq!(normalize_rotation_deg(-270.0), 90.0);
        assert_eq!(normalize_rotation_deg(450.0), 90.0);
        assert_eq!(normalize_rotation_deg(-90.0), -90.0);
        assert_eq!(normalize_rotation_deg(270.0), -90.0);
        assert_eq!(normalize_rotation_deg(180.0), 180.0);
        assert_eq!(normalize_rotation_deg(-180.0), 180.0);
        assert_eq!(normalize_rotation_deg(0.0), 0.0);
        assert_eq!(normalize_rotation_deg(f64::NAN), 0.0);
    }

    /// Feature: Display-matrix rotation
    /// Scenario: only quarter turns put the picture on its side
    #[test]
    fn should_swap_dimensions_only_for_quarter_turns() {
        assert!(rotation_swaps_dimensions(90.0));
        assert!(rotation_swaps_dimensions(-90.0));
        assert!(rotation_swaps_dimensions(270.0));
        assert!(!rotation_swaps_dimensions(0.0));
        assert!(!rotation_swaps_dimensions(180.0));

        assert_eq!(display_dimensions(1920, 1080, 90.0), (1080, 1920));
        assert_eq!(display_dimensions(1920, 1080, 180.0), (1920, 1080));
        assert_eq!(display_dimensions(1920, 1080, 0.0), (1920, 1080));
    }

    /// Feature: Display-matrix rotation
    /// Scenario: a portrait phone clip reports its turn through side_data_list
    #[test]
    fn should_read_rotation_from_side_data_list() {
        let stream = serde_json::json!({
            "codec_type": "video",
            "width": 1920,
            "height": 1080,
            "side_data_list": [
                { "side_data_type": "Display Matrix", "displaymatrix": "...", "rotation": -90 }
            ]
        });

        assert_eq!(rotation_from_probe_stream(&stream), -90.0);
    }

    /// Feature: Display-matrix rotation
    /// Scenario: an older remux only leaves a rotate tag behind
    #[test]
    fn should_read_rotation_from_the_rotate_tag() {
        let stream = serde_json::json!({
            "codec_type": "video",
            "tags": { "rotate": "270" }
        });

        assert_eq!(rotation_from_probe_stream(&stream), -90.0);
    }

    /// Feature: Display-matrix rotation
    /// Scenario: a stream with no matrix is not rotated
    #[test]
    fn should_report_no_rotation_when_the_stream_carries_none() {
        let stream = serde_json::json!({ "codec_type": "video", "width": 640, "height": 480 });

        assert_eq!(rotation_from_probe_stream(&stream), 0.0);
    }
}
