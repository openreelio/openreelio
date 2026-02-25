/**
 * Agent Definitions
 *
 * Defines the available agent types and their configurations.
 * Each agent has specific capabilities, allowed tools, and behavior.
 */

import type { AgentRole } from '../prompts/system';

// =============================================================================
// Types
// =============================================================================

export type AgentMode = 'primary' | 'subagent';

export interface AgentDefinition {
  /** Unique agent identifier */
  id: string;
  /** Display name */
  name: string;
  /** Short description of the agent's role */
  description: string;
  /** Primary or sub-agent */
  mode: AgentMode;
  /** Allowed tool categories (* for all) */
  tools: string[];
  /** Agent role for system prompt selection */
  role: AgentRole;
  /** Temperature for LLM calls */
  temperature: number;
  /** Maximum iterations per run */
  maxIterations?: number;
}

// =============================================================================
// Built-in Agents
// =============================================================================

export const AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
  editor: {
    id: 'editor',
    name: 'Editor',
    description: 'Full video editing agent with all tools',
    mode: 'primary',
    tools: ['*'],
    role: 'editor',
    temperature: 0.3,
    maxIterations: 20,
  },
  analyst: {
    id: 'analyst',
    name: 'Analyst',
    description: 'Read-only analysis agent for timeline and asset inspection',
    mode: 'subagent',
    tools: ['analysis', 'mediaAnalysis'],
    role: 'analyst',
    temperature: 0.2,
    maxIterations: 10,
  },
  colorist: {
    id: 'colorist',
    name: 'Colorist',
    description: 'Color grading specialist',
    mode: 'subagent',
    tools: ['effect', 'analysis'],
    role: 'colorist',
    temperature: 0.4,
    maxIterations: 15,
  },
  audio: {
    id: 'audio',
    name: 'Audio Engineer',
    description: 'Audio mixing and processing specialist',
    mode: 'subagent',
    tools: ['audio', 'analysis'],
    role: 'audio',
    temperature: 0.3,
    maxIterations: 15,
  },
};

/**
 * Get an agent definition by ID.
 */
export function getAgentDefinition(id: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS[id];
}

/**
 * Get all available agent definitions.
 */
export function getAllAgentDefinitions(): AgentDefinition[] {
  return Object.values(AGENT_DEFINITIONS);
}

/**
 * Get only primary agents (suitable for direct user interaction).
 */
export function getPrimaryAgents(): AgentDefinition[] {
  return getAllAgentDefinitions().filter((a) => a.mode === 'primary');
}

/**
 * Get only sub-agents (suitable for orchestration by a primary agent).
 */
export function getSubAgents(): AgentDefinition[] {
  return getAllAgentDefinitions().filter((a) => a.mode === 'subagent');
}
