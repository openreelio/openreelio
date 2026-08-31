//! Convergent preview-cache fill.
//!
//! A fill is described by the set of segments it is trying to produce — its
//! [`CacheFillWorkSet`] — rather than by the frozen list it was spawned with.
//! That distinction is what makes repeated requests convergent instead of
//! destructive.
//!
//! # Why a request is not automatically a supersede
//!
//! The cache is filled by whatever notices work to do: a manual request, an
//! edit landing, a status refresh. Treating every one of those as "cancel the
//! in-flight FFmpeg and start again" means a burst of requests renders nothing
//! at all — each one kills the encode the previous one started, so the fill
//! never converges while the user is working.
//!
//! The rule adopted here — informed by how background render caching behaves in
//! established finishing tools — is: *cancel a segment only when that segment's
//! own work changed*. A request that asks for the same work as the fill running
//! is a no-op ([`EnsureAction::AlreadyConverging`]); a request that changes the
//! queue swaps the queue in place and leaves an unaffected in-flight encode
//! alone ([`EnsureAction::Retarget`]); only a request for a different sequence
//! or a different encode profile — where nothing already on disk is
//! byte-compatible — throws the fill away ([`EnsureAction::Supersede`]).
//!
//! Segment identity is the plan fingerprint
//! ([`SegmentFingerprint`]), which already covers the render plan, the encode
//! profile, the renderer's compositor semantics and the timeline content inside
//! the segment's window. If it is unchanged, re-rendering the segment would
//! produce the same bytes, so the encode in flight is still the right one.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::cache::{RenderCacheManifest, SegmentFingerprint};

/// Which segments a preview-cache fill request is asking for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PreviewCacheScope {
    /// Every segment that needs rendering, in timeline order.
    #[default]
    WholeTimeline,
    /// Only segments the live preview cannot draw faithfully, and only those the
    /// export path can actually render.
    ///
    /// This is the scope that buys accuracy rather than smoothness: a flagged
    /// segment is one where what the user sees and what the export produces
    /// disagree, so filling it replaces a guess with the real composite.
    Flagged,
}

impl PreviewCacheScope {
    /// Stable key for this scope in event payloads.
    ///
    /// Matches the serde representation, so a frontend can compare it against
    /// the value it would send.
    pub fn event_key(self) -> &'static str {
        match self {
            Self::WholeTimeline => "whole_timeline",
            Self::Flagged => "flagged",
        }
    }

    /// The wider of two scopes.
    ///
    /// [`WholeTimeline`](Self::WholeTimeline) subsumes
    /// [`Flagged`](Self::Flagged): every flagged segment needing a render is also
    /// a segment needing a render. When two requests meet, the fill keeps the
    /// wider label so it never advertises itself as doing less than it is.
    pub fn broader(self, other: Self) -> Self {
        match (self, other) {
            (Self::WholeTimeline, _) | (_, Self::WholeTimeline) => Self::WholeTimeline,
            (Self::Flagged, Self::Flagged) => Self::Flagged,
        }
    }
}

/// The segments one convergent preview-cache fill is trying to produce.
///
/// The queue is shared with the running fill task, which pops from it, and with
/// later requests, which replace it wholesale. Both ends therefore agree on
/// exactly one thing: a segment index paired with the fingerprint of the work
/// that segment currently represents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheFillWorkSet {
    /// Sequence whose cache is being filled.
    pub sequence_id: String,
    /// Encode profile the segments are produced with.
    pub profile_hash: String,
    /// What this fill advertises itself as doing.
    ///
    /// Carried on the work set rather than captured at spawn time so that a
    /// retarget which widens the fill also widens the label every event reports —
    /// see [`merge_work_sets`].
    pub scope: PreviewCacheScope,
    /// `(index, fingerprint)` pairs, ascending by index (canonicalized on
    /// construction).
    pub segments: Vec<(u32, SegmentFingerprint)>,
}

