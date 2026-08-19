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
//!   from the right family;
//! * every text preset — and every alias of one — survives `AddTextClip`,
//!   stores the exact [`TextClipData`](crate::core::text::TextClipData) the
//!   registry declares, leaves no preset id behind in the logged op, and
//!   renders its own typography into the overlay `drawtext` filter;
//! * `src/data/textPresets.manifest.json` still equals this registry, which is
//!   what stops the TypeScript catalog from drifting away from it.

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
    caption_pack_ids, transition_recipe_ids, CAPTION_PACKS, TEXT_PRESETS, TRANSITION_RECIPES,
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
            "dissolve-soft" => "xfade=transition=dissolve:duration=0.5000",
            "dissolve-standard" => "xfade=transition=dissolve:duration=1.0000",
            "dissolve-long" => "xfade=transition=dissolve:duration=2.0000",
            "fade-in" => "fade=t=in:st=0:d=1.0000",
            // The fixture clip is 10s, so the tail anchor is 10 - 1.
            "fade-out" => "fade=t=out:st=9.0000:d=1.0000",
            "wipe-left" => "xfade=transition=wipeleft:duration=0.7000",
            "wipe-right" => "xfade=transition=wiperight:duration=0.7000",
            "wipe-up" => "xfade=transition=wipeup:duration=0.7000",
            "wipe-down" => "xfade=transition=wipedown:duration=0.7000",
            "slide-left" => "xfade=transition=slideleft:duration=0.5000",
            "slide-right" => "xfade=transition=slideright:duration=0.5000",
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
    // A recipe never records an offset: the render stitch derives it.
    assert_eq!(effect.get_float("offset"), None);
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

// =============================================================================
// Curated text presets
// =============================================================================

/// Copy short enough to stay legible and distinct from any preset's own text.
const TEXT_OVERLAY_CONTENT: &str = "Contract Text";

/// Builds a project holding one video track and returns its ids.
fn project_with_video_track() -> (ProjectState, String, String) {
    let mut state = ProjectState::new_empty("Curated Text Presets");

    let mut sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
    let video = Track::new_video("V1");
    let track_id = video.id.clone();
    sequence.add_track(video);

    let sequence_id = sequence.id.clone();
    state.active_sequence_id = Some(sequence_id.clone());
    state.sequences.insert(sequence_id.clone(), sequence);

    (state, sequence_id, track_id)
}

/// Adds one text clip from `preset` and returns the resulting project and clip.
fn add_text_clip_with_preset(preset_id: &str, text_data: Option<Value>) -> (ProjectState, Clip) {
    let (mut state, sequence_id, track_id) = project_with_video_track();

    let mut payload = json!({
        "sequenceId": sequence_id,
        "trackId": track_id,
        "timelineIn": 1.0,
        "duration": 4.0,
        "preset": preset_id,
    });
    if let Some(text_data) = text_data {
        payload["textData"] = text_data;
    }

    let created = execute_payload(&mut state, "AddTextClip", payload)
        .unwrap_or_else(|error| panic!("preset '{preset_id}' must add a text clip: {error}"));
    let clip_id = created.first().expect("clip id").clone();

    let clip = state
        .sequences
        .get(&sequence_id)
        .expect("sequence exists")
        .tracks
        .iter()
        .flat_map(|track| track.clips.iter())
        .find(|clip| clip.id == clip_id)
        .expect("text clip exists")
        .clone();

    (state, clip)
}

/// Renders a preset color the way `hex_to_ffmpeg_color` does.
///
/// Full opacity has no `@alpha` suffix. Only the RGB triplet is read, which is
/// why an `#RRGGBBAA` background's own alpha does not appear here: the drawtext
/// path composes alpha from the clip opacity instead.
fn ffmpeg_hex_color(hex: &str, opacity: f64) -> String {
    let clean = hex.trim().trim_start_matches('#');
    let rgb = &clean[0..6];
    let opacity = opacity.clamp(0.0, 1.0);
    if (opacity - 1.0).abs() < 0.001 {
        format!("0x{}", rgb.to_ascii_uppercase())
    } else {
        format!("0x{}@{:.2}", rgb.to_ascii_uppercase(), opacity)
    }
}

