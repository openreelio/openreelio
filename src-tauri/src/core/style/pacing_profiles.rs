//! Curated Pacing Profiles
//!
//! A pacing profile is the taste layer for automated cutting. Left to itself an
//! agent asked to "cut this down" has to invent a shot length, decide whether
//! shots should vary, pick a transition, and choose how often to use it — four
//! guesses with no feedback until the render. A profile is one name that answers
//! all four the way an editor working in that idiom would.
//!
//! # What a profile decides
//!
//! - `target_shot_sec` — the mean length of a cut shot.
//! - `shot_variance_sec` — how far shots swing either side of that mean.
//! - `respect_shot_boundaries` — whether generated cuts snap onto detected shot
//!   changes in the source rather than landing mid-shot.
//!
//! # Transitions are reserved
//!
//! `transition_recipe` + `transition_every_n` describe which curated transition
//! to place and on which cuts (`every_n` counts *boundaries*, so `3` means the
//! 1st, 4th, and 7th cut; `0` or no recipe means hard cuts). Every shipped
//! profile sets `transition_recipe: None`.
//!
//! Handles are not what stops them. A profile cuts *one asset* into many clips,
//! so every boundary it makes is a razor split: the outgoing clip's out point is
//! the incoming clip's in point in the same source, and there is always unused
//! media on both sides. The renderer would blend every one of them happily.
//!
//! The blend would simply be invisible. Both sides are the same footage at the
//! same frame, so every frame of the dissolve mixes a frame with itself and the
//! output is bit-identical to the hard cut it replaced — measurably so: a
//! dissolve across a split renders at infinite PSNR against the cut. Shipping a
//! profile that advertised a dissolve would mean advertising an effect the file
//! cannot show, and paying encode time for it.
//!
//! What a profile would need before it can place one is material to blend
//! *between*: either boundaries drawn between different shots, or clips trimmed
//! back at the boundary so the two sides no longer overlap in the source. The
//! fields stay in the schema, and [`generate_steps_with_transitions`] still
//! knows how to emit the `AddEffect` steps, so the planner half is ready when
//! that work happens.
//!
//! [`generate_steps_with_transitions`]: crate::core::analysis::style_planner
//!
//! # What a profile does not decide
//!
//! Nothing about content. A profile has no idea what is in the frame, whether a
//! sentence is finished, or where the beat falls — `bpm` in the analysis bundle
//! is a single scalar, not a beat grid, so nothing here can cut on the beat.
//! `respect_shot_boundaries` is the whole of its content awareness, and it only
//! works when shot detection has run.
//!
//! # Consistency
//!
//! `tempo` is not free-form: it must be the [`TempoClassification`] that
//! [`TempoClassification::from_mean_duration`] assigns to `target_shot_sec`, so
//! a profile cannot advertise a tempo its own target contradicts. The contract
//! test enforces it, which is also what keeps profiles comparable with the
//! tempo an ESD measures off a reference video.
//!
//! # Stability
//!
//! Profile ids are a public contract, so ids are append-only: rename nothing,
//! and add rather than repurpose. A generated plan records the concrete cut
//! times and effect parameters a profile produced, not the id that produced
//! them, so a rename would silently split one profile into two for every
//! surface that lists them.

use serde::{Deserialize, Serialize};

use crate::core::analysis::esd::TempoClassification;

use super::normalize_pack_id;

/// Immutable definition of one curated pacing profile.
#[derive(Clone, Debug)]
pub struct PacingProfileSpec {
    /// Canonical, hyphenated profile identifier.
    pub id: &'static str,
    /// One-line description of the idiom the profile cuts in.
    pub description: &'static str,
    /// Additional identifiers that resolve to this profile.
    pub aliases: &'static [&'static str],
    /// Tempo band the profile cuts in; must agree with `target_shot_sec`.
    pub tempo: TempoClassification,
    /// Mean length of a generated shot, in seconds.
    pub target_shot_sec: f64,
    /// Peak-to-peak swing around the target, in seconds. `0.0` is metronomic.
    pub shot_variance_sec: f64,
    /// Curated transition recipe id, or `None` for hard cuts throughout.
    ///
    /// Still reserved: a profile cuts one asset, so every boundary it makes is
    /// a razor split that would blend the same footage into itself — visible
    /// nowhere. Every shipped profile sets `None`.
    pub transition_recipe: Option<&'static str>,
    /// Place a transition every N cut boundaries; `0` means never.
    ///
    /// Reserved alongside [`Self::transition_recipe`].
    pub transition_every_n: usize,
    /// Snap generated cuts onto detected source shot changes where one is near.
    pub respect_shot_boundaries: bool,
}

