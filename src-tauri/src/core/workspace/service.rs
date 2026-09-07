//! Workspace Orchestration Service
//!
//! Coordinates scanning, indexing, and watching for the project workspace.
//! This is the main entry point for workspace operations.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::core::assets::{
    needs_probe_refresh, probe_measured_nothing, Asset, AssetKind, MediaMetadata,
    MetadataExtractor, ASSET_PROBE_VERSION,
};
use crate::core::commands::{recorded_audio_duration_sec, recorded_duration_sec};
use crate::core::project::ProjectState;
use crate::core::CoreResult;

use super::ignore::IgnoreRules;
use super::index::{AssetIndex, IndexEntry};
use super::scanner::WorkspaceScanner;
use super::watcher::{WorkspaceEvent, WorkspaceWatcher, WORKSPACE_EVENT_CHANNEL_CAPACITY};

/// Result of a workspace scan operation
#[derive(Debug, Clone)]
pub struct ScanResult {
    /// Total number of media files found
    pub total_files: usize,
    /// Number of new files discovered (not previously indexed)
    pub new_files: usize,
    /// Number of files that were removed since last scan
    pub removed_files: usize,
    /// Number of files already registered as assets
    pub registered_files: usize,
}

/// What one auto-registration pass over the workspace index did.
///
/// A pass is not all-or-nothing: it mutates `ProjectState` file by file, and the
/// caller turns those mutations into ops afterwards. Propagating the first file
/// FFprobe could not be launched for would abandon that pass mid-way, leaving
/// the assets it had already inserted in state with no op behind them — a
/// project that diverges from its own log. So the pass carries its refusals out
/// instead of throwing them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AutoRegisterOutcome {
    /// Number of workspace files registered as assets during this pass.
    pub registered: usize,
    /// Workspace-relative paths left for a later pass because the probe
    /// measured nothing about them. They stay unregistered in the index, so the
    /// next scan — after FFmpeg finishes installing, say — picks them up again.
    pub skipped: Vec<String>,
    /// Workspace-relative paths that were linked to an asset that already
    /// existed, but whose missing metadata could not be filled in because the
    /// probe measured nothing.
    ///
    /// Separate from [`Self::skipped`] because nothing was refused: the asset
    /// is real, carries the metadata it was imported with, and is registered in
    /// the index. Only the top-up did not happen.
    ///
    /// Being registered is exactly why the retry needs its own pass: the
    /// unregistered loop never looks at these files again, so the second pass
    /// over already-registered entries is what fills the gaps once a probe can
    /// run.
    pub unrefreshed: Vec<String>,
}

/// An entry in the file tree hierarchy
#[derive(Debug, Clone)]
pub struct FileTreeEntry {
    /// Relative path within the project folder
    pub relative_path: String,
    /// Display name (file or directory name)
    pub name: String,
    /// Whether this is a directory
    pub is_directory: bool,
    /// Asset kind (None for directories)
    pub kind: Option<crate::core::assets::AssetKind>,
    /// File size in bytes (None for directories)
    pub file_size: Option<u64>,
    /// Asset ID if registered as a project asset
    pub asset_id: Option<String>,
    /// Whether the associated asset is marked as missing
    pub missing: bool,
    /// Child entries (for directories)
    pub children: Vec<FileTreeEntry>,
}

/// Workspace orchestration service
///
/// Manages the lifecycle of workspace scanning, indexing, and file watching.
pub struct WorkspaceService {
    project_root: PathBuf,
    scanner: WorkspaceScanner,
    index: AssetIndex,
    watcher: Option<WorkspaceWatcher>,
    event_tx: mpsc::Sender<WorkspaceEvent>,
    event_rx: Option<mpsc::Receiver<WorkspaceEvent>>,
    ignore_rules: Arc<IgnoreRules>,
    last_skipped_count: AtomicUsize,
    last_unrefreshed_count: AtomicUsize,
    /// Workspace-relative paths whose metadata gap a *successful* probe left
    /// open, and so no further probe of the same bytes can close.
    ///
    /// A container that carries no `format.duration` — a raw stream, a
    /// zero-byte file — probes fine and still leaves `duration_sec` unset, so
    /// [`workspace_asset_needs_metadata_refresh`] keeps saying yes forever.
    /// Without this set the watcher would re-probe that file on every
    /// filesystem event, with the project lock held. A path settles only after
    /// a probe that returned `Ok` and changed nothing; a probe that measured
    /// nothing never settles, because the next one may well succeed.
    ///
    /// The set lives on the service, and [`WorkspaceService::open`] runs per
    /// IPC call, so a one-shot scan starts with an empty one and probes each
    /// gap once. That is the intended reach: the repetition worth stopping is
    /// the watcher loop, which holds a single service for the life of the
    /// session. An entry is dropped again when the file itself changes (see
    /// [`WorkspaceService::handle_event`]), because new bytes may finally
    /// carry the measurement the old ones did not.
    settled_metadata_gaps: Mutex<HashSet<String>>,
}

/// Builds the [`Asset`] a discovered workspace file should be registered as.
///
/// Fails when the probe measured nothing - FFprobe could not be started, or it
/// ran and produced output nothing could be read from (see
/// [`probe_measured_nothing`]) - and only then. Every default below - a
/// zero-valued `VideoInfo`,
/// `1920x1080` for an image, an absent duration - is a statement about a file
/// FFprobe *looked at* and could not describe. When no probe ran, the same
/// defaults are pure invention, and the GUI's own import path (the workspace
/// scan that auto-registers what it finds) would silently fill a project with
/// assets carrying a made-up frame size and no duration. The scan refuses
/// instead, the same way `import_asset` refuses a hand-picked file. Verdicts
/// FFprobe reached about the file itself keep the defaults: something did look,
/// and a workspace scan should not be stopped by one unreadable file.
/// The measurement is supplied rather than taken here. That seam is what lets a
/// test produce one specific failure - FFprobe missing versus FFprobe rejecting
/// the file - without installing or removing binaries. The alternative is
/// registering a bogus FFprobe path, which is process-global and would reach
/// every other test running beside this one.
fn build_workspace_asset_with<F>(
    entry: &IndexEntry,
    absolute_path: &std::path::Path,
    extract: F,
) -> CoreResult<Asset>
where
    F: FnOnce(&std::path::Path) -> CoreResult<crate::core::assets::MediaMetadata>,
{
    let uri = absolute_path.to_string_lossy().to_string();
    let name = entry
        .relative_path
        .rsplit('/')
        .next()
        .unwrap_or(&entry.relative_path);
    let extracted_metadata = match extract(absolute_path) {
        Ok(metadata) => Some(metadata),
        Err(error) if probe_measured_nothing(&error) => return Err(error),
        Err(error) => {
            tracing::warn!(
                path = %entry.relative_path,
                "Registering workspace file without probed metadata: {}",
                error
            );
            None
        }
    };

    let resolved_file_size = extracted_metadata
        .as_ref()
        .map(|metadata| metadata.file_size)
        .filter(|size| *size > 0)
        .unwrap_or(entry.file_size);

    let mut asset = match entry.kind {
        AssetKind::Audio => Asset::new_audio(
            name,
            &uri,
            extracted_metadata
                .as_ref()
                .and_then(|metadata| metadata.audio.clone())
                .unwrap_or_default(),
        ),
        AssetKind::Image => {
            let (width, height) = extracted_metadata
                .as_ref()
                .and_then(|metadata| {
                    metadata
                        .video
                        .as_ref()
                        .map(|video| (video.width, video.height))
                })
                .unwrap_or((1920, 1080));
            Asset::new_image(name, &uri, width, height)
        }
        _ => Asset::new_video(
            name,
            &uri,
            extracted_metadata
                .as_ref()
                .and_then(|metadata| metadata.video.clone())
                .unwrap_or_default(),
        ),
    };

    if let Some(metadata) = extracted_metadata.as_ref() {
        apply_probed_durations(&mut asset, metadata);
        if let Some(audio) = metadata.audio.clone() {
            asset.audio = Some(audio);
        }
    }

    Ok(asset.with_file_size(resolved_file_size))
}

/// Whether a probe could still fill something in on an already-built asset.
///
/// Asked before every top-up, so it decides how much probing a pass over the
/// whole workspace costs. Only gaps a probe can actually close count: a still
/// has no duration to measure, and treating its absence as a gap would make
/// every image in the workspace look unmeasured forever, so every pass would
/// re-probe every image. A codec is likewise only expected where a video stream
/// is.
///
/// A duration alone no longer proves the asset was read under the current
/// rules: an asset scanned before `audioDurationSec` existed carries a picture
/// length and no sound length, and is indistinguishable from one whose sound
/// simply does not outlast its picture. The probe marker separates the two, so
/// each stale asset is re-read exactly once. A still is exempt from that check
/// for the same reason it is exempt from the duration one — a re-probe would
/// record nothing — so its marker never advances and never has to.
fn workspace_asset_needs_metadata_refresh(asset: &Asset) -> bool {
    let unread_lengths = !matches!(asset.kind, AssetKind::Image)
        && (asset.duration_sec.is_none() || needs_probe_refresh(asset));
    let video_codec_missing = matches!(asset.kind, AssetKind::Video)
        && asset
            .video
            .as_ref()
            .map(|video| video.codec.trim().is_empty())
            .unwrap_or(true);

    unread_lengths || asset.file_size == 0 || video_codec_missing
}

