//! Curated Text Presets
//!
//! A text preset is a named, hand-checked [`TextClipData`]: typography, canvas
//! anchor, shadow, outline, opacity, a starter string, and a suggested duration.
//! Naming one is a single token; assembling the same overlay field by field is a
//! dozen decisions with no feedback until the render.
//!
//! # One catalog
//!
//! This table is the *only* text preset catalog in the Rust tree. Before it
//! existed the CLI carried its own inline table of 14 presets while the agent
//! prose advertised 17 and the TypeScript UI shipped 22, so `--preset quote` was
//! documented and rejected in the same breath. Every Rust surface — the CLI
//! `text add --preset`, `packs list --kind text`, the `preset` field on
//! `AddTextClip`, the MCP payload hints, and `help-json` — now reads from
//! [`TEXT_PRESETS`], and `src/data/textPresets.manifest.json` pins the
//! TypeScript catalog to it by test on both sides.
//!
//! # Guarantees
//!
//! Every preset in [`TEXT_PRESETS`] is verified by contract test to:
//!
//! - resolve from its id, its display name, and each of its aliases,
//! - survive the real command path — `AddTextClip` with `preset` through
//!   `CommandPayload::parse`, execute, and back out of the clip as typed
//!   [`TextClipData`] — and
//! - reach the export `drawtext` filter with the typography it advertises.
//!
//! # Stability
//!
//! Preset ids are a public contract, so ids are append-only: rename nothing, and
//! add rather than repurpose. The op log records the concrete [`TextClipData`] a
//! preset produced, not the id that produced it — replay never consults this
//! table — so a rename cannot be repaired by rewriting history.

use serde::{Deserialize, Serialize};

use crate::core::text::{
    TextAlignment, TextClipData, TextOutline, TextPosition, TextShadow, TextStyle,
};

use super::normalize_pack_id;

/// Editorial role a preset plays, and the placement intent that follows from it.
///
/// The agent text tools read this to decide whether an overlay may be moved by
/// smart placement (`title`, `lower-third`, `subtitle`, `callout`) or must keep
/// the anchor the template chose (`credit`, `brand`, `creative`), so a category
/// is behavior rather than a label.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextPresetCategory {
    /// Name plates and speaker identification.
    LowerThird,
    /// Full-frame titles and chapter cards.
    Title,
    /// Dialogue-style bottom text.
    Subtitle,
    /// Attention-grabbing emphasis, stats, warnings, counters.
    Callout,
    /// Attribution and end credits.
    Credit,
    /// Channel bugs and social handles.
    Brand,
    /// Stylistic treatments that own their placement.
    Creative,
}

impl TextPresetCategory {
    /// Returns the serialized spelling of this category.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LowerThird => "lower-third",
            Self::Title => "title",
            Self::Subtitle => "subtitle",
            Self::Callout => "callout",
            Self::Credit => "credit",
            Self::Brand => "brand",
            Self::Creative => "creative",
        }
    }
}

/// A preset's drop shadow, in `const`-friendly form.
#[derive(Clone, Copy, Debug)]
struct PresetShadow {
    color: &'static str,
    offset_x: i32,
    offset_y: i32,
    blur: u32,
}

/// A preset's outline, in `const`-friendly form.
#[derive(Clone, Copy, Debug)]
struct PresetOutline {
    color: &'static str,
    width: u32,
}

/// Immutable definition of one curated text preset.
///
/// Held in a `const` table so the id list, the validator, and the resolved clip
/// data are the same source. [`TextClipData`] owns `String` fields and therefore
/// cannot be `const` itself, so the spec stores `&'static str` and materializes
/// the typed clip on demand via [`TextPresetSpec::clip_data`].
#[derive(Clone, Debug)]
pub struct TextPresetSpec {
    /// Canonical, hyphenated preset identifier.
    pub id: &'static str,
    /// Human-readable display name, as shown in the UI picker.
    pub name: &'static str,
    /// One-line description of what the preset is for.
    pub description: &'static str,
    /// Editorial role, which also decides placement handling.
    pub category: TextPresetCategory,
    /// Additional identifiers that resolve to this preset.
    pub aliases: &'static [&'static str],
    /// Starter copy, used when a caller names a preset without text.
    pub default_content: &'static str,
    /// Suggested clip duration in seconds.
    pub default_duration_sec: f64,
    font_family: &'static str,
    font_size: u32,
    color: &'static str,
    bold: bool,
    italic: bool,
    underline: bool,
    alignment: TextAlignment,
    line_height: f64,
    letter_spacing: i32,
    background_color: Option<&'static str>,
    background_padding: u32,
    x: f64,
    y: f64,
    shadow: Option<PresetShadow>,
    outline: Option<PresetOutline>,
    rotation: f64,
    opacity: f64,
}

