# OpenReelio Edit Command Reference

This document describes all edit commands (Command) used in OpenReelio in detail.

---

## Table of Contents

1. [Command System Overview](#command-system-overview)
2. [Asset Commands](#asset-commands)
3. [Clip Commands](#clip-commands)
4. [Track Commands](#track-commands)
5. [Effect Commands](#effect-commands)
6. [Caption Commands](#caption-commands)
7. [Sequence Commands](#sequence-commands)
8. [Marker Commands](#marker-commands)

---

## Command System Overview

### Core Principles

1. **All edits via Command**: State changes must only occur through Commands.
2. **Undo/Redo support**: All Commands are reversible.
3. **Log storage**: All Commands are recorded in `ops.jsonl`.
4. **Atomicity**: Commands either completely succeed or completely fail.

### Command Structure

```typescript
interface Command {
  type: CommandType;        // Command type
  payload: CommandPayload;  // Command parameters
}

interface CommandResult {
  opId: OpId;               // Generated Operation ID
  changes: StateChange[];   // List of state changes
  createdIds: string[];     // Newly created IDs
  deletedIds: string[];     // Deleted IDs
}
```

### Command Execution Example

```typescript
// Execute command from Frontend
const result = await invoke('execute_command', {
  command: {
    type: 'SplitClip',
    payload: {
      clipId: 'clip_01HZ...',
      atTimelineSec: 5.5
    }
  }
});

// Handle result
console.log('Created clips:', result.createdIds);
```

---

## Asset Commands

### ImportAsset

Imports an external file as an asset to the project.

#### Payload

```typescript
interface ImportAssetPayload {
  // Required
  uri: string;                      // Source file path (absolute or URL)

  // Optional
  kind?: AssetKind;                 // Omit for auto-detection
  name?: string;                    // Display name (default: filename)
  copyToProject?: boolean;          // Copy to project (default: true)
  tags?: string[];                  // Tags
  license?: LicenseInfo;            // License info
}
```

#### Result

- createdIds contains new AssetId
- Proxy/thumbnail generation Jobs auto-start

#### Example

```typescript
// Video import
{
  type: 'ImportAsset',
  payload: {
    uri: '/Users/user/Videos/source.mp4',
    name: 'Interview Footage',
    tags: ['interview', 'main']
  }
}
```

### DeleteAsset

Deletes an asset from the project.

#### Payload

```typescript
interface DeleteAssetPayload {
  assetId: AssetId;
  force?: boolean;    // Delete even if in use (default: false)
}
```

---

## Clip Commands

### InsertClip

Inserts a clip at a specific position on the timeline.

#### Payload

```typescript
interface InsertClipPayload {
  trackId: TrackId;
  assetId: AssetId;
  timelineStart: number;            // Timeline start position (seconds)
  sourceStart?: number;             // Source start (default: 0)
  sourceEnd?: number;               // Source end (default: asset duration)
  transform?: Partial<Transform>;
  volume?: number;                  // Audio volume
}
```

### MoveClip

Moves an existing clip.

#### Payload

```typescript
interface MoveClipPayload {
  clipId: ClipId;
  newTrackId?: TrackId;             // Move to another track
  newTimelineStart: number;
}
```

### SplitClip

Splits a clip at a specific point.

#### Payload

```typescript
interface SplitClipPayload {
  clipId: ClipId;
  atTimelineSec: number;            // Split point (seconds)
}
```

#### Result

- Creates two new clips (left and right of split point)
- Original clip is deleted

### TrimClip

Trims clip start/end points.

#### Payload

```typescript
interface TrimClipPayload {
  clipId: ClipId;
  side: 'start' | 'end';
  newTimelineSec: number;           // New boundary position
}
```

### DeleteClip

Deletes a clip.

#### Payload

```typescript
interface DeleteClipPayload {
  clipId: ClipId;
  ripple?: boolean;                 // Adjust following clips (default: false)
}
```

### SetClipSpeed

Changes clip playback speed.

#### Payload

```typescript
interface SetClipSpeedPayload {
  clipId: ClipId;
  speed: number;                    // 1.0 = normal, 0.5 = half, 2.0 = double
  maintainPitch?: boolean;          // Maintain audio pitch (default: true)
}
```

### SetClipTransform

Changes clip transform properties.

#### Payload

```typescript
interface SetClipTransformPayload {
  clipId: ClipId;
  transform: Partial<Transform>;
}
```

### SetClipVolume

Changes clip audio volume.

#### Payload

```typescript
interface SetClipVolumePayload {
  clipId: ClipId;
  volume: number;                   // 0.0 ~ 2.0 (1.0 = 100%)
}
```

### SetClipOpacity

Changes clip opacity.

#### Payload

```typescript
interface SetClipOpacityPayload {
  clipId: ClipId;
  opacity: number;                  // 0.0 ~ 1.0
}
```

---

## Track Commands

### CreateTrack

Creates a new track.

#### Payload

```typescript
interface CreateTrackPayload {
  sequenceId: SequenceId;
  kind: TrackKind;                  // 'video' | 'audio' | 'caption'
  name?: string;
  insertAt?: number;                // Layer position (default: top)
}
```

### DeleteTrack

Deletes a track (including all clips).

#### Payload

```typescript
interface DeleteTrackPayload {
  trackId: TrackId;
}
```

### ReorderTrack

Changes track order.

#### Payload

```typescript
interface ReorderTrackPayload {
  trackId: TrackId;
  newIndex: number;
}
```

### SetTrackVisibility

Changes video track visibility.

#### Payload

```typescript
interface SetTrackVisibilityPayload {
  trackId: TrackId;
  visible: boolean;
}
```

### SetTrackMute

Changes audio track mute state.

#### Payload

```typescript
interface SetTrackMutePayload {
  trackId: TrackId;
  muted: boolean;
}
```

### SetTrackLock

Changes track lock state.

#### Payload

```typescript
interface SetTrackLockPayload {
  trackId: TrackId;
  locked: boolean;
}
```

---

## Effect Commands

### AddEffect

Adds an effect to a clip.

#### Payload

```typescript
interface AddEffectPayload {
  clipId: ClipId;
  effectType: EffectType;
  params?: Record<string, any>;
  insertAt?: number;                // Effect order (default: end)
}
```

### RemoveEffect

Removes an effect.

#### Payload

```typescript
interface RemoveEffectPayload {
  effectId: EffectId;
}
```

### SetEffectParams

Changes effect parameters.

#### Payload

```typescript
interface SetEffectParamsPayload {
  effectId: EffectId;
  params: Record<string, any>;
}
```

### SetEffectEnabled

Toggles effect on/off.

#### Payload

```typescript
interface SetEffectEnabledPayload {
  effectId: EffectId;
  enabled: boolean;
}
```

### ReorderEffects

Changes effect application order.

#### Payload

```typescript
interface ReorderEffectsPayload {
  clipId: ClipId;
  effectIds: EffectId[];            // New order
}
```

### AddKeyframe

Adds an effect keyframe.

#### Payload

```typescript
interface AddKeyframePayload {
  effectId: EffectId;
  time: number;                     // Seconds
  value: Record<string, any>;
  easing?: EasingType;
}
```

### RemoveKeyframe

Removes a keyframe.

#### Payload

```typescript
interface RemoveKeyframePayload {
  effectId: EffectId;
  time: number;                     // Time of keyframe to remove
}
```

---

## Caption Commands

### CreateCaption

Creates a new caption.

#### Payload

```typescript
interface CreateCaptionPayload {
  trackId: TrackId;
  text: string;
  startTime: number;                // Seconds
  endTime: number;
  style?: Partial<CaptionStyle>;
}
```

### UpdateCaption

Updates caption text or timing.

#### Payload

```typescript
interface UpdateCaptionPayload {
  captionId: CaptionId;
  text?: string;
  startTime?: number;
  endTime?: number;
}
```

### SetCaptionStyle

Changes caption style.

#### Payload

```typescript
interface SetCaptionStylePayload {
  captionId: CaptionId;
  style: Partial<CaptionStyle>;
}
```

### DeleteCaption

Deletes a caption.

#### Payload

```typescript
interface DeleteCaptionPayload {
  captionId: CaptionId;
}
```

### ImportCaptions

Imports captions from subtitle file.

#### Payload

```typescript
interface ImportCaptionsPayload {
  trackId: TrackId;
  uri: string;                      // SRT, VTT file path
  offset?: number;                  // Time offset (seconds)
}
```

---

## Sequence Commands

### CreateSequence

Creates a new sequence.

#### Payload

```typescript
interface CreateSequencePayload {
  name: string;
  format: SequenceFormat;
}
```

### DeleteSequence

Deletes a sequence.

#### Payload

```typescript
interface DeleteSequencePayload {
  sequenceId: SequenceId;
}
```

### SetSequenceFormat

Changes sequence format.

#### Payload

```typescript
interface SetSequenceFormatPayload {
  sequenceId: SequenceId;
  format: Partial<SequenceFormat>;
}
```

---

## Marker Commands

### AddMarker

Adds a marker.

#### Payload

```typescript
interface AddMarkerPayload {
  sequenceId: SequenceId;
  time: number;                     // Seconds
  label?: string;
  color?: string;
}
```

### UpdateMarker

Updates a marker.

#### Payload

```typescript
interface UpdateMarkerPayload {
  markerId: string;
  time?: number;
  label?: string;
  color?: string;
}
```

### DeleteMarker

Deletes a marker.

#### Payload

```typescript
interface DeleteMarkerPayload {
  markerId: string;
}
```

---

## Command Batching

### Batch Execution

Execute multiple commands atomically.

```typescript
const result = await invoke('execute_batch', {
  commands: [
    { type: 'SplitClip', payload: { clipId: 'clip_01', atTimelineSec: 5 } },
    { type: 'DeleteClip', payload: { clipId: 'clip_01_right' } },
    { type: 'AddEffect', payload: { clipId: 'clip_01_left', effectType: 'fade' } }
  ],
  atomic: true  // All or nothing
});
```

### Command Merging

Consecutive commands of the same type may be merged:

- Continuous text input -> single UpdateCaption
- Continuous position changes -> single SetClipTransform
- Continuous volume adjustments -> single SetClipVolume
