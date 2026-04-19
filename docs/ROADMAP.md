# OpenReelio Development Roadmap

> **Last Updated**: 2026-02-03
> **Version**: v0.1.0 → v1.0.0 Planning
> **Status**: MVP v0.1.0 mostly implemented | v0.2.0 AI partially shipped | v0.3.0 Effects partially shipped | **v0.5.0 PRO foundations in progress** | **v0.6.0 ADV prototypes in progress** | **v0.7.0 VFX exploratory**
> **Strategic Goal**: Professional-grade NLE matching DaVinci Resolve / Premiere Pro standards
> **Gap Analysis**: See [GAP_ANALYSIS.md](./GAP_ANALYSIS.md) for detailed feature comparison

This document outlines the complete development roadmap for OpenReelio, from MVP to professional-grade production-ready release.

---

## Table of Contents

1. [Milestone Overview](#milestone-overview)
2. [v0.1.0 - MVP Core Editor](#v010---mvp-core-editor)
3. [v0.2.0 - AI Integration & Smart Features](#v020---ai-integration--smart-features)
4. [v0.3.0 - Effects, Transitions & Animation](#v030---effects-transitions--animation)
5. [v0.4.0 - Plugin Ecosystem](#v040---plugin-ecosystem)
6. [**v0.5.0 - Professional Foundation** (NEW)](#v050---professional-foundation)
7. [**v0.6.0 - Advanced Editing** (NEW)](#v060---advanced-editing)
8. [**v0.7.0 - Color & VFX** (NEW)](#v070---color--vfx)
9. [v1.0.0 - Production Ready](#v100---production-ready)
10. [Technology Integration Reference](#technology-integration-reference)
11. [Risk Assessment & Mitigation](#risk-assessment--mitigation)

---

## Milestone Overview

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                        OpenReelio Development Timeline (Revised)                       │
├───────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│  v0.1-0.3         v0.4.0           v0.5.0           v0.6.0         v0.7.0    v1.0.0  │
│  ─────────────→──────────────→──────────────→──────────────→──────────────→────────  │
│  Core + AI       Plugins         PRO FOUNDATION   ADV EDITING    COLOR/VFX   PROD    │
│  + Effects                       ├─ Titles        ├─ Multicam    ├─ Scopes          │
│                                  ├─ Color Wheels  ├─ Keying      ├─ Qualifiers      │
│                                  ├─ Audio Mixer   ├─ Tracking    ├─ HDR             │
│                                  └─ Bins/Folders  └─ Noise Red.  └─ Motion GFX      │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

| Milestone  | Focus                       | Key Deliverables                            | Status                       |
| ---------- | --------------------------- | ------------------------------------------- | ---------------------------- |
| **v0.1.0** | Core Editor                 | Timeline, Preview, Export                   | 🚧 Stabilization needed      |
| **v0.2.0** | AI Integration              | Whisper, Meilisearch, AI Sidebar            | 🚧 Partial / feature-flagged |
| **v0.3.0** | Effects & Animation         | Transitions, Keyframes, Audio FX            | 🚧 Partial                   |
| **v0.4.0** | Plugin Ecosystem            | WASM Host, Marketplace                      | 📋 Planned (60%)             |
| **v0.5.0** | **Professional Foundation** | Titles, Color Wheels, Scopes, Audio Mixer   | 🚧 In progress               |
| **v0.6.0** | **Advanced Editing**        | Multicam, Keying, Tracking, Noise Reduction | 🚧 Prototype stage           |
| **v0.7.0** | **Color & VFX**             | Qualifiers, HDR, Advanced Motion Graphics   | 📋 Early exploration         |
| **v1.0.0** | Production                  | Performance, Stability, Cross-platform      | 📋 Planned                   |

### Critical Gap Summary (Updated 2026-02-03)

| Category          | Current | Industry Standard            | Gap                                                        |
| ----------------- | ------- | ---------------------------- | ---------------------------------------------------------- |
| Color Grading     | **85%** | Professional tools (Resolve) | ⚠️ Core panels exist, product integration incomplete       |
| Audio Post        | **80%** | DAW-level (Fairlight)        | ⚠️ Mixer UI exists, playback/render integration incomplete |
| Titles/Motion GFX | **90%** | Full title system            | ⚠️ Core text workflow exists, still needs hardening        |
| Compositing/VFX   | **70%** | Keying, Tracking             | ⚠️ Controls exist, render/export support is incomplete     |
| Multicam          | **80%** | Full multicam workflow       | ⚠️ Viewer/hooks exist, end-to-end workflow incomplete      |

### Distribution Infrastructure Status

| Component                                 | Priority | Status                                            |
| ----------------------------------------- | -------- | ------------------------------------------------- |
| Auto-Update System (tauri-plugin-updater) | HIGH     | ✅ Complete (UpdateBanner, useUpdate hook)        |
| Settings Persistence                      | HIGH     | ✅ Complete (settingsStore, useSettings, backend) |
| Version Sync Script                       | HIGH     | ✅ Complete (scripts/sync-version.ts + tests)     |
| Update Manifest Generation                | HIGH     | ✅ Complete                                       |
| First-Run Setup Wizard                    | HIGH     | ✅ Complete (SetupWizard.tsx)                     |
| Windows Code Signing (Authenticode)       | OPTIONAL | ⏳ Deferred (users can bypass SmartScreen)        |
| macOS Notarization                        | OPTIONAL | ⏳ Deferred (users can bypass Gatekeeper)         |
| Installer Customization                   | LOW      | ⏳ Pending                                        |
| Crash Reporting                           | LOW      | ⏳ Pending                                        |

> **Note**: Code signing is OPTIONAL for open source projects. Users can bypass OS warnings.

---

## v0.1.0 - MVP Core Editor

**Goal**: Functional desktop video editor with import, timeline editing, preview, and export capabilities.

### Current Progress

> **Last Updated**: 2026-01-23

| Phase   | Description       | Status      | Completion |
| ------- | ----------------- | ----------- | ---------- |
| Phase 0 | Build Environment | ✅ Complete | 100%       |
| Phase 1 | Project & Assets  | ✅ Complete | 100%       |
| Phase 2 | Timeline Core     | ✅ Complete | 100%       |
| Phase 3 | Preview System    | ✅ Complete | 100%       |
| Phase 4 | Export Pipeline   | ✅ Complete | 95%        |
| Phase 5 | Polish & UX       | ✅ Complete | 90%        |

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

- ✅ Drop validity feedback - COMPLETE (DragPreviewLayer with isValidDrop)
- ⏳ Track reordering (drag track headers)

### Phase 2: Timeline Core (Current Priority: LOW - Nearly Complete)

**Remaining Tasks:**

| Task             | Description                            | Priority | Status      |
| ---------------- | -------------------------------------- | -------- | ----------- |
| Drop Feedback    | Visual feedback for valid/invalid drop | LOW      | ✅ Complete |
| Track Reordering | Drag track headers to reorder          | LOW      | ⏳ Pending  |

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

| Task           | Description                         | Priority | Status                           |
| -------------- | ----------------------------------- | -------- | -------------------------------- |
| Proxy Playback | Use proxy videos for smooth preview | HIGH     | ✅ Complete (ProxyPreviewPlayer) |

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

| Task             | Description                           | Priority | Status                                              |
| ---------------- | ------------------------------------- | -------- | --------------------------------------------------- |
| Error Boundaries | Graceful error handling               | MEDIUM   | ✅ Complete (ErrorBoundary + withErrorBoundary HOC) |
| Loading States   | Skeleton loaders, progress indicators | LOW      | ✅ Complete (10+ skeleton variants + Spinner)       |

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

> **Status**: 98% capability surface complete, canonical runtime enforcement in progress
>
> **⚙️ CANONICAL RUNTIME ENFORCEMENT**: The shipping AI sidebar now uses the TPAO `AgenticEngine` only. The legacy `chat_with_ai` path and the streaming `AgentLoop` runtime remain retained compatibility/internal surfaces while verification and cleanup continue. See [AGENT_IMPLEMENTATION_MASTER_PLAN.md](./AGENT_IMPLEMENTATION_MASTER_PLAN.md) for the current plan.

### Current Progress (as of 2026-01-27)

**Completed:**

- ✅ AI Provider Architecture (OpenAI, Anthropic, Local providers)
- ✅ AI Gateway with edit script executor
- ✅ AI Settings Panel (AISettingsPanel.tsx) with dialog integration
- ✅ Legacy AI Prompt Path (`aiStore` + `chat_with_ai`) retained for internal compatibility
- ✅ AI Store (provider sync, proposals, and legacy/internal compatibility state)
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
- ✅ **AI Sidebar** (AISidebar.tsx) - Shipping container for the canonical agent runtime
- ✅ **Agent Sidebar Integration** (AgenticSidebarContent.tsx) - Runtime selection, recovery UI, and prompt-context loading
- ✅ **Agentic Chat Surface** (AgenticChat.tsx) - Main plan-driven chat interface
- ✅ **Recovery Surfaces** (`AgentSessionRecoveryPanel`, `AgentSessionResumeHistoryPanel`, `AgentSessionRecoveryStatus`) - Persisted session recovery visibility
- ✅ **Proposal Card** (ProposalCard.tsx) - AI edit proposal display
- ✅ **Chat Storage** (chatStorage.ts) - Legacy/internal chat history persistence per project
- ✅ **Agent Tool Surface** (src/agents/, src/agents/tools/)
  - ✅ ToolRegistry-backed tool registration and execution
  - ✅ ContextBuilder for building agent context
  - ✅ Meta-tool consolidation and workspace tool surfaces
  - ✅ BackendToolExecutor for atomic backend-safe editing commands
- ✅ **TPAO Runtime** (src/agents/engine/)
  - ✅ AgenticEngine orchestrator with iteration control
  - ✅ Thinker phase (intent analysis via LLM)
  - ✅ Planner phase (step generation with risk assessment)
  - ✅ Executor phase (tool execution with checkpoints)
  - ✅ Observer phase (result evaluation and iteration)
  - ✅ Port/Adapter architecture (ILLMClient, IToolExecutor)
  - ✅ TauriLLMAdapter (bridges to backend providers)
  - ✅ ToolRegistryAdapter (bridges to existing tools)
  - ✅ Feature flag controlled (USE_AGENTIC_ENGINE)
- ✅ **Compatibility Runtime** (src/agents/engine/AgentLoop.ts)
  - ✅ Streaming-first loop with iterative tool execution
  - ✅ Doom-loop detection, compaction, and permission gating
  - ✅ Internal compatibility flag (USE_AGENT_LOOP)
- ✅ **Session / Recovery / Permission Substrate**
  - ✅ Agent session backend and persistence store
  - ✅ Permission audit persistence and replay
  - ✅ Resume checkpoint and compaction artifact persistence
- ✅ **Agent UI Components** (src/components/features/agent/)
  - ✅ AgenticChat - Main chat interface with loop integration
  - ✅ AgentLoopChat - Compatibility-only chat interface for internal verification
  - ✅ ThinkingIndicator - Shows AI thinking process
  - ✅ PlanViewer - Displays plans with approval controls
  - ✅ ActionFeed - Real-time action progress
  - ✅ AgenticSidebarContent - Integration wrapper
- ✅ **React Hooks** (src/hooks/)
  - ✅ useAgenticLoop - Main hook for engine orchestration
  - ✅ useAgentLoop - Main hook for the compatibility runtime
  - ✅ useAgentApproval - Human-in-the-loop approval
  - ✅ useAgentStreaming - Token streaming support
  - ✅ useAgentWorkflow - Workflow state management
- ✅ **Editing Tools** (src/agents/tools/editingTools.ts)
  - ✅ move_clip, trim_clip, split_clip, delete_clip, insert_clip
  - ✅ Full IPC integration with validation
- ✅ **Error Boundaries** (AIErrorBoundary for graceful error handling)

**Pending:**

- ✅ whisper.cpp (whisper-rs) integration for offline transcription
- ⏳ Shot detection with candle ML
- ✅ Caption export to SRT/VTT formats

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

| Task                          | Dependencies            | Priority | Status                  |
| ----------------------------- | ----------------------- | -------- | ----------------------- |
| whisper-rs integration        | None                    | HIGH     | ✅ Complete             |
| Caption UI (edit, export)     | whisper-rs              | HIGH     | ✅ Complete             |
| Meilisearch sidecar setup     | None                    | HIGH     | ✅ Complete             |
| Asset indexing pipeline       | Meilisearch             | HIGH     | ✅ Complete             |
| Search UI component           | Asset indexing          | MEDIUM   | ✅ Complete             |
| Transcript search             | whisper-rs, Meilisearch | MEDIUM   | ✅ Infrastructure Ready |
| candle setup                  | None                    | MEDIUM   | ⏳ Pending              |
| Shot detection impl           | candle                  | MEDIUM   | ⏳ Pending              |
| Shot UI (markers, navigation) | Shot detection          | LOW      | ⏳ Pending              |
| Caption export SRT/VTT        | Caption UI              | LOW      | ✅ Complete             |

### v0.2.0 Definition of Done

- [x] One-click captioning for video assets (whisper-rs complete)
- [x] Caption editing UI (CaptionEditor.tsx complete)
- [x] Caption export (SRT/VTT formats) - complete
- [x] Full-text search across all assets (SearchPanel, Meilisearch)
- [x] Transcript-based search ("find 'hello'") - infrastructure ready
- [ ] Automatic shot detection with markers (candle pending)
- [x] Canonical AI sidebar runtime with plan-driven editing (`AISidebar.tsx` + `AgenticEngine`)

---

## v0.3.0 - Effects, Transitions & Animation

**Goal**: Professional-grade video effects, transitions, and keyframe animation system.

> **Status**: 90% Complete (as of 2026-01-30)
> **Current Focus**: Export integration complete, UI fully implemented

### Current Progress

| Component                           | Status      | Tests     |
| ----------------------------------- | ----------- | --------- |
| FFmpeg Transition Filters           | ✅ Complete | 38 tests  |
| Effect Commands (Add/Remove/Update) | ✅ Complete | 19 tests  |
| IPC Integration                     | ✅ Complete | -         |
| Frontend Types                      | ✅ Complete | -         |
| EffectsBrowser UI                   | ✅ Complete | 28 tests  |
| TransitionPicker UI                 | ✅ Complete | 28 tests  |
| EffectInspector UI                  | ✅ Complete | 21 tests  |
| TransitionZone Component            | ✅ Complete | 30 tests  |
| useTransitionZones Hook             | ✅ Complete | 12 tests  |
| Timeline Integration                | ✅ Complete | 5 tests   |
| Keyframe Interpolation              | ✅ Complete | 28 tests  |
| useKeyframeAnimation Hook           | ✅ Complete | 11 tests  |
| KeyframeEditor UI                   | ✅ Complete | 20+ tests |
| Audio Effects Factory               | ✅ Complete | 36 tests  |
| CurveEditor Component               | ✅ Complete | 19 tests  |

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

**✅ Implemented (filter_builder.rs):**

```rust
// build_cross_dissolve_filter() - xfade=transition=dissolve
// build_wipe_filter() - xfade with wipeleft/wiperight/wipeup/wipedown
// build_slide_filter() - xfade with slideleft/slideright/slideup/slidedown
// build_zoom_filter() - zoompan filter with configurable center and zoom factor
```

**✅ Effect Commands (effect.rs):**

```rust
pub struct AddEffectCommand { ... }     // Add effect to clip
pub struct RemoveEffectCommand { ... }  // Remove effect with undo support
pub struct UpdateEffectCommand { ... }  // Update effect parameters
```

**✅ UI Components:**

- `EffectsBrowser` - 45+ effects across 8 categories with search
- `TransitionPicker` - Duration, direction, zoom type configuration
- `EffectInspector` - Parameter editing with reset/delete actions
- `TransitionZone` - Visual zone between clips for transition placement
- `useTransitionZones` - Hook to calculate adjacent clip pairs

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

| Effect          | Description                 | Priority |
| --------------- | --------------------------- | -------- |
| Volume          | Gain control with keyframes | HIGH     |
| Fade In/Out     | Audio fade transitions      | HIGH     |
| EQ              | Basic equalization          | MEDIUM   |
| Compressor      | Dynamic range compression   | MEDIUM   |
| Noise Reduction | Basic noise gate            | LOW      |

### v0.3.0 Task Breakdown

| Task                                | Priority | Status      | Effort |
| ----------------------------------- | -------- | ----------- | ------ |
| Transition data model               | HIGH     | ✅ Complete | 2 days |
| Transition FFmpeg generation        | HIGH     | ✅ Complete | 1 week |
| Effect Commands (Add/Remove/Update) | HIGH     | ✅ Complete | 2 days |
| EffectsBrowser UI                   | HIGH     | ✅ Complete | 1 day  |
| TransitionPicker UI                 | HIGH     | ✅ Complete | 1 day  |
| EffectInspector UI                  | HIGH     | ✅ Complete | 1 day  |
| Transition UI (TransitionZone)      | HIGH     | ✅ Complete | -      |
| Keyframe data model                 | HIGH     | ✅ Complete | -      |
| Keyframe interpolation              | HIGH     | ✅ Complete | -      |
| Keyframe UI (KeyframeEditor)        | HIGH     | ✅ Complete | -      |
| Curve editor component              | MEDIUM   | ✅ Complete | -      |
| LUT support                         | MEDIUM   | ✅ Complete | -      |
| Audio effects pipeline              | MEDIUM   | ✅ Complete | -      |

### v0.3.0 Definition of Done

- [x] 5+ built-in transitions (CrossDissolve, Fade, Wipe, Slide, Zoom)
- [x] 10+ built-in transitions (45+ effects total in EffectsBrowser)
- [ ] Custom transition support
- [x] Effect Commands with undo/redo
- [x] Effects Browser UI
- [x] Transition Picker UI
- [x] Effect Inspector UI
- [x] Keyframe animation (KeyframeEditor, interpolation, export integration)
- [x] Bezier curve editor (CurveEditor with presets)
- [x] Audio effects (AudioEffectFactory: gain, EQ, compressor, delay, panner)
- [ ] Audio preview with effects chain (useAudioPlaybackWithEffects exists, integration pending)

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

## v0.5.0 - Professional Foundation

> **Goal**: Add critical missing features that block professional video editing workflows
> **Strategic Importance**: CRITICAL - Without these, OpenReelio cannot compete with even basic professional tools
> **Reference**: [GAP_ANALYSIS.md](./GAP_ANALYSIS.md)

### Priority 1: Text & Title System

**The Problem**: OpenReelio has NO text/title capability. Users cannot add any text to their videos.

**Industry Reference**: Every NLE from iMovie to DaVinci Resolve includes title generation.

| Feature             | Priority | FFmpeg Filter | Notes                       |
| ------------------- | -------- | ------------- | --------------------------- |
| Basic text clip     | CRITICAL | `drawtext`    | Font, size, color, position |
| Text styling        | HIGH     | `drawtext`    | Shadow, outline, background |
| Lower thirds preset | HIGH     | Template      | Common broadcast element    |
| Text animation      | MEDIUM   | Keyframes     | Fade in/out, position       |
| Text-on-path        | LOW      | Complex       | Curved text                 |

**Data Model:**

```typescript
interface TextClip extends Clip {
  kind: 'text';
  text: {
    content: string;
    font: string;
    fontSize: number;
    color: string;
    backgroundColor?: string;
    position: { x: number; y: number };
    alignment: 'left' | 'center' | 'right';
    shadow?: { color: string; offsetX: number; offsetY: number; blur: number };
    outline?: { color: string; width: number };
  };
}
```

**FFmpeg Implementation:**

```bash
# Basic text
-vf "drawtext=fontfile=/path/font.ttf:text='Hello':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2"

# With shadow
-vf "drawtext=fontfile=font.ttf:text='Hello':fontsize=48:fontcolor=white:shadowcolor=black:shadowx=2:shadowy=2"
```

### Priority 2: Color Grading System

**The Problem**: OpenReelio has only basic brightness/contrast. Professional colorists need Color Wheels and Scopes.

**Industry Reference**: DaVinci Resolve's color page is the industry standard for color grading.

#### 2.1 Color Wheels (Lift/Gamma/Gain)

| Wheel             | Controls         | FFmpeg Implementation   |
| ----------------- | ---------------- | ----------------------- |
| Lift (Shadows)    | RGB + Master     | `colorlevels`, `curves` |
| Gamma (Midtones)  | RGB + Master     | `eq`, `curves`          |
| Gain (Highlights) | RGB + Master     | `colorlevels`, `curves` |
| Offset            | Global RGB shift | `colorbalance`          |

**UI Component**: `ColorWheels.tsx`

- Circular wheel interface with RGB picker
- Master luminance slider per wheel
- Reset buttons
- Real-time preview

#### 2.2 Video Scopes

| Scope       | Purpose                | Implementation |
| ----------- | ---------------------- | -------------- |
| Waveform    | Luminance distribution | Canvas + WebGL |
| Vectorscope | Color saturation/hue   | Canvas + WebGL |
| RGB Parade  | Per-channel levels     | Canvas + WebGL |
| Histogram   | Tonal distribution     | Canvas         |

**Technical Approach:**

- Extract frame data via ImageData
- Process in WebGL shader for performance
- Update at 10-15fps during playback
- 60fps during scrubbing

### Priority 3: Audio Mixer Panel

**The Problem**: OpenReelio has audio effects but NO mixer interface. Users cannot see or adjust audio levels properly.

**Industry Reference**: Fairlight (DaVinci) provides 1000+ track mixing with full channel strips.

**Required Features:**
| Feature | Priority | Notes |
|---------|----------|-------|
| Track faders | CRITICAL | Vertical faders with dB scale |
| Peak meters | CRITICAL | Real-time level display |
| Pan controls | HIGH | Stereo positioning |
| Mute/Solo | HIGH | Already have mute on track |
| Master bus | HIGH | Final output level |

**UI Component**: `AudioMixer.tsx`

- Channel strip per audio track
- Fader, meter, pan, mute/solo
- Master output with limiter indicator
- Collapsible panel at bottom

### Priority 4: Media Organization (Bins)

**The Problem**: All assets in flat list. No folders or organization.

**Required Features:**
| Feature | Priority | Notes |
|---------|----------|-------|
| Create bins | CRITICAL | Folders in Project Explorer |
| Drag to bin | CRITICAL | Organize assets |
| Smart collections | MEDIUM | Auto-populate by criteria |
| Color labels | MEDIUM | Visual organization |
| Favorites | LOW | Quick access |

### Priority 5: Customizable Keyboard Shortcuts

**The Problem**: 20+ shortcuts exist but are hardcoded. Users cannot customize.

**Required Features:**
| Feature | Priority | Notes |
|---------|----------|-------|
| Shortcut settings UI | HIGH | List all shortcuts |
| Rebind shortcuts | HIGH | Click to change |
| Conflict detection | HIGH | Warn on duplicates |
| Preset import | MEDIUM | Premiere, Final Cut presets |
| Reset to defaults | MEDIUM | Undo customization |

### v0.5.0 Task Breakdown

| Task                     | Priority | Estimated Effort | Dependencies |
| ------------------------ | -------- | ---------------- | ------------ |
| Text clip data model     | CRITICAL | 2 days           | None         |
| Text rendering (FFmpeg)  | CRITICAL | 3 days           | Data model   |
| Title Inspector UI       | CRITICAL | 3 days           | Data model   |
| Title templates          | HIGH     | 2 days           | Inspector    |
| Color Wheels component   | CRITICAL | 5 days           | None         |
| Waveform scope           | CRITICAL | 3 days           | WebGL setup  |
| Vectorscope              | CRITICAL | 3 days           | WebGL setup  |
| RGB Parade               | HIGH     | 2 days           | Waveform     |
| Audio Mixer panel        | CRITICAL | 5 days           | None         |
| Audio meters             | HIGH     | 2 days           | Mixer        |
| Bins in Project Explorer | HIGH     | 3 days           | None         |
| Shortcut settings UI     | HIGH     | 3 days           | None         |

### v0.5.0 Definition of Done

- [ ] Users can add text/titles to videos
- [ ] Color Wheels with Lift/Gamma/Gain
- [ ] Waveform, Vectorscope, RGB Parade scopes
- [ ] Audio Mixer with faders and meters
- [ ] Bins/folders in Project Explorer
- [ ] Customizable keyboard shortcuts

---

## v0.6.0 - Advanced Editing

> **Goal**: Add secondary professional features that enhance workflow
> **Strategic Importance**: HIGH - Differentiates from consumer editors

### Priority 1: Multicam Editing

**The Problem**: No multicam support. Users must manually sync and switch angles.

**Industry Reference**: All professional NLEs support multicam with audio sync.

**Required Features:**
| Feature | Priority | Notes |
|---------|----------|-------|
| Create multicam clip | CRITICAL | From selected clips |
| Audio waveform sync | CRITICAL | Automatic alignment |
| Angle viewer | HIGH | 2x2 or 3x3 grid |
| Live switching | HIGH | Click to cut/switch |
| Keyboard switching | HIGH | 1-9 keys for angles |

**Data Model:**

```typescript
interface MulticamClip extends Clip {
  kind: 'multicam';
  angles: {
    id: string;
    clipId: string;
    label: string;
    enabled: boolean;
  }[];
  syncMethod: 'audio' | 'timecode' | 'inPoint';
  activeAngle: string;
  cuts: { time: number; angleId: string }[];
}
```

### Priority 2: Keying (Chroma/Luma)

**The Problem**: No green screen support. Users cannot do basic compositing.

**FFmpeg Filters:**

```bash
# Chroma key (green screen)
-vf "chromakey=color=0x00FF00:similarity=0.3:blend=0.1"

# Luma key
-vf "lumakey=threshold=0.1:tolerance=0.1"
```

**UI Component**: `KeyingControls.tsx`

- Color picker for key color
- Similarity/tolerance sliders
- Spill suppression
- Edge softness

### Priority 3: Motion Tracking

**The Problem**: No tracking capability. Users cannot attach elements to moving objects.

**Implementation Options:**

1. **FFmpeg vidstabdetect** - Basic stabilization/tracking
2. **OpenCV via WASM** - More advanced tracking
3. **Manual keyframing** - Fallback approach

**MVP Scope**: Point tracking for position stabilization

### Priority 4: Noise Reduction

**The Problem**: Audio effects exist but no noise reduction. Essential for dialogue.

**FFmpeg Filters:**

```bash
# Noise reduction
-af "anlmdn=s=7:p=0.002:r=0.002"  # Non-local means
-af "afftdn=nf=-20"               # FFT-based

# De-hummer
-af "highpass=f=60,lowpass=f=15000"
```

### Priority 5: Blend Modes

**The Problem**: No blend modes. Cannot do basic compositing.

**Required Modes:**
| Mode | FFmpeg Filter | Use Case |
|------|---------------|----------|
| Normal | Default | Standard overlay |
| Multiply | `blend=multiply` | Darken |
| Screen | `blend=screen` | Lighten |
| Overlay | `blend=overlay` | Contrast |
| Add | `blend=add` | Light effects |
| Difference | `blend=difference` | Comparison |

### v0.6.0 Definition of Done

- [ ] Multicam editing with audio sync
- [ ] Chroma key (green screen)
- [ ] Basic motion tracking (stabilization)
- [ ] Audio noise reduction
- [ ] Blend modes (6+ modes)
- [ ] Smart collections

---

## v0.7.0 - Color & VFX

> **Goal**: Professional-level color grading and motion graphics
> **Strategic Importance**: MEDIUM - Advanced features for power users
> **Status**: In Progress (85%) - Power Windows, Qualifiers, Shape Layers, HDR & Motion Graphics Templates complete

### Advanced Color Grading

| Feature                    | Priority | Status              | Notes                                          |
| -------------------------- | -------- | ------------------- | ---------------------------------------------- |
| **Power Windows**          | HIGH     | ✅ Backend Complete | Shape-based masking (62 tests)                 |
| **Qualifier (HSL keying)** | HIGH     | ✅ Backend Complete | Selective color correction (28 tests)          |
| Color Match                | MEDIUM   | 📋 Planned          | Match between shots                            |
| **HDR Support**            | MEDIUM   | ✅ Backend Complete | Color spaces, tonemapping, metadata (35 tests) |
| ACES Workflow              | LOW      | 📋 Planned          | Professional color management                  |

#### Power Windows Implementation Details

Backend Complete:

- ✅ Mask data models (Rectangle, Ellipse, Polygon, Bezier) - 23 tests
- ✅ Mask commands (Add/Update/Remove with undo/redo) - 9 tests
- ✅ Effect integration (MaskGroup on Effect struct)
- ✅ FFmpeg filter builder (geq expressions, feathering, blend modes) - 24 tests
- ✅ IPC payloads and command handling - 6 tests

Frontend Pending:

- 📋 MaskEditor component
- 📋 MaskList component
- 📋 MaskPropertyPanel

#### HSL Qualifier Implementation Details

Backend Complete:

- ✅ QualifierParams (hue/sat/lum ranges, softness, invert) - 10 tests
- ✅ ColorAdjustments (hue_shift, sat_adjust, lum_adjust) - 3 tests
- ✅ build_qualifier_filter() - True selective color correction
- ✅ build_qualified_mask_filter() - Qualifier + Power Windows integration
- ✅ build_qualifier_preview_filter() - Selection visualization
- ✅ Preset qualifiers (skin_tones, sky_blue, foliage) - 3 tests
- ✅ Updated HSLQualifier effect to use selective system - 10 tests

Frontend Pending:

- 📋 QualifierPanel component
- 📋 HSL picker/wheel UI
- 📋 Qualifier preview mode toggle

#### HDR Workflow Implementation Details

Backend Complete (35 tests):

- ✅ Color primaries: BT.709, BT.2020, DCI-P3, Display P3
- ✅ Transfer functions: sRGB, BT.709, PQ (HDR10), HLG
- ✅ ColorSpace struct combining primaries, transfer, matrix
- ✅ MasteringDisplayInfo (SMPTE ST 2086) with FFmpeg output
- ✅ HdrMetadata with MaxCLL/MaxFALL and x265-params generation
- ✅ Tonemapping modes: Reinhard, Hable, Mobius, BT.2390
- ✅ build_tonemap_filter() for HDR to SDR preview
- ✅ HDR detection from FFprobe metadata
- ✅ Color space conversion filters

Frontend Pending:

- 📋 HDR indicator badge on assets
- 📋 HDR preview mode toggle
- 📋 HDR export settings UI

### Advanced Motion Graphics

| Feature                       | Priority | Status              | Notes                                          |
| ----------------------------- | -------- | ------------------- | ---------------------------------------------- |
| **Shape layers**              | HIGH     | ✅ Backend Complete | Rectangle, ellipse, polygon, paths (36 tests)  |
| **Motion Graphics Templates** | HIGH     | ✅ Backend Complete | Lower thirds, title cards, callouts (26 tests) |
| Advanced text animation       | HIGH     | 📋 Planned          | Per-character effects                          |
| Motion paths                  | LOW      | 📋 Planned          | Animate along bezier curves                    |

#### Shape Layers Implementation Details

Backend Complete:

- ✅ Shape types: Rectangle, Ellipse, Line, Polygon (3-100 sides), Path
- ✅ ShapeFill: None, Solid, LinearGradient, RadialGradient
- ✅ ShapeStroke: color, width, cap, join, dash patterns
- ✅ ShapeLayerData with full configuration
- ✅ Preset shapes: lower_third_bar, callout_box, highlight_circle, arrow, divider
- ✅ Full validation and serialization

Frontend/Commands Pending:

- 📋 Shape commands (Add/Update/Remove)
- 📋 FFmpeg filter generation
- 📋 Shape editor UI

#### Motion Graphics Template System (26 tests)

Backend Complete:

- ✅ TemplateCategory: LowerThird, TitleCard, Callout, EndScreen, Transition
- ✅ TemplateParamType: Text, Color, Number, Toggle, Choice
- ✅ TemplateElement with parameter bindings
- ✅ MotionGraphicsTemplate with validation
- ✅ TemplateInstance for customization
- ✅ TemplateLibrary with search and category filtering
- ✅ 6 built-in templates: lower_third_simple, lower_third_modern, title_card_centered, callout_box, end_screen_subscribe, highlight_circle

Frontend Pending:

- 📋 Template browser panel
- 📋 Template parameter editor
- 📋 Template preview renderer

### Advanced Audio

| Feature                  | Priority | Notes                |
| ------------------------ | -------- | -------------------- |
| Surround sound (5.1)     | LOW      | Multi-channel output |
| Voice isolation          | MEDIUM   | AI-powered           |
| Loudness metering (LUFS) | HIGH     | Broadcast compliance |

### v0.7.0 Definition of Done

- [x] Qualifier for selective color - Backend complete (28 tests), frontend pending
- [x] Power Windows (masks) - Backend complete (62 tests), frontend pending
- [x] HDR workflow support - Backend complete (35 tests), frontend pending
- [x] Shape layers - Backend complete (36 tests), commands/frontend pending
- [x] Motion Graphics Templates - Backend complete (26 tests), frontend pending
- [ ] Advanced text animation
- [ ] LUFS loudness metering

---

## v1.0.0 - Production Ready

**Goal**: Stable, performant, cross-platform release.

### Focus Areas

#### 1. Performance Optimization

| Area            | Target       | Current |
| --------------- | ------------ | ------- |
| Startup time    | < 2s         | TBD     |
| Timeline scroll | 60fps        | TBD     |
| Preview latency | < 100ms      | TBD     |
| Export speed    | Real-time+   | TBD     |
| Memory usage    | < 500MB base | TBD     |

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

| Platform              | Priority | Status         |
| --------------------- | -------- | -------------- |
| Windows 10/11         | HIGH     | Primary target |
| macOS (Intel)         | HIGH     | Planned        |
| macOS (Apple Silicon) | HIGH     | Planned        |
| Linux (Ubuntu)        | MEDIUM   | Planned        |

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

| Technology      | Purpose          | Integration Point              | Version             |
| --------------- | ---------------- | ------------------------------ | ------------------- |
| **whisper.cpp** | Speech-to-text   | `core/indexing/transcripts.rs` | via whisper-rs 0.13 |
| **Meilisearch** | Full-text search | Tauri sidecar + `core/search/` | 1.6+                |
| **candle**      | ML inference     | `core/indexing/shots.rs`       | 0.8                 |
| **FFmpeg**      | Video processing | `core/ffmpeg/`                 | 6.0+                |
| **Wasmtime**    | Plugin runtime   | `core/plugin/host.rs`          | 27                  |

### Evaluated but Not Adopted

| Technology              | Reason for Rejection                                           |
| ----------------------- | -------------------------------------------------------------- |
| **MLT Framework**       | C/C++ integration complexity; FFmpeg direct control preferred  |
| **Vis.js Timeline**     | Not specialized for video editing; missing trim/layer features |
| **React-Timeline-9000** | Already have custom implementation; would require migration    |

### Reference Projects (For Inspiration Only)

| Project    | Reference Use                                              |
| ---------- | ---------------------------------------------------------- |
| **Editly** | JSON-based edit definition structure for EditScript design |

---

## Risk Assessment & Mitigation

### Technical Risks

| Risk                        | Impact | Probability | Mitigation                                 |
| --------------------------- | ------ | ----------- | ------------------------------------------ |
| FFmpeg compatibility issues | HIGH   | MEDIUM      | Bundle specific version; extensive testing |
| Whisper model size          | MEDIUM | LOW         | Offer model selection; lazy download       |
| Meilisearch memory usage    | MEDIUM | LOW         | Configure limits; monitor usage            |
| WASM plugin security        | HIGH   | LOW         | Strict permission system; sandboxing       |
| Cross-platform differences  | MEDIUM | MEDIUM      | CI/CD on all platforms; abstraction layers |

### Resource Risks

| Risk                       | Impact | Probability | Mitigation                                |
| -------------------------- | ------ | ----------- | ----------------------------------------- |
| Large video file handling  | HIGH   | HIGH        | Proxy generation; streaming architecture  |
| Memory exhaustion          | HIGH   | MEDIUM      | Memory monitoring; cache eviction; limits |
| CPU overload during render | MEDIUM | LOW         | Worker pool; background processing        |

### Dependency Risks

| Risk                   | Impact | Probability | Mitigation                            |
| ---------------------- | ------ | ----------- | ------------------------------------- |
| Tauri breaking changes | HIGH   | LOW         | Pin versions; follow upgrade guides   |
| Rust ecosystem changes | MEDIUM | LOW         | Lock Cargo.lock; conservative updates |
| AI model licensing     | MEDIUM | LOW         | Use permissive models (MIT/Apache)    |

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

_This roadmap is a living document. Updates will be made as development progresses and priorities shift._
