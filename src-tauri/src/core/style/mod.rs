//! Curated Style Registries
//!
//! Editorial quality is mostly a question of defaults. An agent asked to caption
//! a video can pick a font size, an outline width, a background alpha, and a
//! margin — four independent guesses with no feedback until the render — or it
//! can name a pack that was checked once and stays checked by contract test.
//!
//! This module holds those registries:
//!
//! - [`caption_packs`] — typed [`CaptionStyle`](crate::core::captions::CaptionStyle)
//!   plus [`CaptionPosition`](crate::core::captions::CaptionPosition) combinations
//!   that pass `CaptionSafeAreaRule` on both landscape and vertical canvases.
//! - [`transition_recipes`] — transition [`EffectType`] plus the parameters the
//!   FFmpeg filter builder actually reads.
//! - [`text_presets`] — typed [`TextClipData`](crate::core::text::TextClipData)
//!   overlays: typography, anchor, shadow, outline, starter copy, and a
//!   suggested duration.
//!
//! # Layering
//!
//! A pack is a *base layer*, never a lock. [`resolve_caption_layers`] and
//! [`resolve_effect_recipe`] merge caller-supplied values on top of the pack
//! key by key, so `stylePack: "boxed-contrast"` with `style: {"fontSize": 64}`
//! is the boxed pack at 64pt rather than an either/or choice.
//!
//! The merge is alias-aware: caption style JSON is read by the render path
//! through alias groups (`fontSize` or `font_size`, `alignment` or `textAlign`),
//! so an override spelled one way removes every spelling the pack contributed.
//! Without that, a pack's `fontSize` would silently outrank a caller's
//! `font_size`.
//!
//! Positions layer only within one anchoring mode. A pack anchor and a caller
//! anchor that disagree about *how* they place the caption do not blend, so the
//! caller's replaces the pack's outright — see [`resolve_caption_layers`].
//!
//! Restyling is the one place a pack is style-only: `UpdateCaption` replaces
//! whatever position the command carries, so a pack anchor riding along with a
//! restyle would move a caption nobody asked to move. [`resolve_caption_style`]
//! is the entry point for that case.

pub mod caption_packs;
pub mod text_presets;
pub mod transition_recipes;

#[cfg(test)]
mod contract_tests;

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::core::effects::{EffectType, ParamValue};
use crate::core::text::{TextClipData, TextOutline, TextShadow, TextStyle};

pub use caption_packs::{
    caption_pack_ids, list_caption_packs, resolve_caption_pack, CaptionPackDescriptor,
    CaptionPackSpec, CAPTION_PACKS,
};
pub use text_presets::{
    list_text_presets, resolve_text_preset, text_preset_ids, text_preset_keys, TextPresetCategory,
    TextPresetDescriptor, TextPresetSpec, TEXT_PRESETS,
};
pub use transition_recipes::{
    list_transition_recipes, resolve_transition_recipe, transition_recipe_ids, RecipeParam,
    TransitionRecipeDescriptor, TransitionRecipeSpec, TRANSITION_RECIPES,
};

/// The numeric weight a bold text style carries.
const BOLD_FONT_WEIGHT: u16 = 700;

/// The numeric weight a regular text style carries.
const REGULAR_FONT_WEIGHT: u16 = 400;

/// The weight at and above which every render path reads a style as bold.
const BOLD_FONT_WEIGHT_THRESHOLD: u16 = 600;

/// The preset id that means "no preset", accepted everywhere a preset is named.
///
/// The CLI has always defaulted `--preset` to this word and the agent tool enums
/// advertise it, so the payload boundary accepts it too rather than rejecting a
/// spelling every other surface teaches.
pub const NO_TEXT_PRESET: &str = "default";

/// Normalizes a pack or recipe identifier for matching.
///
/// Follows the same contract as `ExportPreset::from_legacy_id`: trim, lowercase,
/// and fold `_` and spaces onto the canonical `-` separator, so `Clean_Minimal`,
/// `clean minimal`, and `clean-minimal` are one id.
pub(crate) fn normalize_pack_id(raw: &str) -> String {
    raw.trim().to_ascii_lowercase().replace(['_', ' '], "-")
}

