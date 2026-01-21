# OpenReelio Work Plan

> **Last Updated**: 2026-01-21
> **Current Phase**: MVP v0.1.0 Completion
> **Target**: Complete MVP, then proceed to v0.2.0 AI Integration

This document provides actionable task breakdowns for immediate development work.

---

## Current Sprint: MVP Completion

### Priority Matrix

```
                    IMPACT
              HIGH           LOW
         ┌─────────────┬─────────────┐
    HIGH │  DO FIRST   │  SCHEDULE   │
URGENCY  │  Phase 2-3  │  Phase 5    │
         ├─────────────┼─────────────┤
    LOW  │  DELEGATE   │   DEFER     │
         │  v0.2.0     │   v0.3.0+   │
         └─────────────┴─────────────┘
```

---

## Week 1-2: Timeline Core Completion (Phase 2)

### Task 1.1: Clip Drag & Drop Enhancement

**Current State**: Basic drag exists in `useClipDrag.ts`
**Goal**: Production-ready drag between tracks with visual feedback

**Files to Modify:**
- `src/hooks/useClipDrag.ts`
- `src/components/timeline/Timeline.tsx`
- `src/components/timeline/Clip.tsx`
- `src/stores/timelineStore.ts`

**Implementation Steps:**

```typescript
// Step 1: Enhance useClipDrag hook
// src/hooks/useClipDrag.ts

interface DragState {
  clipId: string;
  originalTrackId: string;
  originalPosition: number;
  currentTrackId: string;
  currentPosition: number;
  isDragging: boolean;
  ghostPosition: { x: number; y: number };
}

export function useClipDrag() {
  const [dragState, setDragState] = useState<DragState | null>(null);

  const handleDragStart = (clipId: string, e: React.MouseEvent) => {
    // 1. Get clip from store
    // 2. Calculate offset from mouse to clip start
    // 3. Set drag state
    // 4. Add global mouse listeners
  };

  const handleDragMove = (e: MouseEvent) => {
    // 1. Calculate new position (pixels to time)
    // 2. Detect track under cursor
    // 3. Apply snapping
    // 4. Update ghost position
    // 5. Show drop indicators
  };

  const handleDragEnd = () => {
    // 1. If position changed, execute MoveClip command
    // 2. Clean up listeners
    // 3. Reset drag state
  };

  return { dragState, handleDragStart };
}
```

```typescript
// Step 2: Add ghost clip rendering
// src/components/timeline/GhostClip.tsx

interface GhostClipProps {
  clip: Clip;
  position: { x: number; y: number };
  isValid: boolean;
}

export function GhostClip({ clip, position, isValid }: GhostClipProps) {
  return (
    <div
      className={cn(
        "absolute pointer-events-none opacity-50 border-2 rounded",
        isValid ? "border-blue-500 bg-blue-500/20" : "border-red-500 bg-red-500/20"
      )}
      style={{
        left: position.x,
        top: position.y,
        width: clip.duration * pixelsPerSecond,
        height: TRACK_HEIGHT,
      }}
    >
      {clip.name}
    </div>
  );
}
```

**Test Cases:**
```typescript
// src/hooks/useClipDrag.test.ts
describe('useClipDrag', () => {
  it('should initialize drag state on mouse down', () => {});
  it('should update position during drag', () => {});
  it('should snap to nearby clips', () => {});
  it('should snap to playhead', () => {});
  it('should detect track changes', () => {});
  it('should execute MoveClip command on drop', () => {});
  it('should revert on invalid drop', () => {});
  it('should handle multi-clip drag', () => {});
});
```

**Acceptance Criteria:**
- [ ] Single clip drag between tracks
- [ ] Multi-clip drag (selected clips move together)
- [ ] Snap to playhead (configurable)
- [ ] Snap to clip edges (configurable)
- [ ] Visual feedback (ghost clip, drop indicators)
- [ ] Undo/redo works correctly
- [ ] 60fps during drag operation

---

