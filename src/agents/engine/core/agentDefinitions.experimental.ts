/**
 * Experimental Agent Definitions
 *
 * Compatibility-only multi-agent profiles that are not part of the shipping
 * sidebar/runtime contract. Experimental surfaces should import from this file
 * directly instead of the shipping barrel.
 */

import {
  EDITOR_AGENT_DEFINITION,
  type AgentDefinition,
} from './agentDefinitions';

export type ExperimentalAgentDefinition = AgentDefinition;

const EXPERIMENTAL_SUBAGENT_DEFINITIONS: Record<string, ExperimentalAgentDefinition> = {
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

export const EXPERIMENTAL_AGENT_DEFINITIONS: Record<string, ExperimentalAgentDefinition> = {
  [EDITOR_AGENT_DEFINITION.id]: EDITOR_AGENT_DEFINITION,
  ...EXPERIMENTAL_SUBAGENT_DEFINITIONS,
};

export function getExperimentalAgentDefinition(
  id: string,
): ExperimentalAgentDefinition | undefined {
  return EXPERIMENTAL_AGENT_DEFINITIONS[id];
}

export function listExperimentalAgentDefinitions(): ExperimentalAgentDefinition[] {
  return Object.values(EXPERIMENTAL_AGENT_DEFINITIONS);
}

export function listExperimentalSubAgentDefinitions(): ExperimentalAgentDefinition[] {
  return Object.values(EXPERIMENTAL_SUBAGENT_DEFINITIONS);
}
