//! Contract guards for the curated style registries.
//!
//! A pack is only worth naming if naming it is safer than styling by hand. That
//! promise is checked here end to end rather than asserted in prose:
//!
//! * every caption pack survives the real command path — payload with
//!   `stylePack` through [`CommandPayload::parse`], execute, and back out of the
//!   clip as typed [`CaptionStyle`] — and then draws zero `CaptionSafeAreaRule`
//!   violations on both a 1920x1080 and a 1080x1920 canvas, with a negative
//!   control proving the rule can still fail;
//! * every caption pack's own typography reaches the `drawtext` filter through
//!   the render seam, so a pack cannot be legible on paper and generic in the
//!   export;
//! * every transition recipe resolves through `AddEffect` and builds the exact
//!   FFmpeg transition token and duration it advertises, not merely something
//!   from the right family.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::core::captions::{CaptionPosition, CaptionStyle};
use crate::core::commands::CommandExecutor;
use crate::core::effects::{Effect, EffectType, IntoFFmpegFilter, ParamValue};
use crate::core::project::ProjectState;
use crate::core::qc::context::QCContext;
use crate::core::qc::rules::{QCRule, RuleConfig};
use crate::core::qc::CaptionSafeAreaRule;
use crate::core::render::export::build_caption_drawtext_with_enable;
use crate::core::style::{
    caption_pack_ids, transition_recipe_ids, CAPTION_PACKS, TRANSITION_RECIPES,
};
use crate::core::timeline::{Clip, Sequence, SequenceFormat, Track, TrackKind};
use crate::ipc::CommandPayload;

/// Caption text long enough to exercise the safe-area width estimate.
const CAPTION_TEXT: &str = "The quick brown fox jumps over the lazy dog";

/// Builds a project holding one empty caption track and one video clip track.
fn project_with_caption_track(format: SequenceFormat) -> (ProjectState, String, String, String) {
    let mut state = ProjectState::new_empty("Curated Packs");

    let mut sequence = Sequence::new("Main", format);
    let mut video = Track::new_video("V1");
    let mut clip = Clip::with_range("asset_fixture", 0.0, 10.0);
    clip.place.timeline_in_sec = 0.0;
    clip.place.duration_sec = 10.0;
    let clip_id = clip.id.clone();
    video.add_clip(clip);
    sequence.add_track(video);

    let captions = Track::new_caption("C1");
    let caption_track_id = captions.id.clone();
    sequence.add_track(captions);

    let sequence_id = sequence.id.clone();
    state.active_sequence_id = Some(sequence_id.clone());
    state.sequences.insert(sequence_id.clone(), sequence);

    (state, sequence_id, caption_track_id, clip_id)
}

/// Runs a command through the full strict path: parse, build, execute.
fn execute_payload(
    state: &mut ProjectState,
    command_type: &str,
    payload: Value,
) -> Result<Vec<String>, String> {
    let parsed = CommandPayload::parse(command_type.to_string(), payload)?;
    let command = parsed.build_command(std::path::Path::new("."));
    let mut executor = CommandExecutor::new();
    executor
        .execute(command, state)
        .map(|result| result.created_ids)
        .map_err(|error| error.to_string())
}

/// Returns the caption clip a `CreateCaption` produced.
fn caption_clip<'a>(state: &'a ProjectState, sequence_id: &str, caption_id: &str) -> &'a Clip {
    state
        .sequences
        .get(sequence_id)
        .expect("sequence exists")
        .tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Caption)
        .flat_map(|track| track.clips.iter())
        .find(|clip| clip.id == caption_id)
        .expect("caption clip exists")
}

/// Runs `CaptionSafeAreaRule` over a sequence and returns its violations.
async fn safe_area_violations(state: &ProjectState, sequence_id: &str) -> Vec<String> {
    let sequence = state.sequences.get(sequence_id).expect("sequence exists");
    let rule = CaptionSafeAreaRule::new();
    let context = QCContext::from_sequence(sequence);
    let config = RuleConfig::default();

    let violations = rule
        .check(sequence, state, &config, &context)
        .await
        .expect("safe area rule runs");

    violations
        .into_iter()
        .map(|violation| format!("{} ({:?})", violation.message, violation.severity))
        .collect()
}

