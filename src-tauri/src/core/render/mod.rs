//! Render Pipeline Module
//!
//! Handles preview rendering, final export, and the render graph system.
//!
//! # Modules
//!
//! - `export`: Video export engine and settings
//! - `hdr`: HDR workflow support (color spaces, tonemapping, metadata)

pub mod cache;
pub mod executor;
pub(crate) mod export;

/// Version of the renderer's *semantics* — what the compositor and filtergraph
/// do with a given timeline, as opposed to how that timeline is spelled.
///
/// **Bump this on ANY change to compositor or filtergraph math**: transform and
/// motion-keyframe evaluation, chroma handling, picture-in-picture compositing,
/// blend-mode formulas, transition stitching, colour conversion, audio mixing.
/// A cached preview segment records this version in its fingerprint, so a bump
/// invalidates every segment rendered by the previous behaviour.
///
/// It exists because a render cache survives app upgrades while
/// [`graph::RENDER_GRAPH_VERSION`] does not track this: that constant versions
/// the render-graph *schema*, and the four compositor-math changes that landed
/// before this constant existed all left it at 1. Do not overload it for this.
///
/// Starts at 2 so that caches written before this fingerprint existed — which
/// carry no renderer version at all — cannot be mistaken for current ones.
///
/// Bumped to 3 when a ranged render stopped being "the whole timeline's graph
/// with an output-side `-ss`" and became a graph whose own clock starts at the
/// window: every cached segment was rendered by the old shape, and the old shape
/// could land a segment up to half an output frame out of phase.
pub const RENDERER_SEMANTICS_VERSION: u32 = 3;
pub mod ffmpeg_graph;
mod ffmpeg_plan;
pub mod graph;
pub mod hardware;
pub mod hdr;
mod pip_stitch;
pub mod plan;
pub(crate) mod preview_cancel;
mod render_window;
pub mod smart;
mod transform_layout;
pub(crate) mod transition_stitch;

pub use executor::{
    execute_ffmpeg_invocation, execute_ffmpeg_output, FfmpegExecutionResult, FfmpegOutput,
};
pub use export::*;
pub use ffmpeg_graph::{
    build_ffmpeg_invocation_for_render_plan, build_ffmpeg_invocation_from_args, FfmpegInvocation,
    FfmpegInvocationError,
};
pub use graph::{
    build_render_graph, AudioRenderLayer, RenderGraph, VisualRenderLayer, VisualRenderSource,
};
pub use hardware::{
    detect_available_decoders, detect_available_encoders, is_hardware_encoder,
    resolve_best_decoder, resolve_quality_args, resolve_video_encoder, software_encoder_name,
    AvailableDecoders, AvailableEncoders, HardwareAccelMode, HardwareDecoderBackend,
    HardwareDecoderInfo, HardwareEncoderInfo,
};
pub use plan::{
    build_render_plan, RenderPlan, RenderPlanAudioLayer, RenderPlanEffect, RenderPlanValidation,
    RenderPlanVideoLayer, RenderPlanVisualSource,
};

// Render cache re-exports
pub use cache::{
    cache_status_snapshot, classify_segment_window, cleanup_stale_files, clear_sequence_cache,
    compute_plan_segment_fingerprint, compute_profile_hash, compute_window_content_hash,
    enforce_cache_limit, is_cached_segment_name, load_manifest, manifest_for_profile,
    manifest_path, preview_profile_hash, profile_cache_dir, prune_other_profile_caches,
    refresh_manifest_plan_fingerprints, refresh_manifest_segment_flags, render_cache_dir,
    resolve_cached_segment_path, save_manifest, segment_cache_file, sequence_cache_dir,
    CacheSegmentState, CacheSegmentStatusDto, InterruptedRenderPolicy, ManifestForProfile,
    RenderCacheConfig, RenderCacheManifest, RenderCacheSegment, RenderCacheStatus,
    SegmentFingerprint, SegmentFlagReason, SEGMENT_FINGERPRINT_UNSET,
};

// Smart render re-exports
pub use smart::{
    merge_reencode_ranges, plan_smart_render, SegmentAction, SmartRenderPlan, SmartRenderSegment,
};

// HDR re-exports
pub use hdr::{
    build_colorspace_conversion_filter, build_preview_tonemap_filter, build_tonemap_filter,
    detect_hdr_from_metadata, ColorPrimaries, ColorSpace, DetectedHdrInfo, HdrMetadata,
    MasteringDisplayInfo, MatrixCoefficients, TonemapMode, TonemapParams, TransferCharacteristics,
};
