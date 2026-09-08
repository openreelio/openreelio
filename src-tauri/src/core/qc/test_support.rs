//! Fixtures shared by the QC test modules.
//!
//! A text overlay is the one QC fixture that takes two objects to build — the
//! clip and the effect that actually carries its words — so the builder for it
//! was copied into every test module that needed one. Two copies had already
//! drifted apart in how they spelled the virtual asset prefix; this is the one
//! they now share.

use crate::core::commands::TEXT_ASSET_PREFIX;
use crate::core::effects::{Effect, EffectType, ParamValue};
use crate::core::timeline::Clip;

/// Builds a text-overlay clip and the effect that carries its words.
///
/// The two are returned separately because they are stored separately: the clip
/// goes on a track and the effect into `ProjectState::effects`, and a QC rule
/// only sees the text once both halves are in place.
pub(super) fn text_overlay_clip(
    text: &str,
    timeline_in_sec: f64,
    duration_sec: f64,
) -> (Clip, Effect) {
    let mut clip = Clip::with_range("placeholder", 0.0, duration_sec);
    clip.asset_id = format!("{TEXT_ASSET_PREFIX}{}", clip.id);
    clip.place.timeline_in_sec = timeline_in_sec;
    clip.place.duration_sec = duration_sec;

    let mut effect = Effect::new(EffectType::TextOverlay);
    effect.set_param("text", ParamValue::String(text.to_string()));
    clip.effects.push(effect.id.clone());

    (clip, effect)
}
