import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProjectPromptContext } from './projectPromptContext';
import { KnowledgeBase } from './knowledgeBase';
import { readWorkspaceDocumentFromBackend } from '@/services/workspaceGateway';

vi.mock('./knowledgeBase', () => ({
  KnowledgeBase: {
    getContextForPrompt: vi.fn(),
  },
}));

vi.mock('@/services/workspaceGateway', () => ({
  readWorkspaceDocumentFromBackend: vi.fn(),
}));

describe('loadProjectPromptContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(KnowledgeBase.getContextForPrompt).mockResolvedValue([]);
  });

  it('should return empty knowledge when no project is active', async () => {
    const result = await loadProjectPromptContext(null);

    expect(result).toEqual({ knowledge: [] });
    expect(KnowledgeBase.getContextForPrompt).not.toHaveBeenCalled();
  });

  it('should load knowledge entries and prefer CLAUDE.md for custom instructions', async () => {
    vi.mocked(KnowledgeBase.getContextForPrompt).mockResolvedValue([
      'Use warm grade defaults',
      'Keep subtitle pacing tight',
    ]);
    vi.mocked(readWorkspaceDocumentFromBackend).mockImplementation(async (relativePath) => {
      if (relativePath === 'CLAUDE.md') {
        return {
          relativePath,
          content: '# CLAUDE\nProject instruction body',
          sizeBytes: 30,
          modifiedAtUnixSec: 100,
        };
      }

      throw new Error('not found');
    });

    const result = await loadProjectPromptContext('project-1');

    expect(result).toEqual({
      knowledge: ['Use warm grade defaults', 'Keep subtitle pacing tight'],
      customInstructions: '# CLAUDE\nProject instruction body',
    });
  });

  it('should fall back to AGENTS.md when CLAUDE.md is unavailable', async () => {
    vi.mocked(readWorkspaceDocumentFromBackend).mockImplementation(async (relativePath) => {
      if (relativePath === 'AGENTS.md') {
        return {
          relativePath,
          content: 'Follow the repo rules.',
          sizeBytes: 24,
          modifiedAtUnixSec: 100,
        };
      }

      throw new Error('missing');
    });

    const result = await loadProjectPromptContext('project-1');

    expect(result.customInstructions).toBe('Follow the repo rules.');
  });

  it('should truncate oversized instruction documents', async () => {
    const oversized = 'A'.repeat(2_500);
    vi.mocked(readWorkspaceDocumentFromBackend).mockResolvedValue({
      relativePath: 'CLAUDE.md',
      content: oversized,
      sizeBytes: oversized.length,
      modifiedAtUnixSec: 100,
    });

    const result = await loadProjectPromptContext('project-1');

    expect(result.customInstructions?.length).toBe(2_400);
    expect(result.customInstructions?.endsWith('...')).toBe(true);
  });
});
