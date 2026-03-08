//! Integration Tests: Analysis Pipeline -> ESD Generation -> Style Planning
//!
//! End-to-end tests verifying the complete flow from an AnalysisBundle
//! through ESD generation and into style plan output.

use openreelio_lib::core::analysis::dtw::dtw_align;
use openreelio_lib::core::analysis::esd::{EsdGenerator, TempoClassification};
use openreelio_lib::core::analysis::style_planner::{StylePlanner, StylePlanningContext};
use openreelio_lib::core::analysis::types::{
    AnalysisBundle, AudioProfile, ContentSegment, SegmentType, VideoMetadata,
};
use openreelio_lib::core::annotations::models::ShotResult;

// =============================================================================
// Helper Functions
// =============================================================================

fn create_mock_shot(start: f64, end: f64) -> ShotResult {
    ShotResult::new(start, end, 0.9)
}

fn create_mock_audio_profile() -> AudioProfile {
    AudioProfile {
        bpm: Some(120.0),
        spectral_centroid_hz: 2000.0,
        loudness_profile: vec![-20.0; 12],
        peak_db: -3.0,
        silence_regions: vec![],
    }
}

fn create_mock_video_metadata(duration: f64) -> VideoMetadata {
    VideoMetadata::new(duration)
        .with_dimensions(1920, 1080)
        .with_fps(30.0)
        .with_codec("h264")
        .with_audio(true)
}

fn create_mock_bundle(asset_id: &str, shots: Vec<ShotResult>, duration: f64) -> AnalysisBundle {
    let mut bundle = AnalysisBundle::new(asset_id, create_mock_video_metadata(duration));
    bundle.shots = Some(shots);
    bundle.transcript = None;
    bundle.audio_profile = Some(create_mock_audio_profile());
    bundle.segments = Some(vec![
        ContentSegment::new(0.0, duration / 2.0, SegmentType::Talk, 0.8),
        ContentSegment::new(duration / 2.0, duration, SegmentType::Performance, 0.85),
    ]);
    bundle.frame_analysis = None;
    bundle
}

// =============================================================================
// Test 1: Full Pipeline - Bundle to Plan
// =============================================================================

#[tokio::test]
async fn test_full_pipeline_bundle_to_plan() {
    // Create reference bundle with 5 shots: [0-2s, 2-5s, 5-6s, 6-10s, 10-12s]
    let reference_shots = vec![
        create_mock_shot(0.0, 2.0),
        create_mock_shot(2.0, 5.0),
        create_mock_shot(5.0, 6.0),
        create_mock_shot(6.0, 10.0),
        create_mock_shot(10.0, 12.0),
    ];
    let mut reference_bundle = create_mock_bundle("ref-asset", reference_shots, 12.0);
    reference_bundle.segments = Some(vec![
        ContentSegment::new(0.0, 5.0, SegmentType::Talk, 0.8),
        ContentSegment::new(5.0, 10.0, SegmentType::Performance, 0.85),
        ContentSegment::new(10.0, 12.0, SegmentType::Talk, 0.8),
    ]);

    // Step 1: Generate ESD from the reference bundle
    let esd = EsdGenerator::generate(&reference_bundle).unwrap();

    // Step 2: Verify ESD fields
    // Shot durations: [2, 3, 1, 4, 2] -> mean = 12/5 = 2.4
    assert!(
        (esd.rhythm_profile.mean_duration - 2.4).abs() < 0.01,
        "Expected mean_duration ~2.4, got {}",
        esd.rhythm_profile.mean_duration
    );
    assert_eq!(
        esd.rhythm_profile.tempo_classification,
        TempoClassification::Moderate,
        "Expected Moderate tempo for mean 2.4s"
    );
    assert_eq!(
        esd.pacing_curve.len(),
        5,
        "Expected 5 pacing curve points (one per shot)"
    );
    assert_eq!(
        esd.transition_inventory.transitions.len(),
        4,
        "Expected 4 transitions between 5 shots"
    );
    for transition in &esd.transition_inventory.transitions {
        assert_eq!(transition.transition_type, "cut");
    }

    // Step 3: Create source bundle (different shots, 15s duration, 6 shots)
    let source_shots = vec![
        create_mock_shot(0.0, 3.0),
        create_mock_shot(3.0, 5.0),
        create_mock_shot(5.0, 8.0),
        create_mock_shot(8.0, 10.0),
        create_mock_shot(10.0, 13.0),
        create_mock_shot(13.0, 15.0),
    ];
    let mut source_bundle = create_mock_bundle("src-asset", source_shots, 15.0);
    source_bundle.segments = Some(vec![
        ContentSegment::new(0.0, 5.0, SegmentType::Talk, 0.8),
        ContentSegment::new(5.0, 10.0, SegmentType::Performance, 0.85),
        ContentSegment::new(10.0, 15.0, SegmentType::Talk, 0.8),
    ]);

    // Step 4: Generate style plan
    let context = StylePlanningContext::new("sequence-1", "src-asset");
    let result = StylePlanner::plan(&esd, &source_bundle, &context).unwrap();

    // Step 5: Verify plan
    assert!(
        !result.plan.steps.is_empty(),
        "Plan should have steps (AddTrack + InsertClip + SplitClip)"
    );

    let add_track_steps: Vec<_> = result
        .plan
        .steps
        .iter()
        .filter(|s| s.tool_name == "AddTrack")
        .collect();
    assert_eq!(
        add_track_steps.len(),
        1,
        "Expected exactly one AddTrack step"
    );

    let insert_clip_steps: Vec<_> = result
        .plan
        .steps
        .iter()
        .filter(|s| s.tool_name == "InsertClip")
        .collect();
    assert_eq!(
        insert_clip_steps.len(),
        1,
        "Expected exactly one InsertClip step"
    );

    let split_steps: Vec<_> = result
        .plan
        .steps
        .iter()
        .filter(|s| s.tool_name == "SplitClip")
        .collect();
    assert!(
        !split_steps.is_empty(),
        "Expected at least one SplitClip step"
    );

    assert!(
        result.compatibility_score >= 0.0 && result.compatibility_score <= 1.0,
        "Compatibility score {} should be between 0.0 and 1.0",
        result.compatibility_score
    );
}

