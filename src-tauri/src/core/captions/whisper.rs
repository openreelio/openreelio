//! Whisper Transcription Engine
//!
//! Provides speech-to-text transcription using whisper.cpp via whisper-rs.
//! This module is conditionally compiled when the `whisper` feature is enabled.

use std::path::Path;
use thiserror::Error;

use super::models::Caption;

// =============================================================================
// Error Types
// =============================================================================

/// Errors that can occur during transcription
#[derive(Error, Debug)]
pub enum WhisperError {
    /// Whisper model file not found
    #[error("Model file not found: {0}")]
    ModelNotFound(String),

    /// Failed to load Whisper model
    #[error("Failed to load model: {0}")]
    ModelLoadError(String),

    /// Audio file not found
    #[error("Audio file not found: {0}")]
    AudioNotFound(String),

    /// Failed to read audio samples
    #[error("Failed to read audio: {0}")]
    AudioReadError(String),

    /// Transcription inference failed
    #[error("Transcription failed: {0}")]
    TranscriptionError(String),

    /// Whisper feature not enabled
    #[error("Whisper feature not enabled. Rebuild with --features whisper")]
    FeatureNotEnabled,

    /// Failed to download a Whisper model
    #[error("Model download failed: {0}")]
    ModelDownloadError(String),
}

/// Result type for whisper operations
pub type WhisperResult<T> = Result<T, WhisperError>;

// =============================================================================
// Whisper Model Types
// =============================================================================

/// Available Whisper model sizes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WhisperModel {
    /// Tiny model (~75MB) - fastest, lowest accuracy
    Tiny,
    /// Base model (~142MB) - good balance
    #[default]
    Base,
    /// Small model (~466MB) - better accuracy
    Small,
    /// Medium model (~1.5GB) - high accuracy
    Medium,
    /// Large model (~2.9GB) - highest accuracy
    Large,
    /// Large v3 model (~3.1GB) - highest multilingual accuracy
    LargeV3,
    /// Large v3 Turbo model (~1.6GB) - high quality with faster inference
    LargeV3Turbo,
}

