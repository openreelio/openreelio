//! Whisper Transcription Engine
//!
//! Provides speech-to-text transcription using whisper.cpp via whisper-rs.
//! This module is conditionally compiled when the `whisper` feature is enabled.

use std::path::Path;

use serde::{Deserialize, Serialize};
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
    /// Large v3 Turbo quantized q5_0 (~574MB) - near-turbo accuracy, small download
    LargeV3TurboQ5,
    /// Large v3 Turbo quantized q8_0 (~834MB) - turbo accuracy, lower RAM
    LargeV3TurboQ8,
    /// Large v3 quantized q5_0 (~1.1GB) - large-v3 accuracy, smaller download
    LargeV3Q5,
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
            WhisperModel::LargeV3TurboQ5,
            WhisperModel::LargeV3TurboQ8,
            WhisperModel::LargeV3Q5,
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
            WhisperModel::LargeV3TurboQ5 => "ggml-large-v3-turbo-q5_0.bin",
            WhisperModel::LargeV3TurboQ8 => "ggml-large-v3-turbo-q8_0.bin",
            WhisperModel::LargeV3Q5 => "ggml-large-v3-q5_0.bin",
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
            WhisperModel::LargeV3TurboQ5 => "large-v3-turbo-q5_0",
            WhisperModel::LargeV3TurboQ8 => "large-v3-turbo-q8_0",
            WhisperModel::LargeV3Q5 => "large-v3-q5_0",
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
            WhisperModel::LargeV3TurboQ5 => "Large v3 Turbo (q5_0)",
            WhisperModel::LargeV3TurboQ8 => "Large v3 Turbo (q8_0)",
            WhisperModel::LargeV3Q5 => "Large v3 (q5_0)",
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
            WhisperModel::LargeV3TurboQ5 => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
            }
            WhisperModel::LargeV3TurboQ8 => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin"
            }
            WhisperModel::LargeV3Q5 => {
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin"
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
            WhisperModel::LargeV3TurboQ5 => 574_000_000,
            WhisperModel::LargeV3TurboQ8 => 834_000_000,
            WhisperModel::LargeV3Q5 => 1_100_000_000,
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
        // Ranks encode accuracy priority for "best installed" selection:
        // LargeV3 > LargeV3Q5 > LargeV3Turbo > LargeV3TurboQ8 > LargeV3TurboQ5
        // > Large > Medium > Small > Base > Tiny.
        match self {
            WhisperModel::Tiny => 10,
            WhisperModel::Base => 20,
            WhisperModel::Small => 30,
            WhisperModel::Medium => 40,
            WhisperModel::Large => 50,
            WhisperModel::LargeV3TurboQ5 => 60,
            WhisperModel::LargeV3TurboQ8 => 65,
            WhisperModel::LargeV3Turbo => 70,
            WhisperModel::LargeV3Q5 => 80,
            WhisperModel::LargeV3 => 90,
        }
    }

    /// Returns the model OpenReelio recommends when a user has not installed one yet.
    pub fn recommended_default() -> WhisperModel {
        // Best balance: small download, near-turbo accuracy, lower RAM.
        WhisperModel::LargeV3TurboQ5
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
            "large-v3-turbo-q5_0" | "large-v3-turbo-q5" | "largev3turboq5" => {
                Ok(WhisperModel::LargeV3TurboQ5)
            }
            "large-v3-turbo-q8_0" | "large-v3-turbo-q8" | "largev3turboq8" => {
                Ok(WhisperModel::LargeV3TurboQ8)
            }
            "large-v3-q5_0" | "large-v3-q5" | "largev3q5" => Ok(WhisperModel::LargeV3Q5),
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

/// Word-level timing extracted from Whisper token timestamps.
///
/// Sub-word BPE tokens are merged into whole words; each word carries the real
/// `t0`/`t1` token timing converted to seconds (consistent with the segment
/// `/100.0` centisecond convention).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WordTiming {
    /// The word text.
    ///
    /// Leading whitespace is preserved verbatim because it encodes the original
    /// separator between space-delimited (Latin) words; trailing whitespace is
    /// trimmed. CJK words carry no leading space. Cue text is rebuilt by
    /// concatenating word texts and trimming only the cue ends, so the original
    /// transcript spacing is reproduced without inserting separators.
    pub text: String,
    /// Word start time in seconds.
    pub start_time: f64,
    /// Word end time in seconds.
    pub end_time: f64,
}

/// A single transcription segment
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TranscriptionSegment {
    /// Start time in seconds
    pub start_time: f64,
    /// End time in seconds
    pub end_time: f64,
    /// Transcribed text
    pub text: String,
    /// Optional word-level timings derived from Whisper token timestamps.
    ///
    /// Empty when token timestamps are unavailable; serialization stays
    /// backward-compatible via `#[serde(default)]` so previously persisted
    /// segments without this field still deserialize.
    #[serde(default)]
    pub words: Vec<WordTiming>,
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

/// Maximum characters allowed in a single Latin-dominant subtitle cue.
const MAX_CHARS_PER_CUE: usize = 64;
/// Maximum characters allowed in a single CJK-dominant subtitle cue.
///
/// CJK glyphs are roughly double width, so a much smaller budget keeps cues
/// readable without overflowing a single subtitle line.
const MAX_CHARS_PER_CUE_CJK: usize = 24;
/// Maximum duration (seconds) allowed for a single subtitle cue before splitting.
const MAX_CUE_DURATION_SEC: f64 = 6.0;
/// Minimum on-screen duration (seconds) guaranteed for each split cue.
const MIN_SPLIT_DURATION_SEC: f64 = 1.2;
/// Minimum on-screen duration (seconds) below which a finalized cue is merged
/// into the previous cue to avoid sub-second flicker.
const MIN_CUE_DURATION_FLOOR_SEC: f64 = 0.3;

/// When true, caption cues that contain only non-speech annotations (e.g.
/// `[Music]`, `(music)`, `♪♪`, `[음악]`) are dropped so music passages do not
/// plaster useless captions on the timeline.
///
/// This is a deterministic, language-agnostic filter applied only to caption
/// cues — it never touches the raw transcription or full text. Disable to
/// retain non-speech annotations for SDH (subtitles for the deaf and
/// hard-of-hearing) output.
const DROP_NON_SPEECH_CUES: bool = true;

/// When true, the decoder is told to suppress non-speech tokens (whisper.cpp's
/// `suppress_nst` flag) so it is biased away from emitting `[Music]`/applause
/// annotations at the source.
///
/// Defaults to `false`. Decoder-level NST suppression is deliberately disabled
/// because it is hostile to SUNG vocals: Whisper scores melodic singing close to
/// the non-speech boundary, so enabling it pushes the decoder to emit almost
/// nothing over sung lyrics (e.g. Korean songs transcribing to a handful of
/// English words). The deterministic [`is_non_speech_cue`] cue filter (gated by
/// [`DROP_NON_SPEECH_CUES`] and applied to finalized cues) is the authoritative
/// non-speech guard, which makes decoder-level suppression redundant and
/// harmful. Kept as a tunable const so SDH-style pipelines can re-enable it.
const SUPPRESS_NON_SPEECH_TOKENS: bool = false;

/// Returns a short Korean seed prompt used to bias the decoder toward Hangul
/// orthography when transcribing Korean audio, or `None` for any other language.
///
/// Whisper's decoder can drift toward Latin transliteration for Korean sung or
/// borderline speech. Seeding the decoder with a neutral Korean sentence nudges
/// it toward emitting Hangul. This is a best-effort aid only; the seed is kept
/// minimal and is only applied when no explicit initial prompt was supplied.
fn korean_initial_prompt_seed(language: Option<&str>) -> Option<&'static str> {
    match language {
        // Neutral, common Korean words ("Hello. Today the weather is nice.")
        // chosen purely to anchor the decoder on Hangul, not on any content.
        Some("ko") => Some("안녕하세요. 오늘 날씨가 좋네요."),
        _ => None,
    }
}

// =============================================================================
// Automatic multi-window language detection (pure decision logic)
// =============================================================================

/// Whisper's encoder analyses a single ~30s context window, so each detection
/// probe covers at most this many milliseconds of audio.
const DETECTION_WINDOW_MS: usize = 30_000;

/// Fractional offsets (of total duration) at which detection windows are placed.
///
/// Sampling several windows spread across the clip lets vocal sections outvote a
/// non-speech intro (e.g. an instrumental lead-in that Whisper would otherwise
/// mis-detect from the first 30s alone). The values are clip-position fractions,
/// not absolute times, so they scale to any duration.
const DETECTION_WINDOW_FRACTIONS: [f64; 5] = [0.1, 0.3, 0.5, 0.7, 0.9];

