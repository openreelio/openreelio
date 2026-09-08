//! Guard: every suggested fix a QC rule emits must be an executable command.
//!
//! A QC fix is untyped JSON, so nothing at the type level stops a rule from
//! describing a command that does not exist or naming a field the payload
//! rejects. Shipped rules did both, and the failure is invisible until an agent
//! tries to apply the fix and the plan is rejected.
//!
//! This module closes that hole from the other end: it drives the real rules
//! over a project built to trip every fix-emitting one, then feeds each emitted
//! command through [`CommandPayload::parse`] — the same strict, deny-unknown-
//! fields parser `plan validate`, `plan execute` and the IPC layer use. A rule
//! that emits nothing is fine; a rule that emits something unexecutable is not.

use crate::core::assets::{Asset, AudioInfo, VideoInfo};
use crate::core::captions::CaptionPosition;
use crate::core::project::ProjectState;
use crate::core::qc::caption_contrast::CaptionBandSample;
use crate::core::qc::context::RenderMeasurements;
use crate::core::qc::engine::QCEngine;
use crate::core::qc::test_support::text_overlay_clip;
use crate::core::qc::violation::QCViolation;
use crate::core::timeline::{Clip, Sequence, SequenceFormat, Track};
use crate::ipc::CommandPayload;

/// Command types the QC module is expected to be able to suggest.
///
/// Asserted as an exact set so the guard fails loudly in both directions: a new
/// unexecutable fix is caught by the parse, and a fix that quietly stopped
/// being emitted is caught by the coverage assertion.
const EXPECTED_FIX_COMMAND_TYPES: &[&str] = &[
    "CloseGap",
    "CreateCaption",
    "RemoveClip",
    "SetClipOpacity",
    "SetMasterVolume",
    "TrimClip",
    "UpdateCaption",
    "UpdateTextClip",
];

/// Label of the fixture's faded caption cue.
///
/// Named so the measurements can find the clip again and address the band
/// sample at it: the contrast rule reads the cue's clip back off the sequence
/// to decide which half of its layer opacity is the faded one.
const FADED_CAPTION_LABEL: &str = "Faded caption";

/// Source length of the fixture asset, in seconds.
///
/// Comfortably longer than any clip placed on the timeline so the black-frame
/// rule has room to suggest a slip.
const FIXTURE_ASSET_DURATION_SEC: f64 = 120.0;

/// Splits a QC fix command into the `(commandType, payload)` pair the command
/// layer expects, exactly as the CLI does when it builds a plan step.
fn split_command(command: &serde_json::Value) -> (String, serde_json::Value) {
    let object = command
        .as_object()
        .unwrap_or_else(|| panic!("fix command must be a JSON object, got {command}"));
    let command_type = object
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or_else(|| panic!("fix command must carry a string 'type', got {command}"))
        .to_string();

    let payload: serde_json::Map<String, serde_json::Value> = object
        .iter()
        .filter(|(key, _)| key.as_str() != "type")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();

    (command_type, serde_json::Value::Object(payload))
}

/// Builds the fixture asset every clip in the test project points at.
fn fixture_asset(id: &str) -> Asset {
    let mut asset = Asset::new_video(
        "clip.mp4",
        "clip.mp4",
        VideoInfo {
            width: 1920,
            height: 1080,
            codec: "h264".to_string(),
            ..Default::default()
        },
    );
    asset.id = id.to_string();
    asset.duration_sec = Some(FIXTURE_ASSET_DURATION_SEC);
    asset.audio = Some(AudioInfo {
        sample_rate: 48_000,
        channels: 2,
        codec: "aac".to_string(),
        bitrate: None,
    });
    asset
}

fn video_clip(asset_id: &str, timeline_in_sec: f64, duration_sec: f64) -> Clip {
    let mut clip = Clip::with_range(asset_id, 0.0, duration_sec);
    clip.place.timeline_in_sec = timeline_in_sec;
    clip.place.duration_sec = duration_sec;
    clip
}