impl PacingProfileSpec {
    /// Builds the serializable descriptor used by listing surfaces.
    pub fn descriptor(&self) -> PacingProfileDescriptor {
        PacingProfileDescriptor {
            id: self.id.to_string(),
            kind: "pacing".to_string(),
            description: self.description.to_string(),
            aliases: self.aliases.iter().map(|alias| alias.to_string()).collect(),
            tempo: self.tempo.clone(),
            target_shot_sec: self.target_shot_sec,
            shot_variance_sec: self.shot_variance_sec,
            transition_recipe: self.transition_recipe.map(str::to_string),
            transition_every_n: self.transition_every_n,
            respect_shot_boundaries: self.respect_shot_boundaries,
        }
    }

    /// Returns the transition recipe to place, if the profile places any.
    ///
    /// A recipe with `transition_every_n == 0` is the same as no recipe, so
    /// both collapse to `None` here rather than at every call site.
    pub fn active_transition(&self) -> Option<(&'static str, usize)> {
        match (self.transition_recipe, self.transition_every_n) {
            (Some(recipe), every_n) if every_n > 0 => Some((recipe, every_n)),
            _ => None,
        }
    }
}

/// Serializable description of a pacing profile.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacingProfileDescriptor {
    /// Canonical profile identifier.
    pub id: String,
    /// Always `"pacing"`; lets every pack registry share one list.
    pub kind: String,
    /// One-line description of the idiom the profile cuts in.
    pub description: String,
    /// Additional identifiers that resolve to this profile.
    pub aliases: Vec<String>,
    /// Tempo band the profile cuts in.
    pub tempo: TempoClassification,
    /// Mean length of a generated shot, in seconds.
    pub target_shot_sec: f64,
    /// Peak-to-peak swing around the target, in seconds.
    pub shot_variance_sec: f64,
    /// Curated transition recipe id, or absent for hard cuts.
    pub transition_recipe: Option<String>,
    /// Place a transition every N cut boundaries; `0` means never.
    pub transition_every_n: usize,
    /// Whether generated cuts snap onto detected source shot changes.
    pub respect_shot_boundaries: bool,
}

/// The canonical pacing profile table.
///
/// This is both the validator and the listing: `packs list --kind pacing`
/// prints it and [`resolve_pacing_profile`] matches against it.
///
/// Every entry cuts hard. See the module docs for why the transition fields
/// are reserved rather than used.
pub const PACING_PROFILES: &[PacingProfileSpec] = &[
    PacingProfileSpec {
        id: "shorts-hook-fast",
        description: "Sub-two-second shots and hard cuts, for vertical short-form where the \
                      viewer decides in the first three seconds. No transitions: a dissolve \
                      reads as hesitation at this speed.",
        aliases: &["shorts", "hook-fast", "tiktok"],
        tempo: TempoClassification::Fast,
        target_shot_sec: 1.8,
        shot_variance_sec: 0.6,
        transition_recipe: None,
        transition_every_n: 0,
        respect_shot_boundaries: true,
    },
    PacingProfileSpec {
        id: "music-montage",
        description: "Fast, near-even shots for a cut-to-music montage. Cuts are metronomic by \
                      design rather than beat-locked — the analysis bundle carries an average \
                      BPM, not a beat grid, so nothing here can land on the downbeat.",
        aliases: &["montage", "music"],
        tempo: TempoClassification::Fast,
        target_shot_sec: 1.5,
        shot_variance_sec: 0.2,
        transition_recipe: None,
        transition_every_n: 0,
        respect_shot_boundaries: false,
    },
    PacingProfileSpec {
        id: "dynamic-social",
        description: "Two-and-a-half-second shots and hard cuts. The default for landscape \
                      social video that needs energy without feeling frantic.",
        aliases: &["social", "dynamic"],
        tempo: TempoClassification::Moderate,
        target_shot_sec: 2.5,
        shot_variance_sec: 1.0,
        transition_recipe: None,
        transition_every_n: 0,
        respect_shot_boundaries: true,
    },
    PacingProfileSpec {
        id: "steady-documentary",
        description: "Four-and-a-half-second shots and hard cuts. Long enough to let a subject \
                      finish a thought, cut often enough to keep an interview moving.",
        aliases: &["documentary", "doc", "steady"],
        tempo: TempoClassification::Moderate,
        target_shot_sec: 4.5,
        shot_variance_sec: 1.5,
        transition_recipe: None,
        transition_every_n: 0,
        respect_shot_boundaries: true,
    },
    PacingProfileSpec {
        id: "calm-longform",
        description: "Seven-second shots and hard cuts, for landscape, ambience, and \
                      passage-of-time sequences where the edit should be felt rather than \
                      noticed.",
        aliases: &["calm", "longform", "ambient"],
        tempo: TempoClassification::Slow,
        target_shot_sec: 7.0,
        shot_variance_sec: 2.0,
        transition_recipe: None,
        transition_every_n: 0,
        respect_shot_boundaries: true,
    },
];