/// Computes the detection-window start offsets (in milliseconds) for a clip.
///
/// `total_ms` is the clip duration in milliseconds. The returned offsets are the
/// start of each ~30s detection window:
///
/// * For clips no longer than one detection window, a single window at offset 0
///   covers the whole clip.
/// * For longer clips, windows are placed at [`DETECTION_WINDOW_FRACTIONS`] of
///   the duration, each clamped so a full window fits inside the audio, then
///   de-duplicated. Spreading the probes lets later (vocal) windows outvote an
///   instrumental intro.
///
/// The result is always non-empty (at least the offset 0 window) and sorted
/// ascending. This is pure arithmetic with no Whisper dependency so it is unit
/// testable without a model.
fn detection_window_offsets_ms(total_ms: usize) -> Vec<usize> {
    // Short clips (and zero-length input) use a single window from the start.
    if total_ms <= DETECTION_WINDOW_MS {
        return vec![0];
    }

    // The latest offset at which a full window still fits inside the audio.
    let max_offset = total_ms - DETECTION_WINDOW_MS;

    let mut offsets: Vec<usize> = DETECTION_WINDOW_FRACTIONS
        .iter()
        .map(|fraction| {
            let raw = (total_ms as f64 * fraction).round() as usize;
            raw.min(max_offset)
        })
        .collect();

    offsets.sort_unstable();
    offsets.dedup();
    offsets
}

/// Aggregates per-window language probability vectors into a single best
/// language id.
///
/// Each element of `windows` is the probability distribution returned by
/// `WhisperState::lang_detect` for one detection window (indexed by language
/// id). The distributions are summed component-wise and the argmax of the sum is
/// returned. Summing the full vectors (rather than counting per-window winners)
/// lets confident vocal windows outweigh a weak instrumental-intro window even
/// when the intro nominally "wins" its own window.
///
/// Returns `None` when there are no windows, when the vectors are empty, or when
/// every aggregated probability is non-positive (no usable signal). This keeps
/// the caller on Whisper's built-in auto-detection in degenerate cases. Vectors
/// of differing lengths are tolerated (shorter ones simply contribute nothing to
/// the missing tail ids). Pure logic, unit testable without a model.
fn aggregate_language_probabilities(windows: &[Vec<f32>]) -> Option<usize> {
    let max_len = windows.iter().map(|probs| probs.len()).max().unwrap_or(0);
    if max_len == 0 {
        return None;
    }

    let mut totals = vec![0.0f64; max_len];
    for probs in windows {
        for (index, &value) in probs.iter().enumerate() {
            // Ignore NaN/negative entries defensively so one bad probe cannot
            // poison the aggregate.
            if value.is_finite() && value > 0.0 {
                totals[index] += value as f64;
            }
        }
    }

    let mut best_index: Option<usize> = None;
    let mut best_value = 0.0f64;
    for (index, &total) in totals.iter().enumerate() {
        if total > best_value {
            best_value = total;
            best_index = Some(index);
        }
    }

    best_index
}

/// Returns true when `text` contains no speech once non-speech annotations are
/// removed.
///
/// Whisper emits non-speech audio (music, applause, etc.) as bracketed
/// annotations such as `[Music]`, `(music)`, `[Applause]`, `[음악]`, or as bare
/// musical-note glyphs like `♪♪`. A cue is classified as non-speech only when,
/// after stripping every bracketed group (`[...]`, `(...)`, `{...}`, `<...>`),
/// musical-note glyphs (U+2669–U+266F), asterisks, whitespace, and standalone
/// punctuation, nothing remains.
///
/// Real dialogue is never dropped because it carries letters or digits outside
/// any bracket: `He said [unclear] hi` retains `He said  hi` and is kept.
fn is_non_speech_cue(text: &str) -> bool {
    let mut depth: usize = 0;
    let mut remaining = String::new();
    for ch in text.chars() {
        match ch {
            '[' | '(' | '{' | '<' => depth += 1,
            ']' | ')' | '}' | '>' => depth = depth.saturating_sub(1),
            _ if depth > 0 => {}
            // Musical-note glyphs (U+2669–U+266F: ♩♪♫♬♭♮♯) and asterisks are
            // non-speech markers; whitespace carries no speech on its own.
            '\u{2669}'..='\u{266F}' | '*' => {}
            _ if ch.is_whitespace() => {}
            // Standalone punctuation outside brackets is not speech.
            _ if !ch.is_alphanumeric() => {}
            _ => remaining.push(ch),
        }
    }
    remaining.trim().is_empty()
}

/// Returns true when this segment should be dropped as a non-speech cue.
///
/// Gated behind [`DROP_NON_SPEECH_CUES`] so the behavior can be disabled for SDH
/// output without changing call sites.
fn should_drop_non_speech(text: &str) -> bool {
    DROP_NON_SPEECH_CUES && is_non_speech_cue(text)
}

/// Returns true when `c` belongs to a CJK script that is written without spaces
/// between word units (Hangul, Han ideographs, Kana, and CJK symbols).
///
/// Whisper emits no leading spaces between CJK tokens, so these characters must
/// be treated as their own word units when grouping tokens and splitting cues.
fn is_cjk(c: char) -> bool {
    matches!(c,
        // Hangul syllables and Jamo (Korean).
        '\u{AC00}'..='\u{D7A3}'        // Hangul Syllables
        | '\u{1100}'..='\u{11FF}'      // Hangul Jamo
        | '\u{3130}'..='\u{318F}'      // Hangul Compatibility Jamo
        | '\u{A960}'..='\u{A97F}'      // Hangul Jamo Extended-A
        | '\u{D7B0}'..='\u{D7FF}'      // Hangul Jamo Extended-B
        // CJK Unified Ideographs and common extensions/compatibility (Chinese/Kanji).
        | '\u{4E00}'..='\u{9FFF}'      // CJK Unified Ideographs
        | '\u{3400}'..='\u{4DBF}'      // CJK Unified Ideographs Extension A
        | '\u{F900}'..='\u{FAFF}'      // CJK Compatibility Ideographs
        // Japanese kana.
        | '\u{3040}'..='\u{309F}'      // Hiragana
        | '\u{30A0}'..='\u{30FF}'      // Katakana
        // Shared CJK symbols and punctuation.
        | '\u{3000}'..='\u{303F}'      // CJK Symbols and Punctuation
    )
}

/// Returns true when `text` is predominantly CJK script.
///
/// Counts CJK versus other letter/ideograph characters (ignoring whitespace,
/// digits, and ASCII punctuation) and reports CJK dominance when at least half
/// of the meaningful characters are CJK.
fn is_cjk_dominant(text: &str) -> bool {
    let mut cjk = 0usize;
    let mut other = 0usize;
    for c in text.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else if c.is_alphabetic() {
            other += 1;
        }
    }
    cjk > 0 && cjk >= other
}

/// Picks the per-cue character budget from the segment text.
///
/// Uses the smaller CJK budget when the text is predominantly CJK, otherwise the
/// Latin budget. Detection is text-based so no language parameter is required.
fn char_budget_for(text: &str) -> usize {
    if is_cjk_dominant(text) {
        MAX_CHARS_PER_CUE_CJK
    } else {
        MAX_CHARS_PER_CUE
    }
}

/// Normalizes ASR segments into readable subtitle cues.
///
/// When a segment carries word-level timings (from Whisper token timestamps),
/// long segments are split on word boundaries and each cue receives the real
/// start/end derived from its words' token timestamps. When word timings are
/// absent, the function falls back to the legacy character-proportion split so
/// behavior degrades gracefully.
pub fn subtitle_ready_segments(segments: &[TranscriptionSegment]) -> Vec<TranscriptionSegment> {
    let mut output = Vec::new();
    for segment in segments {
        let text = segment.text.trim();
        if text.is_empty() || segment.end_time <= segment.start_time {
            continue;
        }

        // Drop non-speech annotations (e.g. `[Music]`, `♪♪`, `[음악]`) so music
        // passages leave a gap rather than emitting a useless caption cue. This
        // guard covers both the word-timed and char-proportion paths because it
        // runs before either is selected.
        if should_drop_non_speech(text) {
            continue;
        }

        let char_budget = char_budget_for(text);
        if segment.words.is_empty() {
            push_char_proportion_cues(segment, text, char_budget, &mut output);
        } else {
            push_word_timed_cues(segment, text, char_budget, &mut output);
        }
    }

    output
}