/// Creates one caption styled by `pack_id` and returns the resulting clip state.
fn create_caption_with_pack(format: SequenceFormat, pack_id: &str) -> (ProjectState, String, Clip) {
    create_caption_with_pack_and_style(format, pack_id, None)
}

/// Creates one caption styled by `pack_id` plus an optional style override.
fn create_caption_with_pack_and_style(
    format: SequenceFormat,
    pack_id: &str,
    style: Option<Value>,
) -> (ProjectState, String, Clip) {
    let (mut state, sequence_id, caption_track_id, _clip_id) = project_with_caption_track(format);

    let mut payload = json!({
        "sequenceId": sequence_id,
        "trackId": caption_track_id,
        "text": CAPTION_TEXT,
        "startSec": 1.0,
        "endSec": 4.0,
        "stylePack": pack_id,
    });
    if let Some(style) = style {
        payload["style"] = style;
    }

    let created = execute_payload(&mut state, "CreateCaption", payload)
        .unwrap_or_else(|error| panic!("pack '{pack_id}' must create a caption: {error}"));

    let caption_id = created.first().expect("caption id").clone();
    let clip = caption_clip(&state, &sequence_id, &caption_id).clone();

    (state, sequence_id, clip)
}

#[test]
fn every_caption_pack_round_trips_into_a_typed_style() {
    for pack in CAPTION_PACKS {
        let (_state, _sequence_id, clip) =
            create_caption_with_pack(SequenceFormat::youtube_1080(), pack.id);

        let style_json = clip
            .caption_style
            .as_ref()
            .unwrap_or_else(|| panic!("pack '{}' must store a caption style", pack.id));
        let style: CaptionStyle = serde_json::from_value(style_json.clone())
            .unwrap_or_else(|error| panic!("pack '{}' style must be typed: {error}", pack.id));
        assert_eq!(style, pack.style(), "pack '{}' style drifted", pack.id);

        let position_json = clip
            .caption_position
            .as_ref()
            .unwrap_or_else(|| panic!("pack '{}' must store a caption position", pack.id));
        let position: CaptionPosition = serde_json::from_value(position_json.clone())
            .unwrap_or_else(|error| panic!("pack '{}' position must be typed: {error}", pack.id));
        assert_eq!(
            position,
            pack.position(),
            "pack '{}' position drifted",
            pack.id
        );
    }
}

#[tokio::test]
async fn every_caption_pack_passes_the_safe_area_rule_on_both_canvases() {
    for pack in CAPTION_PACKS {
        for (label, format) in [
            ("1920x1080", SequenceFormat::youtube_1080()),
            ("1080x1920", SequenceFormat::shorts_1080()),
        ] {
            let (state, sequence_id, _clip) = create_caption_with_pack(format, pack.id);
            let violations = safe_area_violations(&state, &sequence_id).await;

            assert!(
                violations.is_empty(),
                "pack '{}' must be safe at {label}, got: {}",
                pack.id,
                violations.join("; ")
            );
        }
    }
}

#[tokio::test]
async fn the_safe_area_guarantee_is_falsifiable() {
    // Negative control for the test above. The rule measures the text block
    // against the canvas, so a pack perturbed past what the canvas can hold has
    // to fail — otherwise "every pack passes" would be a statement about the
    // rule's blind spots rather than about the packs.
    for pack in CAPTION_PACKS {
        for (label, format) in [
            ("1920x1080", SequenceFormat::youtube_1080()),
            ("1080x1920", SequenceFormat::shorts_1080()),
        ] {
            let (state, sequence_id, _clip) = create_caption_with_pack_and_style(
                format,
                pack.id,
                Some(json!({ "fontSize": 500 })),
            );
            let violations = safe_area_violations(&state, &sequence_id).await;

            assert!(
                !violations.is_empty(),
                "pack '{}' at 500px must be reported unsafe at {label}",
                pack.id
            );
        }
    }
}

