//! Curated Caption Style Packs
//!
//! A caption pack is a named, hand-checked combination of a typed
//! [`CaptionStyle`] and a [`CaptionPosition`]. Packs exist so an agent does not
//! have to invent typography: picking `boxed-contrast` is one token and lands on
//! a legible result, while assembling the same style field by field is a dozen
//! decisions with no feedback until the render.
//!
//! # Guarantees
//!
//! Every pack in [`CAPTION_PACKS`] is verified by contract test to:
//!
//! - deserialize back into a typed [`CaptionStyle`] after JSON round-trip,
//! - produce zero `CaptionSafeAreaRule` violations on both a 1920x1080 and a
//!   1080x1920 canvas — the rule measures the text block against the canvas, so
//!   the two runs are two different measurements rather than one repeated, and
//! - reach the export `drawtext` filter with the typography it advertises.
//!
//! Most packs anchor with [`CaptionPosition::Preset`] at a margin at or above
//! the 10% title-safe band. A pack whose alignment is not centered anchors with
//! [`CaptionPosition::Custom`] instead, because the renderer reads a preset
//! anchor as horizontally centered: pairing left alignment with a preset would
//! put the text's left edge at frame center.
//!
//! # Stability
//!
//! Pack ids are a public contract, so ids are append-only: rename nothing, and
//! add rather than repurpose. The op log records the concrete style a pack
//! produced, not the id that produced it — replay never consults this table —
//! so a rename cannot be repaired by rewriting history.

use serde::{Deserialize, Serialize};

use crate::core::captions::{
    CaptionPosition, CaptionStyle, Color, CustomPosition, FontWeight, TextAlignment,
    VerticalPosition,
};

use super::normalize_pack_id;

/// Where a pack places its captions.
///
/// A preset anchor is canvas-independent, which is what a centered dialogue
/// subtitle wants. A pack that is not centered has to name its own coordinates:
/// the render path reads every preset anchor as x = 50%, so pairing left
/// alignment with a preset would put the text's *left edge* at frame center.
#[derive(Clone, Debug)]
enum PackAnchor {
    /// Vertical preset at a margin percentage of the canvas height.
    Preset {
        /// Which edge the margin is measured from.
        vertical: VerticalPosition,
        /// Distance from that edge, as a percentage of canvas height.
        margin_percent: f64,
    },
    /// Explicit canvas-percentage anchor.
    ///
    /// `x_percent` is the text's left edge for a left-aligned pack and its
    /// center for a centered one, matching how `drawtext` reads the anchor.
    Custom {
        /// Horizontal anchor, as a percentage of canvas width.
        x_percent: f64,
        /// Vertical center of the text block, as a percentage of canvas height.
        y_percent: f64,
    },
}

/// Immutable definition of one curated caption style pack.
///
/// Held in a `const` table so the id list, the validator, and the resolved style
/// are the same source. [`CaptionStyle`] owns a `String` font family and
/// therefore cannot be `const` itself, so the spec stores `&'static str` and
/// materializes the typed style on demand via [`CaptionPackSpec::style`].
#[derive(Clone, Debug)]
pub struct CaptionPackSpec {
    /// Canonical, hyphenated pack identifier.
    pub id: &'static str,
    /// One-line description of what the pack is for.
    pub description: &'static str,
    /// Additional identifiers that resolve to this pack.
    pub aliases: &'static [&'static str],
    font_family: &'static str,
    font_size: u32,
    font_weight: FontWeight,
    color: Color,
    background_color: Option<Color>,
    outline_color: Option<Color>,
    outline_width: f32,
    shadow_color: Option<Color>,
    shadow_offset: f32,
    alignment: TextAlignment,
    anchor: PackAnchor,
}

impl CaptionPackSpec {
    /// Materializes the typed caption style for this pack.
    pub fn style(&self) -> CaptionStyle {
        CaptionStyle {
            font_family: self.font_family.to_string(),
            font_size: self.font_size,
            font_weight: self.font_weight.clone(),
            color: self.color.clone(),
            background_color: self.background_color.clone(),
            outline_color: self.outline_color.clone(),
            outline_width: self.outline_width,
            shadow_color: self.shadow_color.clone(),
            shadow_offset: self.shadow_offset,
            alignment: self.alignment.clone(),
            italic: false,
            underline: false,
        }
    }

