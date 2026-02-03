//! Effects Module
//!
//! Defines visual and audio effects that can be applied to clips.
//! Includes FFmpeg filter generation for rendering effects.

mod filter_builder;
mod mask_filters;
mod models;
mod qualifier_filters;

pub use filter_builder::{FilterGraph, IntoFFmpegFilter};
pub use mask_filters::{
    apply_effect_through_mask, mask_group_to_alpha_expression, mask_to_alpha_filter,
    MaskFilterBuilder,
};
pub use models::*;
pub use qualifier_filters::{
    build_qualified_mask_filter, build_qualifier_alpha_expression, build_qualifier_filter,
    build_qualifier_preview_filter, ColorAdjustments, QualifierParams,
};