#[test]
fn every_caption_pack_renders_its_own_typography_into_the_drawtext_filter() {
    let mut filters_by_pack: Vec<(&str, String)> = Vec::new();

    for pack in CAPTION_PACKS {
        let (_state, _sequence_id, clip) =
            create_caption_with_pack(SequenceFormat::youtube_1080(), pack.id);
        let style = pack.style();

        let filter = build_caption_drawtext_with_enable(&clip)
            .unwrap_or_else(|| panic!("pack '{}' must render a drawtext filter", pack.id));

        assert!(
            filter.starts_with("drawtext="),
            "pack '{}' must render drawtext, got: {filter}",
            pack.id
        );
        assert!(
            filter.contains("enable='between(t,"),
            "pack '{}' filter must be time gated, got: {filter}",
            pack.id
        );

        // The point of the pack is its typography, so the assertion is that the
        // pack's own values arrive — not that some drawtext filter exists.
        assert!(
            filter.contains(&format!("fontsize={}", style.font_size)),
            "pack '{}' must render at {}px, got: {filter}",
            pack.id,
            style.font_size
        );
        assert!(
            filter.contains(&format!("fontcolor={}", ffmpeg_color(&style.color))),
            "pack '{}' must render in its own color, got: {filter}",
            pack.id
        );

        match &style.background_color {
            Some(background) => {
                assert!(
                    filter.contains("box=1")
                        && filter.contains(&format!("boxcolor={}", ffmpeg_color(background))),
                    "pack '{}' must render its box at alpha {}, got: {filter}",
                    pack.id,
                    background.a
                );
            }
            None => assert!(
                !filter.contains("boxcolor="),
                "pack '{}' declares no box, got: {filter}",
                pack.id
            ),
        }

        match &style.outline_color {
            Some(outline) => assert!(
                filter.contains(&format!(":borderw={}", style.outline_width as i64))
                    && filter.contains(&format!("bordercolor={}", ffmpeg_color(outline))),
                "pack '{}' must render its outline, got: {filter}",
                pack.id
            ),
            None => assert!(
                !filter.contains("bordercolor="),
                "pack '{}' declares no outline, got: {filter}",
                pack.id
            ),
        }

        assert!(
            filter.contains(&format!("x={}", expected_x_expression(pack))),
            "pack '{}' must anchor where it says it does, got: {filter}",
            pack.id
        );

        filters_by_pack.push((pack.id, filter));
    }

    // Two packs that describe different looks must not compile to the same
    // filter: identical output would mean the differences never reached it.
    for (index, (id, filter)) in filters_by_pack.iter().enumerate() {
        for (other_id, other_filter) in filters_by_pack.iter().skip(index + 1) {
            assert_ne!(
                filter, other_filter,
                "packs '{id}' and '{other_id}' render identically"
            );
        }
    }
}

/// Renders a pack color the way `hex_to_ffmpeg_color` does.
///
/// Full opacity has no `@alpha` suffix; anything else carries the alpha the
/// pack declared, which is what makes a translucent box translucent.
fn ffmpeg_color(color: &crate::core::captions::Color) -> String {
    let hex = format!("0x{:02X}{:02X}{:02X}", color.r, color.g, color.b);
    if color.a == 255 {
        hex
    } else {
        format!("{hex}@{:.2}", f64::from(color.a) / 255.0)
    }
}

/// The `x=` expression a pack's anchor and alignment must produce.
fn expected_x_expression(pack: &crate::core::style::CaptionPackSpec) -> String {
    let (x_norm, alignment) = match pack.position() {
        CaptionPosition::Preset { .. } => (0.5, pack.style().alignment),
        CaptionPosition::Custom(custom) => (custom.x_percent / 100.0, pack.style().alignment),
    };

    match alignment {
        crate::core::captions::TextAlignment::Left => format!("(w*{x_norm:.4})"),
        crate::core::captions::TextAlignment::Right => format!("(w*{x_norm:.4})-text_w"),
        crate::core::captions::TextAlignment::Center => format!("(w*{x_norm:.4})-(text_w/2)"),
    }
}