/// A profile that places transitions, for tests only.
///
/// No shipped profile places one while the renderer turns two-input transitions
/// into cuts, but the planner still has to know how — the `AddEffect` cadence is
/// the half of the feature that is finished, and it should not rot while the
/// render half is built. Nothing outside the test build can see this, so it
/// cannot be resolved by id or listed as a shipped choice.
#[cfg(test)]
pub(crate) const TRANSITION_CADENCE_TEST_PROFILE: PacingProfileSpec = PacingProfileSpec {
    id: "test-transition-cadence",
    description: "Test-only profile that exercises the transition cadence machinery.",
    aliases: &[],
    tempo: TempoClassification::Moderate,
    target_shot_sec: 2.5,
    shot_variance_sec: 1.0,
    transition_recipe: Some("dissolve-soft"),
    transition_every_n: 4,
    respect_shot_boundaries: false,
};

/// Returns every pacing profile descriptor, in table order.
pub fn list_pacing_profiles() -> Vec<PacingProfileDescriptor> {
    PACING_PROFILES
        .iter()
        .map(PacingProfileSpec::descriptor)
        .collect()
}

/// Returns the canonical ids of every pacing profile, in table order.
pub fn pacing_profile_ids() -> Vec<&'static str> {
    PACING_PROFILES.iter().map(|profile| profile.id).collect()
}