// =============================================================================
// Test 2: ESD Generation with Empty Shots
// =============================================================================

#[tokio::test]
async fn test_esd_generation_with_empty_shots() {
    let mut bundle = AnalysisBundle::new("empty-asset", create_mock_video_metadata(10.0));
    bundle.shots = Some(vec![]);
    bundle.audio_profile = Some(create_mock_audio_profile());

    let esd = EsdGenerator::generate(&bundle).unwrap();

    assert!(
        esd.rhythm_profile.shot_durations.is_empty(),
        "Expected empty shot_durations for empty shots input"
    );
    assert_eq!(
        esd.rhythm_profile.tempo_classification,
        TempoClassification::Moderate,
        "Expected Moderate as default tempo classification"
    );
    assert!(
        esd.pacing_curve.is_empty(),
        "Expected empty pacing curve for empty shots"
    );
}

// =============================================================================
// Test 3: Style Planner Validation Errors
// =============================================================================

#[tokio::test]
async fn test_style_planner_validation_errors() {
    let shots = vec![create_mock_shot(0.0, 5.0), create_mock_shot(5.0, 10.0)];
    let bundle = create_mock_bundle("src-asset", shots.clone(), 10.0);

    let ref_bundle = create_mock_bundle(
        "ref-asset",
        vec![create_mock_shot(0.0, 5.0), create_mock_shot(5.0, 10.0)],
        10.0,
    );
    let esd = EsdGenerator::generate(&ref_bundle).unwrap();

    // Empty sequence_id should fail
    let ctx_empty_seq = StylePlanningContext::new("", "src-asset");
    let result = StylePlanner::plan(&esd, &bundle, &ctx_empty_seq);
    assert!(
        result.is_err(),
        "Expected validation error for empty sequence_id"
    );

    // Empty source_asset_id should fail
    let ctx_empty_asset = StylePlanningContext::new("sequence-1", "");
    let result = StylePlanner::plan(&esd, &bundle, &ctx_empty_asset);
    assert!(
        result.is_err(),
        "Expected validation error for empty source_asset_id"
    );

    // Mismatched bundle.asset_id vs context.source_asset_id should fail
    let ctx_mismatch = StylePlanningContext::new("sequence-1", "different-asset");
    let result = StylePlanner::plan(&esd, &bundle, &ctx_mismatch);
    assert!(
        result.is_err(),
        "Expected validation error for mismatched asset IDs"
    );
}

// =============================================================================
// Test 4: Compatibility Score - Similar Content
// =============================================================================

