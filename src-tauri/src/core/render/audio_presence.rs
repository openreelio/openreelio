//! One definition of which clips make a sound.
//!
//! The export argument builders and the render graph answer the same question —
//! "does this clip put audio into the output?" — and used to answer it
//! differently. The builders walk the sequence's tracks and accept a video-track
//! clip's embedded audio; the graph only ever emitted an audio layer for a clip
//! on an *audio* track. A talk imported as one A/V file and inserted on the
//! video track — the default path for every agent — therefore rendered with
//! sound while `render graph` reported `"audioLayers": []` and the transcription
//! mixdown refused the sequence outright.
//!
//! [`clip_carries_audio`] is that single definition. Both the export builders
//! and [`crate::core::render::graph::build_render_graph`] call it, so the graph
//! cannot claim silence for a render that will have sound.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use crate::core::assets::{Asset, AssetKind, MediaMetadata};
use crate::core::project::ProjectState;
use crate::core::render::export::{
    asset_has_playable_audio, clip_audio_is_suppressed_by_companion, AssetAudioInfo,
};
use crate::core::timeline::{Clip, Track};
use crate::core::{CoreError, CoreResult};

/// Whether this clip contributes an audio stream to a render of its sequence.
///
/// Two questions, in the order the export builders ask them:
///
/// 1. Does the asset carry audio this track can play? An audio asset always
///    does; a video asset does when the probe — or, absent a probe, the stored
///    asset metadata — found an audio stream. Anything else (images, text,
///    adjustment layers, caption placeholders) does not.
/// 2. Is that audio already on the timeline a second time? `DetachAudio` leaves
///    the video clip in place and adds an audio-track clip over the same source
///    range, and mixing both would double the sound.
///
/// Whether the clip is *silenced* is deliberately not part of the answer: the
/// export still opens the input and applies the gain, while the transcription
/// mixdown drops it. Callers apply `clip.audio.muted` and `clip.freeze_frame`
/// themselves, exactly as they did before this predicate was hoisted.
pub fn clip_carries_audio(
    clip: &Clip,
    track: &Track,
    asset: &Asset,
    audio_info: Option<&AssetAudioInfo>,
    audio_companion_keys: &HashSet<String>,
) -> bool {
    asset_has_playable_audio(asset, &track.kind, audio_info)
        && !clip_audio_is_suppressed_by_companion(clip, track, asset, audio_companion_keys)
}

/// Measures which of a sequence's assets actually carry an audio stream.
///
/// [`clip_carries_audio`] falls back to the *stored* asset metadata when it is
/// given no probe result, and that metadata is frequently absent: the CLI's
/// `asset import` records an asset from its file extension without opening the
/// file, so an A/V mp4 is stored with no audio info at all. The export never hit
/// this because it probes every unique asset before building its arguments;
/// callers that need the same truth without an export engine — the transcription
/// mixdown, `render graph` — call this instead.
///
/// One FFprobe per unique *video* asset, memoized for the life of the process —
/// see [`probe_asset_audio_info`]. An asset that cannot be probed falls back to
/// its stored metadata rather than failing the caller, which is what the export
/// engine's own probe does.
///
/// This blocks on FFprobe. A caller on an async runtime must not hold a lock
/// across it: read [`sequence_probe_targets`] under the lock, drop the guard,
/// and await [`probe_assets_audio_info_off_runtime`] instead.
pub fn probe_sequence_audio_info(
    state: &ProjectState,
    sequence_id: &str,
) -> HashMap<String, AssetAudioInfo> {
    probe_assets_audio_info(&sequence_probe_targets(state, sequence_id))
}

/// The assets of a sequence whose audio presence actually has to be measured.
///
/// Only *video* assets are returned. An audio asset is audible whatever a probe
/// would say, and an image, subtitle, font or preset carries no sound at all —
/// [`asset_has_playable_audio`] answers for both without opening the file, so
/// probing them would spend an FFprobe on a question already settled. Assets
/// left out of the map fall back to exactly that answer.
///
/// The assets are cloned so a caller can drop whatever lock it read the project
/// under before [`probe_assets_audio_info`] starts spawning processes.
pub fn sequence_probe_targets(state: &ProjectState, sequence_id: &str) -> Vec<Asset> {
    let Some(sequence) = state.sequences.get(sequence_id) else {
        return Vec::new();
    };

    let mut unique_asset_ids = HashSet::new();
    for track in &sequence.tracks {
        for clip in &track.clips {
            if clip.enabled {
                unique_asset_ids.insert(clip.asset_id.clone());
            }
        }
    }

    unique_asset_ids
        .into_iter()
        .filter_map(|asset_id| state.assets.get(&asset_id))
        .filter(|asset| asset.kind == AssetKind::Video)
        .cloned()
        .collect()
}

/// Measures the assets [`sequence_probe_targets`] selected, keyed by asset id.
pub fn probe_assets_audio_info(assets: &[Asset]) -> HashMap<String, AssetAudioInfo> {
    assets
        .iter()
        .map(|asset| (asset.id.clone(), probe_asset_audio_info(asset)))
        .collect()
}