/// Resolves a pacing profile id.
///
/// Matching is tolerant of case and of `-`, `_`, or space separators, and of the
/// per-profile alias list. An unknown id is a hard error naming every valid id.
pub fn resolve_pacing_profile(id: &str) -> Result<&'static PacingProfileSpec, String> {
    let normalized = normalize_pack_id(id);

    PACING_PROFILES
        .iter()
        .find(|profile| {
            normalize_pack_id(profile.id) == normalized
                || profile
                    .aliases
                    .iter()
                    .any(|alias| normalize_pack_id(alias) == normalized)
        })
        .ok_or_else(|| {
            format!(
                "Unknown pacing profile '{}'. Valid profiles: {}",
                id.trim(),
                pacing_profile_ids().join(", ")
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_profile_id_is_unique_and_hyphenated() {
        let mut seen = std::collections::HashSet::new();
        for profile in PACING_PROFILES {
            assert!(
                seen.insert(profile.id),
                "duplicate profile id '{}'",
                profile.id
            );
            assert!(
                profile
                    .id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "profile id '{}' must be lowercase kebab-case",
                profile.id
            );
        }
    }

    #[test]
    fn every_profile_names_a_transition_recipe_that_exists() {
        for profile in PACING_PROFILES
            .iter()
            .chain(std::iter::once(&TRANSITION_CADENCE_TEST_PROFILE))
        {
            let Some(recipe_id) = profile.transition_recipe else {
                continue;
            };
            let resolved = resolve_pacing_recipe(profile.id, recipe_id);
            assert_eq!(
                resolved, recipe_id,
                "profile '{}' must name a canonical recipe id, not an alias",
                profile.id
            );
        }
    }

    #[test]
    fn every_shipped_profile_cuts_hard_until_it_can_choose_eligible_boundaries() {
        // Not for want of handles: a profile cuts one asset, so both sides of
        // every boundary it makes have all the unused media they could want.
        // The problem is that both sides are the *same* media at the same
        // frame, so the blend mixes each frame with itself and renders
        // bit-identically to the cut it replaced. Advertising a dissolve there
        // would advertise an effect the file cannot show.
        for profile in PACING_PROFILES {
            assert!(
                profile.transition_recipe.is_none(),
                "profile '{}' advertises transition recipe '{:?}', but every boundary a profile \
                 makes is a razor split, and a blend across one is invisible — leave the field \
                 None until a profile can also produce boundaries with material to blend between",
                profile.id,
                profile.transition_recipe
            );
            assert_eq!(
                profile.transition_every_n, 0,
                "profile '{}' must not declare a transition cadence it has no recipe for",
                profile.id
            );
            assert!(
                profile.active_transition().is_none(),
                "profile '{}' must cut hard",
                profile.id
            );
        }
    }

    #[test]
    fn the_test_only_profile_still_exercises_the_transition_cadence() {
        // The cadence machinery is finished and stays proven; only the shipped
        // catalogue holds back. If this ever stops reporting a transition, the
        // planner's `AddEffect` path has gone untested.
        let (recipe, every_n) = TRANSITION_CADENCE_TEST_PROFILE
            .active_transition()
            .expect("the test profile must place transitions");
        assert_eq!(recipe, "dissolve-soft");
        assert_eq!(every_n, 4);
        assert!(
            !PACING_PROFILES
                .iter()
                .any(|profile| profile.id == TRANSITION_CADENCE_TEST_PROFILE.id),
            "the test-only profile must never be shipped in the catalogue"
        );
    }

    fn resolve_pacing_recipe(profile_id: &str, recipe_id: &str) -> &'static str {
        super::super::resolve_transition_recipe(recipe_id)
            .unwrap_or_else(|error| {
                panic!("profile '{profile_id}' names an unknown recipe: {error}")
            })
            .id
    }

    #[test]
    fn every_profile_tempo_agrees_with_its_own_target() {
        // The tempo bands are the ESD's, so a profile and a measured reference
        // video describe pace on one scale rather than two.
        for profile in PACING_PROFILES {
            assert_eq!(
                profile.tempo,
                TempoClassification::from_mean_duration(profile.target_shot_sec),
                "profile '{}' declares a tempo its target of {}s contradicts",
                profile.id,
                profile.target_shot_sec
            );
        }
    }

    #[test]
    fn every_profile_declares_a_usable_target_and_variance() {
        for profile in PACING_PROFILES {
            assert!(
                profile.target_shot_sec > 0.5 && profile.target_shot_sec <= 30.0,
                "profile '{}' target {} is out of range",
                profile.id,
                profile.target_shot_sec
            );
            assert!(
                profile.shot_variance_sec >= 0.0,
                "profile '{}' variance must not be negative",
                profile.id
            );
            // A swing wider than the target itself would generate a shot of
            // zero or negative length at the bottom of the cycle.
            assert!(
                profile.shot_variance_sec < profile.target_shot_sec,
                "profile '{}' variance {} must stay under its target {}",
                profile.id,
                profile.shot_variance_sec,
                profile.target_shot_sec
            );
        }
    }

    #[test]
    fn a_profile_without_a_recipe_never_reports_an_active_transition() {
        for profile in PACING_PROFILES
            .iter()
            .chain(std::iter::once(&TRANSITION_CADENCE_TEST_PROFILE))
        {
            if profile.transition_recipe.is_none() || profile.transition_every_n == 0 {
                assert!(
                    profile.active_transition().is_none(),
                    "profile '{}' must cut hard",
                    profile.id
                );
            } else {
                assert!(
                    profile.active_transition().is_some(),
                    "profile '{}' must report its transition",
                    profile.id
                );
            }
        }
    }

    #[test]
    fn resolve_accepts_separator_and_case_variants() {
        for profile in PACING_PROFILES {
            for candidate in [
                profile.id.to_string(),
                profile.id.replace('-', "_"),
                profile.id.replace('-', " "),
                profile.id.to_ascii_uppercase(),
            ] {
                let resolved = resolve_pacing_profile(&candidate)
                    .unwrap_or_else(|error| panic!("'{candidate}' must resolve: {error}"));
                assert_eq!(resolved.id, profile.id);
            }
        }
    }

    #[test]
    fn every_alias_resolves_to_its_profile() {
        for profile in PACING_PROFILES {
            for alias in profile.aliases {
                let resolved = resolve_pacing_profile(alias)
                    .unwrap_or_else(|error| panic!("alias '{alias}' must resolve: {error}"));
                assert_eq!(resolved.id, profile.id);
            }
        }
    }

    #[test]
    fn unknown_profile_error_lists_every_valid_id() {
        let error = resolve_pacing_profile("no-such-profile").expect_err("unknown id must fail");
        for profile in PACING_PROFILES {
            assert!(
                error.contains(profile.id),
                "error must name '{}': {error}",
                profile.id
            );
        }
    }

    #[test]
    fn descriptors_round_trip_through_json() {
        for descriptor in list_pacing_profiles() {
            let json = serde_json::to_value(&descriptor).expect("descriptor serializes");
            let parsed: PacingProfileDescriptor =
                serde_json::from_value(json).expect("descriptor deserializes");
            assert_eq!(parsed, descriptor);
        }
    }

    #[test]
    fn the_catalog_spans_every_tempo_band() {
        // A taste layer with only one speed is not a choice.
        for tempo in [
            TempoClassification::Fast,
            TempoClassification::Moderate,
            TempoClassification::Slow,
        ] {
            assert!(
                PACING_PROFILES.iter().any(|profile| profile.tempo == tempo),
                "no profile covers {tempo:?}"
            );
        }
    }
}
