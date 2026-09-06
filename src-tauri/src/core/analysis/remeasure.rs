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
//! panel that asks — hold their own once-per-asset set and claim a slot in it
//! through [`claim_loudness_remeasure`]; see `should_attempt_loudness_remeasure`
//! in the IPC layer.

use std::collections::HashSet;

use super::audio::{LoudnessFailure, LoudnessFailureKind};
use super::types::{AnalysisBundle, AUDIO_MEASUREMENT_VERSION};
use crate::core::CoreError;

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

/// Error prefix for a whole audio pass that never reached a verdict.
///
/// The counterpart of [`LOUDNESS_FAILURE_PREFIX`] one level up: nothing was
/// produced at all — not the silence regions, not the speech regions, not the
/// numbers — for a reason that says nothing about the media. It is a separate
/// word from the loudness pair because it describes a different loss, and an
/// agent reading `"Loudness measurement failed"` over a run that produced no
/// regions either was being told to trust regions this run never wrote.
pub const AUDIO_PASS_FAILURE_PREFIX: &str = "Audio analysis failed: ";

/// Error prefix for a whole audio pass that ran and settled the question.
///
/// The media has no audio stream, or the pass looked and could not analyse it.
/// Repeating the decode reaches the same verdict, so the gate leaves it alone.
pub const AUDIO_PASS_UNMEASURABLE_PREFIX: &str = "Audio could not be analysed: ";

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

/// Renders a whole audio pass that failed as the message recorded against the job.
///
/// The loudness-only path classifies at the meter; a pass that failed outright
/// never got that far, so its [`CoreError`] is classified instead. The verdict
/// is the same question — could a later pass still succeed — so the gate reads
/// both vocabularies, but the wording is the pass's own: this run produced
/// nothing, and recording the bare error text made it look like a verdict and
/// stranded the asset's cached profile without numbers.
pub fn audio_pass_bundle_error(error: &CoreError) -> String {
    let failure = LoudnessFailure::from_error(error);
    let prefix = match failure.kind {
        LoudnessFailureKind::Transient => AUDIO_PASS_FAILURE_PREFIX,
        LoudnessFailureKind::Unmeasurable => AUDIO_PASS_UNMEASURABLE_PREFIX,
    };

    format!("{}{}", prefix, failure.message)
}

/// Whether a recorded `audio` error marks a failure that could still clear.
fn audio_error_is_retryable(error: &str) -> bool {
    error.starts_with(LOUDNESS_FAILURE_PREFIX) || error.starts_with(AUDIO_PASS_FAILURE_PREFIX)
}

