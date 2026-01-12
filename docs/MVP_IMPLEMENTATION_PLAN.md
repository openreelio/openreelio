# MVP Implementation Plan (v0.1.0)

> **Goal:** Deliver a functional desktop video editor that can import media, arrange clips on a timeline, preview playback, and export to video file.

---

## Executive Summary

### Target Outcome
A user downloads OpenReelio, launches it, and can:
1. Create a new project
2. Import video/audio files
3. Drag clips onto a timeline
4. Preview the composition
5. Export to MP4

### Technical Prerequisites
- Windows SDK 10.0+ (for Rust/Tauri build)
- FFmpeg 6+ (for video processing)
- Node.js 20+ and Rust 1.85+

### Estimated Scope
- **Phase 0**: Build environment setup (blocker resolution)
- **Phase 1**: Project & Asset management (frontend integration)
- **Phase 2**: Timeline core (major feature)
- **Phase 3**: Preview system (major feature)
- **Phase 4**: Export pipeline (major feature)
- **Phase 5**: Polish & UX refinements

---

## Phase 0: Build Environment Setup

### Current Blocker
Windows SDK not installed - `kernel32.lib` not found during Rust compilation.

### Resolution Steps

1. **Install Windows SDK**
   ```
   Visual Studio Installer → Modify → Individual Components →
   ☑ Windows 10 SDK (10.0.22621.0 or latest)
   ☑ MSVC v143 build tools
   ```

2. **Verify Installation**
   ```bash
   # After installation, verify SDK exists
   ls "C:/Program Files (x86)/Windows Kits/10/Lib/10.0.*/um/x64/kernel32.lib"
   ```

3. **Clean Build**
   ```bash
   cd src-tauri && rm -rf target
   npm run tauri dev
   ```

### Success Criteria
- [ ] `npm run tauri dev` launches Tauri window
- [ ] Greet button in Inspector panel works (IPC test)
- [ ] `npm test` passes all frontend tests
- [ ] `cargo test` passes all backend tests

---

## Phase 1: Project & Asset Management

### 1.1 Welcome Screen

**Component:** `src/components/features/welcome/WelcomeScreen.tsx`

**Requirements:**
- Show on app launch when no project loaded
- "New Project" button → opens creation dialog
- "Open Project" button → opens file browser
- Recent projects list (stored in localStorage or Tauri store)

**Data Flow:**
```
WelcomeScreen
  └─ onNewProject → ProjectCreationDialog
  └─ onOpenProject → invoke('open_project', path)
  └─ onSelectRecent → invoke('open_project', path)
```

**Tests:**
- `WelcomeScreen.test.tsx`: Renders buttons, handles clicks
- Integration: Creating project updates store

### 1.2 Project Creation Dialog

**Component:** `src/components/features/project/ProjectCreationDialog.tsx`

**Requirements:**
- Project name input (required)
- Location picker (Tauri file dialog)
- Format preset dropdown (1080p, 4K, Vertical, Custom)
- Create button → `invoke('create_project', { name, path, format })`

**Backend:** Already implemented in `commands.rs`

**Tests:**
- Form validation
- IPC call with correct parameters
- Error handling (invalid path, permissions)

### 1.3 Project Explorer Enhancement

**Component:** `src/components/features/explorer/ProjectExplorer.tsx`

**Current State:** Placeholder showing "No project loaded"

**Requirements:**
- Display project name and info when loaded
- Asset list with icons by type (video/audio/image)
- Import button → file picker → `invoke('import_asset', uri)`
- Drag-and-drop support for file import
- Context menu: Delete, Reveal in Explorer
- Double-click to preview asset

**Subcomponents:**
```
ProjectExplorer/
├── ProjectExplorer.tsx      # Container
├── ProjectHeader.tsx        # Project name, settings
├── AssetList.tsx           # Scrollable asset grid/list
├── AssetItem.tsx           # Single asset with thumbnail
├── ImportDropzone.tsx      # Drag-drop overlay
└── hooks/
    └── useAssetImport.ts   # Import logic hook
```

**Tests:**
- Renders empty state
- Renders asset list when project loaded
- Drag-drop triggers import
- Delete shows confirmation

### 1.4 Asset Thumbnails

**Backend Task:** Generate thumbnail for imported assets

**Implementation:**
```rust
// src-tauri/src/core/assets/thumbnail.rs
pub async fn generate_thumbnail(asset_path: &Path) -> Result<PathBuf> {
    // For video: extract frame at 1 second using FFmpeg
    // For image: resize to thumbnail size
    // For audio: generate waveform image (or use placeholder)
}
```

