//! Curated Transition Recipes
//!
//! A transition recipe is a named, hand-checked combination of a transition
//! [`EffectType`] and the parameters the FFmpeg filter builder actually reads.
//! Transitions in OpenReelio are ordinary effects (there is no `AddTransition`
//! command), so a recipe is a shorthand for `AddEffect` with the right type and
//! a duration that has been chosen rather than guessed.
//!
//! # Parameter contract
//!
//! Recipe parameters are restricted to keys the filter builder consumes:
//!
//! - `duration` (seconds) — every family
//! - `offset` (seconds) — `xfade`-backed families (cross dissolve, wipe, slide)
//! - `direction` (`left`/`right`/`up`/`down`) — wipe and slide
//! - `fade_in` (bool) — fade
//!
//! A recipe never sets a parameter it cannot know. `fade-out` therefore ships
//! without `start_time`, which only the target clip's duration can supply;
//! `AddEffectCommand::execute` computes it there, before the op is logged.
//!
//! # Admission
//!
//! The table is a quality floor, so an entry earns its place by rendering what
//! its description promises. A recipe whose builder cannot produce the described
//! result is removed rather than shipped with a caveat — an agent picking a
//! one-token curated option must not have to know which entries are sound.
//!
//! # Stability
//!
//! Recipe ids are a public contract, so ids are append-only: rename nothing, and
//! add rather than repurpose. The op log records the parameters a recipe
//! produced, not the id that produced them, so a rename would silently split
//! one recipe into two for every surface that lists them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::core::effects::{EffectType, ParamValue};

use super::normalize_pack_id;

/// A `const`-constructible parameter literal.
///
/// [`ParamValue::String`] owns a `String`, so the table stores `&'static str`
/// and converts on demand.
#[derive(Clone, Copy, Debug)]
pub enum RecipeParam {
    /// Numeric parameter (seconds, factors, ratios).
    Float(f64),
    /// Boolean switch.
    Bool(bool),
    /// Enumerated string parameter such as a direction.
    Str(&'static str),
}

impl RecipeParam {
    fn to_param_value(self) -> ParamValue {
        match self {
            Self::Float(value) => ParamValue::Float(value),
            Self::Bool(value) => ParamValue::Bool(value),
            Self::Str(value) => ParamValue::String(value.to_string()),
        }
    }
}

/// Immutable definition of one curated transition recipe.
#[derive(Clone, Debug)]
pub struct TransitionRecipeSpec {
    /// Canonical, hyphenated recipe identifier.
    pub id: &'static str,
    /// One-line description of what the recipe is for.
    pub description: &'static str,
    /// Additional identifiers that resolve to this recipe.
    pub aliases: &'static [&'static str],
    /// The transition effect type the recipe applies.
    pub effect_type: EffectType,
    params: &'static [(&'static str, RecipeParam)],
}

impl TransitionRecipeSpec {
    /// Materializes the recipe parameters as effect parameters.
    pub fn params(&self) -> BTreeMap<String, ParamValue> {
        self.params
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.to_param_value()))
            .collect()
    }

    /// Builds the serializable descriptor used by listing surfaces.
    pub fn descriptor(&self) -> TransitionRecipeDescriptor {
        TransitionRecipeDescriptor {
            id: self.id.to_string(),
            kind: "transition".to_string(),
            description: self.description.to_string(),
            aliases: self.aliases.iter().map(|alias| alias.to_string()).collect(),
            effect_type: self.effect_type.clone(),
            params: self.params(),
        }
    }
}

/// Serializable description of a transition recipe.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionRecipeDescriptor {
    /// Canonical recipe identifier.
    pub id: String,
    /// Always `"transition"`; lets caption and transition entries share one list.
    pub kind: String,
    /// One-line description of what the recipe is for.
    pub description: String,
    /// Additional identifiers that resolve to this recipe.
    pub aliases: Vec<String>,
    /// The transition effect type the recipe applies.
    pub effect_type: EffectType,
    /// The effect parameters the recipe applies, sorted by key.
    pub params: BTreeMap<String, ParamValue>,
}

