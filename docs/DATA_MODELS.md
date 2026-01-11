# OpenReelio Data Model Schema

This document defines all data model schemas used in OpenReelio.

---

## Table of Contents

1. [Basic Types](#basic-types)
2. [Project Model](#project-model)
3. [Asset Model](#asset-model)
4. [Timeline Model](#timeline-model)
5. [Effect Model](#effect-model)
6. [Caption Model](#caption-model)
7. [AI Model](#ai-model)
8. [Index Model](#index-model)

---

## Basic Types

### ID Types

All IDs use ULID (Universally Unique Lexicographically Sortable Identifier) format.

```typescript
// TypeScript
type AssetId = string;    // "01HZ8N3QJGK5M7RX2P4V6W9YBC"
type ClipId = string;
type TrackId = string;
type EffectId = string;
type CaptionId = string;
type OpId = string;
type JobId = string;
type SequenceId = string;
type PluginId = string;
```

```rust
// Rust
pub type AssetId = String;
pub type ClipId = String;
pub type TrackId = String;
pub type EffectId = String;
pub type CaptionId = String;
pub type OpId = String;
pub type JobId = String;
pub type SequenceId = String;
pub type PluginId = String;
```

### Time Types

```typescript
type TimeSec = number;    // Seconds (floating point)
type Frame = number;      // Frames (integer)

interface Ratio {
  num: number;   // Numerator
  den: number;   // Denominator
}

// Example: 30fps = { num: 30, den: 1 }
// Example: 29.97fps = { num: 30000, den: 1001 }
```

### Spatial Types

```typescript
interface Point2D {
  x: number;   // normalized (0.0 ~ 1.0) or pixel
  y: number;
}

interface Size2D {
  width: number;
  height: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Transform {
  position: Point2D;      // Center position (normalized)
  scale: Point2D;         // Scale (1.0 = 100%)
  rotation: number;       // Degrees
  anchor: Point2D;        // Anchor point (normalized)
}
```

### Color Types

```typescript
interface Color {
  r: number;   // 0.0 ~ 1.0
  g: number;
  b: number;
  a?: number;  // Optional alpha
}
```

---

## Project Model

### Project

```typescript
interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;              // ISO 8601
  modifiedAt: string;
  version: string;                // Schema version
  defaultSequenceId: SequenceId;
  settings: ProjectSettings;
}

interface ProjectSettings {
  defaultFormat: SequenceFormat;
  proxyEnabled: boolean;
  proxyHeight: number;            // Default: 720
  autosaveInterval: number;       // Seconds, 0 = disabled
  aiProvider?: AIProviderConfig;
}
```

### SequenceFormat

```typescript
interface SequenceFormat {
  canvas: Size2D;                 // e.g., { width: 1080, height: 1920 }
  fps: Ratio;                     // e.g., { num: 30, den: 1 }
  audioSampleRate: number;        // e.g., 48000
  audioChannels: number;          // e.g., 2
}
```

---

## Asset Model

### Asset

```typescript
interface Asset {
  id: AssetId;
  kind: AssetKind;
  name: string;
  originalUri: string;
  projectUri?: string;            // Path within project
  meta: AssetMeta;
  proxyStatus: ProxyStatus;
  thumbnails: string[];           // Thumbnail paths
  tags: string[];
  license?: LicenseInfo;
  createdAt: string;
  modifiedAt: string;
}

type AssetKind = 'video' | 'audio' | 'image' | 'caption';

interface AssetMeta {
  duration?: number;              // Seconds (video/audio)
  width?: number;                 // Pixels (video/image)
  height?: number;
  fps?: Ratio;                    // Video only
  codec?: string;
  bitrate?: number;               // bps
  sampleRate?: number;            // Hz (audio)
  channels?: number;              // Audio channels
  fileSize: number;               // Bytes
  mimeType: string;
}

type ProxyStatus = 'none' | 'generating' | 'ready' | 'failed';
```

---

## Timeline Model

### Sequence

```typescript
interface Sequence {
  id: SequenceId;
  name: string;
  format: SequenceFormat;
  duration: number;               // Calculated from clips
  tracks: TrackId[];              // Ordered track IDs
  markers: Marker[];
  createdAt: string;
  modifiedAt: string;
}
```

### Track

```typescript
interface Track {
  id: TrackId;
  kind: TrackKind;
  name: string;
  sequenceId: SequenceId;
  index: number;                  // Layer order (0 = bottom)
  locked: boolean;
  visible: boolean;               // Video track visibility
  muted: boolean;                 // Audio track mute
  volume: number;                 // Audio volume (0.0 ~ 2.0)
  clips: ClipId[];
}

type TrackKind = 'video' | 'audio' | 'caption';
```

### Clip

```typescript
interface Clip {
  id: ClipId;
  trackId: TrackId;
  assetId?: AssetId;              // Generator clips have no asset
  type: ClipType;

  // Timeline position
  timelineStart: number;          // Seconds on timeline
  timelineEnd: number;

  // Source range
  sourceStart: number;            // Seconds in source
  sourceEnd: number;

  // Properties
  speed: number;                  // Playback speed (1.0 = normal)
  volume: number;                 // Audio volume
  transform: Transform;
  opacity: number;                // 0.0 ~ 1.0

  // Effects and transitions
  effects: EffectId[];
  transitionIn?: Transition;
  transitionOut?: Transition;

  // Metadata
  label?: string;
  color?: string;                 // Clip color for UI
}

type ClipType = 'video' | 'audio' | 'image' | 'generator' | 'compound';
```

---

## Effect Model

### Effect

```typescript
interface Effect {
  id: EffectId;
  type: EffectType;
  name: string;
  enabled: boolean;
  params: Record<string, any>;
  keyframes?: Keyframe<Record<string, any>>[];
}

type EffectType =
  | 'color_correction'
  | 'blur'
  | 'sharpen'
  | 'crop'
  | 'speed'
  | 'stabilize'
  | 'noise_reduction'
  | 'chroma_key'
  | 'lut'
  | 'custom';
```

### Transition

```typescript
interface Transition {
  type: TransitionType;
  duration: number;               // Seconds
  params?: Record<string, any>;
}

type TransitionType =
  | 'fade'
  | 'dissolve'
  | 'wipe'
  | 'slide'
  | 'zoom'
  | 'custom';
```

### Keyframe

```typescript
interface Keyframe<T> {
  time: number;                   // Seconds
  value: T;
  easing: EasingType;
}

type EasingType =
  | 'linear'
  | 'ease_in'
  | 'ease_out'
  | 'ease_in_out'
  | 'bezier';
```

---

## Caption Model

### Caption

```typescript
interface Caption {
  id: CaptionId;
  trackId: TrackId;
  text: string;
  startTime: number;              // Seconds
  endTime: number;
  style: CaptionStyle;
  position?: Point2D;             // Override default position
  animation?: CaptionAnimation;
}

interface CaptionStyle {
  fontFamily: string;
  fontSize: number;               // Points
  fontWeight: number;             // 100 ~ 900
  color: Color;
  backgroundColor?: Color;
  outlineColor?: Color;
  outlineWidth?: number;
  shadowColor?: Color;
  shadowOffset?: Point2D;
  alignment: TextAlignment;
  verticalPosition: number;       // 0.0 (top) ~ 1.0 (bottom)
}

type TextAlignment = 'left' | 'center' | 'right';

interface CaptionAnimation {
  type: 'none' | 'fade' | 'slide' | 'typewriter' | 'bounce';
  duration?: number;
  params?: Record<string, any>;
}
```

---

## AI Model

### Proposal

```typescript
interface Proposal {
  id: string;
  prompt: string;
  status: ProposalStatus;
  editScript: EditScript;
  preview?: PreviewInfo;
  reasoning?: string;             // AI reasoning explanation
  createdAt: string;
  appliedAt?: string;
}

type ProposalStatus = 'pending' | 'ready' | 'applied' | 'rejected';

interface EditScript {
  commands: Command[];
  description: string;
}
```

### SearchQuery

```typescript
interface SearchQuery {
  text?: string;                  // Semantic search
  kind?: AssetKind[];
  tags?: string[];
  duration?: { min?: number; max?: number };
  dateRange?: { start?: string; end?: string };
  hasTranscript?: boolean;
  limit?: number;
  offset?: number;
}

interface SearchResult {
  assetId: AssetId;
  score: number;                  // Relevance score
  highlights?: SearchHighlight[];
}
```

---

## Index Model

### AssetIndex

```typescript
interface AssetIndex {
  assetId: AssetId;
  transcript?: Transcript;
  shots?: Shot[];
  faces?: FaceOccurrence[];
  objects?: ObjectOccurrence[];
  embedding?: number[];           // Vector embedding
  keywords?: string[];
  indexedAt: string;
}
```

### Transcript

```typescript
interface Transcript {
  language: string;               // ISO 639-1 code
  segments: TranscriptSegment[];
  fullText: string;
}

interface TranscriptSegment {
  start: number;                  // Seconds
  end: number;
  text: string;
  confidence: number;             // 0.0 ~ 1.0
  speaker?: string;               // Speaker ID
  words?: Word[];
}

interface Word {
  start: number;
  end: number;
  text: string;
  confidence: number;
}
```

### Shot

```typescript
interface Shot {
  start: number;                  // Seconds
  end: number;
  type: ShotType;
  thumbnail?: string;
}

type ShotType = 'cut' | 'dissolve' | 'fade' | 'unknown';
```