/// The ASS script the libass export path burns this project's overlays with.
fn ass_script_for(state: &ProjectState) -> String {
    let sequence_id = state
        .active_sequence_id
        .clone()
        .expect("the fixture sets an active sequence");
    let sequence = state.sequences.get(&sequence_id).expect("sequence exists");
    crate::core::render::export::build_ass_text_overlay_script(sequence, &state.effects)
        .expect("the ASS script must build")
        .expect("a text overlay must produce an ASS script")
}

/// The preview render spec the graph hands the compositor for the text clip.
fn preview_text_render_spec(state: &ProjectState) -> crate::core::render::graph::TextRenderSpec {
    let sequence_id = state
        .active_sequence_id
        .clone()
        .expect("the fixture sets an active sequence");
    let graph = crate::core::render::graph::build_render_graph(state, &sequence_id)
        .expect("the render graph must build");

    graph
        .visual_layers
        .iter()
        .find_map(|layer| match &layer.source {
            crate::core::render::graph::VisualRenderSource::Text { render_spec, .. } => {
                render_spec.clone()
            }
            _ => None,
        })
        .expect("the text clip must reach the preview graph with a render spec")
}

/// The `x=` expression a preset's anchor and alignment must produce.
fn expected_text_x_expression(clip_data: &crate::core::text::TextClipData) -> String {
    let x = clip_data.position.x;
    match clip_data.style.alignment {
        crate::core::text::TextAlignment::Left => format!("(w*{x:.4})"),
        crate::core::text::TextAlignment::Right => format!("(w*{x:.4})-text_w"),
        crate::core::text::TextAlignment::Center => format!("(w*{x:.4})-(text_w/2)"),
    }
}

#[test]
fn every_text_preset_round_trips_into_typed_clip_data() {
    for preset in TEXT_PRESETS {
        let (state, clip) = add_text_clip_with_preset(preset.id, None);

        assert!(
            crate::core::commands::is_text_clip(&clip),
            "preset '{}' must produce a text clip",
            preset.id
        );

        let stored = crate::core::commands::get_text_data(&clip, &state)
            .unwrap_or_else(|| panic!("preset '{}' must store text data", preset.id));

        assert_eq!(
            stored,
            preset.default_clip_data(),
            "preset '{}' drifted between the registry and the clip",
            preset.id
        );
    }
}

#[test]
fn every_text_preset_alias_resolves_to_the_same_clip_data() {
    for preset in TEXT_PRESETS {
        let expected = preset.default_clip_data();
        for alias in preset.aliases {
            let (state, clip) = add_text_clip_with_preset(alias, None);
            let stored = crate::core::commands::get_text_data(&clip, &state)
                .unwrap_or_else(|| panic!("alias '{alias}' must store text data"));
            assert_eq!(
                stored, expected,
                "alias '{alias}' must produce the '{}' overlay",
                preset.id
            );
        }
    }
}

#[test]
fn explicit_text_data_overrides_the_preset_key_by_key() {
    let (state, clip) = add_text_clip_with_preset(
        "quote",
        Some(json!({
            "content": TEXT_OVERLAY_CONTENT,
            "style": { "fontSize": 64 },
        })),
    );

    let stored = crate::core::commands::get_text_data(&clip, &state).expect("text data");
    let preset = crate::core::style::resolve_text_preset("quote").expect("preset");

    assert_eq!(stored.content, TEXT_OVERLAY_CONTENT);
    assert_eq!(stored.style.font_size, 64);
    // Everything the caller did not mention still comes from the preset.
    assert_eq!(stored.style.font_family, preset.style().font_family);
    assert!(stored.style.italic, "the quote preset is italic");
    assert_eq!(stored.opacity, preset.default_clip_data().opacity);
    assert_eq!(stored.shadow, preset.default_clip_data().shadow);
}

