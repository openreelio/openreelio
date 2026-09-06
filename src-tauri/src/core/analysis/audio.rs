//! Audio Profiling Module
//!
//! Extracts audio characteristics from video files using FFmpeg filters.
//! Part of the reference video analysis pipeline (ADR-048, Group 2).
//!
//! Produces an [`AudioProfile`] containing BPM estimation, loudness curves,
//! spectral centroid, and silence region detection.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use uuid::Uuid;
use webrtc_vad::{SampleRate as VadSampleRate, Vad, VadMode};

use super::ducking::invert_silence_to_speech;
use super::loudness::{
    is_audible, loudness_filter_chain, parse_astats_overall, parse_loudness_summary,
    parse_momentary_series, per_second_loudness_profile, MOMENTARY_SAMPLES_PER_SECOND,
};
use super::types::{
    AudioProfile, SilenceRegion, SpeechRegion, AUDIO_MEASUREMENT_VERSION, SILENCE_FLOOR_DB,
};
use crate::core::captions::audio::{extract_audio_for_transcription_async, load_audio_samples_i16};
use crate::core::ffmpeg::{capture_filter_stderr, FFmpegError, FilterMode};
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Constants
// =============================================================================

/// Silence detection noise floor threshold in dB
const SILENCE_THRESHOLD_DB: &str = "-40dB";

/// Minimum silence duration in seconds
const SILENCE_MIN_DURATION: &str = "0.5";

/// Peak detection threshold in dB: a sample must exceed both neighbors by
/// at least this amount to be considered a rhythmic onset.
const PEAK_THRESHOLD_DB: f64 = 3.0;

/// Approximate sampling rate of FFmpeg `ebur128` momentary loudness output.
const LOUDNESS_SAMPLES_PER_SECOND: f64 = MOMENTARY_SAMPLES_PER_SECOND;

/// Minimum number of detected peaks required for BPM estimation.
const MIN_PEAKS_FOR_BPM: usize = 4;

/// Minimum valid BPM (clamp lower bound)
const MIN_BPM: f64 = 30.0;

/// Maximum valid BPM (clamp upper bound)
const MAX_BPM: f64 = 300.0;

/// Number of tail lines to keep from FFmpeg stderr for error reporting.
const STDERR_TAIL_SIZE: usize = 20;

/// Watchdog timeout for a single FFmpeg analysis pass.
///
/// Matches the analysis job budget elsewhere in the pipeline; without it a
/// stalled decoder would hang the calling job forever.
const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(600);

/// Opening words of the message an analysis pass reports when it times out.
///
/// Wording only: nothing classifies a failure by reading it back. The reason a
/// pass failed travels as [`FilterPassFailure`], decided where the evidence is.
const ANALYSIS_TIMEOUT_MARKER: &str = "Audio analysis timed out";

/// Opening words of the message reported when the FFmpeg process never ran.
///
/// Wording only, like [`ANALYSIS_TIMEOUT_MARKER`].
const FFMPEG_SPAWN_FAILURE_MARKER: &str = "Failed to run FFmpeg";

/// Diagnostic shape FFmpeg prints when the filter a pass asked for is missing.
///
/// Matched against raw FFmpeg stderr, at the point of capture — never against a
/// message that has already had that stderr formatted into it.
///
/// The whole diagnostic shape is matched rather than the words, and one line at
/// a time. Raw stderr always echoes the input path (`Error opening input file
/// <path>.`), so matching the bare words let a file named
/// `broken No such filter.mp4` classify its own decode error as a missing
/// filter. A real diagnostic is emitted by the filter graph, so it carries that
/// context's `[AVFilterGraph @ 0x…] ` prefix and quotes the filter name:
/// `[AVFilterGraph @ 0x1] No such filter: 'ebur128'`.
///
/// This is the only shape a *pass* can hit. FFmpeg also has an
/// `Unknown filter '<name>'.` message, but the only caller is the `-h filter=`
/// help path, which prints it unprefixed and exits 0 — no filter graph is ever
/// built there, so a pass can never see it.
const MISSING_FILTER_MARKER: &str = "] No such filter: '";

/// Words shared by every FFmpeg diagnostic for "this output has no streams".
///
/// The sentence they belong to is what actually classifies the line; see
/// [`line_reports_no_audio_stream`].
const NO_AUDIO_STREAM_MARKER: &str = "does not contain any stream";

/// VAD frame size in milliseconds.
const VAD_FRAME_MS: usize = 30;

/// VAD frame size in samples at 16 kHz.
const VAD_FRAME_SAMPLES: usize = 480;

/// Merge adjacent voiced regions separated by short gaps.
const VAD_MAX_GAP_SEC: f64 = 0.25;

/// Drop very short speech regions that are likely false positives.
const VAD_MIN_SPEECH_SEC: f64 = 0.18;

// =============================================================================
// AudioProfiler
// =============================================================================

/// Analyzes audio tracks in video files using FFmpeg filters.
///
/// Runs multiple FFmpeg filter passes (silence detection, EBU R128 loudness,
/// spectral centroid) and combines the results into a single [`AudioProfile`].
pub struct AudioProfiler {
    ffmpeg_path: PathBuf,
}

impl AudioProfiler {
    /// Creates a new audio profiler with the given FFmpeg binary path.
    pub fn new(ffmpeg_path: PathBuf) -> Self {
        Self { ffmpeg_path }
    }

    /// Analyzes the audio track of a video file and returns a complete audio profile.
    ///
    /// Runs silence detection, loudness metering, and spectral analysis in
    /// parallel via `tokio::join!`. If the video has no audio stream, returns
    /// [`AudioProfile::silent`] instead.
    ///
    /// A loudness pass that fails or measures nothing does not fail the whole
    /// analysis: the silence regions, speech regions and spectral centroid are
    /// three independent FFmpeg passes and they are what most of the pipeline
    /// actually reads. The profile comes back with its loudness fields
    /// unmeasured and the reason in [`AudioAnalysis::loudness_error`], so the
    /// caller can record the gap without discarding the rest.
    ///
    /// # Errors
    ///
    /// Only silence detection is load-bearing enough to fail the pass: without
    /// it there are no regions and nothing downstream has anything to work
    /// with.
    pub async fn analyze(&self, video_path: &Path, duration_sec: f64) -> CoreResult<AudioAnalysis> {
        // Run all three analysis passes in parallel
        let (silence_result, loudness_result, spectral_result) = tokio::join!(
            self.detect_silence(video_path),
            self.extract_loudness_and_peak(video_path),
            self.extract_spectral_centroid(video_path),
        );

        // If all three fail with a "no audio stream" indicator, return silent profile
        let silence_no_audio = matches!(&silence_result, Err(FilterPassFailure::NoAudioStream));
        let loudness_no_audio =
            matches!(&loudness_result, Err(failure) if failure.is_no_audio_stream());
        let spectral_no_audio = matches!(&spectral_result, Err(FilterPassFailure::NoAudioStream));

        if silence_no_audio && loudness_no_audio && spectral_no_audio {
            tracing::debug!(
                "No audio stream detected in {}, returning silent profile",
                video_path.display()
            );
            return Ok(AudioAnalysis::measured(AudioProfile::silent(duration_sec)));
        }

        let silence_regions = silence_result?;
        // A failed loudness pass costs the loudness fields, not the profile.
        let (loudness, loudness_error) = match loudness_result {
            Ok(measurement) => (measurement, None),
            Err(error) => {
                let failure = error.into_loudness_failure();
                tracing::warn!(
                    input = %video_path.display(),
                    error = %failure.message,
                    transient = failure.is_transient(),
                    "Loudness measurement failed; the audio profile keeps its regions \
                     and reports its loudness as unmeasured"
                );
                (LoudnessMeasurement::default(), Some(failure))
            }
        };
        let spectral_centroid_hz = spectral_result.unwrap_or_else(|err| {
            tracing::debug!(
                "Spectral centroid extraction failed, defaulting to 0.0: {}",
                err
            );
            0.0
        });

        // Onset detection scans the full positional series, silence included:
        // an index is only a time while every reading holds its slot, and
        // dropping the silent ones would turn a ten-second pause into an
        // adjacent pair of samples and invent a beat out of it. The peak test
        // itself skips the silent readings instead (see
        // [`Self::estimate_bpm_from_samples`]).
        let bpm =
            Self::estimate_bpm_from_samples(&loudness.momentary_lufs, LOUDNESS_SAMPLES_PER_SECOND)
                .or_else(|| Self::estimate_bpm(&loudness.loudness_profile));
        let speech_regions = match self
            .detect_speech_regions_vad(video_path, duration_sec)
            .await
        {
            Ok(regions) => regions,
            Err(err) => {
                tracing::debug!(
                    "Speech VAD failed, falling back to silence inversion: {}",
                    err
                );
                derive_speech_regions_from_silence(&silence_regions, duration_sec)
            }
        };

        let peak_db = loudness.peak_db();

        Ok(AudioAnalysis {
            profile: AudioProfile {
                measurement_version: AUDIO_MEASUREMENT_VERSION,
                bpm,
                spectral_centroid_hz,
                loudness_profile: loudness.loudness_profile,
                peak_db,
                integrated_lufs: loudness.integrated_lufs,
                loudness_range_lu: loudness.loudness_range_lu,
                true_peak_dbtp: loudness.true_peak_dbtp,
                silence_regions,
                speech_regions,
                loudness_measured: loudness_error.is_none(),
            },
            loudness_error,
        })
    }

    // =========================================================================
    // Silence Detection
    // =========================================================================

    /// Detects regions of silence using FFmpeg's `silencedetect` filter.
    ///
    /// Parses stderr for `silence_start` and `silence_end` markers.
    async fn detect_silence(
        &self,
        video_path: &Path,
    ) -> Result<Vec<SilenceRegion>, FilterPassFailure> {
        let filter = format!(
            "silencedetect=n={}:d={}",
            SILENCE_THRESHOLD_DB, SILENCE_MIN_DURATION
        );
        let capture = self.run_ffmpeg_filter(video_path, &filter).await?;
        Ok(parse_silence_regions(&capture.stderr))
    }

    /// Detects silence regions with custom threshold and minimum duration.
    ///
    /// Unlike `detect_silence()` which uses fixed defaults (-40dB / 0.5s),
    /// this allows callers to specify sensitivity for cleanup workflows.
    pub async fn detect_silence_custom(
        &self,
        video_path: &Path,
        threshold_db: f64,
        min_duration_sec: f64,
    ) -> CoreResult<Vec<SilenceRegion>> {
        if !threshold_db.is_finite() || !min_duration_sec.is_finite() {
            return Err(CoreError::ValidationError(
                "threshold_db and min_duration_sec must be finite values".to_string(),
            ));
        }

        let threshold = format!("{}dB", threshold_db.clamp(-90.0, 0.0));
        let duration = format!("{:.3}", min_duration_sec.clamp(0.01, 30.0));
        let filter = format!("silencedetect=n={}:d={}", threshold, duration);
        let capture = self.run_ffmpeg_filter(video_path, &filter).await?;
        Ok(parse_silence_regions(&capture.stderr))
    }

    /// Detect speech regions using a lightweight WebRTC VAD pass.
    async fn detect_speech_regions_vad(
        &self,
        video_path: &Path,
        duration_sec: f64,
    ) -> CoreResult<Vec<SpeechRegion>> {
        let temp_audio_path =
            std::env::temp_dir().join(format!("openreelio-vad-{}.wav", Uuid::new_v4()));
        let temp_audio_path_for_cleanup = temp_audio_path.clone();
        let ffmpeg_path = self.ffmpeg_path.to_string_lossy().to_string();

        let result = async {
            extract_audio_for_transcription_async(video_path, &temp_audio_path, Some(&ffmpeg_path))
                .await
                .map_err(map_audio_extraction_error)?;

            let audio_path_for_task = temp_audio_path.clone();
            tokio::task::spawn_blocking(move || {
                let samples = load_audio_samples_i16(&audio_path_for_task)
                    .map_err(map_audio_extraction_error)?;
                detect_speech_regions_from_pcm(&samples, duration_sec)
            })
            .await
            .map_err(|error| {
                CoreError::AnalysisFailed(format!("Speech VAD task panicked: {}", error))
            })?
        }
        .await;

        let _ = tokio::fs::remove_file(&temp_audio_path_for_cleanup).await;
        result
    }

    // =========================================================================
    // Loudness & Peak Extraction
    // =========================================================================

