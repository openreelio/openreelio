//! Media-locality checks for everything a frame probe is about to read.
//!
//! A frame probe opens two very different kinds of path. A rendered `file` is
//! the caller's own string and is *confined* to the project directory by each
//! surface, because an unconfined path handed to FFmpeg turns a read-only tool
//! into a whole-disk existence oracle. An asset's media is not the caller's
//! string at all: it is the project's own, imported by the user, and it
//! legitimately lives wherever their footage lives — a camera dump, an external
//! drive. Confining that would refuse the ordinary case while protecting
//! nothing, since the sequence those assets are cut into is already rendered,
//! previewed and exported from wherever the media lies.
//!
//! What is enforced here is the one thing a frame probe must not become: the
//! step that reaches off-host. A UNC or network path is refused **lexically**,
//! before anything stats it, because on Windows the stat *is* the outbound SMB
//! connection and the NTLM handshake that leaks with it. Media that is not
//! readable on this machine is refused too, so a caller is told its footage is
//! missing rather than reading an FFmpeg error about a file it cannot see.
//!
//! Neither message names the resolved path, and neither distinguishes the two
//! failures beyond what the caller can act on: the asset id is what gets fixed,
//! and echoing where a project's media lives — or answering "does this path
//! exist" per asset — is not something a frame probe owes anybody.

use std::path::Path;

use crate::core::fs::{is_network_path, strip_verbatim_prefix};
use crate::core::project::ProjectState;

/// Why a piece of the project's media must not, or cannot, be read here.
///
/// The two cases are kept apart because they are different kinds of answer: one
/// is a policy decision this process makes, the other is an environment failure
/// the operator fixes by reconnecting a drive. A surface that distinguishes
/// refusal kinds — the MCP server does — maps them to different errors, and a
/// surface that does not simply prints the message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaLocalityError {
    /// The asset's media resolves onto a UNC or network path.
    OffHost {
        /// Asset whose media is off-host.
        asset_id: String,
    },
    /// The asset's media is not readable on this machine.
    Unreadable {
        /// Asset whose media is missing.
        asset_id: String,
    },
}

impl std::fmt::Display for MediaLocalityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OffHost { asset_id } => write!(
                formatter,
                "Asset '{asset_id}' resolves to media on a UNC or network path; only local media is read"
            ),
            Self::Unreadable { asset_id } => write!(
                formatter,
                "Asset '{asset_id}' has no readable media on this machine"
            ),
        }
    }
}

impl std::error::Error for MediaLocalityError {}

/// Checks one asset's media before anything opens it.
///
/// An unknown asset id is *not* an error here: whichever operation was asked
/// for reports it in its own words, and there is no path to check.
pub fn check_asset_media(
    project_path: &Path,
    state: &ProjectState,
    asset_id: &str,
) -> Result<(), MediaLocalityError> {
    let Some(asset) = state.assets.get(asset_id) else {
        return Ok(());
    };

    // Import canonicalizes the URI, so on Windows it carries the `\\?\`
    // verbatim prefix. Stripping it is what tells an ordinary drive path apart
    // from a real UNC share, which keeps its prefix and is rejected below.
    let resolved = asset
        .resolved_path(project_path)
        .to_string_lossy()
        .into_owned();
    let media_path = strip_verbatim_prefix(&resolved);
    if is_network_path(&media_path) {
        return Err(MediaLocalityError::OffHost {
            asset_id: asset_id.to_string(),
        });
    }
    if !Path::new(media_path.as_ref()).exists() {
        return Err(MediaLocalityError::Unreadable {
            asset_id: asset_id.to_string(),
        });
    }

    Ok(())
}

/// Checks every asset a sequence's render will read.
///
/// The render graph covers the whole sequence, so every asset it references is
/// checked rather than the audible or visible subset alone: which layers
/// survive muting and trimming is the graph's decision, and media this machine
/// cannot read — or must not reach for — is worth refusing before FFmpeg is
/// spawned at all.
///
/// An unknown sequence id is not an error here either, for the same reason an
/// unknown asset id is not: the probe reports it with a message that says which
/// sequences do exist.
pub fn check_sequence_media(
    project_path: &Path,
    state: &ProjectState,
    sequence_id: &str,
) -> Result<(), MediaLocalityError> {
    let Some(sequence) = state.sequences.get(sequence_id) else {
        return Ok(());
    };

    for track in &sequence.tracks {
        for clip in &track.clips {
            check_asset_media(project_path, state, &clip.asset_id)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{Asset, VideoInfo};
    use crate::core::timeline::{Clip, Sequence, SequenceFormat, Track, TrackKind};

    /// Media on a UNC share, which must be refused before anything stats it.
    const SHARE_MEDIA: &str = r"\\share\media\clip.mp4";

    /// A project holding one absolutely-addressed video asset.
    fn project_with_asset(media: &str) -> ProjectState {
        let mut state = ProjectState::new("locality");
        let mut asset = Asset::new_video(
            "clip.mp4",
            media,
            VideoInfo {
                width: 1920,
                height: 1080,
                ..VideoInfo::default()
            },
        );
        asset.id = "asset-1".to_string();
        // `resolved_path` prefers a stored relative path, and the media under
        // test is addressed absolutely.
        asset.relative_path = None;
        state.assets.insert(asset.id.clone(), asset);
        state
    }

    /// The same project with the asset cut onto a sequence.
    fn project_with_sequence(media: &str) -> ProjectState {
        let mut state = project_with_asset(media);
        let mut sequence = Sequence::new("Sequence 1", SequenceFormat::default());
        sequence.id = "seq-1".to_string();
        let mut track = Track::new("V1", TrackKind::Video);
        let mut clip = Clip::new("asset-1");
        clip.id = "clip-1".to_string();
        clip.place.duration_sec = 5.0;
        track.clips.push(clip);
        sequence.tracks.push(track);
        state.sequences.insert(sequence.id.clone(), sequence);
        state
    }

    #[test]
    fn check_asset_media_should_reject_a_unc_path_without_touching_the_network() {
        let state = project_with_asset(SHARE_MEDIA);

        assert_eq!(
            check_asset_media(Path::new("."), &state, "asset-1"),
            Err(MediaLocalityError::OffHost {
                asset_id: "asset-1".to_string()
            })
        );
    }

    #[test]
    fn check_asset_media_should_accept_an_unknown_asset() {
        let state = project_with_asset("media/clip.mp4");

        assert_eq!(check_asset_media(Path::new("."), &state, "missing"), Ok(()));
    }

    #[test]
    fn check_sequence_media_should_refuse_a_clip_whose_media_is_off_host() {
        let state = project_with_sequence(SHARE_MEDIA);

        assert_eq!(
            check_sequence_media(Path::new("."), &state, "seq-1"),
            Err(MediaLocalityError::OffHost {
                asset_id: "asset-1".to_string()
            })
        );
    }

    #[test]
    fn check_sequence_media_should_accept_an_unknown_sequence() {
        let state = project_with_sequence("media/clip.mp4");

        assert_eq!(
            check_sequence_media(Path::new("."), &state, "missing"),
            Ok(())
        );
    }
}