/// Asserts every render path agrees the overlay is regular weight, not bold.
///
/// `bold` and `fontWeight` are two spellings of one decision, and each render
/// path reconciles them by OR-ing, so a stored pair that disagrees renders bold
/// no matter which half said otherwise. Checking the merged JSON alone would
/// miss exactly that.
fn assert_renders_regular_weight(state: &ProjectState, clip: &Clip, case: &str) {
    let stored = crate::core::commands::get_text_data(clip, state)
        .unwrap_or_else(|| panic!("{case}: the clip must store text data"));
    assert!(!stored.style.bold, "{case}: readback must not claim bold");
    assert_eq!(
        stored.style.font_weight, 400,
        "{case}: readback weight must agree with the readback bold flag"
    );

    // drawtext expresses bold through the fontconfig style suffix.
    let filter =
        crate::core::render::export::build_text_clip_drawtext_with_enable(clip, &state.effects)
            .unwrap_or_else(|error| panic!("{case}: the filter must build: {error}"));
    assert!(
        !filter.contains(":style=Bold"),
        "{case}: drawtext must not select a bold face, got: {filter}"
    );

    // The ASS export carries the weight into every dialogue line.
    let script = ass_script_for(state);
    assert!(
        script.contains(r"\b400") && !script.contains(r"\b700"),
        "{case}: the ASS event must carry weight 400, got: {script}"
    );

    // The preview graph reconciles the same pair for the canvas compositor.
    let spec = preview_text_render_spec(state);
    assert!(
        !spec.style.bold,
        "{case}: the preview spec must not be bold, got: {spec:?}"
    );
    assert_eq!(
        spec.style.font_weight, 400,
        "{case}: the preview spec weight must agree with its bold flag"
    );
}

#[test]
fn turning_bold_off_on_a_bold_preset_renders_regular_everywhere() {
    // `centered-title` is bold, so its serialized base carries fontWeight 700.
    // A caller who never mentions fontWeight must still get a regular overlay.
    let (state, clip) = add_text_clip_with_preset(
        "centered-title",
        Some(json!({
            "content": TEXT_OVERLAY_CONTENT,
            "style": { "bold": false },
        })),
    );

    assert_renders_regular_weight(&state, &clip, "bold:false");

    // Nothing else about the preset moved.
    let preset = crate::core::style::resolve_text_preset("centered-title").expect("preset");
    let stored = crate::core::commands::get_text_data(&clip, &state).expect("text data");
    assert_eq!(stored.style.font_size, preset.style().font_size);
    assert_eq!(stored.position, preset.position());
}

#[test]
fn lowering_the_font_weight_on_a_bold_preset_renders_regular_everywhere() {
    // The symmetric case: naming only the numeric half must drop `bold` too,
    // or the effect layer promotes the weight straight back to 700.
    let (state, clip) = add_text_clip_with_preset(
        "centered-title",
        Some(json!({
            "content": TEXT_OVERLAY_CONTENT,
            "style": { "fontWeight": 400 },
        })),
    );

    assert_renders_regular_weight(&state, &clip, "fontWeight:400");
}

#[test]
fn naming_both_halves_of_the_weight_pair_keeps_both() {
    // With both named there is nothing to infer, so neither is rewritten —
    // which is also what makes replaying a resolved op idempotent.
    let (state, clip) = add_text_clip_with_preset(
        "subtitle",
        Some(json!({
            "content": TEXT_OVERLAY_CONTENT,
            "style": { "bold": true, "fontWeight": 900 },
        })),
    );

    let stored = crate::core::commands::get_text_data(&clip, &state).expect("text data");
    assert!(stored.style.bold);
    assert_eq!(stored.style.font_weight, 900);

    let filter =
        crate::core::render::export::build_text_clip_drawtext_with_enable(&clip, &state.effects)
            .expect("filter builds");
    assert!(filter.contains(":style=Bold"), "got: {filter}");
    assert!(ass_script_for(&state).contains(r"\b900"));
    assert!(preview_text_render_spec(&state).style.bold);
}

