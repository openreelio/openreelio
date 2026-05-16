export type ExternalAgentRuntimeId =
  | 'codex'
  | 'claude_code'
  | 'gemini_cli'
  | 'cursor_cli'
  | 'opencode'
  | 'kimi_cli'
  | 'qwen_code'
  | 'xai_remote_mcp'
  | 'custom_mcp';

export type ExternalAgentInstallStatus = 'installed' | 'missing' | 'unknown';

export type ExternalAgentAuthStatus = 'signed-in' | 'signed-out' | 'api-key' | 'unknown' | 'error';

export interface ExternalAgentRuntimeCapabilities {
  streamingEvents: boolean;
  interrupt: boolean;
  mcpClient: boolean;
  approvalAware: boolean;
  localAccountAuth: boolean;
  sessionResume: boolean;
  structuredToolCalls: boolean;
}

export interface ExternalAgentRuntimeStatus {
  runtimeId: ExternalAgentRuntimeId;
  displayName: string;
  installStatus: ExternalAgentInstallStatus;
  authStatus: ExternalAgentAuthStatus;
  available: boolean;
  version: string | null;
  reason: string | null;
}

export interface AgentRuntimeReadiness {
  ready: boolean;
  reason: string | null;
}

export interface ExternalAgentSessionHandle {
  sessionId: string;
  runtimeId: ExternalAgentRuntimeId | string;
  metadata?: Record<string, unknown> | null;
}

export type ExternalAgentApprovalScope = 'openreelio.plan.apply';

export interface ExternalAgentApprovalTokenGrant {
  token: string;
  tokenId: string;
  sessionId: string;
  runId: string | null;
  planId: string | null;
  projectId: string;
  runtimeId: ExternalAgentRuntimeId | string;
  scopes: ExternalAgentApprovalScope[];
  createdAt: number;
  expiresAt: number;
}

export interface ExternalAgentApprovalTokenInfo {
  tokenId: string;
  sessionId: string;
  runId: string | null;
  planId: string | null;
  projectId: string;
  runtimeId: ExternalAgentRuntimeId | string;
  scopes: ExternalAgentApprovalScope[];
  createdAt: number;
  expiresAt: number;
}

export interface ExternalAgentApprovalTokenValidation {
  valid: boolean;
  reason: string | null;
  grant: ExternalAgentApprovalTokenInfo | null;
}

export interface CreateExternalAgentPlanApplyApprovalInput {
  sessionId: string;
  runId?: string | null;
  planId: string;
  projectId: string;
  runtimeId: ExternalAgentRuntimeId | string;
  ttlMs?: number;
}

export interface ConsumeExternalAgentPlanApplyApprovalInput {
  token: string;
  sessionId: string;
  planId: string;
  projectId: string;
  runtimeId: ExternalAgentRuntimeId | string;
}

export interface ExternalAgentMcpApprovalEnvironment {
  OPENREELIO_MCP_APPROVAL_TOKEN: string;
  OPENREELIO_MCP_APPROVAL_EXPIRES_AT_MS: string;
  OPENREELIO_MCP_APPROVAL_SESSION_ID: string;
  OPENREELIO_MCP_APPROVAL_PLAN_ID: string;
  OPENREELIO_MCP_APPROVAL_PROJECT_ID: string;
  OPENREELIO_MCP_APPROVAL_RUNTIME_ID: string;
}

export interface StartAgentSessionInput {
  projectId: string;
  prompt?: string;
  cwd?: string | null;
}

export interface ResumeAgentSessionInput {
  projectId: string;
  externalSessionId: string;
  cwd?: string | null;
}

export interface AgentUserMessage {
  content: string;
  cwd?: string | null;
}

export type ExternalAgentRuntimeEvent =
  | {
      type: 'turn_started';
      runtimeId: ExternalAgentRuntimeId | string;
      sessionId: string;
      turnId: string;
    }
  | {
      type: 'turn_completed';
      runtimeId: ExternalAgentRuntimeId | string;
      sessionId: string;
      turnId: string | null;
      status: 'completed' | 'interrupted' | 'failed' | string;
      error?: string | null;
    }
  | {
      type: 'assistant_delta';
      runtimeId: ExternalAgentRuntimeId | string;
      sessionId: string;
      itemId?: string | null;
      content: string;
    }
  | {
      type: 'assistant_completed';
      runtimeId: ExternalAgentRuntimeId | string;
      sessionId: string;
      itemId?: string | null;
      content?: string | null;
    }
  | {
      type: 'reasoning_delta';
      runtimeId: ExternalAgentRuntimeId | string;
      sessionId: string;
      itemId?: string | null;
      content: string;
    }
  | {
      type: 'tool_started';
      runtimeId: ExternalAgentRuntimeId | string;
      sessionId: string;
      itemId: string;
      tool: string;
      description: string;
      args?: Record<string, unknown>;
    }
  | {
      type: 'tool_completed';
      runtimeId: ExternalAgentRuntimeId | string;
      sessionId: string;
      itemId: string;
      tool: string;
      success: boolean;
      result?: unknown;
      error?: string | null;
      durationMs?: number | null;
    }
  | {
      type: 'file_change';
      runtimeId: ExternalAgentRuntimeId | string;
      sessionId: string;
      itemId: string;
      diff: string;
      files: string[];
      status?: string | null;
    }
  | {
      type: 'approval_requested';
      runtimeId: ExternalAgentRuntimeId | string;
      sessionId: string;
      itemId: string | null;
      requestId: number;
      approvalType:
        | 'os_command'
        | 'file_change'
        | 'openreelio_edit_command'
        | 'openreelio_plan_apply'
        | 'openreelio_workspace_command'
        | 'unknown';
      reason?: string | null;
      tool?: string | null;
      description?: string | null;
      args?: Record<string, unknown>;
    }
  | {
      type: 'error';
      runtimeId: ExternalAgentRuntimeId | string;
      sessionId?: string | null;
      message: string;
    };

export type ExternalAgentRuntimeEventHandler = (event: ExternalAgentRuntimeEvent) => void;

export type ExternalAgentApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ExternalAgentApprovalRequest {
  id: string;
  runtimeId: ExternalAgentRuntimeId | string;
  sessionId: string;
  turnId: string | null;
  itemId: string | null;
  requestId: number;
  approvalType:
    | 'os_command'
    | 'file_change'
    | 'openreelio_edit_command'
    | 'openreelio_plan_apply'
    | 'openreelio_workspace_command'
    | 'unknown';
  tool: string;
  description: string;
  args: Record<string, unknown>;
  reason: string | null;
  requestedAt: number;
}

export type ExternalAgentApprovalDecisionProvider = (
  request: ExternalAgentApprovalRequest,
) => ExternalAgentApprovalDecision | Promise<ExternalAgentApprovalDecision>;

export interface ExternalAgentRuntimeAdapter {
  readonly id: ExternalAgentRuntimeId;
  readonly displayName: string;
  detect(): Promise<ExternalAgentRuntimeStatus>;
  authStatus(): Promise<ExternalAgentAuthStatus>;
  capabilities(): Promise<ExternalAgentRuntimeCapabilities>;
  subscribe?(handler: ExternalAgentRuntimeEventHandler): () => void;
  startSession(input: StartAgentSessionInput): Promise<ExternalAgentSessionHandle>;
  resumeSession?(input: ResumeAgentSessionInput): Promise<ExternalAgentSessionHandle>;
  sendMessage(sessionId: string, message: AgentUserMessage): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  shutdown(sessionId: string): Promise<void>;
}
