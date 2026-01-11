//! Built-in Asset Providers
//!
//! Provides native implementations of asset providers that don't require WASM plugins.
//! These are included by default and provide basic functionality.

pub mod audio;
pub mod meme;
pub mod stock;

pub use audio::AudioLibraryProvider;
pub use meme::MemePackProvider;
pub use stock::StockMediaProvider;
