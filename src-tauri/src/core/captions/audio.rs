//! Audio Extraction Module
//!
//! Provides audio extraction functionality for transcription using FFmpeg.
//! Extracts audio as 16kHz mono WAV format suitable for Whisper.

use std::path::Path;
use std::process::Command;
use thiserror::Error;

// =============================================================================
// Error Types
// =============================================================================

/// Errors that can occur during audio extraction
#[derive(Error, Debug)]
pub enum AudioExtractionError {
    /// FFmpeg command failed to execute
    #[error("FFmpeg execution failed: {0}")]
    FFmpegFailed(String),

    /// FFmpeg command returned non-zero exit code
    #[error("FFmpeg process exited with error: {0}")]
    ProcessError(String),

    /// Input file not found
    #[error("Input file not found: {0}")]
    InputNotFound(String),

    /// Output directory does not exist
    #[error("Output directory does not exist: {0}")]
    OutputDirNotFound(String),

    /// IO error during file operations
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Result type for audio extraction operations
pub type AudioResult<T> = Result<T, AudioExtractionError>;

// =============================================================================
// Audio Extraction Functions
// =============================================================================

/// Extracts audio from a video/audio file as 16kHz mono WAV for transcription.
///
/// # Arguments
///
/// * `input_path` - Path to the input video/audio file
/// * `output_path` - Path where the WAV file should be saved
/// * `ffmpeg_path` - Optional path to FFmpeg binary (defaults to "ffmpeg")
///
/// # Returns
///
/// Returns `Ok(())` on success, or an error if extraction fails.
///
/// # Example
///
/// ```rust,ignore
/// use crate::core::captions::audio::extract_audio_for_transcription;
///
/// extract_audio_for_transcription(
///     Path::new("/path/to/video.mp4"),
///     Path::new("/tmp/audio.wav"),
///     None,
/// )?;
/// ```
pub fn extract_audio_for_transcription(
    input_path: &Path,
    output_path: &Path,
    ffmpeg_path: Option<&str>,
) -> AudioResult<()> {
    // Validate input file exists
    if !input_path.exists() {
        return Err(AudioExtractionError::InputNotFound(
            input_path.to_string_lossy().to_string(),
        ));
    }

    // Validate output directory exists
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AudioExtractionError::OutputDirNotFound(
                parent.to_string_lossy().to_string(),
            ));
        }
    }

    // Build FFmpeg command
    let ffmpeg = ffmpeg_path.unwrap_or("ffmpeg");
    let output = Command::new(ffmpeg)
        .args([
            "-i",
            input_path.to_str().unwrap_or_default(),
            "-ar",
            "16000", // 16kHz sample rate (required by Whisper)
            "-ac",
            "1", // Mono audio
            "-c:a",
            "pcm_s16le", // 16-bit PCM
            "-y",        // Overwrite output
            output_path.to_str().unwrap_or_default(),
        ])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AudioExtractionError::ProcessError(stderr.to_string()));
    }

    Ok(())
}

/// Extracts audio asynchronously using Tokio's spawn_blocking.
///
/// This is useful when you need to extract audio without blocking the async runtime.
///
/// # Arguments
///
/// * `input_path` - Path to the input video/audio file
/// * `output_path` - Path where the WAV file should be saved
/// * `ffmpeg_path` - Optional path to FFmpeg binary
///
/// # Returns
///
/// Returns `Ok(())` on success, or an error if extraction fails.
pub async fn extract_audio_for_transcription_async(
    input_path: &Path,
    output_path: &Path,
    ffmpeg_path: Option<&str>,
) -> AudioResult<()> {
    let input = input_path.to_path_buf();
    let output = output_path.to_path_buf();
    let ffmpeg = ffmpeg_path.map(|s| s.to_string());

    tokio::task::spawn_blocking(move || {
        extract_audio_for_transcription(&input, &output, ffmpeg.as_deref())
    })
    .await
    .map_err(|e| AudioExtractionError::FFmpegFailed(e.to_string()))?
}