impl CacheFillWorkSet {
    /// Builds a work set, canonicalizing the segment list.
    ///
    /// Segments are sorted ascending by index and de-duplicated by index, so two
    /// requests that name the same work in a different order compare equal. That
    /// equality is what [`decide_ensure_action`] uses to recognize a repeated
    /// request, so the ordering cannot be left to the caller.
    ///
    /// A duplicated index keeps its first fingerprint after sorting; the caller
    /// derives the list from a manifest, where an index appears once, so a
    /// duplicate can only be a caller bug and there is no better answer to pick.
    pub fn new(
        sequence_id: impl Into<String>,
        profile_hash: impl Into<String>,
        scope: PreviewCacheScope,
        segments: Vec<(u32, SegmentFingerprint)>,
    ) -> Self {
        let mut segments = segments;
        segments.sort_by_key(|(index, _)| *index);
        segments.dedup_by_key(|(index, _)| *index);
        Self {
            sequence_id: sequence_id.into(),
            profile_hash: profile_hash.into(),
            scope,
            segments,
        }
    }

    /// The fingerprint this work set expects for `index`, if it wants it at all.
    pub fn fingerprint_of(&self, index: u32) -> Option<SegmentFingerprint> {
        self.segments
            .iter()
            .find(|(candidate, _)| *candidate == index)
            .map(|(_, fingerprint)| *fingerprint)
    }

    /// Number of segments still queued.
    pub fn len(&self) -> usize {
        self.segments.len()
    }

    /// Whether nothing is left to render.
    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }

    /// Number of segments queued other than `index`.
    ///
    /// The fill measures its own progress with this: a retarget can put the
    /// segment that just finished back on the queue (its manifest entry was
    /// momentarily `Rendering`, which a fresh prepare resets to `Error`), and
    /// counting it as both done and outstanding would understate progress
    /// forever.
    pub fn len_excluding(&self, index: u32) -> usize {
        self.segments
            .iter()
            .filter(|(candidate, _)| *candidate != index)
            .count()
    }

    /// Pops the lowest-index segment `still_needed` accepts, discarding the
    /// entries it rejects along the way.
    ///
    /// The fill re-reads the manifest before every segment, so a queued entry
    /// can have been rendered, evicted or invalidated since it was queued. It is
    /// removed either way: an entry that no longer needs rendering has nothing
    /// left to do, and leaving it queued would make the fill re-examine it
    /// forever.
    pub fn pop_next_where(
        &mut self,
        still_needed: impl Fn(u32) -> bool,
    ) -> Option<(u32, SegmentFingerprint)> {
        while !self.segments.is_empty() {
            let entry = self.segments.remove(0);
            if still_needed(entry.0) {
                return Some(entry);
            }
        }
        None
    }
}

/// A read-only view of the fill currently registered as active.
pub struct ActiveFillView<'a> {
    /// The queue that fill is working through.
    pub work: &'a CacheFillWorkSet,
    /// `(index, fingerprint)` of the segment whose FFmpeg is running, if any.
    pub in_flight: Option<(u32, SegmentFingerprint)>,
}

/// What a fresh fill request should do about the fill already in flight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnsureAction {
    /// Nothing is running: register and spawn.
    Start,
    /// The running fill is already producing exactly this work set.
    AlreadyConverging,
    /// Same fill, different work set: swap the queue in place. `cancel_in_flight`
    /// is true only when the in-flight segment's fingerprint moved or it left the
    /// work set, so a segment still being rendered correctly finishes.
    Retarget {
        /// Whether the segment currently encoding is now producing the wrong bytes.
        cancel_in_flight: bool,
    },
    /// Different sequence or encode profile: everything on disk is byte-incompatible.
    Supersede,
}

/// Decides how a fresh fill request relates to the fill already in flight.
///
/// See the module docs for why a repeated request converges instead of
/// restarting.
///
/// `desired` must already have been folded through [`merge_work_sets`], so what
/// arrives here is the complete set the fill should be converging on.
///
/// # The `AlreadyConverging` invariant
///
/// A no-op requires *two* things, not one: the queue must be unchanged **and**
/// whatever is encoding right now must still be wanted at the same fingerprint.
/// The second half is not redundant, because the in-flight segment has been
/// popped and so is normally missing from the queue — comparing queues alone
/// would declare "nothing to do" while an encode produced bytes this request has
/// already invalidated.
///
/// Today the reconcile step in the ensure path resets an interrupted
/// `Rendering` segment to `Error`, which puts the in-flight segment back into
/// every freshly derived work set and therefore makes the queues differ anyway.
/// That is an accident of one policy choice, not a guarantee; the invariant is
/// checked directly so a future `Preserve` policy cannot turn it into a silent
/// data bug.
pub fn decide_ensure_action(
    active: Option<&ActiveFillView<'_>>,
    desired: &CacheFillWorkSet,
) -> EnsureAction {
    let Some(active) = active else {
        return EnsureAction::Start;
    };

    // A different sequence or profile writes to a different directory with
    // different encode settings, so none of the running fill's remaining work
    // can be reused and converging onto it is meaningless.
    if active.work.sequence_id != desired.sequence_id
        || active.work.profile_hash != desired.profile_hash
    {
        return EnsureAction::Supersede;
    }

    // The in-flight encode is only wrong if *its own* work changed: either the
    // new work set no longer wants that segment, or it wants it at a different
    // fingerprint. A neighbouring segment moving says nothing about it.
    //
    // The in-flight segment is normally *absent* from the active queue, because
    // the fill pops before it encodes. So an unchanged queue does not by itself
    // mean there is nothing to do: the encode running right now could still be
    // producing bytes this request no longer wants.
    let in_flight_is_wanted = match active.in_flight {
        Some((index, fingerprint)) => desired.fingerprint_of(index) == Some(fingerprint),
        None => true,
    };

    if active.work.segments == desired.segments && in_flight_is_wanted {
        return EnsureAction::AlreadyConverging;
    }

    EnsureAction::Retarget {
        cancel_in_flight: !in_flight_is_wanted,
    }
}

