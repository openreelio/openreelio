import { describe, expect, it } from 'vitest';
import { MockToolExecutor } from './MockToolExecutor';
import { createScopedToolExecutor } from './ScopedToolExecutor';
import { getAllowedToolNamesForAgent } from '../../core/agentCatalog';
import { getExperimentalAgentDefinition } from '../../core/agentDefinitions.experimental';
import { EDITOR_AGENT_DEFINITION } from '../../core/agentDefinitions';

function createMockExecutor(): MockToolExecutor {
  const executor = new MockToolExecutor();

  executor.registerTools([
    {
      info: {
        name: 'query',
        description: 'Query project state',
        category: 'analysis',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: true,
      },
      parameters: { type: 'object' },
      result: { success: true, data: { ok: true }, duration: 5 },
    },
    {
      info: {
        name: 'edit',
        description: 'Edit timeline',
        category: 'timeline',
        riskLevel: 'medium',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: { type: 'object' },
      result: { success: true, data: { ok: true }, duration: 8 },
    },
    {
      info: {
        name: 'audio',
        description: 'Adjust audio',
        category: 'audio',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: { type: 'object' },
      result: { success: true, data: { ok: true }, duration: 6 },
    },
    {
      info: {
        name: 'read_workspace_document',
        description: 'Read a workspace file',
        category: 'utility',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: true,
      },
      parameters: { type: 'object' },
      result: { success: true, data: { ok: true }, duration: 3 },
    },
    {
      info: {
        name: 'write_workspace_document',
        description: 'Write a workspace file',
        category: 'utility',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: false,
      },
      parameters: { type: 'object' },
      result: { success: true, data: { ok: true }, duration: 4 },
    },
  ]);

  return executor;
}

describe('ScopedToolExecutor', () => {
  it('filters available tools to the active agent profile', () => {
    const baseExecutor = createMockExecutor();
    const analyst = getExperimentalAgentDefinition('analyst');
    expect(analyst).toBeDefined();

    const scoped = createScopedToolExecutor(
      baseExecutor,
      getAllowedToolNamesForAgent(analyst!, baseExecutor.getAvailableTools()),
    );

    expect(scoped.getAvailableTools().map((tool) => tool.name)).toEqual([
      'query',
      'read_workspace_document',
    ]);
    expect(scoped.hasTool('edit')).toBe(false);
    expect(scoped.hasTool('write_workspace_document')).toBe(false);
  });

  it('rejects tool execution outside the active agent profile scope', async () => {
    const baseExecutor = createMockExecutor();
    const analyst = getExperimentalAgentDefinition('analyst');
    expect(analyst).toBeDefined();

    const scoped = createScopedToolExecutor(
      baseExecutor,
      getAllowedToolNamesForAgent(analyst!, baseExecutor.getAvailableTools()),
    );

    const result = await scoped.execute(
      'edit',
      {},
      { projectId: 'project-1', sessionId: 'session-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not available in the active agent profile/i);
    expect(baseExecutor.getExecutionCount()).toBe(0);
  });

  it('preserves unrestricted access for the editor profile', async () => {
    const baseExecutor = createMockExecutor();
    const scoped = createScopedToolExecutor(
      baseExecutor,
      getAllowedToolNamesForAgent(EDITOR_AGENT_DEFINITION, baseExecutor.getAvailableTools()),
    );

    const result = await scoped.execute(
      'edit',
      {},
      { projectId: 'project-1', sessionId: 'session-1' },
    );

    expect(result.success).toBe(true);
    expect(baseExecutor.getExecutionCount()).toBe(1);
  });
});
