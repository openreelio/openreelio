# OpenReelio Development Roadmap

> **Last Updated**: 2026-01-27
> **Version**: v0.1.0 → v1.0.0 Planning
> **Status**: MVP v0.1.0 at 95% completion | v0.2.0 AI Integration at 95%
> **Critical Blocker**: Code Signing + Auto-Update finalization required for v0.1.0 release

This document outlines the complete development roadmap for OpenReelio, from MVP to production-ready release.

---

## Table of Contents

1. [Milestone Overview](#milestone-overview)
2. [v0.1.0 - MVP Core Editor](#v010---mvp-core-editor)
3. [v0.2.0 - AI Integration & Smart Features](#v020---ai-integration--smart-features)
4. [v0.3.0 - Effects, Transitions & Animation](#v030---effects-transitions--animation)
5. [v0.4.0 - Plugin Ecosystem](#v040---plugin-ecosystem)
6. [v1.0.0 - Production Ready](#v100---production-ready)
7. [Technology Integration Reference](#technology-integration-reference)
8. [Risk Assessment & Mitigation](#risk-assessment--mitigation)

---

## Milestone Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        OpenReelio Development Timeline                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  v0.1.0 MVP          v0.2.0 AI           v0.3.0 Effects      v1.0.0        │
│  ───────────────────→───────────────────→────────────────────→──────────   │
│  Core Editor         Whisper + Search    Transitions         Production    │
│  + DISTRIBUTION      Meilisearch         Keyframes           Optimization  │
│  + Auto-Update       Shot Detection      Audio Effects       Cross-platform│
│  + Code Signing                                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Milestone | Focus | Key Deliverables | Status |
|-----------|-------|------------------|--------|
| **v0.1.0** | Core Editor + Distribution | Timeline, Preview, Export, Auto-Update, Code Signing | 🔄 In Progress (95%) |
| **v0.2.0** | AI Integration | Whisper, Meilisearch, AI Sidebar, Agent Framework | 🔄 In Progress (95%) |
| **v0.3.0** | Effects & Animation | Transitions, Keyframes, Audio FX | 📋 Planned |
| **v0.4.0** | Plugin Ecosystem | WASM Host, Marketplace | 📋 Planned |
| **v1.0.0** | Production | Performance, Stability, Docs | 📋 Planned |

### CRITICAL: Distribution Infrastructure (BLOCKER)

Before v0.1.0 can be released, the following must be completed:

| Component | Priority | Status |
|-----------|----------|--------|
| Auto-Update System (tauri-plugin-updater) | BLOCKER | ✅ Implemented (UpdateBanner, useUpdate hook) |
| Settings Persistence | BLOCKER | ✅ Complete (settingsStore, useSettings, backend) |
| Version Sync Script | BLOCKER | ✅ Complete (scripts/sync-version.ts + tests) |
| Windows Code Signing (Authenticode) | HIGH | ⏳ Pending (signing key script ready) |
| macOS Notarization | HIGH | ⏳ Pending |
| Update Manifest Generation | HIGH | ✅ Infrastructure ready |
| Installer Customization | MEDIUM | ⏳ Pending |
| First-Run Setup Wizard | MEDIUM | ⏳ Pending |
| Crash Reporting | MEDIUM | ⏳ Pending |

---

## v0.1.0 - MVP Core Editor

**Goal**: Functional desktop video editor with import, timeline editing, preview, and export capabilities.

### Current Progress

> **Last Updated**: 2026-01-23

| Phase | Description | Status | Completion |
|-------|-------------|--------|------------|
| Phase 0 | Build Environment | ✅ Complete | 100% |
| Phase 1 | Project & Assets | ✅ Complete | 100% |
| Phase 2 | Timeline Core | ✅ Complete | 100% |
| Phase 3 | Preview System | ✅ Complete | 100% |
| Phase 4 | Export Pipeline | ✅ Complete | 95% |
| Phase 5 | Polish & UX | ✅ Complete | 90% |

### Phase 2 Detailed Status

**Completed:**
- ✅ Single clip drag & trim (`useClipDrag` hook)
- ✅ Grid snapping for clip operations
- ✅ Selection box (drag-to-select)
- ✅ Shift+click additive selection
- ✅ Clip visual representation with waveforms
- ✅ Track mute/lock/visibility controls
- ✅ Playhead scrubbing
- ✅ Timeline zoom & scroll
- ✅ Cross-track drag (commit 219b41b)
- ✅ Multi-clip drag (commit 219b41b)
- ✅ Enhanced snapping with snap points (commit 1d4fa56)
- ✅ Caption editing in Inspector (commit 19165c8)
- ✅ Specta Type integration for IPC (commit 507588c)

**Pending:**
- ⏳ Drop validity feedback (valid/invalid drop zones)
- ⏳ Track reordering (drag track headers)

### Phase 2: Timeline Core (Current Priority: LOW - Nearly Complete)

**Remaining Tasks:**

| Task | Description | Priority | Estimated Effort |
|------|-------------|----------|------------------|
| Drop Feedback | Visual feedback for valid/invalid drop | LOW | 1 day |
| Track Reordering | Drag track headers to reorder | LOW | 1 day |

**Technical Requirements:**
- Virtual scrolling for 1000+ clips performance
- 60fps drag interaction
- Undo/redo for all operations

### Phase 3: Preview System (90% Complete)

**Completed:**
- ✅ Frame extraction via FFmpeg (`useFrameExtractor` hook)
- ✅ Playback loop with RAF-based 30fps (`usePlaybackLoop` hook)
- ✅ Audio sync with Web Audio API (`useAudioPlayback` hook)
- ✅ Timeline scrubbing (`useScrubbing` hook)
- ✅ Frame caching with LRU eviction (`FrameCache` service)
- ✅ Canvas-based composite rendering (`TimelinePreviewPlayer`)
- ✅ Fullscreen preview with PiP support

**Remaining Tasks:**

| Task | Description | Priority | Estimated Effort |
|------|-------------|----------|------------------|
| Proxy Playback | Use proxy videos for smooth preview | HIGH | 2 days |

### Phase 5: Polish & UX

**Completed:**
- ✅ Keyboard Shortcuts (useKeyboardShortcuts.ts expanded with 20+ shortcuts)
- ✅ Toast Notifications (Toast.tsx, useToast hook)
- ✅ Settings Dialog (SettingsDialog.tsx with all sections)
- ✅ Shortcuts Help Dialog (ShortcutsDialog.tsx)
- ✅ Update Banner (UpdateBanner.tsx with auto-update)
- ✅ Context Menu System (ContextMenu.tsx)
- ✅ Progress Panels (ProgressBar.tsx, ProgressPanel.tsx)
- ✅ Spinner Component (Spinner.tsx)
- ✅ Drop Validity Feedback (dropValidity.ts utilities)

**Remaining Tasks:**

| Task | Description | Priority | Estimated Effort |
|------|-------------|----------|------------------|
| Error Boundaries | Graceful error handling | MEDIUM | 1 day |
| Loading States | Skeleton loaders, progress indicators | LOW | 1 day |

### MVP Definition of Done

- [ ] All Phase 0-4 items implemented
- [ ] Test coverage > 80%
- [ ] No critical bugs
- [ ] Documentation updated
- [ ] Windows build and installer working
- [ ] Complete user flow: Import → Edit → Preview → Export

---

## v0.2.0 - AI Integration & Smart Features

**Goal**: Enable AI-powered editing with automatic transcription, smart search, and shot detection.

> **Status**: 95% Complete - Full AI chat interface, agent framework, and editing tools implemented

### Current Progress (as of 2026-01-27)

**Completed:**
- ✅ AI Provider Architecture (OpenAI, Anthropic, Local providers)
- ✅ AI Gateway with edit script executor
- ✅ AI Settings Panel (AISettingsPanel.tsx) with dialog integration
- ✅ AI Prompt Panel (AIPromptPanel.tsx)
- ✅ AI Store (aiStore.ts with full state management + cancel generation)
- ✅ Meilisearch Sidecar Setup (sidecar.rs)
- ✅ Meilisearch Search Service (service.rs)
- ✅ Search UI Components (SearchBar, SearchPanel, SearchFilters, GroupedSearchResults)
- ✅ useSearch Hook (with debouncing, filters, facets)
- ✅ Caption Editor (CaptionEditor.tsx with full editing)
- ✅ Transcription Dialog (TranscriptionDialog.tsx)
- ✅ Asset Context Menu with transcription trigger
- ✅ useCaption Hook (CRUD operations)
- ✅ useTranscriptionWithIndexing Hook
- ✅ First-Run Setup Wizard (SetupWizard.tsx)
- ✅ **AI Sidebar** (AISidebar.tsx) - Collapsible chat interface with resize support
- ✅ **Chat History** (ChatHistory.tsx) - Message display with auto-scroll
- ✅ **Chat Input** (ChatInput.tsx) - Auto-resize input with stop generation
- ✅ **Context Panel** (ContextPanel.tsx) - Shows current editing context
- ✅ **Quick Actions Bar** (QuickActionsBar.tsx) - Common AI actions
- ✅ **Proposal Card** (ProposalCard.tsx) - AI edit proposal display
- ✅ **Chat Storage** (chatStorage.ts) - Persistent chat history per project
- ✅ **Agent Framework** (src/agents/)
  - ✅ Agent base class with event emitter and tool execution
  - ✅ ToolRegistry for registering and executing tools
  - ✅ ContextBuilder for building agent context
  - ✅ VideoEditingAgent for AI-powered video editing
  - ✅ MockAgent for testing
- ✅ **Editing Tools** (src/agents/tools/editingTools.ts)
  - ✅ move_clip, trim_clip, split_clip, delete_clip, insert_clip
  - ✅ Full IPC integration with validation
- ✅ **Error Boundaries** (AIErrorBoundary for graceful error handling)

**Pending:**
- ⏳ whisper.cpp (whisper-rs) integration for offline transcription
- ⏳ Shot detection with candle ML
- ⏳ Caption export to SRT/VTT formats

### Core Features

#### 1. Auto-Captioning with whisper.cpp

**Integration Plan:**
```rust
// Cargo.toml addition
whisper-rs = "0.13"  // Rust bindings for whisper.cpp

// src-tauri/src/core/indexing/transcripts.rs
use whisper_rs::{WhisperContext, WhisperContextParameters, FullParams, SamplingStrategy};

pub struct TranscriptionEngine {
    context: WhisperContext,
    model_path: PathBuf,
}

impl TranscriptionEngine {
    pub async fn transcribe(&self, audio_path: &Path) -> Result<Vec<Caption>, CoreError> {
        // 1. Extract audio to WAV (16kHz mono)
        // 2. Run whisper inference
        // 3. Convert segments to Caption structs
        // 4. Return with timestamps
    }
}
```

**Model Options:**
| Model | Size | Speed | Accuracy | Recommended For |
|-------|------|-------|----------|-----------------|
| tiny | 75MB | Very Fast | Good | Quick drafts |
| base | 142MB | Fast | Better | Default choice |
| small | 466MB | Medium | Great | Professional use |
| medium | 1.5GB | Slow | Excellent | Final transcripts |

**User Experience:**
- One-click captioning from asset context menu
- Real-time progress with word count
- Edit captions in Inspector panel
- Export to SRT/VTT

#### 2. Smart Asset Search with Meilisearch

**Integration Architecture:**
```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend (React)                                                │
│   └─ SearchBar Component                                        │
│         ↓ IPC: search_assets(query)                             │
├─────────────────────────────────────────────────────────────────┤
│ Rust Core (search/engine.rs)                                    │
│   └─ SearchEngine                                               │
│         ↓ HTTP API                                              │
├─────────────────────────────────────────────────────────────────┤
│ Meilisearch (Sidecar Process)                                   │
│   ├─ Index: assets (name, path, metadata, tags)                 │
│   ├─ Index: transcripts (text, asset_id, timestamps)            │
│   └─ Index: clips (sequence_id, track, in/out points)           │
└─────────────────────────────────────────────────────────────────┘
```

**Cargo.toml Addition:**
```toml
meilisearch-sdk = "0.27"
```

**Search Features:**
- Typo-tolerant search ("brithday" → "birthday")
- Faceted filtering (by type, date, duration)
- Transcript search ("find where I say hello")
- Ranking by relevance and recency

**Deployment Strategy:**
1. Bundle Meilisearch binary (~50MB) as Tauri sidecar
2. Start on app launch, stop on exit
3. Data stored in `{project}/.openreelio/search/`

#### 3. Shot Detection with candle

**Integration Plan:**
```rust
// Cargo.toml addition
candle-core = "0.8"
candle-nn = "0.8"
candle-transformers = "0.8"

// src-tauri/src/core/indexing/shots.rs
pub struct ShotDetector {
    model: SceneDetectionModel,
}

impl ShotDetector {
    pub async fn detect_shots(&self, video_path: &Path) -> Result<Vec<Shot>, CoreError> {
        // 1. Sample frames at intervals (e.g., 1fps)
        // 2. Extract features with CNN
        // 3. Detect scene boundaries
        // 4. Return shot list with timestamps
    }
}
```

**Output:**
```rust
pub struct Shot {
    pub id: String,
    pub start_time: f64,
    pub end_time: f64,
    pub thumbnail: PathBuf,
    pub confidence: f32,
    pub scene_type: SceneType,  // Action, Dialogue, Transition, etc.
}
```

### v0.2.0 Task Breakdown

| Task | Dependencies | Priority | Status |
|------|--------------|----------|--------|
| whisper-rs integration | None | HIGH | ⏳ Pending |
| Caption UI (edit, export) | whisper-rs | HIGH | ✅ Complete |
| Meilisearch sidecar setup | None | HIGH | ✅ Complete |
| Asset indexing pipeline | Meilisearch | HIGH | ✅ Complete |
| Search UI component | Asset indexing | MEDIUM | ✅ Complete |
| Transcript search | whisper-rs, Meilisearch | MEDIUM | ✅ Infrastructure Ready |
| candle setup | None | MEDIUM | ⏳ Pending |
| Shot detection impl | candle | MEDIUM | ⏳ Pending |
| Shot UI (markers, navigation) | Shot detection | LOW | ⏳ Pending |
| Caption export SRT/VTT | Caption UI | LOW | ⏳ Pending |

### v0.2.0 Definition of Done

- [ ] One-click captioning for video assets (UI ready, whisper-rs pending)
- [x] Caption editing UI (CaptionEditor.tsx complete)
- [ ] Caption export (SRT/VTT formats) - pending
- [x] Full-text search across all assets (SearchPanel, Meilisearch)
- [x] Transcript-based search ("find 'hello'") - infrastructure ready
- [ ] Automatic shot detection with markers (candle pending)
- [x] AI prompt panel with EditScript execution (AIPromptPanel.tsx)

---

## v0.3.0 - Effects, Transitions & Animation

**Goal**: Professional-grade video effects, transitions, and keyframe animation system.

### Core Features

#### 1. Video Effects Pipeline

**Already Implemented (filter_builder.rs):**
- Brightness, Contrast, Saturation
- Blur, Sharpen
- Color grading (RGB curves)
- Crop, Rotate, Scale

**To Add:**
| Effect Category | Effects | Priority |
|-----------------|---------|----------|
| Color | LUT support, Color wheels | HIGH |
| Stylize | Film grain, Vignette, Glow | MEDIUM |
| Distort | Lens correction, Stabilization | MEDIUM |
| Generate | Solid color, Gradient, Noise | LOW |

#### 2. Transition System

**Implementation:**
```rust
pub struct Transition {
    pub id: String,
    pub transition_type: TransitionType,
    pub duration: f64,
    pub easing: EasingFunction,
    pub params: HashMap<String, ParameterValue>,
}

pub enum TransitionType {
    CrossDissolve,
    Fade { to_color: Color },
    Wipe { direction: WipeDirection, softness: f32 },
    Slide { direction: SlideDirection },
    Zoom { center: Point, direction: ZoomDirection },
    Custom { filter_graph: String },
}
```

**FFmpeg Filter Generation:**
```rust
impl Transition {
    pub fn to_filter_graph(&self, clip_a: &Clip, clip_b: &Clip) -> String {
        match &self.transition_type {
            TransitionType::CrossDissolve => {
                format!("[{}][{}]xfade=transition=fade:duration={}",
                    clip_a.id, clip_b.id, self.duration)
            }
            // ... other transitions
        }
    }
}
```

#### 3. Keyframe Animation

**Data Model:**
```rust
pub struct Keyframe {
    pub time: f64,
    pub value: ParameterValue,
    pub easing: EasingFunction,
}

pub struct AnimatedParameter {
    pub parameter_id: String,
    pub keyframes: Vec<Keyframe>,
}

pub enum EasingFunction {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    Bezier { control_points: [f32; 4] },
}
```

**UI Components:**
- Keyframe editor in Inspector
- Curve editor for Bezier easing
- Copy/paste keyframes
- Timeline keyframe visualization

#### 4. Audio Effects

| Effect | Description | Priority |
|--------|-------------|----------|
| Volume | Gain control with keyframes | HIGH |
| Fade In/Out | Audio fade transitions | HIGH |
| EQ | Basic equalization | MEDIUM |
| Compressor | Dynamic range compression | MEDIUM |
| Noise Reduction | Basic noise gate | LOW |

### v0.3.0 Task Breakdown

| Task | Priority | Effort |
|------|----------|--------|
| Transition data model | HIGH | 2 days |
| Transition FFmpeg generation | HIGH | 1 week |
| Transition UI (drag between clips) | HIGH | 3 days |
| Keyframe data model | HIGH | 2 days |
| Keyframe interpolation | HIGH | 3 days |
| Keyframe UI (Inspector) | HIGH | 1 week |
| Curve editor component | MEDIUM | 1 week |
| LUT support | MEDIUM | 3 days |
| Audio effects pipeline | MEDIUM | 1 week |

### v0.3.0 Definition of Done

- [ ] 10+ built-in transitions
- [ ] Custom transition support
- [ ] Keyframe animation for all effect parameters
- [ ] Bezier curve editor
- [ ] Audio fade in/out
- [ ] Basic audio effects (volume, EQ)

---

## v0.4.0 - Plugin Ecosystem

**Goal**: Extensible platform with WASM plugin support and community ecosystem.

### Core Features

#### 1. WASM Plugin Host (Already Implemented)

**Current State:**
- Wasmtime 27 integration
- Permission system (FS, Network, Models, Project)
- Plugin manifest parsing
- Sandbox isolation

**To Complete:**
| Task | Priority | Effort |
|------|----------|--------|
| Plugin API stabilization | HIGH | 1 week |
| Plugin SDK (Rust template) | HIGH | 1 week |
| Plugin SDK (AssemblyScript) | MEDIUM | 1 week |
| Hot reload support | MEDIUM | 3 days |
| Plugin settings UI | MEDIUM | 3 days |

#### 2. Built-in Plugins

**Asset Providers (Partially Implemented):**
- Stock media (Unsplash, Pexels)
- Audio library integration
- Meme pack provider

**To Add:**
- Freesound.org integration
- Google Fonts for text effects
- Giphy integration

#### 3. Effect Plugins

**Plugin Interface:**
```rust
pub trait EffectPlugin {
    fn manifest(&self) -> EffectManifest;
    fn parameters(&self) -> Vec<ParameterDefinition>;
    fn process_frame(&self, input: &Frame, params: &ParameterValues) -> Frame;
}
```

#### 4. Export Plugins

**Plugin Interface:**
```rust
pub trait ExportPlugin {
    fn manifest(&self) -> ExportManifest;
    fn formats(&self) -> Vec<ExportFormat>;
    fn export(&self, sequence: &Sequence, config: &ExportConfig) -> Result<PathBuf>;
}
```

**Example Plugins:**
- YouTube preset optimizer
- Instagram Reels formatter
- GIF exporter
- Lottie animation exporter

### v0.4.0 Definition of Done

- [ ] Stable plugin API (v1.0)
- [ ] Plugin SDK with documentation
- [ ] 5+ built-in plugins
- [ ] Plugin settings in UI
- [ ] Plugin marketplace foundation

---

## v1.0.0 - Production Ready

**Goal**: Stable, performant, cross-platform release.

### Focus Areas

#### 1. Performance Optimization

| Area | Target | Current |
|------|--------|---------|
| Startup time | < 2s | TBD |
| Timeline scroll | 60fps | TBD |
| Preview latency | < 100ms | TBD |
| Export speed | Real-time+ | TBD |
| Memory usage | < 500MB base | TBD |

**Optimization Tasks:**
- Profile and optimize hot paths
- Implement frame caching strategy
- GPU acceleration validation
- Memory leak detection and fixes

#### 2. Stability

- Crash reporting integration
- Automatic recovery from failures
- Project backup and versioning
- Comprehensive error handling

#### 3. Cross-Platform

| Platform | Priority | Status |
|----------|----------|--------|
| Windows 10/11 | HIGH | Primary target |
| macOS (Intel) | HIGH | Planned |
| macOS (Apple Silicon) | HIGH | Planned |
| Linux (Ubuntu) | MEDIUM | Planned |

#### 4. Documentation

- User guide (Getting Started)
- Video tutorials
- API documentation
- Plugin development guide
- Contributing guide

### v1.0.0 Definition of Done

- [ ] No critical/high severity bugs
- [ ] Performance targets met
- [ ] Windows, macOS installers
- [ ] Complete user documentation
- [ ] Plugin SDK documentation
- [ ] 90%+ test coverage

---

## Technology Integration Reference

### Adopted Technologies

| Technology | Purpose | Integration Point | Version |
|------------|---------|-------------------|---------|
| **whisper.cpp** | Speech-to-text | `core/indexing/transcripts.rs` | via whisper-rs 0.13 |
| **Meilisearch** | Full-text search | Tauri sidecar + `core/search/` | 1.6+ |
| **candle** | ML inference | `core/indexing/shots.rs` | 0.8 |
| **FFmpeg** | Video processing | `core/ffmpeg/` | 6.0+ |
| **Wasmtime** | Plugin runtime | `core/plugin/host.rs` | 27 |

### Evaluated but Not Adopted

| Technology | Reason for Rejection |
|------------|----------------------|
| **MLT Framework** | C/C++ integration complexity; FFmpeg direct control preferred |
| **Vis.js Timeline** | Not specialized for video editing; missing trim/layer features |
| **React-Timeline-9000** | Already have custom implementation; would require migration |

### Reference Projects (For Inspiration Only)

| Project | Reference Use |
|---------|--------------|
| **Editly** | JSON-based edit definition structure for EditScript design |

---

## Risk Assessment & Mitigation

### Technical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| FFmpeg compatibility issues | HIGH | MEDIUM | Bundle specific version; extensive testing |
| Whisper model size | MEDIUM | LOW | Offer model selection; lazy download |
| Meilisearch memory usage | MEDIUM | LOW | Configure limits; monitor usage |
| WASM plugin security | HIGH | LOW | Strict permission system; sandboxing |
| Cross-platform differences | MEDIUM | MEDIUM | CI/CD on all platforms; abstraction layers |

### Resource Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Large video file handling | HIGH | HIGH | Proxy generation; streaming architecture |
| Memory exhaustion | HIGH | MEDIUM | Memory monitoring; cache eviction; limits |
| CPU overload during render | MEDIUM | LOW | Worker pool; background processing |

### Dependency Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Tauri breaking changes | HIGH | LOW | Pin versions; follow upgrade guides |
| Rust ecosystem changes | MEDIUM | LOW | Lock Cargo.lock; conservative updates |
| AI model licensing | MEDIUM | LOW | Use permissive models (MIT/Apache) |

---

## Appendix: File Structure After All Milestones

```
src-tauri/src/core/
├── ai/
│   ├── gateway.rs          # LLM API integration
│   ├── edit_script.rs      # AI command output
│   ├── proposal.rs         # User approval flow
│   └── provider.rs         # OpenAI/Anthropic/Local
├── assets/
│   ├── models.rs           # Asset data types
│   ├── metadata.rs         # FFprobe extraction
│   └── thumbnail.rs        # Poster frame generation
├── captions/
│   ├── models.rs           # Caption data types
│   ├── formats.rs          # SRT/VTT parsers
│   └── whisper.rs          # ✨ NEW: whisper-rs integration
├── commands/               # Event sourcing commands
├── effects/
│   ├── models.rs           # Effect definitions
│   ├── filter_builder.rs   # FFmpeg filter generation
│   ├── transitions.rs      # ✨ NEW: Transition types
│   └── keyframes.rs        # ✨ NEW: Keyframe interpolation
├── ffmpeg/                 # FFmpeg subprocess control
├── generative/             # AI content generation
├── indexing/
│   ├── db.rs               # SQLite operations
│   ├── shots.rs            # Scene detection
│   ├── transcripts.rs      # Speech recognition
│   └── search.rs           # ✨ NEW: Meilisearch client
├── jobs/                   # Background worker pool
├── performance/            # GPU, memory, parallelism
├── plugin/                 # WASM plugin host
├── project/                # Project state, ops log
├── qc/                     # Quality check rules
├── render/                 # Export pipeline
├── search/                 # ✨ NEW: Smart search engine
├── template/               # Template system
└── timeline/               # Timeline logic
```

---

*This roadmap is a living document. Updates will be made as development progresses and priorities shift.*