/// Folds a fresh request into the work a running fill already owns.
///
/// Callers must have established that the two describe the same sequence and
/// encode profile; a mismatch there is [`EnsureAction::Supersede`], not a merge.
///
/// A request in the **same scope** replaces the active set outright: it was
/// derived from a freshly reconciled manifest, so it is a complete and more
/// current answer to the same question.
///
/// A request in a **different scope** is unioned instead, and keeps the
/// [`broader`](PreviewCacheScope::broader) label. Replacing here would silently
/// throw away work: a `Flagged` request arriving while a `WholeTimeline` fill is
/// running would shrink that fill to the flagged segments alone, and nothing
/// would ever put the rest back. On an index in both sets the fresher
/// fingerprint — the incoming one — wins.
///
/// # Folding in the segment that is encoding
///
/// `in_flight` is the identity of the segment whose FFmpeg is running. It
/// appears in **neither** list: the fill pops a segment before it encodes it,
/// and a fresh request may have no opinion about it either. Leaving it out would
/// make it look dropped, which cancels a perfectly good encode *and* strands the
/// segment in no queue at all — a request for more work would lose work.
///
/// So it is re-added at the fingerprint it is being encoded for whenever nothing
/// else in the merged set already names it. The rule holds in every direction:
///
/// - **Cross-scope.** A `Flagged` request omits an unflagged in-flight segment
///   because its filter tests "is this flagged", not "is this being worked on".
///   Silence there is not a decision, so the broader fill keeps the segment.
/// - **Same scope, today.** The ensure path reconciles the interrupted
///   `Rendering` state to `Error`, so a same-scope request already lists the
///   in-flight segment at the manifest's current fingerprint. That entry wins,
///   and the fold changes nothing.
/// - **Same scope, under a future `Preserve` policy.** The segment would stay
///   `Rendering`, drop out of `needs_render`, and vanish from the request — as
///   "already being handled", not "unwanted". The fold keeps it, so the policy
///   change cannot turn into a spurious cancel.
///
/// The effect is that the cancel decision keys purely on a *fingerprint change*
/// rather than on absence. A segment that genuinely disappeared — the timeline
/// shrank past it — is no longer cancelled, but it cannot corrupt anything:
/// [`verdict_for_rendered_segment`] discards bytes whose segment is gone from
/// the manifest. The cost is one wasted encode in a rare case, against a
/// guaranteed lost encode in a common one.
pub fn merge_work_sets(
    active: &CacheFillWorkSet,
    desired: &CacheFillWorkSet,
    in_flight: Option<(u32, SegmentFingerprint)>,
) -> CacheFillWorkSet {
    let cross_scope = active.scope != desired.scope;
    let mut segments = desired.segments.clone();

    if cross_scope {
        segments.extend(
            active
                .segments
                .iter()
                .filter(|(index, _)| desired.fingerprint_of(*index).is_none())
                .copied(),
        );
    }

    if let Some((index, fingerprint)) = in_flight {
        if !segments.iter().any(|(candidate, _)| *candidate == index) {
            segments.push((index, fingerprint));
        }
    }

    CacheFillWorkSet::new(
        desired.sequence_id.clone(),
        desired.profile_hash.clone(),
        if cross_scope {
            active.scope.broader(desired.scope)
        } else {
            desired.scope
        },
        segments,
    )
}