    /// Measures loudness and peak with the shared EBU R128 / true-peak pass.
    ///
    /// The filter chain comes from [`super::loudness`], so this profile and the
    /// rendered-file QC measurement agree by construction. Momentary readings
    /// drive the per-second profile and BPM estimation; the summary block
    /// supplies the program-level numbers.
    async fn extract_loudness_and_peak(
        &self,
        video_path: &Path,
    ) -> Result<LoudnessMeasurement, LoudnessPassFailure> {
        if let Some(latched) =
            latched_missing_loudness_filter(loudness_filter_latch(), &self.ffmpeg_path)
        {
            return Err(LoudnessPassFailure::Pass(latched));
        }

        let capture = match self
            .run_ffmpeg_filter(video_path, &loudness_filter_chain())
            .await
        {
            Ok(capture) => capture,
            Err(failure) => {
                if let FilterPassFailure::MissingFilter { stderr_tail } = &failure {
                    latch_missing_loudness_filter(
                        loudness_filter_latch(),
                        &self.ffmpeg_path,
                        stderr_tail,
                    );
                }
                return Err(LoudnessPassFailure::Pass(failure));
            }
        };
        measure_loudness(&capture.stderr).map_err(LoudnessPassFailure::Meter)
    }

    // =========================================================================
    // Spectral Centroid
    // =========================================================================

    /// Extracts the average spectral centroid frequency in Hz.
    ///
    /// Uses FFmpeg's `aspectralstats` filter to compute per-frame spectral
    /// centroids and averages them. Returns 0.0 gracefully if the filter is
    /// unavailable in the current FFmpeg build.
    async fn extract_spectral_centroid(&self, video_path: &Path) -> Result<f64, FilterPassFailure> {
        let filter =
            "aspectralstats=measure=centroid,ametadata=mode=print:key=lavfi.aspectralstats.1.centroid";

        match self.run_ffmpeg_filter(video_path, filter).await {
            Ok(capture) => Ok(parse_spectral_centroid(&capture.stderr)),
            Err(err) => {
                // Only swallow explicit missing-filter errors; other failures propagate.
                if matches!(err, FilterPassFailure::MissingFilter { .. }) {
                    tracing::debug!("aspectralstats filter unavailable, returning 0.0 Hz");
                    Ok(0.0)
                } else {
                    Err(err)
                }
            }
        }
    }

    // =========================================================================
    // BPM Estimation (Pure Function)
    // =========================================================================

    /// Estimates beats per minute from a per-second loudness profile.
    ///
    /// Detects local peaks in the loudness data (values exceeding both
    /// neighbors by more than [`PEAK_THRESHOLD_DB`]) and computes the
    /// median inter-onset interval. Returns `None` if fewer than
    /// [`MIN_PEAKS_FOR_BPM`] peaks are detected. The result is clamped
    /// to the 30-300 BPM range.
    ///
    /// The profile must be positional - entry `i` covers second `i`, silent
    /// seconds included - because the interval between two peaks is read off
    /// their indices.
    pub fn estimate_bpm(loudness_profile: &[f64]) -> Option<f64> {
        Self::estimate_bpm_from_samples(loudness_profile, 1.0)
    }

    /// Estimates beats per minute from a positional, sampled loudness series.
    ///
    /// `loudness_samples` keeps its silent slots: index over
    /// `samples_per_second` is the only thing that makes an inter-onset
    /// interval a duration, and a filtered series collapses every pause it
    /// contains. A silent reading is therefore skipped as a *candidate* rather
    /// than removed (a peak needs an audible value and two audible
    /// neighbours), so the edge of a silence, which clears
    /// [`PEAK_THRESHOLD_DB`] by tens of dB against the floor sentinel, cannot
    /// be mistaken for an onset.
    fn estimate_bpm_from_samples(loudness_samples: &[f64], samples_per_second: f64) -> Option<f64> {
        if loudness_samples.len() < 3
            || samples_per_second <= 0.0
            || !samples_per_second.is_finite()
        {
            return None;
        }

        // Find local peak indices
        let mut peak_indices: Vec<usize> = Vec::new();
        for i in 1..loudness_samples.len() - 1 {
            let current = loudness_samples[i];
            let prev = loudness_samples[i - 1];
            let next = loudness_samples[i + 1];

            if !is_audible(current) || !is_audible(prev) || !is_audible(next) {
                continue;
            }

            if current - prev > PEAK_THRESHOLD_DB && current - next > PEAK_THRESHOLD_DB {
                peak_indices.push(i);
            }
        }

        if peak_indices.len() < MIN_PEAKS_FOR_BPM {
            return None;
        }

        // Calculate inter-onset intervals in seconds from sample indices.
        let mut ioi: Vec<f64> = Vec::with_capacity(peak_indices.len() - 1);
        for pair in peak_indices.windows(2) {
            ioi.push((pair[1] - pair[0]) as f64 / samples_per_second);
        }

        if ioi.is_empty() {
            return None;
        }

        // Sort for median calculation
        ioi.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median_ioi = ioi[ioi.len() / 2];

        if median_ioi <= 0.0 {
            return None;
        }

        let bpm = 60.0 / median_ioi;
        Some(bpm.clamp(MIN_BPM, MAX_BPM))
    }

    // =========================================================================
    // FFmpeg Helper
    // =========================================================================

    /// Runs FFmpeg with the given audio filter and returns the whole capture.
    ///
    /// Delegates spawning, bounded stderr retention, and the watchdog timeout to
    /// [`capture_filter_stderr`]; only the audio-specific interpretation of the
    /// result (missing audio stream vs. genuine failure) lives here.
    ///
    /// The [`FilterCapture`] is returned rather than just its text so the
    /// truncation flag is not silently dropped: per-frame filters such as
    /// `aspectralstats` overflow the retention limit on very long inputs, and a
    /// parser fed the surviving tail would average only the end of the file.
    /// Truncation is logged here — the audio profile has no warnings channel to
    /// carry it — so an unexpectedly flat measurement is at least traceable.
    ///
    /// [`FilterCapture`]: crate::core::ffmpeg::FilterCapture
    async fn run_ffmpeg_filter(
        &self,
        video_path: &Path,
        filter: &str,
    ) -> Result<crate::core::ffmpeg::FilterCapture, FilterPassFailure> {
        let capture = capture_filter_stderr(
            &self.ffmpeg_path,
            video_path,
            FilterMode::Audio(filter),
            ANALYSIS_TIMEOUT,
        )
        .await
        .map_err(|error| match error {
            FFmpegError::Timeout => FilterPassFailure::TimedOut,
            other => FilterPassFailure::NotRun(other.to_string()),
        })?;

        // Every cause below is a *failed* pass, and only a failed pass is read
        // for one. A pass that exits 0 measured the file: FFmpeg refuses an
        // output with no streams before it writes anything (exit 127 on the
        // bundled 9.0.1), so a successful capture cannot be a missing audio
        // stream — while its text routinely quotes the input path, and a file
        // under `b-roll no audio/` used to talk a clean pass into reporting
        // silence it never measured.
        if !capture.success {
            if has_no_audio_indicator(&capture.stderr) {
                return Err(FilterPassFailure::NoAudioStream);
            }

            let stderr_tail = capture.stderr_tail(STDERR_TAIL_SIZE);
            // Decided here, over raw FFmpeg stderr, because this is the last
            // place the two are still separable: once the tail is formatted
            // into a message, a media path or a caption quoting the words
            // would read back as a missing filter.
            if has_missing_filter_indicator(&capture.stderr) {
                return Err(FilterPassFailure::MissingFilter { stderr_tail });
            }

            return Err(FilterPassFailure::Failed {
                exit_code: capture.exit_code.unwrap_or(-1),
                stderr_tail,
            });
        }

        if capture.truncated {
            tracing::warn!(
                filter = %filter,
                input = %video_path.display(),
                "FFmpeg filter output exceeded the stderr retention limit; \
                 the parsed result covers only the end of the input"
            );
        }

        Ok(capture)
    }
}

// =============================================================================
// Parsing Helpers (testable without FFmpeg)
// =============================================================================

/// Checks whether FFmpeg output says the input carried no audio stream.
///
/// Only ever asked of a *failed* pass — `AudioProfiler::run_ffmpeg_filter`
/// checks the exit status first, and `map_audio_extraction_error` only sees an
/// error — and one line at a time, against the whole diagnostic sentence rather
/// than the words in it.
fn has_no_audio_indicator(stderr: &str) -> bool {
    stderr.lines().any(line_reports_no_audio_stream)
}

/// Whether one FFmpeg stderr line is the "this output has no streams" refusal.
///
/// An audio pass over a video-only input reaches it by construction: `-vn`
/// drops the video and the audio filter has nothing to read, so the muxer is
/// handed an output with no streams and refuses it. FFmpeg 9 prints
/// `[out#0/null @ 0x…] Output file does not contain any stream`; builds before
/// the context prefix printed `Output file #0 does not contain any stream`.
///
/// Both open the sentence with `Output file`, and the echoed input path never
/// does — it arrives as `Error opening input file <path>.` — which is what
/// keeps a file *named* after the diagnostic from claiming it. The old matcher
/// took the bare words over the whole capture, so `b-roll no audio/clip.wav`
/// came back as digital silence it had never been measured for.
fn line_reports_no_audio_stream(line: &str) -> bool {
    let Some((head, _)) = line.split_once(NO_AUDIO_STREAM_MARKER) else {
        return false;
    };

    // Strip the logging context, but only where FFmpeg itself puts one: a `] `
    // anywhere else in the line belongs to the message, quite possibly to a
    // path inside it.
    let sentence = match head.strip_prefix('[') {
        Some(after_open) => match after_open.split_once("] ") {
            Some((_, sentence)) => sentence,
            None => return false,
        },
        None => head,
    };

    sentence.starts_with("Output file")
}

/// Checks whether FFmpeg stderr says the requested filter is not in this build.
///
/// One line at a time, against the whole diagnostic shape: see
/// [`MISSING_FILTER_MARKER`] for why the bare words are not enough.
fn has_missing_filter_indicator(stderr: &str) -> bool {
    stderr
        .lines()
        .any(|line| line.contains(MISSING_FILTER_MARKER))
}

// =============================================================================
// Missing-Filter Latch
// =============================================================================

/// One binary's recorded refusal to build the loudness filter chain.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MissingLoudnessFilter {
    /// The FFmpeg binary that reported it. Another binary is not covered.
    ffmpeg_path: PathBuf,
    /// The stderr tail of that refusal, replayed so the message never changes.
    stderr_tail: String,
}

/// The process-wide latch backing [`loudness_filter_latch`].
static LOUDNESS_FILTER_LATCH: OnceLock<Mutex<Option<MissingLoudnessFilter>>> = OnceLock::new();

/// Returns the latch recording which FFmpeg binary has no loudness filter.
///
/// A missing filter stays classified transient, because which filters exist is
/// a property of the FFmpeg install and an install changes between launches.
/// Within one launch it does not: without this latch every asset paid for its
/// own full decode to be told the same thing by the same binary, and a library
/// import turned one missing filter into one wasted decode per asset.
///
/// Keyed on the resolved binary path, so a build swapped in mid-launch — the
/// user pointing `OPENREELIO_FFMPEG_PATH` somewhere else, a managed download
/// finishing — is tried on its own merits. A binary replaced *in place* keeps
/// the latch until the next launch, which is the same bound the transient
/// classification already promised.
fn loudness_filter_latch() -> &'static Mutex<Option<MissingLoudnessFilter>> {
    LOUDNESS_FILTER_LATCH.get_or_init(|| Mutex::new(None))
}

/// Replays the recorded refusal when `ffmpeg_path` is the binary that gave it.
///
/// A poisoned latch answers `None`: paying for a decode is the safe direction
/// when the record cannot be read.
fn latched_missing_loudness_filter(
    latch: &Mutex<Option<MissingLoudnessFilter>>,
    ffmpeg_path: &Path,
) -> Option<FilterPassFailure> {
    let latched = latch.lock().ok()?;
    let recorded = latched.as_ref()?;

    (recorded.ffmpeg_path.as_path() == ffmpeg_path).then(|| FilterPassFailure::MissingFilter {
        stderr_tail: recorded.stderr_tail.clone(),
    })
}

/// Records that `ffmpeg_path` could not build the loudness filter chain.
///
/// Replaces any earlier record: only the binary a pass just ran against is
/// worth short-circuiting, and the previous one may well be gone.
fn latch_missing_loudness_filter(
    latch: &Mutex<Option<MissingLoudnessFilter>>,
    ffmpeg_path: &Path,
    stderr_tail: &str,
) {
    if let Ok(mut latched) = latch.lock() {
        *latched = Some(MissingLoudnessFilter {
            ffmpeg_path: ffmpeg_path.to_path_buf(),
            stderr_tail: stderr_tail.to_string(),
        });
    }
}

