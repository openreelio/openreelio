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
/// One FFprobe per unique asset. An asset that cannot be probed falls back to
/// its stored metadata rather than failing the caller, which is what the export
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
        let info = match crate::core::assets::MetadataExtractor::extract(&asset.uri) {
            Ok(metadata) => AssetAudioInfo {
                has_audio: metadata.audio.is_some(),
                ..AssetAudioInfo::from_asset(asset)
            },
            Err(error) => {
                tracing::debug!(
                    asset_id = %asset_id,
                    "Falling back to stored audio metadata: {}",
                    error
                );
                AssetAudioInfo::from_asset(asset)
            }
        };
        audio_info.insert(asset_id, info);
    }

    audio_info
}