/// Measurements, together with the file each asset pointed at when it was taken.
///
/// A probe deliberately runs with the project lock released, so the project can
/// change while it runs. Relinking an asset — `UpdateAsset` pointing the same id
/// at a different file — is the change the asset id alone cannot survive: the
/// measurement is of the *old* file, and answering the new one with it reports
/// audio a render will not produce, or silence for a render that has sound.
///
/// So the uri is carried alongside, and [`Self::measurements_for`] is what every
/// caller uses to turn the pair back into a map once it has re-locked.
#[derive(Clone, Debug, Default)]
pub struct SequenceAudioProbe {
    /// What was measured, keyed by asset id.
    measurements: HashMap<String, AssetAudioInfo>,
    /// The uri each of those assets carried when it was measured.
    probed_uris: HashMap<String, String>,
}

impl SequenceAudioProbe {
    /// Measurements that still describe the files `state` currently points at.
    ///
    /// An asset relinked while the probe ran is dropped rather than answered
    /// from the old file's verdict. Dropping it is safe in a way answering it is
    /// not: an asset absent from the map falls back to its own stored metadata,
    /// which is what an unprobed asset has always done.
    pub fn measurements_for(&self, state: &ProjectState) -> HashMap<String, AssetAudioInfo> {
        self.measurements
            .iter()
            .filter(|(asset_id, _)| {
                let probed_uri = self.probed_uris.get(*asset_id);
                match (state.assets.get(*asset_id), probed_uri) {
                    (Some(asset), Some(uri)) => &asset.uri == uri,
                    // An asset that is gone is not looked up by the graph
                    // either, and a measurement with no recorded uri cannot be
                    // vouched for.
                    _ => false,
                }
            })
            .map(|(asset_id, info)| (asset_id.clone(), info.clone()))
            .collect()
    }
}

/// [`probe_assets_audio_info`], moved off the async runtime's worker threads.
///
/// FFprobe is a process spawn and a demuxer read — tens of milliseconds each,
/// and unbounded when the file lives on a disconnected network share. Running
/// it inside an async task stalls that task's whole worker thread, and running
/// it while the task holds the project lock stalls every other IPC command too.
///
/// A join failure (the runtime shutting down, or the blocking task panicking)
/// answers with no measurements, which is the same "nobody measured these"
/// fallback [`crate::core::render::build_render_graph`] already handles.
pub async fn probe_assets_audio_info_off_runtime(assets: Vec<Asset>) -> SequenceAudioProbe {
    let probed_uris = assets
        .iter()
        .map(|asset| (asset.id.clone(), asset.uri.clone()))
        .collect::<HashMap<_, _>>();

    match tokio::task::spawn_blocking(move || probe_assets_audio_info(&assets)).await {
        Ok(measurements) => SequenceAudioProbe {
            measurements,
            probed_uris,
        },
        Err(error) => {
            tracing::warn!("Audio presence probe did not complete: {error}");
            SequenceAudioProbe::default()
        }
    }
}

/// What a probe of one asset is remembered against: where the file is, and how
/// it looked when it was measured.
///
/// Modification time and size together are what every incremental build system
/// treats as "this file did not change", and they cost one `stat` against the
/// several tens of milliseconds an FFprobe run costs. A file edited in place
/// changes at least one of them and is measured again.
type ProbeFingerprint = (PathBuf, Option<SystemTime>, u64);

/// Upper bound on remembered probes.
///
/// A project's own assets are a handful; the cap only exists so a long-lived
/// GUI session that opens project after project cannot grow this without end.
/// Reaching it clears the cache rather than evicting cleverly — the next graph
/// re-measures what it needs and nothing is ever wrong, only slower once.
const PROBE_CACHE_CAPACITY: usize = 512;

/// How long a probe failure that reached no verdict suppresses another probe
/// of the same file.
///
/// These failures must not be remembered — a locked file is released, a share
/// comes back, a permission is granted — but "not remembered" used to mean
/// "re-probed by every caller", and a GUI builds a render graph on every status
/// poll. That is a doomed FFprobe spawn several times a second for as long as
/// the file stays locked, on exactly the poll-driven path this cache exists to
/// keep cheap. The interval is short enough that a file freed while the user
/// watches is picked up within one of their glances, and
/// [`clear_negative_probes`] still cuts it short whenever the FFmpeg resolver
/// publishes new paths.
const NEGATIVE_PROBE_RETRY_INTERVAL: Duration = Duration::from_secs(30);

/// When each file last failed a probe that said nothing about its bytes.
///
/// Separate from [`probe_cache`] because these entries are not verdicts: they
/// answer "was this asked recently", not "what is the answer", and they expire
/// on their own after [`NEGATIVE_PROBE_RETRY_INTERVAL`].
fn transient_probe_cache() -> &'static Mutex<HashMap<ProbeFingerprint, Instant>> {
    static CACHE: OnceLock<Mutex<HashMap<ProbeFingerprint, Instant>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Probes remembered from earlier graphs in this process.
///
/// A `None` entry records that FFprobe could not measure this exact file: the
/// verdict is remembered, but the *answer* is not, because the fallback reads
/// the asset's own stored metadata and two assets may point at one path.
fn probe_cache() -> &'static Mutex<HashMap<ProbeFingerprint, Option<AssetAudioInfo>>> {
    static CACHE: OnceLock<Mutex<HashMap<ProbeFingerprint, Option<AssetAudioInfo>>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// FFprobe runs this process has actually spawned, so a test can prove that a