/// What to do with a segment whose encode just succeeded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderedSegmentVerdict {
    /// The bytes still match what the manifest says the segment should be.
    Accept,
    /// The segment's identity moved while it was encoding: throw the file away.
    Discard,
}

/// Decides whether a finished encode may be recorded as this segment's cache.
///
/// `rendered` is the fingerprint the encode was started for; `stored` is what
/// the manifest says the segment's fingerprint is *now*, freshly reloaded.
///
/// They can differ: an edit landing mid-encode re-fingerprints the manifest, and
/// the encode that is already running was built from the pre-edit timeline. If
/// such a file were marked `Cached` it would inherit the new fingerprint by
/// association and look current forever — the freshness check compares stored
/// fingerprints against the plan, sees a match, and never re-renders it. That is
/// a permanently wrong cache served as truth, so a mismatch discards.
///
/// A segment that has vanished from the manifest (`stored` is `None`) also
/// discards: there is nothing left to attach the bytes to.
pub fn verdict_for_rendered_segment(
    rendered: SegmentFingerprint,
    stored: Option<SegmentFingerprint>,
) -> RenderedSegmentVerdict {
    if stored == Some(rendered) {
        RenderedSegmentVerdict::Accept
    } else {
        RenderedSegmentVerdict::Discard
    }
}

/// What a fill does after its current segment reports `Cancelled`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelledOutcome {
    /// A newer fill owns the cache now: stop.
    StopFill,
    /// Only this segment was cancelled: keep going with the retargeted queue.
    ContinueFill,
}

/// Maps a cancelled segment onto the fill's next move.
///
/// The exporter reports the same `Cancelled` error whichever cancel fired, so
/// the fill distinguishes them by the supersede flag: a targeted cancel never
/// sets it (see
/// [`PreviewCacheCancel::cancel_segment_if_stale`](super::preview_cancel::PreviewCacheCancel::cancel_segment_if_stale)),
/// which is exactly what makes the segment-level cancel non-fatal to the fill.
pub fn cancelled_outcome(superseded: bool) -> CancelledOutcome {
    if superseded {
        CancelledOutcome::StopFill
    } else {
        CancelledOutcome::ContinueFill
    }
}

