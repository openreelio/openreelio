# Codex And External Agent Integration Design Plan

Status: Proposed
Date: 2026-05-10
Scope: Product architecture, implementation plan, security model, and OpenSpec impact for using Codex and other external AI agents inside or alongside OpenReelio.

## Executive Decision

OpenReelio should integrate Codex through the official Codex app-server, MCP, and plugin surfaces. It should not merge the Codex OAuth PR as-is, and it should not turn a user's Codex or ChatGPT login into an OpenAI API key for the existing OpenReelio LLM provider stack.

This should be implemented as the first adapter of a broader External Agent Host architecture. Codex is the reference integration because it has an official app-server protocol suitable for embedding in a rich desktop client, but the OpenReelio side of the design must be agent-vendor-neutral.

The target product shape is:

1. The OpenReelio sidebar remains the canonical user-facing AI surface.
2. Codex becomes the first optional local agent bridge that can run under the user's existing Codex account.
3. Other agents can integrate through the same External Agent Host adapter model or through OpenReelio's MCP server.
4. OpenReelio gives external agents safe, product-specific tools through an OpenReelio MCP server and existing command/plan execution paths.
5. All edits still flow through OpenReelio's event-sourced command log, plan validation, approval gates, and rollback semantics.

This gives users the benefit they actually want: use their Codex subscription and agent quality inside OpenReelio without paying separate API usage for normal API-key providers. It also avoids relying on private ChatGPT/Codex OAuth token exchange behavior.

## Evidence From Official Sources

Reviewed on 2026-05-10.

- Codex CLI can be installed with `npm i -g @openai/codex`, runs locally, and prompts the user to authenticate with either ChatGPT or an API key on first use: https://developers.openai.com/codex/cli
- Codex app-server is the documented interface for embedding Codex in rich clients. It supports JSON-RPC over stdio by default, streams agent events, supports approvals, and exposes auth/account endpoints for ChatGPT-managed auth state: https://developers.openai.com/codex/app-server
- Codex SDK is intended for programmatic integration and internal workflows. The TypeScript SDK is server-side and the Python SDK wraps local app-server JSON-RPC: https://developers.openai.com/codex/sdk
- Codex MCP configuration lets Codex access local or HTTP MCP servers. STDIO MCP servers are first-class and can be configured through Codex CLI or config files: https://developers.openai.com/codex/mcp
- Codex plugins can bundle skills, MCP server config, app mappings, hooks, and assets. A `.codex-plugin/plugin.json` manifest is required, and `.mcp.json` can point Codex at bundled MCP servers: https://developers.openai.com/codex/plugins and https://developers.openai.com/codex/plugins/build
- Codex IDE integrations are powered by the same Codex harness through app-server. OpenAI notes that the IDE extension works in VS Code, Cursor, and VS Code forks, and can use context such as opened files and selected code for shorter prompts and faster results: https://openai.com/index/unlocking-the-codex-harness/ and https://openai.com/index/introducing-upgrades-to-codex/
- ChatGPT subscriptions and OpenAI API billing are managed separately. API usage remains separately billed by token usage: https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform and https://help.openai.com/en/articles/8156019-how-can-i-move-my-chatgpt-subscription-to-the-api
- Claude Code supports MCP servers for external tools and data sources, and the Claude Code SDK supports MCP configuration for agent queries: https://docs.claude.com/en/docs/claude-code/mcp and https://docs.claude.com/en/docs/claude-code/sdk/sdk-mcp
- Claude Code's VS Code extension provides native IDE context such as selection/current tab sharing, inline diffs, plan review, file mentions with line ranges, checkpoints, and conversation history: https://code.claude.com/docs/en/ide-integrations
- Gemini CLI supports MCP servers through `mcpServers` configuration: https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
- Cursor CLI supports MCP servers for `cursor-agent`, and Cursor CLI detects MCP configuration used by the IDE: https://docs.cursor.com/cli/mcp and https://docs.cursor.com/en/cli/using
- Cursor MCP can expose tools, prompts, resources, roots, and elicitation, and Cursor's CLI uses the same MCP configuration and rules system as the IDE: https://docs.cursor.com/advanced/model-context-protocol and https://docs.cursor.com/en/cli/using
- VS Code supports MCP servers in Copilot Chat, discovers server tools, lets users manage MCP servers, and lets extensions contribute first-class language-model tools backed by VS Code APIs such as active tabs: https://code.visualstudio.com/docs/copilot/customization/mcp-servers and https://code.visualstudio.com/api/extension-guides/ai/tools
- MCP clients send `clientInfo` during initialization, which OpenReelio can use as a weak signal for the host client name/version while still relying on explicit host context for correctness: https://modelcontextprotocol.io/specification/2025-06-18/schema
- Agent Client Protocol defines a client-agent relationship where the client and agent negotiate capabilities, create sessions, send prompts, handle file operations, permission requests, and cancellation. This is closer to IDE-grade hosting than MCP alone: https://agentclientprotocol.com/protocol/overview
- OpenCode supports MCP servers in its config under `mcp`: https://opencode.ai/docs/mcp-servers/
- Kimi CLI supports MCP tools and also supports IDE integration through Agent Client Protocol: https://www.kimi.com/code/docs/en/kimi-cli.html
- Qwen Code supports MCP server configuration and CLI management commands: https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/
- xAI documents remote MCP tools for Grok through its SDK and OpenAI-compatible Responses API: https://docs.x.ai/docs/guides/tools/remote-mcp-tools