/// Builds a project that trips every fix-emitting rule at once.
///
/// * a hole between two clips on one track — `CloseGap`
/// * a sub-frame leftover clip — `RemoveClip`
/// * a caption pinned to the very bottom of the canvas — `UpdateCaption`
/// * a caption that reads too fast with no gap to grow into — `CreateCaption`
/// * a caption carrying an emoji the burn-in cannot draw — `UpdateCaption`
/// * a title card carrying one — `UpdateTextClip`
/// * a caption clip faded too far for any outline to rescue — `SetClipOpacity`
/// * black at the head of a clip whose source has room — `TrimClip`
/// * a clipped, over-loud mix — `SetMasterVolume`
fn project_with_every_fixable_finding() -> (Sequence, ProjectState) {
    const ASSET_ID: &str = "asset_fixture";

    let mut sequence = Sequence::new("QC Fix Round Trip", SequenceFormat::youtube_1080());

    let mut video = Track::new_video("V1");
    video.add_clip(video_clip(ASSET_ID, 0.0, 5.0));
    // Leaves an interior hole at 5.0-7.0 that a single-track ripple closes.
    video.add_clip(video_clip(ASSET_ID, 7.0, 5.0));
    // Well under two frames at 30 fps: a leftover from a split or a drag.
    video.add_clip(video_clip(ASSET_ID, 12.0, 0.01));
    sequence.add_track(video);

    let mut captions = Track::new_caption("C1");
    let mut caption = Clip::with_range("caption", 0.0, 2.0);
    caption.place.timeline_in_sec = 1.0;
    caption.place.duration_sec = 2.0;
    caption.label = Some("Caption pinned to the very bottom edge".to_string());
    caption.caption_position = Some(
        serde_json::to_value(CaptionPosition::Custom(
            crate::core::captions::CustomPosition {
                x_percent: 50.0,
                y_percent: 99.0,
            },
        ))
        .expect("caption position serialises"),
    );
    captions.add_clip(caption);

    // Far too much text for the time it is up, and the cue that follows starts
    // immediately, so the repair cannot simply extend it: it has to propose a
    // split, which is the only path that emits `CreateCaption`.
    let mut hurried = Clip::with_range("caption", 0.0, 0.2);
    hurried.place.timeline_in_sec = 4.0;
    hurried.place.duration_sec = 0.2;
    hurried.label = Some("Far too many characters to read in a fifth of a second".to_string());
    captions.add_clip(hurried);

    let mut follower = Clip::with_range("caption", 0.0, 0.8);
    follower.place.timeline_in_sec = 4.2;
    follower.place.duration_sec = 0.8;
    follower.label = Some("Next".to_string());
    captions.add_clip(follower);

    // Drawn at three tenths with no style of its own, so the style paints
    // opaque and the clip is the faded half: the contrast rule's fix is the
    // clip's opacity rather than a restyle. `measurements_for` carries the
    // band sample that reports it.
    let mut faded = Clip::with_range("caption", 0.0, 2.0);
    faded.place.timeline_in_sec = 6.0;
    faded.place.duration_sec = 2.0;
    faded.label = Some(FADED_CAPTION_LABEL.to_string());
    faded.opacity = 0.3;
    captions.add_clip(faded);

    // A colour emoji libass paints as a flat monochrome outline. Comfortably
    // slow to read and nowhere near an edge, so this cue trips the emoji rule
    // and nothing else, and its `UpdateCaption` carries a rewritten `text`
    // rather than the retimed `endSec` the reading-rate repair emits.
    let mut emoji = Clip::with_range("caption", 0.0, 3.0);
    emoji.place.timeline_in_sec = 9.0;
    emoji.place.duration_sec = 3.0;
    emoji.label = Some("Ship it \u{1F389} today".to_string());
    captions.add_clip(emoji);

    sequence.add_track(captions);

    let mut state = ProjectState::new("QC Fix Round Trip");
    state
        .assets
        .insert(ASSET_ID.to_string(), fixture_asset(ASSET_ID));

    // A title card carrying the same emoji, on a track of its own so it adds no
    // gap and no overlap for the other rules to find. The emoji rule repairs a
    // text overlay with `UpdateTextClip`, whose payload is a whole
    // `TextClipData` block rather than a handful of ids - the one fix in the
    // module that has to survive the strict parser as a nested struct.
    let mut titles = Track::new_video("V2");
    let (title, title_effect) = text_overlay_clip("Big sale \u{1F389} today", 0.0, 4.0);
    titles.add_clip(title);
    state.effects.insert(title_effect.id.clone(), title_effect);
    sequence.add_track(titles);

    (sequence, state)
}

/// The band sample that reports the fixture's faded caption cue.
///
/// White words on a near-white band, measured on the cue the fixture drew at
/// three tenths: no stroke can reach the contrast floor from there, so the rule
/// offers the opacity instead of the `standard-outline` pack.
fn faded_caption_sample(sequence: &Sequence) -> CaptionBandSample {
    let (track, clip) = sequence
        .tracks
        .iter()
        .filter(|track| track.is_caption())
        .find_map(|track| {
            track
                .clips
                .iter()
                .find(|clip| clip.label.as_deref() == Some(FADED_CAPTION_LABEL))
                .map(|clip| (track, clip))
        })
        .expect("the fixture holds a faded caption cue");

    CaptionBandSample {
        clip_id: clip.id.clone(),
        track_id: track.id.clone(),
        start_sec: clip.place.timeline_in_sec,
        end_sec: clip.timeline_end(),
        sampled_at_sec: clip.place.timeline_in_sec + clip.place.duration_sec / 2.0,
        band_luminance: 0.97,
        band_luminance_stddev: 0.01,
        text_luminance: 1.0,
        has_box: false,
        has_outline: false,
        box_alpha: 0.0,
        box_luminance: 0.0,
        layer_opacity: 0.3,
    }
}