/// Caption style JSON keys that mean the same thing to the render path.
///
/// The render path reads each group by trying its spellings in order, so an
/// override must displace the whole group rather than only its own spelling.
const CAPTION_STYLE_KEY_GROUPS: &[&[&str]] = &[
    &["fontFamily", "font_family"],
    &["fontSize", "font_size"],
    &["fontWeight", "font_weight"],
    &["backgroundColor", "background_color"],
    &["backgroundPadding", "background_padding"],
    &["outlineColor", "outline_color"],
    &["outlineWidth", "outline_width"],
    &["shadowColor", "shadow_color"],
    &["shadowOffset", "shadow_offset"],
    &["shadowOffsetX", "shadow_offset_x", "shadowX", "shadow_x"],
    &["shadowOffsetY", "shadow_offset_y", "shadowY", "shadow_y"],
    &["shadowBlur", "shadow_blur"],
    &["lineHeight", "line_height"],
    &["letterSpacing", "letter_spacing"],
    &["alignment", "textAlign", "text_align"],
    &["verticalAlign", "vertical_align"],
];

/// Caption position JSON keys that mean the same thing to the render path.
const CAPTION_POSITION_KEY_GROUPS: &[&[&str]] = &[
    &["marginPercent", "margin_percent"],
    &["xPercent", "x_percent", "x"],
    &["yPercent", "y_percent", "y"],
];

/// Position JSON keys that name a custom anchor's coordinates.
///
/// A position object carrying any of these is a custom anchor even when it
/// omits `type`, because that is how every consumer already reads it: the CLI
/// validator defaults a missing `type` to `custom`, and the render path falls
/// through to the coordinate branch when no `type` is present.
const CUSTOM_POSITION_COORDINATE_KEYS: &[&str] =
    &["xPercent", "x_percent", "x", "yPercent", "y_percent", "y"];

/// The style and position a caption command should store on its clip.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedCaptionLayers {
    /// Caption style JSON, or `None` when neither a pack nor an override applied.
    pub style: Option<Value>,
    /// Caption position JSON, or `None` when neither a pack nor an override applied.
    pub position: Option<Value>,
}

/// The effect type and parameters an `AddEffect` command should apply.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedEffectRecipe {
    /// Effect type, taken from the recipe when one was named.
    pub effect_type: Option<EffectType>,
    /// Effect parameters: recipe values with caller overrides applied.
    pub params: HashMap<String, ParamValue>,
}

/// Resolves a caption style pack against caller-supplied style and position.
///
/// The pack is the base layer; `style` and `position` override it key by key.
/// A position override that anchors differently from the pack replaces the pack
/// position outright, because a preset anchor and a custom anchor do not merge.
/// Anchoring mode is read from `type` when present and from the coordinate keys
/// when it is not, so `{"xPercent": 25, "yPercent": 80}` replaces a preset pack
/// anchor rather than decorating it with keys the render path never reads.
///
/// Returns an error naming every valid pack id when `style_pack` is unknown.
pub fn resolve_caption_layers(
    style_pack: Option<&str>,
    style: Option<Value>,
    position: Option<Value>,
) -> Result<ResolvedCaptionLayers, String> {
    let Some(pack_id) = style_pack.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(ResolvedCaptionLayers { style, position });
    };

    let pack = resolve_caption_pack(pack_id)?;

    let pack_style = serde_json::to_value(pack.style())
        .map_err(|error| format!("Failed to serialize caption pack style: {error}"))?;
    let pack_position = serde_json::to_value(pack.position())
        .map_err(|error| format!("Failed to serialize caption pack position: {error}"))?;

    Ok(ResolvedCaptionLayers {
        style: Some(merge_json_layer(
            pack_style,
            style,
            CAPTION_STYLE_KEY_GROUPS,
        )),
        position: Some(merge_position_layer(pack_position, position)),
    })
}

/// Resolves a caption style pack for an edit that must not move the caption.
///
/// `UpdateCaption` replaces the stored anchor whenever the command carries one,
/// so a pack anchor riding along with a restyle would silently reposition a
/// caption that was placed deliberately — a caption lifted clear of a burned-in
/// lower third would drop straight back into it. A pack on an update therefore
/// contributes style only; a new anchor has to be asked for explicitly.
///
/// Returns an error naming every valid pack id when `style_pack` is unknown.
pub fn resolve_caption_style(
    style_pack: Option<&str>,
    style: Option<Value>,
) -> Result<Option<Value>, String> {
    Ok(resolve_caption_layers(style_pack, style, None)?.style)
}