/// Records a scanned file's lengths under the rules import records them by.
///
/// The scanner used to store the container duration, which is the maximum
/// across every stream: a video whose sound outlasts its pictures was given a
/// length no picture clip cut from it could reach, a still was given the single
/// frame FFprobe reports for a JPEG, and the sound past the last frame was
/// recorded nowhere at all. The two helpers here are the same ones import
/// calls, so a file carries the same *lengths* whether it arrived through
/// `asset import` or by being dropped into the project folder.
///
/// The parity stops at the lengths. Import also corrects the asset *kind*
/// against the probe — an `.ogg` holding pictures becomes a video, an `.mp4`
/// holding only sound becomes audio; see
/// [`import_command_from_probe`](crate::core::commands::import_command_from_probe).
/// The scan takes its kind from the file extension alone, so a mislabelled file
/// is measured under the kind its name claims, and both helpers read the kind.
fn apply_probed_durations(asset: &mut Asset, metadata: &MediaMetadata) {
    if let Some(duration_sec) = recorded_duration_sec(metadata, &asset.kind) {
        asset.duration_sec = Some(duration_sec);
    }
    asset.audio_duration_sec = recorded_audio_duration_sec(metadata, &asset.kind);
    // The marker records that this reading happened under the current rules,
    // which is what stops the next scan from re-probing a file whose sound
    // simply does not outlast its picture. See [`Asset::probe_version`].
    asset.probe_version = Some(ASSET_PROBE_VERSION);
}

/// Fills in what an already-registered asset is missing, from a fresh probe.
///
/// Propagates a probe that measured nothing for the reason
/// [`build_workspace_asset_with`] does: with no measurement, the "refreshed"
/// asset is all defaults, and copying those over a real codec or frame size is
/// worse than leaving the gaps alone.
///
/// The lengths are the one pair that is *replaced* rather than gap-filled, and
/// only when the refresh ran because the asset was read under older rules (see
/// [`needs_probe_refresh`]). Gap-filling is right for an asset that never had a
/// length; it is wrong for one whose recorded length is the reading this pass
/// exists to correct. An mp4 whose AAC outlasts its pictures was registered at
/// its *container* length before those rules, so keeping the old value here
/// discarded the corrected picture length while still stamping the marker —
/// making the too-long reading permanent, because every later check
/// ([`workspace_asset_needs_metadata_refresh`],
/// [`asset_needs_measurement`](crate::core::commands::asset_needs_measurement))
/// then reads the asset as already measured.
fn refresh_existing_workspace_asset_metadata<F>(
    asset: &mut Asset,
    entry: &IndexEntry,
    absolute_path: &std::path::Path,
    extract: F,
) -> CoreResult<()>
where
    F: FnOnce(&std::path::Path) -> CoreResult<crate::core::assets::MediaMetadata>,
{
    if !workspace_asset_needs_metadata_refresh(asset) {
        return Ok(());
    }

    // Read before the refresh overwrites the marker it is judged by. A still is
    // exempt for the reason it is exempt everywhere else: it records no length,
    // so there is nothing for a re-read to supersede.
    let read_under_older_rules =
        !matches!(asset.kind, AssetKind::Image) && needs_probe_refresh(asset);

    let refreshed = build_workspace_asset_with(entry, absolute_path, extract)?;
    if read_under_older_rules && refreshed.probe_version.is_some() {
        // A reading taken under the current rules supersedes the older one.
        // Still `or`-ed on the picture length: a probe that ran but measured no
        // usable duration must not erase a length the asset already had.
        asset.duration_sec = refreshed.duration_sec.or(asset.duration_sec);
        // Assigned outright rather than `or`-ed, because `None` is a *reading*
        // here — it says the sound does not outlast the picture — and a stale
        // value left in place would bound a linked audio clip by a file the
        // asset no longer claims to be.
        asset.audio_duration_sec = refreshed.audio_duration_sec;
    } else {
        asset.duration_sec = asset.duration_sec.or(refreshed.duration_sec);
        // The sound's own length travels with the picture's: an asset refreshed
        // into a duration but left without one would bound its linked audio
        // clip by the pictures again.
        asset.audio_duration_sec = asset.audio_duration_sec.or(refreshed.audio_duration_sec);
    }
    asset.probe_version = refreshed.probe_version.or(asset.probe_version);
    if refreshed.file_size > 0 {
        asset.file_size = refreshed.file_size;
    }
    if asset.video.is_none()
        || asset
            .video
            .as_ref()
            .map(|video| video.codec.trim().is_empty())
            .unwrap_or(true)
    {
        asset.video = refreshed.video;
    }
    if asset.audio.is_none() {
        asset.audio = refreshed.audio;
    }

    Ok(())
}

impl WorkspaceService {
    /// Open a workspace service for the given project
    pub fn open(project_root: PathBuf) -> CoreResult<Self> {
        let ignore_rules = Arc::new(IgnoreRules::load(&project_root));
        let scanner =
            WorkspaceScanner::with_ignore_rules(project_root.clone(), (*ignore_rules).clone());
        let index = AssetIndex::open(&project_root)?;
        let (event_tx, event_rx) = mpsc::channel(WORKSPACE_EVENT_CHANNEL_CAPACITY);

        Ok(Self {
            project_root,
            scanner,
            index,
            watcher: None,
            event_tx,
            event_rx: Some(event_rx),
            ignore_rules,
            last_skipped_count: AtomicUsize::new(0),
            last_unrefreshed_count: AtomicUsize::new(0),
            settled_metadata_gaps: Mutex::new(HashSet::new()),
        })
    }