### Task 1.2: Clip Trimming

**Current State**: Not implemented
**Goal**: Drag clip edges to adjust in/out points

**Files to Create/Modify:**
- `src/hooks/useClipTrim.ts` (NEW)
- `src/components/timeline/TrimHandle.tsx` (NEW)
- `src/components/timeline/Clip.tsx`

**Implementation Steps:**

```typescript
// Step 1: Create trim handle component
// src/components/timeline/TrimHandle.tsx

interface TrimHandleProps {
  side: 'left' | 'right';
  onTrimStart: () => void;
}

export function TrimHandle({ side, onTrimStart }: TrimHandleProps) {
  return (
    <div
      className={cn(
        "absolute top-0 bottom-0 w-2 cursor-ew-resize",
        "opacity-0 group-hover:opacity-100 transition-opacity",
        side === 'left' ? 'left-0' : 'right-0',
        "bg-white/50 hover:bg-blue-500"
      )}
      onMouseDown={(e) => {
        e.stopPropagation();
        onTrimStart();
      }}
    />
  );
}
```

```typescript
// Step 2: Create trim hook
// src/hooks/useClipTrim.ts

interface TrimState {
  clipId: string;
  side: 'left' | 'right';
  originalInPoint: number;
  originalOutPoint: number;
  currentValue: number;
  minValue: number;
  maxValue: number;
}

export function useClipTrim() {
  const [trimState, setTrimState] = useState<TrimState | null>(null);

  const handleTrimStart = (clipId: string, side: 'left' | 'right', e: React.MouseEvent) => {
    const clip = getClip(clipId);
    const asset = getAsset(clip.assetId);

    setTrimState({
      clipId,
      side,
      originalInPoint: clip.inPoint,
      originalOutPoint: clip.outPoint,
      currentValue: side === 'left' ? clip.inPoint : clip.outPoint,
      minValue: 0,
      maxValue: asset.duration,
    });
  };

  const handleTrimMove = (e: MouseEvent) => {
    // 1. Calculate delta in time
    // 2. Apply snapping
    // 3. Clamp to min/max
    // 4. Update preview
  };

  const handleTrimEnd = () => {
    // Execute TrimClip command
    const command = {
      type: 'TrimClip',
      payload: {
        clipId: trimState.clipId,
        newInPoint: ...,
        newOutPoint: ...,
      }
    };
    executeCommand(command);
  };

  return { trimState, handleTrimStart };
}
```

**Backend Command (Already Exists):**
```rust
// src-tauri/src/core/commands/clip.rs
pub struct TrimClip {
    pub clip_id: String,
    pub new_in_point: Option<f64>,
    pub new_out_point: Option<f64>,
}
```

**Test Cases:**
```typescript
describe('useClipTrim', () => {
  it('should trim left edge (adjust in point)', () => {});
  it('should trim right edge (adjust out point)', () => {});
  it('should not trim beyond asset duration', () => {});
  it('should not trim to negative duration', () => {});
  it('should snap to playhead during trim', () => {});
  it('should show trim preview', () => {});
  it('should execute TrimClip command on release', () => {});
});
```

**Acceptance Criteria:**
- [ ] Left edge trim (in point)
- [ ] Right edge trim (out point)
- [ ] Handles appear on hover
- [ ] Cursor changes to resize
- [ ] Preview updates during trim
- [ ] Snapping to playhead/clips
- [ ] Cannot trim beyond source duration
- [ ] Cannot create zero-length clip

---

### Task 1.3: Multi-Selection

**Current State**: Single selection works
**Goal**: Shift+click and drag-select multiple clips

**Files to Modify:**
- `src/stores/timelineStore.ts`
- `src/components/timeline/Timeline.tsx`
- `src/components/timeline/SelectionBox.tsx` (NEW)

**Implementation:**

