//! OpenReelio Plugin System
//!
//! WASM-based plugin ecosystem for extending functionality.
//! Provides secure sandboxed execution with granular permissions.

pub mod api;
pub mod context;
pub mod host;
pub mod manifest;
pub mod permission;
pub mod providers;

// Re-export main types
pub use api::{
    AssetProviderPlugin, CaptionStyleProviderPlugin, EditAssistantPlugin, EditContext,
    EditSuggestion, EffectPresetProviderPlugin, PluginAssetRef, PluginAssetType,
    PluginCaptionStyle, PluginEffectPreset, PluginFetchedAsset, PluginSearchQuery,
    PluginTemplate, TemplatePlaceholder, TemplateProviderPlugin,
};
pub use context::PluginContext;
pub use host::{LoadedPlugin, PluginHost, PluginHostConfig, PluginInfo, PluginState};
pub use manifest::{PluginCapability, PluginManifest, PluginPermissions};
pub use permission::{Permission, PermissionManager, PermissionScope, PermissionStatus};
pub use providers::{AudioLibraryProvider, MemePackProvider, StockMediaProvider};