fn map_audio_extraction_error(
    error: crate::core::captions::audio::AudioExtractionError,
) -> CoreError {
    let message = error.to_string();
    if has_no_audio_indicator(&message) {
        CoreError::Internal("No audio stream found in input".to_string())
    } else {
        CoreError::AnalysisFailed(format!("Speech VAD audio extraction failed: {}", message))
    }
}

fn detect_speech_regions_from_pcm(
    samples: &[i16],
    duration_sec: f64,
) -> CoreResult<Vec<SpeechRegion>> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let mut vad = Vad::new_with_rate_and_mode(VadSampleRate::Rate16kHz, VadMode::LowBitrate);
    let mut voiced_frames = Vec::with_capacity(samples.len() / VAD_FRAME_SAMPLES);

    for frame in samples.chunks(VAD_FRAME_SAMPLES) {
        if frame.len() != VAD_FRAME_SAMPLES {
            break;
        }

        let is_voiced = vad.is_voice_segment(frame).map_err(|_| {
            CoreError::AnalysisFailed("Speech VAD received an invalid frame length".to_string())
        })?;
        voiced_frames.push(is_voiced);
    }

    Ok(speech_regions_from_voiced_flags(
        &voiced_frames,
        duration_sec,
        VAD_FRAME_MS as f64 / 1000.0,
    ))
}

fn speech_regions_from_voiced_flags(
    voiced_frames: &[bool],
    duration_sec: f64,
    frame_duration_sec: f64,
) -> Vec<SpeechRegion> {
    if voiced_frames.is_empty() || duration_sec <= 0.0 || frame_duration_sec <= 0.0 {
        return Vec::new();
    }

    let mut regions = Vec::new();
    let mut active_start: Option<usize> = None;

    for (index, is_voiced) in voiced_frames.iter().copied().enumerate() {
        match (active_start, is_voiced) {
            (None, true) => active_start = Some(index),
            (Some(start_index), false) => {
                regions.push(SpeechRegion::new(
                    start_index as f64 * frame_duration_sec,
                    index as f64 * frame_duration_sec,
                ));
                active_start = None;
            }
            _ => {}
        }
    }

    if let Some(start_index) = active_start {
        regions.push(SpeechRegion::new(
            start_index as f64 * frame_duration_sec,
            voiced_frames.len() as f64 * frame_duration_sec,
        ));
    }

    let mut merged: Vec<SpeechRegion> = Vec::new();
    for region in regions {
        let start_sec = region.start_sec.clamp(0.0, duration_sec);
        let end_sec = region.end_sec.clamp(start_sec, duration_sec);
        if end_sec <= start_sec {
            continue;
        }

        let region = SpeechRegion::new(start_sec, end_sec);
        if let Some(last) = merged.last_mut() {
            if region.start_sec <= last.end_sec + VAD_MAX_GAP_SEC {
                last.end_sec = last.end_sec.max(region.end_sec);
                continue;
            }
        }
        merged.push(region);
    }

    merged
        .into_iter()
        .filter(|region| region.duration() >= VAD_MIN_SPEECH_SEC)
        .collect()
}

fn derive_speech_regions_from_silence(
    silence_regions: &[SilenceRegion],
    duration_sec: f64,
) -> Vec<SpeechRegion> {
    invert_silence_to_speech(silence_regions, duration_sec)
        .into_iter()
        .map(|region| SpeechRegion::new(region.start_sec, region.end_sec))
        .collect()
}

/// Parses silence regions from FFmpeg `silencedetect` filter stderr output.
///
/// Expects lines in the form:
/// ```text
/// [silencedetect @ ...] silence_start: 1.234
/// [silencedetect @ ...] silence_end: 5.678 | silence_duration: 4.444
/// ```
pub(crate) fn parse_silence_regions(stderr: &str) -> Vec<SilenceRegion> {
    let mut regions = Vec::new();
    let mut current_start: Option<f64> = None;

    for line in stderr.lines() {
        if let Some(start_val) = extract_silence_start(line) {
            current_start = Some(start_val);
        } else if let Some(end_val) = extract_silence_end(line) {
            if let Some(start) = current_start.take() {
                regions.push(SilenceRegion::new(start, end_val));
            }
        }
    }

    regions
}

/// Extracts the time value from a `silence_start:` line.
fn extract_silence_start(line: &str) -> Option<f64> {
    if !line.contains("silence_start:") {
        return None;
    }
    let marker = "silence_start:";
    let pos = line.find(marker)?;
    let rest = line[pos + marker.len()..].trim();
    // Take characters until whitespace or end of string
    let num_str: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
    num_str.parse::<f64>().ok()
}

/// Extracts the time value from a `silence_end:` line.
fn extract_silence_end(line: &str) -> Option<f64> {
    if !line.contains("silence_end:") {
        return None;
    }
    let marker = "silence_end:";
    let pos = line.find(marker)?;
    let rest = line[pos + marker.len()..].trim();
    let num_str: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
    num_str.parse::<f64>().ok()
}

/// Why one FFmpeg filter pass produced no capture.
///
/// Each variant is decided where the evidence still is — the watchdog, the
/// spawn result, the raw stderr — so no caller has to read a formatted message
/// back to learn what happened. The message is for humans only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FilterPassFailure {
    /// The watchdog fired before FFmpeg finished.
    TimedOut,
    /// FFmpeg never ran to completion: a missing input path, a process that
    /// would not spawn, an I/O error while waiting for it.
    NotRun(String),
    /// The input carries no audio stream for the filter to read.
    NoAudioStream,
    /// This FFmpeg build does not have the filter the pass asked for.
    MissingFilter {
        /// Tail of the FFmpeg stderr, for the message.
        stderr_tail: String,
    },
    /// FFmpeg ran and exited non-zero for some other reason.
    Failed {
        /// The process exit code, or `-1` when it reported none.
        exit_code: i32,
        /// Tail of the FFmpeg stderr, for the message.
        stderr_tail: String,
    },
}

impl FilterPassFailure {
    /// Whether a later pass over the same media could still succeed.
    ///
    /// Only one cause is settled: an input with no audio stream, which is a
    /// property of the file and will read the same way forever. Everything else
    /// — the watchdog, a process that would not start, a non-zero exit carrying
    /// a decode or I/O error — says nothing about the media that the next pass
    /// has to repeat.
    ///
    /// A missing filter is transient too, and deliberately so: which filters
    /// exist is a property of the FFmpeg install, and that can change between
    /// launches — a bundled binary replaced by an update, a system FFmpeg the
    /// user just installed.
    ///
    /// On its own that optimism costs one decode per asset per launch, which a
    /// library import multiplies by the whole library. [`loudness_filter_latch`]
    /// is what bounds it to one: the first refusal records the binary that gave
    /// it, and every later loudness pass against that same binary replays the
    /// recorded failure without decoding anything.
    pub(crate) fn kind(&self) -> LoudnessFailureKind {
        match self {
            Self::NoAudioStream => LoudnessFailureKind::Unmeasurable,
            Self::TimedOut | Self::NotRun(_) | Self::MissingFilter { .. } | Self::Failed { .. } => {
                LoudnessFailureKind::Transient
            }
        }
    }
}

impl std::fmt::Display for FilterPassFailure {
    /// Renders the reason on its own, with no verdict of its own in front.
    ///
    /// Every recorded form of this message already carries a prefix naming what
    /// failed — `"Loudness measurement failed: "` for a meter-only failure,
    /// `"Audio analysis failed: "` for a whole pass; see
    /// [`crate::core::analysis::remeasure`]. Opening with "Audio analysis
    /// failed" here as well produced the stutter agents were reading back.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TimedOut => write!(
                f,
                "{} after {}s",
                ANALYSIS_TIMEOUT_MARKER,
                ANALYSIS_TIMEOUT.as_secs()
            ),
            Self::NotRun(reason) => write!(f, "{}: {}", FFMPEG_SPAWN_FAILURE_MARKER, reason),
            Self::NoAudioStream => write!(f, "No audio stream found in input"),
            Self::MissingFilter { stderr_tail } => {
                write!(f, "This FFmpeg build has no such filter: {}", stderr_tail)
            }
            Self::Failed {
                exit_code,
                stderr_tail,
            } => write!(f, "FFmpeg exited {}: {}", exit_code, stderr_tail),
        }
    }
}

impl From<FilterPassFailure> for CoreError {
    /// Carries the verdict across the [`CoreError`] boundary in the variant.
    ///
    /// A settled failure becomes [`CoreError::AnalysisFailed`] and a transient
    /// one [`CoreError::Internal`], which is what lets
    /// [`LoudnessFailure::from_error`] classify a whole-pass error without
    /// matching words inside a message that embeds stderr.
    fn from(failure: FilterPassFailure) -> Self {
        match failure.kind() {
            LoudnessFailureKind::Unmeasurable => CoreError::AnalysisFailed(failure.to_string()),
            LoudnessFailureKind::Transient => CoreError::Internal(failure.to_string()),
        }
    }
}

/// Why the loudness pass produced no measurement.
///
/// Kept apart from [`LoudnessFailure`] for the length of the pass because
/// `analyze` needs one thing the rendered message cannot tell it: whether the
/// input has an audio stream at all.
#[derive(Debug)]
pub(crate) enum LoudnessPassFailure {
    /// The FFmpeg pass never handed the meter anything to read.
    Pass(FilterPassFailure),
    /// The capture came back and [`measure_loudness`] refused it.
    Meter(CoreError),
}

impl LoudnessPassFailure {
    /// Whether this pass failed because the input has no audio stream.
    pub(crate) fn is_no_audio_stream(&self) -> bool {
        matches!(self, Self::Pass(FilterPassFailure::NoAudioStream))
    }

    /// Renders the failure as the verdict stored against the profile.
    pub(crate) fn into_loudness_failure(self) -> LoudnessFailure {
        match self {
            Self::Pass(failure) => LoudnessFailure {
                message: failure.to_string(),
                kind: failure.kind(),
            },
            Self::Meter(error) => LoudnessFailure::from_error(&error),
        }
    }
}

/// Whether a failed loudness pass could still produce numbers on a later run.
///
/// Read by the re-measure gate in [`crate::core::analysis::remeasure`]: only a
/// transient failure earns another full decode of the asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoudnessFailureKind {
    /// The pass never reached a verdict about the media.
    ///
    /// It ran out of time, FFmpeg could not be started at all, the build had no
    /// such filter, or the process exited non-zero on something — a read error,
    /// a killed decoder, a machine out of resources — that the next run need not
    /// hit. Nothing here is a property of the file, so the same asset is worth
    /// one more pass once the machine or the install has moved on. This is the
    /// default: a cause has to be recognised as settled before it costs the
    /// asset its numbers forever.
    Transient,
    /// The pass ran and its output could not be turned into numbers.
    ///
    /// A meter that measured nothing, frame lines carrying no readable
    /// momentary token, an input with no audio stream: each is a property of
    /// this media, and paying for the decode again reaches the same verdict.
    Unmeasurable,
}

/// Why the loudness fields of an audio profile came back unmeasured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoudnessFailure {
    /// The reason, as reported by the pass that failed.
    pub message: String,
    /// Whether a later attempt could still succeed.
    pub kind: LoudnessFailureKind,
}

impl LoudnessFailure {
    /// Classifies a failure that has already been flattened into a [`CoreError`].
    ///
    /// The variant carries the verdict, and only the variant: a settled cause —
    /// output [`measure_loudness`] refused, an input with no audio stream —
    /// arrives as [`CoreError::AnalysisFailed`], and everything else is
    /// transient. Reading the *message* instead is how
    /// the classifier used to default to permanent: a decode that died on
    /// `Input/output error` carried no marker, so it was filed as a verdict
    /// about the media and the asset never got another pass.
    ///
    /// Prefer classifying at the pass — `LoudnessPassFailure` and
    /// `FilterPassFailure::kind` — where the cause is still structured. This
    /// is for callers holding nothing else, such as a whole analysis pass that
    /// failed before the loudness result existed.
    pub fn from_error(error: &CoreError) -> Self {
        let kind = match error {
            CoreError::AnalysisFailed(_) => LoudnessFailureKind::Unmeasurable,
            _ => LoudnessFailureKind::Transient,
        };

        Self {
            message: error.to_string(),
            kind,
        }
    }

    /// Returns `true` when another pass could still produce numbers.
    pub fn is_transient(&self) -> bool {
        self.kind == LoudnessFailureKind::Transient
    }
}

/// One audio analysis pass: the profile it produced and what it could not measure.
///
/// Separate from [`AudioProfile`] because the profile is the cached artifact
/// and this is the run report. The loudness fields can come back unmeasured
/// while the regions are perfectly good, and the caller needs the reason to
/// record against the bundle.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioAnalysis {
    /// The profile to cache. Always present, even when loudness failed.
    pub profile: AudioProfile,
    /// Why the loudness fields are unmeasured, when they are.
    pub loudness_error: Option<LoudnessFailure>,
}

