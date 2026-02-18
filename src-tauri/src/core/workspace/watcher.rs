//! Workspace File System Watcher
//!
//! Real-time filesystem monitoring for the project workspace using `notify`.
//! Debounces events and filters through ignore rules.

use std::path::PathBuf;
use std::sync::Arc;

use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use tokio::sync::mpsc;

use super::ignore::IgnoreRules;

/// Events emitted by the workspace watcher
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceEvent {
    /// A new file was added to the workspace
    FileAdded(String),
    /// A file was removed from the workspace
    FileRemoved(String),
    /// A file was modified in the workspace
    FileModified(String),
}

/// File system watcher for the project workspace
pub struct WorkspaceWatcher {
    /// Stop signal sender — dropping this stops the watcher
    _stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl WorkspaceWatcher {
    /// Start watching the project workspace for file changes
    ///
    /// Events are sent through the provided channel after being filtered
    /// through ignore rules and debounced (500ms).
    pub fn start(
        project_root: PathBuf,
        ignore_rules: Arc<IgnoreRules>,
        event_tx: mpsc::UnboundedSender<WorkspaceEvent>,
    ) -> Result<Self, String> {
        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
        let root_clone = project_root.clone();

        // Create the notify debouncer with 500ms delay
        let (tx, rx) = std::sync::mpsc::channel();
        let mut debouncer = new_debouncer(std::time::Duration::from_millis(500), tx)
            .map_err(|e| format!("Failed to create file watcher: {}", e))?;

        debouncer
            .watcher()
            .watch(&project_root, notify::RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch directory: {}", e))?;

        // Spawn a thread to process debounced events
        std::thread::spawn(move || {
            // Keep the debouncer alive
            let _debouncer = debouncer;

            loop {
                // Check for stop signal
                if stop_rx.try_recv().is_ok() {
                    tracing::debug!("Workspace watcher stopped by signal");
                    break;
                }

                // Poll for events with timeout
                match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                    Ok(Ok(events)) => {
                        for event in events {
                            let path = &event.path;

                            // Get relative path
                            let rel_path = match path.strip_prefix(&root_clone) {
                                Ok(rel) => rel,
                                Err(_) => continue,
                            };

                            // Check ignore rules
                            if ignore_rules.is_ignored(rel_path) {
                                continue;
                            }

                            // Only process media files
                            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

                            if !is_media_extension(ext) {
                                continue;
                            }

                            let rel_str = rel_path.to_string_lossy().replace('\\', "/");

                            let ws_event = match event.kind {
                                DebouncedEventKind::Any => {
                                    // notify-debouncer-mini only reports Any/AnyContinuous,
                                    // not specific create/modify/delete kinds.
                                    // We classify based on file existence — the handler
                                    // treats FileAdded and FileModified identically (upsert).
                                    if path.exists() {
                                        WorkspaceEvent::FileModified(rel_str)
                                    } else {
                                        WorkspaceEvent::FileRemoved(rel_str)
                                    }
                                }
                                DebouncedEventKind::AnyContinuous => {
                                    // Ongoing writes — treat as modified
                                    if path.exists() {
                                        WorkspaceEvent::FileModified(rel_str)
                                    } else {
                                        continue;
                                    }
                                }
                                _ => continue,
                            };

                            if event_tx.send(ws_event).is_err() {
                                tracing::debug!("Workspace event channel closed, stopping watcher");
                                return;
                            }
                        }
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(error = %error, "File watcher error");
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        // Normal timeout, continue loop
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        tracing::debug!("File watcher channel disconnected, stopping");
                        break;
                    }
                }
            }
        });

        Ok(Self {
            _stop_tx: Some(stop_tx),
        })
    }

    /// Stop the watcher
    pub fn stop(&mut self) {
        self._stop_tx.take(); // Dropping the sender signals the thread to stop
    }
}

/// Check if a file extension is a recognized media type
fn is_media_extension(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "mp4"
            | "mov"
            | "avi"
            | "mkv"
            | "webm"
            | "m4v"
            | "wmv"
            | "flv"
            | "mp3"
            | "wav"
            | "aac"
            | "ogg"
            | "flac"
            | "m4a"
            | "wma"
            | "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "bmp"
            | "webp"
            | "tiff"
            | "svg"
            | "srt"
            | "vtt"
            | "ass"
            | "ssa"
            | "sub"
            | "ttf"
            | "otf"
            | "woff"
            | "woff2"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_media_extension() {
        assert!(is_media_extension("mp4"));
        assert!(is_media_extension("MP4"));
        assert!(is_media_extension("wav"));
        assert!(is_media_extension("jpg"));
        assert!(is_media_extension("srt"));
        assert!(is_media_extension("ttf"));
        assert!(!is_media_extension("txt"));
        assert!(!is_media_extension("rs"));
        assert!(!is_media_extension("json"));
    }

    #[test]
    fn test_workspace_event_equality() {
        assert_eq!(
            WorkspaceEvent::FileAdded("a.mp4".to_string()),
            WorkspaceEvent::FileAdded("a.mp4".to_string())
        );
        assert_ne!(
            WorkspaceEvent::FileAdded("a.mp4".to_string()),
            WorkspaceEvent::FileRemoved("a.mp4".to_string())
        );
    }

    #[tokio::test]
    async fn test_watcher_start_and_stop() {
        let dir = tempfile::tempdir().unwrap();
        let rules = Arc::new(IgnoreRules::defaults());
        let (tx, _rx) = mpsc::unbounded_channel();

        let mut watcher = WorkspaceWatcher::start(dir.path().to_path_buf(), rules, tx).unwrap();

        // Give the watcher time to start
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        watcher.stop();
        // Should not panic
    }

    #[tokio::test]
    async fn test_watcher_detects_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let rules = Arc::new(IgnoreRules::defaults());
        let (tx, mut rx) = mpsc::unbounded_channel();

        let _watcher = WorkspaceWatcher::start(dir.path().to_path_buf(), rules, tx).unwrap();

        // Wait for watcher to initialize
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // Create a media file
        std::fs::write(dir.path().join("test.mp4"), b"video data").unwrap();

        // Wait for debounced event (500ms debounce + overhead)
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        // Should receive an event
        let event = rx.try_recv();
        assert!(
            event.is_ok(),
            "Expected a workspace event after creating a file"
        );
        match event.unwrap() {
            WorkspaceEvent::FileAdded(p) | WorkspaceEvent::FileModified(p) => {
                assert_eq!(p, "test.mp4");
            }
            other => panic!("Unexpected event: {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_watcher_ignores_non_media() {
        let dir = tempfile::tempdir().unwrap();
        let rules = Arc::new(IgnoreRules::defaults());
        let (tx, mut rx) = mpsc::unbounded_channel();

        let _watcher = WorkspaceWatcher::start(dir.path().to_path_buf(), rules, tx).unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // Create a non-media file
        std::fs::write(dir.path().join("readme.txt"), b"text").unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        // Should NOT receive an event
        assert!(rx.try_recv().is_err());
    }
}
