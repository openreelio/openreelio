import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIsMetaToolsEnabled, mockGetVisibleMetaToolNames, mockGetWorkspaceToolNames } =
  vi.hoisted(() => ({
    mockIsMetaToolsEnabled: vi.fn(),
    mockGetVisibleMetaToolNames: vi.fn(),
    mockGetWorkspaceToolNames: vi.fn(),
  }));

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    isMetaToolsEnabled: mockIsMetaToolsEnabled,
  };
});

vi.mock('@/agents/tools/metaTools', () => ({
  getVisibleMetaToolNames: mockGetVisibleMetaToolNames,
}));

vi.mock('@/agents/tools/workspaceTools', () => ({
  getWorkspaceToolNames: mockGetWorkspaceToolNames,
}));

import { createToolRegistryAdapter } from './ToolRegistryAdapter';
import { ToolRegistry, type ToolCategory, type ToolDefinition } from '@/agents/ToolRegistry';

function createTool(name: string, category: ToolCategory, description = name): ToolDefinition {
  return {
    name,
    description,
    category,
    parameters: { type: 'object', properties: {} },
    handler: vi.fn().mockResolvedValue({ success: true }),
  };
}

describe('ToolRegistryAdapter meta-tool visibility', () => {
  beforeEach(() => {
    mockIsMetaToolsEnabled.mockReturnValue(true);
    mockGetVisibleMetaToolNames.mockReturnValue(['query', 'edit', 'audio', 'effects', 'text']);
    mockGetWorkspaceToolNames.mockReturnValue(['list_workspace_documents']);
  });

  it('hides execute_plan and individual tools from the default tool surface', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('query', 'analysis'));
    registry.register(createTool('edit', 'timeline'));
    registry.register(createTool('execute_plan', 'utility'));
    registry.register(createTool('split_clip', 'clip'));
    registry.register(createTool('list_workspace_documents', 'utility'));

    const adapter = createToolRegistryAdapter(registry);
    const visibleNames = adapter.getAvailableTools().map((tool) => tool.name);

    expect(visibleNames).toEqual(['query', 'edit', 'list_workspace_documents']);
  });

  it('keeps category-specific reads unfiltered for non-LLM callers', () => {
    const registry = new ToolRegistry();
    registry.register(createTool('split_clip', 'clip'));
    registry.register(createTool('delete_clip', 'clip'));

    const adapter = createToolRegistryAdapter(registry);
    const visibleNames = adapter.getAvailableTools('clip').map((tool) => tool.name);

    expect(visibleNames).toEqual(['split_clip', 'delete_clip']);
  });
});