#[tokio::test]
async fn test_compatibility_score_similar_content() {
    // Reference: 5 concert shots, Performance segments
    let ref_shots = vec![
        create_mock_shot(0.0, 3.0),
        create_mock_shot(3.0, 6.0),
        create_mock_shot(6.0, 8.0),
        create_mock_shot(8.0, 11.0),
        create_mock_shot(11.0, 14.0),
    ];
    let mut ref_bundle = create_mock_bundle("ref-asset", ref_shots, 14.0);
    ref_bundle.segments = Some(vec![
        ContentSegment::new(0.0, 7.0, SegmentType::Performance, 0.9),
        ContentSegment::new(7.0, 14.0, SegmentType::Performance, 0.9),
    ]);
    let esd = EsdGenerator::generate(&ref_bundle).unwrap();

    // Source: 4 similar concert shots, Performance segments
    let source_shots = vec![
        create_mock_shot(0.0, 3.5),
        create_mock_shot(3.5, 7.0),
        create_mock_shot(7.0, 9.5),
        create_mock_shot(9.5, 13.0),
    ];
    let mut source_bundle = create_mock_bundle("src-asset", source_shots, 13.0);
    source_bundle.segments = Some(vec![
        ContentSegment::new(0.0, 6.5, SegmentType::Performance, 0.9),
        ContentSegment::new(6.5, 13.0, SegmentType::Performance, 0.9),
    ]);

    let score = StylePlanner::compute_compatibility_score(&esd, &source_bundle);
    assert!(
        score > 0.5,
        "Expected compatibility score > 0.5 for similar concert content, got {}",
        score
    );
}

// =============================================================================
// Test 5: Compatibility Score - Dissimilar Content
// =============================================================================

#[tokio::test]
async fn test_compatibility_score_dissimilar_content() {
    // Reference: fast-paced montage
    let ref_shots = vec![
        create_mock_shot(0.0, 0.5),
        create_mock_shot(0.5, 0.8),
        create_mock_shot(0.8, 1.6),
        create_mock_shot(1.6, 2.0),
        create_mock_shot(2.0, 2.6),
    ];
    let mut ref_bundle = create_mock_bundle("ref-asset", ref_shots, 2.6);
    ref_bundle.segments = Some(vec![ContentSegment::new(
        0.0,
        2.6,
        SegmentType::Montage,
        0.9,
    )]);
    ref_bundle.audio_profile = Some(AudioProfile {
        bpm: Some(180.0),
        spectral_centroid_hz: 5000.0,
        loudness_profile: vec![-10.0; 3],
        peak_db: -3.0,
        silence_regions: vec![],
    });
    let esd = EsdGenerator::generate(&ref_bundle).unwrap();

    // Source: long talking head (single 120s shot, Talk segment)
    let source_shots = vec![create_mock_shot(0.0, 120.0)];
    let mut source_bundle = create_mock_bundle("src-asset", source_shots, 120.0);
    source_bundle.segments = Some(vec![ContentSegment::new(
        0.0,
        120.0,
        SegmentType::Talk,
        0.9,
    )]);
    source_bundle.audio_profile = Some(AudioProfile {
        bpm: None,
        spectral_centroid_hz: 800.0,
        loudness_profile: vec![-30.0; 120],
        peak_db: -20.0,
        silence_regions: vec![],
    });

    let score = StylePlanner::compute_compatibility_score(&esd, &source_bundle);
    assert!(
        score < 0.5,
        "Expected compatibility score < 0.5 for dissimilar content, got {}",
        score
    );
}

// =============================================================================
// Test 6: DTW Alignment Preserves Cut Order
// =============================================================================

#[tokio::test]
async fn test_dtw_alignment_preserves_cut_order() {
    let reference = vec![2.0, 3.0, 1.0, 4.0, 2.0];
    let source = vec![3.0, 2.0, 4.0, 1.0, 3.0, 2.0];

    let result = dtw_align(&reference, &source);

    // Verify monotonically increasing alignment pairs
    for window in result.path.windows(2) {
        assert!(
            window[1].0 >= window[0].0 && window[1].1 >= window[0].1,
            "DTW path is not monotonically increasing: {:?} -> {:?}",
            window[0],
            window[1]
        );
    }

    // Verify path starts and ends correctly
    assert_eq!(
        result.path.first(),
        Some(&(0, 0)),
        "DTW path should start at (0, 0)"
    );
    assert_eq!(
        result.path.last(),
        Some(&(reference.len() - 1, source.len() - 1)),
        "DTW path should end at last indices"
    );

    // Verify all indices are covered
    let ref_indices: Vec<usize> = result.path.iter().map(|&(r, _)| r).collect();
    let src_indices: Vec<usize> = result.path.iter().map(|&(_, s)| s).collect();
    for i in 0..reference.len() {
        assert!(
            ref_indices.contains(&i),
            "Reference index {} missing from DTW path",
            i
        );
    }
    for j in 0..source.len() {
        assert!(
            src_indices.contains(&j),
            "Source index {} missing from DTW path",
            j
        );
    }
}