impl AudioAnalysis {
    /// Wraps a profile whose loudness pass succeeded.
    pub fn measured(profile: AudioProfile) -> Self {
        Self {
            profile,
            loudness_error: None,
        }
    }
}

/// Everything the loudness pass measured for one asset.
///
/// Kept as a struct rather than a tuple because the pass now yields both
/// per-window readings (profile, BPM) and program-level values (integrated
/// loudness, true peak) that callers pick from independently.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct LoudnessMeasurement {
    /// Per-second average of the momentary readings, in LUFS.
    pub loudness_profile: Vec<f64>,
    /// Raw momentary readings at roughly 10 Hz, in LUFS.
    pub momentary_lufs: Vec<f64>,
    /// Integrated program loudness in LUFS, when the summary reported one.
    pub integrated_lufs: Option<f64>,
    /// Loudness range in LU, when the summary reported one.
    pub loudness_range_lu: Option<f64>,
    /// True peak in dBTP, when the FFmpeg build measured one.
    pub true_peak_dbtp: Option<f64>,
    /// Sample peak in dBFS reported by `astats`.
    pub sample_peak_db: Option<f64>,
}

impl LoudnessMeasurement {
    /// Returns the peak level to report, in dB relative to full scale.
    ///
    /// True peak is preferred because it accounts for inter-sample overs; the
    /// `astats` sample peak stands in on builds without true-peak support. The
    /// measured value is reported as measured — a quiet master really can peak
    /// below the silence floor, and clamping it would invent a level the file
    /// does not have. The floor is reached only when both fields are empty,
    /// which for a completed pass means the input was digital silence:
    /// [`measure_loudness`] rejects a pass that measured nothing at all, and a
    /// pass that never completed is published with
    /// `AudioProfile::loudness_measured` clear rather than as a level.
    pub fn peak_db(&self) -> f64 {
        self.true_peak_dbtp
            .or(self.sample_peak_db)
            .unwrap_or(SILENCE_FLOOR_DB)
    }
}

/// Number of stderr lines quoted when a measurement pass parsed nothing.
const EMPTY_MEASUREMENT_STDERR_LINES: usize = 3;

/// Turns one `ebur128,astats` filter log into a [`LoudnessMeasurement`].
///
/// Pure over the captured stderr so it is testable without invoking FFmpeg.
///
/// # Errors
///
/// Returns [`CoreError::AnalysisFailed`] when the pass exited successfully but
/// the log carries no momentary readings, no integrated loudness and no peak,
/// and when every frame line it did carry had an unreadable momentary token.
/// A pass that measured *nothing* is a broken pass, not a silent file: even
/// digital silence produces frame lines at the meter's floor. Reporting it as
/// silence is how the `metadata=1` regression stayed invisible for so long, so
/// the numbers a caller cannot trust are refused instead of published.
pub(crate) fn measure_loudness(stderr: &str) -> CoreResult<LoudnessMeasurement> {
    let series = parse_momentary_series(stderr);
    let momentary_lufs = series.readings;
    let loudness_profile =
        per_second_loudness_profile(&momentary_lufs, LOUDNESS_SAMPLES_PER_SECOND as usize);
    let summary = parse_loudness_summary(stderr);
    let astats = parse_astats_overall(stderr);

    if momentary_lufs.is_empty()
        && summary.integrated_lufs.is_none()
        && astats.sample_peak_db.is_none()
    {
        return Err(CoreError::AnalysisFailed(format!(
            "The `{}` pass completed but measured nothing: no momentary readings, \
             no integrated loudness and no peak. First stderr lines: {}",
            loudness_filter_chain(),
            first_stderr_lines(stderr, EMPTY_MEASUREMENT_STDERR_LINES),
        )));
    }

    // A frame line whose momentary token this parser cannot read at all is not
    // a silent window - the meter has its own spellings for those, and they all
    // land on the floor sentinel with the slot intact. A handful of unreadable
    // lines costs their seconds; a run where *every* line was unreadable
    // produces a profile of pure floor, which reads back as a silent file. That
    // is the same lie the `metadata=1` regression told, so it is refused here
    // rather than published, whatever the summary block managed to say.
    if !momentary_lufs.is_empty() && series.unreadable == momentary_lufs.len() {
        return Err(CoreError::AnalysisFailed(format!(
            "The `{}` pass produced {} frame lines and none of them carried a \
             readable momentary loudness. First stderr lines: {}",
            loudness_filter_chain(),
            momentary_lufs.len(),
            first_stderr_lines(stderr, EMPTY_MEASUREMENT_STDERR_LINES),
        )));
    }

    Ok(LoudnessMeasurement {
        loudness_profile,
        momentary_lufs,
        integrated_lufs: summary.integrated_lufs,
        loudness_range_lu: summary.loudness_range_lu,
        true_peak_dbtp: summary.true_peak_dbtp,
        sample_peak_db: astats.sample_peak_db,
    })
}

/// Joins the first `limit` non-empty stderr lines into one diagnostic string.
fn first_stderr_lines(stderr: &str, limit: usize) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(limit)
        .collect();

    if lines.is_empty() {
        "<no stderr output>".to_string()
    } else {
        lines.join(" | ")
    }
}