#[test]
fn explicit_style_field_overrides_only_that_pack_key() {
    let (mut state, sequence_id, caption_track_id, _clip_id) =
        project_with_caption_track(SequenceFormat::youtube_1080());

    let created = execute_payload(
        &mut state,
        "CreateCaption",
        json!({
            "sequenceId": sequence_id,
            "trackId": caption_track_id,
            "text": CAPTION_TEXT,
            "startSec": 0.0,
            "endSec": 2.0,
            "stylePack": "boxed-contrast",
            "style": { "fontSize": 96, "italic": true },
        }),
    )
    .expect("pack plus overrides must execute");

    let caption_id = created.first().expect("caption id");
    let clip = caption_clip(&state, &sequence_id, caption_id);
    let style: CaptionStyle =
        serde_json::from_value(clip.caption_style.clone().expect("style")).expect("typed style");
    let pack_style = crate::core::style::resolve_caption_pack("boxed-contrast")
        .expect("pack resolves")
        .style();

    // Overridden.
    assert_eq!(style.font_size, 96);
    assert!(style.italic);
    // Inherited from the pack.
    assert_eq!(style.background_color, pack_style.background_color);
    assert_eq!(style.font_family, pack_style.font_family);
    assert_eq!(style.alignment, pack_style.alignment);
}

#[test]
fn explicit_position_replaces_the_pack_anchor() {
    let (mut state, sequence_id, caption_track_id, _clip_id) =
        project_with_caption_track(SequenceFormat::youtube_1080());

    let created = execute_payload(
        &mut state,
        "CreateCaption",
        json!({
            "sequenceId": sequence_id,
            "trackId": caption_track_id,
            "text": CAPTION_TEXT,
            "startSec": 0.0,
            "endSec": 2.0,
            "stylePack": "clean-minimal",
            "position": { "type": "preset", "vertical": "top", "marginPercent": 25.0 },
        }),
    )
    .expect("pack plus position override must execute");

    let caption_id = created.first().expect("caption id");
    let clip = caption_clip(&state, &sequence_id, caption_id);
    let position: CaptionPosition =
        serde_json::from_value(clip.caption_position.clone().expect("position"))
            .expect("typed position");

    assert_eq!(
        position,
        CaptionPosition::Preset {
            vertical: crate::core::captions::VerticalPosition::Top,
            margin_percent: 25.0,
        }
    );
}

#[test]
fn a_type_less_custom_position_replaces_the_pack_anchor() {
    // The CLI accepts `--position-json '{"xPercent":…,"yPercent":…}'` without a
    // `type`, and `command execute` accepts the same object. Merging it into a
    // preset pack anchor would keep the pack's placement and leave the caller's
    // coordinates as keys the render path never reads.
    let (mut state, sequence_id, caption_track_id, _clip_id) =
        project_with_caption_track(SequenceFormat::youtube_1080());

    let created = execute_payload(
        &mut state,
        "CreateCaption",
        json!({
            "sequenceId": sequence_id,
            "trackId": caption_track_id,
            "text": CAPTION_TEXT,
            "startSec": 0.0,
            "endSec": 2.0,
            "stylePack": "clean-minimal",
            "position": { "xPercent": 25.0, "yPercent": 80.0 },
        }),
    )
    .expect("pack plus a type-less custom position must execute");

    let caption_id = created.first().expect("caption id");
    let clip = caption_clip(&state, &sequence_id, caption_id);
    let stored = clip.caption_position.clone().expect("position");

    assert_eq!(stored, json!({ "xPercent": 25.0, "yPercent": 80.0 }));

    // And it has to survive all the way into the filter, which is the only
    // place the difference is observable.
    let filter = build_caption_drawtext_with_enable(clip).expect("drawtext filter");
    assert!(
        filter.contains("x=(w*0.2500)"),
        "the requested anchor must reach the filter, got: {filter}"
    );
}

