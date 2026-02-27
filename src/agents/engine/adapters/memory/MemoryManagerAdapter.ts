/**
 * MemoryManagerAdapter
 *
 * Implements the IMemoryStore port with SQLite-backed persistence via Tauri IPC.
 * Operations, preferences, and corrections are stored in the backend
 * `agent_memory` table. When IPC is unavailable (e.g., in tests or offline),
 * a simple in-memory Map fallback is used.
 *
 * Conversations and project memory remain in-memory (not persisted via IPC).
 */

import { commands, type MemoryEntry } from '@/bindings';
import { createLogger } from '@/services/logger';
import type {
  ConversationMemory,
  IMemoryStore,
  MemoryQueryOptions,
  ProjectMemory,
  UserPreferences,
} from '../../ports/IMemoryStore';
import type { CorrectionRecord, OperationRecord } from '../../core/types';

const logger = createLogger('MemoryManagerAdapter');

// Sentinel project ID for global (non-project-specific) memory entries
const GLOBAL_PROJECT_ID = '__global__';

// =============================================================================
// Adapter
// =============================================================================

export class MemoryManagerAdapter implements IMemoryStore {
  // Conversations and project memory remain in-memory
  private readonly conversations = new Map<string, ConversationMemory>();
  private readonly projectMemory = new Map<string, ProjectMemory>();

  // In-memory fallback stores (activated on IPC failure)
  private readonly fallbackOperations = new Map<string, OperationRecord>();
  private readonly fallbackPreferences = new Map<string, unknown>();
  private readonly fallbackCorrections: CorrectionRecord[] = [];
  private ipcFailed = false;

  // Auto-incrementing ID counter for new entries
  private idCounter = 0;

  constructor() {}

  // ===========================================================================
  // Conversation Memory (in-memory only)
  // ===========================================================================

  async storeConversation(conversation: ConversationMemory): Promise<void> {
    this.conversations.set(conversation.conversationId, {
      ...conversation,
      messages: [...conversation.messages],
      initialContext: { ...conversation.initialContext },
      metadata: { ...conversation.metadata },
      lastUpdatedAt: Date.now(),
    });
  }

  async getConversation(conversationId: string): Promise<ConversationMemory | null> {
    return this.conversations.get(conversationId) ?? null;
  }

  async getRecentConversations(options?: MemoryQueryOptions): Promise<ConversationMemory[]> {
    const since = options?.since ?? 0;
    const projectId = options?.projectId;
    const limit = options?.limit ?? 20;

    return Array.from(this.conversations.values())
      .filter((conversation) => conversation.lastUpdatedAt >= since)
      .filter((conversation) => (projectId ? conversation.projectId === projectId : true))
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .slice(0, limit)
      .map((conversation) => ({
        ...conversation,
        messages: [...conversation.messages],
        initialContext: { ...conversation.initialContext },
        metadata: { ...conversation.metadata },
      }));
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.conversations.delete(conversationId);
  }

  // ===========================================================================
  // Operation Tracking (IPC-backed with fallback)
  // ===========================================================================

  async recordOperation(operation: string, projectId?: string): Promise<void> {
    if (!this.ipcFailed) {
      try {
        // Operations are stored globally (not per-project) to match
        // the getFrequentOperations / getRecentOperations interface.
        const existing = await this.getOperationEntry(GLOBAL_PROJECT_ID, operation);
        const count = existing ? existing.count + 1 : 1;
        const value = JSON.stringify({ count, lastUsed: Date.now() });

        const id = existing
          ? this.parseEntryId(existing)
          : this.generateId('op');

        const result = await commands.saveAgentMemory(
          id, GLOBAL_PROJECT_ID, 'operation', operation, value, null,
        );
        if (result.status === 'error') throw new Error(result.error);

        // Update project memory tracking
        if (projectId) {
          this.updateProjectOperations(projectId, operation);
        }
        return;
      } catch (e) {
        this.activateFallback('recordOperation', e);
      }
    }

    // Fallback: in-memory (keyed by operation name only — global scope)
    const existing = this.fallbackOperations.get(operation);
    const count = existing ? existing.count + 1 : 1;
    this.fallbackOperations.set(operation, { operation, count, lastUsed: Date.now() });

    if (projectId) {
      this.updateProjectOperations(projectId, operation);
    }
  }

