//! Managed state holding the resident preview decoder pool.
//!
//! The pool is built lazily rather than at startup because FFmpeg detection is
//! itself asynchronous and may not have finished by the time the first preview
//! frame is asked for.

use std::sync::Arc;

use tokio::sync::RwLock;

use super::decoder::PreviewDecoderPool;
use crate::core::ffmpeg::SharedFFmpegState;

/// The lazily built pool behind the preview frame command.
#[derive(Default)]
pub struct PreviewDecoderState {
    pool: RwLock<Option<Arc<PreviewDecoderPool>>>,
}

/// The managed-state handle registered with the application.
pub type SharedPreviewDecoders = Arc<PreviewDecoderState>;

/// Creates the preview decoder state to register with `manage`.
pub fn create_preview_decoder_state() -> SharedPreviewDecoders {
    Arc::new(PreviewDecoderState::default())
}

impl PreviewDecoderState {
    /// The pool, building it from the resolved FFmpeg binaries on first use.
    ///
    /// Uses whatever FFmpeg detection resolved rather than a path of its own, so
    /// the preview cannot end up on a different binary from the rest of the app.
    pub async fn pool(
        &self,
        ffmpeg_state: &SharedFFmpegState,
    ) -> Result<Arc<PreviewDecoderPool>, String> {
        if let Some(pool) = self.pool.read().await.as_ref() {
            return Ok(Arc::clone(pool));
        }

        let (ffmpeg_path, ffprobe_path) = {
            let ffmpeg_state = ffmpeg_state.read().await;
            let info = ffmpeg_state
                .runner()
                .ok_or_else(|| "FFmpeg not available".to_string())?
                .info();
            (info.ffmpeg_path.clone(), info.ffprobe_path.clone())
        };

        let mut guard = self.pool.write().await;
        // Another caller may have won the race between the two locks.
        if let Some(pool) = guard.as_ref() {
            return Ok(Arc::clone(pool));
        }

        let pool = Arc::new(PreviewDecoderPool::new(ffmpeg_path, ffprobe_path));
        *guard = Some(Arc::clone(&pool));
        Ok(pool)
    }

    /// Kills every resident decoder and forgets the pool.
    ///
    /// Called when the preview goes away (unmount, project close, app exit) so
    /// no FFmpeg outlives the thing that was displaying its frames.
    ///
    /// The teardown kills, waits and joins, and can block for as long as an
    /// in-flight read, so it runs on a blocking thread rather than on an async
    /// worker.
    pub async fn release_all(&self) {
        let pool = self.pool.write().await.take();
        let Some(pool) = pool else {
            return;
        };

        if tokio::task::spawn_blocking(move || pool.release_all())
            .await
            .is_err()
        {
            tracing::warn!("Preview decoder teardown task failed to run to completion");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feature: preview decoder lifecycle
    /// Scenario: releasing an unused state is harmless
    #[tokio::test]
    async fn releasing_before_any_frame_is_a_no_op() {
        let state = create_preview_decoder_state();
        state.release_all().await;
        state.release_all().await;
    }

    /// Feature: preview decoder lifecycle
    /// Scenario: no pool is built while FFmpeg is still unresolved
    #[tokio::test]
    async fn the_pool_is_refused_until_ffmpeg_resolves() {
        let state = create_preview_decoder_state();
        let ffmpeg_state = crate::core::ffmpeg::create_ffmpeg_state();

        match state.pool(&ffmpeg_state).await {
            Ok(_) => panic!("an unresolved FFmpeg must not produce a pool"),
            Err(error) => assert!(
                error.contains("FFmpeg not available"),
                "the error must say FFmpeg is missing, got: {error}"
            ),
        }
    }
}