#[test]
fn update_caption_with_only_a_pack_leaves_the_caption_where_it_is() {
    let (mut state, sequence_id, caption_track_id, _clip_id) =
        project_with_caption_track(SequenceFormat::youtube_1080());

    let created = execute_payload(
        &mut state,
        "CreateCaption",
        json!({
            "sequenceId": sequence_id,
            "trackId": caption_track_id,
            "text": CAPTION_TEXT,
            "startSec": 0.0,
            "endSec": 2.0,
            "position": { "type": "preset", "vertical": "top", "marginPercent": 12.0 },
        }),
    )
    .expect("caption must execute");
    let caption_id = created.first().expect("caption id").clone();

    execute_payload(
        &mut state,
        "UpdateCaption",
        json!({
            "sequenceId": sequence_id,
            "trackId": caption_track_id,
            "captionId": caption_id,
            "stylePack": "boxed-contrast",
        }),
    )
    .expect("restyle must execute");

    let clip = caption_clip(&state, &sequence_id, &caption_id);
    let position: CaptionPosition =
        serde_json::from_value(clip.caption_position.clone().expect("position"))
            .expect("typed position");

    // A restyle is not a move: the caption was deliberately placed at the top,
    // and the pack's bottom anchor must not drag it back down.
    assert_eq!(
        position,
        CaptionPosition::Preset {
            vertical: crate::core::captions::VerticalPosition::Top,
            margin_percent: 12.0,
        }
    );
    let style: CaptionStyle =
        serde_json::from_value(clip.caption_style.clone().expect("style")).expect("typed style");
    assert_eq!(
        style,
        crate::core::style::resolve_caption_pack("boxed-contrast")
            .expect("pack resolves")
            .style()
    );
}

#[test]
fn update_caption_applies_a_pack_to_an_existing_caption() {
    let (mut state, sequence_id, caption_track_id, _clip_id) =
        project_with_caption_track(SequenceFormat::youtube_1080());

    let created = execute_payload(
        &mut state,
        "CreateCaption",
        json!({
            "sequenceId": sequence_id,
            "trackId": caption_track_id,
            "text": CAPTION_TEXT,
            "startSec": 0.0,
            "endSec": 2.0,
        }),
    )
    .expect("plain caption must execute");
    let caption_id = created.first().expect("caption id").clone();

    execute_payload(
        &mut state,
        "UpdateCaption",
        json!({
            "sequenceId": sequence_id,
            "trackId": caption_track_id,
            "captionId": caption_id,
            "stylePack": "high-contrast-accessible",
        }),
    )
    .expect("restyle must execute");

    let clip = caption_clip(&state, &sequence_id, &caption_id);
    let style: CaptionStyle =
        serde_json::from_value(clip.caption_style.clone().expect("style")).expect("typed style");

    assert_eq!(
        style,
        crate::core::style::resolve_caption_pack("high-contrast-accessible")
            .expect("pack resolves")
            .style()
    );
}

#[tokio::test]
async fn import_generated_captions_applies_a_pack_to_every_cue() {
    let (mut state, sequence_id, caption_track_id, _clip_id) =
        project_with_caption_track(SequenceFormat::shorts_1080());

    execute_payload(
        &mut state,
        "ImportGeneratedCaptions",
        json!({
            "sequenceId": sequence_id,
            "trackId": caption_track_id,
            "stylePack": "shorts-bold-outline",
            "segments": [
                { "startSec": 0.0, "endSec": 1.5, "text": "First cue" },
                { "startSec": 1.5, "endSec": 3.0, "text": "Second cue" },
            ],
        }),
    )
    .expect("import must execute");

    let expected = crate::core::style::resolve_caption_pack("shorts-bold-outline")
        .expect("pack resolves")
        .style();

    let sequence = state.sequences.get(&sequence_id).expect("sequence");
    let captions: Vec<&Clip> = sequence
        .tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Caption)
        .flat_map(|track| track.clips.iter())
        .collect();

    assert_eq!(captions.len(), 2);
    for clip in captions {
        let style: CaptionStyle =
            serde_json::from_value(clip.caption_style.clone().expect("style")).expect("typed");
        assert_eq!(style, expected);
    }

    assert!(safe_area_violations(&state, &sequence_id).await.is_empty());
}

