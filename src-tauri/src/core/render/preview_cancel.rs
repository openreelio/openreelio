//! Cooperative cancellation for a preview-cache fill.
//!
//! Superseding a fill has to stop it *and* kill the FFmpeg it currently has in
//! flight — dropping the task alone leaves the process orphaned. Aborting the
//! task races the graceful cleanup (the abort drops the task before its cancel
//! arm can remove the partial file and report the segment as no longer
//! rendering), so the fill is cancelled cooperatively instead: the loop checks
//! [`PreviewCacheCancel::is_superseded`] between segments, and the segment
//! currently rendering is cancelled through its own oneshot so the exporter
//! kills FFmpeg, deletes the partial output and returns `ExportError::Cancelled`.
//!
//! # Two kinds of cancel
//!
//! Superseding is the blunt one and stops the whole fill. The armed segment also
//! carries its *identity* — index plus plan fingerprint — so a fill that is
//! merely retargeted can cancel only the segment whose work actually changed and
//! leave the fill running; see
//! [`PreviewCacheCancel::cancel_segment_if_stale`] and
//! [`crate::core::render::preview_fill`]. That cancel deliberately never sets the
//! supersede flag, which is how the fill loop tells the two apart.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tokio::sync::oneshot;

use super::cache::SegmentFingerprint;
use super::preview_fill::CacheFillWorkSet;

/// The segment whose FFmpeg is currently running, and the handle that kills it.
struct ArmedSegment {
    index: u32,
    fingerprint: SegmentFingerprint,
    sender: oneshot::Sender<()>,
}

/// Cancellation shared between a preview-cache fill task and the call that
/// supersedes it.
#[derive(Default)]
pub struct PreviewCacheCancel {
    superseded: AtomicBool,
    segment: Mutex<Option<ArmedSegment>>,
}

