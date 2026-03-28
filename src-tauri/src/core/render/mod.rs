//! Render Pipeline Module
//!
//! Handles preview rendering, final export, and the render graph system.
//!
//! # Modules
//!
//! - `export`: Video export engine and settings
//! - `hdr`: HDR workflow support (color spaces, tonemapping, metadata)

pub mod cache;
mod export;
pub mod hardware;
pub mod hdr;
pub mod smart;

pub use export::*;
pub use hardware::{
    detect_available_decoders, detect_available_encoders, is_hardware_encoder,
    resolve_best_decoder, resolve_quality_args, resolve_video_encoder, software_encoder_name,
    AvailableDecoders, AvailableEncoders, HardwareAccelMode, HardwareDecoderBackend,
    HardwareDecoderInfo, HardwareEncoderInfo,
};

// Render cache re-exports
pub use cache::{
    cleanup_stale_files, clear_sequence_cache, compute_segment_fingerprint, enforce_cache_limit,
    load_manifest, manifest_path, render_cache_dir, save_manifest, segment_cache_file,
    sequence_cache_dir, CacheSegmentState, CacheSegmentStatusDto, RenderCacheConfig,
    RenderCacheManifest, RenderCacheSegment, RenderCacheStatus, SegmentFingerprint,
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