impl WhisperModel {
    /// Returns all supported model variants in UI display order.
    pub fn all() -> &'static [WhisperModel] {
        const MODELS: &[WhisperModel] = &[
            WhisperModel::Tiny,
            WhisperModel::Base,
            WhisperModel::Small,
            WhisperModel::Medium,
            WhisperModel::Large,
            WhisperModel::LargeV3,
            WhisperModel::LargeV3Turbo,
        ];
        MODELS
    }

    /// Returns the filename for this model size
    pub fn filename(&self) -> &'static str {
        match self {
            WhisperModel::Tiny => "ggml-tiny.bin",
            WhisperModel::Base => "ggml-base.bin",
            WhisperModel::Small => "ggml-small.bin",
            WhisperModel::Medium => "ggml-medium.bin",
            WhisperModel::Large => "ggml-large.bin",
            WhisperModel::LargeV3 => "ggml-large-v3.bin",
            WhisperModel::LargeV3Turbo => "ggml-large-v3-turbo.bin",
        }
    }

    /// Returns the model name for logging/display
    pub fn name(&self) -> &'static str {
        match self {
            WhisperModel::Tiny => "tiny",
            WhisperModel::Base => "base",
            WhisperModel::Small => "small",
            WhisperModel::Medium => "medium",
            WhisperModel::Large => "large",
            WhisperModel::LargeV3 => "large-v3",
            WhisperModel::LargeV3Turbo => "large-v3-turbo",
        }
    }

    /// Returns a readable model label for UI and agent surfaces.
    pub fn display_name(&self) -> &'static str {
        match self {
            WhisperModel::Tiny => "Tiny",
            WhisperModel::Base => "Base",
            WhisperModel::Small => "Small",
            WhisperModel::Medium => "Medium",
            WhisperModel::Large => "Large",
            WhisperModel::LargeV3 => "Large v3",
            WhisperModel::LargeV3Turbo => "Large v3 Turbo",
        }
    }

    /// Returns the official whisper.cpp ggml model download URL.
    pub fn download_url(&self) -> &'static str {
        match self {
            WhisperModel::Tiny => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
            }
            WhisperModel::Base => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
            }
            WhisperModel::Small => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
            }
            WhisperModel::Medium => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"
            }
            WhisperModel::Large => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large.bin"
            }
            WhisperModel::LargeV3 => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin"
            }
            WhisperModel::LargeV3Turbo => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
            }
        }
    }

    /// Returns an estimated model size in bytes for UI planning before download.
    pub fn estimated_size_bytes(&self) -> u64 {
        match self {
            WhisperModel::Tiny => 78_000_000,
            WhisperModel::Base => 148_000_000,
            WhisperModel::Small => 488_000_000,
            WhisperModel::Medium => 1_530_000_000,
            WhisperModel::Large => 3_100_000_000,
            WhisperModel::LargeV3 => 3_100_000_000,
            WhisperModel::LargeV3Turbo => 1_620_000_000,
        }
    }

    /// Returns the upstream source repository for this converted ggml model.
    pub fn source(&self) -> &'static str {
        "ggerganov/whisper.cpp"
    }

    /// Returns the upstream license label surfaced to users and agents.
    pub fn license(&self) -> &'static str {
        "MIT"
    }

    /// Returns a quality-first rank used when choosing among already installed models.
    pub fn quality_rank(&self) -> u8 {
        match self {
            WhisperModel::Tiny => 10,
            WhisperModel::Base => 20,
            WhisperModel::Small => 30,
            WhisperModel::Medium => 40,
            WhisperModel::Large => 50,
            WhisperModel::LargeV3Turbo => 60,
            WhisperModel::LargeV3 => 70,
        }
    }

    /// Returns the model OpenReelio recommends when a user has not installed one yet.
    pub fn recommended_default() -> WhisperModel {
        WhisperModel::LargeV3Turbo
    }

    /// Returns true when this model file exists and is non-empty in the given directory.
    pub fn is_installed_in(&self, models_dir: &Path) -> bool {
        std::fs::metadata(models_dir.join(self.filename()))
            .map(|metadata| metadata.is_file() && metadata.len() > 0)
            .unwrap_or(false)
    }

    /// Selects the highest-quality installed model in the given directory.
    pub fn best_installed_in(models_dir: &Path) -> Option<WhisperModel> {
        WhisperModel::all()
            .iter()
            .copied()
            .filter(|model| model.is_installed_in(models_dir))
            .max_by_key(WhisperModel::quality_rank)
    }

    /// Selects the default model for a directory, preferring the best installed model.
    pub fn default_for_dir(models_dir: &Path) -> WhisperModel {
        WhisperModel::best_installed_in(models_dir)
            .unwrap_or_else(WhisperModel::recommended_default)
    }

    /// Resolves an optional user model selection.
    ///
    /// `auto`, `default`, `best`, empty, or omitted values use the best installed
    /// model, falling back to the recommended install candidate when none exist.
    pub fn resolve_requested_or_default(
        requested: Option<&str>,
        models_dir: &Path,
    ) -> WhisperResult<WhisperModel> {
        let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(WhisperModel::default_for_dir(models_dir));
        };

        match requested.to_lowercase().as_str() {
            "auto" | "default" | "best" => Ok(WhisperModel::default_for_dir(models_dir)),
            _ => requested.parse(),
        }
    }
}

impl std::str::FromStr for WhisperModel {
    type Err = WhisperError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "tiny" => Ok(WhisperModel::Tiny),
            "base" => Ok(WhisperModel::Base),
            "small" => Ok(WhisperModel::Small),
            "medium" => Ok(WhisperModel::Medium),
            "large" => Ok(WhisperModel::Large),
            "large-v3" | "largev3" => Ok(WhisperModel::LargeV3),
            "large-v3-turbo" | "largev3turbo" | "turbo" => Ok(WhisperModel::LargeV3Turbo),
            _ => Err(WhisperError::ModelLoadError(format!(
                "Unknown model size: {}",
                s
            ))),
        }
    }
}