/// Resolves a transition recipe against a caller-supplied effect type and params.
///
/// The recipe supplies the effect type and its baseline parameters; `params`
/// overrides individual recipe values. Naming a recipe *and* an incompatible
/// effect type is an error rather than a silent preference, because the two
/// express contradictory intent.
///
/// Returns an error naming every valid recipe id when `recipe` is unknown.
pub fn resolve_effect_recipe(
    recipe: Option<&str>,
    effect_type: Option<EffectType>,
    params: HashMap<String, ParamValue>,
) -> Result<ResolvedEffectRecipe, String> {
    let Some(recipe_id) = recipe.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(ResolvedEffectRecipe {
            effect_type,
            params,
        });
    };

    let recipe = resolve_transition_recipe(recipe_id)?;

    if let Some(explicit) = &effect_type {
        if explicit != &recipe.effect_type {
            return Err(format!(
                "Transition recipe '{}' applies effect type {}, but effectType {} was also given. \
                 Drop one of the two.",
                recipe.id,
                effect_type_label(&recipe.effect_type),
                effect_type_label(explicit)
            ));
        }
    }

    let mut merged: HashMap<String, ParamValue> = recipe.params().into_iter().collect();
    merged.extend(params);

    Ok(ResolvedEffectRecipe {
        effect_type: Some(recipe.effect_type.clone()),
        params: merged,
    })
}

/// Resolves a text preset against caller-supplied text clip data.
///
/// The preset is the base layer; `text_data` overrides it field by field, and
/// nested objects (`style`, `position`, `shadow`, `outline`) merge key by key
/// rather than replacing wholesale — `{"style":{"fontSize":64}}` on top of
/// `quote` is the quote preset at 64pt, not a style with one field. An explicit
/// `null` clears an optional layer, so `{"shadow":null}` drops the preset's
/// shadow.
///
/// `shadow` and `outline` are optional, so roughly half the catalog declares
/// neither and there would be nothing for a partial override to merge into.
/// Those two merge onto their type defaults instead of demanding a complete
/// layer, so `{"shadow":{"offsetX":2}}` means the same thing on every preset.
///
/// `bold` and `fontWeight` are reconciled after the merge, because they are one
/// decision spelled two ways — see [`reconcile_bold_and_font_weight`].
///
/// Without a preset this is just the strict `TextClipData` parse the payload
/// always did, so `text_data` stays required in that case. Reconciliation is
/// likewise skipped there: with no base layer underneath, nothing the caller
/// left out was filled in on its behalf.
///
/// Returns an error naming every valid preset id when `preset` is unknown.
pub fn resolve_text_clip_data(
    preset: Option<&str>,
    text_data: Option<Value>,
) -> Result<TextClipData, String> {
    let preset_id = preset
        .map(str::trim)
        .filter(|id| !id.is_empty() && !normalize_pack_id(id).eq(NO_TEXT_PRESET));

    let Some(preset_id) = preset_id else {
        let text_data = text_data
            .filter(|value| !value.is_null())
            .ok_or_else(|| "textData is required unless a preset is named".to_string())?;
        return serde_json::from_value(text_data)
            .map_err(|error| format!("Invalid textData: {error}"));
    };

    let preset = resolve_text_preset(preset_id)?;
    let overrides = text_data.filter(|value| !value.is_null());
    let (bold_was_named, font_weight_was_named) = named_bold_and_font_weight(overrides.as_ref());

    let mut base = serde_json::to_value(preset.default_clip_data())
        .map_err(|error| format!("Failed to serialize text preset: {error}"))?;
    seed_optional_text_layers(&mut base, overrides.as_ref());
    merge_json_deep(&mut base, overrides);

    let mut resolved: TextClipData = serde_json::from_value(base)
        .map_err(|error| format!("Invalid textData for preset '{}': {error}", preset.id))?;
    reconcile_bold_and_font_weight(&mut resolved.style, bold_was_named, font_weight_was_named);

    Ok(resolved)
}