```typescript
// Step 1: Enhance store
// src/stores/timelineStore.ts

interface TimelineState {
  selectedClipIds: Set<string>;

  // Actions
  selectClip: (clipId: string, addToSelection?: boolean) => void;
  selectClips: (clipIds: string[]) => void;
  deselectAll: () => void;
  selectInRect: (rect: Rect) => void;
}
```

```typescript
// Step 2: Selection box component
// src/components/timeline/SelectionBox.tsx

export function useSelectionBox() {
  const [selection, setSelection] = useState<{
    start: Point;
    current: Point;
  } | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.target === timelineRef.current) {
      setSelection({ start: { x: e.clientX, y: e.clientY }, current: { x: e.clientX, y: e.clientY } });
    }
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (selection) {
      setSelection(prev => ({ ...prev!, current: { x: e.clientX, y: e.clientY } }));

      // Calculate rect and find clips inside
      const rect = calculateRect(selection.start, { x: e.clientX, y: e.clientY });
      const clipsInRect = findClipsInRect(rect);
      selectClips(clipsInRect.map(c => c.id));
    }
  };

  return { selection, handlers: { onMouseDown: handleMouseDown } };
}
```

**Acceptance Criteria:**
- [ ] Shift+click adds to selection
- [ ] Ctrl+click toggles selection
- [ ] Click on empty area deselects all
- [ ] Drag on empty area creates selection box
- [ ] Selection box highlights intersecting clips
- [ ] Selected clips move together

---

## Week 3-4: Preview System (Phase 3)

### Task 2.1: Frame Extraction Pipeline

**Current State**: FFmpeg runner exists, frame extraction stub
**Goal**: Extract and display frames at any timestamp

**Files to Modify:**
- `src-tauri/src/core/ffmpeg/commands.rs`
- `src-tauri/src/ipc/commands.rs`
- `src/hooks/useFrameExtractor.ts`
- `src/components/preview/PreviewPlayer.tsx`

**Backend Implementation:**

```rust
// src-tauri/src/core/ffmpeg/commands.rs

impl FFmpegCommands {
    /// Extract a single frame at the given timestamp
    pub fn extract_frame(
        input_path: &Path,
        timestamp: f64,
        output_path: &Path,
        size: Option<(u32, u32)>,
    ) -> Command {
        let mut cmd = Command::new(&self.ffmpeg_path);
        cmd.args([
            "-ss", &format!("{:.3}", timestamp),
            "-i", input_path.to_str().unwrap(),
            "-frames:v", "1",
            "-q:v", "2",
        ]);

        if let Some((w, h)) = size {
            cmd.args(["-vf", &format!("scale={}:{}", w, h)]);
        }

        cmd.arg(output_path);
        cmd
    }
}

// src-tauri/src/ipc/commands.rs
#[tauri::command]
pub async fn extract_frame(
    state: State<'_, AppState>,
    asset_id: String,
    timestamp: f64,
) -> Result<String, String> {
    let asset = state.project.get_asset(&asset_id)?;
    let cache_path = state.cache.frame_path(&asset_id, timestamp);

    if !cache_path.exists() {
        state.ffmpeg.extract_frame(&asset.path, timestamp, &cache_path, Some((1920, 1080))).await?;
    }

    Ok(cache_path.to_string_lossy().to_string())
}
```

**Frontend Implementation:**

```typescript
// src/hooks/useFrameExtractor.ts

export function useFrameExtractor() {
  const [frameCache, setFrameCache] = useState<Map<string, string>>(new Map());

  const extractFrame = useCallback(async (assetId: string, timestamp: number) => {
    const cacheKey = `${assetId}:${timestamp.toFixed(2)}`;

    if (frameCache.has(cacheKey)) {
      return frameCache.get(cacheKey)!;
    }

    const framePath = await invoke<string>('extract_frame', { assetId, timestamp });

    // Convert to asset URL for Tauri
    const frameUrl = convertFileSrc(framePath);

    setFrameCache(prev => new Map(prev).set(cacheKey, frameUrl));
    return frameUrl;
  }, [frameCache]);

  return { extractFrame, frameCache };
}
```