## Why Not Merge PR #511 As-Is

The PR direction is understandable, but it optimizes for the wrong integration boundary.

Problems with the PR direction:

- It treats Codex/ChatGPT auth as a way to feed the existing API provider stack. That crosses billing and auth boundaries that OpenAI documents as separate.
- It depends on non-core/private surfaces around `chatgpt.com/backend-api` and OAuth-to-API-key behavior rather than the official Codex integration APIs.
- It expands the model provider abstraction even though Codex is an agent runtime, not just another chat completion provider.
- It conflicts with the existing OpenSpec governance that says OpenReelio must have one canonical interactive runtime surface and must not expose compatibility runtimes as normal product paths.
- It creates higher security risk because OpenReelio would need to store, refresh, or proxy account tokens instead of letting Codex own its auth lifecycle.

Useful idea to keep from the PR:

- Users prefer subscription-based Codex usage over separate API-key billing.

Decision:

- Close or supersede PR #511 with a new Codex bridge proposal.
- Do not port its credential provider changes.
- Do not add `openai-codex-oauth` as a normal `ProviderType`.

## Current OpenReelio Integration Points

The existing codebase already has the right primitives for a safe external agent bridge.

Frontend AI surface:

- `src/components/features/ai/AISidebar.tsx` owns the visible sidebar shell, provider status, settings, and chat reset behavior.
- `src/components/features/agent/AgenticSidebarContent.tsx` mounts the canonical agent experience and wires the agent engine, LLM adapter, tool executor, project prompt context, and memory adapter.
- `src/config/featureFlags.ts` currently keeps `USE_AGENTIC_ENGINE` enabled, `USE_BACKEND_TOOLS` enabled, and defines the canonical sidebar runtime as TPAO.

Agent runtime:

- `src/agents/engine/AgenticEngine.ts` owns the Think/Plan/Act/Observe orchestration.
- `src/agents/engine/ports/ILLMClient.ts` defines the LLM adapter boundary.
- `src/agents/engine/adapters/llm/TauriLLMAdapter.ts` bridges frontend agent calls to backend AI providers.
- `src/agents/engine/adapters/tools/BackendToolExecutor.ts` already routes backend-safe editing tools through `execute_agent_plan`, validates mutating operations, and separates frontend-only high-level tools from backend-direct tools.

Backend command and plan execution:

- `src-tauri/src/core/ai/agent_plan.rs` defines agent plan and step result structures.
- `src-tauri/src/core/ai/plan_executor.rs` handles plan execution, command payload parsing, dependencies, rollback, and project save behavior.
- `src-tauri/src/ipc/payloads.rs` defines strict command payload schemas for editing operations.
- `crates/openreelio-cli/src/commands/command.rs`, `plan.rs`, and `help_json.rs` expose machine-readable command execution, validation, and help JSON that can be reused as an agent tool contract.

Conversation persistence:

- `src-tauri/src/core/ai/conversation_commands.rs` already has DTOs for sessions, runs, delegation records, permission decisions, and `runtime_kind`.

The lowest-risk design is to connect Codex to those existing boundaries instead of creating a parallel editor mutation path.

## Target Architecture

The durable architecture is a vendor-neutral External Agent Host. Codex is one adapter.