#[test]
fn an_explicit_null_layer_clears_the_preset_layer() {
    let (state, clip) = add_text_clip_with_preset(
        "epic-title",
        Some(json!({ "content": TEXT_OVERLAY_CONTENT, "outline": null })),
    );

    let stored = crate::core::commands::get_text_data(&clip, &state).expect("text data");
    assert!(
        stored.outline.is_none(),
        "an explicit null must drop the preset's outline"
    );
    assert!(
        stored.shadow.is_some(),
        "clearing one layer must not clear another"
    );
}

#[test]
fn a_partial_shadow_override_merges_on_every_preset() {
    // `epic-title` declares a shadow, `watermark` does not. The same fragment
    // has to mean the same thing on both, or an agent that learned the pattern
    // from one preset gets a parse error about a field it never named.
    for (preset_id, declares_shadow) in [("epic-title", true), ("watermark", false)] {
        let (state, clip) = add_text_clip_with_preset(
            preset_id,
            Some(json!({
                "content": TEXT_OVERLAY_CONTENT,
                "shadow": { "offsetX": 7 },
            })),
        );

        let stored = crate::core::commands::get_text_data(&clip, &state)
            .unwrap_or_else(|| panic!("preset '{preset_id}' must store text data"));
        let shadow = stored
            .shadow
            .unwrap_or_else(|| panic!("preset '{preset_id}' must carry the merged shadow"));

        assert_eq!(shadow.offset_x, 7, "preset '{preset_id}'");

        let base = crate::core::style::resolve_text_preset(preset_id)
            .expect("preset")
            .default_clip_data()
            .shadow
            .unwrap_or_default();
        assert_eq!(
            (shadow.color.as_str(), shadow.offset_y, shadow.blur),
            (base.color.as_str(), base.offset_y, base.blur),
            "preset '{preset_id}' must keep the rest of the layer \
             (declared: {declares_shadow})"
        );
    }
}

#[test]
fn a_partial_outline_override_merges_on_every_preset() {
    for preset_id in ["epic-title", "subtitle"] {
        let (state, clip) = add_text_clip_with_preset(
            preset_id,
            Some(json!({
                "content": TEXT_OVERLAY_CONTENT,
                "outline": { "width": 3 },
            })),
        );

        let stored = crate::core::commands::get_text_data(&clip, &state)
            .unwrap_or_else(|| panic!("preset '{preset_id}' must store text data"));
        let outline = stored
            .outline
            .unwrap_or_else(|| panic!("preset '{preset_id}' must carry the merged outline"));

        assert_eq!(outline.width, 3, "preset '{preset_id}'");

        let base = crate::core::style::resolve_text_preset(preset_id)
            .expect("preset")
            .default_clip_data()
            .outline
            .unwrap_or_default();
        assert_eq!(
            outline.color, base.color,
            "preset '{preset_id}' must keep the color it did not name"
        );
    }
}

#[test]
fn seeding_a_missing_layer_does_not_resurrect_a_cleared_one() {
    // The seed only applies to a layer the caller is actually merging into, so
    // an explicit null still clears and an untouched layer stays absent.
    let (state, clip) = add_text_clip_with_preset(
        "epic-title",
        Some(json!({
            "content": TEXT_OVERLAY_CONTENT,
            "outline": null,
            "shadow": { "blur": 12 },
        })),
    );

    let stored = crate::core::commands::get_text_data(&clip, &state).expect("text data");
    assert!(
        stored.outline.is_none(),
        "an explicit null must still clear"
    );
    assert_eq!(stored.shadow.expect("shadow merged").blur, 12);

    let (state, clip) = add_text_clip_with_preset(
        "watermark",
        Some(json!({ "content": TEXT_OVERLAY_CONTENT })),
    );
    let stored = crate::core::commands::get_text_data(&clip, &state).expect("text data");
    assert!(
        stored.shadow.is_none() && stored.outline.is_none(),
        "a preset that declares no decoration must not gain one"
    );
}