**Test Cases:**
```typescript
describe('useFrameExtractor', () => {
  it('should extract frame at timestamp', async () => {});
  it('should cache extracted frames', async () => {});
  it('should handle extraction errors', async () => {});
});
```

---

### Task 2.2: Playback Loop

**Goal**: Smooth 30fps preview playback with audio sync

**Implementation Strategy:**

```typescript
// src/hooks/usePlayback.ts

export function usePlayback() {
  const { currentTime, isPlaying, setCurrentTime, setIsPlaying } = usePlaybackStore();
  const { extractFrame } = useFrameExtractor();
  const audioRef = useRef<HTMLAudioElement>(null);
  const frameRequestRef = useRef<number>();
  const lastFrameTimeRef = useRef<number>(0);

  const targetFps = 30;
  const frameInterval = 1000 / targetFps;

  const playbackLoop = useCallback((timestamp: number) => {
    if (!isPlaying) return;

    const elapsed = timestamp - lastFrameTimeRef.current;

    if (elapsed >= frameInterval) {
      const newTime = currentTime + (elapsed / 1000) * playbackSpeed;

      if (newTime >= duration) {
        setIsPlaying(false);
        setCurrentTime(duration);
        return;
      }

      setCurrentTime(newTime);
      lastFrameTimeRef.current = timestamp;
    }

    frameRequestRef.current = requestAnimationFrame(playbackLoop);
  }, [isPlaying, currentTime, duration, playbackSpeed]);

  useEffect(() => {
    if (isPlaying) {
      lastFrameTimeRef.current = performance.now();
      frameRequestRef.current = requestAnimationFrame(playbackLoop);
      audioRef.current?.play();
    } else {
      if (frameRequestRef.current) {
        cancelAnimationFrame(frameRequestRef.current);
      }
      audioRef.current?.pause();
    }

    return () => {
      if (frameRequestRef.current) {
        cancelAnimationFrame(frameRequestRef.current);
      }
    };
  }, [isPlaying, playbackLoop]);

  return { play, pause, seek, currentTime, isPlaying };
}
```

**Frame Pre-caching:**

```typescript
// Prefetch frames ahead of playhead
const PREFETCH_SECONDS = 2;
const PREFETCH_INTERVAL = 1 / 15; // Every 2 frames at 30fps

useEffect(() => {
  if (isPlaying) {
    const prefetchFrames = async () => {
      for (let t = currentTime; t < currentTime + PREFETCH_SECONDS; t += PREFETCH_INTERVAL) {
        await extractFrame(currentAssetId, t);
      }
    };
    prefetchFrames();
  }
}, [currentTime, isPlaying]);
```

---

### Task 2.3: Audio Synchronization

**Implementation:**

```typescript
// src/components/preview/AudioPlayer.tsx

export function AudioPlayer({ assetId, currentTime, isPlaying, volume }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // Load audio file
  useEffect(() => {
    const loadAudio = async () => {
      const asset = await invoke<Asset>('get_asset', { assetId });
      setAudioUrl(convertFileSrc(asset.path));
    };
    loadAudio();
  }, [assetId]);

  // Sync playback state
  useEffect(() => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.play();
    } else {
      audioRef.current.pause();
    }
  }, [isPlaying]);

  // Sync position
  useEffect(() => {
    if (!audioRef.current) return;

    const drift = Math.abs(audioRef.current.currentTime - currentTime);
    if (drift > 0.1) { // Resync if drifted more than 100ms
      audioRef.current.currentTime = currentTime;
    }
  }, [currentTime]);

  // Sync volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  return audioUrl ? <audio ref={audioRef} src={audioUrl} /> : null;
}
```

---

## Week 5: Polish & UX (Phase 5)

### Task 3.1: Complete Keyboard Shortcuts

**Current State**: `useKeyboardShortcuts.ts` exists with partial implementation

**Full Shortcut Map:**