/// Gives a partial `shadow` or `outline` override a layer to merge into.
///
/// Both are `Option` on [`TextClipData`] and skipped when absent, so on the
/// roughly half of the catalog that declares neither, `merge_json_deep` would
/// install the caller's fragment as the whole layer and the parse would fail on
/// a field the caller never meant to set. Seeding the type's defaults first
/// makes `{"shadow":{"offsetX":2}}` mean the same thing on every preset, which
/// is what the documented key-by-key contract promises.
fn seed_optional_text_layers(base: &mut Value, overrides: Option<&Value>) {
    let (Some(base_object), Some(override_object)) =
        (base.as_object_mut(), overrides.and_then(Value::as_object))
    else {
        return;
    };

    for (key, value) in override_object {
        if !value.is_object() {
            continue;
        }
        if base_object.get(key).is_some_and(|layer| !layer.is_null()) {
            continue;
        }
        if let Some(defaults) = default_optional_text_layer(key) {
            base_object.insert(key.clone(), defaults);
        }
    }
}

/// The base layer a partial override of `key` merges onto, when there is one.
fn default_optional_text_layer(key: &str) -> Option<Value> {
    match key {
        "shadow" => serde_json::to_value(TextShadow::default()).ok(),
        "outline" => serde_json::to_value(TextOutline::default()).ok(),
        _ => None,
    }
}

/// Reconciles the paired `bold` and `fontWeight` fields after a layered override.
///
/// The two are one decision spelled two ways: every render path reads bold as
/// `bold || fontWeight >= 600`, so a caller who layers `{"bold": false}` onto a
/// base that carries `fontWeight: 700` gets an overlay that renders bold, reads
/// back as regular, and matches neither the base nor the request. Whichever half
/// the caller named wins and the other follows it; naming both keeps both, since
/// then there is nothing left to infer.
///
/// Every surface that layers a style onto a base — the payload boundary's preset
/// merge and the CLI's `--style-json` patch — routes through here, so the two
/// cannot answer identical input differently.
pub fn reconcile_bold_and_font_weight(
    style: &mut TextStyle,
    bold_was_named: bool,
    font_weight_was_named: bool,
) {
    match (bold_was_named, font_weight_was_named) {
        (true, false) => {
            style.font_weight = if style.bold {
                BOLD_FONT_WEIGHT
            } else {
                REGULAR_FONT_WEIGHT
            };
        }
        (false, true) => {
            style.bold = style.font_weight >= BOLD_FONT_WEIGHT_THRESHOLD;
        }
        _ => {}
    }
}

/// Reports which half of the bold/`fontWeight` pair a `textData` override named.
///
/// Only the spelling the [`TextStyle`] deserializer actually reads counts:
/// `font_weight` is dropped on the floor by serde, so treating it as named would
/// make `bold` follow a value that never landed.
fn named_bold_and_font_weight(text_data: Option<&Value>) -> (bool, bool) {
    let Some(style) = text_data
        .and_then(Value::as_object)
        .and_then(|object| object.get("style"))
        .and_then(Value::as_object)
    else {
        return (false, false);
    };

    let named = |key: &str| style.get(key).is_some_and(|value| !value.is_null());
    (named("bold"), named("fontWeight"))
}

/// Merges `overrides` onto `base` recursively, key by key.
///
/// Objects merge; everything else replaces, so an explicit `null` clears the
/// key it names and a scalar wins outright.
fn merge_json_deep(base: &mut Value, overrides: Option<Value>) {
    let Some(overrides) = overrides else {
        return;
    };

    match (base, overrides) {
        (Value::Object(base_object), Value::Object(override_object)) => {
            for (key, value) in override_object {
                match base_object.get_mut(&key) {
                    Some(existing) if existing.is_object() && value.is_object() => {
                        merge_json_deep(existing, Some(value));
                    }
                    _ => {
                        base_object.insert(key, value);
                    }
                }
            }
        }
        (base, overrides) => *base = overrides,
    }
}

/// Renders an effect type for an error message.
fn effect_type_label(effect_type: &EffectType) -> String {
    serde_json::to_value(effect_type)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{effect_type:?}"))
}

/// Merges `overrides` onto `base`, treating each alias group as one key.
///
/// A non-object or absent override leaves the base untouched, except that a
/// non-null, non-object override replaces the base outright (there is nothing to
/// merge into).
fn merge_json_layer(base: Value, overrides: Option<Value>, groups: &[&[&str]]) -> Value {
    let Some(overrides) = overrides.filter(|value| !value.is_null()) else {
        return base;
    };

    let (Value::Object(base_object), Value::Object(override_object)) = (&base, &overrides) else {
        return overrides;
    };

    let mut merged: Map<String, Value> = base_object.clone();
    for (key, value) in override_object {
        match groups.iter().find(|group| group.contains(&key.as_str())) {
            Some(group) => {
                for alias in *group {
                    merged.remove(*alias);
                }
            }
            None => {
                merged.remove(key);
            }
        }
        merged.insert(key.clone(), value.clone());
    }

    Value::Object(merged)
}