    /// Materializes the typed caption position for this pack.
    pub fn position(&self) -> CaptionPosition {
        match &self.anchor {
            PackAnchor::Preset {
                vertical,
                margin_percent,
            } => CaptionPosition::Preset {
                vertical: vertical.clone(),
                margin_percent: *margin_percent,
            },
            PackAnchor::Custom {
                x_percent,
                y_percent,
            } => CaptionPosition::Custom(CustomPosition {
                x_percent: *x_percent,
                y_percent: *y_percent,
            }),
        }
    }

    /// Builds the serializable descriptor used by listing surfaces.
    pub fn descriptor(&self) -> CaptionPackDescriptor {
        CaptionPackDescriptor {
            id: self.id.to_string(),
            kind: "caption".to_string(),
            description: self.description.to_string(),
            aliases: self.aliases.iter().map(|alias| alias.to_string()).collect(),
            style: self.style(),
            position: self.position(),
        }
    }
}

/// Serializable description of a caption pack, as returned by listing surfaces.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionPackDescriptor {
    /// Canonical pack identifier.
    pub id: String,
    /// Always `"caption"`; lets caption and transition entries share one list.
    pub kind: String,
    /// One-line description of what the pack is for.
    pub description: String,
    /// Additional identifiers that resolve to this pack.
    pub aliases: Vec<String>,
    /// The typed style the pack applies.
    pub style: CaptionStyle,
    /// The typed position the pack applies.
    pub position: CaptionPosition,
}

/// White at full opacity.
const WHITE: Color = Color {
    r: 255,
    g: 255,
    b: 255,
    a: 255,
};

/// Opaque black, used for outlines and shadows.
const BLACK: Color = Color {
    r: 0,
    g: 0,
    b: 0,
    a: 255,
};

