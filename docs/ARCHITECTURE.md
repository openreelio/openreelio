# OpenReelio Architecture Document

This document describes the complete system architecture of OpenReelio.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Process Structure](#process-structure)
3. [Core Engine](#core-engine)
4. [Render Pipeline](#render-pipeline)
5. [AI Agent System](#ai-agent-system)
6. [Plugin System](#plugin-system)
7. [Data Flow](#data-flow)

---

## System Overview

OpenReelio uses a Tauri 2.0 desktop application architecture with:

- **Frontend**: React 18 + TypeScript + Zustand WebView with Timeline, Preview, Explorer, and Prompt/Chat components
- **Core Service**: Rust-based engine with Command Engine, Timeline Engine, Asset Manager, Project Manager
- **State Manager**: Event sourcing with ops.jsonl (Event Log) and snapshot.json (State Cache)
- **Worker Pool**: FFmpeg workers for heavy processing
- **AI Gateway**: Integration with OpenAI/Anthropic/Local LLM
- **Plugin Host**: WASM-based plugin execution

### Project Folder Structure

- .openreelio/state/project.json - Project metadata
- .openreelio/state/ops.jsonl - Operation log (append-only)
- .openreelio/state/snapshot.json - Snapshot cache (rebuildable)
- .openreelio/workspace_index.db - Workspace scan/registration index
- assets/ - Asset files
- cache/ - Cache files

---

## Process Structure

### Multi-Process Design

| Process      | Role                                 | Characteristics        |
| ------------ | ------------------------------------ | ---------------------- |
| Main Process | UI + IPC                             | No blocking allowed    |
| Core Service | State management, command processing | Single source of truth |
| Worker Pool  | Heavy operations                     | Parallel processing    |
| Plugin Host  | WASM plugin execution                | Sandbox isolation      |

### Communication Methods

```rust
// Frontend to Core (IPC via Tauri Commands)
#[tauri::command]
async fn execute_command(command: Command) -> Result<CommandResult, Error> {
    // Forward to Core Service
}

// Core to Worker (Channel-based job queue)
pub struct JobChannel {
    sender: mpsc::Sender<Job>,
    receiver: mpsc::Receiver<JobResult>,
}
```

---

## Core Engine

### Module Structure

```
src-tauri/src/core/
├── mod.rs              # Module definitions
├── types.rs            # Common types
├── error.rs            # Error definitions
├── commands/           # Edit commands
│   ├── traits.rs       # Command trait
│   ├── clip.rs         # Clip-related commands
│   ├── track.rs        # Track-related commands
│   └── effect.rs       # Effect-related commands
├── timeline/           # Timeline logic
├── assets/             # Asset management
├── project/            # Project management
└── render/             # Render pipeline
```

### Command Pattern

All edit commands implement the Command trait:

```rust
pub trait Command: Send + Sync {
    fn execute(&self, state: &mut ProjectState) -> Result<CommandResult, CommandError>;
    fn undo(&self, state: &mut ProjectState) -> Result<(), CommandError>;
    fn redo(&self, state: &mut ProjectState) -> Result<CommandResult, CommandError>;
    fn type_name(&self) -> &'static str;
    fn to_json(&self) -> serde_json::Value;
}
```

### Command Execution Flow

1. User Action / AI EditScript
2. Create Command
3. Validation (return error on failure)
4. Command.execute() - Modify state, generate result
5. OpsLog.append() - Record to ops.jsonl
6. Emit event - Notify UI of changes
7. Return result

### Event Sourcing

ops.jsonl is the source of truth. All operations are appended to this log.
snapshot.json is a cached state for faster startup, rebuilt from ops.jsonl.

---

## Render Pipeline

### Render Graph Nodes

- **Decode**: Source decoding from asset files
- **Transform**: Position, size, rotation transformations
- **Effect**: Visual/audio effect application
- **Composite**: Layer compositing
- **Caption**: Caption/subtitle rendering
- **AudioMix**: Audio mixing
- **Encode**: Output encoding

### Render Process

1. Sequence (Timeline State)
2. Graph Builder - Convert sequence to render graph
3. Cache Check - Hash-based cache lookup
4. Graph Optimization - Node merging, remove unnecessary ops
5. Graph Execution - FFmpeg/GPU rendering
6. Cache Storage
7. Output Frame

### Preview vs Final Render

| Item       | Preview           | Final Render     |
| ---------- | ----------------- | ---------------- |
| Source     | Proxy             | Original         |
| Resolution | 720p              | Original/Config  |
| Codec      | Fast decoding     | High quality     |
| Effects    | Can be simplified | Full application |
| Cache      | Actively used     | As needed        |

---

## AI Agent System

> **Current State (2026-04-03)**: OpenReelio retains three AI execution paths: a legacy/internal `aiStore` -> `chat_with_ai` request-response flow, the canonical TPAO `AgenticEngine`, and the compatibility `AgentLoop` runtime. The shipping AI sidebar uses TPAO only; `AgentLoop` remains available for internal verification and harness coverage. See [AGENT_IMPLEMENTATION_MASTER_PLAN.md](./AGENT_IMPLEMENTATION_MASTER_PLAN.md) for the current stabilization plan.

### Architecture Overview

OpenReelio currently has three distinct AI paths:

1. **Legacy AI Path**: Internal request-response flows centered on `aiStore` and `chat_with_ai`
2. **TPAO Runtime**: Full Think → Plan → Act → Observe loop via `AgenticEngine`
3. **Compatibility Runtime**: Streaming `AgentLoop` that follows stream → tool → loop for internal verification

The TPAO and fast runtimes already share significant operational infrastructure:

- Session persistence and recovery artifacts
- Permission audit records
- Compaction and resume checkpoints
- Backend-safe tool execution

### Runtime Matrix

| Runtime | Primary Entry Points | Current Role |
| ------- | -------------------- | ------------ |
| Legacy AI Path | `src/stores/aiStore.ts`, `chat_with_ai` | Legacy / internal compatibility surface |
| TPAO Runtime | `src/agents/engine/AgenticEngine.ts`, `src/hooks/useAgenticLoop.ts`, `src/components/features/agent/AgenticChat.tsx` | Canonical interactive runtime |
| Compatibility Runtime | `src/agents/engine/AgentLoop.ts`, `src/hooks/useAgentLoop.ts`, `src/components/features/agent/AgentLoopChat.tsx` | Internal compatibility runtime |

### TPAO Runtime Architecture

The TPAO runtime implements the **Think → Plan → Act → Observe (TPAO)** cycle:

```
┌─────────────────────────────────────────────────────────────────┐
│                     AgentEngine (Orchestrator)                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    │
│   │  THINK  │ → │  PLAN   │ → │   ACT   │ → │ OBSERVE │    │
│   │ Analyze │    │ Strategy│    │ Execute │    │ Verify  │    │
│   └─────────┘    └─────────┘    └─────────┘    └─────────┘    │
│        ↑                                            │          │
│        └────────────── Continue if needed ──────────┘          │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Ports (Abstractions)           Adapters (Implementations)      │
│  ├─ LLMPort                     ├─ AnthropicAdapter             │
│  ├─ ToolPort                    ├─ OpenAIAdapter                │
│  └─ ApprovalPort                └─ LocalLLMAdapter              │
└─────────────────────────────────────────────────────────────────┘
```

### Key Components (Implemented)

| Component               | Location                                                  | Purpose                                             |
| ----------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| **AgenticEngine**       | `src/agents/engine/AgenticEngine.ts`                      | Orchestrates the TPAO loop, manages turns and state |
| **Thinker**             | `src/agents/engine/phases/Thinker.ts`                     | Analyzes user intent and requirements               |
| **Planner**             | `src/agents/engine/phases/Planner.ts`                     | Generates execution plans with risk assessment      |
| **Executor**            | `src/agents/engine/phases/Executor.ts`                    | Executes tools with checkpointing                   |
| **Observer**            | `src/agents/engine/phases/Observer.ts`                    | Evaluates results and determines next steps         |
| **ILLMClient**          | `src/agents/engine/ports/ILLMClient.ts`                   | Abstract interface for LLM providers                |
| **TauriLLMAdapter**     | `src/agents/engine/adapters/llm/TauriLLMAdapter.ts`       | Bridges to Tauri backend AI providers               |
| **ToolRegistryAdapter** | `src/agents/engine/adapters/tools/ToolRegistryAdapter.ts` | Bridges to existing tool registry                   |
| **useAgenticLoop**      | `src/hooks/useAgenticLoop.ts`                             | React hook for agentic loop integration             |
| **AgenticChat**         | `src/components/features/agent/AgenticChat.tsx`           | Main chat UI component                              |
| **ThinkingIndicator**   | `src/components/features/agent/ThinkingIndicator.tsx`     | Shows AI thinking process                           |
| **PlanViewer**          | `src/components/features/agent/PlanViewer.tsx`            | Displays and approves plans                         |
| **ActionFeed**          | `src/components/features/agent/ActionFeed.tsx`            | Real-time action progress                           |

### Compatibility Runtime Components

| Component | Location | Purpose |
| --------- | -------- | ------- |
| **AgentLoop** | `src/agents/engine/AgentLoop.ts` | Streaming-first compatibility runtime that lets the model decide tool usage implicitly |
| **useAgentLoop** | `src/hooks/useAgentLoop.ts` | React hook for compatibility-runtime verification |
| **AgentLoopChat** | `src/components/features/agent/AgentLoopChat.tsx` | Compatibility-only chat UI for internal verification |
| **useAgentLoopEventHandler** | `src/hooks/useAgentLoopEventHandler.ts` | Bridges loop events into conversation parts |

### Tool Categories

1. **Timeline Tools**: move_clip, trim_clip, split_clip, delete_clip, insert_clip
2. **Effect Tools**: add_effect, remove_effect, update_effect_params
3. **Analysis Tools**: analyze_clip, get_clip_info, get_timeline_state
4. **Audio Tools**: adjust_volume, add_audio_effect
5. **Caption Tools**: add_caption, edit_caption, sync_captions
6. **Transition Tools**: add_transition, update_transition

### Project Memory

Stores user preferences, styles, and context for better AI suggestions.

---

## Plugin System

### WASM Host Structure

- Wasmtime Engine for WASM execution
- Multiple sandboxed plugin instances
- Permission Manager for access control

### Permission System

```rust
pub struct PluginPermissions {
    pub fs: Vec<FsPermission>,      // Filesystem access
    pub net: Vec<NetPermission>,    // Network access
    pub models: Vec<String>,        // AI model usage
    pub project: ProjectPermission, // Project data access
}
```

### Plugin Lifecycle

1. **Load** - Parse manifest.json, validate permissions, load WASM
2. **Initialize** - Call plugin init(), allocate resources
3. **Execute** - Host calls interface methods, plugin returns responses
4. **Unload** - Clean up resources, release WASM instance

---

## Data Flow

### Edit Operation Flow

1. Frontend (Timeline.tsx) - User action
2. useTimelineStore().splitClip() - Create command
3. IPC invoke - Send to core
4. Core CommandEngine.execute() - Process command
5. EventEmitter - Emit state change
6. IPC event - Notify frontend
7. Zustand Store update - Update state
8. React re-render - Update UI

### AI Edit Flow (Agentic Mode)

1. Frontend (AgenticChat.tsx) - User prompt
2. useAgenticLoop.run() - Start agentic session
3. **THINK**: Thinker analyzes intent via LLM
4. **PLAN**: Planner generates steps with risk levels
5. ApprovalGate (if high risk) - User confirms plan
6. **ACT**: Executor runs tools via ToolRegistryAdapter
7. **OBSERVE**: Observer evaluates results
8. Loop back to THINK if needed
9. Session complete - Update UI with results

### AI Edit Flow (Legacy Internal Mode)

1. Internal caller (`aiStore.sendMessage`) - Legacy prompt
2. IPC `chat_with_ai` - Send to core
3. Core AI Gateway - Process with LLM
4. EditScript generation - Create commands
5. Proposal creation - Package for review
6. Legacy/internal UI flow consumes the response
7. User Apply - Confirm changes
8. Execute commands - Apply to state
9. Update UI

---

## Performance Considerations

### Memory Management

- Asset streaming with chunked buffers
- Cache size limits (proxy: 2048MB, thumbnails: 256MB, preview: 512MB)

### Thread Pool Configuration

```rust
pub struct WorkerConfig {
    pub proxy_workers: usize,  // Default: CPU cores / 2
    pub render_workers: usize, // Default: 2
    pub index_workers: usize,  // Default: 2
    pub ai_workers: usize,     // Default: 4
}
```

### GPU Utilization (Optional)

- Hardware decode/encode
- GPU effect processing
- Supported APIs: CUDA, VCE, QSV