#[test]
fn the_resolved_text_payload_never_carries_the_preset_id() {
    // The op log has to be readable without the registry: what a preset
    // produced is recorded, not which preset produced it.
    let parsed = CommandPayload::parse(
        "AddTextClip".to_string(),
        json!({
            "sequenceId": "seq_1",
            "trackId": "track_1",
            "timelineIn": 0.0,
            "duration": 4.0,
            "preset": "logo-bug",
        }),
    )
    .expect("preset payload must parse");

    let CommandPayload::AddTextClip(payload) = parsed else {
        panic!("parsed the wrong variant");
    };
    assert!(payload.preset.is_none());

    let serialized = serde_json::to_value(&payload).expect("payload serializes");
    assert!(
        serialized.get("preset").is_none(),
        "a logged op must not name a preset: {serialized}"
    );
    assert_eq!(
        serialized["textData"]["style"]["backgroundColor"],
        json!("#0F766ECC")
    );

    // Re-parsing what was logged is a no-op, which is what makes replay stable.
    let reparsed = CommandPayload::parse("AddTextClip".to_string(), serialized)
        .expect("resolved payload must re-parse");
    let CommandPayload::AddTextClip(reparsed) = reparsed else {
        panic!("parsed the wrong variant");
    };
    assert_eq!(reparsed.text_data, payload.text_data);
}

#[test]
fn an_unknown_text_preset_is_rejected_with_the_valid_list() {
    let error = CommandPayload::parse(
        "AddTextClip".to_string(),
        json!({
            "sequenceId": "seq_1",
            "trackId": "track_1",
            "timelineIn": 0.0,
            "duration": 4.0,
            "preset": "no-such-preset",
        }),
    )
    .expect_err("unknown preset must fail");

    for preset in TEXT_PRESETS {
        assert!(
            error.contains(preset.id),
            "error must name '{}': {error}",
            preset.id
        );
    }
}

#[test]
fn text_data_is_still_required_without_a_preset() {
    let error = CommandPayload::parse(
        "AddTextClip".to_string(),
        json!({
            "sequenceId": "seq_1",
            "trackId": "track_1",
            "timelineIn": 0.0,
            "duration": 4.0,
        }),
    )
    .expect_err("a payload with neither preset nor textData must fail");

    assert!(error.contains("textData"), "{error}");
}