/// The canonical caption pack table.
///
/// This is both the validator and the listing: `packs list` prints it and
/// [`resolve_caption_pack`] matches against it.
pub const CAPTION_PACKS: &[CaptionPackSpec] = &[
    CaptionPackSpec {
        id: "standard-outline",
        description: "General-purpose subtitle: white text with a thin black outline and a soft \
                      drop shadow. The safe default when the brief says nothing about styling.",
        aliases: &["standard", "default"],
        font_family: "Arial",
        font_size: 48,
        font_weight: FontWeight::Normal,
        color: WHITE,
        background_color: None,
        outline_color: Some(BLACK),
        outline_width: 2.0,
        shadow_color: Some(Color {
            r: 0,
            g: 0,
            b: 0,
            a: 128,
        }),
        shadow_offset: 2.0,
        alignment: TextAlignment::Center,
        anchor: PackAnchor::Preset {
            vertical: VerticalPosition::Bottom,
            margin_percent: 10.0,
        },
    },
    CaptionPackSpec {
        id: "clean-minimal",
        description: "Unadorned white text with no outline, shadow, or box. Use only over \
                      controlled, consistently dark footage.",
        aliases: &["minimal", "clean"],
        font_family: "Arial",
        font_size: 48,
        font_weight: FontWeight::Normal,
        color: WHITE,
        background_color: None,
        outline_color: None,
        outline_width: 0.0,
        shadow_color: None,
        shadow_offset: 0.0,
        alignment: TextAlignment::Center,
        anchor: PackAnchor::Preset {
            vertical: VerticalPosition::Bottom,
            margin_percent: 10.0,
        },
    },
    CaptionPackSpec {
        id: "boxed-contrast",
        description: "White text on a translucent black box. Survives busy or bright backgrounds \
                      where an outline alone breaks down.",
        aliases: &["boxed", "box"],
        font_family: "Arial",
        font_size: 48,
        font_weight: FontWeight::Normal,
        color: WHITE,
        background_color: Some(Color {
            r: 0,
            g: 0,
            b: 0,
            a: 180,
        }),
        outline_color: None,
        outline_width: 0.0,
        shadow_color: None,
        shadow_offset: 0.0,
        alignment: TextAlignment::Center,
        anchor: PackAnchor::Preset {
            vertical: VerticalPosition::Bottom,
            margin_percent: 10.0,
        },
    },
    CaptionPackSpec {
        id: "yellow-classic",
        description: "Broadcast-legacy yellow subtitle with black outline and shadow. Reads as \
                      dialogue subtitling rather than on-screen graphics.",
        aliases: &["yellow", "classic"],
        font_family: "Arial",
        font_size: 48,
        font_weight: FontWeight::Normal,
        color: Color {
            r: 255,
            g: 255,
            b: 0,
            a: 255,
        },
        background_color: None,
        outline_color: Some(BLACK),
        outline_width: 2.0,
        shadow_color: Some(Color {
            r: 0,
            g: 0,
            b: 0,
            a: 128,
        }),
        shadow_offset: 2.0,
        alignment: TextAlignment::Center,
        anchor: PackAnchor::Preset {
            vertical: VerticalPosition::Bottom,
            margin_percent: 10.0,
        },
    },
    CaptionPackSpec {
        id: "shorts-bold-outline",
        description: "Large bold white text with a thick black outline, lifted to an 18% bottom \
                      margin so vertical-platform UI does not cover it.",
        aliases: &["shorts", "reels", "tiktok", "vertical"],
        font_family: "Arial",
        font_size: 72,
        font_weight: FontWeight::Bold,
        color: WHITE,
        background_color: None,
        outline_color: Some(BLACK),
        outline_width: 6.0,
        shadow_color: Some(Color {
            r: 0,
            g: 0,
            b: 0,
            a: 160,
        }),
        shadow_offset: 3.0,
        alignment: TextAlignment::Center,
        anchor: PackAnchor::Preset {
            vertical: VerticalPosition::Bottom,
            margin_percent: 18.0,
        },
    },
    CaptionPackSpec {
        id: "broadcast-lower",
        description: "Left-aligned boxed name plate anchored in the lower-left third, for \
                      attribution rather than dialogue.",
        aliases: &["broadcast", "lower-third"],
        font_family: "Arial",
        font_size: 40,
        font_weight: FontWeight::Bold,
        color: WHITE,
        background_color: Some(Color {
            r: 0,
            g: 0,
            b: 0,
            a: 200,
        }),
        outline_color: None,
        outline_width: 0.0,
        shadow_color: Some(Color {
            r: 0,
            g: 0,
            b: 0,
            a: 120,
        }),
        shadow_offset: 2.0,
        alignment: TextAlignment::Left,
        // The only non-centered pack, so the only one that cannot use a preset:
        // `drawtext` puts a left-aligned run's left edge on the anchor, and a
        // preset anchor is always x = 50%. 10% from the left is the title-safe
        // edge, which is where a name plate belongs.
        anchor: PackAnchor::Custom {
            x_percent: 10.0,
            y_percent: 84.0,
        },
    },
    CaptionPackSpec {
        id: "high-contrast-accessible",
        description: "Oversized bold white text on a near-opaque black box. Highest legibility \
                      floor for small screens and low-vision viewers.",
        aliases: &["accessible", "a11y", "high-contrast"],
        font_family: "Arial",
        font_size: 64,
        font_weight: FontWeight::Bold,
        color: WHITE,
        background_color: Some(Color {
            r: 0,
            g: 0,
            b: 0,
            a: 230,
        }),
        outline_color: None,
        outline_width: 0.0,
        shadow_color: None,
        shadow_offset: 0.0,
        alignment: TextAlignment::Center,
        anchor: PackAnchor::Preset {
            vertical: VerticalPosition::Bottom,
            margin_percent: 12.0,
        },
    },
    CaptionPackSpec {
        id: "caption-top",
        description: "Outlined white text anchored to the top of frame, for shots whose action \
                      or burned-in graphics own the lower half.",
        aliases: &["top", "top-caption"],
        font_family: "Arial",
        font_size: 48,
        font_weight: FontWeight::Normal,
        color: WHITE,
        background_color: None,
        outline_color: Some(BLACK),
        outline_width: 2.0,
        shadow_color: Some(Color {
            r: 0,
            g: 0,
            b: 0,
            a: 128,
        }),
        shadow_offset: 2.0,
        alignment: TextAlignment::Center,
        anchor: PackAnchor::Preset {
            vertical: VerticalPosition::Top,
            margin_percent: 12.0,
        },
    },
];