/// Classifies a caption position object as `preset` or `custom`.
///
/// `type` decides when it is present. Otherwise a coordinate key decides, which
/// is what makes a type-less `{"xPercent": …, "yPercent": …}` a custom anchor
/// rather than an untyped fragment. `None` means the object names neither — a
/// partial such as `{"marginPercent": 20}`, which can only be read as an
/// overlay on whatever it is merged onto.
fn position_anchor_kind(value: &Value) -> Option<String> {
    if let Some(explicit) = value.get("type").and_then(Value::as_str) {
        return Some(explicit.trim().to_ascii_lowercase());
    }

    CUSTOM_POSITION_COORDINATE_KEYS
        .iter()
        .any(|key| value.get(*key).is_some())
        .then(|| "custom".to_string())
}

/// Merges a caption position override onto a pack position.
///
/// Positions only merge within one anchoring mode: an override that anchors
/// differently from the pack replaces the pack position instead of blending
/// preset and custom fields into an object that means neither.
fn merge_position_layer(base: Value, overrides: Option<Value>) -> Value {
    let Some(overrides) = overrides.filter(|value| !value.is_null()) else {
        return base;
    };

    let base_kind = position_anchor_kind(&base);
    let override_kind = position_anchor_kind(&overrides);
    if override_kind.is_some() && override_kind != base_kind {
        return overrides;
    }

    let merged = merge_json_layer(base, Some(overrides), CAPTION_POSITION_KEY_GROUPS);
    drop_dead_preset_coordinates(merged)
}

