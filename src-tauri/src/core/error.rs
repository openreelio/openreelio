//! OpenReelio Error Definitions
//!
//! Defines error types used throughout the project.

use thiserror::Error;

use super::{AssetId, ClipId, EffectId, OpId, SequenceId, TimeSec, TrackId};

/// Core engine error types
#[derive(Error, Debug)]
pub enum CoreError {
    // =========================================================================
    // Project Errors
    // =========================================================================
    #[error("Project not found: {0}")]
    ProjectNotFound(String),

    #[error("Project already open")]
    ProjectAlreadyOpen,

    #[error("Project file corrupted: {0}")]
    ProjectCorrupted(String),

    #[error("Failed to save project: {0}")]
    ProjectSaveFailed(String),

    // =========================================================================
    // Asset Errors
    // =========================================================================
    #[error("Asset not found: {0}")]
    AssetNotFound(AssetId),

    #[error("Asset in use: {0}")]
    AssetInUse(AssetId),

    #[error("Asset import failed: {0}")]
    AssetImportFailed(String),

    #[error("Unsupported asset format: {0}")]
    UnsupportedAssetFormat(String),

    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("FFprobe error: {0}")]
    FFprobeError(String),

    // =========================================================================
    // Timeline Errors
    // =========================================================================
    #[error("Clip not found: {0}")]
    ClipNotFound(ClipId),

    #[error("Track not found: {0}")]
    TrackNotFound(TrackId),

    #[error("Sequence not found: {0}")]
    SequenceNotFound(SequenceId),

    #[error("Invalid split point: {0} seconds")]
    InvalidSplitPoint(TimeSec),

    #[error("Invalid time range: {0}~{1} seconds")]
    InvalidTimeRange(TimeSec, TimeSec),

    #[error("Clip conflict: another clip exists at this position")]
    ClipConflict,

    #[error(
        "Clip overlap on track {track_id}: {new_start:.3}~{new_end:.3}s conflicts with clip {existing_clip_id}"
    )]
    ClipOverlap {
        track_id: TrackId,
        existing_clip_id: ClipId,
        new_start: TimeSec,
        new_end: TimeSec,
    },

    // =========================================================================
    // Effect Errors
    // =========================================================================
    #[error("Effect not found: {0}")]
    EffectNotFound(EffectId),

    #[error("Invalid effect parameters: {0}")]
    InvalidEffectParams(String),

    // =========================================================================
    // Command Errors
    // =========================================================================
    #[error("Invalid command: {0}")]
    InvalidCommand(String),

    #[error("Command execution failed: {0}")]
    CommandExecutionFailed(String),

    #[error("Operation not found: {0}")]
    OperationNotFound(OpId),

    #[error("Nothing to undo")]
    NothingToUndo,

    #[error("Nothing to redo")]
    NothingToRedo,

    // =========================================================================
    // Render Errors
    // =========================================================================
    #[error("Render failed: {0}")]
    RenderFailed(String),

    #[error("Proxy generation failed: {0}")]
    ProxyGenerationFailed(String),

    // =========================================================================
    // AI Errors
    // =========================================================================
    #[error("AI request failed: {0}")]
    AIRequestFailed(String),

    #[error("Proposal not found: {0}")]
    ProposalNotFound(String),

    // =========================================================================
    // Plugin Errors
    // =========================================================================
    #[error("Plugin error: {0}")]
    PluginError(String),

    #[error("Plugin not found: {0}")]
    PluginNotFound(String),

    #[error("Plugin already loaded: {0}")]
    PluginAlreadyLoaded(String),

    #[error("Invalid plugin manifest: {0}")]
    InvalidPluginManifest(String),

    #[error("Plugin execution failed: {0}")]
    PluginExecutionFailed(String),

    #[error("Plugin timeout: {0}")]
    PluginTimeout(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    // =========================================================================
    // General Errors
    // =========================================================================
    #[error("Not supported: {0}")]
    NotSupported(String),

    #[error("Validation error: {0}")]
    ValidationError(String),

    #[error("Resource exhausted: {0}")]
    ResourceExhausted(String),

    #[error("Timeout: {0}")]
    Timeout(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("JSON parsing error: {0}")]
    JsonError(#[from] serde_json::Error),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("No project open")]
    NoProjectOpen,

    #[error("Not found: {0}")]
    NotFound(String),
}

/// Core engine result type
pub type CoreResult<T> = Result<T, CoreError>;

impl CoreError {
    /// Convert to a user-friendly error message for IPC
    pub fn to_ipc_error(&self) -> String {
        self.to_string()
    }
}