  async getFrequentOperations(limit: number = 10): Promise<OperationRecord[]> {
    if (!this.ipcFailed) {
      try {
        const entries = await this.fetchCategory(GLOBAL_PROJECT_ID, 'operation');
        return entries
          .map(parseOperationEntry)
          .sort((a, b) => b.count - a.count)
          .slice(0, limit);
      } catch (e) {
        this.activateFallback('getFrequentOperations', e);
      }
    }

    return Array.from(this.fallbackOperations.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  async getRecentOperations(limit: number = 10): Promise<OperationRecord[]> {
    if (!this.ipcFailed) {
      try {
        // Backend sorts by updatedAt DESC already
        const entries = await this.fetchCategory(GLOBAL_PROJECT_ID, 'operation');
        return entries.map(parseOperationEntry).slice(0, limit);
      } catch (e) {
        this.activateFallback('getRecentOperations', e);
      }
    }

    return Array.from(this.fallbackOperations.values())
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, limit);
  }

  // ===========================================================================
  // Corrections (IPC-backed with fallback)
  // ===========================================================================

  async recordCorrection(original: string, corrected: string, context?: string): Promise<void> {
    if (!this.ipcFailed) {
      try {
        const id = this.generateId('corr');
        const value = JSON.stringify({ original, corrected, context });
        const result = await commands.saveAgentMemory(
          id, GLOBAL_PROJECT_ID, 'correction', original, value, null,
        );
        if (result.status === 'error') throw new Error(result.error);
        return;
      } catch (e) {
        this.activateFallback('recordCorrection', e);
      }
    }

    this.fallbackCorrections.push({ original, corrected, context });
  }

  async getCorrections(limit: number = 20): Promise<CorrectionRecord[]> {
    if (!this.ipcFailed) {
      try {
        const entries = await this.fetchCategory(GLOBAL_PROJECT_ID, 'correction');
        return entries.map(parseCorrectionEntry).slice(0, limit);
      } catch (e) {
        this.activateFallback('getCorrections', e);
      }
    }

    return [...this.fallbackCorrections].reverse().slice(0, limit);
  }

  async searchCorrections(query: string, limit: number = 20): Promise<CorrectionRecord[]> {
    const all = await this.getCorrections(100);
    const lowerQuery = query.toLowerCase();
    return all
      .filter(
        (c) =>
          c.original.toLowerCase().includes(lowerQuery) ||
          c.corrected.toLowerCase().includes(lowerQuery) ||
          (c.context ?? '').toLowerCase().includes(lowerQuery),
      )
      .slice(0, limit);
  }

  // ===========================================================================
  // User Preferences (IPC-backed with fallback)
  // ===========================================================================

  async setPreferences(preferences: Partial<UserPreferences>): Promise<void> {
    const current = await this.getPreferences();
    const mergedCustom = { ...current.custom, ...(preferences.custom ?? {}) };

    const merged: UserPreferences = {
      ...current,
      ...preferences,
      custom: mergedCustom,
    };

    const keys: (keyof Omit<UserPreferences, 'custom'>)[] = [
      'defaultTransitionType',
      'defaultTransitionDuration',
      'defaultVolume',
      'language',
    ];

    for (const key of keys) {
      if (merged[key] !== undefined) {
        await this.setPreference(key, merged[key]);
      }
    }
    await this.setPreference('custom', merged.custom);
  }

  async getPreferences(): Promise<UserPreferences> {
    const defaultTransitionType = await this.getPreference<string>('defaultTransitionType');
    const defaultTransitionDuration = await this.getPreference<number>(
      'defaultTransitionDuration',
    );
    const defaultVolume = await this.getPreference<number>('defaultVolume');
    const language = await this.getPreference<string>('language');
    const custom =
      (await this.getPreference<Record<string, unknown>>('custom')) ?? {};

    return {
      defaultTransitionType,
      defaultTransitionDuration,
      defaultVolume,
      language,
      custom,
    };
  }

  async setPreference(key: string, value: unknown): Promise<void> {
    if (!this.ipcFailed) {
      try {
        const id = `pref-${key}`;
        const serialized = JSON.stringify(value);
        const result = await commands.saveAgentMemory(
          id, GLOBAL_PROJECT_ID, 'preference', key, serialized, null,
        );
        if (result.status === 'error') throw new Error(result.error);
        return;
      } catch (e) {
        this.activateFallback('setPreference', e);
      }
    }

    this.fallbackPreferences.set(key, value);
  }

  async getPreference<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    if (!this.ipcFailed) {
      try {
        const entries = await this.fetchCategory(GLOBAL_PROJECT_ID, 'preference');
        const entry = entries.find((e) => e.key === key);
        if (entry) {
          return JSON.parse(entry.value) as T;
        }
        return defaultValue;
      } catch (e) {
        this.activateFallback('getPreference', e);
      }
    }

    const value = this.fallbackPreferences.get(key);
    return (value as T | undefined) ?? defaultValue;
  }