```text
OpenReelio AI Sidebar
  ExternalAgentHost
    AgentRuntimeAdapter
      CodexAdapter
      ClaudeCodeAdapter
      GeminiCliAdapter
      CursorCliAdapter
      OpenCodeAdapter
      KimiCliAdapter
      QwenCodeAdapter
      ApiModelAgentAdapter
    OpenReelioMcpServer
      read-only project context tools
      command schema and validation tools
      approval-gated mutation tools
    AgentApprovalGateway
      approval tokens
      permission audit
      rollback reports
```

In-app Codex reference path:

```text
OpenReelio AI Sidebar
  AgenticSidebarContent
    ExternalAgentHost
      CodexAgentBridge
      Tauri IPC
        CodexProcessManager
          codex app-server over stdio JSON-RPC
        OpenReelioMcpServer
          timeline/project read tools
          command schema and validation tools
          approved plan apply tool
        execute_agent_plan
          command log
          rollback
          project save
```

External agent path:

```text
Codex / Claude Code / Gemini CLI / Cursor / OpenCode / Kimi / Qwen
  OpenReelio MCP configuration
  OpenReelio agent instructions or plugin
    OpenReelio MCP server
      command schema
      timeline context
      plan validation
      approved plan apply
```

Two integration surfaces should be built together:

1. In-app bridge: best user experience inside OpenReelio.
2. External agent integration: lets users ask their preferred agent directly for OpenReelio help with the same MCP tools and product knowledge.

## External Agent Host Abstraction

OpenReelio should define one internal adapter interface for all third-party agent runtimes:

```ts
interface ExternalAgentRuntimeAdapter {
  id: string;
  displayName: string;
  detect(): Promise<AgentRuntimeStatus>;
  authStatus(): Promise<AgentAuthStatus>;
  capabilities(): Promise<AgentRuntimeCapabilities>;
  startSession(input: StartAgentSessionInput): Promise<AgentSessionHandle>;
  sendMessage(sessionId: string, message: AgentUserMessage): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  shutdown(sessionId: string): Promise<void>;
}
```

Capabilities should be explicit:

- `streamingEvents`: can stream deltas/events into the OpenReelio sidebar.
- `interrupt`: can stop an active turn.
- `mcpClient`: can connect to OpenReelio MCP tools.
- `approvalAware`: can surface tool approval events or be wrapped by OpenReelio's approval gateway.
- `localAccountAuth`: can use the user's app subscription or local account login without OpenReelio handling tokens.
- `sessionResume`: can resume previous threads.
- `structuredToolCalls`: can return structured MCP/tool call results.

Supported transports:

- `stdio-jsonrpc`: Codex app-server style. Best for in-app embedding.
- `sdk`: Claude Code SDK style or future vendor SDKs. Good if streaming, MCP, interrupt, and auth are officially supported.
- `cli-interactive`: terminal-like subprocess. Acceptable for external use and experiments, weaker for polished in-app UX.
- `cli-noninteractive`: one-shot command execution. Useful for background tasks, not ideal for live editing chat.
- `mcp-only`: OpenReelio exposes tools; the agent runs outside OpenReelio.
- `api-remote-mcp`: vendor API calls remote MCP tools. Useful for model providers such as Grok/xAI, but usually does not satisfy the "use my desktop subscription agent inside OpenReelio" goal.
- `acp`: Agent Client Protocol, if the agent exposes it and it can be hosted safely.

The adapter contract protects OpenReelio from vendor churn. A new agent should only need:

1. A runtime adapter if it is embedded in-app.
2. An MCP configuration template if it is external-only.
3. Optional instructions/skills/rules that teach the agent OpenReelio editing semantics.

## Host-Native Context And Tools

MCP is necessary, but it is not enough for IDE-grade UX.

Agents feel substantially better in VS Code, Cursor, Claude Code, and Codex IDE extensions because the host continuously contributes native context and native tools:

- Active file, current tab, selected lines, and open editors.
- Workspace roots and project-level rules.
- Diagnostics, lint errors, syntax errors, and test output.
- Diff previews and plan review UI.
- Checkpoints, undo/rewind, and approval controls.
- Native file pickers, file references, and image attachments.
- Built-in tools for file operations, search, terminals, and debugging.
- Host identity such as "running in VS Code", "running in Cursor", or "running in Claude Code extension".

OpenReelio needs the same concept, translated from code editing to video editing.

Add a `HostContextEnvelope` that every in-app external agent session receives before and during turns:

```ts
interface HostContextEnvelope {
  host: {
    appId: 'openreelio';
    appName: 'OpenReelio';
    appVersion: string;
    surface: 'tauri-desktop' | 'web-preview' | 'external-mcp-client';
    os: string;
    locale: string;
  };
  project: {
    projectId: string;
    projectName: string;
    projectKind: 'video-editing-project';
    saveState: 'clean' | 'dirty';
  };
  ui: {
    activePanel: string;
    playheadSeconds: number;
    selectedClipIds: string[];
    selectedTrackIds: string[];
    selectedRange?: { startSeconds: number; endSeconds: number };
    visibleTimelineRange?: { startSeconds: number; endSeconds: number };
    previewState: 'idle' | 'playing' | 'rendering' | 'exporting';
  };
  capabilities: {
    timelineRead: boolean;
    commandValidate: boolean;
    planValidate: boolean;
    planApplyWithApproval: boolean;
    previewFrameRead: boolean;
    diagnosticsRead: boolean;
    renderControl: boolean;
  };
  policy: {
    approvalMode: 'read-only' | 'approve-mutations' | 'trusted-workspace';
    rawMediaAccess: 'none' | 'selected-only' | 'project';
    filesystemAccess: 'none' | 'bridge-workdir' | 'project-readonly';
  };
}
```

The envelope should be available through three paths:

1. Prompt prelude for embedded runtimes such as Codex app-server.
2. MCP resource `openreelio://host/context` for MCP-capable external agents.
3. MCP tool `openreelio.host.context` for clients that do not support resources well.

Add host-native MCP tools that mirror why IDE agents feel smooth:

- `openreelio.host.context`: returns host identity, active project, UI state, and permissions.
- `openreelio.selection.read`: returns selected clips, selected tracks, selected timeline range, and playhead.
- `openreelio.diagnostics.read`: returns project warnings, missing media, invalid effects, render errors, and last command failures.
- `openreelio.preview.frame.describe`: returns structured metadata for the current preview frame; raw image access remains permissioned.
- `openreelio.diff.preview`: creates a non-mutating diff/preview for a proposed plan.
- `openreelio.plan.review`: opens a native plan review panel and waits for user feedback or approval.
- `openreelio.checkpoint.create`: creates an undo/rollback checkpoint before approved mutation.
- `openreelio.deep_link.open`: opens a specific clip, track, marker, caption, or effect in the OpenReelio UI.

Host detection rules:

- For embedded agents, OpenReelio is the host and must explicitly say so in `HostContextEnvelope`.
- For external MCP clients, the MCP `initialize.params.clientInfo` value can be recorded as `clientInfo`, but it must not be trusted for permissions.
- For Cursor and VS Code, ship workspace configuration templates so the client can discover OpenReelio MCP tools naturally.
- For future ACP-compatible agents, prefer ACP when OpenReelio needs IDE-grade session semantics such as file/edit operations, permission requests, cancellation, and rich progress updates.

This is the missing layer between "generic MCP server" and "feels native inside a host". Without it, external agents can call OpenReelio tools, but they will not reliably know the current timeline focus, selection, preview state, or what UX surface the user is working in.

## Initial Agent Integration Matrix

This matrix is intentionally conservative. It records integration shape, not endorsement.

| Agent/service                   | Current best OpenReelio path                                                                | Notes                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Codex                           | In-app `stdio-jsonrpc` adapter via `codex app-server`; external MCP/plugin                  | Reference implementation because app-server is built for rich-client embedding.                      |
| Claude Code                     | External MCP first; in-app SDK adapter later if product and auth behavior fit               | Official MCP and SDK surfaces exist. Do not assume ChatGPT-style billing semantics.                  |
| Gemini CLI                      | External MCP first; CLI adapter later only after UX/security validation                     | Official MCP config exists. Treat as a CLI agent, not a provider in `aiStore`.                       |
| Cursor / cursor-agent           | External MCP and rules first; CLI adapter only for non-interactive or developer workflows   | Cursor is primarily an editor/CLI agent. Avoid embedding assumptions without a stable host protocol. |
| OpenCode                        | External MCP first; optional CLI/provider adapter later                                     | OpenCode config supports MCP. It may also be useful as a provider-agnostic agent wrapper.            |
| Kimi CLI                        | External MCP first; investigate ACP for in-app hosting                                      | Kimi documents MCP and Agent Client Protocol integration.                                            |
| Qwen Code                       | External MCP first; optional CLI adapter later                                              | Qwen Code documents MCP configuration and management.                                                |
| Grok / xAI                      | API remote MCP or model-provider path, not subscription-agent bridge                        | xAI documents remote MCP tools through SDK/API. This is not the same UX as a local Codex-like agent. |
| DeepSeek, GLM, other model APIs | Use existing or future model-provider path, or run through an agent shell that supports MCP | Do not assume an official local subscription agent until documented.                                 |

