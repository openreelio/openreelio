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
use std::time::SystemTime;

use crate::core::assets::Asset;
use crate::core::project::ProjectState;
use crate::core::render::export::{
    asset_has_playable_audio, clip_audio_is_suppressed_by_companion, AssetAudioInfo,
};
use crate::core::timeline::{Clip, Track};

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
/// One FFprobe per unique asset, memoized for the life of the process — see
/// [`probe_asset_audio_info`]. An asset that cannot be probed falls back to its
/// stored metadata rather than failing the caller, which is what the export
/// engine's own probe does.
pub fn probe_sequence_audio_info(
    state: &ProjectState,
    sequence_id: &str,
) -> HashMap<String, AssetAudioInfo> {
    let mut audio_info = HashMap::new();
    let Some(sequence) = state.sequences.get(sequence_id) else {
        return audio_info;
    };

    let mut unique_asset_ids = HashSet::new();
    for track in &sequence.tracks {
        for clip in &track.clips {
            if clip.enabled {
                unique_asset_ids.insert(clip.asset_id.clone());
            }
        }
    }

    for asset_id in unique_asset_ids {
        let Some(asset) = state.assets.get(&asset_id) else {
            continue;
        };
        audio_info.insert(asset_id, probe_asset_audio_info(asset));
    }

    audio_info
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

/// Probes remembered from earlier graphs in this process.
fn probe_cache() -> &'static Mutex<HashMap<ProbeFingerprint, AssetAudioInfo>> {
    static CACHE: OnceLock<Mutex<HashMap<ProbeFingerprint, AssetAudioInfo>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Measures one asset, reusing an earlier measurement of the same file.
///
/// Every surface that builds a render graph probes, and a GUI builds one on
/// every export, every preview-cache fill and every status poll. Without a cache
/// that is one FFprobe per asset per graph, on files that have not changed since
/// the last one — the cost the `render graph` help text warns about, paid over
/// and over.
///
/// A file that cannot be `stat`ed is probed without being remembered, and a
/// probe that fails falls back to the stored metadata and is not remembered
/// either: a missing or half-copied file that appears later must be measured
/// then, not answered from a failure.
pub fn probe_asset_audio_info(asset: &Asset) -> AssetAudioInfo {
    let path = Path::new(&asset.uri);
    let fingerprint = std::fs::metadata(path).ok().and_then(|metadata| {
        metadata
            .is_file()
            .then(|| (path.to_path_buf(), metadata.modified().ok(), metadata.len()))
    });

    if let Some(key) = fingerprint.as_ref() {
        if let Ok(cache) = probe_cache().lock() {
            if let Some(cached) = cache.get(key) {
                return cached.clone();
            }
        }
    }

    let info = match crate::core::assets::MetadataExtractor::extract(&asset.uri) {
        Ok(metadata) => AssetAudioInfo::from_media_metadata(&metadata),
        Err(error) => {
            tracing::debug!(
                asset_id = %asset.id,
                "Falling back to stored audio metadata: {}",
                error
            );
            return AssetAudioInfo::from_asset(asset);
        }
    };

    if let Some(key) = fingerprint {
        if let Ok(mut cache) = probe_cache().lock() {
            if cache.len() >= PROBE_CACHE_CAPACITY {
                cache.clear();
            }
            cache.insert(key, info.clone());
        }
    }

    info
}