/// Returns every caption pack descriptor, in table order.
pub fn list_caption_packs() -> Vec<CaptionPackDescriptor> {
    CAPTION_PACKS
        .iter()
        .map(CaptionPackSpec::descriptor)
        .collect()
}

/// Returns the canonical ids of every caption pack, in table order.
pub fn caption_pack_ids() -> Vec<&'static str> {
    CAPTION_PACKS.iter().map(|pack| pack.id).collect()
}

/// Resolves a caption pack id.
///
/// Matching is tolerant of case and of `-`, `_`, or space separators, and of the
/// per-pack alias list. An unknown id is a hard error naming every valid id.
pub fn resolve_caption_pack(id: &str) -> Result<&'static CaptionPackSpec, String> {
    let normalized = normalize_pack_id(id);

    CAPTION_PACKS
        .iter()
        .find(|pack| {
            normalize_pack_id(pack.id) == normalized
                || pack
                    .aliases
                    .iter()
                    .any(|alias| normalize_pack_id(alias) == normalized)
        })
        .ok_or_else(|| {
            format!(
                "Unknown caption style pack '{}'. Valid packs: {}",
                id.trim(),
                caption_pack_ids().join(", ")
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pack_id_is_unique_and_hyphenated() {
        let mut seen = std::collections::HashSet::new();
        for pack in CAPTION_PACKS {
            assert!(seen.insert(pack.id), "duplicate pack id '{}'", pack.id);
            assert!(
                pack.id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "pack id '{}' must be lowercase kebab-case",
                pack.id
            );
        }
    }

    #[test]
    fn resolve_accepts_separator_and_case_variants() {
        for pack in CAPTION_PACKS {
            let underscored = pack.id.replace('-', "_");
            let spaced = pack.id.replace('-', " ");
            for candidate in [
                pack.id.to_string(),
                underscored,
                spaced,
                pack.id.to_ascii_uppercase(),
                format!("  {}  ", pack.id),
            ] {
                let resolved = resolve_caption_pack(&candidate)
                    .unwrap_or_else(|error| panic!("'{candidate}' must resolve: {error}"));
                assert_eq!(resolved.id, pack.id);
            }
        }
    }

    #[test]
    fn every_alias_resolves_to_its_pack() {
        for pack in CAPTION_PACKS {
            for alias in pack.aliases {
                let resolved = resolve_caption_pack(alias)
                    .unwrap_or_else(|error| panic!("alias '{alias}' must resolve: {error}"));
                assert_eq!(resolved.id, pack.id);
            }
        }
    }

    #[test]
    fn unknown_pack_error_lists_every_valid_id() {
        let error = resolve_caption_pack("no-such-pack").expect_err("unknown id must fail");
        for pack in CAPTION_PACKS {
            assert!(
                error.contains(pack.id),
                "error must name '{}': {error}",
                pack.id
            );
        }
    }

    #[test]
    fn a_non_centered_pack_never_anchors_with_a_preset() {
        // The render path resolves every preset anchor to x = 50%, so left or
        // right alignment paired with one puts the text's edge at frame center
        // instead of where the pack says it goes.
        for pack in CAPTION_PACKS {
            if pack.style().alignment == TextAlignment::Center {
                continue;
            }

            assert!(
                matches!(pack.position(), CaptionPosition::Custom(_)),
                "pack '{}' is {:?}-aligned, so it must name its own x anchor",
                pack.id,
                pack.style().alignment
            );
        }
    }

    #[test]
    fn descriptors_round_trip_through_json() {
        for descriptor in list_caption_packs() {
            let json = serde_json::to_value(&descriptor).expect("descriptor serializes");
            let parsed: CaptionPackDescriptor =
                serde_json::from_value(json).expect("descriptor deserializes");
            assert_eq!(parsed, descriptor);
        }
    }
}