## Runtime Governance

OpenReelio should not ship Codex, Claude Code, Gemini CLI, Cursor, OpenCode, Kimi, Qwen, Grok, DeepSeek, GLM, or any other third-party agent as unrelated sidebar runtimes.

Recommended governance model:

- Keep `AgenticSidebarContent` as the canonical UI surface.
- Add `ExternalAgentHost` behind a top-level `USE_EXTERNAL_AGENT_HOST` flag.
- Add individual adapters behind narrower flags such as `USE_CODEX_AGENT`, `USE_CLAUDE_CODE_AGENT`, or `USE_GEMINI_CLI_AGENT`.
- Persist external-agent sessions with explicit runtime markers such as `runtime_kind = "external_agent"` plus `agent_runtime = "codex" | "claude_code" | "gemini_cli" | ...`.
- Update OpenSpec before implementation so `canonical-runtime-enforcement` and `agent-runtime-governance` explicitly allow External Agent Host modes as first-class modes of the canonical sidebar, not as legacy compatibility runtimes.

This preserves the current architectural rule: there is still one OpenReelio AI product surface, and all mutations still go through approved OpenReelio tools.

## Codex App-Server Bridge

Backend module:

- Add `src-tauri/src/core/codex/`.
- `process.rs`: locate `codex`, start `codex app-server`, own stdin/stdout, restart on crash, enforce timeouts.
- `protocol.rs`: typed JSON-RPC request/response/event structs generated or mirrored from `codex app-server generate-json-schema` / `generate-ts`.
- `auth.rs`: call app-server account endpoints such as `account/read` and login start methods. Do not parse Codex auth files.
- `session.rs`: map OpenReelio sessions to Codex threads and turns.
- `events.rs`: stream app-server notifications to the frontend through Tauri events.

Tauri IPC commands:

- `get_codex_status`: returns installed version, app-server support, auth mode, plan type when app-server reports it, and whether MCP tools started.
- `start_codex_session`: starts or resumes a Codex thread for a project.
- `send_codex_message`: starts a turn with project context and OpenReelio tool instructions.
- `interrupt_codex_session`: interrupts the current turn.
- `stop_codex_session`: shuts down the app-server process if no sessions need it.
- `approve_codex_tool_request`: resolves a pending mutating tool request with a session-scoped approval token.

Frontend adapter:

- Add `src/agents/engine/adapters/codex/CodexAgentBridge.ts`.
- Add `src/hooks/useCodexAgent.ts` or a small `codexStore.ts` for status, active thread, streamed events, pending approvals, and errors.
- Update `AISidebar.tsx` and settings to show Codex as a connected local agent option, not as an API-key provider.
- Use a segmented control only when the feature flag is enabled: "OpenReelio Agent" and "Codex".

First implementation should drive `codex app-server` over stdio, not WebSocket. WebSocket is documented as experimental, while stdio is the default app-server transport.

## OpenReelio MCP Server

Add an MCP server that exposes only OpenReelio-safe capabilities. The server can be implemented in Rust inside the Tauri backend and also exposed through the CLI for external Codex use.

Recommended command:

```text
openreelio-cli mcp --project <project-path> --stdio
```

MVP tool set:

- `openreelio.host.context`: read host identity, active OpenReelio UI state, capabilities, and policy.
- `openreelio.project.info`: read project path, project id, media root, save state, and app version.
- `openreelio.selection.read`: read selected clips, tracks, timeline range, and playhead.
- `openreelio.diagnostics.read`: read missing media, invalid timeline state, render/export errors, and last command failures.
- `openreelio.timeline.snapshot`: read tracks, clips, selections, markers, captions, effects, and current playhead.
- `openreelio.assets.list`: read asset metadata and missing/offline status.
- `openreelio.command.schema`: return the strict command schema from the existing CLI/help JSON path.
- `openreelio.command.validate`: validate one command payload without mutating state.
- `openreelio.plan.validate`: validate a multi-step agent plan without mutating state.
- `openreelio.diff.preview`: non-mutating preview of a proposed plan when the command layer can compute it.
- `openreelio.plan.apply`: mutating tool. Requires a fresh approval token issued by the OpenReelio UI and executes through `execute_agent_plan`.
- `openreelio.preview.describe`: read non-sensitive preview state and render/export status.