impl TextPresetSpec {
    /// Materializes the typed style for this preset.
    ///
    /// `font_weight` is derived from `bold` rather than stored, because the two
    /// are one decision: the render path treats any weight at or above 600 as
    /// bold, so a preset that says bold and carries weight 400 would render one
    /// way and read the other.
    pub fn style(&self) -> TextStyle {
        TextStyle {
            font_family: self.font_family.to_string(),
            font_size: self.font_size,
            font_weight: if self.bold { 700 } else { 400 },
            color: self.color.to_string(),
            background_color: self.background_color.map(str::to_string),
            background_padding: self.background_padding,
            alignment: self.alignment.clone(),
            bold: self.bold,
            italic: self.italic,
            underline: self.underline,
            line_height: self.line_height,
            letter_spacing: self.letter_spacing,
        }
    }

    /// Materializes the typed canvas anchor for this preset.
    pub fn position(&self) -> TextPosition {
        TextPosition {
            x: self.x,
            y: self.y,
        }
    }

    /// Materializes the typed clip data for this preset with the given content.
    pub fn clip_data(&self, content: impl Into<String>) -> TextClipData {
        TextClipData {
            content: content.into(),
            style: self.style(),
            position: self.position(),
            shadow: self.shadow.map(|shadow| TextShadow {
                color: shadow.color.to_string(),
                offset_x: shadow.offset_x,
                offset_y: shadow.offset_y,
                blur: shadow.blur,
            }),
            outline: self.outline.map(|outline| TextOutline {
                color: outline.color.to_string(),
                width: outline.width,
            }),
            rotation: self.rotation,
            opacity: self.opacity,
        }
    }

    /// Materializes the typed clip data carrying the preset's starter copy.
    pub fn default_clip_data(&self) -> TextClipData {
        self.clip_data(self.default_content)
    }

    /// Builds the serializable descriptor used by listing surfaces.
    pub fn descriptor(&self) -> TextPresetDescriptor {
        TextPresetDescriptor {
            id: self.id.to_string(),
            kind: "text".to_string(),
            name: self.name.to_string(),
            category: self.category,
            description: self.description.to_string(),
            aliases: self.aliases.iter().map(|alias| alias.to_string()).collect(),
            default_duration_sec: self.default_duration_sec,
            clip: self.default_clip_data(),
        }
    }
}

/// Serializable description of a text preset, as returned by listing surfaces.
///
/// This is also the shape pinned into `src/data/textPresets.manifest.json`, so
/// the TypeScript catalog and this table cannot drift without a test failing on
/// one side or the other.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPresetDescriptor {
    /// Canonical preset identifier.
    pub id: String,
    /// Always `"text"`; lets text, caption, and transition entries share one list.
    pub kind: String,
    /// Human-readable display name.
    pub name: String,
    /// Editorial role, which also decides placement handling.
    pub category: TextPresetCategory,
    /// One-line description of what the preset is for.
    pub description: String,
    /// Additional identifiers that resolve to this preset.
    pub aliases: Vec<String>,
    /// Suggested clip duration in seconds.
    pub default_duration_sec: f64,
    /// The typed clip data the preset applies, carrying its starter copy.
    pub clip: TextClipData,
}