  // ===========================================================================
  // Project Memory (in-memory only)
  // ===========================================================================

  async getProjectMemory(projectId: string): Promise<ProjectMemory | null> {
    return this.projectMemory.get(projectId) ?? null;
  }

  async updateProjectMemory(projectId: string, updates: Partial<ProjectMemory>): Promise<void> {
    const existing = this.projectMemory.get(projectId) ?? this.createProjectMemory(projectId);
    this.projectMemory.set(projectId, {
      ...existing,
      ...updates,
      projectId,
      frequentAssets: updates.frequentAssets ?? existing.frequentAssets,
      commonOperations: updates.commonOperations ?? existing.commonOperations,
      notes: updates.notes ?? existing.notes,
      lastAccessed: Date.now(),
    });
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async clearAll(): Promise<void> {
    this.conversations.clear();
    this.projectMemory.clear();
    this.fallbackOperations.clear();
    this.fallbackPreferences.clear();
    this.fallbackCorrections.length = 0;

    if (!this.ipcFailed) {
      try {
        const result = await commands.clearAgentMemory(GLOBAL_PROJECT_ID, null);
        if (result.status === 'error') throw new Error(result.error);
      } catch {
        // Best effort — local state already cleared
      }
    }
  }

  async clearProject(projectId: string): Promise<void> {
    this.projectMemory.delete(projectId);

    for (const [conversationId, conversation] of this.conversations.entries()) {
      if (conversation.projectId === projectId) {
        this.conversations.delete(conversationId);
      }
    }

    if (!this.ipcFailed) {
      try {
        const result = await commands.clearAgentMemory(projectId, null);
        if (result.status === 'error') throw new Error(result.error);
      } catch {
        // Best effort
      }
    }
  }

  async pruneOld(olderThan: number): Promise<void> {
    for (const [conversationId, conversation] of this.conversations.entries()) {
      if (conversation.lastUpdatedAt < olderThan) {
        this.conversations.delete(conversationId);
      }
    }
  }

  async export(): Promise<Record<string, unknown>> {
    const conversationEntries = Array.from(this.conversations.values()).map((conversation) => ({
      ...conversation,
      messages: [...conversation.messages],
      initialContext: { ...conversation.initialContext },
      metadata: { ...conversation.metadata },
    }));

    return {
      conversations: conversationEntries,
      preferences: await this.getPreferences(),
      operations: await this.getFrequentOperations(100),
      corrections: await this.getCorrections(100),
      projectMemory: Array.from(this.projectMemory.values()),
      exportedAt: Date.now(),
    };
  }

  async import(data: Record<string, unknown>): Promise<void> {
    await this.clearAll();

    const rawConversations = Array.isArray(data.conversations)
      ? (data.conversations as ConversationMemory[])
      : [];
    for (const conversation of rawConversations) {
      await this.storeConversation(conversation);
    }

    if (isObject(data.preferences)) {
      await this.setPreferences(data.preferences as Partial<UserPreferences>);
    }

    const rawOperations = Array.isArray(data.operations)
      ? (data.operations as OperationRecord[])
      : [];
    for (const operation of rawOperations) {
      const repeatCount = Math.max(1, operation.count);
      for (let i = 0; i < repeatCount; i += 1) {
        await this.recordOperation(operation.operation);
      }
    }

    const rawCorrections = Array.isArray(data.corrections)
      ? (data.corrections as CorrectionRecord[])
      : [];
    for (const correction of rawCorrections) {
      await this.recordCorrection(correction.original, correction.corrected, correction.context);
    }

    const rawProjectMemory = Array.isArray(data.projectMemory)
      ? (data.projectMemory as ProjectMemory[])
      : [];
    for (const pm of rawProjectMemory) {
      await this.updateProjectMemory(pm.projectId, pm);
    }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private createProjectMemory(projectId: string): ProjectMemory {
    return {
      projectId,
      frequentAssets: [],
      commonOperations: [],
      notes: [],
      lastAccessed: Date.now(),
    };
  }

  private updateProjectOperations(projectId: string, operation: string): void {
    const existing = this.projectMemory.get(projectId) ?? this.createProjectMemory(projectId);
    const nextOperations = [
      operation,
      ...existing.commonOperations.filter((name) => name !== operation),
    ];
    this.projectMemory.set(projectId, {
      ...existing,
      commonOperations: nextOperations.slice(0, 30),
      lastAccessed: Date.now(),
    });
  }

  private generateId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${Date.now()}-${this.idCounter}`;
  }

  private async fetchCategory(
    projectId: string,
    category: string,
  ): Promise<MemoryEntry[]> {
    const result = await commands.getAgentMemory(projectId, category);
    if (result.status === 'error') throw new Error(result.error);
    return result.data;
  }

  /** Look up an existing operation entry by project + operation name. */
  private async getOperationEntry(
    projectId: string,
    operation: string,
  ): Promise<(OperationRecord & { _id: string }) | null> {
    const entries = await this.fetchCategory(projectId, 'operation');
    const entry = entries.find((e) => e.key === operation);
    if (!entry) return null;
    const parsed = parseOperationEntry(entry);
    return { ...parsed, _id: entry.id };
  }

  /** Extract the stored ID from an entry for upsert. */
  private parseEntryId(record: { _id: string }): string {
    return record._id;
  }

  private activateFallback(method: string, error: unknown): void {
    if (!this.ipcFailed) {
      logger.warn(
        `IPC failed in ${method}, switching to in-memory fallback:`,
        { error: error instanceof Error ? error.message : error },
      );
      this.ipcFailed = true;
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createMemoryManagerAdapter(): MemoryManagerAdapter {
  return new MemoryManagerAdapter();
}

// =============================================================================
// Entry Parsers
// =============================================================================

function parseOperationEntry(entry: MemoryEntry): OperationRecord {
  try {
    const parsed = JSON.parse(entry.value) as { count?: number; lastUsed?: number };
    return {
      operation: entry.key,
      count: parsed.count ?? 1,
      lastUsed: parsed.lastUsed ?? entry.updatedAt,
    };
  } catch {
    return { operation: entry.key, count: 1, lastUsed: entry.updatedAt };
  }
}

function parseCorrectionEntry(entry: MemoryEntry): CorrectionRecord {
  try {
    const parsed = JSON.parse(entry.value) as {
      original?: string;
      corrected?: string;
      context?: string;
    };
    return {
      original: parsed.original ?? entry.key,
      corrected: parsed.corrected ?? '',
      context: parsed.context,
    };
  } catch {
    return { original: entry.key, corrected: '', context: undefined };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