impl PreviewCacheCancel {
    /// Marks the fill superseded and cancels the segment in flight, if any.
    pub fn trigger(&self) {
        self.superseded.store(true, Ordering::Release);
        if let Some(armed) = self.segment.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = armed.sender.send(());
        }
    }

    /// Whether a newer fill has taken over.
    pub fn is_superseded(&self) -> bool {
        self.superseded.load(Ordering::Acquire)
    }

    /// Arms cancellation for the segment about to render, returning its receiver.
    ///
    /// If the fill was superseded before the sender is armed, the returned
    /// receiver is already cancelled so the render is skipped rather than run.
    /// The flag is read *inside* the lock and [`trigger`](Self::trigger) sets the
    /// flag *before* taking the lock, so the two cannot interleave into a state
    /// where the flag is set yet a live sender sits in the slot that nothing will
    /// ever fire — which would leave the segment rendering uncancellably.
    ///
    /// `index` and `fingerprint` identify the work this encode is producing, so
    /// a later request can tell whether it is still the right encode.
    pub fn arm_segment(
        &self,
        index: u32,
        fingerprint: SegmentFingerprint,
    ) -> oneshot::Receiver<()> {
        let (sender, receiver) = oneshot::channel();
        match self.segment.lock() {
            Ok(mut slot) => {
                if self.is_superseded() {
                    *slot = None;
                    let _ = sender.send(());
                } else {
                    *slot = Some(ArmedSegment {
                        index,
                        fingerprint,
                        sender,
                    });
                }
            }
            // Fail safe: an unusable lock must cancel the segment, never leave it
            // rendering with no way to stop it.
            Err(_) => {
                let _ = sender.send(());
            }
        }
        receiver
    }

    /// Clears the armed segment sender once its render has returned.
    pub fn disarm_segment(&self) {
        if let Ok(mut slot) = self.segment.lock() {
            *slot = None;
        }
    }

    /// The segment currently encoding, if any.
    pub fn in_flight(&self) -> Option<(u32, SegmentFingerprint)> {
        self.segment
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|armed| (armed.index, armed.fingerprint)))
    }

    /// Cancels the segment in flight when `desired` no longer wants the work it
    /// is producing, and reports whether it fired.
    ///
    /// This is the targeted counterpart to [`trigger`](Self::trigger): it kills
    /// one encode without marking the fill superseded, so the fill loop treats
    /// the resulting `Cancelled` as "pick this segment up again with fresh
    /// inputs" rather than "stop". A segment whose fingerprint is unchanged is
    /// left alone, because re-rendering it would produce the same bytes.
    ///
    /// Reading the identity and taking the sender happen under one lock
    /// acquisition so the segment cannot be swapped out between the two.
    pub fn cancel_segment_if_stale(&self, desired: &CacheFillWorkSet) -> bool {
        let Ok(mut slot) = self.segment.lock() else {
            // The slot is unreadable, so no identity can be compared and no
            // sender can be taken. Nothing armed after this point can render
            // anyway: `arm_segment` fails safe by pre-cancelling whenever the
            // lock is unusable.
            tracing::warn!("Preview cache cancel slot unavailable; skipping targeted cancel");
            return false;
        };

        let Some(armed) = slot.as_ref() else {
            return false;
        };
        if desired.fingerprint_of(armed.index) == Some(armed.fingerprint) {
            return false;
        }

        // `take` rather than a borrow: the sender is consumed by sending, and the
        // slot must not keep naming an encode that is already being torn down.
        if let Some(armed) = slot.take() {
            let _ = armed.sender.send(());
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(segments: &[(u32, SegmentFingerprint)]) -> CacheFillWorkSet {
        CacheFillWorkSet::new(
            "seq1",
            "profile-a",
            super::super::preview_fill::PreviewCacheScope::WholeTimeline,
            segments.to_vec(),
        )
    }

    /// Feature: Preview cache cancellation
    /// Scenario: triggering marks the fill superseded
    #[test]
    fn should_report_superseded_after_trigger() {
        let cancel = PreviewCacheCancel::default();
        assert!(!cancel.is_superseded());
        cancel.trigger();
        assert!(cancel.is_superseded());
    }

    /// Feature: Preview cache cancellation
    /// Scenario: triggering cancels the segment currently armed
    #[test]
    fn should_cancel_the_armed_segment_when_triggered() {
        let cancel = PreviewCacheCancel::default();
        let mut receiver = cancel.arm_segment(0, 10);
        assert_eq!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );

        cancel.trigger();

        assert_eq!(receiver.try_recv(), Ok(()));
    }

    /// Feature: Preview cache cancellation
    /// Scenario: arming after a supersede yields an already-cancelled receiver
    ///
    /// Covers the race where the fill is superseded between the loop's
    /// `is_superseded` check and arming the next segment: the segment must not
    /// render.
    #[test]
    fn should_arm_a_pre_cancelled_receiver_after_a_supersede() {
        let cancel = PreviewCacheCancel::default();
        cancel.trigger();

        let mut receiver = cancel.arm_segment(0, 10);

        assert_eq!(receiver.try_recv(), Ok(()));
    }

    /// Feature: Preview cache cancellation
    /// Scenario: disarming drops the sender so a later trigger sends nothing
    #[test]
    fn should_drop_the_sender_on_disarm() {
        let cancel = PreviewCacheCancel::default();
        let mut receiver = cancel.arm_segment(0, 10);
        cancel.disarm_segment();

        cancel.trigger();

        // The receiver's sender was dropped by disarm, so the channel is closed
        // rather than delivering a cancellation.
        assert_eq!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        );
    }

    /// Feature: Preview cache cancellation
    /// Scenario: the armed segment reports which work it is producing
    #[test]
    fn should_report_the_armed_segment_identity_when_a_segment_is_rendering() {
        let cancel = PreviewCacheCancel::default();
        assert_eq!(cancel.in_flight(), None);

        let _receiver = cancel.arm_segment(3, 42);
        assert_eq!(cancel.in_flight(), Some((3, 42)));

        cancel.disarm_segment();
        assert_eq!(cancel.in_flight(), None);
    }

    /// Feature: Preview cache cancellation
    /// Scenario: the segment in flight is still producing the wanted bytes
    #[test]
    fn should_not_cancel_the_armed_segment_when_its_fingerprint_is_unchanged() {
        let cancel = PreviewCacheCancel::default();
        let mut receiver = cancel.arm_segment(1, 20);

        let fired = cancel.cancel_segment_if_stale(&work(&[(0, 99), (1, 20)]));

        assert!(!fired);
        assert_eq!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        assert_eq!(cancel.in_flight(), Some((1, 20)));
    }

    /// Feature: Preview cache cancellation
    /// Scenario: the segment in flight was edited, or is no longer wanted
    #[test]
    fn should_cancel_the_armed_segment_when_its_work_is_stale_or_dropped() {
        let cancel = PreviewCacheCancel::default();
        let mut moved = cancel.arm_segment(1, 20);
        assert!(cancel.cancel_segment_if_stale(&work(&[(1, 21)])));
        assert_eq!(moved.try_recv(), Ok(()));

        let cancel = PreviewCacheCancel::default();
        let mut dropped = cancel.arm_segment(1, 20);
        assert!(cancel.cancel_segment_if_stale(&work(&[(0, 10)])));
        assert_eq!(dropped.try_recv(), Ok(()));
    }

    /// Feature: Preview cache cancellation
    /// Scenario: a targeted cancel leaves the fill itself running
    ///
    /// The supersede flag is what the fill loop reads to decide whether to stop,
    /// so a segment-level cancel must never set it.
    #[test]
    fn should_not_mark_the_fill_superseded_when_only_a_segment_is_cancelled() {
        let cancel = PreviewCacheCancel::default();
        let _receiver = cancel.arm_segment(1, 20);

        cancel.cancel_segment_if_stale(&work(&[(1, 21)]));

        assert!(!cancel.is_superseded());
    }

    /// Feature: Preview cache cancellation
    /// Scenario: no segment is rendering when a retarget arrives
    #[test]
    fn should_do_nothing_when_no_segment_is_armed() {
        let cancel = PreviewCacheCancel::default();

        assert!(!cancel.cancel_segment_if_stale(&work(&[(1, 21)])));
        assert!(!cancel.is_superseded());
    }
}
