//! Whether a cached bundle's missing loudness numbers are worth measuring again.
//!
//! Both halves of the retry contract live here: the prefixes the pipeline
//! stamps on the `audio` job error when the meter is the only thing that
//! failed, and the gate that reads them back. They are one decision written in
//! two places, and keeping them apart is how a permanent failure ended up
//! marked retryable.
//!
//! The gate deliberately knows nothing about sessions or concurrency. Callers
//! that must not run the pass twice — the GUI serves the same bundle to every
//! panel that asks — pair it with their own once-per-asset set; see
//! `should_attempt_loudness_remeasure` in the IPC layer.

use super::audio::{LoudnessFailure, LoudnessFailureKind};
use super::types::AnalysisBundle;

/// Error prefix for a loudness pass that never reached a verdict.
///
/// The audio pass produced a profile — its silence and speech regions are
/// stored — and could not put numbers on it, for a reason that says nothing
/// about the media: the analysis timeout on a busy machine, an FFmpeg install
/// that came and went. The recorded message is the only thing that survives
/// into the cached bundle, so it is what marks the failure as worth one more
/// try.
pub const LOUDNESS_FAILURE_PREFIX: &str = "Loudness measurement failed: ";

/// Error prefix for a loudness pass that ran and could not produce numbers.
///
/// The meter looked at this media, with this FFmpeg build, and refused: it
/// measured nothing, every frame line was unreadable, the filter is missing,
/// there is no audio stream. Repeating the decode reaches the same verdict, so
/// the gate leaves it alone.
pub const LOUDNESS_UNMEASURABLE_PREFIX: &str = "Loudness could not be measured: ";

/// Renders a loudness failure as the message recorded against the `audio` job.
///
/// Every writer of that error goes through here, so a bundle can never carry a
/// reason the gate cannot classify.
pub fn loudness_bundle_error(failure: &LoudnessFailure) -> String {
    let prefix = match failure.kind {
        LoudnessFailureKind::Transient => LOUDNESS_FAILURE_PREFIX,
        LoudnessFailureKind::Unmeasurable => LOUDNESS_UNMEASURABLE_PREFIX,
    };

    format!("{}{}", prefix, failure.message)
}

