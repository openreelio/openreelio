//! Audio Generation
//!
//! Parameters and results for TTS and music generation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Voice preset for TTS
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Voice {
    /// Voice ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Language code (e.g., "en-US", "ko-KR")
    pub language: String,
    /// Gender
    pub gender: VoiceGender,
    /// Age range
    pub age: VoiceAge,
    /// Style/tone description
    pub style: Option<String>,
    /// Preview audio URL
    pub preview_url: Option<String>,
}

/// Voice gender
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceGender {
    Male,
    Female,
    Neutral,
}

impl Default for VoiceGender {
    fn default() -> Self {
        VoiceGender::Neutral
    }
}

/// Voice age range
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceAge {
    Child,
    Young,
    Adult,
    Senior,
}

impl Default for VoiceAge {
    fn default() -> Self {
        VoiceAge::Adult
    }
}

impl Voice {
    /// Creates a new voice
    pub fn new(id: impl Into<String>, name: impl Into<String>, language: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            language: language.into(),
            gender: VoiceGender::default(),
            age: VoiceAge::default(),
            style: None,
            preview_url: None,
        }
    }

    /// Sets the gender
    pub fn with_gender(mut self, gender: VoiceGender) -> Self {
        self.gender = gender;
        self
    }

    /// Sets the age
    pub fn with_age(mut self, age: VoiceAge) -> Self {
        self.age = age;
        self
    }

    /// Sets the style
    pub fn with_style(mut self, style: impl Into<String>) -> Self {
        self.style = Some(style.into());
        self
    }
}

/// Parameters for text-to-speech
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TTSParams {
    /// Text to convert to speech
    pub text: String,
    /// Voice ID to use
    pub voice_id: Option<String>,
    /// Language code
    pub language: Option<String>,
    /// Speaking speed (0.5 - 2.0, 1.0 is normal)
    pub speed: f32,
    /// Pitch adjustment (-1.0 to 1.0, 0.0 is normal)
    pub pitch: f32,
    /// Volume adjustment (0.0 - 1.0)
    pub volume: f32,
    /// Output format
    pub format: AudioFormat,
    /// Model ID to use
    pub model_id: Option<String>,
    /// Enable SSML processing
    pub ssml_enabled: bool,
    /// Additional parameters
    pub extra_params: HashMap<String, serde_json::Value>,
}

impl TTSParams {
    /// Creates new TTS params
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            voice_id: None,
            language: None,
            speed: 1.0,
            pitch: 0.0,
            volume: 1.0,
            format: AudioFormat::MP3,
            model_id: None,
            ssml_enabled: false,
            extra_params: HashMap::new(),
        }
    }

    /// Sets the voice ID
    pub fn with_voice(mut self, voice_id: impl Into<String>) -> Self {
        self.voice_id = Some(voice_id.into());
        self
    }

    /// Sets the language
    pub fn with_language(mut self, language: impl Into<String>) -> Self {
        self.language = Some(language.into());
        self
    }

    /// Sets the speaking speed
    pub fn with_speed(mut self, speed: f32) -> Self {
        self.speed = speed.clamp(0.5, 2.0);
        self
    }

    /// Sets the pitch
    pub fn with_pitch(mut self, pitch: f32) -> Self {
        self.pitch = pitch.clamp(-1.0, 1.0);
        self
    }

    /// Sets the volume
    pub fn with_volume(mut self, volume: f32) -> Self {
        self.volume = volume.clamp(0.0, 1.0);
        self
    }

    /// Sets the output format
    pub fn with_format(mut self, format: AudioFormat) -> Self {
        self.format = format;
        self
    }

    /// Enables SSML processing
    pub fn with_ssml(mut self) -> Self {
        self.ssml_enabled = true;
        self
    }

    /// Validates the parameters
    pub fn validate(&self) -> Result<(), String> {
        if self.text.trim().is_empty() {
            return Err("Text cannot be empty".to_string());
        }

        if self.text.len() > 10000 {
            return Err("Text too long (max 10000 characters)".to_string());
        }

        Ok(())
    }
}

/// Audio output format
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioFormat {
    #[default]
    MP3,
    WAV,
    OGG,
    FLAC,
    AAC,
}

impl AudioFormat {
    /// Returns the file extension
    pub fn extension(&self) -> &str {
        match self {
            AudioFormat::MP3 => "mp3",
            AudioFormat::WAV => "wav",
            AudioFormat::OGG => "ogg",
            AudioFormat::FLAC => "flac",
            AudioFormat::AAC => "aac",
        }
    }