/// Loads audio samples from a WAV file as f32 samples normalized to [-1.0, 1.0].
///
/// # Arguments
///
/// * `wav_path` - Path to the WAV file
///
/// # Returns
///
/// Returns a vector of f32 samples on success.
///
/// # Example
///
/// ```rust,ignore
/// let samples = load_audio_samples(Path::new("/tmp/audio.wav"))?;
/// println!("Loaded {} samples", samples.len());
/// ```
pub fn load_audio_samples(wav_path: &Path) -> AudioResult<Vec<f32>> {
    let reader = hound::WavReader::open(wav_path).map_err(|e| {
        AudioExtractionError::FFmpegFailed(format!("Failed to open WAV file: {}", e))
    })?;

    let spec = reader.spec();

    // Verify format is what we expect
    if spec.sample_rate != 16000 {
        return Err(AudioExtractionError::FFmpegFailed(format!(
            "Expected 16kHz sample rate, got {} Hz",
            spec.sample_rate
        )));
    }

    if spec.channels != 1 {
        return Err(AudioExtractionError::FFmpegFailed(format!(
            "Expected mono audio, got {} channels",
            spec.channels
        )));
    }

    // Read samples based on bit depth
    let samples: Vec<f32> = match spec.bits_per_sample {
        16 => reader
            .into_samples::<i16>()
            .filter_map(Result::ok)
            .map(|s| s as f32 / 32768.0)
            .collect(),
        32 => reader
            .into_samples::<i32>()
            .filter_map(Result::ok)
            .map(|s| s as f32 / 2147483648.0)
            .collect(),
        bits => {
            return Err(AudioExtractionError::FFmpegFailed(format!(
                "Unsupported bit depth: {}",
                bits
            )));
        }
    };

    Ok(samples)
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn test_extract_audio_input_not_found() {
        let result = extract_audio_for_transcription(
            Path::new("/nonexistent/video.mp4"),
            Path::new("/tmp/output.wav"),
            None,
        );

        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AudioExtractionError::InputNotFound(_)
        ));
    }

    #[test]
    fn test_extract_audio_output_dir_not_found() {
        // Create a temp file as input
        let temp_dir = TempDir::new().unwrap();
        let input_path = temp_dir.path().join("input.txt");
        File::create(&input_path)
            .unwrap()
            .write_all(b"test")
            .unwrap();

        let result = extract_audio_for_transcription(
            &input_path,
            Path::new("/nonexistent/dir/output.wav"),
            None,
        );

        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AudioExtractionError::OutputDirNotFound(_)
        ));
    }

    #[test]
    fn test_load_audio_samples_file_not_found() {
        let result = load_audio_samples(Path::new("/nonexistent/audio.wav"));
        assert!(result.is_err());
    }

    #[test]
    fn test_load_audio_samples_valid_wav() {
        let temp_dir = TempDir::new().unwrap();
        let wav_path = temp_dir.path().join("test.wav");

        // Create a valid 16kHz mono WAV file with hound
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(&wav_path, spec).unwrap();

        // Write some test samples
        for i in 0..1600 {
            // 0.1 seconds of audio
            let sample = ((i as f32 / 100.0).sin() * 16000.0) as i16;
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();

        // Load and verify
        let samples = load_audio_samples(&wav_path).unwrap();
        assert_eq!(samples.len(), 1600);
        assert!(samples.iter().all(|&s| (-1.0..=1.0).contains(&s)));
    }

    #[test]
    fn test_load_audio_wrong_sample_rate() {
        let temp_dir = TempDir::new().unwrap();
        let wav_path = temp_dir.path().join("wrong_rate.wav");

        // Create a WAV with wrong sample rate
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 44100, // Wrong rate
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(&wav_path, spec).unwrap();
        writer.write_sample(0i16).unwrap();
        writer.finalize().unwrap();

        let result = load_audio_samples(&wav_path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("16kHz"));
    }

    #[test]
    fn test_load_audio_wrong_channels() {
        let temp_dir = TempDir::new().unwrap();
        let wav_path = temp_dir.path().join("stereo.wav");

        // Create a stereo WAV
        let spec = hound::WavSpec {
            channels: 2, // Stereo
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(&wav_path, spec).unwrap();
        writer.write_sample(0i16).unwrap();
        writer.write_sample(0i16).unwrap();
        writer.finalize().unwrap();

        let result = load_audio_samples(&wav_path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("mono"));
    }
}