/// second look at the same file did not spawn another one.
#[cfg(test)]
static PROBE_ATTEMPTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Serializes every test that reads [`PROBE_ATTEMPTS`] or depends on the probe
/// cache surviving between two calls.
///
/// The counter and the cache are process-global, and `cargo test` runs the
/// binary's tests on many threads. Anything that counts probes, or that asserts
/// a remembered verdict is still remembered, has to hold this — including tests
/// outside this module: [`clear_negative_probes`] is called by
/// `crate::core::ffmpeg::set_resolved_paths`, so a resolver test registering
/// paths would otherwise wipe the cache mid-assertion.
///
/// The guard is deliberately recovered from poisoning: a panicking test tells
/// us nothing about whether the *next* one may run.
#[cfg(test)]
pub(crate) fn probe_counter_guard() -> std::sync::MutexGuard<'static, ()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    let guard = GUARD.get_or_init(|| Mutex::new(()));
    guard
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Measures one asset, reusing an earlier measurement of the same file.
///
/// Every surface that builds a render graph probes, and a GUI builds one on
/// every export, every preview-cache fill and every status poll. Without a cache
/// that is one FFprobe per asset per graph, on files that have not changed since
/// the last one — the cost the `render graph` help text warns about, paid over
/// and over.
///
/// A file that cannot be `stat`ed is probed without being remembered: a missing
/// or half-copied file that appears later must be measured then, not answered
/// from a failure. A file that stats but that FFprobe *ran on and rejected* is
/// remembered as unmeasurable — the same broken or non-media file on the
/// timeline otherwise spawned a doomed FFprobe on every graph, which is exactly
/// the poll-driven cost this cache exists to remove — and its answer still comes
/// from the asking asset's own stored metadata.
///
/// A probe that failed for any other reason — FFprobe could not be started,
/// FFprobe started but could not open the file — is never remembered as an
/// answer: that says nothing about the bytes, and remembering it would freeze
/// the whole timeline as unmeasurable for the life of the process even after a
/// managed FFmpeg finishes installing or a locked file is released. It is only
/// rate-limited, for [`NEGATIVE_PROBE_RETRY_INTERVAL`], so that a file held
/// open elsewhere does not draw a fresh doomed spawn out of every status poll.
/// See [`probe_failure_is_final`] for which verdicts count, and
/// [`clear_negative_probes`], which the FFmpeg resolver calls when it publishes
/// new paths.
pub fn probe_asset_audio_info(asset: &Asset) -> AssetAudioInfo {
    probe_asset_audio_info_with(asset, |uri| {
        crate::core::assets::MetadataExtractor::extract(uri)
    })
}

/// Verdicts FFprobe reaches about the *content* of a file it managed to open.
///
/// Matched case-insensitively against the diagnostic tail of FFprobe's own
/// stderr lines (see [`probe_failure_is_final`]). Each one means the bytes were
/// read and refused, so the identical bytes get the identical answer and the
/// failure is worth remembering.
///
/// Kept deliberately short. `unknown format` is something FFprobe says when it
/// is told a format with `-f`, which no probe here passes, and `not a valid`
/// only ever appeared as part of a longer sentence this list cannot pin down —
/// both were guesses at wordings rather than verdicts observed from the probes
/// this cache remembers.
///
/// "The identical bytes get the identical answer" is what makes these safe to
/// remember, and it is the *fingerprint*, not this list, that decides which
/// bytes an answer belongs to. A file caught mid-copy earns one of these
/// verdicts honestly — an empty file and a preallocated one with no `moov` atom
/// yet are both genuinely unreadable at the instant FFprobe looks — and the
/// verdict is only ever un-stuck because finishing the copy changes the size or
/// the modification time and so asks under a new [`ProbeFingerprint`]. A copy
/// that somehow ended with both unchanged would keep the stale verdict for the
/// life of the process; no probe path here can tell that apart from a file that
/// really is broken, and [`clear_negative_probes`] is the way out.
const FINAL_PROBE_VERDICTS: [&str; 2] = ["invalid data found", "moov atom not found"];

