use crate::ipc::payloads::CommandPayload;
use serde_json::json;

#[test]
fn test_destructive_invalid_payload_injection() {
    // Simulating a malicious payload (Type mismatch injection)
    // The frontend sends "timelineIn" as a string "NOT_A_NUMBER", but we expect f64.
    let payload = json!({
        "sequenceId": "seq_1",
        "trackId": "track_1",
        "assetId": "asset_1",
        "timelineIn": "NOT_A_NUMBER"
    });

    // In the "Early Implementation", this might have been manually parsed with .as_f64() -> None -> 0.0
    // In our "Principal Engineer" implementation, this MUST fail with a parsing error.
    let result = CommandPayload::parse("insertClip".to_string(), payload);

    assert!(
        result.is_err(),
        "Should have rejected invalid type for timelineIn"
    );
    let error = result.unwrap_err();
    assert!(
        error.contains("invalid type"),
        "Error message should mention type mismatch, got: {}",
        error
    );
}

#[test]
fn test_destructive_missing_field() {
    // Missing "assetId"
    let payload = json!({
        "sequenceId": "seq_1",
        "trackId": "track_1",
        "timelineIn": 10.0
    });

    let result = CommandPayload::parse("InsertClip".to_string(), payload);
    assert!(result.is_err(), "Should have rejected missing assetId");
    assert!(
        result.unwrap_err().contains("missing field"),
        "Error should mention missing field"
    );
}

#[test]
fn test_destructive_missing_timeline_start_is_rejected() {
    // Missing both timelineStart and legacy timelineIn
    let payload = json!({
        "sequenceId": "seq_1",
        "trackId": "track_1",
        "assetId": "asset_1"
    });

    let result = CommandPayload::parse("InsertClip".to_string(), payload);

    assert!(
        result.is_err(),
        "Should have rejected missing timelineStart"
    );
    assert!(
        result.unwrap_err().contains("missing field"),
        "Error should mention missing field"
    );
}

#[test]
fn test_happy_path_parsing() {
    let payload = json!({
        "sequenceId": "seq_1",
        "trackId": "track_1",
        "assetId": "asset_1",
        "timelineIn": 10.0
    });

    let result = CommandPayload::parse("InsertClip".to_string(), payload);
    assert!(result.is_ok());
    if let Ok(CommandPayload::InsertClip(p)) = result {
        assert_eq!(p.timeline_start, 10.0);
    } else {
        panic!("Wrong variant parsed");
    }
}
