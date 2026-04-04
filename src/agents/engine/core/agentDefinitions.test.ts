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

    expect(experimentalDefinitions.map((definition) => definition.id)).toEqual([
      'editor',
      'analyst',
      'colorist',
      'audio',
    ]);
    expect(subAgents.map((definition) => definition.id)).toEqual([
      'analyst',
      'colorist',
      'audio',
    ]);
    expect(getExperimentalAgentDefinition('analyst')?.mode).toBe('subagent');
  });
});
