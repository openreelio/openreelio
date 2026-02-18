/**
 * Conversation Model - Multi-Part Message System
 *
 * Defines the conversation data model with typed message parts.
 * Each message can contain multiple parts (text, thinking, plan,
 * tool calls, tool results, errors, approvals) enabling rich
 * rendering and streaming updates.
 *
 * Inspired by OpenCode's multi-part message architecture.
 */

import type { LLMMessage } from '../ports/ILLMClient';
import type { Plan, PlanStep, Thought, RiskLevel } from './types';

// =============================================================================
// Message Part Types
// =============================================================================

/**
 * Plain text content part, supports markdown
 */
export interface TextPart {
  type: 'text';
  content: string;
}

/**
 * Thinking/reasoning part from the Think phase
 */
export interface ThinkingPart {
  type: 'thinking';
  thought: Thought;
}

/**
 * Plan part from the Plan phase
 */
export interface PlanPart {
  type: 'plan';
  plan: Plan;
  status: 'proposed' | 'approved' | 'rejected';
}

/**
 * Tool invocation part
 */
export interface ToolCallPart {
  type: 'tool_call';
  stepId: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
  riskLevel: RiskLevel;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt?: number;
}

/**
 * Tool execution result part
 */
export interface ToolResultPart {
  type: 'tool_result';
  stepId: string;
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
  duration: number;
}

/**
 * Error part
 */
export interface ErrorPart {
  type: 'error';
  code: string;
  message: string;
  phase: string;
  recoverable: boolean;
}

/**
 * Approval request/response part
 */
export interface ApprovalPart {
  type: 'approval';
  plan: Plan;
  status: 'pending' | 'approved' | 'rejected';
  reason?: string;
}

/**
 * Per-tool approval request part (inline permission check)
 */
export interface ToolApprovalPart {
  type: 'tool_approval';
  stepId: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
  riskLevel: RiskLevel;
  status: 'pending' | 'approved' | 'denied';
}

/**
 * Union of all message part types
 */
export type MessagePart =
  | TextPart
  | ThinkingPart
  | PlanPart
  | ToolCallPart
  | ToolResultPart
  | ErrorPart
  | ApprovalPart
  | ToolApprovalPart;

// =============================================================================
// Conversation Message
// =============================================================================

/**
 * Role of the message sender
 */
export type ConversationRole = 'user' | 'assistant' | 'system';

/**
 * Token usage information
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * A single message in the conversation with typed parts
 */
export interface ConversationMessage {
  /** Unique message identifier */
  id: string;
  /** Role of the message sender */
  role: ConversationRole;
  /** Typed parts that compose this message */
  parts: MessagePart[];
  /** When the message was created */
  timestamp: number;
  /** Session ID for agentic sessions */
  sessionId?: string;
  /** Token usage for assistant messages */
  usage?: TokenUsage;
}

/**
 * A complete conversation
 */
export interface Conversation {
  /** Unique conversation identifier */
  id: string;
  /** Project this conversation belongs to */
  projectId: string;
  /** Messages in the conversation */
  messages: ConversationMessage[];
  /** When the conversation was created */
  createdAt: number;
  /** When the conversation was last updated */
  updatedAt: number;
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a new empty conversation for a project
 */
export function createConversation(projectId: string): Conversation {
  return {
    id: crypto.randomUUID(),
    projectId,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Create a user message with text content
 */
export function createUserMessage(content: string): ConversationMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', content }],
    timestamp: Date.now(),
  };
}

/**
 * Create an assistant message (initially empty, parts added during streaming)
 */
export function createAssistantMessage(sessionId?: string): ConversationMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [],
    timestamp: Date.now(),
    sessionId,
  };
}

/**
 * Create a system message
 */
export function createSystemMessage(content: string): ConversationMessage {
  return {
    id: crypto.randomUUID(),
    role: 'system',
    parts: [{ type: 'text', content }],
    timestamp: Date.now(),
  };
}

// =============================================================================
// Part Factory Functions
// =============================================================================

/**
 * Create a text part
 */
export function createTextPart(content: string): TextPart {
  return { type: 'text', content };
}

/**
 * Create a thinking part from a Thought
 */
export function createThinkingPart(thought: Thought): ThinkingPart {
  return { type: 'thinking', thought };
}

/**
 * Create a plan part
 */
export function createPlanPart(
  plan: Plan,
  status: PlanPart['status'] = 'proposed'
): PlanPart {
  return { type: 'plan', plan, status };
}

/**
 * Create a tool call part from a PlanStep
 */
export function createToolCallPart(step: PlanStep): ToolCallPart {
  return {
    type: 'tool_call',
    stepId: step.id,
    tool: step.tool,
    args: step.args,
    description: step.description,
    riskLevel: step.riskLevel,
    status: 'pending',
  };
}