/// Whether a failed probe is worth remembering against the file.
///
/// The policy is an allow-list, not a deny-list: a failure is remembered only
/// when FFprobe's own stderr names a verdict it reached about the content (see
/// [`FINAL_PROBE_VERDICTS`]). Everything else is treated as transient and asked
/// again, at most once per [`NEGATIVE_PROBE_RETRY_INTERVAL`].
///
/// Two kinds of failure hide behind the same [`CoreError::FFprobeError`]:
/// FFprobe ran and rejected what it read, and FFprobe ran but could not *open*
/// the file at all — a locked or still-copying file, a share that dropped, a
/// permission that a later run may have. Only the first says anything permanent
/// about the bytes. A deny-list would have to enumerate every phrasing of the
/// second (`Permission denied`, `Input/output error`, `No such file or
/// directory`, `Resource temporarily unavailable`, `Operation not permitted`,
/// `Access is denied`, …) across platforms and locales, and anything it missed
/// would be memoized as a permanent verdict for the life of the process.
/// Erring the other way only costs a re-probe.
///
/// [`CoreError::FFprobeUnavailable`] — FFprobe could not be started — is never
/// final for the same reason, and does not reach the allow-list.
///
/// Each stderr line is matched from its last `": "` onwards, which is where
/// FFprobe puts the diagnostic and everything before which is the subject it is
/// diagnosing — the demuxer tag, or the input path. Matching the whole line
/// would let a *path* carry a verdict (`/clips/invalid data found/take1.mp4:
/// Permission denied`) and memoize a transient failure for the life of the
/// process. Lines are looked at one at a time because FFprobe reports the
/// container diagnostic and the verdict on the file separately, and only the
/// first of those carries `moov atom not found`.
fn probe_failure_is_final(error: &CoreError) -> bool {
    let CoreError::FFprobeError(message) = error else {
        return false;
    };
    message.lines().any(|line| {
        let diagnostic = line
            .rsplit_once(": ")
            .map_or(line, |(_subject, tail)| tail)
            .to_ascii_lowercase();
        FINAL_PROBE_VERDICTS
            .iter()
            .any(|verdict| diagnostic.contains(verdict))
    })
}

/// [`probe_asset_audio_info`], with the measurement itself supplied.
///
/// The seam is what lets a test produce one specific failure — FFprobe missing
/// versus FFprobe rejecting the file — without installing or removing binaries.
fn probe_asset_audio_info_with<F>(asset: &Asset, extract: F) -> AssetAudioInfo
where
    F: FnOnce(&str) -> CoreResult<MediaMetadata>,
{
    probe_asset_audio_info_at(asset, Instant::now(), extract)
}

/// [`probe_asset_audio_info_with`], with the clock supplied too.
///
/// [`NEGATIVE_PROBE_RETRY_INTERVAL`] is otherwise only observable by waiting it
/// out, which no test should do; passing the instant lets one prove both halves
/// of the rule — suppressed inside the interval, probed again past it — in no
/// time at all.
fn probe_asset_audio_info_at<F>(asset: &Asset, now: Instant, extract: F) -> AssetAudioInfo
where
    F: FnOnce(&str) -> CoreResult<MediaMetadata>,
{
    let path = Path::new(&asset.uri);
    let fingerprint = std::fs::metadata(path).ok().and_then(|metadata| {
        metadata
            .is_file()
            .then(|| (path.to_path_buf(), metadata.modified().ok(), metadata.len()))
    });

    if let Some(key) = fingerprint.as_ref() {
        if let Ok(cache) = probe_cache().lock() {
            match cache.get(key) {
                Some(Some(cached)) => return cached.clone(),
                Some(None) => return AssetAudioInfo::from_asset(asset),
                None => {}
            }
        }

        if let Ok(mut recent) = transient_probe_cache().lock() {
            match recent.get(key) {
                Some(failed_at)
                    if now.saturating_duration_since(*failed_at)
                        < NEGATIVE_PROBE_RETRY_INTERVAL =>
                {
                    return AssetAudioInfo::from_asset(asset);
                }
                // Past the interval the question is open again, and the entry
                // is dropped now rather than left for a sweep that never runs.
                Some(_) => {
                    recent.remove(key);
                }
                None => {}
            }
        }
    }

    #[cfg(test)]
    PROBE_ATTEMPTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let (probed, remember) = match extract(&asset.uri) {
        Ok(metadata) => (Some(AssetAudioInfo::from_media_metadata(&metadata)), true),
        Err(error) => {
            let remember = probe_failure_is_final(&error);
            tracing::debug!(
                asset_id = %asset.id,
                remembered = remember,
                "Falling back to stored audio metadata: {}",
                error
            );
            (None, remember)
        }
    };

    if let Some(key) = fingerprint {
        if remember {
            if let Ok(mut cache) = probe_cache().lock() {
                if cache.len() >= PROBE_CACHE_CAPACITY {
                    cache.clear();
                }
                cache.insert(key, probed.clone());
            }
        } else if probed.is_none() {
            if let Ok(mut recent) = transient_probe_cache().lock() {
                if recent.len() >= PROBE_CACHE_CAPACITY {
                    recent.clear();
                }
                recent.insert(key, now);
            }
        }
    }

    probed.unwrap_or_else(|| AssetAudioInfo::from_asset(asset))
}

/// Forgets every remembered *failure*, keeping the successful measurements.
///
/// A failure is only remembered once FFprobe has actually run, but the reasons a
/// run refuses a file are not all permanent: an FFprobe too old for a container,
/// or one resolved from a half-written managed download, rejects media a newly
/// registered binary reads fine. The FFmpeg resolver calls this whenever it
/// publishes paths, so a session that opened a project before FFmpeg finished
/// installing measures its media on the next graph instead of reporting silence
/// until it is restarted.
pub fn clear_negative_probes() {
    if let Ok(mut cache) = probe_cache().lock() {
        cache.retain(|_, probed| probed.is_some());
    }
    // The failures that were only being rate-limited are dropped outright: new
    // binaries are exactly the event [`NEGATIVE_PROBE_RETRY_INTERVAL`] is
    // waiting for.
    clear_transient_probes();
}