/// Removes coordinate keys from a preset anchor.
///
/// The render path returns as soon as it reads `"type":"preset"`, so `xPercent`
/// or `yPercent` sitting next to it are keys no consumer reads while looking
/// exactly like an applied position. One object must mean one anchor.
fn drop_dead_preset_coordinates(position: Value) -> Value {
    let is_preset = position
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("preset"));
    if !is_preset {
        return position;
    }

    match position {
        Value::Object(mut object) => {
            for key in CUSTOM_POSITION_COORDINATE_KEYS {
                object.remove(*key);
            }
            Value::Object(object)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::captions::{CaptionPosition, CaptionStyle};

    #[test]
    fn absent_pack_passes_explicit_values_through_untouched() {
        let style = serde_json::json!({ "fontSize": 30 });
        let position = serde_json::json!({ "type": "preset", "vertical": "top" });

        let resolved =
            resolve_caption_layers(None, Some(style.clone()), Some(position.clone())).unwrap();

        assert_eq!(resolved.style, Some(style));
        assert_eq!(resolved.position, Some(position));
    }

    #[test]
    fn pack_alone_yields_the_typed_pack_style_and_position() {
        let resolved = resolve_caption_layers(Some("boxed-contrast"), None, None).unwrap();

        let style: CaptionStyle = serde_json::from_value(resolved.style.expect("style")).unwrap();
        let expected = resolve_caption_pack("boxed-contrast").unwrap();
        assert_eq!(style, expected.style());

        let position: CaptionPosition =
            serde_json::from_value(resolved.position.expect("position")).unwrap();
        assert_eq!(position, expected.position());
    }

    #[test]
    fn explicit_style_field_overrides_only_that_key() {
        let resolved = resolve_caption_layers(
            Some("boxed-contrast"),
            Some(serde_json::json!({ "fontSize": 96 })),
            None,
        )
        .unwrap();

        let style: CaptionStyle = serde_json::from_value(resolved.style.expect("style")).unwrap();
        let pack = resolve_caption_pack("boxed-contrast").unwrap().style();

        assert_eq!(style.font_size, 96);
        assert_eq!(style.background_color, pack.background_color);
        assert_eq!(style.font_family, pack.font_family);
    }

    #[test]
    fn snake_case_override_displaces_the_packs_camel_case_key() {
        let resolved = resolve_caption_layers(
            Some("standard-outline"),
            Some(serde_json::json!({ "font_size": 24 })),
            None,
        )
        .unwrap();

        let style = resolved.style.expect("style");
        assert!(
            style.get("fontSize").is_none(),
            "the pack's camelCase spelling must not survive: {style}"
        );
        assert_eq!(style.get("font_size").and_then(Value::as_u64), Some(24));
    }

    #[test]
    fn position_override_of_the_same_type_merges_key_by_key() {
        let resolved = resolve_caption_layers(
            Some("standard-outline"),
            None,
            Some(serde_json::json!({ "type": "preset", "marginPercent": 20 })),
        )
        .unwrap();

        let position: CaptionPosition =
            serde_json::from_value(resolved.position.expect("position")).unwrap();
        assert_eq!(
            position,
            CaptionPosition::Preset {
                vertical: crate::core::captions::VerticalPosition::Bottom,
                margin_percent: 20.0,
            }
        );
    }

    #[test]
    fn position_override_of_a_different_type_replaces_the_pack_anchor() {
        let custom = serde_json::json!({ "type": "custom", "xPercent": 50.0, "yPercent": 40.0 });
        let resolved =
            resolve_caption_layers(Some("standard-outline"), None, Some(custom.clone())).unwrap();

        assert_eq!(resolved.position, Some(custom));
    }

    #[test]
    fn type_less_custom_coordinates_replace_the_pack_anchor() {
        // The CLI accepts and range-validates this shape without stamping a
        // `type`, so it has to read as a custom anchor here too.
        let custom = serde_json::json!({ "xPercent": 25.0, "yPercent": 80.0 });
        let resolved =
            resolve_caption_layers(Some("clean-minimal"), None, Some(custom.clone())).unwrap();

        assert_eq!(resolved.position, Some(custom));
    }

    #[test]
    fn a_merged_preset_never_carries_coordinate_keys() {
        let resolved = resolve_caption_layers(
            Some("clean-minimal"),
            None,
            Some(serde_json::json!({ "type": "preset", "vertical": "top", "yPercent": 12.0 })),
        )
        .unwrap();

        let position = resolved.position.expect("position");
        assert!(
            position.get("yPercent").is_none(),
            "a preset anchor must not carry dead coordinates: {position}"
        );
        let typed: CaptionPosition = serde_json::from_value(position).unwrap();
        assert!(matches!(typed, CaptionPosition::Preset { .. }));
    }

    #[test]
    fn a_margin_only_override_still_merges_onto_a_preset_pack() {
        let resolved = resolve_caption_layers(
            Some("shorts-bold-outline"),
            None,
            Some(serde_json::json!({ "marginPercent": 22.0 })),
        )
        .unwrap();

        let position: CaptionPosition =
            serde_json::from_value(resolved.position.expect("position")).unwrap();
        assert_eq!(
            position,
            CaptionPosition::Preset {
                vertical: crate::core::captions::VerticalPosition::Bottom,
                margin_percent: 22.0,
            }
        );
    }

    #[test]
    fn style_only_resolution_never_produces_a_position() {
        let style = resolve_caption_style(Some("boxed-contrast"), None)
            .unwrap()
            .expect("style");

        let typed: CaptionStyle = serde_json::from_value(style).unwrap();
        assert_eq!(
            typed,
            resolve_caption_pack("boxed-contrast").unwrap().style()
        );
    }

    #[test]
    fn unknown_pack_is_rejected_with_the_valid_list() {
        let error = resolve_caption_layers(Some("nope"), None, None).expect_err("must fail");
        assert!(error.contains("clean-minimal"), "{error}");
    }

    #[test]
    fn recipe_supplies_type_and_params_when_none_were_given() {
        let resolved =
            resolve_effect_recipe(Some("wipe-left"), None, HashMap::new()).expect("resolves");

        assert_eq!(resolved.effect_type, Some(EffectType::Wipe));
        assert_eq!(
            resolved.params.get("direction"),
            Some(&ParamValue::String("left".to_string()))
        );
        assert_eq!(
            resolved
                .params
                .get("duration")
                .and_then(ParamValue::as_float),
            Some(0.7)
        );
    }

    #[test]
    fn explicit_param_overrides_the_recipe_value() {
        let mut params = HashMap::new();
        params.insert("duration".to_string(), ParamValue::Float(2.5));

        let resolved = resolve_effect_recipe(Some("wipe-left"), None, params).expect("resolves");

        assert_eq!(
            resolved
                .params
                .get("duration")
                .and_then(ParamValue::as_float),
            Some(2.5)
        );
        assert_eq!(
            resolved.params.get("direction"),
            Some(&ParamValue::String("left".to_string()))
        );
    }

    #[test]
    fn matching_explicit_effect_type_is_accepted() {
        let resolved = resolve_effect_recipe(
            Some("dissolve-soft"),
            Some(EffectType::CrossDissolve),
            HashMap::new(),
        )
        .expect("resolves");

        assert_eq!(resolved.effect_type, Some(EffectType::CrossDissolve));
    }

    #[test]
    fn conflicting_explicit_effect_type_is_rejected() {
        let error = resolve_effect_recipe(
            Some("dissolve-soft"),
            Some(EffectType::Wipe),
            HashMap::new(),
        )
        .expect_err("must fail");

        assert!(error.contains("dissolve-soft"), "{error}");
        assert!(error.contains("cross_dissolve"), "{error}");
        assert!(error.contains("wipe"), "{error}");
    }

    #[test]
    fn unknown_recipe_is_rejected_with_the_valid_list() {
        let error =
            resolve_effect_recipe(Some("nope"), None, HashMap::new()).expect_err("must fail");
        assert!(error.contains("dissolve-standard"), "{error}");
    }

    #[test]
    fn resolution_is_idempotent_for_captions() {
        let first = resolve_caption_layers(
            Some("shorts-bold-outline"),
            Some(serde_json::json!({ "italic": true })),
            None,
        )
        .unwrap();

        let second = resolve_caption_layers(
            Some("shorts-bold-outline"),
            first.style.clone(),
            first.position.clone(),
        )
        .unwrap();

        assert_eq!(first, second);
    }

    #[test]
    fn resolution_is_idempotent_for_recipes() {
        let first = resolve_effect_recipe(Some("wipe-down"), None, HashMap::new()).unwrap();
        let second = resolve_effect_recipe(
            Some("wipe-down"),
            first.effect_type.clone(),
            first.params.clone(),
        )
        .unwrap();

        assert_eq!(first, second);
    }

    #[test]
    fn absent_text_preset_parses_the_given_clip_data_unchanged() {
        let text_data = serde_json::json!({
            "content": "Hand assembled",
            "style": { "fontFamily": "Arial", "fontSize": 30, "color": "#FFFFFF" },
            "position": { "x": 0.2, "y": 0.7 },
        });

        let resolved = resolve_text_clip_data(None, Some(text_data)).expect("resolves");

        assert_eq!(resolved.content, "Hand assembled");
        assert_eq!(resolved.style.font_size, 30);
        assert_eq!(resolved.position.x, 0.2);
    }

    #[test]
    fn the_no_preset_sentinel_is_accepted_in_every_spelling() {
        let text_data = serde_json::json!({
            "content": "Plain",
            "style": { "fontFamily": "Arial", "fontSize": 30, "color": "#FFFFFF" },
            "position": { "x": 0.5, "y": 0.5 },
        });

        for spelling in ["default", "DEFAULT", "  default  "] {
            let resolved = resolve_text_clip_data(Some(spelling), Some(text_data.clone()))
                .unwrap_or_else(|error| panic!("'{spelling}' must resolve: {error}"));
            assert_eq!(resolved.style.font_size, 30);
        }
    }

    #[test]
    fn a_nested_text_override_merges_instead_of_replacing_its_object() {
        // A partial style has to leave the rest of the preset's typography
        // intact; replacing the object outright would fail to deserialize and,
        // worse, would silently drop the look the caller asked for by name.
        let resolved = resolve_text_clip_data(
            Some("tech-style"),
            Some(serde_json::json!({ "style": { "color": "#FF00FF" } })),
        )
        .expect("resolves");

        assert_eq!(resolved.style.color, "#FF00FF");
        assert_eq!(resolved.style.font_family, "Courier New");
        assert_eq!(resolved.style.font_size, 36);
    }

    #[test]
    fn resolution_is_idempotent_for_text_presets() {
        let first = resolve_text_clip_data(
            Some("credits-block"),
            Some(serde_json::json!({ "content": "Directed by" })),
        )
        .unwrap();

        let second = resolve_text_clip_data(
            Some("credits-block"),
            Some(serde_json::to_value(&first).unwrap()),
        )
        .unwrap();

        assert_eq!(first, second);
    }
}