Explicitly exclude from MVP:

- Generic shell execution.
- Generic filesystem write.
- Direct timeline mutation APIs.
- Credential read/write.
- Network fetch tools unrelated to OpenReelio project work.

Tool payload rules:

- Every mutating tool request must include `session_id`, `project_id`, `plan_id`, and an approval token.
- Tool requests must be idempotency-aware. Repeated `plan.apply` with the same `plan_id` must not duplicate edits.
- All mutations must return structured `AgentPlanResult` data, not free-form text.
- The MCP server must not reveal absolute user paths unless the user enables detailed diagnostics.

## Agent Instructions And Plugin Packaging

Create a distributable OpenReelio Codex plugin after the MCP server exists. For other agents, create equivalent instruction/config packages using their native conventions, but keep the same OpenReelio MCP tool contract.

Proposed Codex plugin structure:

```text
.agents/plugins/openreelio-codex/
  .codex-plugin/
    plugin.json
  .mcp.json
  skills/
    openreelio-video-editing/
      SKILL.md
  assets/
    icon.png
```

Manifest direction:

- `name`: `openreelio`
- `description`: "Plan and execute OpenReelio video edits through safe project tools."
- `skills`: `./skills/`
- Keep MCP server configuration in the plugin-root `.mcp.json`, because Codex plugins support `.mcp.json` alongside the required `.codex-plugin/plugin.json`.
- Configure app/tool settings so the initial plugin behaves as read-only. Enable destructive or write-capable tools only after approval-token mutation is stable.

Skill content should teach Codex:

- OpenReelio is an event-sourced video editing IDE.
- It must plan edits as OpenReelio command payloads or agent plans.
- It must never claim an edit has been applied until `openreelio.plan.apply` returns success.
- It must prefer `timeline.snapshot`, `command.schema`, and validation tools before proposing edits.
- It must ask for user approval before destructive or broad changes.

For non-Codex agents, ship templates rather than pretending they all share the Codex plugin format:

- `.mcp.json` template for Claude Code.
- Gemini CLI `settings.json` `mcpServers` template.
- Cursor `.cursor/mcp.json` and rules template.
- OpenCode config `mcp` template.
- Kimi CLI MCP config template and ACP notes.
- Qwen Code `settings.json` `mcpServers` template.
- API remote MCP instructions for xAI/Grok-style integrations.

## Authentication And Billing UX

External agent authentication should be owned by the external agent. Codex authentication should be owned by Codex, Claude Code authentication by Claude Code, Gemini CLI authentication by Gemini CLI, and so on.

For Codex, OpenReelio must:

- Detect whether `codex` is installed.
- Start `codex app-server` only when the user begins an embedded Codex session.
- Use app-server account endpoints to read auth state and start ChatGPT-managed login when needed.
- Display status such as signed out, signed in with ChatGPT, API key mode, rate limited, or app-server unavailable.
- Explain that Codex usage follows the user's Codex/ChatGPT account when Codex is in ChatGPT-managed mode.

For all external agents, OpenReelio must not:

- Read `~/.codex/auth.json`.
- Read third-party agent auth files unless the vendor explicitly documents a safe status API and the user opted in.
- Store Codex refresh tokens.
- Store third-party agent refresh tokens.
- Exchange external app OAuth tokens for API usage.
- Represent external agents as normal `ProviderType` values inside `aiStore` or Rust `ProviderType`.
- Run `codex mcp add`, `codex plugin marketplace add`, or equivalent Codex user-config mutations automatically from app startup, status checks, or runtime selection.
- Persist OpenReelio project paths into user-level `~/.codex/config.toml`; in-app Codex must use app-server dynamic tools instead of global Codex MCP config.
- Promise exact token accounting unless the agent runtime exposes reliable usage/rate limit data for the account.

## Security Model

Default policy:

- Embedded agent adapters use local-only transports by default.
- The agent child process runs from an OpenReelio-managed bridge working directory, not the user's media root.
- OpenReelio passes project context through MCP tools and prompt items, not by granting Codex broad filesystem access.
- Mutations require OpenReelio UI approval and a short-lived approval token.
- Approvals are scoped to one `plan_id`, one session, and one project.
- All mutating results are persisted in the existing permission audit/session trace system.

Sandboxing:

- For turn start, use a restrictive `sandboxPolicy` where supported.
- If a writable root is needed, make it an app-managed temp or bridge directory.
- Keep project and media directories read-only through OpenReelio tools unless a user explicitly enables broader local-agent mode in developer settings.

Network:

- Do not expose app-server on non-loopback transports.
- Do not use WebSocket for MVP.
- If WebSocket is added later, require app-server auth flags and bind to loopback only.

Data minimization:

- Send structured project summaries and selected metadata first.
- Do not send raw media, transcripts, or full file paths unless the user asks for an operation that needs them.
- Redact credentials, filesystem secrets, local environment variables, and unrelated project metadata from tool outputs.

Failure handling:

- External agent process crash: keep OpenReelio running, mark session interrupted, allow restart.
- Tool failure: return structured error and rollback report.
- Approval timeout: decline the tool call and let Codex continue with a read-only explanation.
- Adapter protocol mismatch: disable the affected external agent mode and show a version upgrade prompt.

## Implementation Phases

Phase 0: OpenSpec and architecture record

- Create OpenSpec change `integrate-external-agent-host`.
- Update runtime governance specs to permit External Agent Host modes inside the canonical sidebar.
- Add a capability spec for runtime adapters, auth status, event streaming, MCP tools, and approval-gated mutation.
- Add a threat model note covering local process, MCP, token boundaries, and project data minimization.

Phase 1: Read-only MCP server and external agent templates

- Add `openreelio-cli mcp --stdio`.
- Implement `host.context`, `project.info`, `selection.read`, `diagnostics.read`, `timeline.snapshot`, `assets.list`, `command.schema`, `command.validate`, and `plan.validate`.
- Add MCP resources for `openreelio://host/context`, `openreelio://timeline/snapshot`, and `openreelio://command/schema`.
- Add Codex plugin skeleton with skill instructions and `.mcp.json`.
- Add MCP config templates for Claude Code, Gemini CLI, Cursor, OpenCode, Kimi, Qwen, and xAI/Grok remote MCP.
- Verify at least Codex, Claude Code, Gemini CLI, Cursor, and OpenCode can see read-only OpenReelio tools.

Phase 2: ExternalAgentHost and Codex app-server reference adapter

- Implement `ExternalAgentHost`, capability detection, status persistence, and shared event reducers.
- Implement `CodexProcessManager` and typed JSON-RPC client.
- Implement `HostContextEnvelope` creation and update broadcasts for playhead, selection, diagnostics, project dirty state, and preview state.
- Add status and login UX in settings.
- Stream Codex events into the sidebar.
- Start turns with OpenReelio project context and in-app dynamic OpenReelio tools.
- Persist session/run records with `runtime_kind = "external_agent"` and `agent_runtime = "codex"` or the final OpenSpec-approved shape.

Phase 3: Approval-gated plan apply

- Implement pending tool approval UI in the sidebar.
- Implement short-lived approval tokens.
- Add `openreelio.plan.apply` using `execute_agent_plan`.
- Persist permission decisions and rollback reports.
- Add golden tests for destructive edits, rollback, and failed validation.

Current implementation note:

- The CLI MCP server supports `openreelio.plan.apply` only when `OPENREELIO_MCP_APPROVAL_TOKEN` is set for that server process.
- MCP approval token windows can also be bounded with `OPENREELIO_MCP_APPROVAL_EXPIRES_AT_MS`; expired windows do not advertise or execute `openreelio.plan.apply`.
- The app-side external-agent approval gateway issues runtime-only, session/project/runtime/plan/scope-scoped tokens and records permission audit decisions for plan-apply approval.
- Requests without a matching `approvalToken` are rejected before project state is loaded for mutation.
- Approved CLI MCP plans execute through the same command payload parsing, command executor, rollback, and project save path used by `openreelio-cli plan execute`.
- The Codex app-server bridge is owned by the Tauri backend, with frontend transport adapters receiving decoded JSON-RPC events over per-server Tauri event channels.
- The Codex reference adapter lazily starts the backend app-server process only when a session operation needs it; status detection never launches `codex app-server`.
- The in-app Codex runtime is available behind `USE_EXTERNAL_AGENT_HOST` and `USE_CODEX_AGENT`, reuses the canonical AI sidebar chat shell, binds messages to OpenReelio AI sessions, keeps the OpenReelio project path in host context instead of Codex `cwd`, and streams Codex notifications into typed conversation parts.
- The app-server process is launched from an OpenReelio app-data bridge directory with `history.persistence="none"`, `mcp_servers={}`, `features.hooks=false`, `notify=[]`, read-only sandbox defaults, and an OpenReelio app-data `log_dir` override so embedded sessions do not write OpenReelio chat history/logs, load user-configured MCP servers, or trigger user-configured Codex hooks/notifications through the user's default Codex data directory.
- The settings runtime check is non-mutating: it verifies Codex installation/auth readiness but does not install project MCP servers, add plugin marketplaces, or write OpenReelio paths into Codex global config.
- Codex server-initiated command/file-change approval requests are handled by a scoped in-app decision broker when the Codex sidebar runtime is active. The broker reuses OpenReelio's tool approval UI, maps Allow/Allow Always/Deny to Codex app-server decisions, records interactive permission audit entries, and still falls back to conservative `decline` when no broker is attached.