    /// The settled-gap set, with a poisoned lock recovered rather than
    /// propagated.
    ///
    /// The set is a probe-cost cache, never a source of project state: a pass
    /// that panicked mid-update can leave it stale at worst, which costs one
    /// extra probe. Refusing the whole scan over that would be the larger harm.
    fn settled_metadata_gaps(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.settled_metadata_gaps
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Perform an initial scan and populate the index
    ///
    /// Compares discovered files with the current index to determine
    /// new, removed, and existing entries.
    pub fn initial_scan(&self) -> CoreResult<ScanResult> {
        let discovered = self.scanner.scan();
        let existing = self.index.get_all()?;

        // Build a set of existing paths for quick lookup
        let existing_paths: std::collections::HashSet<String> =
            existing.iter().map(|e| e.relative_path.clone()).collect();

        let discovered_paths: std::collections::HashSet<String> =
            discovered.iter().map(|f| f.relative_path.clone()).collect();

        let now = chrono::Utc::now().timestamp();
        let mut new_count = 0;
        let mut registered_count = 0;

        // Upsert discovered files
        for file in &discovered {
            let is_new = !existing_paths.contains(&file.relative_path);
            if is_new {
                new_count += 1;
            }

            let modified_at = file
                .modified_at
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            let entry = IndexEntry {
                relative_path: file.relative_path.clone(),
                kind: file.kind.clone(),
                file_size: file.file_size,
                modified_at,
                asset_id: None, // Preserved by upsert if already set
                indexed_at: now,
                metadata_extracted: false,
            };

            self.index.upsert(&entry)?;
        }

        // Remove entries that no longer exist on disk
        let mut removed_count = 0;
        for existing_entry in &existing {
            if !discovered_paths.contains(&existing_entry.relative_path) {
                self.index.remove(&existing_entry.relative_path)?;
                removed_count += 1;
            }
        }

        // Count registered files
        for entry in self.index.get_all()? {
            if entry.asset_id.is_some() {
                registered_count += 1;
            }
        }

        Ok(ScanResult {
            total_files: discovered.len(),
            new_files: new_count,
            removed_files: removed_count,
            registered_files: registered_count,
        })
    }

    /// Start watching the workspace for file changes
    pub fn start_watching(&mut self) -> Result<(), String> {
        if self.watcher.is_some() {
            return Ok(()); // Already watching
        }

        let watcher = WorkspaceWatcher::start(
            self.project_root.clone(),
            Arc::clone(&self.ignore_rules),
            self.event_tx.clone(),
        )?;

        self.watcher = Some(watcher);
        tracing::info!(
            project = %self.project_root.display(),
            "Workspace file watching started"
        );
        Ok(())
    }

    /// Stop watching the workspace
    pub fn stop_watching(&mut self) {
        if let Some(mut watcher) = self.watcher.take() {
            watcher.stop();
            tracing::info!("Workspace file watching stopped");
        }
    }

    /// Take the event receiver (can only be called once)
    pub fn take_event_rx(&mut self) -> Option<mpsc::Receiver<WorkspaceEvent>> {
        self.event_rx.take()
    }

    /// Build a hierarchical file tree from the index
    pub fn get_file_tree(&self) -> CoreResult<Vec<FileTreeEntry>> {
        let entries = self.index.get_all()?;
        Ok(build_file_tree(&entries))
    }

    /// Get unregistered files from the index
    pub fn get_unregistered_files(&self) -> CoreResult<Vec<IndexEntry>> {
        self.index.get_unregistered()
    }

    /// Get the asset index for direct access
    pub fn index(&self) -> &AssetIndex {
        &self.index
    }

    /// Get the scanner for direct access
    pub fn scanner(&self) -> &WorkspaceScanner {
        &self.scanner
    }

    /// Get the project root path
    pub fn project_root(&self) -> &PathBuf {
        &self.project_root
    }

    /// Process a workspace event, updating both the index and project state.
    /// For FileRemoved: marks matching assets as missing.
    /// For FileAdded: auto-reconnects previously missing assets.
    pub fn handle_event_with_state(
        &self,
        event: &WorkspaceEvent,
        state: &mut ProjectState,
    ) -> CoreResult<()> {
        // First, update the index (existing behavior)
        self.handle_event(event)?;

        match event {
            WorkspaceEvent::FileRemoved(rel_path) => {
                // Find assets with this relative_path and mark them missing
                for asset in state.assets.values_mut() {
                    if asset.relative_path.as_deref() == Some(rel_path.as_str()) {
                        asset.missing = true;
                        tracing::info!(
                            asset_id = %asset.id,
                            path = %rel_path,
                            "Asset marked as missing (file removed externally)"
                        );
                    }
                }
            }
            WorkspaceEvent::FileAdded(rel_path) | WorkspaceEvent::FileModified(rel_path) => {
                // Check if any missing asset matches this path and reconnect
                for asset in state.assets.values_mut() {
                    if asset.missing && asset.relative_path.as_deref() == Some(rel_path.as_str()) {
                        asset.missing = false;
                        tracing::info!(
                            asset_id = %asset.id,
                            path = %rel_path,
                            "Asset reconnected (file re-appeared)"
                        );
                    }
                }
            }
            WorkspaceEvent::ProjectStateChanged(_) => {
                // Project state files are not workspace media; external-change
                // handling lives in the workspace event loop.
            }
        }
        Ok(())
    }

    /// Process a single workspace event (update index)
    pub fn handle_event(&self, event: &WorkspaceEvent) -> CoreResult<()> {
        match event {
            WorkspaceEvent::FileAdded(rel_path) | WorkspaceEvent::FileModified(rel_path) => {
                if let Some(discovered) = self.scanner.scan_path(std::path::Path::new(rel_path)) {
                    let now = chrono::Utc::now().timestamp();
                    let modified_at = discovered
                        .modified_at
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);

                    let entry = IndexEntry {
                        relative_path: discovered.relative_path,
                        kind: discovered.kind,
                        file_size: discovered.file_size,
                        modified_at,
                        asset_id: None,
                        indexed_at: now,
                        metadata_extracted: false,
                    };
                    // The bytes changed, so a gap an earlier probe could not
                    // close may now be measurable. Let the next pass try again.
                    self.settled_metadata_gaps().remove(&entry.relative_path);
                    self.index.upsert(&entry)?;
                }
            }
            WorkspaceEvent::FileRemoved(rel_path) => {
                self.index.remove(rel_path)?;
            }
            WorkspaceEvent::ProjectStateChanged(_) => {
                // Project state files are never indexed as workspace media.
            }
        }
        Ok(())
    }

    /// Auto-register all discovered files that don't yet have an asset_id.
    /// Creates Asset entries in ProjectState and links them in the index.
    ///
    /// A file the probe measured nothing about is reported in
    /// [`AutoRegisterOutcome::skipped`] and the pass carries on with the rest;
    /// see that type for why one such probe must not abort the pass.
    pub fn auto_register_discovered_files(
        &self,
        state: &mut ProjectState,
        project_root: &std::path::Path,
    ) -> CoreResult<AutoRegisterOutcome> {
        self.auto_register_discovered_files_with(state, project_root, |path| {
            MetadataExtractor::extract(path)
        })
    }

    /// [`Self::auto_register_discovered_files`], with the measurement supplied.
    ///
    /// The seam exists for the same reason [`build_workspace_asset_with`]'s
    /// does: a test needs one file's probe to fail without touching the
    /// process-global FFmpeg resolution every other test shares.
    fn auto_register_discovered_files_with<F>(
        &self,
        state: &mut ProjectState,
        project_root: &std::path::Path,
        extract: F,
    ) -> CoreResult<AutoRegisterOutcome>
    where
        F: Fn(&std::path::Path) -> CoreResult<crate::core::assets::MediaMetadata>,
    {
        let unregistered = self.index.get_unregistered()?;
        let mut outcome = AutoRegisterOutcome::default();

        // Files this pass has already probed. The second pass below must not
        // measure them again: they were built moments ago, from the freshest
        // probe there is.
        let mut probed_in_this_pass: HashSet<String> = HashSet::new();

        for entry in &unregistered {
            // An asset for this path may already be in the project - imported
            // by hand before the scan reached the file. Link it and leave its
            // metadata alone. The link is made even when the asset still has
            // gaps: refusing it would leave a real asset unlinked from the file
            // it points at, so the explorer would show that file as
            // unregistered and offer to import a second copy of it. Whatever is
            // missing is filled by the pass over registered entries below, so
            // one place tops an asset up rather than two.
            let existing_asset_id = state
                .assets
                .values()
                .find(|asset| asset.relative_path.as_deref() == Some(&entry.relative_path))
                .map(|asset| asset.id.clone());
            if let Some(asset_id) = existing_asset_id {
                self.index
                    .mark_registered(&entry.relative_path, &asset_id)?;
                continue;
            }

            let abs_path = project_root.join(&entry.relative_path);
            let asset = match build_workspace_asset_with(entry, &abs_path, &extract) {
                Ok(asset) => asset,
                Err(error) if probe_measured_nothing(&error) => {
                    skip_unmeasurable(&mut outcome, entry);
                    continue;
                }
                Err(error) => return Err(error),
            };

            let asset = asset
                .with_relative_path(&entry.relative_path)
                .as_workspace_managed()
                .with_file_size(entry.file_size);

            let asset_id = asset.id.clone();
            state.assets.insert(asset_id.clone(), asset);
            self.index
                .mark_registered(&entry.relative_path, &asset_id)?;
            probed_in_this_pass.insert(entry.relative_path.clone());
            outcome.registered += 1;
        }

        // Second pass, over what the index already calls registered. Two kinds
        // of entry need it.
        //
        // A stale entry names an asset id `state` no longer has; it is rebuilt
        // under that same id so clips referencing it remain valid.
        //
        // A live entry names an asset `state` does have, which may still be
        // missing the metadata an earlier pass could not measure.
        // `mark_registered` has already run for it, so the loop above - which
        // only sees unregistered entries - will never look at it again. Without
        // this pass the retry [`AutoRegisterOutcome::unrefreshed`] promises
        // would never happen, and a project opened once while FFmpeg was
        // missing would carry durationless assets until every file was touched
        // by hand.
        //
        // The work is bounded three times over: files this pass already probed
        // are skipped, a probe only runs for an asset that still has a gap
        // worth closing (see [`workspace_asset_needs_metadata_refresh`]), and a
        // gap a successful probe already failed to close is not asked again
        // (see [`Self::settled_metadata_gaps`]).
        //
        // The top-up writes to `state` without an op behind it, unlike the
        // registrations above. That is deliberate: it copies what is on disk
        // into a cache of what is on disk, so a reopen re-derives the same
        // values from the same files rather than replaying them.
        let registered_entries = self.index.get_all_registered()?;
        for entry in &registered_entries {
            let Some(asset_id) = entry.asset_id.as_ref() else {
                continue;
            };
            if probed_in_this_pass.contains(&entry.relative_path) {
                continue;
            }

            let abs_path = project_root.join(&entry.relative_path);

            if let Some(existing_asset) = state.assets.get_mut(asset_id) {
                if !workspace_asset_needs_metadata_refresh(existing_asset) {
                    continue;
                }
                // Checked before the filesystem is touched: a gap no probe can
                // close is the common case here, and asking the disk about it
                // every pass is the cost this set exists to remove.
                if self.settled_metadata_gaps().contains(&entry.relative_path) {
                    continue;
                }
                // A top-up needs a file to measure. It may have been deleted
                // since it was indexed, with the removal not yet processed.
                // Probing a path that is not there fails with an error this
                // pass propagates, which would turn one deleted file into a
                // failed scan of the whole workspace - and this pass sweeps
                // every registered entry, not just the ones the scanner just
                // saw on disk.
                //
                // Only the disk is asked. `Asset::missing` is this session's
                // last word on the file, and it goes stale the moment the file
                // comes back: a restored asset whose flag no watcher event has
                // cleared yet would otherwise never get the top-up it is
                // sitting here waiting for.
                if !abs_path.exists() {
                    continue;
                }
                match refresh_existing_workspace_asset_metadata(
                    existing_asset,
                    entry,
                    &abs_path,
                    &extract,
                ) {
                    // A probe ran and the gap is still open, so the file simply
                    // does not carry that measurement - a container with no
                    // duration, say. Re-probing the same bytes would report the
                    // same nothing, so stop asking until they change.
                    Ok(()) if workspace_asset_needs_metadata_refresh(existing_asset) => {
                        self.settled_metadata_gaps()
                            .insert(entry.relative_path.clone());
                    }
                    Ok(()) => {}
                    // The asset keeps the metadata it already has: it is real,
                    // and copying defaults over a measured codec or frame size
                    // is worse than leaving the gaps for the pass after this
                    // one.
                    Err(error) if probe_measured_nothing(&error) => {
                        record_unrefreshed(&mut outcome, entry);
                    }
                    Err(error) => return Err(error),
                }
                continue;
            }

            let mut asset = match build_workspace_asset_with(entry, &abs_path, &extract) {
                Ok(asset) => asset,
                Err(error) if probe_measured_nothing(&error) => {
                    skip_unmeasurable(&mut outcome, entry);
                    continue;
                }
                Err(error) => return Err(error),
            };

            // Preserve the original asset_id from the index
            asset.id = asset_id.clone();

            let asset = asset
                .with_relative_path(&entry.relative_path)
                .as_workspace_managed()
                .with_file_size(entry.file_size);

            state.assets.insert(asset_id.clone(), asset);
            outcome.registered += 1;
        }

        if outcome.registered > 0 {
            tracing::info!(
                count = outcome.registered,
                "Auto-registered workspace files as assets"
            );
        }
        log_unmeasured_aggregate(
            &self.last_skipped_count,
            outcome.skipped.len(),
            "Left workspace files unregistered: the probe measured nothing about them",
        );
        log_unmeasured_aggregate(
            &self.last_unrefreshed_count,
            outcome.unrefreshed.len(),
            "Linked workspace files without their missing metadata: the probe measured nothing about them",
        );

        Ok(outcome)
    }
}

