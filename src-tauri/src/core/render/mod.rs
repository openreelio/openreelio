//! Render Pipeline Module
//!
//! Handles preview rendering, final export, and the render graph system.
//!
//! # Modules
//!
//! - `export`: Video export engine and settings
//! - `hdr`: HDR workflow support (color spaces, tonemapping, metadata)

mod export;
pub mod hdr;

pub use export::*;

// HDR re-exports
pub use hdr::{
    build_colorspace_conversion_filter, build_preview_tonemap_filter, build_tonemap_filter,
    detect_hdr_from_metadata, ColorPrimaries, ColorSpace, DetectedHdrInfo, HdrMetadata,
    MasteringDisplayInfo, MatrixCoefficients, TonemapMode, TonemapParams, TransferCharacteristics,
};