#[test]
fn unknown_caption_pack_is_rejected_with_the_valid_list() {
    let (mut state, sequence_id, caption_track_id, _clip_id) =
        project_with_caption_track(SequenceFormat::youtube_1080());

    let error = execute_payload(
        &mut state,
        "CreateCaption",
        json!({
            "sequenceId": sequence_id,
            "trackId": caption_track_id,
            "text": CAPTION_TEXT,
            "startSec": 0.0,
            "endSec": 2.0,
            "stylePack": "not-a-pack",
        }),
    )
    .expect_err("unknown pack must be rejected");

    for id in caption_pack_ids() {
        assert!(error.contains(id), "error must name '{id}': {error}");
    }
}

/// Adds `payload` as an `AddEffect` on the fixture's video clip.
fn add_effect(
    state: &mut ProjectState,
    sequence_id: &str,
    clip_id: &str,
    mut payload: Value,
) -> String {
    let track_id = state
        .sequences
        .get(sequence_id)
        .expect("sequence")
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Video)
        .expect("video track")
        .id
        .clone();

    payload["sequenceId"] = json!(sequence_id);
    payload["trackId"] = json!(track_id);
    payload["clipId"] = json!(clip_id);

    let created = execute_payload(state, "AddEffect", payload).expect("AddEffect must execute");
    created.first().expect("effect id").clone()
}

#[test]
fn every_transition_recipe_builds_the_exact_filter_it_advertises() {
    // Family prefixes are useless as a guard: every wipe direction shares
    // `xfade=transition=wipe`, and all three dissolves share
    // `xfade=transition=dissolve`. What distinguishes one curated entry from
    // its sibling is the direction token, the duration, or the fade side, so
    // that is what has to be asserted.
    for recipe in TRANSITION_RECIPES {
        let (mut state, sequence_id, _caption_track_id, clip_id) =
            project_with_caption_track(SequenceFormat::youtube_1080());

        let effect_id = add_effect(
            &mut state,
            &sequence_id,
            &clip_id,
            json!({ "recipe": recipe.id }),
        );
        let effect: &Effect = state.effects.get(&effect_id).expect("effect stored");

        assert_eq!(
            effect.effect_type, recipe.effect_type,
            "recipe '{}' applied the wrong effect type",
            recipe.id
        );

        let filter = effect.to_filter_string("in", "out");
        let expected = match recipe.id {
            "dissolve-soft" => "xfade=transition=dissolve:duration=0.5000:offset=0.0000",
            "dissolve-standard" => "xfade=transition=dissolve:duration=1.0000:offset=0.0000",
            "dissolve-long" => "xfade=transition=dissolve:duration=2.0000:offset=0.0000",
            "fade-in" => "fade=t=in:st=0:d=1.0000",
            // The fixture clip is 10s, so the tail anchor is 10 - 1.
            "fade-out" => "fade=t=out:st=9.0000:d=1.0000",
            "wipe-left" => "xfade=transition=wipeleft:duration=0.7000:offset=0.0000",
            "wipe-right" => "xfade=transition=wiperight:duration=0.7000:offset=0.0000",
            "wipe-up" => "xfade=transition=wipeup:duration=0.7000:offset=0.0000",
            "wipe-down" => "xfade=transition=wipedown:duration=0.7000:offset=0.0000",
            "slide-left" => "xfade=transition=slideleft:duration=0.5000:offset=0.0000",
            "slide-right" => "xfade=transition=slideright:duration=0.5000:offset=0.0000",
            other => panic!(
                "recipe '{other}' has no expected filter; add one rather than \
                 letting a new curated entry ship unasserted"
            ),
        };

        assert!(
            filter.contains(expected),
            "recipe '{}' must build '{expected}', got: {filter}",
            recipe.id
        );
    }
}

