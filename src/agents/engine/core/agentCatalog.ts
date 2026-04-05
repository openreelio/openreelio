import type { ToolInfo } from '../ports/IToolExecutor';
import type { AgentDefinition, AgentToolScope } from './agentDefinitions';
import {
  DEFAULT_AGENT_PROFILE_ID,
  getShippingAgentDefinition,
  listShippingAgentDefinitions,
} from './agentDefinitions';
import {
  getExperimentalAgentDefinition,
  listExperimentalAgentDefinitions,
} from './agentDefinitions.experimental';
import { getAnalysisToolNames } from '@/agents/tools/analysisTools';
import { getAudioToolNames } from '@/agents/tools/audioTools';
import { getCaptionToolNames } from '@/agents/tools/captionTools';
import { getEditingToolNames } from '@/agents/tools/editingTools';
import { getEffectToolNames } from '@/agents/tools/effectTools';
import { getMediaAnalysisToolNames } from '@/agents/tools/mediaAnalysisTools';
import { getTransitionToolNames } from '@/agents/tools/transitionTools';
import { getWorkspaceToolNames } from '@/agents/tools/workspaceTools';

const TOOL_NAMES_BY_SCOPE: Record<Exclude<AgentToolScope, '*'>, Set<string>> = {
  query: new Set(['query', ...getAnalysisToolNames(), ...getMediaAnalysisToolNames()]),
  edit: new Set(['edit', ...getEditingToolNames()]),
  audio: new Set(['audio', ...getAudioToolNames()]),
  effects: new Set(['effects', ...getEffectToolNames(), ...getTransitionToolNames()]),
  text: new Set(['text', ...getCaptionToolNames()]),
  workspace: new Set(getWorkspaceToolNames()),
};

export function resolveAgentDefinition(agentId?: string | null): AgentDefinition | undefined {
  if (!agentId) {
    return getShippingAgentDefinition(DEFAULT_AGENT_PROFILE_ID);
  }

  return getShippingAgentDefinition(agentId) ?? getExperimentalAgentDefinition(agentId);
}

export function listSelectableAgentDefinitions(): AgentDefinition[] {
  const definitions = [...listShippingAgentDefinitions(), ...listExperimentalAgentDefinitions()];
  const deduped = new Map<string, AgentDefinition>();

  for (const definition of definitions) {
    deduped.set(definition.id, definition);
  }

  return Array.from(deduped.values());
}

export function getAgentDisplayName(agentId?: string | null): string {
  return resolveAgentDefinition(agentId)?.name ?? 'Unknown';
}

export function getAgentPromptPlaceholder(agentId?: string | null): string {
  return (
    resolveAgentDefinition(agentId)?.promptPlaceholder ??
    getShippingAgentDefinition(DEFAULT_AGENT_PROFILE_ID)?.promptPlaceholder ??
    'Describe what you want to edit...'
  );
}

function matchesToolScope(toolName: string, scope: Exclude<AgentToolScope, '*'>): boolean {
  return TOOL_NAMES_BY_SCOPE[scope].has(toolName);
}

export function isToolAllowedForAgent(
  definition: AgentDefinition,
  tool: Pick<ToolInfo, 'name'>,
): boolean {
  if (definition.tools.includes('*')) {
    return true;
  }

  return definition.tools.some((scope) => scope !== '*' && matchesToolScope(tool.name, scope));
}

export function getAllowedToolNamesForAgent(
  definition: AgentDefinition,
  tools: Iterable<Pick<ToolInfo, 'name'>>,
): Set<string> {
  if (definition.tools.includes('*')) {
    return new Set(Array.from(tools, (tool) => tool.name));
  }

  return new Set(
    Array.from(tools)
      .filter((tool) => isToolAllowedForAgent(definition, tool))
      .map((tool) => tool.name),
  );
}