/// Logs one pass-level count, loudly only when it is news.
///
/// The watcher runs a pass per filesystem event, so a workspace opened before
/// FFmpeg finished installing would repeat the same warning for every file that
/// lands, drowning out the one line that matters. A count that has not moved
/// since the previous pass says nothing new and drops to `debug!`; the first
/// pass to reach a count still warns, and so does the next pass that reaches a
/// different one. A count of zero is not logged at all, but is still recorded,
/// so a workspace that recovers and then regresses warns again.
fn log_unmeasured_aggregate(previous: &AtomicUsize, count: usize, message: &'static str) {
    let unchanged = previous.swap(count, Ordering::Relaxed) == count;
    if count == 0 {
        return;
    }

    if unchanged {
        tracing::debug!(count, "{}", message);
    } else {
        tracing::warn!(count, "{}", message);
    }
}

/// Records one file the pass could not measure, and says so in the log.
///
/// Per-file at `debug!`: a scan of a workspace opened before FFmpeg finished
/// installing reaches every file at once, and one `warn!` each buries the
/// aggregate the caller actually acts on. The pass logs that count once.
fn skip_unmeasurable(outcome: &mut AutoRegisterOutcome, entry: &IndexEntry) {
    tracing::debug!(
        path = %entry.relative_path,
        "Skipping workspace file: the probe measured nothing about it"
    );
    outcome.skipped.push(entry.relative_path.clone());
}

/// Records one already-registered file whose metadata gaps stayed unfilled.
///
/// At `debug!` for the reason [`skip_unmeasurable`] is.
fn record_unrefreshed(outcome: &mut AutoRegisterOutcome, entry: &IndexEntry) {
    tracing::debug!(
        path = %entry.relative_path,
        "Linked workspace file without refreshing its metadata: the probe measured nothing about it"
    );
    outcome.unrefreshed.push(entry.relative_path.clone());
}

/// Build a hierarchical file tree from flat index entries
fn build_file_tree(entries: &[IndexEntry]) -> Vec<FileTreeEntry> {
    use std::collections::BTreeMap;

    // Group files by their directory components
    let mut dirs: BTreeMap<String, Vec<&IndexEntry>> = BTreeMap::new();

    for entry in entries {
        let parent = std::path::Path::new(&entry.relative_path)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();

        dirs.entry(parent).or_default().push(entry);
    }

    // Build tree recursively from root
    build_tree_level("", &dirs)
}