**Storage:** `{project_dir}/.openreelio/thumbnails/{asset_id}.jpg`

**Frontend:** Load thumbnail via Tauri asset protocol

---

## Phase 2: Timeline Core

### 2.1 Timeline Architecture

**Component Structure:**
```
src/components/features/timeline/
├── Timeline.tsx              # Main container
├── TimelineHeader.tsx        # Time ruler, zoom controls
├── TimelineBody.tsx          # Scrollable track area
├── TrackList.tsx             # Track headers sidebar
├── TrackHeader.tsx           # Single track header
├── TrackLane.tsx             # Track content area
├── Clip.tsx                  # Single clip component
├── Playhead.tsx              # Current position indicator
├── SelectionBox.tsx          # Multi-select rectangle
├── hooks/
│   ├── useTimelineZoom.ts    # Zoom level state
│   ├── useTimelineScroll.ts  # Scroll position sync
│   ├── useClipDrag.ts        # Clip drag-and-drop
│   ├── useClipResize.ts      # Clip edge trimming
│   └── usePlayhead.ts        # Playhead interaction
└── utils/
    ├── timeConversion.ts     # Pixels ↔ Time conversion
    └── snapToGrid.ts         # Snap logic
```

### 2.2 Timeline State Management

**Store:** `src/stores/timelineStore.ts` (enhance existing)

```typescript
interface TimelineUIState {
  // View state
  zoom: number;              // pixels per second
  scrollX: number;           // horizontal scroll
  scrollY: number;           // vertical scroll

  // Selection state
  selectedClipIds: Set<string>;
  selectionBox: Rect | null;

  // Interaction state
  dragState: DragState | null;
  resizeState: ResizeState | null;

  // Playhead
  playheadPosition: number;  // in seconds
  isPlaying: boolean;
}
```

### 2.3 Clip Rendering

**Requirements:**
- Video clips show thumbnail strip
- Audio clips show waveform
- Selected clips have highlight border
- Clips show name label
- Trim handles on hover

**Performance:**
- Virtualize clips outside viewport
- Lazy load thumbnails
- Debounce waveform rendering

### 2.4 Clip Operations

| Operation | Trigger | IPC Command |
|-----------|---------|-------------|
| Add clip | Drag from explorer | `execute_command(InsertClip)` |
| Move clip | Drag clip | `execute_command(MoveClip)` |
| Trim clip | Drag edge | `execute_command(TrimClip)` |
| Delete clip | Delete key | `execute_command(RemoveClip)` |
| Split clip | S key at playhead | `execute_command(SplitClip)` |

**Tests:**
- Unit: Time conversion functions
- Unit: Snap-to-grid logic
- Integration: Drag creates clip via IPC
- Integration: Undo reverts clip state

---

## Phase 3: Preview System

### 3.1 FFmpeg Integration

**Location:** `src-tauri/src/core/render/ffmpeg.rs`

**Approach:** Subprocess execution (not bindings)

```rust
pub struct FFmpegRunner {
    ffmpeg_path: PathBuf,
}

impl FFmpegRunner {
    /// Extract single frame at given time
    pub async fn extract_frame(
        &self,
        input: &Path,
        time_sec: f64,
        output: &Path,
    ) -> Result<()>;

    /// Generate proxy video (low-res for preview)
    pub async fn generate_proxy(
        &self,
        input: &Path,
        output: &Path,
    ) -> Result<()>;

    /// Export final render
    pub async fn render(
        &self,
        command: RenderCommand,
        progress_tx: Sender<RenderProgress>,
    ) -> Result<()>;
}
```

**FFmpeg Detection:**
1. Check PATH for `ffmpeg`
2. Check bundled location (future)
3. Prompt user to install if not found

### 3.2 Preview Player Component

**Component:** `src/components/features/preview/PreviewPlayer.tsx`

**Subcomponents:**
```
PreviewPlayer/
├── PreviewPlayer.tsx        # Container
├── VideoCanvas.tsx          # Frame rendering
├── PlaybackControls.tsx     # Play/pause/seek
├── TimeDisplay.tsx          # Current time / duration
├── VolumeControl.tsx        # Audio volume slider
└── hooks/
    └── usePlayback.ts       # Playback state management
```

**Playback Implementation:**
1. Request frame from backend at current time
2. Backend extracts frame via FFmpeg
3. Send frame as base64 or file path
4. Render to canvas
5. Advance time, repeat

**Optimization:**
- Pre-cache frames ahead of playhead
- Use proxy videos for smoother playback
- Drop frames if behind schedule