// =============================================================================
// Transcription Options
// =============================================================================

/// Options for transcription
#[derive(Debug, Clone)]
pub struct TranscriptionOptions {
    /// Language code (e.g., "en", "ko", "ja") or "auto" for detection
    pub language: Option<String>,
    /// Whether to translate to English
    pub translate: bool,
    /// Number of threads to use (0 = auto)
    pub threads: u32,
    /// Initial prompt to guide the model
    pub initial_prompt: Option<String>,
}

impl Default for TranscriptionOptions {
    fn default() -> Self {
        Self {
            language: Some("auto".to_string()),
            translate: false,
            threads: 0,
            initial_prompt: None,
        }
    }
}

// =============================================================================
// Transcription Result
// =============================================================================

/// A single transcription segment
#[derive(Debug, Clone)]
pub struct TranscriptionSegment {
    /// Start time in seconds
    pub start_time: f64,
    /// End time in seconds
    pub end_time: f64,
    /// Transcribed text
    pub text: String,
}

impl TranscriptionSegment {
    /// Converts this segment to a Caption
    pub fn to_caption(&self) -> Caption {
        Caption::create(self.start_time, self.end_time, &self.text)
    }
}

/// Result of a transcription operation
#[derive(Debug, Clone)]
pub struct TranscriptionResult {
    /// Detected or specified language
    pub language: String,
    /// All transcription segments
    pub segments: Vec<TranscriptionSegment>,
    /// Total duration in seconds
    pub duration: f64,
}

/// Progress snapshot emitted while downloading a local Whisper model.
#[derive(Debug, Clone, Copy)]
pub struct WhisperModelDownloadProgress {
    /// Model being downloaded.
    pub model: WhisperModel,
    /// Bytes written to the temporary file.
    pub downloaded_bytes: u64,
    /// Expected total bytes when known.
    pub total_bytes: Option<u64>,
    /// Current stage: preparing, downloading, finalizing, or complete.
    pub stage: &'static str,
}

impl WhisperModelDownloadProgress {
    /// Returns progress as 0-100 when total size is known.
    pub fn percent(&self) -> Option<f32> {
        let total = self.total_bytes?;
        if total == 0 {
            return None;
        }
        Some(((self.downloaded_bytes as f64 / total as f64) * 100.0).min(100.0) as f32)
    }
}

impl TranscriptionResult {
    /// Converts all segments to Caption objects
    pub fn to_captions(&self) -> Vec<Caption> {
        self.segments.iter().map(|s| s.to_caption()).collect()
    }