/// Parses spectral centroid values from FFmpeg `aspectralstats` / `ametadata`
/// filter stderr and returns the average in Hz.
///
/// Looks for lines matching:
/// ```text
/// lavfi.aspectralstats.1.centroid=1234.56
/// ```
fn parse_spectral_centroid(stderr: &str) -> f64 {
    let mut values: Vec<f64> = Vec::new();
    let marker = "lavfi.aspectralstats.1.centroid=";

    for line in stderr.lines() {
        if let Some(pos) = line.find(marker) {
            let rest = &line[pos + marker.len()..];
            let num_str: String = rest
                .chars()
                .take_while(|c| *c == '-' || *c == '.' || c.is_ascii_digit())
                .collect();
            if let Ok(val) = num_str.parse::<f64>() {
                if val.is_finite() && val >= 0.0 {
                    values.push(val);
                }
            }
        }
    }

    if values.is_empty() {
        return 0.0;
    }

    values.iter().sum::<f64>() / values.len() as f64
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // Loudness Failure Classification Tests
    // -------------------------------------------------------------------------

    /// Feature: loudness failure classification
    /// Scenario: the pass never reached a verdict about the media
    ///   Given a pass that timed out, whose FFmpeg never ran, whose input was
    ///   rejected before the spawn, that asked for a filter this build lacks,
    ///   or that died on a read error
    ///   When the failure is classified
    ///   Then it is transient
    ///
    /// None of these say anything about the file, so the asset is worth one
    /// more pass once the machine or the install has moved on. The old
    /// classifier read the message instead of the cause and defaulted to
    /// permanent, so a decode killed by `Input/output error` cost the asset its
    /// loudness numbers forever.
    ///
    /// A missing filter belongs here for the same reason once removed: it is a
    /// property of the FFmpeg install, not of the media, and an install changes
    /// between launches.
    #[test]
    fn should_classify_a_pass_that_never_reached_a_verdict_as_transient() {
        let never_reached_a_verdict = [
            FilterPassFailure::TimedOut,
            FilterPassFailure::NotRun("No such file or directory (os error 2)".to_string()),
            FilterPassFailure::NotRun("Input file does not exist: /media/clip.mp4".to_string()),
            FilterPassFailure::MissingFilter {
                stderr_tail: "[AVFilterGraph @ 0x1] No such filter: 'ebur128'".to_string(),
            },
            FilterPassFailure::Failed {
                exit_code: 1,
                stderr_tail: "[in#0 @ 0x1] Error during demuxing: Input/output error".to_string(),
            },
        ];

        for failure in never_reached_a_verdict {
            let rendered = failure.to_string();
            assert_eq!(
                failure.kind(),
                LoudnessFailureKind::Transient,
                "expected another pass to be worth it for {:?}",
                rendered
            );
            // The same verdict has to survive the CoreError boundary, which is
            // all a whole-pass failure has to classify from.
            assert!(
                LoudnessFailure::from_error(&CoreError::from(failure)).is_transient(),
                "the verdict was lost crossing CoreError for {:?}",
                rendered
            );
        }
    }

    /// Feature: loudness failure classification
    /// Scenario: the pass looked at the media and settled the question
    ///   Given an input with no audio stream, or output `measure_loudness`
    ///   refused
    ///   When the failure is classified
    ///   Then it is unmeasurable
    ///
    /// Each is a property of this media, so a retry buys a full decode per
    /// session that can only reach the same verdict.
    #[test]
    fn should_classify_a_settled_verdict_as_unmeasurable() {
        let settled = [FilterPassFailure::NoAudioStream];

        for failure in settled {
            let rendered = failure.to_string();
            assert_eq!(
                failure.kind(),
                LoudnessFailureKind::Unmeasurable,
                "expected a settled verdict for {:?}",
                rendered
            );
            assert!(
                !LoudnessFailure::from_error(&CoreError::from(failure)).is_transient(),
                "the verdict was lost crossing CoreError for {:?}",
                rendered
            );
        }

        let measured_nothing = measure_loudness("Input #0, mov, from 'clip.mp4':")
            .expect_err("a log with no readings is refused");
        assert!(!LoudnessFailure::from_error(&measured_nothing).is_transient());
    }

    /// Verbatim stderr of the bundled FFmpeg 9.0.1 failing to open a broken
    /// file named `broken No such filter.mp4`.
    ///
    /// Captured, not written by hand: the point of the test below is that the
    /// classifier reads what FFmpeg actually prints, and FFmpeg always echoes
    /// the input path back — which is the whole trap.
    const BROKEN_INPUT_WITH_A_TRAP_NAME_STDERR: &str = concat!(
        "[in#0 @ 0x1] Format mov,mp4,m4a,3gp,3g2,mj2 detected only with low score of 1, \
         misdetection possible!\n",
        "[in#0 @ 0x1] moov atom not found\n",
        "[in#0 @ 0x1] Error opening input: Invalid data found when processing input\n",
        "Error opening input file broken No such filter.mp4.\n",
        "Error opening input files: Invalid data found when processing input\n",
    );

    /// Stderr of the bundled FFmpeg 9.0.1 asked for a filter it lacks.
    ///
    /// Captured from a real pass over the 4 s stereo sine fixture — only the
    /// temporary fixture path is substituted, because that one is per-machine.
    const MISSING_FILTER_STDERR: &str = concat!(
        "[aist#0:0/pcm_s16le @ 0000020e8d557400] Guessed Channel Layout: stereo\n",
        "Input #0, wav, from 'C:/fixtures/sine_stereo.wav':\n",
        "  Metadata:\n",
        "    encoder         : Lavf63.1.101\n",
        "  Duration: 00:00:04.00, bitrate: 1536 kb/s\n",
        "  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 48000 Hz, stereo, s16, \
         1536 kb/s\n",
        "[AVFilterGraph @ 0000020e8f0e0cc0] No such filter: 'nosuchfilter123'\n",
        "Error opening output file -.\n",
        "Error opening output files: Filter not found\n",
    );

    /// Stderr of the bundled FFmpeg 9.0.1 running the silence pass over a
    /// video-only input, whose path is substituted as above.
    ///
    /// The pass adds `-vn`, so the audio filter has nothing to read and the
    /// muxer refuses an output with no streams. FFmpeg exits 127.
    const VIDEO_ONLY_INPUT_STDERR: &str = concat!(
        "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'C:/fixtures/videoonly.mp4':\n",
        "  Duration: 00:00:02.00, start: 0.000000, bitrate: 50 kb/s\n",
        "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), \
         yuv420p(progressive), 320x240 [SAR 1:1 DAR 4:3], 45 kb/s, 25 fps\n",
        "Output #0, null, to 'pipe:':\n",
        "[out#0/null @ 0000024133acec80] Output file does not contain any stream\n",
        "Error opening output file -.\n",
        "Error opening output files: Invalid argument\n",
    );

    /// Stderr of a clean silence pass over an audible file under `b-roll no audio/`.
    ///
    /// Captured the same way. Both ingredients of the old matcher are here — the
    /// words `no audio` in the echoed path, and the lowercase `stream` that the
    /// summary line's `other streams:0KiB` supplies on every single pass — over
    /// a run that exited 0 having measured the file perfectly.
    const AUDIBLE_INPUT_UNDER_A_TRAP_PATH_STDERR: &str = concat!(
        "[aist#0:0/pcm_s16le @ 000001693be067c0] Guessed Channel Layout: stereo\n",
        "Input #0, wav, from 'C:/fixtures/b-roll no audio/clip.wav':\n",
        "  Duration: 00:00:04.00, bitrate: 1536 kb/s\n",
        "  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 48000 Hz, stereo, s16, \
         1536 kb/s\n",
        "Stream mapping:\n",
        "  Stream #0:0 -> #0:0 (pcm_s16le (native) -> pcm_s16le (native))\n",
        "Output #0, null, to 'pipe:':\n",
        "  Stream #0:0: Audio: pcm_s16le, 48000 Hz, stereo, s16, 1536 kb/s\n",
        "[out#0/null @ 000001693bdbe080] video:0KiB audio:750KiB subtitle:0KiB \
         other streams:0KiB global headers:0KiB muxing overhead: unknown\n",
    );

    /// Feature: loudness failure classification
    /// Scenario: the media path quotes the words of a verdict
    ///   Given the stderr of a decode that died on a file named
    ///   `broken No such filter.mp4`
    ///   When the classifier reads it
    ///   Then it is not a missing filter, and the failure stays transient
    ///   And the stderr of a genuinely missing filter still is one
    ///
    /// The classifier used to `contains`-match the bare words over the whole
    /// capture, and FFmpeg echoes the input path on its own line, so a file
    /// could talk itself out of ever being measured by its name alone.
    #[test]
    fn should_classify_by_cause_and_not_by_words_in_the_message() {
        assert!(
            !has_missing_filter_indicator(BROKEN_INPUT_WITH_A_TRAP_NAME_STDERR),
            "the echoed input path must not read as a missing filter"
        );
        assert!(
            has_missing_filter_indicator(MISSING_FILTER_STDERR),
            "the filter graph's own diagnostic must still be recognised"
        );

        // The classification `run_ffmpeg_filter` reaches over that stderr.
        let failure = FilterPassFailure::Failed {
            exit_code: 183,
            stderr_tail: BROKEN_INPUT_WITH_A_TRAP_NAME_STDERR.to_string(),
        };
        assert_eq!(failure.kind(), LoudnessFailureKind::Transient);
    }

    /// Feature: loudness failure classification
    /// Scenario: the meter refused output the filter pass delivered
    ///   Given a loudness pass whose capture `measure_loudness` rejected
    ///   When the pass failure is turned into the stored verdict
    ///   Then it is unmeasurable, while a failed filter pass keeps its own kind
    #[test]
    fn should_keep_the_meter_and_the_filter_pass_verdicts_apart() {
        let meter = LoudnessPassFailure::Meter(
            measure_loudness("Input #0, mov, from 'clip.mp4':")
                .expect_err("a log with no readings is refused"),
        );
        let timed_out = LoudnessPassFailure::Pass(FilterPassFailure::TimedOut);
        let no_audio = LoudnessPassFailure::Pass(FilterPassFailure::NoAudioStream);

        assert!(!meter.is_no_audio_stream());
        assert!(!meter.into_loudness_failure().is_transient());
        assert!(!timed_out.is_no_audio_stream());
        assert!(timed_out.into_loudness_failure().is_transient());
        assert!(no_audio.is_no_audio_stream());
        assert!(!no_audio.into_loudness_failure().is_transient());
    }

    // -------------------------------------------------------------------------
    // BPM Estimation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_detect_bpm_when_music_present() {
        // Build a loudness profile with regular peaks at 0.5s intervals (120 BPM).
        // Since loudness_profile is per-second, peaks every 0.5s means
        // two peaks per second. We simulate this by creating peaks at
        // alternating seconds: peak at even indices, valley at odd.
        // But estimate_bpm works at per-second granularity, so we space
        // peaks 1 second apart → 60 BPM or 2 seconds apart → 30 BPM.
        //
        // For 120 BPM we need peaks every 0.5s, but since our resolution
        // is 1 second, we cannot represent 120 BPM directly. Instead,
        // we test with peaks every 1 second → 60 BPM.
        let mut loudness: Vec<f64> = Vec::new();
        // Create 20 seconds of data with peaks every 1 second
        for _ in 0..20 {
            loudness.push(-10.0); // peak
        }

        // That gives all peaks — no valleys. Let's do alternating instead:
        // peak, valley, peak, valley, ...
        loudness.clear();
        for i in 0..20 {
            if i % 2 == 0 {
                loudness.push(-10.0); // peak
            } else {
                loudness.push(-25.0); // valley
            }
        }

        let bpm = AudioProfiler::estimate_bpm(&loudness);
        assert!(bpm.is_some(), "BPM should be detected");
        let bpm_val = bpm.unwrap();
        // Peaks at indices 0,2,4,6,8,10,12,14,16,18 → IOI = 2s → BPM = 30
        assert!(
            (bpm_val - 30.0).abs() < 1.0,
            "Expected ~30 BPM, got {}",
            bpm_val
        );
    }

    #[test]
    fn should_detect_bpm_from_evenly_spaced_peaks() {
        // Place peaks at indices 5, 7, 9, 11, 13 (2-second intervals → 30 BPM).
        // Each peak must exceed BOTH neighbors by > PEAK_THRESHOLD_DB (3.0 dB),
        // so valleys at -30.0 and peaks at -5.0 give a 25 dB difference.
        let mut loudness = vec![-30.0; 20];
        for &idx in &[5, 7, 9, 11, 13] {
            loudness[idx] = -5.0;
        }

        let bpm = AudioProfiler::estimate_bpm(&loudness);
        assert!(bpm.is_some());
        let bpm_val = bpm.unwrap();
        assert!(
            (bpm_val - 30.0).abs() < 1.0,
            "Expected ~30 BPM, got {}",
            bpm_val
        );
    }

    #[test]
    fn should_detect_120_bpm_from_half_second_loudness_samples() {
        let mut loudness = vec![-30.0; 40];
        for &idx in &[5, 10, 15, 20, 25, 30, 35] {
            loudness[idx] = -5.0;
        }

        let bpm = AudioProfiler::estimate_bpm_from_samples(&loudness, LOUDNESS_SAMPLES_PER_SECOND);
        assert!(bpm.is_some());
        assert!((bpm.unwrap() - 120.0).abs() < 1.0);
    }

    /// Feature: BPM estimation
    /// Scenario: audible onsets separated by long silences
    ///   Given a profile whose only audible seconds sit ten seconds apart
    ///   And digital silence between them
    ///   When BPM is estimated
    ///   Then no beat is reported
    ///
    /// The onsets are ten seconds apart, so there is no beat here to find. The
    /// old estimator filtered the silence out before looking, which pulled the
    /// onsets next to each other and read a steady 30 BPM off a file that has
    /// one noise every ten seconds.
    #[test]
    fn should_not_invent_a_beat_from_onsets_separated_by_silence() {
        let mut loudness = vec![SILENCE_FLOOR_DB; 100];
        for (onset, second) in (0..100).step_by(10).enumerate() {
            loudness[second] = if onset % 2 == 0 { -5.0 } else { -20.0 };
        }

        assert_eq!(
            AudioProfiler::estimate_bpm(&loudness),
            None,
            "collapsing the silences would turn ten-second gaps into a tempo"
        );
    }

    /// Feature: BPM estimation
    /// Scenario: a steady beat followed by silence
    ///   Given peaks two seconds apart over the first fifteen seconds
    ///   And ten seconds of digital silence after them
    ///   When BPM is estimated
    ///   Then the beat is still reported at 30 BPM
    ///
    /// Skipping the silent readings must not cost the estimator the onsets it
    /// can legitimately see, and the two edges of the silence must not be
    /// counted as onsets of their own.
    #[test]
    fn should_still_detect_a_beat_when_the_profile_ends_in_silence() {
        let mut loudness = vec![-30.0; 15];
        for &second in &[5, 7, 9, 11, 13] {
            loudness[second] = -5.0;
        }
        loudness.extend(std::iter::repeat_n(SILENCE_FLOOR_DB, 10));

        let bpm = AudioProfiler::estimate_bpm(&loudness).expect("the beat is still there");

        assert!((bpm - 30.0).abs() < 1.0, "Expected ~30 BPM, got {bpm}");
    }

    #[test]
    fn should_return_none_bpm_when_insufficient_peaks() {
        // Flat loudness profile — no peaks
        let loudness = vec![-20.0; 30];
        let bpm = AudioProfiler::estimate_bpm(&loudness);
        assert!(bpm.is_none(), "BPM should be None for flat profile");
    }

    #[test]
    fn should_return_none_bpm_when_profile_too_short() {
        let loudness = vec![-20.0, -15.0];
        let bpm = AudioProfiler::estimate_bpm(&loudness);
        assert!(bpm.is_none(), "BPM should be None for < 3 samples");
    }

    #[test]
    fn should_clamp_bpm_to_valid_range() {
        // Create peaks very close together → very high BPM → should clamp to 300
        // This is hard with integer indices; minimum IOI = 1 → 60 BPM.
        // Instead verify clamping logic directly via edge case:
        // all adjacent samples are peaks, IOI = 1, BPM = 60 (within range)
        let mut loudness = Vec::new();
        for i in 0..20 {
            loudness.push(if i % 2 == 0 { -5.0 } else { -30.0 });
        }
        let bpm = AudioProfiler::estimate_bpm(&loudness);
        if let Some(val) = bpm {
            assert!(
                (MIN_BPM..=MAX_BPM).contains(&val),
                "BPM {} out of range",
                val
            );
        }
    }

    // -------------------------------------------------------------------------
    // Silence Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_parse_silence_regions_from_ffmpeg_output() {
        let ffmpeg_stderr = r#"
