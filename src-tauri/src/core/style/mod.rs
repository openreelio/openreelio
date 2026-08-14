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

pub mod caption_packs;
pub mod transition_recipes;

#[cfg(test)]
mod contract_tests;

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::core::effects::{EffectType, ParamValue};

pub use caption_packs::{
    caption_pack_ids, list_caption_packs, resolve_caption_pack, CaptionPackDescriptor,
    CaptionPackSpec, CAPTION_PACKS,
};
pub use transition_recipes::{
    list_transition_recipes, resolve_transition_recipe, transition_recipe_ids, RecipeParam,
    TransitionRecipeDescriptor, TransitionRecipeSpec, TRANSITION_RECIPES,
};

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
/// A position override whose `type` differs from the pack's replaces the pack
/// position outright, because a preset anchor and a custom anchor do not merge.
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

/// Merges a caption position override onto a pack position.
///
/// Positions only merge within one anchoring mode: an override that names a
/// different `type` replaces the pack position instead of blending preset and
/// custom fields into an object that means neither.
fn merge_position_layer(base: Value, overrides: Option<Value>) -> Value {
    let Some(overrides) = overrides.filter(|value| !value.is_null()) else {
        return base;
    };

    let base_type = base.get("type").and_then(Value::as_str);
    let override_type = overrides.get("type").and_then(Value::as_str);
    if override_type.is_some() && override_type != base_type {
        return overrides;
    }

    merge_json_layer(base, Some(overrides), CAPTION_POSITION_KEY_GROUPS)
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
        let first = resolve_effect_recipe(Some("zoom-punch"), None, HashMap::new()).unwrap();
        let second = resolve_effect_recipe(
            Some("zoom-punch"),
            first.effect_type.clone(),
            first.params.clone(),
        )
        .unwrap();

        assert_eq!(first, second);
    }
}
