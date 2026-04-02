import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendToolExecutor } from './BackendToolExecutor';
import type {
  IToolExecutor,
  ToolDefinition,
  ToolInfo,
  BatchExecutionResult,
} from '../../ports/IToolExecutor';
import type { RiskLevel, ValidationResult } from '../../core/types';

const {
  mockIsMetaToolsEnabled,
  mockGetVisibleMetaToolNames,
  mockGetWorkspaceToolNames,
} = vi.hoisted(() => ({
  mockIsMetaToolsEnabled: vi.fn(),
  mockGetVisibleMetaToolNames: vi.fn(),
  mockGetWorkspaceToolNames: vi.fn(),
}));

vi.mock('@/config/featureFlags', () => ({
  isMetaToolsEnabled: mockIsMetaToolsEnabled,
}));

vi.mock('@/agents/tools/metaTools', () => ({
  getVisibleMetaToolNames: mockGetVisibleMetaToolNames,
}));

vi.mock('@/agents/tools/workspaceTools', () => ({
  getWorkspaceToolNames: mockGetWorkspaceToolNames,
}));

function createToolInfo(name: string, category: string): ToolInfo {
  return {
    name,
    description: name,
    category,
    riskLevel: 'low' as RiskLevel,
    estimatedDuration: 'instant',
    supportsUndo: false,
    parallelizable: false,
  };
}

function createFrontendExecutor(tools: ToolInfo[]): IToolExecutor {
  return {
    execute: vi.fn(async () => ({ success: true, duration: 1 })),
    executeBatch: vi.fn(async () => ({
      success: true,
      results: [],
      totalDuration: 1,
      successCount: 0,
      failureCount: 0,
    }) as BatchExecutionResult),
    getAvailableTools: vi.fn((category?: string) =>
      category ? tools.filter((tool) => tool.category === category) : tools),
    getToolDefinition: vi.fn((name: string) =>
      tools.find((tool) => tool.name === name)
        ? ({
            name,
            description: name,
            category: tools.find((tool) => tool.name === name)?.category ?? 'utility',
            parameters: {},
            riskLevel: 'low' as RiskLevel,
            estimatedDuration: 'instant',
            supportsUndo: false,
            parallelizable: false,
          } as ToolDefinition)
        : null),
    validateArgs: vi.fn(() => ({ valid: true, errors: [] }) as ValidationResult),
    hasTool: vi.fn((name: string) => tools.some((tool) => tool.name === name)),
    getToolsByCategory: vi.fn(() => new Map()),
    getToolsByRisk: vi.fn(() => []),
  };
}

describe('BackendToolExecutor visibility', () => {
  beforeEach(() => {
    mockIsMetaToolsEnabled.mockReturnValue(true);
    mockGetVisibleMetaToolNames.mockReturnValue(['query', 'edit', 'audio', 'effects', 'text']);
    mockGetWorkspaceToolNames.mockReturnValue(['list_workspace_documents']);
  });

  it('hides execute_plan from the default meta-tool surface', () => {
    const frontend = createFrontendExecutor([
      createToolInfo('query', 'analysis'),
      createToolInfo('edit', 'timeline'),
      createToolInfo('execute_plan', 'utility'),
      createToolInfo('split_clip', 'clip'),
      createToolInfo('list_workspace_documents', 'utility'),
    ]);

    const backend = new BackendToolExecutor(frontend);
    const visibleNames = backend.getAvailableTools().map((tool) => tool.name);

    expect(visibleNames).toEqual(['query', 'edit', 'list_workspace_documents']);
  });

  it('keeps category-specific tool reads unfiltered', () => {
    const frontend = createFrontendExecutor([
      createToolInfo('split_clip', 'clip'),
      createToolInfo('delete_clip', 'clip'),
    ]);

    const backend = new BackendToolExecutor(frontend);
    const visibleNames = backend.getAvailableTools('clip').map((tool) => tool.name);

    expect(visibleNames).toEqual(['split_clip', 'delete_clip']);
  });
});