/// The canonical transition recipe table.
///
/// This is both the validator and the listing: `packs list` prints it and
/// [`resolve_transition_recipe`] matches against it.
pub const TRANSITION_RECIPES: &[TransitionRecipeSpec] = &[
    TransitionRecipeSpec {
        id: "dissolve-soft",
        description: "Half-second cross dissolve. Short enough to keep pace in a dialogue or \
                      montage cut.",
        aliases: &["soft-dissolve"],
        effect_type: EffectType::CrossDissolve,
        params: &[
            ("duration", RecipeParam::Float(0.5)),
            ("offset", RecipeParam::Float(0.0)),
        ],
    },
    TransitionRecipeSpec {
        id: "dissolve-standard",
        description: "One-second cross dissolve. The default when a scene change needs a soft \
                      handoff rather than a cut.",
        aliases: &["dissolve", "crossfade", "cross-dissolve"],
        effect_type: EffectType::CrossDissolve,
        params: &[
            ("duration", RecipeParam::Float(1.0)),
            ("offset", RecipeParam::Float(0.0)),
        ],
    },
    TransitionRecipeSpec {
        id: "dissolve-long",
        description: "Two-second cross dissolve for a deliberate passage-of-time feel.",
        aliases: &["long-dissolve", "slow-dissolve"],
        effect_type: EffectType::CrossDissolve,
        params: &[
            ("duration", RecipeParam::Float(2.0)),
            ("offset", RecipeParam::Float(0.0)),
        ],
    },
    TransitionRecipeSpec {
        id: "fade-in",
        description: "One-second fade up from black at the head of a clip.",
        aliases: &["fadein", "fade-from-black"],
        effect_type: EffectType::Fade,
        params: &[
            ("duration", RecipeParam::Float(1.0)),
            ("fade_in", RecipeParam::Bool(true)),
        ],
    },
    TransitionRecipeSpec {
        id: "fade-out",
        description: "One-second fade down to black, anchored on the clip's tail. Pass an \
                      explicit start_time to move the fade somewhere else in the clip.",
        aliases: &["fadeout", "fade-to-black"],
        effect_type: EffectType::Fade,
        params: &[
            ("duration", RecipeParam::Float(1.0)),
            ("fade_in", RecipeParam::Bool(false)),
        ],
    },
    TransitionRecipeSpec {
        id: "wipe-left",
        description: "0.7s wipe travelling left. Reads as a deliberate graphic transition, not a \
                      cut.",
        aliases: &["wipe"],
        effect_type: EffectType::Wipe,
        params: &[
            ("direction", RecipeParam::Str("left")),
            ("duration", RecipeParam::Float(0.7)),
            ("offset", RecipeParam::Float(0.0)),
        ],
    },
    TransitionRecipeSpec {
        id: "wipe-right",
        description: "0.7s wipe travelling right.",
        aliases: &[],
        effect_type: EffectType::Wipe,
        params: &[
            ("direction", RecipeParam::Str("right")),
            ("duration", RecipeParam::Float(0.7)),
            ("offset", RecipeParam::Float(0.0)),
        ],
    },
    TransitionRecipeSpec {
        id: "wipe-up",
        description: "0.7s wipe travelling up.",
        aliases: &[],
        effect_type: EffectType::Wipe,
        params: &[
            ("direction", RecipeParam::Str("up")),
            ("duration", RecipeParam::Float(0.7)),
            ("offset", RecipeParam::Float(0.0)),
        ],
    },
    TransitionRecipeSpec {
        id: "wipe-down",
        description: "0.7s wipe travelling down.",
        aliases: &[],
        effect_type: EffectType::Wipe,
        params: &[
            ("direction", RecipeParam::Str("down")),
            ("duration", RecipeParam::Float(0.7)),
            ("offset", RecipeParam::Float(0.0)),
        ],
    },
    TransitionRecipeSpec {
        id: "slide-left",
        description: "Half-second slide pushing the outgoing shot left. Faster than a wipe and \
                      carries direction with it.",
        aliases: &["slide", "push-left"],
        effect_type: EffectType::Slide,
        params: &[
            ("direction", RecipeParam::Str("left")),
            ("duration", RecipeParam::Float(0.5)),
            ("offset", RecipeParam::Float(0.0)),
        ],
    },
    TransitionRecipeSpec {
        id: "slide-right",
        description: "Half-second slide pushing the outgoing shot right.",
        aliases: &["push-right"],
        effect_type: EffectType::Slide,
        params: &[
            ("direction", RecipeParam::Str("right")),
            ("duration", RecipeParam::Float(0.5)),
            ("offset", RecipeParam::Float(0.0)),
        ],
    },
];