    /// Returns the MIME type
    pub fn mime_type(&self) -> &str {
        match self {
            AudioFormat::MP3 => "audio/mpeg",
            AudioFormat::WAV => "audio/wav",
            AudioFormat::OGG => "audio/ogg",
            AudioFormat::FLAC => "audio/flac",
            AudioFormat::AAC => "audio/aac",
        }
    }
}

/// Result of TTS generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TTSResult {
    /// Unique result ID
    pub id: String,
    /// Original text
    pub text: String,
    /// Generated audio data
    #[serde(skip_serializing)]
    pub audio_data: Vec<u8>,
    /// MIME type
    pub mime_type: String,
    /// Audio duration in seconds
    pub duration_sec: f64,
    /// Sample rate
    pub sample_rate: u32,
    /// Model that was used
    pub model_used: String,
    /// Generation time in milliseconds
    pub generation_time_ms: u64,
}

impl TTSResult {
    /// Returns suggested filename
    pub fn suggested_filename(&self) -> String {
        let short_text: String = self
            .text
            .chars()
            .take(20)
            .filter(|c| c.is_alphanumeric() || *c == ' ')
            .collect::<String>()
            .trim()
            .replace(' ', "_");

        let ext = match self.mime_type.as_str() {
            "audio/mpeg" => "mp3",
            "audio/wav" => "wav",
            "audio/ogg" => "ogg",
            _ => "audio",
        };

        format!("tts_{}_{}.{}", short_text, &self.id[..8], ext)
    }
}

/// Music genre
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MusicGenre {
    Ambient,
    Cinematic,
    Corporate,
    Electronic,
    HipHop,
    Jazz,
    Classical,
    Rock,
    Pop,
    LoFi,
    Acoustic,
    Orchestral,
    Dramatic,
    Upbeat,
    Relaxing,
}

impl std::fmt::Display for MusicGenre {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MusicGenre::Ambient => write!(f, "Ambient"),
            MusicGenre::Cinematic => write!(f, "Cinematic"),
            MusicGenre::Corporate => write!(f, "Corporate"),
            MusicGenre::Electronic => write!(f, "Electronic"),
            MusicGenre::HipHop => write!(f, "Hip Hop"),
            MusicGenre::Jazz => write!(f, "Jazz"),
            MusicGenre::Classical => write!(f, "Classical"),
            MusicGenre::Rock => write!(f, "Rock"),
            MusicGenre::Pop => write!(f, "Pop"),
            MusicGenre::LoFi => write!(f, "Lo-Fi"),
            MusicGenre::Acoustic => write!(f, "Acoustic"),
            MusicGenre::Orchestral => write!(f, "Orchestral"),
            MusicGenre::Dramatic => write!(f, "Dramatic"),
            MusicGenre::Upbeat => write!(f, "Upbeat"),
            MusicGenre::Relaxing => write!(f, "Relaxing"),
        }
    }
}

/// Music mood
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MusicMood {
    Happy,
    Sad,
    Energetic,
    Calm,
    Tense,
    Mysterious,
    Romantic,
    Epic,
    Playful,
    Dark,
    Hopeful,
    Nostalgic,
}

impl std::fmt::Display for MusicMood {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MusicMood::Happy => write!(f, "Happy"),
            MusicMood::Sad => write!(f, "Sad"),
            MusicMood::Energetic => write!(f, "Energetic"),
            MusicMood::Calm => write!(f, "Calm"),
            MusicMood::Tense => write!(f, "Tense"),
            MusicMood::Mysterious => write!(f, "Mysterious"),
            MusicMood::Romantic => write!(f, "Romantic"),
            MusicMood::Epic => write!(f, "Epic"),
            MusicMood::Playful => write!(f, "Playful"),
            MusicMood::Dark => write!(f, "Dark"),
            MusicMood::Hopeful => write!(f, "Hopeful"),
            MusicMood::Nostalgic => write!(f, "Nostalgic"),
        }
    }
}

/// Parameters for music generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MusicGenerationParams {
    /// Text prompt describing the music
    pub prompt: Option<String>,
    /// Duration in seconds
    pub duration_sec: f64,
    /// Genre
    pub genre: Option<MusicGenre>,
    /// Mood
    pub mood: Option<MusicMood>,
    /// BPM (beats per minute)
    pub bpm: Option<u32>,
    /// Instruments to include
    pub instruments: Vec<String>,
    /// Whether to generate vocals
    pub with_vocals: bool,
    /// Output format
    pub format: AudioFormat,
    /// Model ID
    pub model_id: Option<String>,
    /// Reference track for style (optional)
    pub reference_audio: Option<Vec<u8>>,
    /// Additional parameters
    pub extra_params: HashMap<String, serde_json::Value>,
}