/// Whether a recorded `audio` error marks a verdict the pass reached by looking.
fn audio_error_is_settled(error: &str) -> bool {
    error.starts_with(LOUDNESS_UNMEASURABLE_PREFIX)
        || error.starts_with(AUDIO_PASS_UNMEASURABLE_PREFIX)
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
///   writes it. A profile from a superseded [`AUDIO_MEASUREMENT_VERSION`] is
///   the exception: the pass that refused no longer exists, so its verdict does
///   not bind the one that would run now.
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
///
/// Whole-pass failures are the exception, and knowingly so: earlier builds
/// recorded them as the bare [`CoreError`] text, with no prefix at all. Such a
/// message is neither retryable nor settled — it belongs to no vocabulary this
/// module writes — so it buys no decodes here, and it does not earn the
/// version stamp that [`settle_audio_measurement_version`] gives a real settled
/// verdict either. That is the safe direction, and it is not permanent: such a
/// bundle is still re-measured once its profile turns out to carry a superseded
/// [`AUDIO_MEASUREMENT_VERSION`], which is the same escape hatch every settled
/// verdict has.
pub fn loudness_remeasure_wanted(bundle: &AnalysisBundle) -> bool {
    if !bundle.needs_loudness_measurement() {
        return false;
    }

    // A settled verdict is settled for the pass that reached it. Once
    // AUDIO_MEASUREMENT_VERSION moves, the pass that would run now is not the
    // pass that refused, so the old refusal does not bind it — that is the
    // whole point of bumping the version, and letting the recorded error
    // outrank it would leave exactly the assets a fix was written for stuck on
    // the verdict of the build that could not measure them.
    if loudness_measurement_superseded(bundle) {
        return true;
    }

    match bundle.errors.get("audio") {
        None => true,
        Some(error) => audio_error_is_retryable(error),
    }
}

/// Returns `true` when the profile's numbers came from a superseded audio pass.
fn loudness_measurement_superseded(bundle: &AnalysisBundle) -> bool {
    bundle
        .audio_profile
        .as_ref()
        .is_some_and(|profile| profile.measurement_version < AUDIO_MEASUREMENT_VERSION)
}

/// Stamps a retained audio profile with the version of the pass that just refused.
///
/// Call it on a merged bundle, after the run's `audio` error has been recorded.
/// It does nothing unless that error is a settled verdict, and returns `true`
/// only when a profile's version actually moved.
///
/// This is what makes [`loudness_remeasure_wanted`] converge. A bundle cached by
/// a superseded pass is retried regardless of its recorded error — the refusal
/// binds the pass that reached it, not the one running now — and an audio-only
/// run keeps that cached profile when its pass fails. Without this stamp the
/// retained profile still carried the old version, so the very next read asked
/// for the pass again, and every launch paid for one more full decode to hear
/// the same "no audio stream".
///
/// Only the version moves. The numbers stay cleared and
/// [`AudioProfile::loudness_measured`] stays `false`, so
/// [`AnalysisBundle::needs_loudness_measurement`] still reports the gap and the
/// recorded error is what decides whether it is worth chasing.
///
/// [`AudioProfile::loudness_measured`]: super::types::AudioProfile::loudness_measured
pub fn settle_audio_measurement_version(bundle: &mut AnalysisBundle) -> bool {
    let settled = bundle
        .errors
        .get("audio")
        .is_some_and(|error| audio_error_is_settled(error));
    if !settled {
        return false;
    }

    bundle.stamp_audio_measurement_version()
}

/// Claims this session's single re-measure slot for `bundle`'s asset.
///
/// [`loudness_remeasure_wanted`] answers the question about the bundle; this
/// adds the one thing that is not a property of it — no pass has been attempted
/// for this asset in this session — and claims the slot in the same step, so
/// two reads of the same asset that arrive together produce one pass, not two.
///
/// Callers hold `attempted` behind whatever lock their concurrency needs and
/// pass it in; the set is what bounds the retry, since a transient failure is
/// worth trying again on the next launch but not on the next read.
pub fn claim_loudness_remeasure(bundle: &AnalysisBundle, attempted: &mut HashSet<String>) -> bool {
    loudness_remeasure_wanted(bundle) && attempted.insert(bundle.asset_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::analysis::types::{AudioProfile, SilenceRegion, VideoMetadata};

    /// A cached bundle for an asset with audio whose loudness never got measured.
    ///
    /// The profile is stamped with the *current* measurement version: this is
    /// the shape the audio pass writes when it stored its regions and the meter
    /// failed over them, and the recorded error is what the gate has to weigh.
    fn bundle_awaiting_loudness(asset_id: &str) -> AnalysisBundle {
        let mut bundle = AnalysisBundle::new(asset_id, VideoMetadata::new(30.0).with_audio(true));
        let mut profile = AudioProfile::silent(30.0);
        profile.measurement_version = AUDIO_MEASUREMENT_VERSION;
        profile.silence_regions = vec![SilenceRegion::new(0.0, 1.0)];
        profile.clear_loudness_measurement();
        bundle.audio_profile = Some(profile);
        bundle
    }

    /// The same bundle, but measured by a pass that has since been superseded.
    fn bundle_from_a_superseded_pass(asset_id: &str) -> AnalysisBundle {
        let mut bundle = bundle_awaiting_loudness(asset_id);
        if let Some(profile) = bundle.audio_profile.as_mut() {
            profile.measurement_version = AUDIO_MEASUREMENT_VERSION.saturating_sub(1);
        }
        bundle
    }

    /// Records a settled meter refusal against the bundle's `audio` job.
    fn record_unmeasurable(bundle: &mut AnalysisBundle) {
        bundle.add_error(
            "audio",
            loudness_bundle_error(&LoudnessFailure {
                message: "The pass completed but measured nothing".to_string(),
                kind: LoudnessFailureKind::Unmeasurable,
            }),
        );
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

        assert!(claim_loudness_remeasure(&bundle, &mut attempted));
        assert!(!claim_loudness_remeasure(&bundle, &mut attempted));
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: the bundle already records an audio failure
    ///   Given a cached bundle whose audio job failed outright
    ///   And an error message carrying none of the prefixes
    ///   When it is read
    ///   Then no pass is queued
    ///
    /// This is also the shape of a whole-pass failure written by a build from
    /// before the prefixes existed: unprefixed, so it is neither retryable nor
    /// settled. It buys no decodes on the strength of the message — the safe
    /// direction — and it earns no version stamp either, so such a bundle is
    /// still picked up by the superseded-version escape hatch when a fix bumps
    /// [`AUDIO_MEASUREMENT_VERSION`].
    #[test]
    fn should_not_remeasure_loudness_when_the_bundle_records_an_audio_failure() {
        let mut bundle = bundle_awaiting_loudness("asset_2");
        bundle.add_error("audio", "FFmpeg is not installed".to_string());

        assert!(!loudness_remeasure_wanted(&bundle));
        assert!(
            !settle_audio_measurement_version(&mut bundle),
            "a message in neither vocabulary is not a settled verdict to stamp"
        );
    }

    /// Feature: the vocabulary of a recorded `audio` failure
    /// Scenario: each kind of failure is rendered for the bundle
    ///   Given a meter-only failure and a whole-pass failure, of each kind
    ///   When each is rendered
    ///   Then the loudness pair names the meter and the pass pair names the pass
    ///
    /// A whole-pass failure used to be recorded as "Loudness measurement
    /// failed", over a run that had produced no silence or speech regions
    /// either, while the skill reference told agents to trust the regions in
    /// exactly that case.
    #[test]
    fn should_word_a_whole_pass_failure_as_the_pass_and_not_as_the_meter() {
        assert_eq!(
            loudness_bundle_error(&LoudnessFailure {
                message: "Audio analysis timed out after 600s".to_string(),
                kind: LoudnessFailureKind::Transient,
            }),
            "Loudness measurement failed: Audio analysis timed out after 600s"
        );
        assert_eq!(
            loudness_bundle_error(&LoudnessFailure {
                message: "The pass completed but measured nothing".to_string(),
                kind: LoudnessFailureKind::Unmeasurable,
            }),
            "Loudness could not be measured: The pass completed but measured nothing"
        );
        // The whole-pass message is the `CoreError`'s own rendering, which
        // carries the variant's word for how the verdict crossed that boundary.
        assert_eq!(
            audio_pass_bundle_error(&CoreError::Internal(
                "Audio analysis timed out after 600s".to_string()
            )),
            "Audio analysis failed: Internal error: Audio analysis timed out after 600s"
        );
        assert_eq!(
            audio_pass_bundle_error(&CoreError::AnalysisFailed(
                "No audio stream found in input".to_string()
            )),
            "Audio could not be analysed: Analysis failed: No audio stream found in input"
        );
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
            claim_loudness_remeasure(&bundle, &mut attempted),
            "a transient meter failure is worth one more try"
        );
        assert!(
            !claim_loudness_remeasure(&bundle, &mut attempted),
            "but only one"
        );
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
        record_unmeasurable(&mut bundle);

        assert!(!loudness_remeasure_wanted(&bundle));
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: the measurement version moved on after the meter refused
    ///   Given a cached bundle carrying a settled meter refusal
    ///   And a profile from a pass that a later version superseded
    ///   When it is read
    ///   Then a pass is queued
    ///
    /// A verdict binds the pass that reached it. Bumping
    /// [`AUDIO_MEASUREMENT_VERSION`] is how a fix says the numbers this build
    /// produces are different ones, so letting the old refusal outrank it would
    /// strand exactly the assets the fix was written for.
    #[test]
    fn should_remeasure_loudness_when_the_refusing_pass_has_been_superseded() {
        let mut bundle = bundle_from_a_superseded_pass("asset_6");
        record_unmeasurable(&mut bundle);

        assert!(loudness_remeasure_wanted(&bundle));
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: the refusal came from the pass that would run now
    ///   Given a cached bundle carrying a settled meter refusal
    ///   And a profile from the current measurement version
    ///   When it is read
    ///   Then no pass is queued
    ///
    /// The counterpart to the superseded case: without the version check the
    /// gate would still be reading only the prefix, and with a version check
    /// that ignored it, every settled refusal would retry forever.
    #[test]
    fn should_not_remeasure_loudness_when_the_current_pass_refused_the_media() {
        let mut bundle = bundle_awaiting_loudness("asset_7");
        record_unmeasurable(&mut bundle);

        assert!(!loudness_remeasure_wanted(&bundle));
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: the whole audio pass timed out over a cached profile
    ///   Given a cached bundle whose loudness numbers are missing
    ///   And a later run whose whole audio pass timed out
    ///   When the bundle is read twice in one session
    ///   Then one pass is queued, and only one
    ///
    /// The merge keeps the earlier profile, so the regions are still there and
    /// only the numbers are missing — the same situation as a meter-only
    /// failure. Recording the whole-pass error unclassified made it read as a
    /// verdict about the media and left those numbers missing for good.
    #[test]
    fn should_retry_a_transient_whole_pass_failure_over_a_cached_profile() {
        let mut bundle = bundle_awaiting_loudness("asset_8");
        bundle.add_error(
            "audio",
            audio_pass_bundle_error(&CoreError::Internal(
                "Audio analysis timed out after 600s".to_string(),
            )),
        );
        let mut attempted = HashSet::new();

        assert!(claim_loudness_remeasure(&bundle, &mut attempted));
        assert!(!claim_loudness_remeasure(&bundle, &mut attempted));
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: the whole audio pass timed out with nothing cached
    ///   Given a bundle with no audio profile at all
    ///   And a whole audio pass that timed out
    ///   When it is read
    ///   Then no pass is queued
    ///
    /// There are no regions to complete: the re-measure path fills in loudness
    /// over a profile that exists, and a bundle without one needs the ordinary
    /// analysis run, not this.
    #[test]
    fn should_not_remeasure_a_transient_whole_pass_failure_without_a_cached_profile() {
        let mut bundle = AnalysisBundle::new("asset_9", VideoMetadata::new(30.0).with_audio(true));
        bundle.add_error(
            "audio",
            audio_pass_bundle_error(&CoreError::Internal(
                "Audio analysis timed out after 600s".to_string(),
            )),
        );

        assert!(!loudness_remeasure_wanted(&bundle));
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: the whole audio pass settled the question
    ///   Given a cached bundle whose loudness numbers are missing
    ///   And a whole audio pass that failed on the media itself
    ///   When it is read
    ///   Then no pass is queued
    #[test]
    fn should_not_retry_a_settled_whole_pass_failure() {
        let mut bundle = bundle_awaiting_loudness("asset_10");
        bundle.add_error(
            "audio",
            audio_pass_bundle_error(&CoreError::AnalysisFailed(
                "No audio stream found in input".to_string(),
            )),
        );

        assert!(!loudness_remeasure_wanted(&bundle));
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: a pass settles the question over a superseded profile
    ///   Given a cached bundle whose profile came from a superseded pass
    ///   And a whole audio pass that then found no audio stream at all
    ///   When the run's verdict is stamped onto the retained profile
    ///   Then the next session queues no pass
    ///
    /// The superseded-version check outranks the recorded error, which is what
    /// lets a fix reach the assets it was written for — but nothing withdrew
    /// the request once a pass had answered it. A legacy profile whose asset
    /// really has no audio stream asked for the pass on every read, forever,
    /// and each launch paid for one more full decode to hear the same answer.
    #[test]
    fn should_stop_asking_for_a_pass_once_one_has_settled_a_superseded_profile() {
        let mut bundle = bundle_from_a_superseded_pass("asset_11");
        assert!(
            loudness_remeasure_wanted(&bundle),
            "a superseded profile is worth one pass"
        );

        bundle.add_error(
            "audio",
            audio_pass_bundle_error(&CoreError::AnalysisFailed(
                "No audio stream found in input".to_string(),
            )),
        );
        assert!(
            settle_audio_measurement_version(&mut bundle),
            "the retained profile must be stamped with the pass that just ran"
        );

        assert!(
            bundle.needs_loudness_measurement(),
            "the numbers are still missing and readers must still say so"
        );
        assert!(
            !loudness_remeasure_wanted(&bundle),
            "but the question has been answered, so no further pass is queued"
        );
    }

    /// Feature: automatic loudness re-measurement
    /// Scenario: the pass that failed could still succeed later
    ///   Given a cached bundle whose profile came from a superseded pass
    ///   And a whole audio pass that timed out
    ///   When the run's verdict is weighed
    ///   Then the profile keeps its stale version and a pass is still queued
    ///
    /// Only a settled verdict withdraws the standing request: a timeout has
    /// answered nothing, and stamping over it would strand exactly the assets
    /// the version bump was written for.
    #[test]
    fn should_leave_a_superseded_profile_asking_after_a_transient_failure() {
        let mut bundle = bundle_from_a_superseded_pass("asset_12");
        bundle.add_error(
            "audio",
            audio_pass_bundle_error(&CoreError::Internal(
                "Audio analysis timed out after 600s".to_string(),
            )),
        );

        assert!(!settle_audio_measurement_version(&mut bundle));
        assert!(loudness_remeasure_wanted(&bundle));
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