/// Build a single level of the file tree
fn build_tree_level(
    prefix: &str,
    dirs: &std::collections::BTreeMap<String, Vec<&IndexEntry>>,
) -> Vec<FileTreeEntry> {
    let mut result = Vec::new();

    // Collect all unique directory names at this level
    let mut child_dirs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for dir_path in dirs.keys() {
        if let Some(child) = get_direct_child_dir(prefix, dir_path) {
            child_dirs.insert(child);
        }
    }

    // Add directory entries
    for dir_name in &child_dirs {
        let full_path = if prefix.is_empty() {
            dir_name.clone()
        } else {
            format!("{}/{}", prefix, dir_name)
        };

        let children = build_tree_level(&full_path, dirs);

        result.push(FileTreeEntry {
            relative_path: full_path,
            name: dir_name.clone(),
            is_directory: true,
            kind: None,
            file_size: None,
            asset_id: None,
            missing: false,
            children,
        });
    }

    // Add file entries at this level
    if let Some(files) = dirs.get(prefix) {
        for entry in files {
            let name = std::path::Path::new(&entry.relative_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            result.push(FileTreeEntry {
                relative_path: entry.relative_path.clone(),
                name,
                is_directory: false,
                kind: Some(entry.kind.clone()),
                file_size: Some(entry.file_size),
                asset_id: entry.asset_id.clone(),
                missing: false,
                children: vec![],
            });
        }
    }

    result
}

/// Get the immediate child directory name from a full path relative to a prefix
fn get_direct_child_dir(prefix: &str, full_path: &str) -> Option<String> {
    let suffix = if prefix.is_empty() {
        full_path.to_string()
    } else if let Some(s) = full_path.strip_prefix(prefix) {
        s.trim_start_matches('/').to_string()
    } else {
        return None;
    };

    if suffix.is_empty() {
        return None;
    }

    // Get only the first directory component
    suffix.split('/').next().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{AssetKind, AudioInfo};
    use crate::core::CoreError;

    /// An index entry for a file the scanner claims to have found.
    fn index_entry(relative_path: &str, kind: AssetKind, file_size: u64) -> IndexEntry {
        IndexEntry {
            relative_path: relative_path.to_string(),
            kind,
            file_size,
            modified_at: 0,
            asset_id: None,
            indexed_at: 0,
            metadata_extracted: false,
        }
    }

    /// Feature: workspace auto-registration
    /// Scenario: FFprobe cannot be started while the workspace is scanned
    ///
    /// Given a workspace file and an FFprobe that cannot be launched
    /// When the scan builds the asset it would register
    /// Then it refuses instead of registering one, because the frame size,
    /// duration and codec it would otherwise attach were never measured - this
    /// is the GUI's own import path, and it must not fill a project with
    /// invented 1920x1080 stills and durationless clips.
    #[test]
    fn a_workspace_file_is_not_registered_when_ffprobe_cannot_be_launched() {
        for kind in [AssetKind::Video, AssetKind::Image, AssetKind::Audio] {
            let entry = index_entry("footage/subject.mp4", kind.clone(), 1_024);
            let built = build_workspace_asset_with(
                &entry,
                std::path::Path::new("/workspace/footage/subject.mp4"),
                |_| {
                    Err(CoreError::FFprobeUnavailable(
                        "Failed to run ffprobe: program not found".to_string(),
                    ))
                },
            );

            assert!(
                matches!(built, Err(CoreError::FFprobeUnavailable(_))),
                "a {kind:?} asset must not be invented when no probe ran"
            );
        }
    }

    /// Feature: workspace auto-registration
    /// Scenario: FFprobe ran and could not describe the file
    ///
    /// Given a workspace file FFprobe looked at and refused
    /// When the scan builds the asset it would register
    /// Then the asset is still built from the index entry and the defaults,
    /// because something did look: one unreadable file must not stop a scan.
    #[test]
    fn a_file_ffprobe_refused_is_still_registered_from_the_index_entry() {
        let entry = index_entry("footage/broken.mp4", AssetKind::Video, 1_024);
        let built = build_workspace_asset_with(
            &entry,
            std::path::Path::new("/workspace/footage/broken.mp4"),
            |_| {
                Err(CoreError::FFprobeError(
                    "FFprobe failed: Invalid data found when processing input".to_string(),
                ))
            },
        );

        let asset = built.expect("a verdict about the file is not a reason to refuse the scan");
        assert_eq!(asset.name, "broken.mp4");
        assert_eq!(asset.file_size, entry.file_size);
        assert_eq!(asset.duration_sec, None);
    }

    /// Feature: workspace auto-registration
    /// Scenario: FFprobe runs and returns output nothing can be read from
    ///
    /// Given a workspace file whose probe exits without a measurement
    /// When the scan builds the asset it would register
    /// Then it refuses, exactly as it does when no probe could be launched:
    /// output that cannot be read is not a verdict about the file, so the
    /// frame size and duration the defaults would supply are still invented.
    #[test]
    fn a_workspace_file_is_not_registered_when_the_probe_measured_nothing() {
        let entry = index_entry("footage/subject.mp4", AssetKind::Video, 1_024);
        let built = build_workspace_asset_with(
            &entry,
            std::path::Path::new("/workspace/footage/subject.mp4"),
            |_| {
                Err(CoreError::FFprobeError(format!(
                    "{}: failed to parse ffprobe output: EOF while parsing a value",
                    crate::core::assets::PROBE_MEASURED_NOTHING_PREFIX
                )))
            },
        );

        assert!(
            built.is_err(),
            "an asset must not be invented from a probe that measured nothing"
        );
    }

    /// What a successful probe of a short clip reports.
    fn probed_metadata() -> crate::core::assets::MediaMetadata {
        crate::core::assets::MediaMetadata {
            duration_sec: 12.0,
            video_duration_sec: Some(12.0),
            audio_duration_sec: None,
            file_size: 1024,
            video: Some(crate::core::assets::VideoInfo::default()),
            audio: None,
            format: "mov,mp4,m4a,3gp,3g2,mj2".to_string(),
            rotation_deg: 0.0,
        }
    }

    /// Feature: workspace auto-registration
    /// Scenario: FFprobe cannot be launched for one file of several
    ///
    /// Given two workspace files, one of which no FFprobe can be started for
    /// When the scan auto-registers what it found
    /// Then the measurable file is registered and the other is reported as
    /// skipped - abandoning the pass at the first refusal would leave the
    /// assets already inserted in the project state with no op behind them.
    #[test]
    fn one_unlaunchable_probe_does_not_abandon_the_rest_of_the_pass() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("footage")).unwrap();
        std::fs::write(dir.path().join("footage/measurable.mp4"), "v").unwrap();
        std::fs::write(dir.path().join("footage/unreachable.mp4"), "v").unwrap();

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        let mut state = ProjectState::new("Workspace Skip Test");
        let outcome = service
            .auto_register_discovered_files_with(&mut state, dir.path(), |path| {
                if path.ends_with("unreachable.mp4") {
                    return Err(CoreError::FFprobeUnavailable(
                        "Failed to run ffprobe: program not found".to_string(),
                    ));
                }
                Ok(probed_metadata())
            })
            .expect("a probe that could not be launched is not a scan failure");

        assert_eq!(outcome.registered, 1);
        assert_eq!(outcome.skipped.len(), 1);
        assert!(
            outcome.skipped[0].ends_with("unreachable.mp4"),
            "the unmeasurable file is the one reported: {:?}",
            outcome.skipped
        );
        assert_eq!(state.assets.len(), 1);
        assert!(
            state
                .assets
                .values()
                .any(|asset| asset.name == "measurable.mp4"),
            "the file FFprobe did measure is still registered"
        );
    }

    /// Feature: workspace auto-registration
    /// Scenario: the file already has an asset, and the top-up probe fails
    ///
    /// Given a project whose asset for a workspace file is missing a duration
    /// And a probe that measures nothing when asked to fill that gap
    /// When the scan links the file to that existing asset
    /// Then the link is still made and the asset keeps the metadata it was
    /// imported with, because the asset is real: refusing the link would leave
    /// the explorer showing an already-imported file as unregistered. The file
    /// is reported as unrefreshed, not skipped - nothing was refused.
    #[test]
    fn an_existing_asset_is_still_linked_when_the_top_up_probe_measures_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("footage")).unwrap();
        std::fs::write(dir.path().join("footage/known.mp4"), "v").unwrap();

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        let mut state = ProjectState::new("Workspace Relink Test");
        let video = crate::core::assets::VideoInfo {
            codec: "h264".to_string(),
            ..Default::default()
        };
        let existing = Asset::new_video(
            "known.mp4",
            &dir.path().join("footage/known.mp4").to_string_lossy(),
            video,
        )
        .with_relative_path("footage/known.mp4")
        .as_workspace_managed()
        .with_file_size(4096);
        let existing_id = existing.id.clone();
        state.assets.insert(existing_id.clone(), existing);

        let outcome = service
            .auto_register_discovered_files_with(&mut state, dir.path(), |_| {
                Err(CoreError::FFprobeUnavailable(
                    "Failed to run ffprobe: program not found".to_string(),
                ))
            })
            .expect("a probe that measured nothing is not a scan failure");

        assert!(
            outcome.skipped.is_empty(),
            "an asset that already exists was not refused: {:?}",
            outcome.skipped
        );
        assert_eq!(outcome.unrefreshed.len(), 1);
        assert!(outcome.unrefreshed[0].ends_with("known.mp4"));

        let asset = state.assets.get(&existing_id).expect("the asset survives");
        assert_eq!(
            asset.file_size, 4096,
            "imported metadata is not overwritten"
        );
        assert_eq!(asset.duration_sec, None, "the gap is left for a later pass");
        assert_eq!(
            asset.video.as_ref().map(|video| video.codec.as_str()),
            Some("h264"),
            "a real codec is not replaced by a default"
        );

        let linked = service
            .index
            .get_all()
            .unwrap()
            .into_iter()
            .find(|entry| entry.relative_path.ends_with("known.mp4"))
            .expect("the file stays in the index");
        assert_eq!(
            linked.asset_id.as_deref(),
            Some(existing_id.as_str()),
            "the file is linked to the asset that already covers it"
        );
    }

    /// Feature: workspace auto-registration
    /// Scenario: the top-up a failed probe deferred is retried by a later pass
    ///
    /// Given a workspace file whose asset was linked without its duration,
    /// because the probe of an earlier pass measured nothing
    /// When a later pass runs and a probe works this time
    /// Then the gap is filled. The file is registered in the index, so the
    /// unregistered loop can never reach it again: only a pass over registered
    /// entries makes the retry that `unrefreshed` promises real.
    #[test]
    fn a_deferred_top_up_is_retried_by_a_later_pass() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("footage")).unwrap();
        std::fs::write(dir.path().join("footage/known.mp4"), "v").unwrap();

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        let mut state = ProjectState::new("Workspace Top-Up Retry Test");
        let video = crate::core::assets::VideoInfo {
            codec: "h264".to_string(),
            ..Default::default()
        };
        let existing = Asset::new_video(
            "known.mp4",
            &dir.path().join("footage/known.mp4").to_string_lossy(),
            video,
        )
        .with_relative_path("footage/known.mp4")
        .as_workspace_managed()
        .with_file_size(4096);
        let existing_id = existing.id.clone();
        state.assets.insert(existing_id.clone(), existing);

        let first = service
            .auto_register_discovered_files_with(&mut state, dir.path(), |_| {
                Err(CoreError::FFprobeUnavailable(
                    "Failed to run ffprobe: program not found".to_string(),
                ))
            })
            .expect("a probe that measured nothing is not a scan failure");

        assert_eq!(first.unrefreshed.len(), 1);
        assert_eq!(
            state.assets.get(&existing_id).unwrap().duration_sec,
            None,
            "nothing was measured, so nothing was filled in"
        );

        let second = service
            .auto_register_discovered_files_with(&mut state, dir.path(), |_| Ok(probed_metadata()))
            .expect("the retry is an ordinary pass");

        assert_eq!(
            second.registered, 0,
            "the file was already registered by the first pass"
        );
        assert!(
            second.unrefreshed.is_empty(),
            "the gap the first pass left is closed: {:?}",
            second.unrefreshed
        );
        assert_eq!(
            state.assets.get(&existing_id).unwrap().duration_sec,
            Some(12.0),
            "a working probe fills the duration the first pass could not measure"
        );
    }

    /// Feature: workspace auto-registration
    /// Scenario: a registered file is gone when the top-up pass reaches it
    ///
    /// Given a registered asset with a gap, whose file was deleted before the
    /// removal reached the index
    /// When a pass sweeps the registered entries looking for gaps to fill
    /// Then it leaves that entry alone. The pass covers every registered file,
    /// not only the ones the scanner just saw, so probing one that is no longer
    /// there would fail the scan of the whole workspace.
    #[test]
    fn a_deleted_file_does_not_fail_the_top_up_pass() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("footage")).unwrap();
        std::fs::write(dir.path().join("footage/gone.mp4"), "v").unwrap();

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        let mut state = ProjectState::new("Workspace Deleted File Test");
        let registered = service
            .auto_register_discovered_files_with(&mut state, dir.path(), |_| {
                Err(CoreError::FFprobeUnavailable(
                    "Failed to run ffprobe: program not found".to_string(),
                ))
            })
            .expect("an unmeasurable file is not a scan failure");
        assert_eq!(registered.skipped.len(), 1);

        // Register it for real, so the next pass has a linked asset with a gap.
        let outcome = service
            .auto_register_discovered_files_with(&mut state, dir.path(), |_| {
                Ok(crate::core::assets::MediaMetadata {
                    duration_sec: 0.0,
                    video_duration_sec: None,
                    audio_duration_sec: None,
                    file_size: 0,
                    video: None,
                    audio: None,
                    format: "mov,mp4,m4a,3gp,3g2,mj2".to_string(),
                    rotation_deg: 0.0,
                })
            })
            .expect("the file is registered from what the probe did report");
        assert_eq!(outcome.registered, 1);

        std::fs::remove_file(dir.path().join("footage/gone.mp4")).unwrap();

        let after_delete = service
            .auto_register_discovered_files_with(&mut state, dir.path(), |_| {
                panic!("a file that is no longer on disk must not be probed")
            })
            .expect("a deleted file does not fail the pass");

        assert_eq!(after_delete, AutoRegisterOutcome::default());
    }

    /// Feature: workspace auto-registration
    /// Scenario: a pass over a workspace with nothing left to fill in
    ///
    /// Given a workspace whose assets are all fully measured, including a still
    /// When another pass runs with a probe that would panic if it were called
    /// Then no probe runs. A still has no duration to measure, so treating its
    /// absence as a gap would re-probe every image in the workspace on every
    /// pass, for a measurement that can never arrive.
    #[test]
    fn a_pass_does_not_re_probe_files_that_have_nothing_left_to_fill() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("footage")).unwrap();
        std::fs::write(dir.path().join("footage/still.png"), "i").unwrap();

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        // What FFprobe reports about a still: dimensions, bytes, no duration.
        let still_metadata = crate::core::assets::MediaMetadata {
            duration_sec: 0.0,
            video_duration_sec: None,
            audio_duration_sec: None,
            file_size: 1024,
            video: Some(crate::core::assets::VideoInfo {
                width: 1920,
                height: 1080,
                codec: "png".to_string(),
                ..Default::default()
            }),
            audio: None,
            format: "png_pipe".to_string(),
            rotation_deg: 0.0,
        };

        let mut state = ProjectState::new("Workspace Re-Probe Test");
        let first = service
            .auto_register_discovered_files_with(&mut state, dir.path(), |_| {
                Ok(still_metadata.clone())
            })
            .expect("the still is measurable");
        assert_eq!(first.registered, 1);
        assert!(
            state
                .assets
                .values()
                .all(|asset| asset.duration_sec.is_none()),
            "a still has no duration to report"
        );

        let second = service
            .auto_register_discovered_files_with(&mut state, dir.path(), |_| {
                panic!("a fully measured workspace must not be probed again")
            })
            .expect("a pass with nothing to do is not a failure");

        assert_eq!(second, AutoRegisterOutcome::default());
    }

    /// What FFprobe reports about a container that carries no duration of its
    /// own: the streams are described, `format.duration` is simply absent.
    fn undurated_metadata() -> crate::core::assets::MediaMetadata {
        crate::core::assets::MediaMetadata {
            duration_sec: 0.0,
            video_duration_sec: None,
            audio_duration_sec: None,
            file_size: 1024,
            video: Some(crate::core::assets::VideoInfo {
                width: 1920,
                height: 1080,
                codec: "h264".to_string(),
                ..Default::default()
            }),
            audio: None,
            format: "h264".to_string(),
            rotation_deg: 0.0,
        }
    }

    /// A workspace holding one file, scanned and ready for a pass.
    fn workspace_with_file(name: &str) -> (tempfile::TempDir, WorkspaceService) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("footage")).unwrap();
        std::fs::write(dir.path().join("footage").join(name), "v").unwrap();

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();
        (dir, service)
    }

    /// Feature: workspace auto-registration
    /// Scenario: a metadata gap no successful probe can ever close
    ///
    /// Given a file whose container reports no duration, so the probe succeeds
    /// and the asset still has none
    /// When pass after pass sweeps the registered entries
    /// Then the file is probed once and then left alone. The gap check would
    /// otherwise keep saying yes forever, and the watcher runs a pass per
    /// filesystem event with the project lock held - so an unclosable gap
    /// would spawn an FFprobe on every keystroke that touches the folder.
    #[test]
    fn a_gap_no_probe_can_close_is_measured_once_per_service() {
        let (dir, service) = workspace_with_file("rawstream.mp4");
        let probes = AtomicUsize::new(0);
        let probe = |_: &std::path::Path| -> CoreResult<crate::core::assets::MediaMetadata> {
            probes.fetch_add(1, Ordering::Relaxed);
            Ok(undurated_metadata())
        };

        let mut state = ProjectState::new("Workspace Settled Gap Test");
        let first = service
            .auto_register_discovered_files_with(&mut state, dir.path(), probe)
            .expect("the file is measurable, it just has no duration to report");
        assert_eq!(first.registered, 1);
        assert_eq!(
            probes.load(Ordering::Relaxed),
            1,
            "registering the file is one probe; the same pass must not measure it twice"
        );
        let asset_id = state.assets.keys().next().cloned().expect("one asset");
        assert_eq!(
            state.assets[&asset_id].duration_sec, None,
            "the container reported no duration, so the asset has none"
        );

        service
            .auto_register_discovered_files_with(&mut state, dir.path(), probe)
            .expect("a pass over a registered file is not a failure");
        assert_eq!(
            probes.load(Ordering::Relaxed),
            2,
            "the first pass built the asset moments earlier; the retry is this one"
        );

        for _ in 0..3 {
            service
                .auto_register_discovered_files_with(&mut state, dir.path(), probe)
                .expect("a pass with nothing left to measure is not a failure");
        }
        assert_eq!(
            probes.load(Ordering::Relaxed),
            2,
            "a gap a successful probe left open is not re-measured"
        );
    }

    /// Feature: workspace auto-registration
    /// Scenario: the file whose gap was given up on is written to again
    ///
    /// Given a settled gap, no longer probed by any pass
    /// When the watcher reports that the file changed
    /// Then the next pass measures it again. New bytes may carry the duration
    /// the old ones did not - a growing recording finalised by its camera, a
    /// placeholder overwritten with the real take.
    #[test]
    fn a_modified_file_re_opens_a_settled_gap() {
        let (dir, service) = workspace_with_file("rawstream.mp4");

        let mut state = ProjectState::new("Workspace Re-Open Gap Test");
        for _ in 0..2 {
            service
                .auto_register_discovered_files_with(&mut state, dir.path(), |_| {
                    Ok(undurated_metadata())
                })
                .expect("the file is measurable");
        }
        let asset_id = state.assets.keys().next().cloned().expect("one asset");
        assert_eq!(state.assets[&asset_id].duration_sec, None);

        std::fs::write(dir.path().join("footage/rawstream.mp4"), "vv").unwrap();
        service
            .handle_event(&WorkspaceEvent::FileModified(
                "footage/rawstream.mp4".to_string(),
            ))
            .expect("an ordinary modification event");

        service
            .auto_register_discovered_files_with(&mut state, dir.path(), |_| Ok(probed_metadata()))
            .expect("the pass after the change is an ordinary one");

        assert_eq!(
            state.assets[&asset_id].duration_sec,
            Some(12.0),
            "the changed file is measured again, and this time it has a duration"
        );
    }

    /// Feature: workspace auto-registration
    /// Scenario: the top-up probe measured nothing, over and over
    ///
    /// Given a registered asset with a gap and a probe that keeps failing to
    /// measure anything
    /// When pass after pass reaches it
    /// Then every pass tries again and reports it unrefreshed. Giving up is
    /// only ever right when a probe *ran* and had nothing to add; a probe that
    /// never measured says nothing about the file, and the FFmpeg it is
    /// waiting on may finish installing at any moment.
    #[test]
    fn a_probe_that_measured_nothing_never_settles_the_gap() {
        let (dir, service) = workspace_with_file("rawstream.mp4");

        let mut state = ProjectState::new("Workspace Unsettled Gap Test");
        service
            .auto_register_discovered_files_with(&mut state, dir.path(), |_| {
                Ok(undurated_metadata())
            })
            .expect("the file is registered from what the probe did report");
        let asset_id = state.assets.keys().next().cloned().expect("one asset");

        for pass in 0..3 {
            let outcome = service
                .auto_register_discovered_files_with(&mut state, dir.path(), |_| {
                    Err(CoreError::FFprobeUnavailable(
                        "Failed to run ffprobe: program not found".to_string(),
                    ))
                })
                .expect("a probe that measured nothing is not a scan failure");
            assert_eq!(
                outcome.unrefreshed.len(),
                1,
                "pass {pass} must still be trying: {:?}",
                outcome.unrefreshed
            );
        }

        service
            .auto_register_discovered_files_with(&mut state, dir.path(), |_| Ok(probed_metadata()))
            .expect("the pass that finally has an FFprobe is an ordinary one");
        assert_eq!(
            state.assets[&asset_id].duration_sec,
            Some(12.0),
            "the gap the failing probes deferred is closed once one works"
        );
    }

    fn create_test_project(dir: &std::path::Path) {
        std::fs::create_dir_all(dir.join("footage")).unwrap();
        std::fs::create_dir_all(dir.join("footage/broll")).unwrap();
        std::fs::create_dir_all(dir.join("audio")).unwrap();
        std::fs::write(dir.join("footage/interview.mp4"), "v").unwrap();
        std::fs::write(dir.join("footage/broll/city.mp4"), "v").unwrap();
        std::fs::write(dir.join("audio/bgm.wav"), "a").unwrap();
    }

    /// Feature: a scan re-probes only what it is missing
    /// Scenario: a still already carrying its size and dimensions
    ///   Given a registered image asset, whose duration is legitimately unknown
    ///   When the workspace refreshes it
    ///   Then nothing is re-read, and the recorded dimensions survive
    #[test]
    fn should_not_reprobe_a_still_whose_duration_is_legitimately_unknown() {
        // The probe would answer 1920x1080 for this path, since there is no
        // file behind it — so a refresh that ran would be visible here.
        let mut asset = Asset::new_image("cover.png", "/nowhere/cover.png", 400, 300)
            .with_file_size(1_234)
            .with_relative_path("cover.png");
        assert_eq!(asset.duration_sec, None, "a still records no duration");

        refresh_existing_workspace_asset_metadata(
            &mut asset,
            &index_entry("cover.png", AssetKind::Image, 1_234),
            std::path::Path::new("/nowhere/cover.png"),
            |_| panic!("a still with nothing missing must not be re-probed"),
        )
        .expect("a refresh that does not run cannot fail");

        assert_eq!(asset.video.as_ref().map(|video| video.width), Some(400));
        assert_eq!(asset.file_size, 1_234);
    }

    /// A still that never got a size *is* still incomplete, and is refreshed.
    #[test]
    fn should_reprobe_a_still_that_is_missing_its_file_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cover.png");
        std::fs::write(&path, "not really a png").unwrap();

        let mut asset = Asset::new_image("cover.png", &path.to_string_lossy(), 400, 300)
            .with_relative_path("cover.png");
        assert_eq!(asset.file_size, 0);

        refresh_existing_workspace_asset_metadata(
            &mut asset,
            &index_entry("cover.png", AssetKind::Image, 16),
            &path,
            |_| Ok(probed_metadata()),
        )
        .expect("the probe measured the file");

        assert!(asset.file_size > 0, "the missing size is filled in");
    }

    /// A video with no duration is a different case: its length is knowable and
    /// missing, so the refresh still runs for it.
    #[test]
    fn should_still_reprobe_a_video_that_is_missing_its_duration() {
        let mut asset = Asset::new_video(
            "clip.mp4",
            "/nowhere/clip.mp4",
            crate::core::assets::VideoInfo {
                width: 640,
                height: 360,
                codec: "h264".to_string(),
                ..Default::default()
            },
        )
        .with_file_size(2_048)
        .with_relative_path("clip.mp4");
        assert_eq!(asset.duration_sec, None);

        refresh_existing_workspace_asset_metadata(
            &mut asset,
            &index_entry("clip.mp4", AssetKind::Video, 2_048),
            std::path::Path::new("/nowhere/clip.mp4"),
            // FFprobe looked and refused, which is a verdict about the
            // file rather than a probe that measured nothing, so the
            // refresh runs and finds no length to record.
            |_| Err(CoreError::FFprobeError("no such file".to_string())),
        )
        .expect("a file FFprobe refused is not a refresh failure");

        // The probe found nothing behind the path, so the duration is still
        // unknown — what matters is that the refresh was attempted and left the
        // recorded stream metadata alone.
        assert_eq!(asset.duration_sec, None);
        assert_eq!(asset.video.as_ref().map(|video| video.width), Some(640));
    }

    /// Feature: a scan re-reads what older rules measured wrongly
    /// Scenario: an mp4 whose AAC outlasts its pictures
    ///   Given a video registered before the picture length was the recorded
    ///   one, carrying its 6s container length and no probe marker
    ///   When the workspace refreshes it under the current rules
    ///   Then it records the 4s its video stream really runs for, plus the
    ///   6s its sound runs for, and is stamped as read
    ///
    /// Gap-filling the length here would keep the 6s reading *and* stamp the
    /// marker, so nothing would ever look at the file again: the refresh check
    /// and `asset_needs_measurement` would both report it as measured, and
    /// every clip cut from it would carry a two-second black tail forever.
    #[test]
    fn should_replace_a_container_length_recorded_before_the_current_probe_rules() {
        let mut asset = Asset::new_video(
            "interview.mp4",
            "/nowhere/interview.mp4",
            crate::core::assets::VideoInfo {
                width: 1920,
                height: 1080,
                codec: "h264".to_string(),
                ..Default::default()
            },
        )
        .with_file_size(4_096)
        .with_relative_path("interview.mp4");
        // What a pre-`audioDurationSec` scan recorded: the container length,
        // which is the longest stream rather than the picture's own.
        asset.duration_sec = Some(6.0);
        assert_eq!(asset.probe_version, None, "read under the older rules");
        assert!(
            workspace_asset_needs_metadata_refresh(&asset),
            "a stale marker is what makes this asset worth re-reading"
        );

        refresh_existing_workspace_asset_metadata(
            &mut asset,
            &index_entry("interview.mp4", AssetKind::Video, 4_096),
            std::path::Path::new("/nowhere/interview.mp4"),
            |_| {
                Ok(crate::core::assets::MediaMetadata {
                    duration_sec: 6.0,
                    video_duration_sec: Some(4.0),
                    audio_duration_sec: Some(6.0),
                    file_size: 4_096,
                    video: Some(crate::core::assets::VideoInfo {
                        width: 1920,
                        height: 1080,
                        codec: "h264".to_string(),
                        ..Default::default()
                    }),
                    audio: Some(crate::core::assets::AudioInfo::default()),
                    format: "mov,mp4,m4a,3gp,3g2,mj2".to_string(),
                    rotation_deg: 0.0,
                })
            },
        )
        .expect("the probe measured the file");

        assert_eq!(
            asset.duration_sec,
            Some(4.0),
            "the picture's own length replaces the container length"
        );
        assert_eq!(
            asset.audio_duration_sec,
            Some(6.0),
            "the sound past the last frame is recorded rather than lost"
        );
        assert_eq!(
            asset.probe_version,
            Some(ASSET_PROBE_VERSION),
            "the reading is stamped, so the next pass leaves the file alone"
        );
        assert!(
            !workspace_asset_needs_metadata_refresh(&asset),
            "a corrected asset settles instead of being re-probed forever"
        );
    }

    /// Feature: a scan re-reads what older rules measured wrongly
    /// Scenario: the re-read is attempted but FFprobe refuses the file
    ///   Given a video carrying a stale marker and both recorded lengths
    ///   When the refresh runs and the probe fails with a verdict about the
    ///   file — not with a probe that measured nothing
    ///   Then both lengths survive and the marker is *not* stamped
    ///
    /// The supersede arm assigns `audio_duration_sec` outright, because `None`
    /// is a reading there. It must only be reached when a reading was actually
    /// taken. A refusal FFprobe reached about the file is carried as "no
    /// metadata" rather than raised, so it would otherwise walk into that arm
    /// and erase the sound length on the strength of a probe that never ran —
    /// and, worse, stamp the marker, so no later pass would look again.
    #[test]
    fn should_keep_both_lengths_when_a_stale_asset_is_refreshed_and_the_probe_refuses() {
        let mut asset = Asset::new_video(
            "interview.mp4",
            "/nowhere/interview.mp4",
            crate::core::assets::VideoInfo {
                width: 1920,
                height: 1080,
                codec: "h264".to_string(),
                ..Default::default()
            },
        )
        .with_file_size(4_096)
        .with_relative_path("interview.mp4");
        asset.duration_sec = Some(4.0);
        asset.audio_duration_sec = Some(6.0);
        assert_eq!(asset.probe_version, None, "read under the older rules");
        assert!(workspace_asset_needs_metadata_refresh(&asset));

        refresh_existing_workspace_asset_metadata(
            &mut asset,
            &index_entry("interview.mp4", AssetKind::Video, 4_096),
            std::path::Path::new("/nowhere/interview.mp4"),
            // A verdict about the file, not a probe that measured nothing, so
            // the refresh completes with no metadata rather than failing.
            |_| Err(CoreError::FFprobeError("moov atom not found".to_string())),
        )
        .expect("a file FFprobe refused is not a refresh failure");

        assert_eq!(
            asset.duration_sec,
            Some(4.0),
            "a probe that never read the file cannot supersede the picture length"
        );
        assert_eq!(
            asset.audio_duration_sec,
            Some(6.0),
            "nor can it erase the sound length by reporting one it never measured"
        );
        assert_eq!(
            asset.probe_version, None,
            "an unread file stays unread, so a later pass still tries"
        );
        assert!(
            workspace_asset_needs_metadata_refresh(&asset),
            "the asset is still owed a reading"
        );
    }

    /// The gap-fill arm is untouched: a refresh that runs only because a length
    /// is missing must not let a probe with nothing to say erase what is there.
    #[test]
    fn should_keep_a_recorded_length_when_an_already_stamped_asset_is_refreshed() {
        let mut asset = Asset::new_video(
            "clip.mp4",
            "/nowhere/clip.mp4",
            crate::core::assets::VideoInfo::default(),
        )
        .with_relative_path("clip.mp4");
        asset.duration_sec = Some(4.0);
        asset.audio_duration_sec = Some(6.0);
        asset.probe_version = Some(ASSET_PROBE_VERSION);
        // Only the missing codec and size make this one worth refreshing.
        assert!(workspace_asset_needs_metadata_refresh(&asset));

        refresh_existing_workspace_asset_metadata(
            &mut asset,
            &index_entry("clip.mp4", AssetKind::Video, 2_048),
            std::path::Path::new("/nowhere/clip.mp4"),
            |_| {
                Ok(crate::core::assets::MediaMetadata {
                    duration_sec: 0.0,
                    video_duration_sec: None,
                    audio_duration_sec: None,
                    file_size: 2_048,
                    video: Some(crate::core::assets::VideoInfo {
                        codec: "h264".to_string(),
                        ..Default::default()
                    }),
                    audio: None,
                    format: "mov,mp4,m4a,3gp,3g2,mj2".to_string(),
                    rotation_deg: 0.0,
                })
            },
        )
        .expect("the probe measured the file");

        assert_eq!(
            asset.duration_sec,
            Some(4.0),
            "a probe carrying no usable length leaves the recorded one alone"
        );
        assert_eq!(
            asset.audio_duration_sec,
            Some(6.0),
            "the sound length is gap-filled too, not assigned over"
        );
    }

    #[test]
    fn test_service_open() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        assert_eq!(service.project_root(), dir.path());
    }

    #[test]
    fn test_initial_scan() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        let result = service.initial_scan().unwrap();

        assert_eq!(result.total_files, 3);
        assert_eq!(result.new_files, 3);
        assert_eq!(result.removed_files, 0);
        assert_eq!(result.registered_files, 0);
    }

    #[test]
    fn test_rescan_detects_new_files() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        // Add a new file
        std::fs::write(dir.path().join("footage/extra.mp4"), "v").unwrap();

        let result = service.initial_scan().unwrap();
        assert_eq!(result.total_files, 4);
        assert_eq!(result.new_files, 1);
    }

    #[test]
    fn test_rescan_detects_removed_files() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        // Remove a file
        std::fs::remove_file(dir.path().join("audio/bgm.wav")).unwrap();

        let result = service.initial_scan().unwrap();
        assert_eq!(result.total_files, 2);
        assert_eq!(result.removed_files, 1);
    }

    #[test]
    fn test_get_file_tree() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        let tree = service.get_file_tree().unwrap();

        // Root should have 2 directories: audio, footage
        assert_eq!(tree.len(), 2);
        assert!(tree.iter().any(|e| e.name == "audio" && e.is_directory));
        assert!(tree.iter().any(|e| e.name == "footage" && e.is_directory));

        // footage should have broll dir + interview.mp4
        let footage = tree.iter().find(|e| e.name == "footage").unwrap();
        assert_eq!(footage.children.len(), 2);
    }

    #[test]
    fn test_get_unregistered_files() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        // All files should be unregistered initially
        let unreg = service.get_unregistered_files().unwrap();
        assert_eq!(unreg.len(), 3);

        // Register one
        service
            .index()
            .mark_registered("audio/bgm.wav", "asset-1")
            .unwrap();

        let unreg = service.get_unregistered_files().unwrap();
        assert_eq!(unreg.len(), 2);
    }

    #[test]
    fn test_handle_event_file_added() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        // Simulate adding a new file
        std::fs::write(dir.path().join("footage/new.mp4"), "v").unwrap();
        service
            .handle_event(&WorkspaceEvent::FileAdded("footage/new.mp4".to_string()))
            .unwrap();

        assert!(service.index().get("footage/new.mp4").unwrap().is_some());
    }

    #[test]
    fn test_handle_event_file_removed() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        std::fs::remove_file(dir.path().join("audio/bgm.wav")).unwrap();
        service
            .handle_event(&WorkspaceEvent::FileRemoved("audio/bgm.wav".to_string()))
            .unwrap();

        assert!(service.index().get("audio/bgm.wav").unwrap().is_none());
    }

    /// Feature: a scanned file records the lengths import would have recorded
    /// Scenario: an mp4 with four seconds of picture and six of sound
    ///   Given the scanner's own probe reading of that file
    ///   When the asset is built from it
    ///   Then it records the picture's four seconds and the sound's six, not
    ///   the container's maximum
    #[test]
    fn should_record_the_picture_and_the_sound_of_a_scanned_file_separately() {
        let metadata = MediaMetadata {
            duration_sec: 6.0,
            video_duration_sec: Some(4.0),
            audio_duration_sec: Some(6.0),
            audio: Some(AudioInfo::default()),
            ..MediaMetadata::default()
        };

        let mut asset = Asset::new_video("mixed.mp4", "mixed.mp4", Default::default());
        apply_probed_durations(&mut asset, &metadata);

        assert_eq!(asset.duration_sec, Some(4.0));
        assert_eq!(asset.audio_duration_sec, Some(6.0));
    }

    /// Feature: a scanned still holds whatever slot the timeline gives it
    /// Scenario: FFprobe answers a JPEG with one frame's 0.04s
    #[test]
    fn should_record_no_duration_for_a_scanned_still() {
        let metadata = MediaMetadata {
            duration_sec: 0.04,
            ..MediaMetadata::default()
        };

        let mut asset = Asset::new_image("still.jpg", "still.jpg", 1920, 1080);
        apply_probed_durations(&mut asset, &metadata);

        assert_eq!(asset.duration_sec, None);
        assert_eq!(asset.audio_duration_sec, None);
    }

    #[test]
    fn test_build_file_tree_nested() {
        let entries = vec![
            IndexEntry {
                relative_path: "a/b/c.mp4".to_string(),
                kind: AssetKind::Video,
                file_size: 100,
                modified_at: 0,
                asset_id: None,
                indexed_at: 0,
                metadata_extracted: false,
            },
            IndexEntry {
                relative_path: "a/d.mp4".to_string(),
                kind: AssetKind::Video,
                file_size: 200,
                modified_at: 0,
                asset_id: Some("asset-1".to_string()),
                indexed_at: 0,
                metadata_extracted: false,
            },
            IndexEntry {
                relative_path: "e.wav".to_string(),
                kind: AssetKind::Audio,
                file_size: 50,
                modified_at: 0,
                asset_id: None,
                indexed_at: 0,
                metadata_extracted: false,
            },
        ];

        let tree = build_file_tree(&entries);

        // Root: dir "a" + file "e.wav"
        assert_eq!(tree.len(), 2);

        let dir_a = tree.iter().find(|e| e.name == "a").unwrap();
        assert!(dir_a.is_directory);
        // a/: dir "b" + file "d.mp4"
        assert_eq!(dir_a.children.len(), 2);

        let file_d = dir_a.children.iter().find(|e| e.name == "d.mp4").unwrap();
        assert!(!file_d.is_directory);
        assert_eq!(file_d.asset_id, Some("asset-1".to_string()));

        let dir_b = dir_a.children.iter().find(|e| e.name == "b").unwrap();
        assert!(dir_b.is_directory);
        assert_eq!(dir_b.children.len(), 1);
        assert_eq!(dir_b.children[0].name, "c.mp4");
    }

    #[test]
    fn test_handle_event_with_state_marks_missing_on_file_removed() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        let mut state = ProjectState::new_empty("test");
        let asset = Asset::new_audio("bgm.wav", "audio/bgm.wav", AudioInfo::default())
            .with_relative_path("audio/bgm.wav");
        let asset_id = asset.id.clone();
        state.assets.insert(asset_id.clone(), asset);

        // Remove the file from disk
        std::fs::remove_file(dir.path().join("audio/bgm.wav")).unwrap();

        service
            .handle_event_with_state(
                &WorkspaceEvent::FileRemoved("audio/bgm.wav".to_string()),
                &mut state,
            )
            .unwrap();

        assert!(state.assets.get(&asset_id).unwrap().missing);
    }

    #[test]
    fn test_handle_event_with_state_reconnects_on_file_added() {
        let dir = tempfile::tempdir().unwrap();
        create_test_project(dir.path());

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        service.initial_scan().unwrap();

        let mut state = ProjectState::new_empty("test");
        let mut asset = Asset::new_audio("bgm.wav", "audio/bgm.wav", AudioInfo::default())
            .with_relative_path("audio/bgm.wav");
        asset.missing = true;
        let asset_id = asset.id.clone();
        state.assets.insert(asset_id.clone(), asset);

        service
            .handle_event_with_state(
                &WorkspaceEvent::FileAdded("audio/bgm.wav".to_string()),
                &mut state,
            )
            .unwrap();

        assert!(!state.assets.get(&asset_id).unwrap().missing);
    }
}