/// Picks the segments a fill of `scope` should produce, in timeline order.
///
/// Only segments that need rendering are ever selected;
/// [`PreviewCacheScope::Flagged`] narrows that to segments the live preview
/// cannot draw faithfully.
///
/// A flagged segment is skipped when *any* of its reasons is not
/// [`fill_renderable`](super::cache::SegmentFlagReason::fill_renderable): those
/// mark content the export path itself refuses or errors on (compound clips,
/// missing assets, overlay-track media), so queueing them would make the fill
/// retry a render that can only fail, forever. The flag still stands — the
/// preview there is still untrustworthy — it just cannot be resolved by
/// rendering.
pub fn select_fill_segments(
    manifest: &RenderCacheManifest,
    scope: PreviewCacheScope,
) -> Vec<(u32, SegmentFingerprint)> {
    manifest
        .segments
        .iter()
        .filter(|segment| segment.needs_render())
        .filter(|segment| match scope {
            PreviewCacheScope::WholeTimeline => true,
            PreviewCacheScope::Flagged => {
                segment.flagged()
                    && segment
                        .flag_reasons
                        .iter()
                        .all(|reason| reason.fill_renderable())
            }
        })
        .map(|segment| (segment.index, segment.fingerprint))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::render::cache::{CacheSegmentState, SegmentFlagReason};

    const PROFILE: &str = "profile-a";

    fn work(segments: &[(u32, SegmentFingerprint)]) -> CacheFillWorkSet {
        scoped_work(PreviewCacheScope::WholeTimeline, segments)
    }

    fn scoped_work(
        scope: PreviewCacheScope,
        segments: &[(u32, SegmentFingerprint)],
    ) -> CacheFillWorkSet {
        CacheFillWorkSet::new("seq1", PROFILE, scope, segments.to_vec())
    }

    fn active<'a>(
        work: &'a CacheFillWorkSet,
        in_flight: Option<(u32, SegmentFingerprint)>,
    ) -> ActiveFillView<'a> {
        ActiveFillView { work, in_flight }
    }

    fn manifest_with(
        segments: Vec<(CacheSegmentState, Vec<SegmentFlagReason>)>,
    ) -> RenderCacheManifest {
        let mut manifest =
            RenderCacheManifest::new("seq1", PROFILE, segments.len() as f64 * 5.0, 5.0);
        for (index, (state, reasons)) in segments.into_iter().enumerate() {
            let segment = &mut manifest.segments[index];
            segment.state = state;
            segment.flag_reasons = reasons;
            segment.fingerprint = 100 + index as u64;
        }
        manifest
    }

    // -----------------------------------------------------------------------
    // decide_ensure_action
    // -----------------------------------------------------------------------

    /// Feature: Convergent preview-cache fill
    /// Scenario: nothing is running
    #[test]
    fn should_start_when_no_fill_is_active() {
        let desired = work(&[(0, 10), (1, 11)]);

        assert_eq!(decide_ensure_action(None, &desired), EnsureAction::Start);
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: a repeated request asks for work already under way
    #[test]
    fn should_report_already_converging_when_the_work_set_is_unchanged() {
        let running = work(&[(0, 10), (1, 11)]);
        let view = active(&running, Some((0, 10)));
        let desired = work(&[(0, 10), (1, 11)]);

        assert_eq!(
            decide_ensure_action(Some(&view), &desired),
            EnsureAction::AlreadyConverging
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: the queue grows while the in-flight segment is unaffected
    #[test]
    fn should_retarget_without_cancelling_when_the_in_flight_segment_is_unchanged() {
        let running = work(&[(0, 10), (1, 11)]);
        let view = active(&running, Some((0, 10)));
        let desired = work(&[(0, 10), (1, 11), (2, 12)]);

        assert_eq!(
            decide_ensure_action(Some(&view), &desired),
            EnsureAction::Retarget {
                cancel_in_flight: false
            }
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: the segment being encoded was edited
    #[test]
    fn should_cancel_the_in_flight_segment_when_its_fingerprint_moved() {
        let running = work(&[(0, 10), (1, 11)]);
        let view = active(&running, Some((0, 10)));
        let desired = work(&[(0, 99), (1, 11)]);

        assert_eq!(
            decide_ensure_action(Some(&view), &desired),
            EnsureAction::Retarget {
                cancel_in_flight: true
            }
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: the segment being encoded is no longer wanted
    #[test]
    fn should_cancel_the_in_flight_segment_when_it_left_the_work_set() {
        let running = work(&[(0, 10), (1, 11)]);
        let view = active(&running, Some((0, 10)));
        let desired = work(&[(1, 11)]);

        assert_eq!(
            decide_ensure_action(Some(&view), &desired),
            EnsureAction::Retarget {
                cancel_in_flight: true
            }
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: an edit lands on a segment that is not the one encoding
    #[test]
    fn should_not_cancel_the_in_flight_segment_when_a_different_segment_moved() {
        let running = work(&[(0, 10), (1, 11)]);
        let view = active(&running, Some((0, 10)));
        let desired = work(&[(0, 10), (1, 99)]);

        assert_eq!(
            decide_ensure_action(Some(&view), &desired),
            EnsureAction::Retarget {
                cancel_in_flight: false
            }
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: the encode profile changed
    #[test]
    fn should_supersede_when_the_profile_hash_differs() {
        let running = work(&[(0, 10)]);
        let view = active(&running, Some((0, 10)));
        let desired = CacheFillWorkSet::new(
            "seq1",
            "profile-b",
            PreviewCacheScope::WholeTimeline,
            vec![(0, 10)],
        );

        assert_eq!(
            decide_ensure_action(Some(&view), &desired),
            EnsureAction::Supersede
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: a different sequence became active
    #[test]
    fn should_supersede_when_the_sequence_differs() {
        let running = work(&[(0, 10)]);
        let view = active(&running, Some((0, 10)));
        let desired = CacheFillWorkSet::new(
            "seq2",
            PROFILE,
            PreviewCacheScope::WholeTimeline,
            vec![(0, 10)],
        );

        assert_eq!(
            decide_ensure_action(Some(&view), &desired),
            EnsureAction::Supersede
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: the same work named in a different order
    ///
    /// Construction order must not decide whether a fill is restarted.
    #[test]
    fn should_report_already_converging_when_only_the_construction_order_differs() {
        let running = work(&[(0, 10), (1, 11), (2, 12)]);
        let view = active(&running, None);
        let desired = work(&[(2, 12), (0, 10), (1, 11)]);

        assert_eq!(
            decide_ensure_action(Some(&view), &desired),
            EnsureAction::AlreadyConverging
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: the in-flight segment was popped and is wanted unchanged
    ///
    /// This is the shape production actually produces: the encoding segment is
    /// absent from the active queue because the fill popped it.
    #[test]
    fn should_retarget_without_cancelling_when_the_popped_segment_is_wanted_unchanged() {
        // The fill popped segment 0 and is encoding it, so its queue holds only 1.
        let running = work(&[(1, 11)]);
        let view = active(&running, Some((0, 10)));
        // A fresh request re-lists segment 0 at the same fingerprint.
        let desired = work(&[(0, 10), (1, 11)]);

        assert_eq!(
            decide_ensure_action(Some(&view), &desired),
            EnsureAction::Retarget {
                cancel_in_flight: false
            }
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: the queue is unchanged but the encode is producing stale bytes
    ///
    /// The in-flight segment is popped, so queue equality alone would call this
    /// a no-op and let a superseded encode be recorded as truth.
    #[test]
    fn should_retarget_when_the_queue_matches_but_the_in_flight_segment_is_unwanted() {
        let running = work(&[(1, 11)]);
        let view = active(&running, Some((0, 10)));
        // Same queue, but segment 0 is no longer wanted at fingerprint 10.
        let desired = work(&[(1, 11)]);

        assert_eq!(
            decide_ensure_action(Some(&view), &desired),
            EnsureAction::Retarget {
                cancel_in_flight: true
            }
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: no encode is running during the pop-to-arm window
    ///
    /// Nothing is in flight, so an unchanged queue really is a no-op.
    #[test]
    fn should_report_already_converging_when_nothing_is_in_flight_and_the_queue_matches() {
        let running = work(&[(0, 10), (1, 11)]);
        let view = active(&running, None);
        let desired = work(&[(0, 10), (1, 11)]);

        assert_eq!(
            decide_ensure_action(Some(&view), &desired),
            EnsureAction::AlreadyConverging
        );
    }

    // -----------------------------------------------------------------------
    // merge_work_sets
    // -----------------------------------------------------------------------

    /// Feature: Convergent preview-cache fill
    /// Scenario: a flagged request arrives while the whole timeline is filling
    #[test]
    fn should_keep_the_wider_work_when_a_flagged_request_meets_a_whole_timeline_fill() {
        let running = scoped_work(
            PreviewCacheScope::WholeTimeline,
            &[(0, 10), (1, 11), (2, 12)],
        );
        let incoming = scoped_work(PreviewCacheScope::Flagged, &[(1, 99)]);

        let merged = merge_work_sets(&running, &incoming, None);

        // Union, not replacement: the whole-timeline work is not thrown away.
        assert_eq!(merged.segments, vec![(0, 10), (1, 99), (2, 12)]);
        // And the fresher fingerprint for the shared index wins.
        assert_eq!(merged.fingerprint_of(1), Some(99));
        assert_eq!(merged.scope, PreviewCacheScope::WholeTimeline);
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: a whole-timeline request arrives while only flagged is filling
    #[test]
    fn should_widen_the_scope_when_a_whole_timeline_request_meets_a_flagged_fill() {
        let running = scoped_work(PreviewCacheScope::Flagged, &[(3, 13)]);
        let incoming = scoped_work(PreviewCacheScope::WholeTimeline, &[(0, 10), (1, 11)]);

        let merged = merge_work_sets(&running, &incoming, None);

        assert_eq!(merged.segments, vec![(0, 10), (1, 11), (3, 13)]);
        assert_eq!(merged.scope, PreviewCacheScope::WholeTimeline);
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: a request in the same scope is a complete, fresher answer
    #[test]
    fn should_replace_the_work_set_when_the_incoming_scope_is_the_same() {
        let running = work(&[(0, 10), (1, 11), (2, 12)]);
        let incoming = work(&[(1, 11)]);

        let merged = merge_work_sets(&running, &incoming, None);

        assert_eq!(merged.segments, vec![(1, 11)]);
        assert_eq!(merged.scope, PreviewCacheScope::WholeTimeline);
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: a narrower request must not strand the segment being encoded
    ///
    /// A `WholeTimeline` fill is encoding segment 0 with 1 and 2 still queued.
    /// A `Flagged` request arrives naming only segment 5 — its filter tests
    /// "is this flagged", so segment 0 is simply outside the question it asked.
    /// Segment 0 is in neither list, and without the fold it would look dropped:
    /// a valid encode killed, and the segment left in no queue at all. A request
    /// for *more* work would have lost work.
    #[test]
    fn should_keep_the_encoding_segment_when_a_narrower_request_says_nothing_about_it() {
        let running = scoped_work(PreviewCacheScope::WholeTimeline, &[(1, 11), (2, 12)]);
        let incoming = scoped_work(PreviewCacheScope::Flagged, &[(5, 15)]);
        let in_flight = Some((0, 10));

        let merged = merge_work_sets(&running, &incoming, in_flight);

        assert_eq!(merged.segments, vec![(0, 10), (1, 11), (2, 12), (5, 15)]);
        assert_eq!(merged.scope, PreviewCacheScope::WholeTimeline);

        // And the encode in flight survives.
        let view = active(&running, in_flight);
        assert_eq!(
            decide_ensure_action(Some(&view), &merged),
            EnsureAction::Retarget {
                cancel_in_flight: false
            }
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: the narrower request *does* have an opinion, and it differs
    ///
    /// The fold must not shield an encode whose work genuinely moved: when the
    /// incoming request names the in-flight segment at a new fingerprint, that
    /// entry wins and the encode is cancelled.
    #[test]
    fn should_still_cancel_the_encoding_segment_when_a_narrower_request_re_fingerprints_it() {
        let running = scoped_work(PreviewCacheScope::WholeTimeline, &[(1, 11), (2, 12)]);
        let incoming = scoped_work(PreviewCacheScope::Flagged, &[(0, 99), (5, 15)]);
        let in_flight = Some((0, 10));

        let merged = merge_work_sets(&running, &incoming, in_flight);

        assert_eq!(merged.fingerprint_of(0), Some(99));

        let view = active(&running, in_flight);
        assert_eq!(
            decide_ensure_action(Some(&view), &merged),
            EnsureAction::Retarget {
                cancel_in_flight: true
            }
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: a same-scope request that omits the segment being encoded
    ///
    /// Today's reconcile resets an interrupted `Rendering` segment to `Error`, so
    /// a same-scope request lists it and the fold is a no-op. Under a `Preserve`
    /// policy it would drop out as "already being handled"; the fold keeps the
    /// encode alive either way, so the policy choice cannot become a data bug.
    #[test]
    fn should_keep_the_encoding_segment_when_a_same_scope_request_omits_it() {
        let running = work(&[(1, 11)]);
        let incoming = work(&[(1, 11), (2, 12)]);
        let in_flight = Some((0, 10));

        let merged = merge_work_sets(&running, &incoming, in_flight);

        assert_eq!(merged.segments, vec![(0, 10), (1, 11), (2, 12)]);

        let view = active(&running, in_flight);
        assert_eq!(
            decide_ensure_action(Some(&view), &merged),
            EnsureAction::Retarget {
                cancel_in_flight: false
            }
        );
    }

    // -----------------------------------------------------------------------
    // verdict_for_rendered_segment
    // -----------------------------------------------------------------------

    /// Feature: Convergent preview-cache fill
    /// Scenario: the segment's identity did not move while it encoded
    #[test]
    fn should_accept_a_rendered_segment_when_its_fingerprint_still_matches() {
        assert_eq!(
            verdict_for_rendered_segment(42, Some(42)),
            RenderedSegmentVerdict::Accept
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: an edit landed while the segment was encoding
    ///
    /// Recording these bytes would attach pre-edit pixels to the post-edit
    /// fingerprint, which no later freshness check could ever detect.
    #[test]
    fn should_discard_a_rendered_segment_when_its_fingerprint_moved_mid_encode() {
        assert_eq!(
            verdict_for_rendered_segment(42, Some(43)),
            RenderedSegmentVerdict::Discard
        );
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: the segment no longer exists in the manifest
    #[test]
    fn should_discard_a_rendered_segment_when_the_manifest_no_longer_has_it() {
        assert_eq!(
            verdict_for_rendered_segment(42, None),
            RenderedSegmentVerdict::Discard
        );
    }

    // -----------------------------------------------------------------------
    // Work-set queue
    // -----------------------------------------------------------------------

    /// Feature: Convergent preview-cache fill
    /// Scenario: the queue skips segments that stopped needing a render
    #[test]
    fn should_skip_queued_segments_when_they_no_longer_need_rendering() {
        let mut queue = work(&[(0, 10), (1, 11), (2, 12)]);
        assert_eq!(queue.len(), 3);

        let popped = queue.pop_next_where(|index| index == 2);

        assert_eq!(popped, Some((2, 12)));
        assert_eq!(queue.len(), 0);
        assert!(queue.is_empty());
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: progress must not count a re-queued finished segment twice
    #[test]
    fn should_exclude_the_named_segment_when_counting_what_is_outstanding() {
        let queue = work(&[(0, 10), (1, 11), (2, 12)]);

        assert_eq!(queue.len_excluding(1), 2);
        // An index that is not queued changes nothing.
        assert_eq!(queue.len_excluding(7), 3);
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: the queue pops in timeline order
    #[test]
    fn should_pop_the_lowest_index_first_when_every_segment_still_needs_rendering() {
        let mut queue = work(&[(2, 12), (0, 10), (1, 11)]);

        assert_eq!(queue.pop_next_where(|_| true), Some((0, 10)));
        assert_eq!(queue.pop_next_where(|_| true), Some((1, 11)));
        assert_eq!(queue.len(), 1);
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: nothing in the queue is renderable any more
    #[test]
    fn should_return_nothing_when_no_queued_segment_still_needs_rendering() {
        let mut queue = work(&[(0, 10), (1, 11)]);

        assert_eq!(queue.pop_next_where(|_| false), None);
        assert!(queue.is_empty());
    }

    // -----------------------------------------------------------------------
    // cancelled_outcome
    // -----------------------------------------------------------------------

    /// Feature: Convergent preview-cache fill
    /// Scenario: a supersede cancelled the segment
    #[test]
    fn should_stop_the_fill_when_a_cancelled_segment_was_superseded() {
        assert_eq!(cancelled_outcome(true), CancelledOutcome::StopFill);
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: only the segment itself was cancelled
    #[test]
    fn should_continue_the_fill_when_a_cancelled_segment_was_only_retargeted() {
        assert_eq!(cancelled_outcome(false), CancelledOutcome::ContinueFill);
    }

    // -----------------------------------------------------------------------
    // select_fill_segments
    // -----------------------------------------------------------------------

    /// Feature: Convergent preview-cache fill
    /// Scenario: the whole-timeline scope takes every segment needing a render
    #[test]
    fn should_select_every_renderable_segment_when_the_scope_is_the_whole_timeline() {
        let manifest = manifest_with(vec![
            (CacheSegmentState::Empty, Vec::new()),
            (CacheSegmentState::Cached, Vec::new()),
            (CacheSegmentState::Stale, vec![SegmentFlagReason::Transform]),
        ]);

        let selected = select_fill_segments(&manifest, PreviewCacheScope::WholeTimeline);

        assert_eq!(selected, vec![(0, 100), (2, 102)]);
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: the flagged scope ignores segments the preview draws correctly
    #[test]
    fn should_select_only_flagged_segments_when_the_scope_is_flagged() {
        let manifest = manifest_with(vec![
            (CacheSegmentState::Empty, Vec::new()),
            (CacheSegmentState::Empty, vec![SegmentFlagReason::BlendMode]),
        ]);

        let selected = select_fill_segments(&manifest, PreviewCacheScope::Flagged);

        assert_eq!(selected, vec![(1, 101)]);
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: a flagged segment the export path cannot render is skipped
    ///
    /// One unrenderable ingredient fails the whole segment, so queueing it would
    /// make the fill retry a render that can only error.
    #[test]
    fn should_skip_flagged_segments_when_any_reason_is_not_fill_renderable() {
        let manifest = manifest_with(vec![
            (
                CacheSegmentState::Empty,
                vec![
                    SegmentFlagReason::Transform,
                    SegmentFlagReason::MissingAsset,
                ],
            ),
            (CacheSegmentState::Empty, vec![SegmentFlagReason::Transform]),
        ]);

        let selected = select_fill_segments(&manifest, PreviewCacheScope::Flagged);

        assert_eq!(selected, vec![(1, 101)]);
    }

    /// Feature: Convergent preview-cache fill
    /// Scenario: a flagged segment that is already cached needs no fill
    #[test]
    fn should_not_select_flagged_segments_when_they_are_already_cached() {
        let manifest = manifest_with(vec![(
            CacheSegmentState::Cached,
            vec![SegmentFlagReason::Transform],
        )]);

        let selected = select_fill_segments(&manifest, PreviewCacheScope::Flagged);

        assert!(selected.is_empty());
    }
}
