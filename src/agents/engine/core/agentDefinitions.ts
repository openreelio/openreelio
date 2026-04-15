/**
 * Agent Definitions
 *
 * Defines the shipping agent profile surface.
 * Experimental multi-agent definitions live in `agentDefinitions.experimental.ts`.
 */

import type { AgentRole } from '../prompts/agentRoles';

// =============================================================================
// Types
// =============================================================================

export type AgentMode = 'primary' | 'subagent';
export type AgentToolScope =
  | '*'
  | 'query'
  | 'edit'
  | 'audio'
  | 'effects'
  | 'text'
  | 'workspace'
  | 'workspace_read';

export interface AgentDefinition {
  /** Unique agent identifier */
  id: string;
  /** Display name */
  name: string;
  /** Short description of the agent's role */
  description: string;
  /** Primary or sub-agent */
  mode: AgentMode;
  /** Allowed tool scopes (* for all) */
  tools: AgentToolScope[];
  /** Agent role for system prompt selection */
  role: AgentRole;
  /** Temperature for LLM calls */
  temperature: number;
  /** Maximum iterations per run */
  maxIterations?: number;
  /** Optional input placeholder used by UI surfaces */
  promptPlaceholder?: string;
}

// =============================================================================
// Shipping Agent Profiles
// =============================================================================

export const DEFAULT_AGENT_PROFILE_ID = 'editor' as const;

export const EDITOR_AGENT_DEFINITION: AgentDefinition = {
  id: DEFAULT_AGENT_PROFILE_ID,
  name: 'Editor',
  description: 'Full video editing agent with all tools',
  mode: 'primary',
  tools: ['*'],
  role: 'editor',
  temperature: 0.3,
  maxIterations: 20,
  promptPlaceholder: 'Describe what you want to edit...',
};

export const SHIPPING_AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
  [DEFAULT_AGENT_PROFILE_ID]: EDITOR_AGENT_DEFINITION,
};

/**
 * Get the shipping agent definition by ID.
 */
export function getShippingAgentDefinition(id: string): AgentDefinition | undefined {
  return SHIPPING_AGENT_DEFINITIONS[id];
}

/**
 * List the shipping agent definitions exposed by the product UI.
 */
export function listShippingAgentDefinitions(): AgentDefinition[] {
  return Object.values(SHIPPING_AGENT_DEFINITIONS);
}
