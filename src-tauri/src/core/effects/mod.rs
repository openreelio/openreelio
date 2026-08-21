//! Effects Module
//!
//! Defines visual and audio effects that can be applied to clips.
//! Includes FFmpeg filter generation for rendering effects.

mod capabilities;
mod filter_builder;
pub mod gpu_filters;
mod mask_filters;
mod models;
pub mod presets;
mod qualifier_filters;

pub use capabilities::{
    all_effect_capabilities, effect_capability, effect_capability_dto, effect_type_label,
    effect_type_supports_export, effect_type_supports_timeline_enable, EffectCapability,
    EffectCapabilityDto, EffectRuntimeSupport,
};
/// Canonical filtergraph escapers, shared with the render pipeline and the IPC
/// commands that build filter strings outside of the effect builders.
// Some consumers live in `ipc::commands`, which is compiled with
// `cfg(all(not(test), feature = "gui"))`, so these re-exports have no user in a
// test build even though the underlying functions are exercised by unit tests.
#[allow(unused_imports)]
pub(crate) use filter_builder::{
    build_vidstabdetect_filter, escape_ffmpeg_filter_path, escape_ffmpeg_filter_value,
    BRANCH_OFFSET_PARAM,
};
pub use filter_builder::{FilterGraph, IntoFFmpegFilter};
pub use gpu_filters::{GpuFilterBackend, GpuFilterContext};
pub use mask_filters::{
    apply_effect_through_mask, mask_group_to_alpha_expression, mask_to_alpha_filter,
    MaskFilterBuilder,
};
pub use models::*;
pub use qualifier_filters::{
    build_qualified_mask_filter, build_qualifier_alpha_expression, build_qualifier_filter,
    build_qualifier_preview_filter, ColorAdjustments, QualifierParams,
};