Phase 4: Additional adapters and product polish

- Add Claude Code SDK or CLI adapter only if it can meet the adapter capability contract.
- Add Gemini CLI, Cursor CLI, OpenCode, Kimi, and Qwen adapters only where their official integration surfaces are stable enough for in-app UX.
- Add session resume.
- Add rate-limit and account status display if app-server provides it reliably.
- Add project context compaction for long timelines.
- Add model/effort controls only if the runtime adapter supports them cleanly.
- Add diagnostics page for agent version, adapter status, MCP startup status, and last protocol error.

Phase 5: Packaging

- MVP requires user-installed Codex CLI.
- Later, evaluate managed install or bundled helper only if licensing and platform behavior are clear.
- Never bundle credentials or auth state.

## Test Plan

Rust:

- JSON-RPC request id matching, notification handling, process restart, timeout, and protocol error tests.
- MCP tool contract tests for schema shape and redaction.
- Approval token tests for expiry, project/session mismatch, replay, and missing token denial.
- Plan apply tests proving all mutation goes through `execute_agent_plan`.

TypeScript:

- Sidebar status rendering tests for signed out, signed in, app-server missing, rate limited, and protocol mismatch states.
- Stream event reducer tests for turn start, deltas, tool request, approval resolution, interruption, and errors.
- Settings tests proving Codex does not appear as an API-key provider.

End-to-end:

- Mock external agent process that streams a normal turn.
- Mock external agent process that requests a mutating plan apply.
- Approval decline and timeout paths.
- Crash and restart path.

Security:

- Static test or review check proving no code reads Codex auth files.
- Mutation denied without approval token.
- Path traversal blocked in MCP project path handling.
- No generic filesystem write or shell tools exposed by the OpenReelio MCP server.

## Acceptance Criteria

The feature is complete when:

- A user with Codex CLI installed and authenticated can open OpenReelio, select Codex mode, and chat from the existing AI sidebar through the External Agent Host.
- At least one non-Codex external agent can connect through the OpenReelio MCP server in read-only mode.
- External agents can inspect the current project through OpenReelio tools.
- Embedded agents receive host-native context for OpenReelio identity, active project, current selection, playhead, diagnostics, preview state, capabilities, and approval policy.
- External MCP clients can read the same context through `openreelio.host.context` or `openreelio://host/context`.
- External agents can propose a multi-step video edit plan using OpenReelio command schemas.
- OpenReelio asks for approval before mutation.
- Approved edits execute through `execute_agent_plan`, appear in the command log, and roll back on failure.
- OpenReelio does not request, store, exchange, or expose external agent OAuth tokens.
- External Codex and at least one other MCP-capable agent can use the OpenReelio MCP server for the same read/validate workflow.
- All new behavior is covered by OpenSpec, unit tests, and at least one mocked external-agent integration test.

## Open Questions

- Should Codex be allowed to use any shell tool in an OpenReelio bridge session? Recommendation: no for MVP.
- Should raw media or transcript access be a separate explicit permission? Recommendation: yes.
- Should the in-app bridge use app-server directly or the TypeScript SDK through a Node helper? Recommendation: app-server directly from Rust for MVP, because the app is a Tauri desktop app and app-server is the official rich-client protocol.
- Should external agents be enabled by default? Recommendation: no. Ship behind feature flags and user settings until protocol and security behavior are stable.
- What exact runtime marker should be persisted? Recommendation: define it in OpenSpec before implementation, then use the same value across Rust, TypeScript, and conversation persistence.

## Next Step

The next implementation slice should persist Codex thread mappings across app restarts and add richer OpenReelio context resources for current timeline selection, playhead, preview, and diagnostics.