#[test]
fn every_text_preset_renders_its_own_typography_into_the_drawtext_filter() {
    let mut filters_by_preset: Vec<(&str, String)> = Vec::new();

    for preset in TEXT_PRESETS {
        // Every preset renders the same copy. The content is the first field of
        // the filter body, so leaving each preset its own starter string would
        // make the pairwise comparison below pass on the text alone and never
        // exercise the styling it exists to separate.
        let (state, clip) =
            add_text_clip_with_preset(preset.id, Some(json!({ "content": TEXT_OVERLAY_CONTENT })));
        let clip_data = preset.clip_data(TEXT_OVERLAY_CONTENT);

        let filter = crate::core::render::export::build_text_clip_drawtext_with_enable(
            &clip,
            &state.effects,
        )
        .unwrap_or_else(|error| panic!("preset '{}' must render: {error}", preset.id));

        assert!(
            filter.starts_with("drawtext="),
            "preset '{}' must render drawtext, got: {filter}",
            preset.id
        );
        assert!(
            filter.contains("enable='between(t,"),
            "preset '{}' filter must be time gated, got: {filter}",
            preset.id
        );
        // Holding the copy constant is what makes the pairwise check below
        // about styling, so the constant has to actually reach the filter.
        assert!(
            filter.contains(&format!("text='{TEXT_OVERLAY_CONTENT}'")),
            "preset '{}' must render the shared copy, got: {filter}",
            preset.id
        );

        // The point of a preset is its own look, so each assertion names a
        // value this preset declares rather than checking that some filter came
        // out the other end.
        assert!(
            filter.contains(&format!("fontsize={}", clip_data.style.font_size)),
            "preset '{}' must render at {}px, got: {filter}",
            preset.id,
            clip_data.style.font_size
        );
        assert!(
            filter.contains(&format!(
                "fontcolor={}",
                ffmpeg_hex_color(&clip_data.style.color, clip_data.opacity)
            )),
            "preset '{}' must render in its own color at its own opacity, got: {filter}",
            preset.id
        );
        assert!(
            filter.contains(&format!("x={}", expected_text_x_expression(&clip_data))),
            "preset '{}' must anchor where it says it does, got: {filter}",
            preset.id
        );
        assert!(
            filter.contains(&format!("y=(h*{:.4})-(text_h/2)", clip_data.position.y)),
            "preset '{}' must sit at y={}, got: {filter}",
            preset.id,
            clip_data.position.y
        );

        match &clip_data.style.background_color {
            Some(background) => assert!(
                filter.contains("box=1")
                    && filter.contains(&format!(
                        "boxcolor={}",
                        ffmpeg_hex_color(background, clip_data.opacity)
                    ))
                    && filter.contains(&format!(
                        "boxborderw={}",
                        clip_data.style.background_padding
                    )),
                "preset '{}' must render its box with {}px padding, got: {filter}",
                preset.id,
                clip_data.style.background_padding
            ),
            None => assert!(
                !filter.contains("boxcolor="),
                "preset '{}' declares no box, got: {filter}",
                preset.id
            ),
        }

        match &clip_data.outline {
            Some(outline) => assert!(
                filter.contains(&format!("borderw={}", outline.width))
                    && filter.contains(&format!(
                        "bordercolor={}",
                        ffmpeg_hex_color(&outline.color, clip_data.opacity)
                    )),
                "preset '{}' must render its outline, got: {filter}",
                preset.id
            ),
            None => assert!(
                !filter.contains("bordercolor="),
                "preset '{}' declares no outline, got: {filter}",
                preset.id
            ),
        }

        match &clip_data.shadow {
            Some(shadow) => assert!(
                filter.contains(&format!("shadowx={}", shadow.offset_x))
                    && filter.contains(&format!("shadowy={}", shadow.offset_y)),
                "preset '{}' must render its shadow offset, got: {filter}",
                preset.id
            ),
            None => assert!(
                !filter.contains("shadowcolor="),
                "preset '{}' declares no shadow, got: {filter}",
                preset.id
            ),
        }

        filters_by_preset.push((preset.id, filter));
    }

    // Two presets that describe different looks must not compile to the same
    // filter. With the copy held constant, only styling can separate them, so
    // a collision here means two catalog entries are one preset wearing two
    // ids — which the listing surfaces would advertise as a real choice.
    for (index, (id, filter)) in filters_by_preset.iter().enumerate() {
        for (other_id, other_filter) in filters_by_preset.iter().skip(index + 1) {
            assert_ne!(
                filter, other_filter,
                "presets '{id}' and '{other_id}' render identically"
            );
        }
    }
}