impl MusicGenerationParams {
    /// Creates new music generation params
    pub fn new(duration_sec: f64) -> Self {
        Self {
            prompt: None,
            duration_sec,
            genre: None,
            mood: None,
            bpm: None,
            instruments: Vec::new(),
            with_vocals: false,
            format: AudioFormat::MP3,
            model_id: None,
            reference_audio: None,
            extra_params: HashMap::new(),
        }
    }

    /// Sets the prompt
    pub fn with_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(prompt.into());
        self
    }

    /// Sets the genre
    pub fn with_genre(mut self, genre: MusicGenre) -> Self {
        self.genre = Some(genre);
        self
    }

    /// Sets the mood
    pub fn with_mood(mut self, mood: MusicMood) -> Self {
        self.mood = Some(mood);
        self
    }

    /// Sets the BPM
    pub fn with_bpm(mut self, bpm: u32) -> Self {
        self.bpm = Some(bpm.clamp(40, 200));
        self
    }

    /// Adds an instrument
    pub fn with_instrument(mut self, instrument: impl Into<String>) -> Self {
        self.instruments.push(instrument.into());
        self
    }

    /// Enables vocals
    pub fn with_vocals(mut self) -> Self {
        self.with_vocals = true;
        self
    }

    /// Builds a prompt from genre, mood, and instruments
    pub fn build_prompt(&self) -> String {
        let mut parts = Vec::new();

        if let Some(ref prompt) = self.prompt {
            parts.push(prompt.clone());
        }

        if let Some(genre) = &self.genre {
            parts.push(format!("{} style", genre));
        }

        if let Some(mood) = &self.mood {
            parts.push(format!("{} mood", mood));
        }

        if !self.instruments.is_empty() {
            parts.push(format!("featuring {}", self.instruments.join(", ")));
        }

        if let Some(bpm) = self.bpm {
            parts.push(format!("{} BPM", bpm));
        }

        if parts.is_empty() {
            "Background music".to_string()
        } else {
            parts.join(", ")
        }
    }

    /// Validates the parameters
    pub fn validate(&self) -> Result<(), String> {
        if self.duration_sec < 1.0 {
            return Err("Duration must be at least 1 second".to_string());
        }

        if self.duration_sec > 600.0 {
            return Err("Duration cannot exceed 600 seconds (10 minutes)".to_string());
        }

        Ok(())
    }
}

/// Result of music generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MusicGenerationResult {
    /// Unique result ID
    pub id: String,
    /// Generated prompt/description
    pub description: String,
    /// Generated audio data
    #[serde(skip_serializing)]
    pub audio_data: Vec<u8>,
    /// MIME type
    pub mime_type: String,
    /// Audio duration in seconds
    pub duration_sec: f64,
    /// Sample rate
    pub sample_rate: u32,
    /// Detected/target BPM
    pub bpm: Option<u32>,
    /// Model that was used
    pub model_used: String,
    /// Generation time in milliseconds
    pub generation_time_ms: u64,
}