/// The canonical text preset table.
///
/// This is both the validator and the listing: `packs list --kind text` prints
/// it and [`resolve_text_preset`] matches against it.
pub const TEXT_PRESETS: &[TextPresetSpec] = &[
    // -------------------------------------------------------------------------
    // Lower thirds
    // -------------------------------------------------------------------------
    TextPresetSpec {
        id: "lower-third",
        name: "Lower Third",
        description: "Classic lower third for names and titles",
        category: TextPresetCategory::LowerThird,
        aliases: &["lower_third", "lowerthird", "name_title"],
        default_content: "Speaker Name\nTitle or Role",
        default_duration_sec: 5.0,
        font_family: "Arial",
        font_size: 42,
        color: "#FFFFFF",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Left,
        line_height: 1.2,
        letter_spacing: 1,
        background_color: Some("#000000B3"),
        background_padding: 12,
        x: 0.08,
        y: 0.82,
        shadow: Some(PresetShadow {
            color: "#000000",
            offset_x: 2,
            offset_y: 2,
            blur: 4,
        }),
        outline: None,
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "lower-third-minimal",
        name: "Lower Third Minimal",
        description: "Clean minimal lower third",
        category: TextPresetCategory::LowerThird,
        aliases: &["minimal_lower_third"],
        default_content: "Speaker Name",
        default_duration_sec: 4.0,
        font_family: "Helvetica",
        font_size: 36,
        color: "#FFFFFF",
        bold: false,
        italic: false,
        underline: false,
        alignment: TextAlignment::Left,
        line_height: 1.3,
        letter_spacing: 2,
        background_color: None,
        background_padding: 0,
        x: 0.05,
        y: 0.88,
        shadow: None,
        outline: Some(PresetOutline {
            color: "#000000",
            width: 1,
        }),
        rotation: 0.0,
        opacity: 0.95,
    },
    TextPresetSpec {
        id: "lower-third-news",
        name: "News Lower Third",
        description: "Broadcast-style lower third with a strong title band",
        category: TextPresetCategory::LowerThird,
        aliases: &["broadcast_lower_third", "news-lower-third"],
        default_content: "Breaking Story\nLocation",
        default_duration_sec: 6.0,
        font_family: "Arial",
        font_size: 40,
        color: "#FFFFFF",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Left,
        line_height: 1.15,
        letter_spacing: 1,
        background_color: Some("#123E7CCC"),
        background_padding: 14,
        x: 0.07,
        y: 0.78,
        shadow: Some(PresetShadow {
            color: "#00000080",
            offset_x: 1,
            offset_y: 2,
            blur: 3,
        }),
        outline: None,
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "lower-third-name-role",
        name: "Name + Role",
        description: "Interview lower third with compact name and role styling",
        category: TextPresetCategory::LowerThird,
        aliases: &["interview_lower_third", "speaker_id", "name_role"],
        default_content: "Jane Doe\nCreative Director",
        default_duration_sec: 5.0,
        font_family: "Helvetica",
        font_size: 38,
        color: "#F8FAFC",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Left,
        line_height: 1.25,
        letter_spacing: 1,
        background_color: Some("#111827D9"),
        background_padding: 10,
        x: 0.08,
        y: 0.84,
        shadow: None,
        outline: Some(PresetOutline {
            color: "#00000066",
            width: 1,
        }),
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "label",
        name: "Label",
        description: "Simple label for annotations",
        category: TextPresetCategory::LowerThird,
        aliases: &["annotation_label", "tag"],
        default_content: "Label",
        default_duration_sec: 3.0,
        font_family: "Arial",
        font_size: 24,
        color: "#FFFFFF",
        bold: false,
        italic: false,
        underline: false,
        alignment: TextAlignment::Left,
        line_height: 1.3,
        letter_spacing: 0,
        background_color: Some("#333333"),
        background_padding: 6,
        x: 0.1,
        y: 0.1,
        shadow: None,
        outline: None,
        rotation: 0.0,
        opacity: 0.9,
    },
    // -------------------------------------------------------------------------
    // Centered titles
    // -------------------------------------------------------------------------
    TextPresetSpec {
        id: "centered-title",
        name: "Centered Title",
        description: "Bold centered title for intros",
        category: TextPresetCategory::Title,
        aliases: &["title"],
        default_content: "Main Title",
        default_duration_sec: 4.0,
        font_family: "Arial",
        font_size: 72,
        color: "#FFFFFF",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.1,
        letter_spacing: 4,
        background_color: None,
        background_padding: 0,
        x: 0.5,
        y: 0.5,
        shadow: Some(PresetShadow {
            color: "#000000",
            offset_x: 3,
            offset_y: 3,
            blur: 8,
        }),
        outline: None,
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "epic-title",
        name: "Epic Title",
        description: "Large dramatic title for impact",
        category: TextPresetCategory::Title,
        aliases: &["impact_title", "hero_title"],
        default_content: "Big Moment",
        default_duration_sec: 3.0,
        font_family: "Impact",
        font_size: 96,
        color: "#FFFFFF",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.0,
        letter_spacing: 6,
        background_color: None,
        background_padding: 0,
        x: 0.5,
        y: 0.5,
        shadow: Some(PresetShadow {
            color: "#000000",
            offset_x: 4,
            offset_y: 4,
            blur: 12,
        }),
        outline: Some(PresetOutline {
            color: "#000000",
            width: 3,
        }),
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "chapter-title",
        name: "Chapter Title",
        description: "Editorial chapter card with title and subtitle",
        category: TextPresetCategory::Title,
        aliases: &["chapter", "chapter_card", "section_title"],
        default_content: "Chapter One\nThe Setup",
        default_duration_sec: 5.0,
        font_family: "Georgia",
        font_size: 62,
        color: "#F8FAFC",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.18,
        letter_spacing: 2,
        background_color: None,
        background_padding: 0,
        x: 0.5,
        y: 0.45,
        shadow: Some(PresetShadow {
            color: "#00000099",
            offset_x: 2,
            offset_y: 3,
            blur: 8,
        }),
        outline: None,
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "end-card-title",
        name: "End Card",
        description: "Centered end screen title for channels and credits",
        category: TextPresetCategory::Title,
        aliases: &["end_card", "outro_title"],
        default_content: "Thanks for Watching",
        default_duration_sec: 6.0,
        font_family: "Arial",
        font_size: 58,
        color: "#FFFFFF",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.25,
        letter_spacing: 1,
        background_color: Some("#111827CC"),
        background_padding: 18,
        x: 0.5,
        y: 0.5,
        shadow: None,
        outline: None,
        rotation: 0.0,
        opacity: 1.0,
    },
    // -------------------------------------------------------------------------
    // Subtitles
    // -------------------------------------------------------------------------
    TextPresetSpec {
        id: "subtitle",
        name: "Subtitle",
        description: "Standard subtitle/caption style",
        category: TextPresetCategory::Subtitle,
        aliases: &["caption", "subtitles"],
        default_content: "Subtitle text",
        default_duration_sec: 3.0,
        font_family: "Arial",
        font_size: 32,
        color: "#FFFFFF",
        bold: false,
        italic: false,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.4,
        letter_spacing: 0,
        background_color: Some("#00000099"),
        background_padding: 8,
        x: 0.5,
        y: 0.9,
        shadow: None,
        outline: None,
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "subtitle-outline",
        name: "Subtitle Outline",
        description: "Subtitle with outline (no background)",
        category: TextPresetCategory::Subtitle,
        aliases: &["outlined_subtitle"],
        default_content: "Subtitle text",
        default_duration_sec: 3.0,
        font_family: "Arial",
        font_size: 34,
        color: "#FFFFFF",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.4,
        letter_spacing: 0,
        background_color: None,
        background_padding: 0,
        x: 0.5,
        y: 0.9,
        shadow: None,
        outline: Some(PresetOutline {
            color: "#000000",
            width: 2,
        }),
        rotation: 0.0,
        opacity: 1.0,
    },
    // -------------------------------------------------------------------------
    // Callouts
    // -------------------------------------------------------------------------
    TextPresetSpec {
        id: "callout",
        name: "Callout",
        description: "Attention-grabbing callout text",
        category: TextPresetCategory::Callout,
        aliases: &["emphasis"],
        default_content: "Key Point",
        default_duration_sec: 3.0,
        font_family: "Arial",
        font_size: 48,
        color: "#FFD700",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.2,
        letter_spacing: 2,
        background_color: None,
        background_padding: 0,
        x: 0.5,
        y: 0.35,
        shadow: Some(PresetShadow {
            color: "#000000",
            offset_x: 2,
            offset_y: 2,
            blur: 6,
        }),
        outline: Some(PresetOutline {
            color: "#000000",
            width: 2,
        }),
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "callout-stat",
        name: "Stat Callout",
        description: "Large numeric callout for data, prices, and milestones",
        category: TextPresetCategory::Callout,
        aliases: &["stat", "number_callout", "price_callout"],
        default_content: "42%",
        default_duration_sec: 3.0,
        font_family: "Arial",
        font_size: 82,
        color: "#38BDF8",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.0,
        letter_spacing: 1,
        background_color: None,
        background_padding: 0,
        x: 0.5,
        y: 0.42,
        shadow: Some(PresetShadow {
            color: "#000000",
            offset_x: 3,
            offset_y: 4,
            blur: 8,
        }),
        outline: Some(PresetOutline {
            color: "#082F49",
            width: 2,
        }),
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "callout-warning",
        name: "Warning Callout",
        description: "High-contrast warning or safety note",
        category: TextPresetCategory::Callout,
        aliases: &["warning", "important_callout"],
        default_content: "Important",
        default_duration_sec: 3.0,
        font_family: "Arial",
        font_size: 46,
        color: "#111827",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.15,
        letter_spacing: 1,
        background_color: Some("#FACC15E6"),
        background_padding: 14,
        x: 0.5,
        y: 0.22,
        shadow: None,
        outline: Some(PresetOutline {
            color: "#FFFFFF",
            width: 1,
        }),
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "countdown",
        name: "Countdown",
        description: "Bold countdown/timer style",
        category: TextPresetCategory::Callout,
        aliases: &["timer"],
        default_content: "3",
        default_duration_sec: 1.0,
        font_family: "Impact",
        font_size: 120,
        color: "#FF0000",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.0,
        letter_spacing: 0,
        background_color: None,
        background_padding: 0,
        x: 0.5,
        y: 0.5,
        shadow: Some(PresetShadow {
            color: "#000000",
            offset_x: 4,
            offset_y: 4,
            blur: 8,
        }),
        outline: Some(PresetOutline {
            color: "#FFFFFF",
            width: 4,
        }),
        rotation: 0.0,
        opacity: 1.0,
    },
    // -------------------------------------------------------------------------
    // Credits and brand
    // -------------------------------------------------------------------------
    TextPresetSpec {
        id: "credits-block",
        name: "Credits Block",
        description: "Centered credit block for ending cards",
        category: TextPresetCategory::Credit,
        aliases: &["credits", "credit_block", "end_credits"],
        default_content: "Directed by\nJane Doe\n\nProduced by\nOpenReelio",
        default_duration_sec: 8.0,
        font_family: "Georgia",
        font_size: 34,
        color: "#F8FAFC",
        bold: false,
        italic: false,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.45,
        letter_spacing: 1,
        background_color: None,
        background_padding: 0,
        x: 0.5,
        y: 0.52,
        shadow: Some(PresetShadow {
            color: "#000000AA",
            offset_x: 1,
            offset_y: 2,
            blur: 5,
        }),
        outline: None,
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "credit-line",
        name: "Credit Line",
        description: "Small single-line attribution or source credit",
        category: TextPresetCategory::Credit,
        aliases: &["source_credit", "attribution"],
        default_content: "Source: OpenReelio",
        default_duration_sec: 5.0,
        font_family: "Arial",
        font_size: 24,
        color: "#E5E7EB",
        bold: false,
        italic: false,
        underline: false,
        alignment: TextAlignment::Right,
        line_height: 1.2,
        letter_spacing: 0,
        background_color: Some("#00000080"),
        background_padding: 6,
        x: 0.94,
        y: 0.92,
        shadow: None,
        outline: None,
        rotation: 0.0,
        opacity: 0.9,
    },
    TextPresetSpec {
        id: "logo-bug",
        name: "Logo Bug",
        description: "Subtle top-right brand bug or channel label",
        category: TextPresetCategory::Brand,
        aliases: &["bug", "channel_bug", "brand_bug"],
        default_content: "OPEN",
        default_duration_sec: 10.0,
        font_family: "Arial",
        font_size: 24,
        color: "#FFFFFF",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Right,
        line_height: 1.15,
        letter_spacing: 1,
        background_color: Some("#0F766ECC"),
        background_padding: 8,
        x: 0.94,
        y: 0.08,
        shadow: None,
        outline: None,
        rotation: 0.0,
        opacity: 0.85,
    },
    TextPresetSpec {
        id: "social-handle",
        name: "Social Handle",
        description: "Creator handle or social profile lower bug",
        category: TextPresetCategory::Brand,
        aliases: &["handle", "social"],
        default_content: "@openreelio",
        default_duration_sec: 5.0,
        font_family: "Arial",
        font_size: 30,
        color: "#FFFFFF",
        bold: true,
        italic: false,
        underline: false,
        alignment: TextAlignment::Left,
        line_height: 1.2,
        letter_spacing: 0,
        background_color: Some("#7C3AEDCC"),
        background_padding: 10,
        x: 0.07,
        y: 0.91,
        shadow: Some(PresetShadow {
            color: "#00000099",
            offset_x: 1,
            offset_y: 2,
            blur: 4,
        }),
        outline: None,
        rotation: 0.0,
        opacity: 1.0,
    },
    // -------------------------------------------------------------------------
    // Creative treatments
    // -------------------------------------------------------------------------
    TextPresetSpec {
        id: "quote",
        name: "Quote",
        description: "Elegant quote style with italics",
        category: TextPresetCategory::Creative,
        aliases: &["pull_quote"],
        default_content: "\"Pull quote goes here\"",
        default_duration_sec: 5.0,
        font_family: "Georgia",
        font_size: 42,
        color: "#FFFFFF",
        bold: false,
        italic: true,
        underline: false,
        alignment: TextAlignment::Center,
        line_height: 1.6,
        letter_spacing: 1,
        background_color: None,
        background_padding: 0,
        x: 0.5,
        y: 0.5,
        shadow: Some(PresetShadow {
            color: "#000000",
            offset_x: 1,
            offset_y: 1,
            blur: 3,
        }),
        outline: None,
        rotation: 0.0,
        opacity: 0.95,
    },
    TextPresetSpec {
        id: "tech-style",
        name: "Tech Style",
        description: "Modern monospace tech aesthetic",
        category: TextPresetCategory::Creative,
        aliases: &["tech", "terminal"],
        default_content: "SYSTEM READY",
        default_duration_sec: 4.0,
        font_family: "Courier New",
        font_size: 36,
        color: "#00FF00",
        bold: false,
        italic: false,
        underline: false,
        alignment: TextAlignment::Left,
        line_height: 1.4,
        letter_spacing: 0,
        background_color: Some("#000000CC"),
        background_padding: 10,
        x: 0.05,
        y: 0.05,
        shadow: None,
        outline: None,
        rotation: 0.0,
        opacity: 1.0,
    },
    TextPresetSpec {
        id: "watermark",
        name: "Watermark",
        description: "Subtle watermark/branding text",
        category: TextPresetCategory::Creative,
        aliases: &[],
        default_content: "Brand",
        default_duration_sec: 10.0,
        font_family: "Arial",
        font_size: 24,
        color: "#FFFFFF",
        bold: false,
        italic: false,
        underline: false,
        alignment: TextAlignment::Right,
        line_height: 1.2,
        letter_spacing: 0,
        background_color: None,
        background_padding: 0,
        x: 0.95,
        y: 0.95,
        shadow: None,
        outline: None,
        rotation: 0.0,
        opacity: 0.4,
    },
];

