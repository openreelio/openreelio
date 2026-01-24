//! IPC DTO helpers
//!
//! This module is compiled in unit tests (unlike the Tauri command entry points).
//! Keep it free of `tauri` dependencies so we can validate serialization and
//! cross-layer type stability with normal `cargo test`.

use serde::Serialize;

/// Serializes a serde value expected to become a JSON string.
///
/// This is primarily used for enums with `#[serde(rename_all = ...)]` where
/// `Debug` formatting is not a stable wire format.
pub fn serialize_to_json_string<T: Serialize>(value: &T) -> Result<String, String> {
    let json_value = serde_json::to_value(value).map_err(|e| e.to_string())?;
    json_value
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Expected value to serialize as a JSON string".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ai::edit_script::{NsfwRisk, RequirementKind, RiskLevel};

    #[test]
    fn serializes_requirement_kind_with_camel_case() {
        assert_eq!(
            serialize_to_json_string(&RequirementKind::AssetSearch).unwrap(),
            "assetSearch"
        );
        assert_eq!(
            serialize_to_json_string(&RequirementKind::Generate).unwrap(),
            "generate"
        );
        assert_eq!(
            serialize_to_json_string(&RequirementKind::Download).unwrap(),
            "download"
        );
    }

    #[test]
    fn serializes_risk_enums_with_expected_wire_values() {
        assert_eq!(serialize_to_json_string(&RiskLevel::High).unwrap(), "high");
        assert_eq!(
            serialize_to_json_string(&NsfwRisk::Possible).unwrap(),
            "possible"
        );
        assert_eq!(
            serialize_to_json_string(&NsfwRisk::Likely).unwrap(),
            "likely"
        );
    }
}
