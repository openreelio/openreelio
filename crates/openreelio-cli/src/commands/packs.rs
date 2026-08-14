//! Curated style pack listing.
//!
//! Packs are the quality floor for captions, transitions, and text overlays: a
//! named, hand-checked style beats a guessed one, and the id is the whole
//! payload. This verb is the discovery half of that — the same `const` tables
//! that validate a `--style-pack`, a `recipe`, or a `--preset` are what it
//! prints, so a listed id is by construction an accepted id.

use clap::{Subcommand, ValueEnum};
use openreelio_core::style::{list_caption_packs, list_text_presets, list_transition_recipes};
use serde_json::Value;

use crate::output;

/// Which registry `packs list` should print.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
pub enum PackKind {
    /// Caption style packs only.
    Caption,
    /// Transition recipes only.
    Transition,
    /// Text overlay presets only.
    Text,
    /// Every registry.
    #[default]
    All,
}

impl PackKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Caption => "caption",
            Self::Transition => "transition",
            Self::Text => "text",
            Self::All => "all",
        }
    }
}

#[derive(Subcommand)]
pub enum PacksAction {
    /// List curated caption style packs, transition recipes, and text presets
    List {
        /// Which registry to list: caption, transition, text, or all
        #[arg(long, value_enum, default_value_t = PackKind::All)]
        kind: PackKind,
    },
}

pub fn execute(action: PacksAction) -> anyhow::Result<()> {
    match action {
        PacksAction::List { kind } => {
            let mut packs: Vec<Value> = Vec::new();

            if matches!(kind, PackKind::Caption | PackKind::All) {
                for descriptor in list_caption_packs() {
                    packs.push(serde_json::to_value(descriptor).map_err(|error| {
                        anyhow::anyhow!("Failed to serialize caption pack: {}", error)
                    })?);
                }
            }

            if matches!(kind, PackKind::Transition | PackKind::All) {
                for descriptor in list_transition_recipes() {
                    packs.push(serde_json::to_value(descriptor).map_err(|error| {
                        anyhow::anyhow!("Failed to serialize transition recipe: {}", error)
                    })?);
                }
            }

            if matches!(kind, PackKind::Text | PackKind::All) {
                for descriptor in list_text_presets() {
                    packs.push(serde_json::to_value(descriptor).map_err(|error| {
                        anyhow::anyhow!("Failed to serialize text preset: {}", error)
                    })?);
                }
            }

            output::print_json_pretty(&serde_json::json!({
                "status": "ok",
                "kind": kind.as_str(),
                "count": packs.len(),
                "packs": packs,
            }))
        }
    }
}