```typescript
// src/hooks/useKeyboardShortcuts.ts

const SHORTCUTS: Record<string, ShortcutConfig> = {
  // Playback
  'Space': { action: 'playPause', description: 'Play/Pause' },
  'K': { action: 'playPause', description: 'Play/Pause (alt)' },
  'J': { action: 'playBackward', description: 'Play backward' },
  'L': { action: 'playForward', description: 'Play forward' },
  'Home': { action: 'goToStart', description: 'Go to start' },
  'End': { action: 'goToEnd', description: 'Go to end' },
  'ArrowLeft': { action: 'framePrev', description: 'Previous frame' },
  'ArrowRight': { action: 'frameNext', description: 'Next frame' },

  // Editing
  'S': { action: 'splitAtPlayhead', description: 'Split at playhead' },
  'Delete': { action: 'deleteSelected', description: 'Delete selected' },
  'Backspace': { action: 'deleteSelected', description: 'Delete selected' },

  // Selection
  'Ctrl+A': { action: 'selectAll', description: 'Select all clips' },
  'Escape': { action: 'deselectAll', description: 'Deselect all' },

  // History
  'Ctrl+Z': { action: 'undo', description: 'Undo' },
  'Ctrl+Shift+Z': { action: 'redo', description: 'Redo' },
  'Ctrl+Y': { action: 'redo', description: 'Redo (alt)' },

  // Project
  'Ctrl+S': { action: 'save', description: 'Save project' },
  'Ctrl+O': { action: 'open', description: 'Open project' },
  'Ctrl+I': { action: 'import', description: 'Import asset' },
  'Ctrl+E': { action: 'export', description: 'Export video' },

  // View
  'Ctrl+=': { action: 'zoomIn', description: 'Zoom in' },
  'Ctrl+-': { action: 'zoomOut', description: 'Zoom out' },
  'Ctrl+0': { action: 'zoomFit', description: 'Zoom to fit' },
  'F': { action: 'toggleFullscreen', description: 'Toggle fullscreen preview' },
};
```

---

### Task 3.2: Toast Notification System

**Implementation:**

```typescript
// src/components/ui/Toast.tsx

interface Toast {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  duration?: number;
}

const ToastContext = createContext<{
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}>(null!);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { ...toast, id }]);

    const duration = toast.duration ?? 5000;
    if (duration > 0) {
      setTimeout(() => removeToast(id), duration);
    }
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      <div className="fixed bottom-4 right-4 space-y-2 z-50">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// Usage hook
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}
```

---

## Post-MVP: v0.2.0 AI Integration

### Phase A: whisper.cpp Integration

**Timeline**: 1 week

**Step 1: Add Dependencies**
```toml
# Cargo.toml
[dependencies]
whisper-rs = "0.13"
hound = "3.5"  # WAV file handling
```

**Step 2: Audio Extraction**
```rust
// src-tauri/src/core/captions/audio.rs

pub async fn extract_audio_for_transcription(
    video_path: &Path,
    output_path: &Path,
) -> Result<(), CoreError> {
    // FFmpeg: extract audio as 16kHz mono WAV
    let status = Command::new("ffmpeg")
        .args([
            "-i", video_path.to_str().unwrap(),
            "-ar", "16000",
            "-ac", "1",
            "-c:a", "pcm_s16le",
            output_path.to_str().unwrap(),
        ])
        .status()
        .await?;

    if !status.success() {
        return Err(CoreError::FFmpeg("Audio extraction failed".into()));
    }

    Ok(())
}
```

