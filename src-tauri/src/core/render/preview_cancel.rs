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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tokio::sync::oneshot;

/// Cancellation shared between a preview-cache fill task and the call that
/// supersedes it.
#[derive(Default)]
pub struct PreviewCacheCancel {
    superseded: AtomicBool,
    segment: Mutex<Option<oneshot::Sender<()>>>,
}

impl PreviewCacheCancel {
    /// Marks the fill superseded and cancels the segment in flight, if any.
    pub fn trigger(&self) {
        self.superseded.store(true, Ordering::Release);
        if let Some(sender) = self.segment.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = sender.send(());
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
    pub fn arm_segment(&self) -> oneshot::Receiver<()> {
        let (sender, receiver) = oneshot::channel();
        match self.segment.lock() {
            Ok(mut slot) => {
                if self.is_superseded() {
                    *slot = None;
                    let _ = sender.send(());
                } else {
                    *slot = Some(sender);
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let mut receiver = cancel.arm_segment();
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

        let mut receiver = cancel.arm_segment();

        assert_eq!(receiver.try_recv(), Ok(()));
    }

    /// Feature: Preview cache cancellation
    /// Scenario: disarming drops the sender so a later trigger sends nothing
    #[test]
    fn should_drop_the_sender_on_disarm() {
        let cancel = PreviewCacheCancel::default();
        let mut receiver = cancel.arm_segment();
        cancel.disarm_segment();

        cancel.trigger();

        // The receiver's sender was dropped by disarm, so the channel is closed
        // rather than delivering a cancellation.
        assert_eq!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        );
    }
}