#[test]
fn the_repurposed_preset_spellings_stay_pinned_to_their_current_geometry() {
    // `title`, `lower-third`, and `subtitle` are the three spellings whose
    // meaning changed when the CLI's inline table gave way to this registry, so
    // they are the three most likely to be quietly repurposed a second time.
    // The module doc states "ids are append-only: rename nothing, and add rather
    // than repurpose"; these numbers are that contract in executable form.
    // Changing one is a breaking change for every existing script that names it,
    // so update the docs and the release notes along with this list.
    struct PinnedGeometry {
        key: &'static str,
        id: &'static str,
        x: f64,
        y: f64,
        font_size: u32,
        bold: bool,
        alignment: crate::core::text::TextAlignment,
    }

    let pinned = [
        PinnedGeometry {
            key: "title",
            id: "centered-title",
            x: 0.5,
            y: 0.5,
            font_size: 72,
            bold: true,
            alignment: crate::core::text::TextAlignment::Center,
        },
        PinnedGeometry {
            key: "lower-third",
            id: "lower-third",
            x: 0.08,
            y: 0.82,
            font_size: 42,
            bold: true,
            alignment: crate::core::text::TextAlignment::Left,
        },
        PinnedGeometry {
            key: "subtitle",
            id: "subtitle",
            x: 0.5,
            y: 0.9,
            font_size: 32,
            bold: false,
            alignment: crate::core::text::TextAlignment::Center,
        },
    ];

    for expected in pinned {
        let preset = crate::core::style::resolve_text_preset(expected.key)
            .unwrap_or_else(|error| panic!("'{}' must resolve: {error}", expected.key));
        assert_eq!(
            preset.id, expected.id,
            "'{}' must keep resolving to the same preset",
            expected.key
        );

        let clip = preset.default_clip_data();
        assert_eq!(
            (clip.position.x, clip.position.y),
            (expected.x, expected.y),
            "'{}' moved",
            expected.key
        );
        assert_eq!(
            clip.style.font_size, expected.font_size,
            "'{}'",
            expected.key
        );
        assert_eq!(clip.style.bold, expected.bold, "'{}'", expected.key);
        assert_eq!(
            clip.style.alignment, expected.alignment,
            "'{}'",
            expected.key
        );
    }
}

// =============================================================================
// TypeScript parity manifest
// =============================================================================

/// Location of the manifest that pins the TypeScript catalog to this registry.
fn text_preset_manifest_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src")
        .join("data")
        .join("textPresets.manifest.json")
}

/// The manifest content this registry implies.
fn text_preset_manifest_json() -> String {
    let value = serde_json::to_value(crate::core::style::list_text_presets())
        .expect("text presets serialize");
    let mut json = serde_json::to_string_pretty(&value).expect("manifest serializes");
    json.push('\n');
    json
}

/// How to bring the manifest back in line after editing the registry.
const REGENERATE_MANIFEST_HINT: &str =
    "cargo test -p openreelio --lib regenerate_text_preset_manifest -- --ignored";

#[test]
fn the_text_preset_manifest_matches_the_registry() {
    let path = text_preset_manifest_path();
    let contents = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "{} is missing ({error}). Regenerate it with: {REGENERATE_MANIFEST_HINT}",
            path.display()
        )
    });

    let recorded: Value = serde_json::from_str(&contents).unwrap_or_else(|error| {
        panic!(
            "{} is not valid JSON ({error}). Regenerate it with: {REGENERATE_MANIFEST_HINT}",
            path.display()
        )
    });
    let expected: Value =
        serde_json::from_str(&text_preset_manifest_json()).expect("manifest is valid JSON");

    assert_eq!(
        recorded,
        expected,
        "{} is stale, so the TypeScript catalog and this registry disagree. \
         Regenerate it with: {REGENERATE_MANIFEST_HINT}",
        path.display()
    );
}

#[test]
#[ignore = "regeneration helper: rewrites src/data/textPresets.manifest.json"]
fn regenerate_text_preset_manifest() {
    let path = text_preset_manifest_path();
    std::fs::write(&path, text_preset_manifest_json())
        .unwrap_or_else(|error| panic!("failed to write {}: {error}", path.display()));
}