/// Splits a segment on word boundaries using real token timestamps.
///
/// `char_budget` is the script-aware per-cue character budget chosen by the
/// caller (smaller for CJK). The accumulated cue text is rebuilt by concatenating
/// each word's verbatim text (preserving original spacing) and trimming only the
/// cue ends, so no separators are invented and no transcript text is dropped.
fn push_word_timed_cues(
    segment: &TranscriptionSegment,
    text: &str,
    char_budget: usize,
    output: &mut Vec<TranscriptionSegment>,
) {
    // Keep only words with usable, ordered timings to avoid degenerate cues.
    let words: Vec<&WordTiming> = segment
        .words
        .iter()
        .filter(|word| !word.text.trim().is_empty() && word.end_time >= word.start_time)
        .collect();

    if words.is_empty() {
        push_char_proportion_cues(segment, text, char_budget, output);
        return;
    }

    // Guard against word timings that fail to cover the segment text (e.g. lost
    // tokens). If the reconstructed word text is far shorter than the segment
    // text, fall back to the char-proportion path rather than dropping content.
    let words_chars: usize = words
        .iter()
        .map(|word| word.text.trim().chars().count())
        .sum();
    let segment_chars = text.chars().count();
    if segment_chars > 0 && words_chars * 2 < segment_chars {
        push_char_proportion_cues(segment, text, char_budget, output);
        return;
    }

    // Expand any single word/unit that already exceeds the budget so an oversized
    // word can never produce an unreadable cue. CJK runs split on character count.
    let units = split_oversized_words(&words, char_budget);

    let duration = segment.end_time - segment.start_time;
    let should_split = segment_chars > char_budget || duration > MAX_CUE_DURATION_SEC;
    if !should_split {
        output.push(TranscriptionSegment {
            start_time: segment.start_time,
            end_time: segment.end_time,
            text: text.to_string(),
            words: segment.words.clone(),
        });
        return;
    }

    let mut cues: Vec<TranscriptionSegment> = Vec::new();
    let mut current_words: Vec<WordTiming> = Vec::new();
    let mut current_chars = 0usize;

    for word in units {
        let word_chars = word.text.trim().chars().count();
        let projected_chars = current_chars + word_chars;
        let cue_start = current_words
            .first()
            .map(|first| first.start_time)
            .unwrap_or(word.start_time);
        let projected_duration = word.end_time - cue_start;

        // Flush the current cue when adding this word would breach char or
        // duration budgets, but only if the pending cue already meets the
        // minimum on-screen duration so cues are not flickered too short.
        let exceeds_budget = !current_words.is_empty()
            && (projected_chars > char_budget || projected_duration > MAX_CUE_DURATION_SEC);
        if exceeds_budget {
            let pending_duration = current_words
                .last()
                .map(|last| last.end_time)
                .unwrap_or(cue_start)
                - cue_start;
            if pending_duration >= MIN_SPLIT_DURATION_SEC {
                push_cue_from_words(&current_words, &mut cues);
                current_words.clear();
                current_chars = 0;
            }
        }

        current_chars += word_chars;
        current_words.push(word);
    }

    if !current_words.is_empty() {
        push_cue_from_words(&current_words, &mut cues);
    }

    if cues.is_empty() {
        // Defensive fallback: emit the whole segment if no cue accumulated.
        output.push(TranscriptionSegment {
            start_time: segment.start_time,
            end_time: segment.end_time,
            text: text.to_string(),
            words: segment.words.clone(),
        });
        return;
    }

    merge_short_cues(&mut cues);
    output.extend(cues);
}

/// Expands words whose own text already exceeds `char_budget` into smaller units.
///
/// A single oversized word (common with long unbroken CJK runs that Whisper
/// emits as one chunk) is divided on character count so no resulting cue can
/// breach the budget. The original token timing is distributed proportionally
/// across the produced sub-units. Words within budget pass through unchanged.
fn split_oversized_words(words: &[&WordTiming], char_budget: usize) -> Vec<WordTiming> {
    let mut units = Vec::new();
    for word in words {
        let trimmed_len = word.text.trim().chars().count();
        if trimmed_len <= char_budget || char_budget == 0 {
            units.push((*word).clone());
            continue;
        }

        // Preserve any leading whitespace on the very first sub-unit so spacing
        // with the previous word is retained.
        let chars: Vec<char> = word.text.chars().collect();
        let total = chars.len();
        let span = (word.end_time - word.start_time).max(0.0);
        let mut index = 0usize;
        while index < total {
            let end = (index + char_budget).min(total);
            let piece: String = chars[index..end].iter().collect();
            // Skip pieces that are only whitespace.
            if piece.trim().is_empty() {
                index = end;
                continue;
            }
            let start_frac = index as f64 / total as f64;
            let end_frac = end as f64 / total as f64;
            let start_time = word.start_time + span * start_frac;
            let end_time = word.start_time + span * end_frac;
            units.push(WordTiming {
                text: piece,
                start_time,
                end_time: end_time.max(start_time),
            });
            index = end;
        }
    }
    units
}

/// Builds a cue from a slice of words and appends it to `cues`.
///
/// Cue text is the verbatim concatenation of the constituent word texts with the
/// cue ends trimmed; word separators are never invented, so Latin words keep
/// their single spaces and CJK characters keep zero spacing.
fn push_cue_from_words(words: &[WordTiming], cues: &mut Vec<TranscriptionSegment>) {
    let Some(first) = words.first() else {
        return;
    };
    let Some(last) = words.last() else {
        return;
    };

    let mut text = String::new();
    for word in words {
        text.push_str(&word.text);
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return;
    }

    cues.push(TranscriptionSegment {
        start_time: first.start_time,
        end_time: last.end_time.max(first.start_time),
        text,
        words: words.to_vec(),
    });
}

/// Merges any cue shorter than the flicker floor into the previous cue.
///
/// A finalized cue below [`MIN_CUE_DURATION_FLOOR_SEC`] is absorbed by extending
/// the previous cue's end time and appending its text, avoiding sub-second
/// flicker without creating overlaps. The first cue is kept even if short
/// because there is no previous cue to merge into.
fn merge_short_cues(cues: &mut Vec<TranscriptionSegment>) {
    if cues.len() < 2 {
        return;
    }

    let mut merged: Vec<TranscriptionSegment> = Vec::with_capacity(cues.len());
    for cue in cues.drain(..) {
        let too_short = cue.end_time - cue.start_time < MIN_CUE_DURATION_FLOOR_SEC;
        if too_short {
            if let Some(previous) = merged.last_mut() {
                // Extend the previous cue to cover this one; never shorten it.
                previous.end_time = previous.end_time.max(cue.end_time);
                // Join the two trimmed cue texts, inserting a space only at a
                // Latin/Latin boundary so CJK stays unspaced and Latin words are
                // not run together.
                let needs_space = matches!(
                    (previous.text.chars().last(), cue.text.chars().next()),
                    (Some(prev_char), Some(next_char))
                        if !is_cjk(prev_char) && !is_cjk(next_char)
                );
                if needs_space {
                    previous.text.push(' ');
                }
                previous.text.push_str(cue.text.trim());
                previous.text = previous.text.trim().to_string();
                previous.words.extend(cue.words);
                continue;
            }
        }
        merged.push(cue);
    }

    *cues = merged;
}

/// Legacy character-proportion split used when word timings are unavailable.
///
/// `char_budget` is the script-aware per-cue character budget. When `text` is
/// empty of word timings the behavior is otherwise identical to the original
/// legacy path: chunk the text, then distribute the segment duration across the
/// chunks by character proportion.
fn push_char_proportion_cues(
    segment: &TranscriptionSegment,
    text: &str,
    char_budget: usize,
    output: &mut Vec<TranscriptionSegment>,
) {
    let duration = segment.end_time - segment.start_time;
    let should_split = text.chars().count() > char_budget || duration > MAX_CUE_DURATION_SEC;
    if !should_split || duration < MIN_SPLIT_DURATION_SEC * 2.0 {
        output.push(TranscriptionSegment {
            start_time: segment.start_time,
            end_time: segment.end_time,
            text: text.to_string(),
            words: Vec::new(),
        });
        return;
    }

    let max_chunks_by_duration = (duration / MIN_SPLIT_DURATION_SEC).floor().max(1.0) as usize;
    let chunks = split_subtitle_text(text, char_budget, max_chunks_by_duration);
    if chunks.len() <= 1 {
        output.push(TranscriptionSegment {
            start_time: segment.start_time,
            end_time: segment.end_time,
            text: text.to_string(),
            words: Vec::new(),
        });
        return;
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
            words: Vec::new(),
        });
        cursor = end_time;
    }
}