/**
 * Create a tool result part
 */
export function createToolResultPart(
  stepId: string,
  tool: string,
  success: boolean,
  duration: number,
  data?: unknown,
  error?: string
): ToolResultPart {
  return {
    type: 'tool_result',
    stepId,
    tool,
    success,
    duration,
    data,
    error,
  };
}

/**
 * Create an error part
 */
export function createErrorPart(
  code: string,
  message: string,
  phase: string,
  recoverable: boolean
): ErrorPart {
  return { type: 'error', code, message, phase, recoverable };
}

/**
 * Create an approval part
 */
export function createApprovalPart(
  plan: Plan,
  status: ApprovalPart['status'] = 'pending'
): ApprovalPart {
  return { type: 'approval', plan, status };
}

// =============================================================================
// Conversion Helpers
// =============================================================================

/**
 * Flatten a ConversationMessage into a simple LLMMessage for LLM context.
 * Extracts text content from all parts and concatenates them.
 */
export function toSimpleLLMMessage(msg: ConversationMessage): LLMMessage {
  const textParts: string[] = [];

  for (const part of msg.parts) {
    switch (part.type) {
      case 'text':
        textParts.push(part.content);
        break;
      case 'thinking':
        textParts.push(`[Thinking] ${part.thought.understanding}`);
        break;
      case 'plan':
        textParts.push(
          `[Plan] ${part.plan.goal}: ${part.plan.steps.map((s) => s.description).join(', ')}`
        );
        break;
      case 'tool_call':
        textParts.push(`[Tool Call] ${part.tool}: ${part.description}`);
        break;
      case 'tool_result':
        textParts.push(
          `[Tool Result] ${part.tool}: ${part.success ? 'success' : `failed: ${part.error}`}`
        );
        break;
      case 'error':
        textParts.push(`[Error] ${part.message}`);
        break;
      case 'approval':
        textParts.push(`[Approval] Plan ${part.status}: ${part.plan.goal}`);
        break;
      case 'tool_approval':
        textParts.push(
          `[Tool Approval] ${part.tool} ${part.status}: ${part.description}`
        );
        break;
    }
  }

  return {
    role: msg.role === 'system' ? 'system' : msg.role,
    content: textParts.join('\n'),
  };
}

/**
 * Convert an array of ConversationMessages to LLMMessages for multi-turn context.
 * Filters out system messages and empty messages.
 */
export function toSimpleLLMMessages(
  messages: ConversationMessage[],
  maxMessages?: number
): LLMMessage[] {
  let filtered = messages.filter(
    (msg) => msg.role !== 'system' && msg.parts.length > 0
  );

  if (maxMessages !== undefined && filtered.length > maxMessages) {
    filtered = filtered.slice(-maxMessages);
  }

  return filtered.map(toSimpleLLMMessage);
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Check if a message part is a valid MessagePart
 */
export function isValidMessagePart(part: unknown): part is MessagePart {
  if (!part || typeof part !== 'object') return false;
  const p = part as Record<string, unknown>;

  switch (p.type) {
    case 'text':
      return typeof p.content === 'string';
    case 'thinking':
      return p.thought != null && typeof p.thought === 'object';
    case 'plan':
      return (
        p.plan != null &&
        typeof p.plan === 'object' &&
        ['proposed', 'approved', 'rejected'].includes(p.status as string)
      );
    case 'tool_call':
      return (
        typeof p.stepId === 'string' &&
        typeof p.tool === 'string' &&
        ['pending', 'running', 'completed', 'failed'].includes(p.status as string)
      );
    case 'tool_result':
      return (
        typeof p.stepId === 'string' &&
        typeof p.tool === 'string' &&
        typeof p.success === 'boolean'
      );
    case 'error':
      return typeof p.code === 'string' && typeof p.message === 'string';
    case 'approval':
      return (
        p.plan != null &&
        typeof p.plan === 'object' &&
        ['pending', 'approved', 'rejected'].includes(p.status as string)
      );
    case 'tool_approval':
      return (
        typeof p.stepId === 'string' &&
        typeof p.tool === 'string' &&
        ['pending', 'approved', 'denied'].includes(p.status as string)
      );
    default:
      return false;
  }
}

/**
 * Check if a ConversationMessage is valid
 */
export function isValidConversationMessage(
  msg: unknown
): msg is ConversationMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;

  if (typeof m.id !== 'string' || m.id.length === 0) return false;
  if (!['user', 'assistant', 'system'].includes(m.role as string)) return false;
  if (!Array.isArray(m.parts)) return false;
  if (typeof m.timestamp !== 'number') return false;

  return m.parts.every(isValidMessagePart);
}
