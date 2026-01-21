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
}

impl WhisperModel {
    /// Returns the filename for this model size
    pub fn filename(&self) -> &'static str {
        match self {
            WhisperModel::Tiny => "ggml-tiny.bin",
            WhisperModel::Base => "ggml-base.bin",
            WhisperModel::Small => "ggml-small.bin",
            WhisperModel::Medium => "ggml-medium.bin",
            WhisperModel::Large => "ggml-large.bin",
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

            // Extract segments
            let num_segments = state
                .full_n_segments()
                .map_err(|e| WhisperError::TranscriptionError(e.to_string()))?;

            let mut segments = Vec::with_capacity(num_segments as usize);

            for i in 0..num_segments {
                let start = state
                    .full_get_segment_t0(i)
                    .map_err(|e| WhisperError::TranscriptionError(e.to_string()))?
                    as f64
                    / 100.0;
                let end = state
                    .full_get_segment_t1(i)
                    .map_err(|e| WhisperError::TranscriptionError(e.to_string()))?
                    as f64
                    / 100.0;
                let text = state
                    .full_get_segment_text(i)
                    .map_err(|e| WhisperError::TranscriptionError(e.to_string()))?;

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
    }

    #[test]
    fn test_whisper_model_from_str() {
        assert_eq!("tiny".parse::<WhisperModel>().unwrap(), WhisperModel::Tiny);
        assert_eq!("BASE".parse::<WhisperModel>().unwrap(), WhisperModel::Base);
        assert_eq!(
            "Medium".parse::<WhisperModel>().unwrap(),
            WhisperModel::Medium
        );
        assert!("invalid".parse::<WhisperModel>().is_err());
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
