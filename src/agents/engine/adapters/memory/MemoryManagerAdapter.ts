/**
 * MemoryManagerAdapter
 *
 * Bridges the legacy MemoryManager to the IMemoryStore port used by
 * the AgenticEngine.
 */

import {
  createMemoryManager,
  type MemoryManager,
  type UserCorrection,
  type OperationFrequency,
} from '@/agents/core/AgentMemory';
import type {
  ConversationMemory,
  IMemoryStore,
  MemoryQueryOptions,
  ProjectMemory,
  UserPreferences,
} from '../../ports/IMemoryStore';
import type { CorrectionRecord, OperationRecord } from '../../core/types';

export class MemoryManagerAdapter implements IMemoryStore {
  private readonly memory: MemoryManager;
  private readonly conversations = new Map<string, ConversationMemory>();
  private readonly projectMemory = new Map<string, ProjectMemory>();

  constructor(memoryManager?: MemoryManager) {
    this.memory = memoryManager ?? createMemoryManager();
  }

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

  async recordOperation(operation: string, projectId?: string): Promise<void> {
    this.memory.recordOperation(operation);

    if (!projectId) {
      return;
    }

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

  async getFrequentOperations(limit: number = 10): Promise<OperationRecord[]> {
    return this.memory.getFrequentOperations(limit).map(mapOperationFrequencyToRecord);
  }

  async getRecentOperations(limit: number = 10): Promise<OperationRecord[]> {
    return this.memory.getRecentOperations(limit).map(mapOperationFrequencyToRecord);
  }

  async recordCorrection(original: string, corrected: string, context?: string): Promise<void> {
    this.memory.recordCorrection(original, corrected, context);
  }

  async getCorrections(limit: number = 20): Promise<CorrectionRecord[]> {
    return this.memory.getCorrections().slice(-limit).reverse().map(mapUserCorrectionToRecord);
  }

  async searchCorrections(query: string, limit: number = 20): Promise<CorrectionRecord[]> {
    return this.memory
      .findRelevantCorrections(query)
      .slice(0, limit)
      .map(mapUserCorrectionToRecord);
  }

  async setPreferences(preferences: Partial<UserPreferences>): Promise<void> {
    const current = await this.getPreferences();
    const mergedCustom = { ...current.custom, ...(preferences.custom ?? {}) };

    const merged: UserPreferences = {
      ...current,
      ...preferences,
      custom: mergedCustom,
    };

    if (merged.defaultTransitionType !== undefined) {
      this.memory.setPreference('defaultTransitionType', merged.defaultTransitionType);
    }
    if (merged.defaultTransitionDuration !== undefined) {
      this.memory.setPreference('defaultTransitionDuration', merged.defaultTransitionDuration);
    }
    if (merged.defaultVolume !== undefined) {
      this.memory.setPreference('defaultVolume', merged.defaultVolume);
    }
    if (merged.language !== undefined) {
      this.memory.setPreference('language', merged.language);
    }

    this.memory.setPreference('custom', merged.custom);
  }

  async getPreferences(): Promise<UserPreferences> {
    const defaultTransitionType = this.memory.getPreference<string>('defaultTransitionType');
    const defaultTransitionDuration = this.memory.getPreference<number>(
      'defaultTransitionDuration',
    );
    const defaultVolume = this.memory.getPreference<number>('defaultVolume');
    const language = this.memory.getPreference<string>('language');
    const custom = this.memory.getPreference<Record<string, unknown>>('custom', {}) ?? {};

    return {
      defaultTransitionType,
      defaultTransitionDuration,
      defaultVolume,
      language,
      custom,
    };
  }

  async setPreference(key: string, value: unknown): Promise<void> {
    this.memory.setPreference(key, value);
  }

  async getPreference<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    return this.memory.getPreference<T>(key, defaultValue);
  }

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

  async clearAll(): Promise<void> {
    this.conversations.clear();
    this.projectMemory.clear();
    this.memory.clearAll();
  }

  async clearProject(projectId: string): Promise<void> {
    this.projectMemory.delete(projectId);

    for (const [conversationId, conversation] of this.conversations.entries()) {
      if (conversation.projectId === projectId) {
        this.conversations.delete(conversationId);
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
    for (const projectMemory of rawProjectMemory) {
      await this.updateProjectMemory(projectMemory.projectId, projectMemory);
    }
  }

  private createProjectMemory(projectId: string): ProjectMemory {
    return {
      projectId,
      frequentAssets: [],
      commonOperations: [],
      notes: [],
      lastAccessed: Date.now(),
    };
  }
}

export function createMemoryManagerAdapter(memoryManager?: MemoryManager): MemoryManagerAdapter {
  return new MemoryManagerAdapter(memoryManager);
}

function mapOperationFrequencyToRecord(operation: OperationFrequency): OperationRecord {
  return {
    operation: operation.operation,
    count: operation.count,
    lastUsed: operation.lastUsed,
  };
}

function mapUserCorrectionToRecord(correction: UserCorrection): CorrectionRecord {
  return {
    original: correction.original,
    corrected: correction.corrected,
    context: correction.context,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