/// Measurements that trip the rendered rules that carry fixes.
fn measurements_for(sequence: &Sequence) -> RenderMeasurements {
    RenderMeasurements {
        // Starts exactly at the first clip's head, so a slip is available.
        black_ranges: vec![(0.0, 0.6)],
        caption_band_samples: vec![faded_caption_sample(sequence)],
        // Over the ceiling: the peak rule suggests lowering the master.
        true_peak_dbtp: Some(-0.2),
        // Well above the -14 LUFS target, so the loudness fix is a cut rather
        // than a boost the peak would forbid.
        integrated_lufs: Some(-8.0),
        file_duration_sec: Some(sequence.duration()),
        ..Default::default()
    }
}

/// Runs every registered rule and returns the violations they produced.
async fn run_every_rule(sequence: &Sequence, state: &ProjectState) -> Vec<QCViolation> {
    QCEngine::new()
        .check_with_measurements(sequence, state, measurements_for(sequence))
        .await
        .expect("QC run completes")
        .violations
}

/// Feature: QC fix suggestions
/// Scenario: should emit only commands the real command parser accepts
#[tokio::test]
async fn test_every_suggested_fix_should_parse_as_a_real_command() {
    let (sequence, state) = project_with_every_fixable_finding();
    let violations = run_every_rule(&sequence, &state).await;

    let mut seen_types: Vec<String> = Vec::new();

    for violation in &violations {
        let Some(fix) = violation.suggested_fix.as_ref() else {
            // A violation with no fix is honest; only emitted fixes are graded.
            continue;
        };

        assert!(
            !fix.commands.is_empty(),
            "{} suggested a fix with no commands",
            violation.rule_name
        );

        for command in &fix.commands {
            let (command_type, payload) = split_command(command);

            CommandPayload::parse(command_type.clone(), payload.clone()).unwrap_or_else(|error| {
                panic!(
                    "{} suggested a fix the command layer rejects: {error}\n  commandType: \
                     {command_type}\n  payload: {payload}",
                    violation.rule_name
                )
            });

            if !seen_types.contains(&command_type) {
                seen_types.push(command_type);
            }
        }
    }

    seen_types.sort();
    assert_eq!(
        seen_types, EXPECTED_FIX_COMMAND_TYPES,
        "the fixture must keep tripping every fix-emitting rule, or the guard \
         stops guarding anything"
    );
}

/// Feature: QC fix suggestions
/// Scenario: should never claim auto-fixability without a fix to apply
#[tokio::test]
async fn test_auto_fixable_violations_should_always_carry_a_fix() {
    let (sequence, state) = project_with_every_fixable_finding();
    let violations = run_every_rule(&sequence, &state).await;

    for violation in &violations {
        // The implication runs one way only. A violation may carry a fix that
        // merely *proposes* something — a caption line split at a guessed word
        // boundary — and report `autoFixable: false`; what it may never do is
        // claim it can be fixed automatically by commands it does not carry.
        if violation.auto_fixable {
            assert!(
                violation.suggested_fix.is_some(),
                "{} claims it can be fixed automatically but carries no commands",
                violation.rule_name
            );
        }
    }
}

/// Feature: QC fix suggestions
/// Scenario: should mark a repair that only proposes something as not automatic
///
/// The counterpart of the guard above: a report where every fix claims to be
/// automatic sends an agent to apply edits nobody agreed to, so at least one
/// rule has to be honest about proposing rather than repairing.
#[tokio::test]
async fn test_a_proposed_caption_split_should_not_claim_to_be_automatic() {
    let (sequence, state) = project_with_every_fixable_finding();
    let violations = run_every_rule(&sequence, &state).await;

    let split = violations
        .iter()
        .find(|violation| {
            violation.suggested_fix.as_ref().is_some_and(|fix| {
                fix.commands
                    .iter()
                    .any(|command| command["type"] == "CreateCaption")
            })
        })
        .expect("the fixture holds a cue that can only be repaired by splitting it");

    assert!(
        !split.auto_fixable,
        "a split rewrites the caption into two lines, which is a proposal to read"
    );
}

/// Feature: QC fix suggestions
/// Scenario: should reject a command type that does not exist
///
/// Pins the guard itself: without this, a parser that accepted anything would
/// let the test above pass while proving nothing.
#[test]
fn test_the_guard_rejects_a_command_type_that_does_not_exist() {
    // The exact shape `AspectRatioRule` used to emit.
    let (command_type, payload) = split_command(&serde_json::json!({
        "type": "SetTransform",
        "clipId": "clip_1",
        "crop": { "fit": "cover" }
    }));

    assert!(CommandPayload::parse(command_type, payload).is_err());
}

/// Feature: QC fix suggestions
/// Scenario: should reject a real command carrying a field it does not define
#[test]
fn test_the_guard_rejects_an_unknown_field_on_a_real_command() {
    // The exact shape `BlackFrameRule` used to emit: a real command, missing
    // `trackId` and carrying a `trimStart` field the payload does not define.
    let (command_type, payload) = split_command(&serde_json::json!({
        "type": "TrimClip",
        "sequenceId": "seq_1",
        "clipId": "clip_1",
        "trimStart": 0.6
    }));

    assert!(CommandPayload::parse(command_type, payload).is_err());
}
