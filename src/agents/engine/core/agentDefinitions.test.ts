import {
  DEFAULT_AGENT_PROFILE_ID,
  getShippingAgentDefinition,
  listShippingAgentDefinitions,
} from './agentDefinitions';
import {
  getExperimentalAgentDefinition,
  listExperimentalAgentDefinitions,
  listExperimentalSubAgentDefinitions,
} from './agentDefinitions.experimental';

describe('agentDefinitions', () => {
  it('should expose only the editor profile on the shipping surface', () => {
    const definitions = listShippingAgentDefinitions();

    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.id).toBe(DEFAULT_AGENT_PROFILE_ID);
    expect(getShippingAgentDefinition(DEFAULT_AGENT_PROFILE_ID)?.mode).toBe('primary');
  });

  it('should keep deferred multi-agent profiles behind the experimental surface', () => {
    const experimentalDefinitions = listExperimentalAgentDefinitions();
    const subAgents = listExperimentalSubAgentDefinitions();

    expect(new Set(experimentalDefinitions.map((definition) => definition.id)).size).toBe(
      experimentalDefinitions.length,
    );
    expect(experimentalDefinitions.every((definition) => definition.tools.length > 0)).toBe(true);
    expect(
      experimentalDefinitions.every((definition) => definition.promptPlaceholder?.length),
    ).toBe(true);
    expect(subAgents.every((definition) => definition.mode === 'subagent')).toBe(true);
    expect(subAgents.map((definition) => definition.id)).toEqual([
      'planner',
      'analyst',
      'verifier',
      'colorist',
      'audio',
      'captioner',
    ]);
    expect(getExperimentalAgentDefinition('analyst')?.mode).toBe('subagent');
    expect(getExperimentalAgentDefinition('planner')?.role).toBe('planner');
    expect(getExperimentalAgentDefinition('verifier')?.tools).toEqual(['query', 'workspace_read']);
  });
});