### 3.3 Playback Sync

**Requirements:**
- Timeline playhead syncs with preview position
- Clicking timeline seeks preview
- Dragging playhead scrubs video
- Play button starts playback from current position

**Implementation:**
```typescript
// Shared playback state
const usePlaybackStore = create<PlaybackState>((set) => ({
  isPlaying: false,
  currentTime: 0,
  duration: 0,

  play: () => { /* start frame loop */ },
  pause: () => { /* stop frame loop */ },
  seek: (time) => { /* update currentTime */ },
}));
```

---

## Phase 4: Export Pipeline

### 4.1 Export Dialog

**Component:** `src/components/features/export/ExportDialog.tsx`

**Fields:**
- Output filename and path
- Format preset (MP4 H.264, WebM VP9, MOV ProRes)
- Resolution (same as sequence, 1080p, 720p, custom)
- Quality (Low/Medium/High/Lossless)
- Audio codec and bitrate

**Presets:**
```typescript
const EXPORT_PRESETS = {
  'youtube-1080p': {
    container: 'mp4',
    videoCodec: 'libx264',
    videoBitrate: '8M',
    audioCodec: 'aac',
    audioBitrate: '192k',
    resolution: [1920, 1080],
  },
  // ... more presets
};
```

### 4.2 Render Engine

**Backend:** `src-tauri/src/core/render/engine.rs`

**Process:**
1. Validate sequence has content
2. Generate FFmpeg complex filter graph
3. Execute FFmpeg with progress parsing
4. Report progress to frontend
5. Handle completion or error

**Progress Reporting:**
```rust
pub struct RenderProgress {
    pub frame: u64,
    pub total_frames: u64,
    pub percent: f32,
    pub fps: f32,
    pub eta_seconds: u64,
}
```

### 4.3 Export Progress UI

**Component:** `src/components/features/export/ExportProgress.tsx`

**Features:**
- Progress bar with percentage
- Current frame / total frames
- Estimated time remaining
- Cancel button
- Success/error notification

---

## Phase 5: Polish & UX

### 5.1 Keyboard Shortcuts

**Implementation:** Global keyboard event listener

**Default Shortcuts:**
| Key | Action |
|-----|--------|
| Space | Play/Pause |
| S | Split at playhead |
| Delete | Delete selected |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+S | Save project |
| Ctrl+I | Import asset |
| Home | Go to start |
| End | Go to end |
| Left/Right | Frame step |
| +/- | Zoom in/out |

**Hook:** `useKeyboardShortcuts.ts`

### 5.2 Toast Notifications

**Component:** `src/components/ui/Toast.tsx`

**Usage:**
- Import success/failure
- Export complete
- Error messages
- Undo/redo confirmation

**Library:** Consider `react-hot-toast` or custom implementation

### 5.3 Error Boundaries

**Implementation:**
- Wrap feature components in error boundaries
- Show user-friendly error message
- Log error details for debugging
- Offer recovery action (reload, retry)

---

## Testing Strategy

### Unit Tests

**Frontend (Vitest):**
- Store reducers
- Utility functions
- Custom hooks
- Pure components

**Backend (cargo test):**
- Command execution
- State reconstruction
- FFmpeg command generation
- File operations

### Integration Tests

**Frontend:**
- Component + store integration
- IPC mock testing

**Backend:**
- Full command flow tests
- Project lifecycle tests

### E2E Tests (Future)

**Playwright or Cypress:**
- Full user journey tests
- Cross-platform verification

---

## Risk Mitigation

### Risk: FFmpeg Not Available
**Mitigation:**
- Check on startup, show install instructions
- Future: Bundle FFmpeg with app

### Risk: Large Video Files Slow Preview
**Mitigation:**
- Generate proxy videos automatically
- Use lower resolution for preview
- Implement frame caching

### Risk: Memory Leaks in Long Sessions
**Mitigation:**
- Proper cleanup in useEffect
- Limit undo history size
- Monitor memory in development

### Risk: Cross-Platform Inconsistencies
**Mitigation:**
- Test on Windows, macOS, Linux
- Use Tauri's cross-platform APIs
- Avoid platform-specific code

---

## Definition of Done

MVP is complete when:
- [ ] All Phase 0-4 items implemented
- [ ] Test coverage > 80%
- [ ] No critical bugs
- [ ] Documentation updated
- [ ] Successfully tested on Windows
- [ ] App can be distributed (installer works)

---

## Next Steps After MVP

1. Gather user feedback
2. Performance profiling
3. macOS/Linux testing
4. AI integration planning
5. Plugin system design
