/**
 * Experimental Agent Definitions
 *
 * Compatibility-only multi-agent profiles that are not part of the shipping
 * sidebar/runtime contract. Experimental surfaces should import from this file
 * directly instead of the shipping barrel.
 */

import { EDITOR_AGENT_DEFINITION, type AgentDefinition } from './agentDefinitions';

export type ExperimentalAgentDefinition = AgentDefinition;

const EXPERIMENTAL_SUBAGENT_DEFINITIONS: Record<string, ExperimentalAgentDefinition> = {
  planner: {
    id: 'planner',
    name: 'Planner',
    description: 'Read-only planning agent for scoped edit execution strategies',
    mode: 'subagent',
    tools: ['query', 'workspace_read'],
    role: 'planner',
    temperature: 0.2,
    maxIterations: 8,
    promptPlaceholder: 'Ask the planner to break down the edit before execution...',
  },
  analyst: {
    id: 'analyst',
    name: 'Analyst',
    description: 'Read-only analysis agent for timeline and asset inspection',
    mode: 'subagent',
    tools: ['query', 'workspace_read'],
    role: 'analyst',
    temperature: 0.2,
    maxIterations: 10,
    promptPlaceholder: 'Ask the analyst to inspect the current cut or assets...',
  },
  verifier: {
    id: 'verifier',
    name: 'Verifier',
    description: 'Read-only merge-readiness reviewer for delegated results',
    mode: 'subagent',
    tools: ['query', 'workspace_read'],
    role: 'verifier',
    temperature: 0.1,
    maxIterations: 10,
    promptPlaceholder: 'Ask the verifier to review whether a delegated result is ready to merge...',
  },
  colorist: {
    id: 'colorist',
    name: 'Colorist',
    description: 'Color grading specialist',
    mode: 'subagent',
    tools: ['query', 'effects', 'workspace'],
    role: 'colorist',
    temperature: 0.4,
    maxIterations: 15,
    promptPlaceholder: 'Describe the look or grading pass you want to apply...',
  },
  audio: {
    id: 'audio',
    name: 'Audio Engineer',
    description: 'Audio mixing and processing specialist',
    mode: 'subagent',
    tools: ['query', 'audio', 'workspace'],
    role: 'audio',
    temperature: 0.3,
    maxIterations: 15,
    promptPlaceholder: 'Describe the audio cleanup, mix, or level adjustment you need...',
  },
  captioner: {
    id: 'captioner',
    name: 'Captioner',
    description: 'Caption and subtitle specialist',
    mode: 'subagent',
    tools: ['query', 'text', 'workspace'],
    role: 'captioner',
    temperature: 0.2,
    maxIterations: 12,
    promptPlaceholder: 'Ask the captioner to create, fix, or style subtitles...',
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