**Step 3: Whisper Integration**
```rust
// src-tauri/src/core/captions/whisper.rs

use whisper_rs::{WhisperContext, WhisperContextParameters, FullParams, SamplingStrategy};

pub struct WhisperEngine {
    context: WhisperContext,
}

impl WhisperEngine {
    pub fn new(model_path: &Path) -> Result<Self, CoreError> {
        let params = WhisperContextParameters::default();
        let context = WhisperContext::new_with_params(
            model_path.to_str().unwrap(),
            params,
        ).map_err(|e| CoreError::Whisper(e.to_string()))?;

        Ok(Self { context })
    }

    pub async fn transcribe(&self, audio_path: &Path) -> Result<Vec<Caption>, CoreError> {
        // 1. Load audio samples
        let samples = self.load_audio(audio_path)?;

        // 2. Create whisper state
        let mut state = self.context.create_state()
            .map_err(|e| CoreError::Whisper(e.to_string()))?;

        // 3. Configure parameters
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("auto"));
        params.set_translate(false);
        params.set_print_progress(false);

        // 4. Run inference
        state.full(params, &samples)
            .map_err(|e| CoreError::Whisper(e.to_string()))?;

        // 5. Extract segments
        let num_segments = state.full_n_segments()
            .map_err(|e| CoreError::Whisper(e.to_string()))?;

        let mut captions = Vec::new();
        for i in 0..num_segments {
            let start = state.full_get_segment_t0(i)
                .map_err(|e| CoreError::Whisper(e.to_string()))? as f64 / 100.0;
            let end = state.full_get_segment_t1(i)
                .map_err(|e| CoreError::Whisper(e.to_string()))? as f64 / 100.0;
            let text = state.full_get_segment_text(i)
                .map_err(|e| CoreError::Whisper(e.to_string()))?;

            captions.push(Caption {
                id: Ulid::new().to_string(),
                start_time: start,
                end_time: end,
                text: text.trim().to_string(),
                style: None,
            });
        }

        Ok(captions)
    }

    fn load_audio(&self, path: &Path) -> Result<Vec<f32>, CoreError> {
        let reader = hound::WavReader::open(path)
            .map_err(|e| CoreError::Audio(e.to_string()))?;

        let samples: Vec<f32> = reader
            .into_samples::<i16>()
            .filter_map(Result::ok)
            .map(|s| s as f32 / 32768.0)
            .collect();

        Ok(samples)
    }
}
```

**Step 4: IPC Command**
```rust
// src-tauri/src/ipc/commands.rs

#[tauri::command]
pub async fn transcribe_asset(
    state: State<'_, AppState>,
    asset_id: String,
    model: Option<String>,
) -> Result<Vec<Caption>, String> {
    let asset = state.project.get_asset(&asset_id)
        .map_err(|e| e.to_string())?;

    // 1. Extract audio
    let audio_path = state.cache.audio_path(&asset_id);
    extract_audio_for_transcription(&asset.path, &audio_path).await
        .map_err(|e| e.to_string())?;

    // 2. Transcribe
    let model_path = state.models.whisper_model(model.as_deref().unwrap_or("base"));
    let engine = WhisperEngine::new(&model_path)
        .map_err(|e| e.to_string())?;

    let captions = engine.transcribe(&audio_path).await
        .map_err(|e| e.to_string())?;

    // 3. Store in project
    state.project.add_captions(&asset_id, captions.clone())
        .map_err(|e| e.to_string())?;

    Ok(captions)
}
```

---

### Phase B: Meilisearch Integration

**Timeline**: 3-4 days

**Step 1: Sidecar Setup**
```rust
// src-tauri/src/core/search/sidecar.rs

pub struct MeilisearchSidecar {
    process: Child,
    client: meilisearch_sdk::Client,
    data_dir: PathBuf,
}

impl MeilisearchSidecar {
    pub async fn start(data_dir: &Path) -> Result<Self, CoreError> {
        // Get bundled binary path
        let binary = std::env::current_exe()?
            .parent()
            .unwrap()
            .join("meilisearch");

        // Start process
        let process = Command::new(&binary)
            .args([
                "--db-path", data_dir.join("search").to_str().unwrap(),
                "--http-addr", "127.0.0.1:7700",
                "--master-key", "openreelio-search-key",
                "--no-analytics",
            ])
            .spawn()?;

        // Wait for ready
        tokio::time::sleep(Duration::from_secs(1)).await;

        // Create client
        let client = meilisearch_sdk::Client::new(
            "http://127.0.0.1:7700",
            Some("openreelio-search-key"),
        );

        Ok(Self { process, client, data_dir: data_dir.to_path_buf() })
    }

    pub async fn stop(&mut self) -> Result<(), CoreError> {
        self.process.kill()?;
        Ok(())
    }
}
```