/// Returns every text preset descriptor, in table order.
pub fn list_text_presets() -> Vec<TextPresetDescriptor> {
    TEXT_PRESETS
        .iter()
        .map(TextPresetSpec::descriptor)
        .collect()
}

/// Returns the canonical ids of every text preset, in table order.
pub fn text_preset_ids() -> Vec<&'static str> {
    TEXT_PRESETS.iter().map(|preset| preset.id).collect()
}

/// Returns every accepted spelling: ids first, then aliases, in table order.
///
/// This is what agent-facing surfaces advertise, because an alias an agent read
/// in a hint has to be an alias the parser accepts.
pub fn text_preset_keys() -> Vec<&'static str> {
    let mut keys: Vec<&'static str> = text_preset_ids();
    for preset in TEXT_PRESETS {
        for alias in preset.aliases {
            if !keys.contains(alias) {
                keys.push(alias);
            }
        }
    }
    keys
}

/// Resolves a text preset id, display name, or alias.
///
/// Matching is tolerant of case and of `-`, `_`, or space separators, matching
/// the TypeScript `normalizeTextPresetKey` contract exactly, so `Lower_Third`,
/// `lower third`, and `lower-third` are one preset. An unknown id is a hard
/// error naming every valid id.
pub fn resolve_text_preset(id: &str) -> Result<&'static TextPresetSpec, String> {
    let normalized = normalize_pack_id(id);

    TEXT_PRESETS
        .iter()
        .find(|preset| {
            normalize_pack_id(preset.id) == normalized
                || normalize_pack_id(preset.name) == normalized
                || preset
                    .aliases
                    .iter()
                    .any(|alias| normalize_pack_id(alias) == normalized)
        })
        .ok_or_else(|| {
            format!(
                "Unknown text preset '{}'. Valid presets: {}",
                id.trim(),
                text_preset_ids().join(", ")
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_id_is_unique_and_hyphenated() {
        let mut seen = std::collections::HashSet::new();
        for preset in TEXT_PRESETS {
            assert!(
                seen.insert(preset.id),
                "duplicate preset id '{}'",
                preset.id
            );
            assert!(
                preset
                    .id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "preset id '{}' must be lowercase kebab-case",
                preset.id
            );
        }
    }

    #[test]
    fn the_catalog_holds_every_ported_preset() {
        assert_eq!(
            TEXT_PRESETS.len(),
            22,
            "the catalog is the union of the former CLI, prose, and UI lists"
        );
    }

    #[test]
    fn resolve_accepts_separator_and_case_variants() {
        for preset in TEXT_PRESETS {
            let underscored = preset.id.replace('-', "_");
            let spaced = preset.id.replace('-', " ");
            for candidate in [
                preset.id.to_string(),
                underscored,
                spaced,
                preset.id.to_ascii_uppercase(),
                format!("  {}  ", preset.id),
            ] {
                let resolved = resolve_text_preset(&candidate)
                    .unwrap_or_else(|error| panic!("'{candidate}' must resolve: {error}"));
                assert_eq!(resolved.id, preset.id);
            }
        }
    }

    #[test]
    fn every_alias_and_display_name_resolves_to_its_own_preset() {
        for preset in TEXT_PRESETS {
            for key in preset.aliases.iter().copied().chain([preset.name]) {
                let resolved = resolve_text_preset(key)
                    .unwrap_or_else(|error| panic!("key '{key}' must resolve: {error}"));
                assert_eq!(
                    resolved.id, preset.id,
                    "key '{key}' belongs to '{}' but resolved to '{}'",
                    preset.id, resolved.id
                );
            }
        }
    }

    #[test]
    fn no_key_is_claimed_by_two_presets() {
        // An ambiguous alias silently hands the caller a different overlay than
        // the one it named, which is worse than rejecting the alias outright.
        let mut owners: std::collections::HashMap<String, &str> = std::collections::HashMap::new();
        for preset in TEXT_PRESETS {
            for key in preset
                .aliases
                .iter()
                .copied()
                .chain([preset.id, preset.name])
            {
                let normalized = normalize_pack_id(key);
                if let Some(existing) = owners.insert(normalized.clone(), preset.id) {
                    assert_eq!(
                        existing, preset.id,
                        "key '{normalized}' is claimed by both '{existing}' and '{}'",
                        preset.id
                    );
                }
            }
        }
    }

    #[test]
    fn unknown_preset_error_lists_every_valid_id() {
        let error = resolve_text_preset("no-such-preset").expect_err("unknown id must fail");
        for preset in TEXT_PRESETS {
            assert!(
                error.contains(preset.id),
                "error must name '{}': {error}",
                preset.id
            );
        }
    }

    #[test]
    fn every_preset_carries_starter_copy_and_a_usable_duration() {
        for preset in TEXT_PRESETS {
            assert!(
                !preset.default_content.trim().is_empty(),
                "preset '{}' must suggest starter copy",
                preset.id
            );
            assert!(
                preset.default_duration_sec.is_finite() && preset.default_duration_sec > 0.0,
                "preset '{}' must suggest a positive duration",
                preset.id
            );
        }
    }

    #[test]
    fn every_preset_produces_valid_clip_data() {
        for preset in TEXT_PRESETS {
            let clip = preset.default_clip_data();
            clip.validate()
                .unwrap_or_else(|error| panic!("preset '{}' must validate: {error}", preset.id));
            assert_eq!(clip.content, preset.default_content);
            assert_eq!(clip.style.bold, clip.style.font_weight >= 600);
        }
    }

    #[test]
    fn descriptors_round_trip_through_json() {
        for descriptor in list_text_presets() {
            let json = serde_json::to_value(&descriptor).expect("descriptor serializes");
            let parsed: TextPresetDescriptor =
                serde_json::from_value(json).expect("descriptor deserializes");
            assert_eq!(parsed, descriptor);
        }
    }

    #[test]
    fn preset_keys_list_ids_before_aliases_without_duplicates() {
        let keys = text_preset_keys();
        let unique: std::collections::HashSet<_> = keys.iter().collect();
        assert_eq!(unique.len(), keys.len(), "keys must not repeat");
        assert_eq!(&keys[..TEXT_PRESETS.len()], &text_preset_ids()[..]);
    }
}