#[test]
fn fade_out_is_anchored_on_the_clip_tail() {
    // The filter builder measures `st` from the clip's own zero, so a fade-out
    // that keeps the default 0 fades during the first second and holds black
    // for the rest of the clip.
    let (mut state, sequence_id, _caption_track_id, clip_id) =
        project_with_caption_track(SequenceFormat::youtube_1080());

    let effect_id = add_effect(
        &mut state,
        &sequence_id,
        &clip_id,
        json!({ "recipe": "fade-out" }),
    );
    let effect = state.effects.get(&effect_id).expect("effect stored");

    assert_eq!(effect.get_float("start_time"), Some(9.0));
    assert!(effect
        .to_filter_string("in", "out")
        .contains("fade=t=out:st=9.0000:d=1.0000"));
}

#[test]
fn fade_out_longer_than_its_clip_becomes_the_whole_clip() {
    let (mut state, sequence_id, _caption_track_id, clip_id) =
        project_with_caption_track(SequenceFormat::youtube_1080());

    let effect_id = add_effect(
        &mut state,
        &sequence_id,
        &clip_id,
        json!({ "recipe": "fade-out", "params": { "duration": 25.0 } }),
    );
    let effect = state.effects.get(&effect_id).expect("effect stored");

    assert_eq!(effect.get_float("start_time"), Some(0.0));
    assert_eq!(effect.get_float("duration"), Some(10.0));
}

#[test]
fn an_explicit_fade_start_time_is_never_overwritten() {
    let (mut state, sequence_id, _caption_track_id, clip_id) =
        project_with_caption_track(SequenceFormat::youtube_1080());

    let effect_id = add_effect(
        &mut state,
        &sequence_id,
        &clip_id,
        json!({ "recipe": "fade-out", "params": { "start_time": 2.0 } }),
    );
    let effect = state.effects.get(&effect_id).expect("effect stored");

    assert_eq!(effect.get_float("start_time"), Some(2.0));
}

#[test]
fn explicit_param_overrides_the_recipe_duration() {
    let (mut state, sequence_id, _caption_track_id, clip_id) =
        project_with_caption_track(SequenceFormat::youtube_1080());
    let track_id = state
        .sequences
        .get(&sequence_id)
        .expect("sequence")
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Video)
        .expect("video track")
        .id
        .clone();

    let created = execute_payload(
        &mut state,
        "AddEffect",
        json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": clip_id,
            "recipe": "dissolve-soft",
            "params": { "duration": 3.0 },
        }),
    )
    .expect("recipe plus override must execute");

    let effect = state
        .effects
        .get(created.first().expect("effect id"))
        .expect("effect stored");

    assert_eq!(effect.get_float("duration"), Some(3.0));
    assert_eq!(effect.get_float("offset"), Some(0.0));
}

#[test]
fn recipe_conflicting_with_an_explicit_effect_type_is_rejected() {
    let (mut state, sequence_id, _caption_track_id, clip_id) =
        project_with_caption_track(SequenceFormat::youtube_1080());
    let track_id = state
        .sequences
        .get(&sequence_id)
        .expect("sequence")
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Video)
        .expect("video track")
        .id
        .clone();

    let error = execute_payload(
        &mut state,
        "AddEffect",
        json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "clipId": clip_id,
            "recipe": "dissolve-soft",
            "effectType": "wipe",
        }),
    )
    .expect_err("conflicting effect type must be rejected");

    assert!(error.contains("dissolve-soft"), "{error}");
}

