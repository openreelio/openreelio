//! Built-in Asset Providers
//!
//! Provides native implementations of asset providers that don't require WASM plugins.
//! These are included by default and provide basic functionality.

pub mod meme;
pub mod stock;
pub mod audio;

pub use meme::MemePackProvider;
pub use stock::StockMediaProvider;
pub use audio::AudioLibraryProvider;