**Step 2: Index Management**
```rust
// src-tauri/src/core/search/indexer.rs

#[derive(Serialize, Deserialize)]
pub struct AssetDocument {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub duration: Option<f64>,
    pub created_at: String,
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub struct TranscriptDocument {
    pub id: String,
    pub asset_id: String,
    pub text: String,
    pub start_time: f64,
    pub end_time: f64,
}

pub struct SearchIndexer {
    client: meilisearch_sdk::Client,
}

impl SearchIndexer {
    pub async fn index_asset(&self, asset: &Asset) -> Result<(), CoreError> {
        let index = self.client.index("assets");

        let doc = AssetDocument {
            id: asset.id.clone(),
            name: asset.name.clone(),
            path: asset.path.to_string_lossy().to_string(),
            kind: format!("{:?}", asset.kind),
            duration: asset.duration,
            created_at: asset.created_at.to_rfc3339(),
            tags: asset.tags.clone(),
        };

        index.add_documents(&[doc], Some("id")).await
            .map_err(|e| CoreError::Search(e.to_string()))?;

        Ok(())
    }

    pub async fn index_captions(&self, asset_id: &str, captions: &[Caption]) -> Result<(), CoreError> {
        let index = self.client.index("transcripts");

        let docs: Vec<TranscriptDocument> = captions.iter().map(|c| {
            TranscriptDocument {
                id: c.id.clone(),
                asset_id: asset_id.to_string(),
                text: c.text.clone(),
                start_time: c.start_time,
                end_time: c.end_time,
            }
        }).collect();

        index.add_documents(&docs, Some("id")).await
            .map_err(|e| CoreError::Search(e.to_string()))?;

        Ok(())
    }

    pub async fn search(&self, query: &str) -> Result<SearchResults, CoreError> {
        // Search both indexes
        let asset_results = self.client.index("assets")
            .search()
            .with_query(query)
            .execute::<AssetDocument>()
            .await?;

        let transcript_results = self.client.index("transcripts")
            .search()
            .with_query(query)
            .execute::<TranscriptDocument>()
            .await?;

        Ok(SearchResults {
            assets: asset_results.hits,
            transcripts: transcript_results.hits,
        })
    }
}
```

---

## Quality Gates

### Before Merging Any Feature

- [ ] All new tests pass
- [ ] No regressions in existing tests
- [ ] Code follows style guide (ESLint, Clippy clean)
- [ ] Documentation updated
- [ ] No console.log/println!/dbg! left
- [ ] Undo/redo tested
- [ ] Error cases handled
- [ ] Performance acceptable (60fps timeline)

### Before MVP Release

- [ ] All Phase 0-4 complete
- [ ] Test coverage > 80%
- [ ] No critical bugs
- [ ] Windows installer works
- [ ] Complete user flow tested
- [ ] Documentation ready

---

## Appendix: Development Commands

```bash
# Frontend development
npm run dev              # Start Vite dev server
npm run test             # Run Vitest
npm run test:ui          # Vitest with UI
npm run lint             # ESLint check
npm run format           # Prettier format

# Backend development
cd src-tauri
cargo build              # Build Rust
cargo test               # Run tests
cargo clippy             # Lint check
cargo fmt                # Format code

# Full app
npm run tauri dev        # Development mode
npm run tauri build      # Production build

# Testing
npm run test:e2e         # Playwright E2E tests
npm run test:bench       # Performance benchmarks
npm run test:stress      # Stress tests
```

---

*This work plan will be updated as tasks are completed and new priorities emerge.*