#[test]
fn unknown_transition_recipe_is_rejected_with_the_valid_list() {
    let error = CommandPayload::parse(
        "AddEffect".to_string(),
        json!({
            "sequenceId": "seq",
            "trackId": "track",
            "clipId": "clip",
            "recipe": "not-a-recipe",
        }),
    )
    .expect_err("unknown recipe must be rejected");

    for id in transition_recipe_ids() {
        assert!(error.contains(id), "error must name '{id}': {error}");
    }
}

#[test]
fn add_effect_without_a_type_or_recipe_is_rejected() {
    let error = CommandPayload::parse(
        "AddEffect".to_string(),
        json!({
            "sequenceId": "seq",
            "trackId": "track",
            "clipId": "clip",
        }),
    )
    .expect_err("a typeless AddEffect must be rejected");

    assert!(error.contains("effectType"), "{error}");
    assert!(error.contains("recipe"), "{error}");
}

#[test]
fn add_effect_still_accepts_a_plain_effect_type() {
    let parsed = CommandPayload::parse(
        "AddEffect".to_string(),
        json!({
            "sequenceId": "seq",
            "trackId": "track",
            "clipId": "clip",
            "effectType": "gaussian_blur",
            "params": { "radius": 4.0 },
        }),
    )
    .expect("a plain AddEffect must still parse");

    let CommandPayload::AddEffect(payload) = parsed else {
        panic!("parsed the wrong variant");
    };
    assert_eq!(payload.effect_type, Some(EffectType::GaussianBlur));
    assert_eq!(
        payload.params.get("radius"),
        Some(&ParamValue::Float(4.0)),
        "explicit params must survive resolution"
    );
}

#[test]
fn caption_payloads_without_a_pack_are_untouched() {
    let style = json!({ "fontSize": 21 });
    let parsed = CommandPayload::parse(
        "CreateCaption".to_string(),
        json!({
            "sequenceId": "seq",
            "trackId": "track",
            "text": "hello",
            "startSec": 0.0,
            "endSec": 1.0,
            "style": style,
        }),
    )
    .expect("plain caption payload must parse");

    let CommandPayload::CreateCaption(payload) = parsed else {
        panic!("parsed the wrong variant");
    };
    assert_eq!(payload.style, Some(style));
    assert_eq!(payload.position, None);
}

#[test]
fn resolution_survives_a_payload_round_trip() {
    let parsed = CommandPayload::parse(
        "CreateCaption".to_string(),
        json!({
            "sequenceId": "seq",
            "trackId": "track",
            "text": "hello",
            "startSec": 0.0,
            "endSec": 1.0,
            "stylePack": "yellow-classic",
        }),
    )
    .expect("pack payload must parse");

    let CommandPayload::CreateCaption(payload) = parsed else {
        panic!("parsed the wrong variant");
    };
    let serialized = serde_json::to_value(&payload).expect("payload serializes");

    let reparsed = CommandPayload::parse("CreateCaption".to_string(), serialized)
        .expect("resolved payload must re-parse");
    let CommandPayload::CreateCaption(reparsed) = reparsed else {
        panic!("parsed the wrong variant");
    };

    assert_eq!(reparsed.style, payload.style);
    assert_eq!(reparsed.position, payload.position);
    assert_eq!(reparsed.style_pack.as_deref(), Some("yellow-classic"));
}

#[test]
fn recipe_params_do_not_leak_between_recipes() {
    // A guard against a shared-mutable-table style regression: resolving one
    // recipe must not observe another's parameters.
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for recipe in TRANSITION_RECIPES {
        let resolved =
            crate::core::style::resolve_effect_recipe(Some(recipe.id), None, HashMap::new())
                .expect("resolves");
        seen.insert(recipe.id, resolved.params.len());
        assert_eq!(
            resolved.params.len(),
            recipe.params().len(),
            "recipe '{}' gained or lost parameters",
            recipe.id
        );
    }
    assert_eq!(seen.len(), TRANSITION_RECIPES.len());
}