impl MusicGenerationResult {
    /// Returns suggested filename
    pub fn suggested_filename(&self) -> String {
        let short_desc: String = self
            .description
            .chars()
            .take(20)
            .filter(|c| c.is_alphanumeric() || *c == ' ')
            .collect::<String>()
            .trim()
            .replace(' ', "_");

        let ext = match self.mime_type.as_str() {
            "audio/mpeg" => "mp3",
            "audio/wav" => "wav",
            _ => "audio",
        };

        format!("music_{}_{}.{}", short_desc, &self.id[..8], ext)
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Voice Tests
    // ========================================================================

    #[test]
    fn test_voice_new() {
        let voice = Voice::new("v1", "Test Voice", "en-US");

        assert_eq!(voice.id, "v1");
        assert_eq!(voice.name, "Test Voice");
        assert_eq!(voice.language, "en-US");
        assert_eq!(voice.gender, VoiceGender::Neutral);
    }

    #[test]
    fn test_voice_builder() {
        let voice = Voice::new("v1", "Test", "en-US")
            .with_gender(VoiceGender::Female)
            .with_age(VoiceAge::Young)
            .with_style("friendly");

        assert_eq!(voice.gender, VoiceGender::Female);
        assert_eq!(voice.age, VoiceAge::Young);
        assert_eq!(voice.style, Some("friendly".to_string()));
    }

    // ========================================================================
    // TTSParams Tests
    // ========================================================================

    #[test]
    fn test_tts_params_new() {
        let params = TTSParams::new("Hello world");

        assert_eq!(params.text, "Hello world");
        assert_eq!(params.speed, 1.0);
        assert_eq!(params.pitch, 0.0);
        assert_eq!(params.volume, 1.0);
    }

    #[test]
    fn test_tts_params_builder() {
        let params = TTSParams::new("Test")
            .with_voice("voice_1")
            .with_language("ko-KR")
            .with_speed(1.5)
            .with_pitch(0.2)
            .with_format(AudioFormat::WAV)
            .with_ssml();

        assert_eq!(params.voice_id, Some("voice_1".to_string()));
        assert_eq!(params.language, Some("ko-KR".to_string()));
        assert_eq!(params.speed, 1.5);
        assert_eq!(params.pitch, 0.2);
        assert_eq!(params.format, AudioFormat::WAV);
        assert!(params.ssml_enabled);
    }

    #[test]
    fn test_tts_params_speed_clamped() {
        let params = TTSParams::new("Test").with_speed(5.0);
        assert_eq!(params.speed, 2.0); // Clamped
    }

    #[test]
    fn test_tts_params_validate() {
        let valid = TTSParams::new("Valid text");
        assert!(valid.validate().is_ok());

        let empty = TTSParams::new("  ");
        assert!(empty.validate().is_err());
    }

    // ========================================================================
    // AudioFormat Tests
    // ========================================================================

    #[test]
    fn test_audio_format_extension() {
        assert_eq!(AudioFormat::MP3.extension(), "mp3");
        assert_eq!(AudioFormat::WAV.extension(), "wav");
        assert_eq!(AudioFormat::FLAC.extension(), "flac");
    }

    #[test]
    fn test_audio_format_mime_type() {
        assert_eq!(AudioFormat::MP3.mime_type(), "audio/mpeg");
        assert_eq!(AudioFormat::WAV.mime_type(), "audio/wav");
    }

    // ========================================================================
    // MusicGenerationParams Tests
    // ========================================================================

    #[test]
    fn test_music_params_new() {
        let params = MusicGenerationParams::new(30.0);

        assert_eq!(params.duration_sec, 30.0);
        assert!(!params.with_vocals);
    }

    #[test]
    fn test_music_params_builder() {
        let params = MusicGenerationParams::new(60.0)
            .with_prompt("Uplifting corporate background")
            .with_genre(MusicGenre::Corporate)
            .with_mood(MusicMood::Energetic)
            .with_bpm(120)
            .with_instrument("piano")
            .with_instrument("drums");

        assert_eq!(params.genre, Some(MusicGenre::Corporate));
        assert_eq!(params.mood, Some(MusicMood::Energetic));
        assert_eq!(params.bpm, Some(120));
        assert_eq!(params.instruments.len(), 2);
    }

    #[test]
    fn test_music_params_build_prompt() {
        let params = MusicGenerationParams::new(30.0)
            .with_genre(MusicGenre::LoFi)
            .with_mood(MusicMood::Calm)
            .with_bpm(80);

        let prompt = params.build_prompt();
        assert!(prompt.contains("Lo-Fi"));
        assert!(prompt.contains("Calm"));
        assert!(prompt.contains("80 BPM"));
    }

    #[test]
    fn test_music_params_validate() {
        let valid = MusicGenerationParams::new(60.0);
        assert!(valid.validate().is_ok());

        let too_short = MusicGenerationParams::new(0.5);
        assert!(too_short.validate().is_err());

        let too_long = MusicGenerationParams::new(1000.0);
        assert!(too_long.validate().is_err());
    }

    // ========================================================================
    // TTSResult Tests
    // ========================================================================

    #[test]
    fn test_tts_result_filename() {
        let result = TTSResult {
            id: "01HZ123456789ABCDEF".to_string(),
            text: "Hello world how are you".to_string(),
            audio_data: vec![],
            mime_type: "audio/mpeg".to_string(),
            duration_sec: 2.5,
            sample_rate: 44100,
            model_used: "test".to_string(),
            generation_time_ms: 100,
        };

        let filename = result.suggested_filename();
        assert!(filename.starts_with("tts_"));
        assert!(filename.ends_with(".mp3"));
    }

    // ========================================================================
    // MusicGenre/Mood Tests
    // ========================================================================

    #[test]
    fn test_genre_display() {
        assert_eq!(MusicGenre::LoFi.to_string(), "Lo-Fi");
        assert_eq!(MusicGenre::HipHop.to_string(), "Hip Hop");
    }

    #[test]
    fn test_mood_display() {
        assert_eq!(MusicMood::Happy.to_string(), "Happy");
        assert_eq!(MusicMood::Mysterious.to_string(), "Mysterious");
    }

    #[test]
    fn test_serialization() {
        assert_eq!(
            serde_json::to_string(&MusicGenre::Electronic).unwrap(),
            "\"electronic\""
        );
        assert_eq!(
            serde_json::from_str::<MusicMood>("\"energetic\"").unwrap(),
            MusicMood::Energetic
        );
    }
}
