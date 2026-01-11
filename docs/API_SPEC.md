# OpenReelio API Specification

This document defines the IPC API between Frontend and Core, as well as internal APIs.

---

## Table of Contents

1. [IPC API (Tauri Commands)](#ipc-api-tauri-commands)
2. [Event API](#event-api)
3. [Worker API](#worker-api)
4. [Plugin API](#plugin-api)
5. [Error Codes](#error-codes)

---

## IPC API (Tauri Commands)

Tauri Commands that Frontend uses to call Rust Core.

### Project Management

#### `create_project`

Creates a new project.

```typescript
// Request
interface CreateProjectRequest {
  name: string;
  path: string;                     // Project folder path
  format?: SequenceFormat;          // Default sequence format
}

// Response
interface CreateProjectResponse {
  projectId: string;
  projectPath: string;
}
```

#### `open_project`

Opens an existing project.

```typescript
interface OpenProjectRequest {
  path: string;
}

interface OpenProjectResponse {
  projectId: string;
  state: ProjectState;
}
```

#### `save_project`

Saves the current project.

#### `close_project`

Closes the project.

#### `get_project_state`

Retrieves the current project state.

---

### Command Execution

#### `execute_command`

Executes an edit command.

```typescript
interface ExecuteCommandRequest {
  command: Command;
}

interface ExecuteCommandResponse {
  opId: OpId;
  changes: StateChange[];
  createdIds: string[];
  deletedIds: string[];
}
```

#### `execute_batch`

Executes multiple commands atomically.

#### `undo`

Undoes the last command.

#### `redo`

Redoes the undone command.

---

### Asset Management

#### `import_asset`

Imports an asset to the project.

```typescript
interface ImportAssetRequest {
  uri: string;                      // Source file path
  kind?: AssetKind;                 // Auto-detect if omitted
  copyToProject?: boolean;          // Copy or link
}

interface ImportAssetResponse {
  asset: Asset;
  jobIds: JobId[];                  // Proxy/thumbnail generation jobs
}
```

#### `get_asset`

Retrieves asset information.

#### `list_assets`

Lists all project assets.

#### `delete_asset`

Deletes an asset (fails if in use).

---

### Timeline

#### `get_sequence`

Retrieves sequence information with tracks and clips.

#### `get_clip`

Retrieves clip information.

#### `get_clips_in_range`

Gets clips within a specific time range.

---

### Rendering

#### `request_preview`

Requests a preview frame.

```typescript
interface RequestPreviewRequest {
  sequenceId: SequenceId;
  timeSec: TimeSec;
  quality: 'low' | 'medium' | 'high';
}

interface RequestPreviewResponse {
  frameUri: string;                 // Rendered frame path
  cached: boolean;
}
```

#### `start_preview_stream`

Starts preview streaming.

#### `stop_preview_stream`

Stops preview streaming.

#### `start_render`

Starts final rendering.

```typescript
interface StartRenderRequest {
  sequenceId: SequenceId;
  outputPath: string;
  settings: RenderSettings;
}

interface RenderSettings {
  format: 'mp4' | 'mov' | 'webm';
  videoCodec: 'h264' | 'hevc' | 'vp9';
  videoBitrate?: number;
  audioCodec: 'aac' | 'opus' | 'mp3';
  audioBitrate?: number;
  resolution?: { width: number; height: number };
  fps?: Ratio;
}
```

#### `cancel_render`

Cancels rendering.

---

### AI Agent

#### `ai_request`

Sends an editing request to AI.

```typescript
interface AIRequestRequest {
  prompt: string;
  context?: {
    selectedClipIds?: ClipId[];
    timeRange?: TimeRange;
  };
}

interface AIRequestResponse {
  proposalId: string;
  status: 'processing' | 'ready';
}
```

#### `get_proposal`

Retrieves AI proposal.

#### `apply_proposal`

Applies AI proposal.

#### `reject_proposal`

Rejects AI proposal.

#### `revise_proposal`

Requests AI proposal revision.

---

### Search

#### `search_assets`

Searches assets.

---

### Job Management

#### `get_job_status`

Retrieves job status.

```typescript
interface GetJobStatusResponse {
  jobId: JobId;
  type: JobType;
  status: JobStatus;
  progress?: number;                // 0.0 ~ 1.0
  message?: string;
  result?: any;
  error?: string;
}
```

#### `list_jobs`

Lists current jobs.

#### `cancel_job`

Cancels a job.

---

## Event API

Events sent from Core to Frontend.

### State Change Events

#### `state_changed`

Emitted when project state changes.

```typescript
interface StateChangedEvent {
  changes: StateChange[];
  opId: OpId;
}

// Subscribe
listen('state_changed', (event) => {
  const { changes, opId } = event.payload;
  // Update Store
});
```

#### `sequence_updated`

Emitted when sequence is updated.

---

### Job Events

#### `job_progress`

Job progress update.

```typescript
interface JobProgressEvent {
  jobId: JobId;
  progress: number;                 // 0.0 ~ 1.0
  message?: string;
  etaSec?: number;
}
```

#### `job_completed`

Job completed.

#### `job_failed`

Job failed.

---

### AI Events

#### `proposal_ready`

AI proposal is ready.

#### `ai_thinking`

AI is processing.

---

### Preview Events

#### `preview_frame_ready`

Preview frame is ready.

---

## Worker API

Internal communication API between Core and Worker.

### Job Message Format

```rust
// Job request
pub struct JobMessage {
    pub id: JobId,
    pub job_type: JobType,
    pub priority: Priority,
    pub payload: serde_json::Value,
    pub cancel_token: CancellationToken,
}

// Job result
pub struct JobResult {
    pub id: JobId,
    pub status: JobResultStatus,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub duration_ms: u64,
}
```

### Job Types

- ProxyGeneration
- ThumbnailGeneration
- Indexing (ShotDetection, Transcription, FaceDetection, ObjectDetection, Embedding)
- FinalRender

---

## Plugin API

API for WASM plugins to communicate with the host.

### Host Functions (called by plugin)

```rust
fn host_log(level: LogLevel, message: &str);
fn host_get_asset(asset_id: &str) -> Option<AssetInfo>;
fn host_read_file(path: &str) -> Result<Vec<u8>, Error>;
fn host_write_file(path: &str, data: &[u8]) -> Result<(), Error>;
fn host_http_request(request: HttpRequest) -> Result<HttpResponse, Error>;
fn host_ai_complete(request: AIRequest) -> Result<AIResponse, Error>;
```

### Plugin Exports (called by host)

```rust
// AssetProvider interface
fn plugin_search(query_json: &str) -> String;
fn plugin_fetch(asset_ref: &str) -> Vec<u8>;
fn plugin_get_license(asset_ref: &str) -> String;

// EditAssistant interface
fn plugin_propose(context_json: &str) -> String;

// EffectPresetProvider interface
fn plugin_list_presets() -> String;
fn plugin_apply_preset(preset_id: &str, params_json: &str) -> String;
```

---

## Error Codes

### Error Response Format

```typescript
interface APIError {
  code: ErrorCode;
  message: string;
  details?: Record<string, any>;
}
```

### Error Code List

| Code | Description |
|------|-------------|
| `PROJECT_NOT_FOUND` | Project not found |
| `PROJECT_ALREADY_OPEN` | Project already open |
| `PROJECT_CORRUPTED` | Project file corrupted |
| `ASSET_NOT_FOUND` | Asset not found |
| `ASSET_IN_USE` | Asset in use |
| `ASSET_IMPORT_FAILED` | Asset import failed |
| `CLIP_NOT_FOUND` | Clip not found |
| `TRACK_NOT_FOUND` | Track not found |
| `SEQUENCE_NOT_FOUND` | Sequence not found |
| `INVALID_COMMAND` | Invalid command |
| `COMMAND_FAILED` | Command execution failed |
| `INVALID_RANGE` | Invalid time range |
| `RENDER_FAILED` | Render failed |
| `JOB_NOT_FOUND` | Job not found |
| `JOB_CANCELLED` | Job cancelled |
| `AI_REQUEST_FAILED` | AI request failed |
| `PROPOSAL_NOT_FOUND` | Proposal not found |
| `PERMISSION_DENIED` | Permission denied |
| `PLUGIN_ERROR` | Plugin error |
| `IO_ERROR` | File IO error |
| `INTERNAL_ERROR` | Internal error |
