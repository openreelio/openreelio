import { KnowledgeBase } from './knowledgeBase';
import { readWorkspaceDocumentFromBackend } from '@/services/workspaceGateway';
import { createLogger } from '@/services/logger';

const logger = createLogger('ProjectPromptContext');

const INSTRUCTION_DOCUMENT_CANDIDATES = ['CLAUDE.md', 'AGENTS.md'] as const;
const MAX_KNOWLEDGE_ENTRIES = 8;
const MAX_CUSTOM_INSTRUCTION_CHARS = 2_400;

export interface ProjectPromptContext {
  knowledge: string[];
  customInstructions?: string;
}

export async function loadProjectPromptContext(
  projectId: string | null | undefined,
): Promise<ProjectPromptContext> {
  if (!projectId) {
    return { knowledge: [] };
  }

  const [knowledge, customInstructions] = await Promise.all([
    loadKnowledgeEntries(projectId),
    loadInstructionDocument(),
  ]);

  return {
    knowledge,
    customInstructions: customInstructions ?? undefined,
  };
}

async function loadKnowledgeEntries(projectId: string): Promise<string[]> {
  const entries = await KnowledgeBase.getContextForPrompt(projectId);
  return entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, MAX_KNOWLEDGE_ENTRIES);
}

async function loadInstructionDocument(): Promise<string | null> {
  for (const relativePath of INSTRUCTION_DOCUMENT_CANDIDATES) {
    try {
      const document = await readWorkspaceDocumentFromBackend(relativePath);
      const normalized = normalizeInstructionContent(document.content);
      if (normalized) {
        return normalized;
      }
    } catch (error) {
      logger.debug('Project instruction document unavailable', {
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

function normalizeInstructionContent(content: string): string | null {
  const normalized = content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

  if (!normalized) {
    return null;
  }

  if (normalized.length <= MAX_CUSTOM_INSTRUCTION_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_CUSTOM_INSTRUCTION_CHARS - 3).trimEnd()}...`;
}
