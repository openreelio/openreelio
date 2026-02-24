/**
 * Knowledge Base
 *
 * Cross-session learning system that persists learned patterns,
 * user corrections, and project-specific conventions to SQLite.
 *
 * The knowledge base enriches system prompts with project-specific
 * context, enabling the AI to improve over time.
 */

import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/services/logger';

const logger = createLogger('KnowledgeBase');

// =============================================================================
// Types
// =============================================================================

export type KnowledgeCategory =
  | 'convention'
  | 'preference'
  | 'correction'
  | 'pattern';

export interface KnowledgeEntry {
  id: string;
  projectId: string;
  category: KnowledgeCategory;
  content: string;
  sourceSessionId?: string;
  createdAt: number;
  relevanceScore: number;
}

export interface KnowledgeQuery {
  projectId: string;
  categories?: KnowledgeCategory[];
  limit?: number;
  minRelevance?: number;
}

// =============================================================================
// Knowledge Base
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace KnowledgeBase {
  const KNOWLEDGE_LIMIT = 20;
  const MIN_RELEVANCE = 0.3;

  /**
   * Record a user correction (when user says "no, do X instead").
   * These have the highest relevance for future interactions.
   */
  export async function recordCorrection(
    projectId: string,
    original: string,
    corrected: string,
    sessionId?: string,
  ): Promise<void> {
    const content = `When asked "${truncate(original, 100)}", prefer: "${truncate(corrected, 200)}"`;
    await saveEntry(projectId, 'correction', content, sessionId, 1.0);
  }

  /**
   * Record a user preference (editing style, defaults, etc.).
   */
  export async function recordPreference(
    projectId: string,
    key: string,
    value: string,
    sessionId?: string,
  ): Promise<void> {
    const content = `${key}: ${value}`;
    await saveEntry(projectId, 'preference', content, sessionId, 0.8);
  }

  /**
   * Record a project convention (naming, structure, etc.).
   */
  export async function recordConvention(
    projectId: string,
    convention: string,
    sessionId?: string,
  ): Promise<void> {
    await saveEntry(projectId, 'convention', convention, sessionId, 0.7);
  }

  /**
   * Record a detected pattern (frequently used workflow).
   */
  export async function recordPattern(
    projectId: string,
    pattern: string,
    sessionId?: string,
  ): Promise<void> {
    await saveEntry(projectId, 'pattern', pattern, sessionId, 0.5);
  }

  /**
   * Get relevant knowledge entries for injection into the system prompt.
   */
  export async function getContextForPrompt(
    projectId: string,
    categories?: KnowledgeCategory[],
  ): Promise<string[]> {
    try {
      const entries = await queryEntries({
        projectId,
        categories,
        limit: KNOWLEDGE_LIMIT,
        minRelevance: MIN_RELEVANCE,
      });
      return entries.map((e) => e.content);
    } catch (err) {
      logger.warn('Failed to load knowledge entries', { err });
      return [];
    }
  }

  /**
   * Delete a knowledge entry.
   */
  export async function deleteEntry(entryId: string): Promise<void> {
    try {
      await invoke('delete_ai_knowledge', { entryId });
    } catch (err) {
      logger.error('Failed to delete knowledge entry', { entryId, err });
      throw err;
    }
  }

  /**
   * List all knowledge for a project (for UI display).
   */
  export async function listAll(projectId: string): Promise<KnowledgeEntry[]> {
    return queryEntries({ projectId, limit: 100 });
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  async function saveEntry(
    projectId: string,
    category: KnowledgeCategory,
    content: string,
    sessionId?: string,
    relevanceScore = 0.5,
  ): Promise<void> {
    try {
      await invoke('save_ai_knowledge', {
        projectId,
        category,
        content,
        sourceSessionId: sessionId ?? null,
        relevanceScore,
      });
      logger.info('Knowledge entry saved', { projectId, category });
    } catch (err) {
      logger.error('Failed to save knowledge entry', { projectId, category, err });
      throw err;
    }
  }

  async function queryEntries(query: KnowledgeQuery): Promise<KnowledgeEntry[]> {
    try {
      const entries = await invoke<KnowledgeEntry[]>('query_ai_knowledge', {
        projectId: query.projectId,
        categories: query.categories ?? null,
        limit: query.limit ?? KNOWLEDGE_LIMIT,
        minRelevance: query.minRelevance ?? MIN_RELEVANCE,
      });
      return entries;
    } catch (err) {
      logger.warn('Failed to query knowledge entries, returning empty', { err });
      return [];
    }
  }

  function truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
  }
}