/// Forgets the rate-limited failures only, keeping every verdict FFprobe
/// reached — the successful measurements and the refusals alike.
///
/// [`NEGATIVE_PROBE_RETRY_INTERVAL`] exists to keep *polling* cheap: a GUI
/// rebuilds a render graph several times a second, and one locked file must not
/// turn that into a stream of doomed FFprobe spawns. A user asking for an
/// export or a preview render is not a poll. It happens once, because they said
/// so, and it is exactly the moment a file that was locked or on a dropped
/// share a few seconds ago is worth asking about again — answering it from a
/// suppression window would silently render a clip mute.
///
/// Every path a user or an agent asks a question through calls this before it
/// probes: the `start_render`, `render_range`, `batch_render`,
/// `export_audio_only` and `validate_export` IPC commands, the preview- and
/// final-render job handlers, and the CLI's `render start` and `render graph`
/// (which the MCP server shares, and that process is long-lived enough for a
/// window to still be open). The polled paths — cache status and cache fill -
/// deliberately do not, because they are the polling this window exists to
/// bound.
///
/// The remembered verdicts are deliberately left alone: they are about bytes
/// that have not changed, and re-measuring them is the cost this cache exists
/// to remove. [`clear_negative_probes`] is the wider reset, for when the FFmpeg
/// resolver publishes binaries that may reach different verdicts.
pub fn clear_transient_probes() {
    if let Ok(mut recent) = transient_probe_cache().lock() {
        recent.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{AudioInfo, VideoInfo};
    use crate::core::timeline::{Clip, ClipPlace, ClipRange, Sequence, SequenceFormat, TrackKind};

    /// How many FFprobe runs this process has spawned so far.
    fn probe_attempts() -> usize {
        PROBE_ATTEMPTS.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// A video asset over a real file, so the probe reaches its fingerprint.
    fn asset_over(path: &std::path::Path) -> Asset {
        let mut asset = Asset::new_video("subject", &path.to_string_lossy(), VideoInfo::default());
        asset.id = "asset-1".to_string();
        asset.audio = None;
        asset
    }

    /// A one-clip sequence over `asset`, on a video track.
    fn state_with_one_clip(asset: Asset) -> ProjectState {
        let mut state = ProjectState::new("Audio Presence Test");
        state.sequences.clear();

        let mut clip = Clip::new(&asset.id);
        clip.id = "clip-1".to_string();
        clip.place = ClipPlace::new(0.0, 4.0);
        clip.range = ClipRange::new(0.0, 4.0);

        let mut sequence = Sequence::new("Sequence", SequenceFormat::youtube_1080());
        sequence.id = "seq-1".to_string();
        let mut track = Track::new("Video 1", TrackKind::Video);
        track.id = "track-1".to_string();
        track.clips.push(clip);
        sequence.tracks.push(track);

        state.assets.insert(asset.id.clone(), asset);
        state.active_sequence_id = Some(sequence.id.clone());
        state.sequences.insert(sequence.id.clone(), sequence);
        state
    }

    /// Feature: audio presence probing
    /// Scenario: an asset whose kind already answers the question
    ///
    /// Given an audio asset and an image asset on a sequence
    /// When the probe targets are collected
    /// Then neither is offered to FFprobe, because `asset_has_playable_audio`
    /// answers "always" and "never" for them without opening the file.
    #[test]
    fn assets_that_are_not_video_are_never_probed() {
        let _serialized = probe_counter_guard();

        for asset in [
            Asset::new_audio("audio", "does-not-matter.wav", AudioInfo::default()),
            Asset::new_image("image", "does-not-matter.png", 1920, 1080),
        ] {
            let mut asset = asset;
            asset.id = "asset-1".to_string();
            let kind = format!("{:?}", asset.kind);
            let state = state_with_one_clip(asset);

            assert!(
                sequence_probe_targets(&state, "seq-1").is_empty(),
                "a {kind} asset must not be handed to FFprobe"
            );

            let before = probe_attempts();
            let audio_info = probe_sequence_audio_info(&state, "seq-1");
            assert_eq!(
                probe_attempts(),
                before,
                "a {kind} asset must not spawn an FFprobe"
            );
            assert!(
                audio_info.is_empty(),
                "an unprobed asset stays out of the map so the kind-based answer stands"
            );
        }
    }

    /// Feature: audio presence probing
    /// Scenario: a file that stats but that FFprobe cannot read
    ///
    /// Given a video asset pointing at a file with no media in it
    /// When the sequence is probed twice
    /// Then FFprobe runs once: the failure is remembered against the same
    /// (path, mtime, size) fingerprint a success would be, so a status poll on a
    /// broken clip stops re-spawning a doomed probe.
    #[test]
    fn a_probe_that_fails_is_remembered() {
        let _serialized = probe_counter_guard();

        let Ok(dir) = tempfile::tempdir() else {
            eprintln!("Skipping test: a temporary directory could not be created");
            return;
        };
        let path = dir.path().join("not-really-a-video.mp4");
        if std::fs::write(&path, b"this is not a media file").is_err() {
            eprintln!("Skipping test: the fixture could not be written");
            return;
        }

        let mut asset = Asset::new_video("broken", &path.to_string_lossy(), VideoInfo::default());
        asset.id = "asset-1".to_string();
        asset.audio = None;
        let state = state_with_one_clip(asset);

        // A test about what FFprobe *decided* has nothing to say on a machine
        // where it cannot be launched at all — that is the other failure, and
        // it is deliberately not remembered.
        if crate::core::test_ffmpeg::require_or_skip_ffprobe().is_none() {
            return;
        }

        let before = probe_attempts();
        let first = probe_sequence_audio_info(&state, "seq-1");
        let after_first = probe_attempts();
        assert_eq!(
            after_first,
            before + 1,
            "the first look at an unmeasured file has to probe it"
        );

        let second = probe_sequence_audio_info(&state, "seq-1");
        assert_eq!(
            probe_attempts(),
            after_first,
            "the second look must be answered from the remembered failure"
        );

        // The remembered failure still answers from the *asking* asset's stored
        // metadata rather than from a cached copy of someone else's.
        assert_eq!(first.get("asset-1").map(|info| info.has_audio), Some(false));
        assert_eq!(
            second.get("asset-1").map(|info| info.has_audio),
            Some(false)
        );
    }

    /// Feature: audio presence probing
    /// Scenario: an asset relinked while the probe ran
    ///
    /// Given a probe taken against one file
    /// When the asset is pointed at a different file before the caller re-locks
    /// Then the old file's measurement is dropped rather than reported for the
    /// new one, and an asset still pointing where it did keeps its measurement.
    #[test]
    fn a_relinked_asset_does_not_keep_the_old_file_s_verdict() {
        let probe = SequenceAudioProbe {
            measurements: HashMap::from([
                (
                    "relinked".to_string(),
                    AssetAudioInfo {
                        has_audio: true,
                        source_dimensions: None,
                        source_duration_sec: None,
                    },
                ),
                (
                    "unchanged".to_string(),
                    AssetAudioInfo {
                        has_audio: true,
                        source_dimensions: None,
                        source_duration_sec: None,
                    },
                ),
            ]),
            probed_uris: HashMap::from([
                ("relinked".to_string(), "with-audio.mp4".to_string()),
                ("unchanged".to_string(), "still-here.mp4".to_string()),
            ]),
        };

        let mut state = ProjectState::new("Relink Test");
        for (id, uri) in [
            ("relinked", "silent-replacement.mp4"),
            ("unchanged", "still-here.mp4"),
        ] {
            let mut asset = Asset::new_video(id, uri, VideoInfo::default());
            asset.id = id.to_string();
            state.assets.insert(asset.id.clone(), asset);
        }

        let resolved = probe.measurements_for(&state);
        assert!(
            !resolved.contains_key("relinked"),
            "the measurement was of the file this asset no longer points at"
        );
        assert_eq!(
            resolved.get("unchanged").map(|info| info.has_audio),
            Some(true),
            "an asset that did not move keeps what was measured for it"
        );

        // An asset removed outright is not answered either.
        state.assets.remove("unchanged");
        assert!(probe.measurements_for(&state).is_empty());
    }

    /// Feature: audio presence probing
    /// Scenario: FFprobe could not be started
    ///
    /// Given a probe that fails because the binary could not be run
    /// When the same asset is probed again
    /// Then it is measured again rather than answered from the failure, because
    /// nothing was ever learned about the file — a managed FFmpeg that finishes
    /// installing mid-session must not find the whole timeline written off.
    #[test]
    fn a_probe_that_could_not_run_is_not_remembered() {
        let _serialized = probe_counter_guard();

        let Ok(dir) = tempfile::tempdir() else {
            eprintln!("Skipping test: a temporary directory could not be created");
            return;
        };
        let path = dir.path().join("unreachable-ffprobe.mp4");
        if std::fs::write(&path, b"contents are never read").is_err() {
            eprintln!("Skipping test: the fixture could not be written");
            return;
        }
        let asset = asset_over(&path);

        let base = Instant::now();
        let attempts = std::cell::Cell::new(0usize);
        let probe = |now: Instant| {
            probe_asset_audio_info_at(&asset, now, |_| {
                attempts.set(attempts.get() + 1);
                Err(CoreError::FFprobeUnavailable(
                    "Failed to run ffprobe: program not found".to_string(),
                ))
            })
        };

        probe(base);
        probe(base + NEGATIVE_PROBE_RETRY_INTERVAL);
        assert_eq!(
            attempts.get(),
            2,
            "a probe that never ran must be retried, not remembered"
        );

        // And once FFprobe is available, the file is measured rather than
        // answered from the earlier non-verdict.
        let measured =
            probe_asset_audio_info_at(&asset, base + NEGATIVE_PROBE_RETRY_INTERVAL * 2, |_| {
                Ok(MediaMetadata {
                    audio: Some(AudioInfo::default()),
                    ..MediaMetadata::default()
                })
            });
        assert!(
            measured.has_audio,
            "the first successful run decides, not the failures before it"
        );
    }

    /// Feature: audio presence probing
    /// Scenario: FFprobe ran and refused the file
    ///
    /// Given a probe that fails with FFprobe's own verdict
    /// When the same asset is probed again
    /// Then FFprobe is not run a second time: the identical bytes get the
    /// identical answer, and that is the poll-driven cost this cache removes.
    #[test]
    fn a_probe_that_ffprobe_refused_is_remembered() {
        let _serialized = probe_counter_guard();

        let Ok(dir) = tempfile::tempdir() else {
            eprintln!("Skipping test: a temporary directory could not be created");
            return;
        };
        let path = dir.path().join("refused-by-ffprobe.mp4");
        if std::fs::write(&path, b"this is not a media file").is_err() {
            eprintln!("Skipping test: the fixture could not be written");
            return;
        }
        let asset = asset_over(&path);

        let attempts = std::cell::Cell::new(0usize);
        let probe = || {
            probe_asset_audio_info_with(&asset, |_| {
                attempts.set(attempts.get() + 1);
                Err(CoreError::FFprobeError(
                    "FFprobe failed: Invalid data found when processing input".to_string(),
                ))
            })
        };

        probe();
        probe();
        assert_eq!(
            attempts.get(),
            1,
            "FFprobe's own verdict on unchanged bytes is asked for once"
        );

        // ...until the resolver publishes new binaries, which retires every
        // verdict the old ones reached.
        clear_negative_probes();
        probe();
        assert_eq!(
            attempts.get(),
            2,
            "re-registered FFmpeg paths reopen the question"
        );
    }

    /// Feature: audio presence probing
    /// Scenario: FFprobe ran but could not open the file
    ///
    /// Given a probe that fails because the file could not be opened
    /// When the same asset is probed again
    /// Then it is measured again: FFprobe reached no verdict on the bytes, and
    /// a lock, a dropped share or a permission that a later run has must not be
    /// written off for the life of the process.
    #[test]
    fn a_probe_that_could_not_open_the_file_is_not_remembered() {
        let _serialized = probe_counter_guard();

        let Ok(dir) = tempfile::tempdir() else {
            eprintln!("Skipping test: a temporary directory could not be created");
            return;
        };
        let path = dir.path().join("locked-by-someone-else.mp4");
        if std::fs::write(&path, b"contents are never read").is_err() {
            eprintln!("Skipping test: the fixture could not be written");
            return;
        }
        let asset = asset_over(&path);

        let base = Instant::now();

        for stderr in [
            "Permission denied",
            "Input/output error",
            "No such file or directory",
            "Resource temporarily unavailable",
            "Operation not permitted",
            "Access is denied. (os error 5)",
            // A path that reads like a verdict must not become one: only the
            // diagnostic after the last ": " is classified.
            "/clips/invalid data found/take1.mp4: Permission denied",
        ] {
            clear_negative_probes();

            let attempts = std::cell::Cell::new(0usize);
            let probe = |now: Instant| {
                probe_asset_audio_info_at(&asset, now, |_| {
                    attempts.set(attempts.get() + 1);
                    Err(CoreError::FFprobeError(format!("FFprobe failed: {stderr}")))
                })
            };

            probe(base);
            probe(base + NEGATIVE_PROBE_RETRY_INTERVAL);
            assert_eq!(
                attempts.get(),
                2,
                "`{stderr}` says nothing about the bytes and must be retried"
            );
        }
    }

    /// Feature: audio presence probing
    /// Scenario: a file that is locked while the GUI polls
    ///
    /// Given a probe that failed without reaching a verdict
    /// When the same asset is probed again straight away
    /// Then FFprobe is not spawned again until the retry interval has passed,
    /// so a status poll several times a second cannot turn one locked file into
    /// a stream of doomed FFprobe spawns.
    #[test]
    fn a_failure_without_a_verdict_is_rate_limited_not_repeated() {
        let _serialized = probe_counter_guard();

        let Ok(dir) = tempfile::tempdir() else {
            eprintln!("Skipping test: a temporary directory could not be created");
            return;
        };
        let path = dir.path().join("held-open-elsewhere.mp4");
        if std::fs::write(&path, b"contents are never read").is_err() {
            eprintln!("Skipping test: the fixture could not be written");
            return;
        }
        let asset = asset_over(&path);
        clear_negative_probes();

        let base = Instant::now();
        let attempts = std::cell::Cell::new(0usize);
        let probe = |now: Instant| {
            probe_asset_audio_info_at(&asset, now, |_| {
                attempts.set(attempts.get() + 1);
                Err(CoreError::FFprobeError(
                    "FFprobe failed: Permission denied".to_string(),
                ))
            })
        };

        probe(base);
        assert_eq!(attempts.get(), 1, "the first poll has to ask");

        probe(base + NEGATIVE_PROBE_RETRY_INTERVAL / 2);
        assert_eq!(
            attempts.get(),
            1,
            "a poll inside the interval is answered from the stored metadata"
        );

        probe(base + NEGATIVE_PROBE_RETRY_INTERVAL);
        assert_eq!(
            attempts.get(),
            2,
            "past the interval the file is asked about again"
        );

        // A resolver publishing new binaries reopens the question immediately,
        // without waiting the interval out.
        clear_negative_probes();
        probe(base + NEGATIVE_PROBE_RETRY_INTERVAL);
        assert_eq!(
            attempts.get(),
            3,
            "re-registered FFmpeg paths cut the interval short"
        );
    }

    /// Feature: audio presence probing
    /// Scenario: a user asks for a render while a file is inside the
    /// suppression window
    ///
    /// Given one file suppressed after a failure that reached no verdict, one
    /// FFprobe refused outright, and one measured successfully
    /// When the export and proxy job paths drop the rate limit
    /// Then only the suppressed file is asked about again: a render the user
    /// asked for re-asks about a file that may have been released, and still
    /// pays nothing to re-measure bytes FFprobe has already ruled on.
    #[test]
    fn a_user_render_reopens_only_the_rate_limited_failures() {
        let _serialized = probe_counter_guard();

        let Ok(dir) = tempfile::tempdir() else {
            eprintln!("Skipping test: a temporary directory could not be created");
            return;
        };
        let locked = dir.path().join("locked.mp4");
        let refused = dir.path().join("refused.mp4");
        let measured = dir.path().join("measured.mp4");
        if [&locked, &refused, &measured]
            .iter()
            .any(|path| std::fs::write(path, b"contents are never read").is_err())
        {
            eprintln!("Skipping test: the fixtures could not be written");
            return;
        }

        clear_negative_probes();

        let base = Instant::now();
        let attempts = std::cell::Cell::new(0usize);
        let probe = |path: &std::path::Path, now: Instant| {
            let asset = asset_over(path);
            let outcome = if path == locked.as_path() {
                Err(CoreError::FFprobeError(
                    "FFprobe failed: Permission denied".to_string(),
                ))
            } else if path == refused.as_path() {
                Err(CoreError::FFprobeError(
                    "FFprobe failed: Invalid data found when processing input".to_string(),
                ))
            } else {
                Ok(MediaMetadata {
                    audio: Some(AudioInfo::default()),
                    ..MediaMetadata::default()
                })
            };
            probe_asset_audio_info_at(&asset, now, |_| {
                attempts.set(attempts.get() + 1);
                outcome
            });
        };

        for path in [&locked, &refused, &measured] {
            probe(path, base);
        }
        assert_eq!(attempts.get(), 3, "each file has to be asked about once");

        // Well inside the retry interval, so only the explicit reset can
        // reopen the suppressed file.
        let during_render = base + NEGATIVE_PROBE_RETRY_INTERVAL / 2;
        clear_transient_probes();
        for path in [&locked, &refused, &measured] {
            probe(path, during_render);
        }
        assert_eq!(
            attempts.get(),
            4,
            "the render re-asks about the suppressed file and nothing else"
        );

        // And the reset is not a one-off: the failure it just re-asked about
        // went back into the rate limit rather than becoming a verdict.
        for path in [&locked, &refused, &measured] {
            probe(path, during_render);
        }
        assert_eq!(
            attempts.get(),
            4,
            "polls after the render are suppressed again"
        );
    }

    /// Feature: audio presence probing
    /// Scenario: which failures are worth remembering
    ///
    /// Given the failures a probe can come back with
    /// When each is classified
    /// Then only FFprobe's verdicts on the content are final, so a policy that
    /// is an allow-list cannot silently memoize a new phrasing of "could not
    /// open this file".
    #[test]
    fn only_content_verdicts_are_treated_as_final() {
        for message in [
            "FFprobe failed: Invalid data found when processing input",
            "FFprobe failed: moov atom not found",
            // What a truncated MP4 really produces: the demuxer's line, then
            // the verdict on the file. Either line on its own is enough.
            "FFprobe failed: [mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] moov atom not found\n\
             C:\\clips\\subject.mp4: Invalid data found when processing input",
        ] {
            assert!(
                probe_failure_is_final(&CoreError::FFprobeError(message.to_string())),
                "`{message}` is a verdict on the bytes and must be remembered"
            );
        }

        for message in [
            "FFprobe failed: Permission denied",
            "FFprobe failed: Input/output error",
            "FFprobe failed: No such file or directory",
            "FFprobe failed: Resource temporarily unavailable",
            "FFprobe failed: Operation not permitted",
            "FFprobe failed: Access is denied. (os error 5)",
            // A path that reads like a verdict is still only a path: the
            // diagnostic is what follows the last ": ".
            "FFprobe failed: /clips/invalid data found/take1.mp4: Permission denied",
            // Wordings that were guessed at rather than observed, and that
            // FFprobe does not produce for a probe with no `-f`.
            "FFprobe failed: Unknown format",
            "FFprobe failed: subject.mp4: not a valid input file",
            // The empty stderr `-v quiet` used to produce: nothing to classify,
            // so nothing to memoize.
            "FFprobe failed: ",
        ] {
            assert!(
                !probe_failure_is_final(&CoreError::FFprobeError(message.to_string())),
                "`{message}` is about this process, not these bytes"
            );
        }

        assert!(
            !probe_failure_is_final(&CoreError::FFprobeUnavailable(
                "Failed to run ffprobe: program not found".to_string()
            )),
            "a probe that never ran is never final"
        );
    }
}