    /// Gets the full text of the transcription
    pub fn full_text(&self) -> String {
        self.segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Normalizes ASR segments for readable subtitle cues without requiring word timestamps.
pub fn subtitle_ready_segments(segments: &[TranscriptionSegment]) -> Vec<TranscriptionSegment> {
    const MAX_CHARS_PER_CUE: usize = 64;
    const MAX_CUE_DURATION_SEC: f64 = 6.0;
    const MIN_SPLIT_DURATION_SEC: f64 = 1.2;

    let mut output = Vec::new();
    for segment in segments {
        let text = segment.text.trim();
        if text.is_empty() || segment.end_time <= segment.start_time {
            continue;
        }

        let duration = segment.end_time - segment.start_time;
        let should_split =
            text.chars().count() > MAX_CHARS_PER_CUE || duration > MAX_CUE_DURATION_SEC;
        if !should_split || duration < MIN_SPLIT_DURATION_SEC * 2.0 {
            output.push(TranscriptionSegment {
                start_time: segment.start_time,
                end_time: segment.end_time,
                text: text.to_string(),
            });
            continue;
        }

        let max_chunks_by_duration = (duration / MIN_SPLIT_DURATION_SEC).floor().max(1.0) as usize;
        let chunks = split_subtitle_text(text, MAX_CHARS_PER_CUE, max_chunks_by_duration);
        if chunks.len() <= 1 {
            output.push(TranscriptionSegment {
                start_time: segment.start_time,
                end_time: segment.end_time,
                text: text.to_string(),
            });
            continue;
        }

        let total_chars = chunks
            .iter()
            .map(|chunk| chunk.chars().count().max(1))
            .sum::<usize>() as f64;
        let mut cursor = segment.start_time;
        for (index, chunk) in chunks.iter().enumerate() {
            let end_time = if index == chunks.len() - 1 {
                segment.end_time
            } else {
                let share = chunk.chars().count().max(1) as f64 / total_chars;
                (cursor + duration * share).min(segment.end_time)
            };
            output.push(TranscriptionSegment {
                start_time: cursor,
                end_time,
                text: chunk.clone(),
            });
            cursor = end_time;
        }
    }

    output
}

fn split_subtitle_text(text: &str, max_chars: usize, max_chunks: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();

    for token in subtitle_split_tokens(text) {
        let pending_len = current.chars().count()
            + token.chars().count()
            + usize::from(!current.is_empty() && !is_punctuation_token(&token));
        if !current.is_empty() && pending_len > max_chars && chunks.len() + 1 < max_chunks {
            chunks.push(current.trim().to_string());
            current.clear();
        }

        if !current.is_empty() && !is_punctuation_token(&token) {
            current.push(' ');
        }
        current.push_str(&token);
    }

    if !current.trim().is_empty() {
        chunks.push(current.trim().to_string());
    }

    if chunks.is_empty() {
        return vec![text.to_string()];
    }
    chunks
}

fn subtitle_split_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else if matches!(
            ch,
            '.' | ',' | '?' | '!' | ';' | ':' | '。' | '，' | '？' | '！'
        ) {
            current.push(ch);
            tokens.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn is_punctuation_token(token: &str) -> bool {
    token.chars().all(|ch| {
        matches!(
            ch,
            '.' | ',' | '?' | '!' | ';' | ':' | '。' | '，' | '？' | '！'
        )
    })
}

// =============================================================================
// Whisper Engine - Feature-gated Implementation
// =============================================================================

#[cfg(feature = "whisper")]
mod engine_impl {
    use super::*;
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    /// Whisper transcription engine
    pub struct WhisperEngine {
        context: WhisperContext,
        model_name: String,
    }

    impl WhisperEngine {
        /// Creates a new WhisperEngine with the specified model
        ///
        /// # Arguments
        ///
        /// * `model_path` - Path to the Whisper model file (.bin)
        ///
        /// # Example
        ///
        /// ```rust,ignore
        /// let engine = WhisperEngine::new(Path::new("/models/ggml-base.bin"))?;
        /// ```
        pub fn new(model_path: &Path) -> WhisperResult<Self> {
            if !model_path.exists() {
                return Err(WhisperError::ModelNotFound(
                    model_path.to_string_lossy().to_string(),
                ));
            }

            let params = WhisperContextParameters::default();
            let context =
                WhisperContext::new_with_params(model_path.to_str().unwrap_or_default(), params)
                    .map_err(|e| WhisperError::ModelLoadError(e.to_string()))?;

            let model_name = model_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();

            Ok(Self {
                context,
                model_name,
            })
        }

        /// Returns the model name
        pub fn model_name(&self) -> &str {
            &self.model_name
        }

        /// Transcribes audio samples
        ///
        /// # Arguments
        ///
        /// * `samples` - Audio samples as f32 values normalized to [-1.0, 1.0]
        /// * `options` - Transcription options
        ///
        /// # Returns
        ///
        /// Returns a TranscriptionResult with all segments
        pub fn transcribe(
            &self,
            samples: &[f32],
            options: &TranscriptionOptions,
        ) -> WhisperResult<TranscriptionResult> {
            // Create whisper state
            let mut state = self
                .context
                .create_state()
                .map_err(|e| WhisperError::TranscriptionError(e.to_string()))?;

            // Configure parameters
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

            // Set language
            if let Some(ref lang) = options.language {
                if lang != "auto" {
                    params.set_language(Some(lang));
                }
            }

            params.set_translate(options.translate);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);

            if options.threads > 0 {
                params.set_n_threads(options.threads as i32);
            }

            if let Some(ref prompt) = options.initial_prompt {
                params.set_initial_prompt(prompt);
            }

            // Run inference
            state
                .full(params, samples)
                .map_err(|e| WhisperError::TranscriptionError(e.to_string()))?;

            // Extract segments using the new iterator API (whisper-rs 0.15+)
            let mut segments = Vec::new();

            for segment in state.as_iter() {
                // Timestamps are in centiseconds (10ms units), convert to seconds
                let start = segment.start_timestamp() as f64 / 100.0;
                let end = segment.end_timestamp() as f64 / 100.0;
                let text = segment.to_string();

                segments.push(TranscriptionSegment {
                    start_time: start,
                    end_time: end,
                    text: text.trim().to_string(),
                });
            }

            // Get detected language (fallback to specified or "unknown")
            let language = options
                .language
                .clone()
                .unwrap_or_else(|| "unknown".to_string());

            // Calculate duration from samples (16kHz)
            let duration = samples.len() as f64 / 16000.0;

            Ok(TranscriptionResult {
                language,
                segments,
                duration,
            })
        }

        /// Transcribes a WAV file
        ///
        /// # Arguments
        ///
        /// * `wav_path` - Path to the WAV file (must be 16kHz mono)
        /// * `options` - Transcription options
        ///
        /// # Returns
        ///
        /// Returns a TranscriptionResult with all segments
        pub fn transcribe_file(
            &self,
            wav_path: &Path,
            options: &TranscriptionOptions,
        ) -> WhisperResult<TranscriptionResult> {
            if !wav_path.exists() {
                return Err(WhisperError::AudioNotFound(
                    wav_path.to_string_lossy().to_string(),
                ));
            }

            // Load audio samples
            let samples = super::super::audio::load_audio_samples(wav_path)
                .map_err(|e| WhisperError::AudioReadError(e.to_string()))?;

            self.transcribe(&samples, options)
        }
    }
}

#[cfg(feature = "whisper")]
pub use engine_impl::WhisperEngine;

// =============================================================================
// Stub Implementation (when whisper feature is disabled)
// =============================================================================

#[cfg(not(feature = "whisper"))]
#[derive(Debug)]
pub struct WhisperEngine;

#[cfg(not(feature = "whisper"))]
impl WhisperEngine {
    /// Creates a new WhisperEngine (stub - returns error)
    pub fn new(_model_path: &Path) -> WhisperResult<Self> {
        Err(WhisperError::FeatureNotEnabled)
    }

    /// Returns the model name (stub)
    pub fn model_name(&self) -> &str {
        ""
    }

    /// Transcribes audio samples (stub - returns error)
    pub fn transcribe(
        &self,
        _samples: &[f32],
        _options: &TranscriptionOptions,
    ) -> WhisperResult<TranscriptionResult> {
        Err(WhisperError::FeatureNotEnabled)
    }

    /// Transcribes a WAV file (stub - returns error)
    pub fn transcribe_file(
        &self,
        _wav_path: &Path,
        _options: &TranscriptionOptions,
    ) -> WhisperResult<TranscriptionResult> {
        Err(WhisperError::FeatureNotEnabled)
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Checks if whisper transcription is available
pub fn is_whisper_available() -> bool {
    cfg!(feature = "whisper")
}

/// Returns the recommended model directory
pub fn default_models_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("openreelio")
        .join("models")
        .join("whisper")
}

#[cfg(feature = "whisper")]
/// Downloads a converted whisper.cpp ggml model into the default local model directory.
pub fn download_whisper_model_blocking<F>(
    model: WhisperModel,
    overwrite: bool,
    mut on_progress: F,
) -> WhisperResult<std::path::PathBuf>
where
    F: FnMut(WhisperModelDownloadProgress),
{
    use std::io::{Read, Write};
    use std::time::Duration;

    let models_dir = default_models_dir();
    std::fs::create_dir_all(&models_dir).map_err(|error| {
        WhisperError::ModelDownloadError(format!(
            "Failed to create model directory {}: {error}",
            models_dir.display()
        ))
    })?;

    let destination = models_dir.join(model.filename());
    if destination.exists() && !overwrite {
        let size = std::fs::metadata(&destination)
            .ok()
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if size > 0 {
            on_progress(WhisperModelDownloadProgress {
                model,
                downloaded_bytes: size,
                total_bytes: Some(size),
                stage: "complete",
            });
            return Ok(destination);
        }
    }

    on_progress(WhisperModelDownloadProgress {
        model,
        downloaded_bytes: 0,
        total_bytes: Some(model.estimated_size_bytes()),
        stage: "preparing",
    });

    let part_path = models_dir.join(format!(".{}.part", model.filename()));
    if part_path.exists() {
        std::fs::remove_file(&part_path).map_err(|error| {
            WhisperError::ModelDownloadError(format!(
                "Failed to remove stale partial download {}: {error}",
                part_path.display()
            ))
        })?;
    }

    struct PartialDownloadGuard(std::path::PathBuf, bool);
    impl PartialDownloadGuard {
        fn keep(&mut self) {
            self.1 = true;
        }
    }
    impl Drop for PartialDownloadGuard {
        fn drop(&mut self) {
            if !self.1 {
                let _ = std::fs::remove_file(&self.0);
            }
        }
    }
    let mut guard = PartialDownloadGuard(part_path.clone(), false);

    let client = reqwest::blocking::Client::builder()
        .user_agent(format!(
            "OpenReelio/{} model-manager",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| WhisperError::ModelDownloadError(error.to_string()))?;

    let mut response = client
        .get(model.download_url())
        .send()
        .map_err(|error| WhisperError::ModelDownloadError(error.to_string()))?;

    if !response.status().is_success() {
        return Err(WhisperError::ModelDownloadError(format!(
            "Download request failed with HTTP status {}",
            response.status()
        )));
    }

    let content_length = response.content_length();
    let total_bytes = content_length.or(Some(model.estimated_size_bytes()));
    let mut output = std::fs::File::create(&part_path).map_err(|error| {
        WhisperError::ModelDownloadError(format!(
            "Failed to create partial model file {}: {error}",
            part_path.display()
        ))
    })?;

    let mut downloaded_bytes = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| WhisperError::ModelDownloadError(error.to_string()))?;
        if read == 0 {
            break;
        }

        output
            .write_all(&buffer[..read])
            .map_err(|error| WhisperError::ModelDownloadError(error.to_string()))?;
        downloaded_bytes += read as u64;
        on_progress(WhisperModelDownloadProgress {
            model,
            downloaded_bytes,
            total_bytes,
            stage: "downloading",
        });
    }

    if downloaded_bytes == 0 {
        return Err(WhisperError::ModelDownloadError(
            "Downloaded model file is empty".to_string(),
        ));
    }

    if let Some(expected) = content_length {
        if downloaded_bytes != expected {
            return Err(WhisperError::ModelDownloadError(format!(
                "Downloaded {} bytes but expected {} bytes",
                downloaded_bytes, expected
            )));
        }
    }

    output
        .sync_all()
        .map_err(|error| WhisperError::ModelDownloadError(error.to_string()))?;
    drop(output);

    on_progress(WhisperModelDownloadProgress {
        model,
        downloaded_bytes,
        total_bytes: Some(downloaded_bytes),
        stage: "finalizing",
    });

    if destination.exists() {
        if overwrite {
            std::fs::remove_file(&destination).map_err(|error| {
                WhisperError::ModelDownloadError(format!(
                    "Failed to replace existing model {}: {error}",
                    destination.display()
                ))
            })?;
        } else {
            return Err(WhisperError::ModelDownloadError(format!(
                "Model already exists at {}",
                destination.display()
            )));
        }
    }

    std::fs::rename(&part_path, &destination).map_err(|error| {
        WhisperError::ModelDownloadError(format!(
            "Failed to finalize model file {}: {error}",
            destination.display()
        ))
    })?;
    guard.keep();

    on_progress(WhisperModelDownloadProgress {
        model,
        downloaded_bytes,
        total_bytes: Some(downloaded_bytes),
        stage: "complete",
    });

    Ok(destination)
}

#[cfg(not(feature = "whisper"))]
/// Stub for builds without local Whisper support.
pub fn download_whisper_model_blocking<F>(
    _model: WhisperModel,
    _overwrite: bool,
    _on_progress: F,
) -> WhisperResult<std::path::PathBuf>
where
    F: FnMut(WhisperModelDownloadProgress),
{
    Err(WhisperError::FeatureNotEnabled)
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_whisper_model_filename() {
        assert_eq!(WhisperModel::Tiny.filename(), "ggml-tiny.bin");
        assert_eq!(WhisperModel::Base.filename(), "ggml-base.bin");
        assert_eq!(WhisperModel::Large.filename(), "ggml-large.bin");
        assert_eq!(WhisperModel::LargeV3.filename(), "ggml-large-v3.bin");
        assert_eq!(
            WhisperModel::LargeV3Turbo.filename(),
            "ggml-large-v3-turbo.bin"
        );
    }

    #[test]
    fn test_whisper_model_all_includes_supported_models() {
        let names: Vec<&str> = WhisperModel::all().iter().map(WhisperModel::name).collect();
        assert_eq!(
            names,
            vec![
                "tiny",
                "base",
                "small",
                "medium",
                "large",
                "large-v3",
                "large-v3-turbo"
            ]
        );
    }

    #[test]
    fn test_whisper_model_from_str() {
        assert_eq!("tiny".parse::<WhisperModel>().unwrap(), WhisperModel::Tiny);
        assert_eq!("BASE".parse::<WhisperModel>().unwrap(), WhisperModel::Base);
        assert_eq!(
            "Medium".parse::<WhisperModel>().unwrap(),
            WhisperModel::Medium
        );
        assert_eq!(
            "large-v3".parse::<WhisperModel>().unwrap(),
            WhisperModel::LargeV3
        );
        assert_eq!(
            "large-v3-turbo".parse::<WhisperModel>().unwrap(),
            WhisperModel::LargeV3Turbo
        );
        assert_eq!(
            "turbo".parse::<WhisperModel>().unwrap(),
            WhisperModel::LargeV3Turbo
        );
        assert!("invalid".parse::<WhisperModel>().is_err());
    }

    #[test]
    fn test_whisper_model_download_metadata() {
        assert_eq!(
            WhisperModel::Base.download_url(),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
        );
        assert!(WhisperModel::LargeV3Turbo
            .download_url()
            .ends_with("ggml-large-v3-turbo.bin"));
        assert!(WhisperModel::Base.estimated_size_bytes() > 100_000_000);
        assert_eq!(WhisperModel::Base.source(), "ggerganov/whisper.cpp");
        assert_eq!(WhisperModel::Base.license(), "MIT");
    }

    #[test]
    fn test_whisper_model_default_prefers_best_installed() {
        let temp_dir = tempfile::tempdir().unwrap();
        std::fs::write(temp_dir.path().join(WhisperModel::Base.filename()), b"base").unwrap();
        std::fs::write(
            temp_dir.path().join(WhisperModel::Small.filename()),
            b"small",
        )
        .unwrap();
        std::fs::write(
            temp_dir.path().join(WhisperModel::LargeV3Turbo.filename()),
            b"turbo",
        )
        .unwrap();

        assert_eq!(
            WhisperModel::best_installed_in(temp_dir.path()),
            Some(WhisperModel::LargeV3Turbo)
        );
        assert_eq!(
            WhisperModel::default_for_dir(temp_dir.path()),
            WhisperModel::LargeV3Turbo
        );
    }

    #[test]
    fn test_whisper_model_default_uses_recommended_when_none_installed() {
        let temp_dir = tempfile::tempdir().unwrap();

        assert_eq!(WhisperModel::best_installed_in(temp_dir.path()), None);
        assert_eq!(
            WhisperModel::default_for_dir(temp_dir.path()),
            WhisperModel::LargeV3Turbo
        );
        assert_eq!(
            WhisperModel::resolve_requested_or_default(Some("auto"), temp_dir.path()).unwrap(),
            WhisperModel::LargeV3Turbo
        );
    }

    #[test]
    fn test_transcription_options_default() {
        let options = TranscriptionOptions::default();
        assert_eq!(options.language, Some("auto".to_string()));
        assert!(!options.translate);
        assert_eq!(options.threads, 0);
        assert!(options.initial_prompt.is_none());
    }

    #[test]
    fn test_transcription_segment_to_caption() {
        let segment = TranscriptionSegment {
            start_time: 1.5,
            end_time: 3.0,
            text: "Hello world".to_string(),
        };

        let caption = segment.to_caption();
        assert_eq!(caption.start_sec, 1.5);
        assert_eq!(caption.end_sec, 3.0);
        assert_eq!(caption.text, "Hello world");
    }

    #[test]
    fn test_transcription_result_full_text() {
        let result = TranscriptionResult {
            language: "en".to_string(),
            segments: vec![
                TranscriptionSegment {
                    start_time: 0.0,
                    end_time: 1.0,
                    text: "Hello".to_string(),
                },
                TranscriptionSegment {
                    start_time: 1.0,
                    end_time: 2.0,
                    text: "world".to_string(),
                },
            ],
            duration: 2.0,
        };

        assert_eq!(result.full_text(), "Hello world");
    }

    #[test]
    fn test_transcription_result_to_captions() {
        let result = TranscriptionResult {
            language: "en".to_string(),
            segments: vec![
                TranscriptionSegment {
                    start_time: 0.0,
                    end_time: 1.0,
                    text: "First".to_string(),
                },
                TranscriptionSegment {
                    start_time: 1.0,
                    end_time: 2.0,
                    text: "Second".to_string(),
                },
            ],
            duration: 2.0,
        };

        let captions = result.to_captions();
        assert_eq!(captions.len(), 2);
        assert_eq!(captions[0].text, "First");
        assert_eq!(captions[1].text, "Second");
    }

    #[test]
    fn test_subtitle_ready_segments_splits_long_segments() {
        let segments = subtitle_ready_segments(&[TranscriptionSegment {
            start_time: 0.0,
            end_time: 8.0,
            text: "This is a long sentence that should be split into multiple readable subtitle cues for display.".to_string(),
        }]);

        assert!(segments.len() > 1);
        assert_eq!(segments.first().unwrap().start_time, 0.0);
        assert_eq!(segments.last().unwrap().end_time, 8.0);
        assert!(segments
            .iter()
            .all(|segment| !segment.text.trim().is_empty()));
    }

    #[test]
    fn test_is_whisper_available() {
        // This will be true or false depending on feature flag
        let available = is_whisper_available();
        #[cfg(feature = "whisper")]
        assert!(available);
        #[cfg(not(feature = "whisper"))]
        assert!(!available);
    }

    #[test]
    fn test_default_models_dir() {
        let dir = default_models_dir();
        assert!(dir.to_string_lossy().contains("whisper"));
    }

    #[cfg(not(feature = "whisper"))]
    #[test]
    fn test_whisper_engine_stub_returns_error() {
        let result = WhisperEngine::new(Path::new("/some/model.bin"));
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            WhisperError::FeatureNotEnabled
        ));
    }
}