/// Decides whether `bundle` should have its audio pass run again for loudness.
///
/// Two things have to hold:
///
/// * The bundle is missing loudness numbers it should have
///   ([`AnalysisBundle::needs_loudness_measurement`]).
/// * The recorded `audio` failure, if any, is one that could clear. A pass that
///   produced nothing — no audio stream, a file that will not decode — is the
///   pipeline saying it already tried, and rerunning it on every read would
///   decode the asset again to reach the same conclusion. A pass that stored
///   its regions and only lost the meter to a timeout or a missing binary is a
///   different animal: those causes clear on their own, and refusing forever
///   left the numbers permanently missing. Only [`LOUDNESS_FAILURE_PREFIX`]
///   marks that case, and [`loudness_bundle_error`] is the only thing that
///   writes it.
///
/// Re-measuring is a full FFmpeg decode of the asset, so a caller that reads a
/// bundle repeatedly must bound the retry itself; this function will keep
/// saying yes for as long as the bundle keeps saying it is missing numbers.
///
/// Every bundle a shipped build has written already carries one of the two
/// prefixes on a meter-only failure — the pipeline has recorded
/// `"Loudness measurement failed: "` verbatim since before the two were told
/// apart — so there is no cohort of older bundles whose `audio` error is
/// unprefixed and would be misread as hopeless. Bundles from those builds do
/// carry the transient prefix over what may have been a permanent failure; they
/// buy one more pass, which then rewrites the error with the prefix it deserves.
pub fn loudness_remeasure_wanted(bundle: &AnalysisBundle) -> bool {
    if !bundle.needs_loudness_measurement() {
        return false;
    }

    match bundle.errors.get("audio") {
        None => true,
        Some(error) => error.starts_with(LOUDNESS_FAILURE_PREFIX),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::analysis::types::{AudioProfile, SilenceRegion, VideoMetadata};
    use std::collections::HashSet;

    /// A cached bundle for an asset with audio whose loudness never got measured.
    fn bundle_awaiting_loudness(asset_id: &str) -> AnalysisBundle {
        let mut bundle = AnalysisBundle::new(asset_id, VideoMetadata::new(30.0).with_audio(true));
        let mut profile = AudioProfile::silent(30.0);
        profile.measurement_version = 0;
        profile.silence_regions = vec![SilenceRegion::new(0.0, 1.0)];
        profile.clear_loudness_measurement();
        bundle.audio_profile = Some(profile);
        bundle
    }

    /// Stands in for the caller's once-per-asset session set.
    fn claim(attempted: &mut HashSet<String>, bundle: &AnalysisBundle) -> bool {
        loudness_remeasure_wanted(bundle) && attempted.insert(bundle.asset_id.clone())
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: the same bundle is read twice in one session
    ///   Given a cached bundle whose loudness numbers are missing
    ///   When it is read again after a pass was already attempted
    ///   Then no second pass is queued
    ///
    /// Re-measuring decodes the whole asset. Before the session set, every read
    /// of a bundle the pass could not fix queued another full decode.
    #[test]
    fn should_attempt_a_loudness_remeasure_at_most_once_per_asset_per_session() {
        let bundle = bundle_awaiting_loudness("asset_1");
        let mut attempted = HashSet::new();

        assert!(claim(&mut attempted, &bundle));
        assert!(!claim(&mut attempted, &bundle));
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: the bundle already records an audio failure
    ///   Given a cached bundle whose audio job failed outright
    ///   When it is read
    ///   Then no pass is queued
    #[test]
    fn should_not_remeasure_loudness_when_the_bundle_records_an_audio_failure() {
        let mut bundle = bundle_awaiting_loudness("asset_2");
        bundle.add_error("audio", "FFmpeg is not installed".to_string());

        assert!(!loudness_remeasure_wanted(&bundle));
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: the recorded audio failure is only the meter's, and transient
    ///   Given a cached bundle whose audio pass stored its regions
    ///   And recorded a transient loudness-measurement failure over them
    ///   When it is read twice in one session
    ///   Then one pass is queued, and only one
    ///
    /// The causes of a transient meter failure — the analysis timeout on a busy
    /// machine, an FFmpeg build that came and went — clear on their own, so
    /// treating the recorded error as final left the numbers permanently
    /// missing for an asset that would measure fine on the next try. The
    /// caller's session set, not the error, is what keeps the retry to one.
    #[test]
    fn should_retry_a_loudness_only_failure_once_per_session() {
        let mut bundle = bundle_awaiting_loudness("asset_4");
        bundle.add_error(
            "audio",
            loudness_bundle_error(&LoudnessFailure {
                message: "Audio analysis timed out after 600s".to_string(),
                kind: LoudnessFailureKind::Transient,
            }),
        );
        let mut attempted = HashSet::new();

        assert!(
            claim(&mut attempted, &bundle),
            "a transient meter failure is worth one more try"
        );
        assert!(!claim(&mut attempted, &bundle), "but only one");
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: the meter ran and refused the media
    ///   Given a cached bundle whose audio pass stored its regions
    ///   And recorded a meter failure the pass reached by looking
    ///   When it is read
    ///   Then no pass is queued
    ///
    /// "Measured nothing" and "no readable momentary loudness" are verdicts
    /// about this media and this FFmpeg build. Marking them with the transient
    /// prefix bought a full decode per session that could only reach the same
    /// answer.
    #[test]
    fn should_not_remeasure_loudness_after_the_meter_refused_the_media() {
        let mut bundle = bundle_awaiting_loudness("asset_5");
        bundle.add_error(
            "audio",
            loudness_bundle_error(&LoudnessFailure {
                message: "The pass completed but measured nothing".to_string(),
                kind: LoudnessFailureKind::Unmeasurable,
            }),
        );

        assert!(!loudness_remeasure_wanted(&bundle));
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: an asset with no audible content is read
    ///   Given a bundle whose audio pass completed and found silence
    ///   When it is read
    ///   Then no pass is queued
    ///
    /// A silent asset has an empty loudness curve, which is also the shape a
    /// pass that never ran leaves behind. Telling them apart by the curve made
    /// every read of a silent asset re-analyse it.
    #[test]
    fn should_not_remeasure_loudness_for_an_asset_that_measured_as_silent() {
        let mut bundle = AnalysisBundle::new("asset_3", VideoMetadata::new(30.0).with_audio(true));
        bundle.audio_profile = Some(AudioProfile::silent(30.0));

        assert!(!loudness_remeasure_wanted(&bundle));
    }
}