fn split_subtitle_text(text: &str, max_chars: usize, max_chunks: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();

    for token in subtitle_split_tokens(text) {
        // No separator is inserted before punctuation or between CJK characters
        // (which are written without spaces); a single space joins Latin words.
        let needs_separator = !current.is_empty()
            && !is_punctuation_token(&token)
            && !token_is_cjk(&token)
            && !current.chars().last().is_some_and(is_cjk);
        let pending_len =
            current.chars().count() + token.chars().count() + usize::from(needs_separator);
        if !current.is_empty() && pending_len > max_chars && chunks.len() + 1 < max_chunks {
            chunks.push(current.trim().to_string());
            current.clear();
        }

        let needs_separator = !current.is_empty()
            && !is_punctuation_token(&token)
            && !token_is_cjk(&token)
            && !current.chars().last().is_some_and(is_cjk);
        if needs_separator {
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
        } else if is_cjk(ch) {
            // CJK scripts have no inter-word spaces, so emit each CJK character
            // as its own token. This lets the char-proportion fallback break a
            // long spaceless CJK run instead of producing one giant cue. Latin
            // tokenization (space/punctuation delimited) is unaffected.
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            tokens.push(ch.to_string());
        } else {
            current.push(ch);
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

/// Returns true when every character in `token` is CJK (no Latin separator).
fn token_is_cjk(token: &str) -> bool {
    !token.is_empty() && token.chars().all(is_cjk)
}

fn is_punctuation_token(token: &str) -> bool {
    token.chars().all(|ch| {
        matches!(
            ch,
            '.' | ',' | '?' | '!' | ';' | ':' | '。' | '，' | '？' | '！'
        )
    })
}

/// A raw Whisper token with its decoded text and token-level timing in seconds.
///
/// Used as the input to [`group_tokens_into_words`]. Token text is sub-word
/// (BPE) and may carry a leading space marking a word boundary; special tokens
/// such as `[_BEG_]` or `<|...|>` are filtered out during grouping.
#[derive(Debug, Clone, PartialEq)]
pub struct RawToken {
    /// Raw token text as decoded by Whisper (may contain a leading space).
    pub text: String,
    /// Token start time in seconds.
    pub start_time: f64,
    /// Token end time in seconds.
    pub end_time: f64,
}

/// Returns true for Whisper special tokens that carry no transcribed text.
///
/// Examples include timestamp/control tokens like `[_BEG_]`, `[_TT_123]`, and
/// language/task markers such as `<|en|>` or `<|transcribe|>`.
fn is_whisper_special_token(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }
    (trimmed.starts_with("[_") && trimmed.ends_with(']'))
        || (trimmed.starts_with("<|") && trimmed.ends_with("|>"))
}

/// Groups sub-word Whisper tokens into whole words with merged timings.
///
/// Whisper emits sub-word BPE tokens. Word boundaries are detected with two
/// rules so both Latin and CJK scripts split correctly:
///
/// * A token that begins with leading whitespace (or the first non-special
///   token) starts a new word — this is the classic space-delimited Latin rule.
/// * CJK characters (Hangul, Han, Kana, CJK symbols) are written without spaces,
///   so Whisper emits no leading space between them. Each CJK character anchors
///   its own word group, and a boundary is inserted whenever the script switches
///   between CJK and non-CJK. This lets long Korean/Japanese/Chinese segments
///   split into readable cues instead of collapsing into one giant "word".
///
/// Special tokens are stripped. To reproduce the original transcript spacing
/// downstream, each resulting word **preserves its leading whitespace verbatim**
/// (only trailing whitespace is trimmed); callers concatenate word texts and
/// trim the cue ends rather than re-inserting separators. Each word spans from
/// its first character's token `start_time` to its last character's `end_time`.
pub fn group_tokens_into_words(tokens: &[RawToken]) -> Vec<WordTiming> {
    let mut words: Vec<WordTiming> = Vec::new();
    let mut current_text = String::new();
    let mut current_start = 0.0_f64;
    let mut current_end = 0.0_f64;
    let mut has_current = false;
    // Tracks whether the last emitted character was CJK, to detect script
    // switches that should start a new word even without leading whitespace.
    let mut prev_char_cjk = false;

    fn flush_word(
        text: &mut String,
        start: f64,
        end: f64,
        has: &mut bool,
        words: &mut Vec<WordTiming>,
    ) {
        if *has {
            // Preserve leading whitespace (it encodes the original separator)
            // but drop trailing whitespace so concatenation stays clean.
            let trimmed = text.trim_end();
            if !trimmed.trim().is_empty() {
                words.push(WordTiming {
                    text: trimmed.to_string(),
                    start_time: start,
                    end_time: end.max(start),
                });
            }
            text.clear();
            *has = false;
        }
    }

    for token in tokens {
        if is_whisper_special_token(&token.text) {
            continue;
        }

        // Walk the token character-by-character so CJK boundaries inside a single
        // multi-character token are still detected. Token timing applies to the
        // whole token; we attribute its start/end to the characters it carries.
        let mut first_in_token = true;
        for c in token.text.chars() {
            let is_space = c.is_whitespace();
            let is_cjk_char = is_cjk(c);

            // Decide whether this character starts a new word.
            let leading_space = is_space && first_in_token;
            let mut start_new_word = false;
            if has_current {
                if leading_space {
                    start_new_word = true;
                } else if !is_space && (is_cjk_char || prev_char_cjk) {
                    // A CJK character starts its own word, and any character that
                    // follows a CJK character starts a new word (script switch or
                    // next CJK syllable). Whitespace itself never forces a break;
                    // it is absorbed as the leading separator of the next word.
                    start_new_word = true;
                }
            }

            if start_new_word {
                flush_word(
                    &mut current_text,
                    current_start,
                    current_end,
                    &mut has_current,
                    &mut words,
                );
            }

            if !has_current {
                current_start = token.start_time;
                has_current = true;
            }
            current_text.push(c);
            current_end = token.end_time;
            if !is_space {
                prev_char_cjk = is_cjk_char;
            }
            first_in_token = false;
        }
    }

    flush_word(
        &mut current_text,
        current_start,
        current_end,
        &mut has_current,
        &mut words,
    );

    words
}

// =============================================================================
// Whisper Engine - Feature-gated Implementation
// =============================================================================

#[cfg(feature = "whisper")]
mod engine_impl {
    use super::*;
    use whisper_rs::{
        get_lang_str, FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
        WhisperState,
    };

    /// Number of threads used for the cheap encoder-only language-detection
    /// probes when the caller did not request a specific thread count.
    const DETECTION_DEFAULT_THREADS: usize = 1;

    /// Whisper transcription engine
    pub struct WhisperEngine {
        context: WhisperContext,
        model_name: String,
        /// Whether GPU acceleration was actually used to initialize the context.
        ///
        /// True only on a GPU-enabled build whose GPU context initialization
        /// succeeded. False on CPU-only builds and whenever GPU initialization
        /// failed and the engine fell back to CPU.
        used_gpu: bool,
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

            let model_str = model_path.to_str().unwrap_or_default();
            let (context, used_gpu) = Self::create_context_with_fallback(model_str)?;

            let model_name = model_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();

            Ok(Self {
                context,
                model_name,
                used_gpu,
            })
        }

        /// Creates a Whisper context, automatically using GPU when available and
        /// transparently falling back to CPU when GPU initialization fails.
        ///
        /// The context parameters default `use_gpu` to true only on builds that
        /// compiled a GPU backend (whisper-rs `_gpu`), so on CPU-only builds the
        /// first attempt is already CPU and no retry is needed. On GPU builds, a
        /// failed GPU initialization is retried once with `use_gpu(false)` so a
        /// missing or unhealthy GPU never blocks transcription. `flash_attn` is
        /// deliberately left at its default (off) because it can disable DTW and
        /// interfere with the token timestamps the subtitle pipeline relies on.
        ///
        /// Returns the initialized context together with whether GPU was actually
        /// used. Never panics; the only propagated error is when CPU also fails.
        fn create_context_with_fallback(model_str: &str) -> WhisperResult<(WhisperContext, bool)> {
            let params = WhisperContextParameters::default();
            // `use_gpu` defaults to true only when a GPU backend was compiled.
            let attempted_gpu = params.use_gpu;

            match WhisperContext::new_with_params(model_str, params) {
                Ok(context) => {
                    if attempted_gpu {
                        tracing::info!("whisper context initialized with GPU acceleration");
                    } else {
                        tracing::info!("whisper context initialized on CPU");
                    }
                    Ok((context, attempted_gpu))
                }
                Err(gpu_error) if attempted_gpu => {
                    // GPU build but GPU init failed: retry once on CPU so a missing
                    // or unhealthy GPU degrades gracefully instead of failing.
                    tracing::warn!(
                        error = %gpu_error,
                        "whisper GPU context initialization failed; retrying on CPU"
                    );
                    let mut cpu_params = WhisperContextParameters::default();
                    cpu_params.use_gpu(false);
                    let context = WhisperContext::new_with_params(model_str, cpu_params)
                        .map_err(|cpu_error| WhisperError::ModelLoadError(cpu_error.to_string()))?;
                    tracing::info!("whisper context initialized on CPU after GPU fallback");
                    Ok((context, false))
                }
                Err(cpu_error) => {
                    // CPU-only build whose CPU init failed: nothing to fall back to.
                    Err(WhisperError::ModelLoadError(cpu_error.to_string()))
                }
            }
        }

        /// Returns the model name
        pub fn model_name(&self) -> &str {
            &self.model_name
        }

        /// Returns whether GPU acceleration was actually used for this engine.
        ///
        /// True only when a GPU build successfully initialized a GPU context.
        /// False on CPU-only builds and after a GPU-to-CPU runtime fallback.
        pub fn used_gpu(&self) -> bool {
            self.used_gpu
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

            // Resolve the language for the main decode pass.
            //
            // An explicit non-"auto" language is honored verbatim and skips
            // detection. Otherwise robust multi-window auto-detection runs over
            // several ~30s windows spread across the clip; this prevents a
            // non-speech intro (e.g. an instrumental lead-in) from fixing the
            // whole track to a mis-detected language. On any detection failure we
            // leave the language unset so Whisper's built-in auto-detection
            // (first-window) still applies as a safe fallback.
            let explicit_language = options
                .language
                .as_deref()
                .map(str::trim)
                .filter(|lang| !lang.is_empty() && *lang != "auto");

            // Tracks the language code chosen for the run so the result can
            // report a concrete detected language instead of "auto".
            let mut resolved_language: Option<String> = explicit_language.map(str::to_string);

            if let Some(lang) = explicit_language {
                params.set_language(Some(lang));
            } else {
                let detect_threads = if options.threads > 0 {
                    options.threads as usize
                } else {
                    DETECTION_DEFAULT_THREADS
                };
                if let Some(code) =
                    Self::detect_language_multi_window(&mut state, samples, detect_threads)
                {
                    tracing::info!(language = code, "whisper auto-detected language");
                    params.set_language(Some(code));
                    resolved_language = Some(code.to_string());
                } else {
                    // No usable detection signal: fall back to Whisper's own
                    // auto-detection by leaving the language unset.
                    tracing::debug!(
                        "whisper multi-window detection inconclusive; using built-in auto-detect"
                    );
                }
            }

            params.set_translate(options.translate);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);

            // Enable word/token-level timing so subtitle splitting can align cues
            // to real speech timing instead of character-count proportions.
            // `set_token_timestamps(true)` populates per-token `t0`/`t1`, and
            // `set_split_on_word(true)` keeps Whisper's own segmentation aligned
            // to word boundaries (verified against whisper-rs 0.16 API).
            params.set_token_timestamps(true);
            params.set_split_on_word(true);

            // Decoder-level non-speech-token suppression is gated and OFF by
            // default. `set_suppress_nst` maps to whisper.cpp's `suppress_nst`
            // flag, but it is hostile to SUNG vocals (Whisper scores singing near
            // the non-speech boundary, so suppression makes the decoder emit
            // almost nothing over lyrics). The deterministic [`is_non_speech_cue`]
            // cue filter is the authoritative non-speech guard, so this remains
            // redundant here. See [`SUPPRESS_NON_SPEECH_TOKENS`] for the rationale.
            if SUPPRESS_NON_SPEECH_TOKENS {
                params.set_suppress_nst(true);
            }

            if options.threads > 0 {
                params.set_n_threads(options.threads as i32);
            }

            if let Some(ref prompt) = options.initial_prompt {
                params.set_initial_prompt(prompt);
            } else if let Some(seed) = korean_initial_prompt_seed(options.language.as_deref()) {
                // Bias the decoder toward Hangul for Korean audio when the caller
                // did not provide an explicit prompt. Language-gated and minimal;
                // never overrides an explicitly supplied initial prompt.
                params.set_initial_prompt(seed);
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

                // Collect per-token timing, then merge sub-word BPE tokens into
                // whole words. Token `t0`/`t1` are also centiseconds.
                let token_count = segment.n_tokens();
                let mut raw_tokens = Vec::with_capacity(token_count.max(0) as usize);
                for token_idx in 0..token_count {
                    let Some(token) = segment.get_token(token_idx) else {
                        continue;
                    };
                    let token_text = match token.to_str_lossy() {
                        Ok(value) => value.into_owned(),
                        Err(_) => continue,
                    };
                    let data = token.token_data();
                    raw_tokens.push(RawToken {
                        text: token_text,
                        start_time: data.t0 as f64 / 100.0,
                        end_time: data.t1 as f64 / 100.0,
                    });
                }
                let words = group_tokens_into_words(&raw_tokens);

                segments.push(TranscriptionSegment {
                    start_time: start,
                    end_time: end,
                    text: text.trim().to_string(),
                    words,
                });
            }

            // Report the resolved language: an explicit choice, the multi-window
            // detection result, or — when detection was inconclusive — whatever
            // Whisper itself settled on during the full run.
            let language = resolved_language
                .or_else(|| {
                    let detected_id = state.full_lang_id_from_state();
                    get_lang_str(detected_id).map(str::to_string)
                })
                .unwrap_or_else(|| "unknown".to_string());

            // Calculate duration from samples (16kHz)
            let duration = samples.len() as f64 / 16000.0;

            Ok(TranscriptionResult {
                language,
                segments,
                duration,
            })
        }

        /// Detects the spoken language across multiple windows of the audio.
        ///
        /// Uses the cheap encoder-only `lang_detect` probe (no decode) at several
        /// ~30s windows spread across the clip, aggregates the returned
        /// per-language probability vectors, and returns the argmax language code.
        ///
        /// This makes detection robust to non-speech intros: an instrumental
        /// lead-in that would mis-fire the first 30s window is outvoted by the
        /// vocal windows. The mel spectrogram is computed once and reused for
        /// every probe.
        ///
        /// Returns the language code (e.g. `"ko"`) on success, or `None` when the
        /// audio is empty, the mel/probe calls fail, or no window yields a usable
        /// signal — in which case the caller falls back to Whisper's built-in
        /// auto-detection. This never panics: every fallible call is handled and
        /// failing windows are skipped.
        fn detect_language_multi_window(
            state: &mut WhisperState,
            samples: &[f32],
            threads: usize,
        ) -> Option<&'static str> {
            if samples.is_empty() {
                return None;
            }

            let threads = threads.max(DETECTION_DEFAULT_THREADS);

            // Compute the log-mel spectrogram once; every probe reuses it. Skip
            // detection entirely (fall back to auto) if this fails.
            if let Err(error) = state.pcm_to_mel(samples, threads) {
                tracing::debug!(
                    ?error,
                    "whisper pcm_to_mel failed; skipping language detection"
                );
                return None;
            }

            // 16 kHz mono: 16 samples per millisecond.
            let total_ms = samples.len() / 16;
            let offsets = detection_window_offsets_ms(total_ms);

            let mut window_probs: Vec<Vec<f32>> = Vec::with_capacity(offsets.len());
            for offset_ms in offsets {
                match state.lang_detect(offset_ms, threads) {
                    Ok((_, probs)) => window_probs.push(probs),
                    Err(error) => {
                        // Skip this window; other windows can still decide.
                        tracing::debug!(
                            ?error,
                            offset_ms,
                            "whisper language probe failed for window; skipping"
                        );
                    }
                }
            }

            let best_id = aggregate_language_probabilities(&window_probs)?;
            get_lang_str(best_id as i32)
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

/// Returns the GPU/CPU acceleration backend compiled into this build.
///
/// The backend is determined purely from the compile-time OpenReelio passthrough
/// features (`whisper-cuda`, `whisper-metal`, `whisper-vulkan`, `whisper-coreml`,
/// `whisper-openblas`). When more than one is somehow enabled, the first match in
/// GPU-then-CPU priority order wins. Returns `"cpu"` when no acceleration feature
/// is compiled, which is the default build configuration.
///
/// This reports what was *compiled*, not whether GPU initialization succeeded at
/// runtime; runtime fallback to CPU is handled separately in `WhisperEngine::new`.
pub fn compiled_acceleration_backend() -> &'static str {
    if cfg!(feature = "whisper-cuda") {
        "cuda"
    } else if cfg!(feature = "whisper-metal") {
        "metal"
    } else if cfg!(feature = "whisper-vulkan") {
        "vulkan"
    } else if cfg!(feature = "whisper-coreml") {
        "coreml"
    } else if cfg!(feature = "whisper-openblas") {
        "openblas"
    } else {
        "cpu"
    }
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
    fn korean_initial_prompt_seed_returns_hangul_seed_for_korean() {
        let seed = korean_initial_prompt_seed(Some("ko"));
        assert!(seed.is_some());
        // The seed must contain Hangul so it actually biases the decoder.
        assert!(seed
            .unwrap()
            .chars()
            .any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c)));
    }

    #[test]
    fn korean_initial_prompt_seed_returns_none_for_other_languages() {
        assert_eq!(korean_initial_prompt_seed(Some("en")), None);
        assert_eq!(korean_initial_prompt_seed(Some("ja")), None);
        assert_eq!(korean_initial_prompt_seed(Some("auto")), None);
        assert_eq!(korean_initial_prompt_seed(None), None);
    }

    // -------------------------------------------------------------------------
    // Multi-window automatic language detection (pure decision logic)
    // -------------------------------------------------------------------------

    #[test]
    fn detection_window_offsets_single_window_for_short_clip() {
        // A clip no longer than one detection window uses a single window at the
        // start that covers the whole clip.
        assert_eq!(detection_window_offsets_ms(0), vec![0]);
        assert_eq!(detection_window_offsets_ms(5_000), vec![0]);
        assert_eq!(detection_window_offsets_ms(DETECTION_WINDOW_MS), vec![0]);
    }

    #[test]
    fn detection_window_offsets_spreads_windows_across_long_clip() {
        // A 5-minute clip yields several distinct, ascending offsets, each placed
        // so a full ~30s window fits inside the audio.
        let total_ms = 300_000; // 5 minutes
        let offsets = detection_window_offsets_ms(total_ms);

        assert!(offsets.len() > 1, "expected multiple windows: {offsets:?}");
        // Sorted, unique, and every window fits inside the clip.
        let max_offset = total_ms - DETECTION_WINDOW_MS;
        let mut previous = 0usize;
        for (index, &offset) in offsets.iter().enumerate() {
            assert!(offset <= max_offset, "window {offset} overflows clip");
            if index > 0 {
                assert!(offset > previous, "offsets must be strictly ascending");
            }
            previous = offset;
        }
        // The later windows (vocal sections) must be sampled, not just the intro.
        assert!(
            offsets.iter().any(|&offset| offset > total_ms / 2),
            "expected a window past the midpoint: {offsets:?}"
        );
    }

    #[test]
    fn detection_window_offsets_clamps_and_dedups_near_window_boundary() {
        // Just over one window: every fractional offset clamps to the single
        // legal position (max_offset), so dedup collapses them to one window.
        let total_ms = DETECTION_WINDOW_MS + 100;
        let offsets = detection_window_offsets_ms(total_ms);
        assert_eq!(offsets, vec![100]);
    }

    #[test]
    fn aggregate_probabilities_votes_majority_language() {
        // Language ids: 0 = "en", 1 = "ko" (positions are illustrative). One
        // window favors English (the instrumental intro), three favor Korean.
        // Summing the vectors must elect Korean.
        let en = vec![0.8, 0.2];
        let ko = vec![0.3, 0.7];
        let windows = vec![en, ko.clone(), ko.clone(), ko];

        assert_eq!(aggregate_language_probabilities(&windows), Some(1));
    }

    #[test]
    fn aggregate_probabilities_single_window_picks_argmax() {
        let windows = vec![vec![0.1, 0.2, 0.7]];
        assert_eq!(aggregate_language_probabilities(&windows), Some(2));
    }

    #[test]
    fn aggregate_probabilities_returns_none_without_signal() {
        // No windows, empty vectors, and all-zero vectors all yield no decision
        // so the caller falls back to Whisper's built-in auto-detection.
        assert_eq!(aggregate_language_probabilities(&[]), None);
        assert_eq!(aggregate_language_probabilities(&[vec![]]), None);
        assert_eq!(aggregate_language_probabilities(&[vec![0.0, 0.0]]), None);
    }

    #[test]
    fn aggregate_probabilities_ignores_non_finite_and_negative() {
        // A poisoned probe (NaN/negative) must not crash or skew the result.
        let bad = vec![f32::NAN, -5.0];
        let good = vec![0.1, 0.9];
        assert_eq!(
            aggregate_language_probabilities(&[bad, good]),
            Some(1),
            "the valid window must decide despite a poisoned probe"
        );
    }

    #[test]
    fn aggregate_probabilities_tolerates_ragged_vectors() {
        // Vectors of differing lengths are tolerated: a shorter vector simply
        // contributes nothing to the missing tail ids.
        let short = vec![0.9];
        let long = vec![0.1, 0.85, 0.05];
        // id 1 wins overall (0 + 0.85 vs id 0 = 0.9 + 0.1 = 1.0)... id 0 = 1.0,
        // id 1 = 0.85, so id 0 wins; assert that exact behavior.
        assert_eq!(aggregate_language_probabilities(&[short, long]), Some(0));
    }

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
                "large-v3-turbo",
                "large-v3-turbo-q5_0",
                "large-v3-turbo-q8_0",
                "large-v3-q5_0"
            ]
        );
    }

    #[test]
    fn test_quantized_variants_filename_url_size_id_round_trip() {
        // Each new quantized variant must report the official ggml filename, the
        // matching HF download URL, a positive estimated size, and round-trip
        // through its id string via the parser.
        let cases = [
            (
                WhisperModel::LargeV3TurboQ5,
                "ggml-large-v3-turbo-q5_0.bin",
                "large-v3-turbo-q5_0",
            ),
            (
                WhisperModel::LargeV3TurboQ8,
                "ggml-large-v3-turbo-q8_0.bin",
                "large-v3-turbo-q8_0",
            ),
            (
                WhisperModel::LargeV3Q5,
                "ggml-large-v3-q5_0.bin",
                "large-v3-q5_0",
            ),
        ];

        for (model, filename, id) in cases {
            assert_eq!(model.filename(), filename);
            assert_eq!(model.name(), id);
            assert!(
                model.download_url().ends_with(filename),
                "url must end with {filename}: {}",
                model.download_url()
            );
            assert!(model
                .download_url()
                .starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"));
            assert!(model.estimated_size_bytes() > 0);
            // id string round-trips back to the same variant.
            assert_eq!(id.parse::<WhisperModel>().unwrap(), model);
            // `all()` must include every new variant.
            assert!(WhisperModel::all().contains(&model));
        }

        // Estimated sizes follow the documented quantization order.
        assert!(
            WhisperModel::LargeV3TurboQ5.estimated_size_bytes()
                < WhisperModel::LargeV3TurboQ8.estimated_size_bytes()
        );
        assert!(
            WhisperModel::LargeV3TurboQ8.estimated_size_bytes()
                < WhisperModel::LargeV3Q5.estimated_size_bytes()
        );
    }

    #[test]
    fn test_recommended_default_is_turbo_q5() {
        assert_eq!(
            WhisperModel::recommended_default(),
            WhisperModel::LargeV3TurboQ5
        );
        // The recommended model id is the stable signal surfaced through the
        // transcription status DTO's `recommendedModel` field.
        assert_eq!(
            WhisperModel::recommended_default().name(),
            "large-v3-turbo-q5_0"
        );
    }

    #[test]
    fn test_is_installed_in_reflects_recommended_model_file_presence() {
        // `is_installed_in` is the exact presence check backing the transcription
        // status DTO's `recommendedInstalled` field. It must be false on an empty
        // directory and true once a non-empty model file exists.
        let temp_dir = std::env::temp_dir().join(format!(
            "openreelio-whisper-installed-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp_dir).expect("temp models dir should be creatable");

        struct DirGuard(std::path::PathBuf);
        impl Drop for DirGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = DirGuard(temp_dir.clone());

        let recommended = WhisperModel::recommended_default();
        assert!(!recommended.is_installed_in(&temp_dir));

        std::fs::write(temp_dir.join(recommended.filename()), b"ggml-model-stub")
            .expect("model file should be writable");
        assert!(recommended.is_installed_in(&temp_dir));

        // An empty file must not count as installed.
        let empty_model = WhisperModel::Base;
        std::fs::write(temp_dir.join(empty_model.filename()), b"")
            .expect("empty model file should be writable");
        assert!(!empty_model.is_installed_in(&temp_dir));
    }

    #[test]
    fn test_quality_rank_accuracy_priority_order() {
        // LargeV3 > LargeV3Q5 > LargeV3Turbo > LargeV3TurboQ8 > LargeV3TurboQ5 > Large.
        assert!(WhisperModel::LargeV3.quality_rank() > WhisperModel::LargeV3Q5.quality_rank());
        assert!(WhisperModel::LargeV3Q5.quality_rank() > WhisperModel::LargeV3Turbo.quality_rank());
        assert!(
            WhisperModel::LargeV3Turbo.quality_rank() > WhisperModel::LargeV3TurboQ8.quality_rank()
        );
        assert!(
            WhisperModel::LargeV3TurboQ8.quality_rank()
                > WhisperModel::LargeV3TurboQ5.quality_rank()
        );
        assert!(WhisperModel::LargeV3TurboQ5.quality_rank() > WhisperModel::Large.quality_rank());
    }

    #[test]
    fn test_compiled_acceleration_backend_is_cpu_on_default_build() {
        // No GPU/accel passthrough feature is enabled in the default test build,
        // so the reported backend must be "cpu".
        assert_eq!(compiled_acceleration_backend(), "cpu");
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
            WhisperModel::LargeV3TurboQ5
        );
        assert_eq!(
            WhisperModel::resolve_requested_or_default(Some("auto"), temp_dir.path()).unwrap(),
            WhisperModel::LargeV3TurboQ5
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
            ..Default::default()
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
                    ..Default::default()
                },
                TranscriptionSegment {
                    start_time: 1.0,
                    end_time: 2.0,
                    text: "world".to_string(),
                    ..Default::default()
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
                    ..Default::default()
                },
                TranscriptionSegment {
                    start_time: 1.0,
                    end_time: 2.0,
                    text: "Second".to_string(),
                    ..Default::default()
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
            ..Default::default()
        }]);

        assert!(segments.len() > 1);
        assert_eq!(segments.first().unwrap().start_time, 0.0);
        assert_eq!(segments.last().unwrap().end_time, 8.0);
        assert!(segments
            .iter()
            .all(|segment| !segment.text.trim().is_empty()));
        // Fallback path must not invent word timings.
        assert!(segments.iter().all(|segment| segment.words.is_empty()));
    }

    #[test]
    fn test_subtitle_ready_segments_char_proportion_fallback_preserved() {
        // With no word timings, the legacy character-proportion behavior must be
        // identical: same chunk count, first/last anchors, and monotonic times.
        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time: 8.0,
            text: "This is a long sentence that should be split into multiple readable subtitle cues for display.".to_string(),
            ..Default::default()
        };
        let segments = subtitle_ready_segments(std::slice::from_ref(&segment));

        assert!(segments.len() > 1);
        assert_eq!(segments.first().unwrap().start_time, 0.0);
        assert_eq!(segments.last().unwrap().end_time, 8.0);
        let mut previous_end = 0.0;
        for cue in &segments {
            assert!(cue.start_time >= previous_end - f64::EPSILON);
            assert!(cue.end_time >= cue.start_time);
            previous_end = cue.end_time;
        }
    }

    #[test]
    fn test_group_tokens_merges_subword_tokens_into_words() {
        // " Hello" + " wor" + "ld" -> ["Hello", "world"]; "ld" lacks a leading
        // space so it merges into the previous word.
        let tokens = vec![
            RawToken {
                text: " Hello".to_string(),
                start_time: 0.0,
                end_time: 0.5,
            },
            RawToken {
                text: " wor".to_string(),
                start_time: 0.6,
                end_time: 0.9,
            },
            RawToken {
                text: "ld".to_string(),
                start_time: 0.9,
                end_time: 1.2,
            },
        ];

        let words = group_tokens_into_words(&tokens);
        assert_eq!(words.len(), 2);
        // Leading whitespace is now preserved verbatim so the original transcript
        // spacing can be reproduced when cues are rebuilt by concatenation.
        // Trailing whitespace is trimmed.
        assert_eq!(words[0].text, " Hello");
        assert_eq!(words[0].start_time, 0.0);
        assert_eq!(words[0].end_time, 0.5);
        assert_eq!(words[1].text, " world");
        assert_eq!(words[1].start_time, 0.6);
        assert_eq!(words[1].end_time, 1.2);
        // Concatenating the words verbatim and trimming reproduces the original
        // spacing (single spaces between Latin words).
        let rebuilt: String = words.iter().map(|word| word.text.as_str()).collect();
        assert_eq!(rebuilt.trim(), "Hello world");
    }

    #[test]
    fn test_group_tokens_strips_special_tokens() {
        let tokens = vec![
            RawToken {
                text: "[_BEG_]".to_string(),
                start_time: 0.0,
                end_time: 0.0,
            },
            RawToken {
                text: "<|en|>".to_string(),
                start_time: 0.0,
                end_time: 0.0,
            },
            RawToken {
                text: " Hi".to_string(),
                start_time: 0.1,
                end_time: 0.4,
            },
            RawToken {
                text: "<|endoftext|>".to_string(),
                start_time: 0.4,
                end_time: 0.4,
            },
        ];

        let words = group_tokens_into_words(&tokens);
        assert_eq!(words.len(), 1);
        // Leading whitespace is preserved; trailing trimmed (see grouping docs).
        assert_eq!(words[0].text, " Hi");
        assert_eq!(words[0].start_time, 0.1);
        assert_eq!(words[0].end_time, 0.4);
    }

    #[test]
    fn test_subtitle_ready_segments_splits_on_word_timings() {
        // Build a 10-second segment whose word timings cluster into two halves
        // with a long second half, forcing a split on real timing boundaries.
        let mut words = Vec::new();
        // First cue worth of words (0.0 - 2.5s), > MIN_SPLIT_DURATION_SEC.
        for (index, word) in ["The", "quick", "brown", "fox"].iter().enumerate() {
            let start = index as f64 * 0.6;
            words.push(WordTiming {
                text: word.to_string(),
                start_time: start,
                end_time: start + 0.5,
            });
        }
        // A late word far past MAX_CUE_DURATION_SEC to force a boundary.
        words.push(WordTiming {
            text: "jumps".to_string(),
            start_time: 7.0,
            end_time: 9.5,
        });

        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time: 9.5,
            text: "The quick brown fox jumps".to_string(),
            words,
        };

        let cues = subtitle_ready_segments(&[segment]);
        assert!(
            cues.len() >= 2,
            "expected a word-boundary split, got {cues:?}"
        );
        // Cue timings come from real token timestamps, not char proportions.
        assert_eq!(cues.first().unwrap().start_time, 0.0);
        assert_eq!(cues.last().unwrap().end_time, 9.5);
        // Each cue must carry the words it was built from.
        assert!(cues.iter().all(|cue| !cue.words.is_empty()));
        // The final cue should be the late word with its real timing.
        let last = cues.last().unwrap();
        assert_eq!(last.text, "jumps");
        assert_eq!(last.start_time, 7.0);
    }

    #[test]
    fn test_subtitle_ready_segments_word_path_keeps_short_segment_intact() {
        // A short segment with word timings must not be split.
        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time: 1.5,
            text: "Hi there".to_string(),
            words: vec![
                WordTiming {
                    text: "Hi".to_string(),
                    start_time: 0.0,
                    end_time: 0.5,
                },
                WordTiming {
                    text: "there".to_string(),
                    start_time: 0.6,
                    end_time: 1.5,
                },
            ],
        };

        let cues = subtitle_ready_segments(&[segment]);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Hi there");
        assert_eq!(cues[0].start_time, 0.0);
        assert_eq!(cues[0].end_time, 1.5);
    }

    #[test]
    fn test_word_timing_serde_backward_compatible() {
        // A segment serialized without `words` must still deserialize (defaulting
        // to an empty vec), preserving backward compatibility.
        let json = r#"{"start_time":0.0,"end_time":1.0,"text":"Hello"}"#;
        let segment: TranscriptionSegment =
            serde_json::from_str(json).expect("legacy segment should deserialize");
        assert!(segment.words.is_empty());
        assert_eq!(segment.text, "Hello");
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

    // -------------------------------------------------------------------------
    // CJK (Korean/Japanese/Chinese) script-aware grouping and splitting
    // -------------------------------------------------------------------------

    /// Builds Korean word timings from a string, one [`WordTiming`] per syllable,
    /// each `step` seconds long. Mirrors how `group_tokens_into_words` anchors
    /// each CJK character as its own word unit (no leading spaces).
    fn korean_words(text: &str, step: f64) -> Vec<WordTiming> {
        text.chars()
            .enumerate()
            .map(|(index, ch)| {
                let start = index as f64 * step;
                WordTiming {
                    text: ch.to_string(),
                    start_time: start,
                    end_time: start + step,
                }
            })
            .collect()
    }

    #[test]
    fn test_is_cjk_covers_hangul_han_kana_and_symbols() {
        assert!(is_cjk('가')); // Hangul syllable
        assert!(is_cjk('한'));
        assert!(is_cjk('語')); // Han ideograph
        assert!(is_cjk('あ')); // Hiragana
        assert!(is_cjk('ア')); // Katakana
        assert!(is_cjk('、')); // CJK punctuation
        assert!(!is_cjk('A'));
        assert!(!is_cjk('1'));
        assert!(!is_cjk(' '));
    }

    #[test]
    fn test_group_tokens_splits_cjk_into_per_syllable_words() {
        // Korean tokens carry no leading spaces; each syllable must become its
        // own word so long segments can split.
        let tokens = vec![
            RawToken {
                text: "안녕".to_string(),
                start_time: 0.0,
                end_time: 0.4,
            },
            RawToken {
                text: "하세요".to_string(),
                start_time: 0.4,
                end_time: 1.0,
            },
        ];

        let words = group_tokens_into_words(&tokens);
        let texts: Vec<&str> = words.iter().map(|word| word.text.as_str()).collect();
        assert_eq!(texts, vec!["안", "녕", "하", "세", "요"]);
        // Concatenating verbatim reproduces the original text with no inserted
        // inter-syllable spaces.
        let rebuilt: String = words.iter().map(|word| word.text.as_str()).collect();
        assert_eq!(rebuilt, "안녕하세요");
    }

    #[test]
    fn test_subtitle_ready_segments_splits_korean_into_readable_cues() {
        // A long Korean segment must split into multiple cues, each within the
        // CJK character budget and with no inserted inter-syllable spaces.
        let text = "안녕하세요만나서반갑습니다오늘은날씨가아주좋네요그렇죠";
        let words = korean_words(text, 0.5);
        let end_time = words.last().map(|word| word.end_time).unwrap_or_default();
        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time,
            text: text.to_string(),
            words,
        };

        let cues = subtitle_ready_segments(&[segment]);
        assert!(cues.len() > 1, "expected Korean to split, got {cues:?}");
        for cue in &cues {
            // No inserted spaces between Korean syllables.
            assert!(
                !cue.text.contains(' '),
                "Korean cue must not contain spaces: {cue:?}"
            );
            // Each cue respects the CJK budget.
            assert!(
                cue.text.chars().count() <= MAX_CHARS_PER_CUE_CJK,
                "cue exceeds CJK budget: {cue:?}"
            );
        }
        // Concatenating all cues reproduces the segment text (modulo trim).
        let rebuilt: String = cues.iter().map(|cue| cue.text.as_str()).collect();
        assert_eq!(rebuilt, text);
        // Anchors preserved.
        assert_eq!(cues.first().unwrap().start_time, 0.0);
        assert_eq!(cues.last().unwrap().end_time, end_time);
    }

    #[test]
    fn test_subtitle_ready_segments_english_keeps_word_spaces() {
        // English cues must keep single spaces between words and concatenating
        // all cues must reproduce the segment text.
        let words = vec![
            (" The", 0.0, 0.4),
            (" quick", 0.5, 0.9),
            (" brown", 1.0, 1.4),
            (" fox", 1.5, 1.9),
            (" jumps", 6.5, 7.0),
            (" over", 7.1, 7.5),
            (" the", 7.6, 8.0),
            (" lazy", 8.1, 8.5),
            (" dog", 8.6, 9.0),
        ];
        let word_timings: Vec<WordTiming> = words
            .iter()
            .map(|(text, start, end)| WordTiming {
                text: text.to_string(),
                start_time: *start,
                end_time: *end,
            })
            .collect();
        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time: 9.0,
            text: "The quick brown fox jumps over the lazy dog".to_string(),
            words: word_timings,
        };

        let cues = subtitle_ready_segments(&[segment]);
        assert!(cues.len() > 1, "expected English split, got {cues:?}");
        // Concatenating cue texts reproduces the transcript spacing (trim ends).
        let rebuilt: String = cues
            .iter()
            .map(|cue| cue.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(rebuilt, "The quick brown fox jumps over the lazy dog");
        for cue in &cues {
            assert!(!cue.text.starts_with(' '));
            assert!(!cue.text.ends_with(' '));
        }
    }

    #[test]
    fn test_subtitle_ready_segments_mixed_korean_and_number() {
        // Mixed Korean + Latin digits: digits keep their value, Korean stays
        // unspaced. Concatenation reproduces the text.
        let mut words = Vec::new();
        for (index, ch) in "오늘은2024년입니다".chars().enumerate() {
            let start = index as f64 * 0.3;
            words.push(WordTiming {
                text: ch.to_string(),
                start_time: start,
                end_time: start + 0.3,
            });
        }
        let end_time = words.last().map(|word| word.end_time).unwrap_or_default();
        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time,
            text: "오늘은2024년입니다".to_string(),
            words,
        };

        let cues = subtitle_ready_segments(&[segment]);
        let rebuilt: String = cues.iter().map(|cue| cue.text.as_str()).collect();
        assert_eq!(rebuilt, "오늘은2024년입니다");
        assert!(cues.iter().all(|cue| !cue.text.contains(' ')));
    }

    #[test]
    fn test_split_oversized_words_breaks_long_cjk_run() {
        // A single oversized "word" (one long CJK run emitted as one chunk) must
        // be broken so no resulting cue exceeds the budget.
        let run: String = "가".repeat(60);
        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time: 12.0,
            text: run.clone(),
            words: vec![WordTiming {
                text: run.clone(),
                start_time: 0.0,
                end_time: 12.0,
            }],
        };

        let cues = subtitle_ready_segments(&[segment]);
        assert!(cues.len() > 1, "long CJK run must split, got {cues:?}");
        for cue in &cues {
            assert!(
                cue.text.chars().count() <= MAX_CHARS_PER_CUE_CJK,
                "cue exceeds CJK budget: {cue:?}"
            );
        }
        let rebuilt: String = cues.iter().map(|cue| cue.text.as_str()).collect();
        assert_eq!(rebuilt, run);
    }

    #[test]
    fn test_merge_short_cues_absorbs_flicker_cue() {
        // A finalized cue shorter than the flicker floor is merged into the
        // previous cue (its end extended), with no overlap created.
        let mut cues = vec![
            TranscriptionSegment {
                start_time: 0.0,
                end_time: 2.0,
                text: "안녕".to_string(),
                words: vec![],
            },
            TranscriptionSegment {
                start_time: 2.0,
                end_time: 2.1, // 0.1s < MIN_CUE_DURATION_FLOOR_SEC
                text: "요".to_string(),
                words: vec![],
            },
        ];

        merge_short_cues(&mut cues);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "안녕요");
        assert_eq!(cues[0].start_time, 0.0);
        assert_eq!(cues[0].end_time, 2.1);
    }

    #[test]
    fn test_merge_short_cues_inserts_space_only_for_latin() {
        // Latin flicker merge keeps a separating space; CJK merge does not.
        let mut cues = vec![
            TranscriptionSegment {
                start_time: 0.0,
                end_time: 2.0,
                text: "hello".to_string(),
                words: vec![],
            },
            TranscriptionSegment {
                start_time: 2.0,
                end_time: 2.1,
                text: "world".to_string(),
                words: vec![],
            },
        ];
        merge_short_cues(&mut cues);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "hello world");
    }

    #[test]
    fn test_subtitle_ready_segments_empty_words_fallback_unchanged() {
        // With no word timings, the CJK path must still use the legacy
        // char-proportion fallback (no invented word timings).
        let text = "안녕하세요만나서반갑습니다오늘은날씨가아주좋네요정말좋아요";
        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time: 8.0,
            text: text.to_string(),
            ..Default::default()
        };

        let cues = subtitle_ready_segments(&[segment]);
        assert!(cues.len() > 1, "long Korean fallback must split: {cues:?}");
        assert!(cues.iter().all(|cue| cue.words.is_empty()));
        assert!(cues.iter().all(|cue| !cue.text.contains(' ')));
        assert_eq!(cues.first().unwrap().start_time, 0.0);
        assert_eq!(cues.last().unwrap().end_time, 8.0);
        let rebuilt: String = cues.iter().map(|cue| cue.text.as_str()).collect();
        assert_eq!(rebuilt, text);
    }

    #[test]
    fn test_subtitle_ready_segments_partial_coverage_falls_back() {
        // Word timings that cover far less than the segment text must fall back
        // to the char-proportion path rather than dropping text.
        let text =
            "This is a fairly long English sentence that should be fully shown to the viewer.";
        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time: 8.0,
            text: text.to_string(),
            // Only two short words provided — nowhere near covering the text.
            words: vec![
                WordTiming {
                    text: " This".to_string(),
                    start_time: 0.0,
                    end_time: 0.4,
                },
                WordTiming {
                    text: " is".to_string(),
                    start_time: 0.5,
                    end_time: 0.7,
                },
            ],
        };

        let cues = subtitle_ready_segments(&[segment]);
        // Fallback path emits cues with no word timings and preserves all text.
        assert!(cues.iter().all(|cue| cue.words.is_empty()));
        let rebuilt: String = cues
            .iter()
            .map(|cue| cue.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(rebuilt, text);
    }

    // -------------------------------------------------------------------------
    // Non-speech annotation filtering (music, applause, musical notes)
    // -------------------------------------------------------------------------

    /// Builds a single-word [`WordTiming`] for the whole cue text so the
    /// word-timed path is exercised (not the char-proportion fallback).
    fn single_word_segment(text: &str, start: f64, end: f64) -> TranscriptionSegment {
        TranscriptionSegment {
            start_time: start,
            end_time: end,
            text: text.to_string(),
            words: vec![WordTiming {
                text: text.to_string(),
                start_time: start,
                end_time: end,
            }],
        }
    }

    #[test]
    fn test_is_non_speech_cue_detection_rule() {
        // Pure annotations / notes are non-speech.
        assert!(is_non_speech_cue("[Music]"));
        assert!(is_non_speech_cue("(music)"));
        assert!(is_non_speech_cue("♪♪"));
        assert!(is_non_speech_cue("[음악]"));
        assert!(is_non_speech_cue("[Applause]"));
        assert!(is_non_speech_cue("[박수]"));
        assert!(is_non_speech_cue("[Music] [Applause]"));
        assert!(is_non_speech_cue("  *  "));
        assert!(is_non_speech_cue("<i>♪</i>"));
        // Real dialogue is never non-speech, even with an inline annotation.
        assert!(!is_non_speech_cue("He said [unclear] hi"));
        assert!(!is_non_speech_cue("Hello world"));
        assert!(!is_non_speech_cue("Track 7"));
    }

    #[test]
    fn test_subtitle_ready_segments_drops_music_word_path() {
        // Word-timed path: a `[Music]` cue is dropped entirely.
        let cues = subtitle_ready_segments(&[single_word_segment("[Music]", 0.0, 3.0)]);
        assert!(
            cues.is_empty(),
            "expected music cue to be dropped: {cues:?}"
        );
    }

    #[test]
    fn test_subtitle_ready_segments_drops_music_fallback_path() {
        // Char-proportion fallback path (no word timings): still dropped.
        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time: 3.0,
            text: "(music)".to_string(),
            ..Default::default()
        };
        let cues = subtitle_ready_segments(&[segment]);
        assert!(
            cues.is_empty(),
            "expected music cue to be dropped: {cues:?}"
        );
    }

    #[test]
    fn test_subtitle_ready_segments_drops_musical_notes() {
        let cues = subtitle_ready_segments(&[single_word_segment("♪♪", 0.0, 2.0)]);
        assert!(cues.is_empty(), "expected note cue to be dropped: {cues:?}");
    }

    #[test]
    fn test_subtitle_ready_segments_drops_korean_music_annotation() {
        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time: 2.0,
            text: "[음악]".to_string(),
            ..Default::default()
        };
        let cues = subtitle_ready_segments(&[segment]);
        assert!(
            cues.is_empty(),
            "expected Korean music cue to be dropped: {cues:?}"
        );
    }

    #[test]
    fn test_subtitle_ready_segments_drops_multiple_annotations() {
        let cues = subtitle_ready_segments(&[single_word_segment("[Music] [Applause]", 0.0, 3.0)]);
        assert!(
            cues.is_empty(),
            "expected multi-annotation cue to be dropped: {cues:?}"
        );
    }

    #[test]
    fn test_subtitle_ready_segments_keeps_dialogue_with_inline_annotation() {
        // Real dialogue carrying an inline `[unclear]` must be kept.
        let segment = TranscriptionSegment {
            start_time: 0.0,
            end_time: 2.0,
            text: "He said [unclear] hi".to_string(),
            ..Default::default()
        };
        let cues = subtitle_ready_segments(&[segment]);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "He said [unclear] hi");
    }

    #[test]
    fn test_subtitle_ready_segments_music_between_speech_leaves_gap() {
        // A music cue between two speech cues is dropped, leaving the two speech
        // cues intact with no merge artifacts.
        let segments = vec![
            single_word_segment("Hello there", 0.0, 2.0),
            single_word_segment("[Music]", 2.0, 5.0),
            single_word_segment("Welcome back", 5.0, 7.0),
        ];
        let cues = subtitle_ready_segments(&segments);
        assert_eq!(cues.len(), 2, "expected two speech cues, got {cues:?}");
        assert_eq!(cues[0].text, "Hello there");
        assert_eq!(cues[0].start_time, 0.0);
        assert_eq!(cues[0].end_time, 2.0);
        assert_eq!(cues[1].text, "Welcome back");
        // The gap between 2.0 and 5.0 is left empty (no caption during music).
        assert_eq!(cues[1].start_time, 5.0);
        assert_eq!(cues[1].end_time, 7.0);
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