/// Returns every transition recipe descriptor, in table order.
pub fn list_transition_recipes() -> Vec<TransitionRecipeDescriptor> {
    TRANSITION_RECIPES
        .iter()
        .map(TransitionRecipeSpec::descriptor)
        .collect()
}

/// Returns the canonical ids of every transition recipe, in table order.
pub fn transition_recipe_ids() -> Vec<&'static str> {
    TRANSITION_RECIPES.iter().map(|recipe| recipe.id).collect()
}

/// Resolves a transition recipe id.
///
/// Matching is tolerant of case and of `-`, `_`, or space separators, and of the
/// per-recipe alias list. An unknown id is a hard error naming every valid id.
pub fn resolve_transition_recipe(id: &str) -> Result<&'static TransitionRecipeSpec, String> {
    let normalized = normalize_pack_id(id);

    TRANSITION_RECIPES
        .iter()
        .find(|recipe| {
            normalize_pack_id(recipe.id) == normalized
                || recipe
                    .aliases
                    .iter()
                    .any(|alias| normalize_pack_id(alias) == normalized)
        })
        .ok_or_else(|| {
            format!(
                "Unknown transition recipe '{}'. Valid recipes: {}",
                id.trim(),
                transition_recipe_ids().join(", ")
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::effects::EffectCategory;

    #[test]
    fn every_recipe_is_a_transition_category_effect() {
        for recipe in TRANSITION_RECIPES {
            assert_eq!(
                recipe.effect_type.category(),
                EffectCategory::Transition,
                "recipe '{}' must use a transition effect type",
                recipe.id
            );
        }
    }

    #[test]
    fn every_recipe_id_is_unique_and_hyphenated() {
        let mut seen = std::collections::HashSet::new();
        for recipe in TRANSITION_RECIPES {
            assert!(
                seen.insert(recipe.id),
                "duplicate recipe id '{}'",
                recipe.id
            );
            assert!(
                recipe
                    .id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "recipe id '{}' must be lowercase kebab-case",
                recipe.id
            );
        }
    }

    #[test]
    fn every_recipe_declares_a_positive_duration() {
        for recipe in TRANSITION_RECIPES {
            let params = recipe.params();
            let duration = params
                .get("duration")
                .and_then(ParamValue::as_float)
                .unwrap_or_else(|| panic!("recipe '{}' must declare a duration", recipe.id));
            assert!(
                duration > 0.0 && duration <= 5.0,
                "recipe '{}' duration {duration} is out of range",
                recipe.id
            );
        }
    }

    #[test]
    fn resolve_accepts_separator_and_case_variants() {
        for recipe in TRANSITION_RECIPES {
            for candidate in [
                recipe.id.to_string(),
                recipe.id.replace('-', "_"),
                recipe.id.replace('-', " "),
                recipe.id.to_ascii_uppercase(),
            ] {
                let resolved = resolve_transition_recipe(&candidate)
                    .unwrap_or_else(|error| panic!("'{candidate}' must resolve: {error}"));
                assert_eq!(resolved.id, recipe.id);
            }
        }
    }

    #[test]
    fn every_alias_resolves_to_its_recipe() {
        for recipe in TRANSITION_RECIPES {
            for alias in recipe.aliases {
                let resolved = resolve_transition_recipe(alias)
                    .unwrap_or_else(|error| panic!("alias '{alias}' must resolve: {error}"));
                assert_eq!(resolved.id, recipe.id);
            }
        }
    }

    #[test]
    fn unknown_recipe_error_lists_every_valid_id() {
        let error = resolve_transition_recipe("no-such-recipe").expect_err("unknown id must fail");
        for recipe in TRANSITION_RECIPES {
            assert!(
                error.contains(recipe.id),
                "error must name '{}': {error}",
                recipe.id
            );
        }
    }

    #[test]
    fn descriptors_round_trip_through_json() {
        for descriptor in list_transition_recipes() {
            let json = serde_json::to_value(&descriptor).expect("descriptor serializes");
            let parsed: TransitionRecipeDescriptor =
                serde_json::from_value(json).expect("descriptor deserializes");
            assert_eq!(parsed, descriptor);
        }
    }
}