[silencedetect @ 0x55f1234] silence_start: 0.000000
[silencedetect @ 0x55f1234] silence_end: 1.500000 | silence_duration: 1.500000
[silencedetect @ 0x55f1234] silence_start: 5.200000
[silencedetect @ 0x55f1234] silence_end: 7.800000 | silence_duration: 2.600000
[silencedetect @ 0x55f1234] silence_start: 12.100000
[silencedetect @ 0x55f1234] silence_end: 14.300000 | silence_duration: 2.200000
size=N/A time=00:00:20.00 bitrate=N/A speed=50.0x
"#;

        let regions = parse_silence_regions(ffmpeg_stderr);
        assert_eq!(regions.len(), 3, "Should detect 3 silence regions");

        assert!((regions[0].start_sec - 0.0).abs() < 0.001);
        assert!((regions[0].end_sec - 1.5).abs() < 0.001);

        assert!((regions[1].start_sec - 5.2).abs() < 0.001);
        assert!((regions[1].end_sec - 7.8).abs() < 0.001);

        assert!((regions[2].start_sec - 12.1).abs() < 0.001);
        assert!((regions[2].end_sec - 14.3).abs() < 0.001);
    }

    #[test]
    fn should_handle_unpaired_silence_start() {
        // silence_start without a matching silence_end should be ignored
        let ffmpeg_stderr = r#"
[silencedetect @ 0x55f1234] silence_start: 0.000000
[silencedetect @ 0x55f1234] silence_end: 1.500000 | silence_duration: 1.500000
[silencedetect @ 0x55f1234] silence_start: 5.200000
"#;

        let regions = parse_silence_regions(ffmpeg_stderr);
        assert_eq!(regions.len(), 1, "Unpaired start should not produce region");
    }

    #[test]
    fn should_handle_empty_silence_output() {
        let regions = parse_silence_regions("");
        assert!(regions.is_empty());
    }

    // -------------------------------------------------------------------------
    // Loudness Parsing Tests
    // -------------------------------------------------------------------------

    /// One second of `ebur128` frame lines at a steady level, as the shared
    /// chain prints them (`peak=true:framelog=info`).
    fn ebur128_frames(level_lufs: f64, count: usize) -> String {
        (0..count)
            .map(|index| {
                format!(
                    "[Parsed_ebur128_0 @ 0x1] t: {:.6}   TARGET:-23 LUFS    M: {:.1} \
                     S: {:.1}     I: {:.1} LUFS       LRA:   0.0 LU  \
                     FTPK: -6.0 -6.0 dBFS  TPK: -6.0 -6.0 dBFS",
                    index as f64 / 10.0,
                    level_lufs,
                    level_lufs,
                    level_lufs,
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The summary block ends every measurement pass.
    fn ebur128_summary(integrated_lufs: f64, true_peak_dbtp: f64) -> String {
        format!(
            "[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    \
             I:  {integrated_lufs:.1} LUFS\n    Threshold: -30.0 LUFS\n\n  \
             Loudness range:\n    LRA:  0.0 LU\n\n  True peak:\n    \
             Peak:  {true_peak_dbtp:.1} dBFS"
        )
    }

    #[test]
    fn should_measure_loudness_and_peak_from_a_full_filter_log() {
        let log = format!(
            "{}\n{}\n[Parsed_astats_1 @ 0x1] Peak level dB: -6.020600",
            ebur128_frames(-6.7, 20),
            ebur128_summary(-6.7, -6.0),
        );

        let measurement = measure_loudness(&log).expect("a full log must measure");

        assert_eq!(
            measurement.loudness_profile.len(),
            2,
            "20 readings at 10/sec is 2 seconds"
        );
        assert!((measurement.loudness_profile[0] - (-6.7)).abs() < 0.05);
        assert_eq!(measurement.integrated_lufs, Some(-6.7));
        assert_eq!(measurement.true_peak_dbtp, Some(-6.0));
        assert_eq!(measurement.sample_peak_db, Some(-6.0206));
        assert!((measurement.peak_db() - (-6.0)).abs() < 0.01);
    }

    /// Feature: audio profile peak reporting
    /// Scenario: the FFmpeg build measures no true peak
    ///   Given a filter log whose summary omits the true-peak section
    ///   When the loudness pass is parsed
    ///   Then the reported peak is the `astats` sample peak
    #[test]
    fn should_fall_back_to_the_sample_peak_when_true_peak_is_unavailable() {
        let log = "\
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:  -16.4 LUFS

  Loudness range:
    LRA:  5.0 LU
[Parsed_astats_1 @ 0x1] Peak level dB: -1.900000";

        let measurement = measure_loudness(log).expect("a summary with a peak must measure");

        assert_eq!(measurement.true_peak_dbtp, None);
        assert!((measurement.peak_db() - (-1.9)).abs() < 0.01);
    }

    /// Feature: audio loudness measurement
    /// Scenario: the filter pass runs but its output carries no measurement
    ///   Given a capture with no frame lines, no summary and no astats block
    ///   When the loudness pass is parsed
    ///   Then it fails, naming the filter and quoting the start of the log
    ///
    /// The old behaviour folded this into `-90 dB` and reported it as a
    /// successful measurement of silence, which is how a pass that measured
    /// nothing shipped as a number users acted on.
    #[test]
    fn should_fail_when_a_successful_pass_measured_nothing() {
        let error = measure_loudness("Stream #0:0: Audio: aac\nno relevant data here")
            .expect_err("a pass that measured nothing must not report silence");

        let message = error.to_string();
        assert!(
            message.contains("ebur128"),
            "the error must name the filter: {message}"
        );
        assert!(
            message.contains("Stream #0:0"),
            "the error must quote the start of the log: {message}"
        );
    }

    /// Feature: audio loudness measurement
    /// Scenario: the meter prints frame lines this parser cannot read
    ///   Given a log whose every momentary token is not a number
    ///   And a summary block that does carry an integrated loudness
    ///   When the loudness pass is parsed
    ///   Then it fails, naming the filter and quoting the start of the log
    ///
    /// Every frame line yields a reading, so an unreadable log and a silent one
    /// produce the same series: a profile of pure floor. Publishing it would
    /// report a file as silent because the log was in a shape this parser does
    /// not know, which is the `metadata=1` lie in a new spelling. The summary
    /// block cannot vouch for a per-second curve it did not produce.
    #[test]
    fn should_fail_when_every_frame_line_is_unreadable() {
        let log = "[Parsed_ebur128_0 @ 0x1] t: 0.4 TARGET:-23 LUFS M: ????? S: ?????
[Parsed_ebur128_0 @ 0x1] t: 0.5 TARGET:-23 LUFS M: ????? S: ?????
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:  -16.4 LUFS";

        let error = measure_loudness(log)
            .expect_err("a log of unreadable frame lines must not report silence");

        let message = error.to_string();
        assert!(
            message.contains("ebur128"),
            "the error must name the filter: {message}"
        );
        assert!(
            message.contains("Parsed_ebur128_0"),
            "the error must quote the start of the log: {message}"
        );
    }

    /// Feature: audio loudness measurement
    /// Scenario: a single frame line is unreadable
    ///   Given a log with two readable frame lines and one that is not
    ///   When the loudness pass is parsed
    ///   Then it succeeds, since the readable lines still measured something
    ///
    /// The unreadable line costs its own slot, nothing more. Only a log where
    /// *nothing* was readable is refused.
    #[test]
    fn should_measure_when_only_some_frame_lines_are_unreadable() {
        let log = "[Parsed_ebur128_0 @ 0x1] t: 0.4 TARGET:-23 LUFS M: -16.4 S: -16.4
[Parsed_ebur128_0 @ 0x1] t: 0.5 TARGET:-23 LUFS M: ????? S: ?????
[Parsed_ebur128_0 @ 0x1] t: 0.6 TARGET:-23 LUFS M: -16.2 S: -16.2";

        let measurement = measure_loudness(log).expect("readable lines are a measurement");

        assert_eq!(measurement.momentary_lufs.len(), 3);
        assert!(measurement.loudness_profile[0] > SILENCE_FLOOR_DB);
    }

    /// Feature: audio loudness measurement
    /// Scenario: the input really is digital silence
    ///   Given frame lines at the meter's silence sentinel and an astats peak
    ///   When the loudness pass is parsed
    ///   Then it succeeds with a floor-level profile
    #[test]
    fn should_measure_digital_silence_rather_than_rejecting_it() {
        let log = "\
[Parsed_ebur128_0 @ 0x1] t: 0.4 TARGET:-23 LUFS M:-120.7 S:-120.7
[Parsed_ebur128_0 @ 0x1] t: 0.5 TARGET:-23 LUFS M:-120.7 S:-120.7";

        let measurement = measure_loudness(log).expect("digital silence is a measurement");

        assert_eq!(measurement.momentary_lufs.len(), 2);
        assert_eq!(measurement.loudness_profile, vec![SILENCE_FLOOR_DB]);
        assert_eq!(measurement.peak_db(), SILENCE_FLOOR_DB);
    }

    /// Feature: audio profile peak reporting
    /// Scenario: a very quiet master peaks below the silence floor
    ///   Given an astats peak of -95 dBFS
    ///   When the peak is reported
    ///   Then the measured value survives instead of being clamped
    #[test]
    fn should_report_a_measured_peak_below_the_silence_floor_as_measured() {
        let log = "\
[Parsed_ebur128_0 @ 0x1] t: 0.4 TARGET:-23 LUFS M: -96.0 S: -96.0
[Parsed_astats_1 @ 0x1] Peak level dB: -95.000000";

        let measurement = measure_loudness(log).expect("a measured peak is a measurement");

        assert!((measurement.peak_db() - (-95.0)).abs() < 0.01);
    }

    /// Feature: audio profile loudness measurement
    /// Scenario: a real talk is profiled
    ///   Given a filter log carrying readings around -16 LUFS
    ///   When the loudness pass is parsed
    ///   Then the profile is populated instead of collapsing to the floor
    ///
    /// This is the regression: `ebur128=metadata=1` demoted its per-frame log
    /// to VERBOSE, so a 14-minute talk reported `peakDb: -90` with zero
    /// loudness samples while `verify --file` measured -16.6 LUFS / -1.9 dBTP.
    #[test]
    fn should_not_collapse_to_the_silence_floor_for_audible_content() {
        let log = format!(
            "{}\n{}\n[Parsed_astats_1 @ 0x1] Peak level dB: -1.900000",
            ebur128_frames(-16.4, 30),
            ebur128_summary(-16.4, -1.9),
        );

        let measurement = measure_loudness(&log).expect("audible content must measure");

        assert!(
            !measurement.loudness_profile.is_empty(),
            "loudnessSampleCount must not be zero for audible content"
        );
        assert!(measurement.peak_db() > SILENCE_FLOOR_DB + 1.0);
        assert!((measurement.integrated_lufs.unwrap_or_default() - (-16.4)).abs() < 0.05);
    }

    // -------------------------------------------------------------------------
    // Spectral Centroid Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_parse_spectral_centroid_from_ffmpeg_output() {
        let stderr = r#"
frame:0    pts:0       pts_time:0
lavfi.aspectralstats.1.centroid=2500.0
frame:1    pts:1024    pts_time:0.023
lavfi.aspectralstats.1.centroid=3000.0
frame:2    pts:2048    pts_time:0.046
lavfi.aspectralstats.1.centroid=2800.0
"#;

        let centroid = parse_spectral_centroid(stderr);
        let expected = (2500.0 + 3000.0 + 2800.0) / 3.0;
        assert!(
            (centroid - expected).abs() < 0.1,
            "Expected centroid ~{}, got {}",
            expected,
            centroid
        );
    }

    #[test]
    fn should_return_zero_centroid_when_no_data() {
        let centroid = parse_spectral_centroid("no spectral data here");
        assert_eq!(centroid, 0.0);
    }

    #[test]
    fn should_ignore_negative_centroid_values() {
        let stderr =
            "lavfi.aspectralstats.1.centroid=-100.0\nlavfi.aspectralstats.1.centroid=2000.0\n";
        let centroid = parse_spectral_centroid(stderr);
        // Only the positive value should be included
        assert!((centroid - 2000.0).abs() < 0.1);
    }

    // -------------------------------------------------------------------------
    // Silent Profile Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_return_silent_profile_when_no_audio() {
        let profile = AudioProfile::silent(10.0);

        assert!(profile.bpm.is_none());
        assert_eq!(profile.spectral_centroid_hz, 0.0);
        assert!(profile.loudness_profile.is_empty());
        assert_eq!(profile.peak_db, SILENCE_FLOOR_DB);
        assert_eq!(profile.silence_regions.len(), 1);
        assert_eq!(profile.silence_regions[0].start_sec, 0.0);
        assert_eq!(profile.silence_regions[0].end_sec, 10.0);
        assert!(profile.speech_regions.is_empty());
    }

    #[test]
    fn should_return_empty_silent_profile_for_zero_duration() {
        let profile = AudioProfile::silent(0.0);
        assert!(profile.silence_regions.is_empty());
        assert!(profile.speech_regions.is_empty());
    }

    #[test]
    fn should_derive_speech_regions_from_silence_regions() {
        let silence = vec![SilenceRegion::new(1.0, 2.0), SilenceRegion::new(4.0, 5.0)];

        let speech = derive_speech_regions_from_silence(&silence, 6.0);

        assert_eq!(speech.len(), 3);
        assert_eq!(speech[0], SpeechRegion::new(0.0, 1.0));
        assert_eq!(speech[1], SpeechRegion::new(2.0, 4.0));
        assert_eq!(speech[2], SpeechRegion::new(5.0, 6.0));
    }

    #[test]
    fn should_merge_short_unvoiced_gaps_between_voiced_frames() {
        let voiced_frames = vec![true, true, false, false, true, true];

        let speech = speech_regions_from_voiced_flags(&voiced_frames, 0.18, 0.03);

        assert_eq!(speech.len(), 1);
        assert!((speech[0].start_sec - 0.0).abs() < f64::EPSILON);
        assert!((speech[0].end_sec - 0.18).abs() < 1e-6);
    }

    #[test]
    fn should_filter_short_voiced_blips_from_vad_regions() {
        let voiced_frames = vec![false, true, false, false];

        let speech = speech_regions_from_voiced_flags(&voiced_frames, 0.12, 0.03);

        assert!(speech.is_empty());
    }

    // -------------------------------------------------------------------------
    // No-Audio Detection Tests
    // -------------------------------------------------------------------------

    /// Feature: no-audio-stream detection
    /// Scenario: the muxer refuses an output the audio pass left empty
    ///   Given the stderr of a silence pass over a video-only input
    ///   When it is read for a no-audio verdict
    ///   Then it is one, in the FFmpeg 9 spelling and the older one alike
    #[test]
    fn should_detect_no_audio_stream_indicator() {
        assert!(has_no_audio_indicator(VIDEO_ONLY_INPUT_STDERR));
        // The spelling of builds from before the context prefix.
        assert!(has_no_audio_indicator(
            "Output file #0 does not contain any stream"
        ));
        assert!(!has_no_audio_indicator("Normal processing output"));
    }

    /// Feature: no-audio-stream detection
    /// Scenario: an audible file lives under a directory named `b-roll no audio`
    ///   Given the stderr of a pass that measured that file and exited 0
    ///   When it is read for a no-audio verdict
    ///   Then it is not one
    ///   And the echoed path cannot claim the diagnostic on a failed pass either
    ///
    /// The old matcher took `"no audio"` and `"stream"` anywhere in the capture,
    /// and checked before the exit status, so every asset under such a folder
    /// was cached as [`AudioProfile::silent`] — marked measured, with no error
    /// recorded — while its audio played fine.
    #[test]
    fn should_not_read_a_no_audio_verdict_out_of_the_echoed_input_path() {
        assert!(!has_no_audio_indicator(
            AUDIBLE_INPUT_UNDER_A_TRAP_PATH_STDERR
        ));
        // Even on a failed pass, the sentence FFmpeg opens with is what decides:
        // an echoed path arrives under `Error opening input file`.
        assert!(!has_no_audio_indicator(
            "Error opening input file C:/b-roll/does not contain any stream.mp4."
        ));
        assert!(!has_no_audio_indicator(
            "[in#0 @ 0x1] Error opening input: a codec that does not contain any stream"
        ));
        // The shape must be found on one line, not assembled across two.
        assert!(!has_no_audio_indicator(
            "[out#0/null @ 0x1] Output file\ndoes not contain any stream"
        ));
    }

    #[test]
    fn should_detect_a_missing_filter_indicator() {
        assert!(has_missing_filter_indicator(MISSING_FILTER_STDERR));
        assert!(has_missing_filter_indicator(
            "[AVFilterGraph @ 0x1] No such filter: 'ebur128'"
        ));
        assert!(!has_missing_filter_indicator(
            "Error during demuxing: Input/output error"
        ));
        // The words on their own are not the diagnostic: an input path or a
        // caption FFmpeg echoes back carries no filter-graph context.
        assert!(!has_missing_filter_indicator(
            "Error opening input file No such filter.mp4."
        ));
        // The one other spelling FFmpeg has is printed by `-h filter=<name>`,
        // which builds no graph and exits 0, so a pass can never capture it.
        assert!(!has_missing_filter_indicator("Unknown filter 'ebur128'."));
        // The shape must be found on one line, not assembled across two.
        assert!(!has_missing_filter_indicator(
            "[in#0 @ 0x1] Error opening input file a]\nNo such filter: 'x'"
        ));
    }

    /// Feature: missing-filter short circuit
    /// Scenario: a second asset is profiled by the binary that already refused
    ///   Given a latch holding one binary's missing-filter refusal
    ///   When another pass asks about that same binary
    ///   Then the recorded failure comes back verbatim, with no decode
    ///   And a different binary is not covered by it
    ///
    /// The refusal stays classified transient — an install changes between
    /// launches — but within one launch it does not, and without the latch a
    /// library import paid for a full decode per asset to hear it again.
    #[test]
    fn should_replay_a_missing_filter_refusal_for_the_binary_that_gave_it() {
        let latch = Mutex::new(None);
        let bundled = Path::new("/opt/openreelio/ffmpeg");
        let system = Path::new("/usr/bin/ffmpeg");

        assert!(latched_missing_loudness_filter(&latch, bundled).is_none());

        let tail = "[AVFilterGraph @ 0x1] No such filter: 'ebur128'";
        latch_missing_loudness_filter(&latch, bundled, tail);

        assert_eq!(
            latched_missing_loudness_filter(&latch, bundled),
            Some(FilterPassFailure::MissingFilter {
                stderr_tail: tail.to_string(),
            }),
            "the short circuit must report exactly what the pass reported"
        );
        assert!(
            latched_missing_loudness_filter(&latch, system).is_none(),
            "which filters exist is a property of one binary, not of the machine"
        );

        // A binary swapped in mid-launch replaces the record rather than
        // adding to it: only the one a pass just ran against is worth replaying.
        latch_missing_loudness_filter(&latch, system, tail);
        assert!(latched_missing_loudness_filter(&latch, bundled).is_none());
        assert!(latched_missing_loudness_filter(&latch, system).is_some());
    }

    // -------------------------------------------------------------------------
    // Edge Case Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_handle_silence_with_extra_whitespace() {
        let stderr = "[silencedetect @ 0x1] silence_start:   2.500  \n[silencedetect @ 0x1] silence_end:  4.000 | silence_duration: 1.500\n";
        let regions = parse_silence_regions(stderr);
        assert_eq!(regions.len(), 1);
        assert!((regions[0].start_sec - 2.5).abs() < 0.001);
        assert!((regions[0].end_sec - 4.0).abs() < 0.001);
    }

    /// Feature: audio profile measurement versioning
    /// Scenario: a profile is produced by the current measurement
    ///   Given a freshly constructed profile
    ///   When its measurement version is read
    ///   Then it carries the current version, so the loader will not drop it
    #[test]
    fn should_stamp_a_freshly_measured_profile_with_the_current_version() {
        let profile = AudioProfile::silent(10.0);

        assert_eq!(profile.measurement_version, AUDIO_MEASUREMENT_VERSION);
    }

    // -------------------------------------------------------------------------
    // FFmpeg-backed measurement
    //
    // These drive a real FFmpeg over a signal whose level is known exactly, so
    // what they assert is the number a user would see rather than the number a
    // hand-written log says. They are `#[ignore]`d because the binary may be
    // missing, and every one starts at `require_or_skip_ffmpeg`, which fails
    // instead of skipping when `REQUIRE_FFMPEG_TESTS` says the run was supposed
    // to have one.
    // -------------------------------------------------------------------------

    use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

    /// Peak level of the synthesized tone, in dBFS.
    const FIXTURE_PEAK_DBFS: f64 = -6.0;

    /// Expected integrated loudness of the stereo fixture, in LUFS.
    ///
    /// A sine of amplitude `A` has mean square `A^2 / 2`, so a -6 dBFS tone
    /// carries `0.5012^2 / 2 = 0.1256` per channel. R128 sums the two
    /// unity-weighted channels and applies its -0.691 LU offset:
    /// `-0.691 + 10 * log10(2 * 0.1256) = -6.7 LUFS`. K-weighting sits within a
    /// few tenths of a dB of unity at 440 Hz, which the tolerance absorbs.
    const FIXTURE_STEREO_LUFS: f64 = -6.7;

    /// Cost of folding a correlated stereo pair to one channel, in LU.
    ///
    /// R128 sums channel powers before taking the logarithm, so the downmix
    /// measures exactly `10 * log10(2)` lower even though it sounds identical.
    /// "The same LUFS" is the wrong expectation for a mono downmix.
    const MONO_DOWNMIX_PENALTY_LU: f64 = 3.01;

    /// Length of the synthesized fixtures, in seconds.
    const FIXTURE_DURATION_SEC: f64 = 4.0;

    /// Length of the video-only fixture, in seconds.
    const VIDEO_ONLY_FIXTURE_SEC: f64 = 2.0;

    /// Tolerance on a measured peak, in dB.
    const PEAK_TOLERANCE_DB: f64 = 0.5;

    /// Tolerance on a measured integrated loudness, in LU.
    const LOUDNESS_TOLERANCE_LU: f64 = 1.0;

    /// Tolerance on the stereo-to-mono loudness relationship, in LU.
    ///
    /// Tighter than [`LOUDNESS_TOLERANCE_LU`] because both sides come from the
    /// same measurement of the same signal, so only the downmix itself can move
    /// the difference.
    const DOWNMIX_TOLERANCE_LU: f64 = 0.5;

    /// Amplitude of the synthesized tone, as a linear sample value.
    ///
    /// `10^(-6/20)`, spelled out so the fixture expression carries the exact
    /// number rather than depending on a filter's rounding.
    const FIXTURE_AMPLITUDE: &str = "0.501187";

    /// Writes a 440 Hz stereo sine at -6 dBFS, 48 kHz, to `path`.
    ///
    /// The tone is written by `aevalsrc` rather than the `sine` source because
    /// `sine` has no amplitude option and emits at a fixed level well below
    /// full scale (-21 dBFS on the bundled FFmpeg 9 build), which would make
    /// the expected loudness a property of the FFmpeg build instead of the
    /// signal. PCM in a WAV container for the same reason: a lossy encoder
    /// would move both the peak and the loudness unpredictably.
    ///
    /// Both channels carry the identical expression, so the pair is fully
    /// correlated and its expected loudness is computable.
    fn write_stereo_sine_fixture(ffmpeg: &Path, path: &Path) -> bool {
        let channel = format!("{FIXTURE_AMPLITUDE}*sin(2*PI*440*t)");
        let source =
            format!("aevalsrc=exprs={channel}|{channel}:s=48000:d={FIXTURE_DURATION_SEC}:c=stereo");

        run_ffmpeg(
            ffmpeg,
            &["-f", "lavfi", "-i", source.as_str(), "-c:a", "pcm_s16le"],
            path,
        )
    }

    /// Writes a short H.264 clip with no audio stream at all to `path`.
    ///
    /// The one input the audio passes genuinely cannot measure, and the only
    /// way to provoke FFmpeg's own "no streams" refusal rather than a
    /// hand-written spelling of it.
    fn write_video_only_fixture(ffmpeg: &Path, path: &Path) -> bool {
        run_ffmpeg(
            ffmpeg,
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=25:duration=2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ],
            path,
        )
    }

    /// Folds `source` to a single channel, leaving the level untouched.
    fn write_mono_downmix(ffmpeg: &Path, source: &Path, path: &Path) -> bool {
        let Some(source) = source.to_str() else {
            return false;
        };

        run_ffmpeg(
            ffmpeg,
            &["-i", source, "-ac", "1", "-c:a", "pcm_s16le"],
            path,
        )
    }

    /// Runs FFmpeg with the shared quiet flags and reports whether `path` was written.
    fn run_ffmpeg(ffmpeg: &Path, args: &[&str], path: &Path) -> bool {
        let mut command = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut command);
        command
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(args)
            .arg(path);

        matches!(command.status(), Ok(status) if status.success()) && path.exists()
    }

    /// Feature: asset audio loudness measurement
    /// Scenario: a tone of known level is profiled
    ///   Given a 440 Hz sine at -6 dBFS, stereo, 48 kHz
    ///   When the audio profiler measures it
    ///   Then the peak, the integrated loudness and the sample count all match
    ///   the synthesized signal
    ///
    /// This is the regression the shared measurement fixed: the old pass ran
    /// `ebur128=metadata=1`, which demotes the per-frame log to VERBOSE while
    /// the pass reads it at `-loglevel info`, so audible content came back as
    /// `peak_db: -90` with an empty loudness profile.
    #[tokio::test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    async fn should_measure_a_synthesized_tone_within_tolerance() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let fixture = dir.path().join("sine_stereo.wav");
        if !write_stereo_sine_fixture(&ffmpeg, &fixture) {
            skip_without_ffmpeg("ffmpeg could not synthesize the stereo sine fixture");
            return;
        }

        let profile = AudioProfiler::new(ffmpeg)
            .analyze(&fixture, FIXTURE_DURATION_SEC)
            .await
            .expect("the profiler must measure a decodable tone")
            .profile;

        assert!(
            !profile.loudness_profile.is_empty(),
            "loudnessSampleCount must be above zero for audible content"
        );
        assert_eq!(profile.measurement_version, AUDIO_MEASUREMENT_VERSION);
        assert!(
            (profile.peak_db - FIXTURE_PEAK_DBFS).abs() <= PEAK_TOLERANCE_DB,
            "peak {} dB is further than {PEAK_TOLERANCE_DB} dB from the synthesized \
             {FIXTURE_PEAK_DBFS} dBFS",
            profile.peak_db
        );

        let integrated = profile
            .integrated_lufs
            .expect("the summary block must report integrated loudness");
        assert!(
            (integrated - FIXTURE_STEREO_LUFS).abs() <= LOUDNESS_TOLERANCE_LU,
            "integrated loudness {integrated} LUFS is further than \
             {LOUDNESS_TOLERANCE_LU} LU from the expected {FIXTURE_STEREO_LUFS} LUFS"
        );
    }

    /// Writes a tone / digital-silence / tone fixture with the given encoder.
    ///
    /// `anullsrc` supplies exact zeroes and the tone is the same `aevalsrc`
    /// expression the other fixtures use, so the audible seconds land at a
    /// known level. The encoder is a parameter because the two that matter
    /// print different things for the silent windows: PCM gives FFmpeg 9 a
    /// number far below the floor, and mp3 gives it the literal `M:   nan`,
    /// which is the spelling the parser used to drop.
    ///
    /// `silence_sec` is 2 rather than 1 because the meter's momentary window is
    /// 400 ms wide: a one-second gap never yields a whole second whose readings
    /// are all silent, only a second of decay.
    fn write_gapped_tone_fixture(
        ffmpeg: &Path,
        path: &Path,
        encoder: &str,
        silence_sec: u32,
    ) -> bool {
        let channel = format!("{FIXTURE_AMPLITUDE}*sin(2*PI*440*t)");
        let tone = format!("aevalsrc=exprs={channel}|{channel}:s=48000:d=1:c=stereo");
        let silence = format!("anullsrc=r=48000:cl=stereo:d={silence_sec}");

        run_ffmpeg(
            ffmpeg,
            &[
                "-f",
                "lavfi",
                "-i",
                tone.as_str(),
                "-f",
                "lavfi",
                "-i",
                silence.as_str(),
                "-f",
                "lavfi",
                "-i",
                tone.as_str(),
                "-filter_complex",
                "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
                "-map",
                "[out]",
                "-c:a",
                encoder,
            ],
            path,
        )
    }

    /// Length of the gapped fixture, in seconds: one tone, two silent, one tone.
    const GAPPED_FIXTURE_SEC: f64 = 4.0;

    /// Seconds of digital silence in the middle of the gapped fixture.
    const GAPPED_FIXTURE_SILENCE_SEC: u32 = 2;

    /// How far below the tone a silent second has to read to count as silent.
    ///
    /// Loose because it has to hold for a lossy encoder too: mp3 reconstructs
    /// digital silence as its own noise floor, around -87 LUFS against a -22
    /// LUFS tone, which is inaudible without being the sentinel.
    const SILENT_SECOND_MARGIN_LU: f64 = 40.0;

    /// Feature: asset audio loudness measurement
    /// Scenario: a file whose middle is digital silence is profiled
    ///   Given tone / 2 s of digital silence / tone, as PCM and as mp3
    ///   When the audio profiler measures each
    ///   Then the per-second profile has one entry per second, the second
    ///   wholly inside the silence reads as silent and the outer seconds read
    ///   the tone
    ///
    /// The real-FFmpeg half of the parser regression, run over both encodings
    /// because they exercise different spellings of "no signal": PCM prints a
    /// number far below the floor, mp3 prints `M:   nan`. Dropping either
    /// shortened the series, so the closing tone was reported at the index of
    /// the silence and every consumer that addresses the profile by time read
    /// the wrong second.
    #[tokio::test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    async fn should_keep_the_profile_aligned_when_the_middle_of_a_file_is_silent() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let profiler = AudioProfiler::new(ffmpeg.clone());

        for (name, encoder) in [
            ("gapped_tone.wav", "pcm_s16le"),
            ("gapped_tone.mp3", "libmp3lame"),
        ] {
            let fixture = dir.path().join(name);
            if !write_gapped_tone_fixture(&ffmpeg, &fixture, encoder, GAPPED_FIXTURE_SILENCE_SEC) {
                skip_without_ffmpeg("ffmpeg could not synthesize the gapped tone fixture");
                return;
            }

            let profile = profiler
                .analyze(&fixture, GAPPED_FIXTURE_SEC)
                .await
                .expect("the profiler must measure a decodable file")
                .profile;
            let curve = &profile.loudness_profile;

            assert_eq!(
                curve.len(),
                GAPPED_FIXTURE_SEC as usize,
                "{encoder}: a {GAPPED_FIXTURE_SEC} s file must yield one entry per \
                 second, got {curve:?}"
            );
            assert!(
                curve[0] > SILENCE_FLOOR_DB,
                "{encoder}: second 0 is the opening tone, got {}",
                curve[0]
            );
            assert!(
                curve[2] < curve[0] - SILENT_SECOND_MARGIN_LU,
                "{encoder}: second 2 is wholly inside the silence, got {} against a \
                 tone at {}",
                curve[2],
                curve[0]
            );
            assert!(
                curve[3] > SILENCE_FLOOR_DB,
                "{encoder}: second 3 is the closing tone, got {}",
                curve[3]
            );
            assert!(
                profile.loudness_measured,
                "{encoder}: a completed pass must mark the profile measured"
            );
        }
    }

    /// Feature: asset audio loudness measurement
    /// Scenario: a second of exact digital silence is profiled
    ///   Given the PCM gapped fixture, whose silence is exact zeroes
    ///   When the audio profiler measures it
    ///   Then the second inside the silence is the floor sentinel exactly
    ///
    /// Split from the encoder-agnostic test because only a lossless encoding
    /// can promise it: mp3 rebuilds digital silence as its own noise floor,
    /// which is a real, if inaudible, reading.
    #[tokio::test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    async fn should_report_the_silence_floor_for_a_second_of_exact_digital_silence() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let fixture = dir.path().join("gapped_tone.wav");
        if !write_gapped_tone_fixture(&ffmpeg, &fixture, "pcm_s16le", GAPPED_FIXTURE_SILENCE_SEC) {
            skip_without_ffmpeg("ffmpeg could not synthesize the gapped tone fixture");
            return;
        }

        let profile = AudioProfiler::new(ffmpeg)
            .analyze(&fixture, GAPPED_FIXTURE_SEC)
            .await
            .expect("the profiler must measure a decodable file")
            .profile;

        assert_eq!(profile.loudness_profile[2], SILENCE_FLOOR_DB);
    }

    /// Feature: asset audio loudness measurement
    /// Scenario: the same tone is measured as stereo and as its mono downmix
    ///   Given a stereo fixture and a one-channel fold of it
    ///   When both are profiled
    ///   Then their peaks agree and their loudness differs only by the R128
    ///   channel-summation term
    ///
    /// The relationship is asserted rather than equality because equality is
    /// what a broken pass would satisfy: a measurement that reads nothing
    /// reports the silence floor for both files.
    #[tokio::test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    async fn should_track_the_signal_rather_than_the_channel_count() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let stereo_path = dir.path().join("sine_stereo.wav");
        let mono_path = dir.path().join("sine_mono.wav");
        if !write_stereo_sine_fixture(&ffmpeg, &stereo_path)
            || !write_mono_downmix(&ffmpeg, &stereo_path, &mono_path)
        {
            skip_without_ffmpeg("ffmpeg could not synthesize the sine fixtures");
            return;
        }

        let profiler = AudioProfiler::new(ffmpeg);
        let stereo = profiler
            .analyze(&stereo_path, FIXTURE_DURATION_SEC)
            .await
            .expect("the profiler must measure the stereo fixture")
            .profile;
        let mono = profiler
            .analyze(&mono_path, FIXTURE_DURATION_SEC)
            .await
            .expect("the profiler must measure the mono downmix")
            .profile;

        assert!(
            (stereo.peak_db - mono.peak_db).abs() <= PEAK_TOLERANCE_DB,
            "peak is a per-sample quantity and must survive the downmix: stereo {} dB \
             against mono {} dB",
            stereo.peak_db,
            mono.peak_db
        );

        let stereo_lufs = stereo
            .integrated_lufs
            .expect("the stereo summary must report integrated loudness");
        let mono_lufs = mono
            .integrated_lufs
            .expect("the mono summary must report integrated loudness");
        assert!(
            ((stereo_lufs - mono_lufs) - MONO_DOWNMIX_PENALTY_LU).abs() <= DOWNMIX_TOLERANCE_LU,
            "the downmix must sit {MONO_DOWNMIX_PENALTY_LU} LU below the stereo source: \
             stereo {stereo_lufs} LUFS against mono {mono_lufs} LUFS"
        );
    }

    /// A filter name no FFmpeg build has, for provoking the real diagnostic.
    const NONEXISTENT_FILTER: &str = "nosuchfilter123";

    /// Feature: loudness failure classification
    /// Scenario: a broken file is named after the diagnostic it must not claim
    ///   Given a file named `broken No such filter.mp4` that will not decode
    ///   And a real FFmpeg asked for a filter it does not have
    ///   When each pass is classified
    ///   Then the broken file is an ordinary failure and stays transient
    ///   And only the missing filter is reported as one
    ///
    /// The pure test above asserts the same thing over a captured transcript;
    /// this one regenerates both transcripts from the FFmpeg actually
    /// installed, so a build that changes the wording of either diagnostic
    /// fails here rather than silently reclassifying every unreadable file.
    #[tokio::test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    async fn should_read_a_missing_filter_from_the_diagnostic_and_not_from_the_path() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let profiler = AudioProfiler::new(ffmpeg.clone());

        // A file whose *name* carries the words, and whose contents FFmpeg
        // cannot open at all.
        let trap = dir.path().join("broken No such filter.mp4");
        std::fs::write(&trap, b"this is not a media file").expect("write the broken fixture");

        let failure = profiler
            .run_ffmpeg_filter(
                &trap,
                &format!("silencedetect=n={SILENCE_THRESHOLD_DB}:d={SILENCE_MIN_DURATION}"),
            )
            .await
            .expect_err("an unreadable input must fail the pass");

        assert!(
            matches!(failure, FilterPassFailure::Failed { .. }),
            "a file that will not decode is an ordinary failure, got {failure:?}"
        );
        assert_eq!(
            failure.kind(),
            LoudnessFailureKind::Transient,
            "a broken file must not cost the asset its numbers because of its name"
        );

        // The same FFmpeg, asked for a filter it really does not have.
        let fixture = dir.path().join("sine_stereo.wav");
        if !write_stereo_sine_fixture(&ffmpeg, &fixture) {
            skip_without_ffmpeg("ffmpeg could not synthesize the stereo sine fixture");
            return;
        }

        let failure = profiler
            .run_ffmpeg_filter(&fixture, NONEXISTENT_FILTER)
            .await
            .expect_err("a filter this build lacks must fail the pass");

        assert!(
            matches!(failure, FilterPassFailure::MissingFilter { .. }),
            "the filter graph's own diagnostic must be recognised, got {failure:?}"
        );
    }

    /// Feature: no-audio-stream detection
    /// Scenario: an audible file sits in a folder named after the verdict
    ///   Given a real audible clip at `b-roll no audio/clip.wav`
    ///   And a real file that carries video and no audio stream at all
    ///   When each is profiled by a real FFmpeg
    ///   Then the audible clip is measured, with its loudness numbers
    ///   And only the video-only file is reported as having no audio
    ///
    /// This is the regression the pure test above asserts over captured
    /// transcripts. The matcher took `"no audio"` and `"stream"` anywhere in
    /// the capture and ran before the exit status, so a clean pass over an
    /// audible file — whose stderr echoes the input path and always ends with
    /// `other streams:0KiB` — was cached as silence, marked measured, with no
    /// error to say otherwise.
    #[tokio::test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    async fn should_read_a_no_audio_verdict_from_the_diagnostic_and_not_from_the_path() {
        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let profiler = AudioProfiler::new(ffmpeg.clone());
        let silence_filter =
            format!("silencedetect=n={SILENCE_THRESHOLD_DB}:d={SILENCE_MIN_DURATION}");

        // An audible clip whose *folder* carries the words of the verdict.
        let trap_dir = dir.path().join("b-roll no audio");
        std::fs::create_dir_all(&trap_dir).expect("create the trap directory");
        let audible = trap_dir.join("clip.wav");
        if !write_stereo_sine_fixture(&ffmpeg, &audible) {
            skip_without_ffmpeg("ffmpeg could not synthesize the stereo sine fixture");
            return;
        }

        let capture = profiler
            .run_ffmpeg_filter(&audible, &silence_filter)
            .await
            .expect("an audible file must pass the silence filter");
        assert!(
            !has_no_audio_indicator(&capture.stderr),
            "a clean pass must not read as no audio: {}",
            capture.stderr
        );

        let analysis = profiler
            .analyze(&audible, FIXTURE_DURATION_SEC)
            .await
            .expect("the profiler must measure an audible clip");
        assert!(
            analysis.loudness_error.is_none(),
            "an audible clip must not record a loudness failure: {:?}",
            analysis.loudness_error
        );
        assert!(analysis.profile.loudness_measured);
        assert!(
            !analysis.profile.loudness_profile.is_empty(),
            "the silent profile has no curve; a measured one must"
        );
        assert!(
            (analysis.profile.peak_db - FIXTURE_PEAK_DBFS).abs() <= PEAK_TOLERANCE_DB,
            "peak {} dB is further than {PEAK_TOLERANCE_DB} dB from the synthesized \
             {FIXTURE_PEAK_DBFS} dBFS",
            analysis.profile.peak_db
        );

        // A file that really has no audio stream, so FFmpeg prints its own
        // refusal rather than a hand-written spelling of one.
        let video_only = dir.path().join("videoonly.mp4");
        if !write_video_only_fixture(&ffmpeg, &video_only) {
            skip_without_ffmpeg("ffmpeg could not synthesize the video-only fixture");
            return;
        }

        let failure = profiler
            .run_ffmpeg_filter(&video_only, &silence_filter)
            .await
            .expect_err("an input with no audio stream must fail the pass");
        assert_eq!(
            failure,
            FilterPassFailure::NoAudioStream,
            "FFmpeg's own no-streams refusal must be recognised"
        );

        let analysis = profiler
            .analyze(&video_only, VIDEO_ONLY_FIXTURE_SEC)
            .await
            .expect("a video-only input yields the silent profile, not an error");
        assert!(
            analysis.profile.loudness_profile.is_empty(),
            "there was nothing to measure, so there is no curve"
        );
        assert_eq!(analysis.profile.peak_db, SILENCE_FLOOR_DB);
    }
}
