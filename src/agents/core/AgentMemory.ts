/**
 * Agent Memory
 *
 * Short-term and long-term memory systems for agents.
 * Enables context persistence and learning from interactions.
 */

import type { AgentMessage, AgentContext } from '../Agent';
import { createLogger } from '@/services/logger';

const logger = createLogger('AgentMemory');

// =============================================================================
// Types
// =============================================================================

/**
 * Short-term memory for a single conversation.
 */
export interface ShortTermMemory {
  /** Unique conversation identifier */
  conversationId: string;
  /** Messages in this conversation */
  messages: AgentMessage[];
  /** Current context */
  context: AgentContext;
  /** When the conversation started */
  startedAt: number;
  /** When last updated */
  lastUpdatedAt: number;
  /** Additional metadata */
  metadata: Record<string, unknown>;
}

/**
 * Long-term memory that persists across conversations.
 */
export interface LongTermMemory {
  /** User preferences learned over time */
  preferences: Record<string, unknown>;
  /** Frequently used operations */
  frequentOperations: OperationFrequency[];
  /** Corrections the user has made */
  corrections: UserCorrection[];
  /** Project-specific information */
  projectMemory: Map<string, ProjectMemory>;
  /** When memory was last updated */
  lastUpdatedAt: number;
}

/**
 * Tracks frequency of operations.
 */
export interface OperationFrequency {
  /** Operation/tool name */
  operation: string;
  /** Number of times used */
  count: number;
  /** Last used timestamp */
  lastUsed: number;
}

/**
 * A user correction to agent behavior.
 */
export interface UserCorrection {
  /** What the agent originally did/said */
  original: string;
  /** What the user corrected it to */
  corrected: string;
  /** When the correction was made */
  timestamp: number;
  /** Context of the correction */
  context?: string;
}

/**
 * Project-specific memory.
 */
export interface ProjectMemory {
  /** Project identifier */
  projectId: string;
  /** Frequently accessed assets */
  frequentAssets: string[];
  /** Commonly used sequences */
  commonSequences: string[];
  /** User notes about the project */
  notes: string[];
  /** Custom project-level preferences */
  preferences: Record<string, unknown>;
}

/**
 * Configuration for memory system.
 */
export interface MemoryConfig {
  /** Maximum corrections to store */
  maxCorrections?: number;
  /** Maximum operation frequency entries */
  maxOperations?: number;
  /** Short-term memory expiry in milliseconds */
  shortTermExpiry?: number;
}

// =============================================================================
// Memory Manager
// =============================================================================

/**
 * Manages agent short-term and long-term memory.
 *
 * Features:
 * - Conversation-scoped short-term memory
 * - Persistent long-term memory
 * - Operation frequency tracking
 * - User correction learning
 *
 * @example
 * ```typescript
 * const memory = new MemoryManager();
 *
 * // Store conversation
 * memory.storeConversation('conv_001', messages, context);
 *
 * // Record an operation
 * memory.recordOperation('split_clip');
 *
 * // Get frequent operations
 * const frequent = memory.getFrequentOperations(5);
 *
 * // Record a correction
 * memory.recordCorrection('cut at 5s', 'split at 5 seconds');
 * ```
 */
export class MemoryManager {
  private shortTermMemory: Map<string, ShortTermMemory> = new Map();
  private longTermMemory: LongTermMemory;
  private config: Required<MemoryConfig>;

  constructor(config: MemoryConfig = {}) {
    this.config = {
      maxCorrections: config.maxCorrections ?? 100,
      maxOperations: config.maxOperations ?? 50,
      shortTermExpiry: config.shortTermExpiry ?? 24 * 60 * 60 * 1000, // 24 hours
    };

    this.longTermMemory = {
      preferences: {},
      frequentOperations: [],
      corrections: [],
      projectMemory: new Map(),
      lastUpdatedAt: Date.now(),
    };
  }

  // ===========================================================================
  // Short-Term Memory
  // ===========================================================================

  /**
   * Store conversation in short-term memory.
   *
   * @param conversationId - Unique conversation ID
   * @param messages - Conversation messages
   * @param context - Current agent context
   * @param metadata - Optional metadata
   */
  storeConversation(
    conversationId: string,
    messages: AgentMessage[],
    context: AgentContext,
    metadata: Record<string, unknown> = {}
  ): void {
    const existing = this.shortTermMemory.get(conversationId);

    const memory: ShortTermMemory = {
      conversationId,
      messages: [...messages],
      context: { ...context },
      startedAt: existing?.startedAt ?? Date.now(),
      lastUpdatedAt: Date.now(),
      metadata: { ...existing?.metadata, ...metadata },
    };

    this.shortTermMemory.set(conversationId, memory);

    logger.debug('Conversation stored', {
      conversationId,
      messageCount: messages.length,
    });
  }

  /**
   * Retrieve conversation from short-term memory.
   *
   * @param conversationId - Conversation ID
   * @returns The conversation memory or null
   */
  getConversation(conversationId: string): ShortTermMemory | null {
    return this.shortTermMemory.get(conversationId) ?? null;
  }

  /**
   * List all active conversations.
   */
  listConversations(): ShortTermMemory[] {
    return Array.from(this.shortTermMemory.values());
  }

  /**
   * Clear a specific conversation.
   *
   * @param conversationId - Conversation ID
   */
  clearConversation(conversationId: string): void {
    this.shortTermMemory.delete(conversationId);
    logger.debug('Conversation cleared', { conversationId });
  }

  /**
   * Clear expired conversations.
   */
  clearExpiredConversations(): number {
    const now = Date.now();
    let cleared = 0;

    for (const [id, memory] of this.shortTermMemory) {
      if (now - memory.lastUpdatedAt > this.config.shortTermExpiry) {
        this.shortTermMemory.delete(id);
        cleared++;
      }
    }

    if (cleared > 0) {
      logger.debug('Expired conversations cleared', { count: cleared });
    }

    return cleared;
  }

  // ===========================================================================
  // Long-Term Memory - Operations
  // ===========================================================================

  /**
   * Record an operation usage.
   *
   * @param operation - Operation/tool name
   */
  recordOperation(operation: string): void {
    const existing = this.longTermMemory.frequentOperations.find(
      (op) => op.operation === operation
    );

    if (existing) {
      existing.count++;
      existing.lastUsed = Date.now();
    } else {
      this.longTermMemory.frequentOperations.push({
        operation,
        count: 1,
        lastUsed: Date.now(),
      });
    }

    // Trim to max size, keeping most frequent
    this.longTermMemory.frequentOperations.sort((a, b) => b.count - a.count);
    if (this.longTermMemory.frequentOperations.length > this.config.maxOperations) {
      this.longTermMemory.frequentOperations = this.longTermMemory.frequentOperations.slice(
        0,
        this.config.maxOperations
      );
    }

    this.longTermMemory.lastUpdatedAt = Date.now();
  }

  /**
   * Get most frequent operations.
   *
   * @param limit - Maximum number to return
   * @returns Sorted list of frequent operations
   */
  getFrequentOperations(limit: number = 10): OperationFrequency[] {
    return this.longTermMemory.frequentOperations
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * Get recently used operations.
   *
   * @param limit - Maximum number to return
   * @returns Sorted list by recency
   */
  getRecentOperations(limit: number = 10): OperationFrequency[] {
    return [...this.longTermMemory.frequentOperations]
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, limit);
  }

  // ===========================================================================
  // Long-Term Memory - Corrections
  // ===========================================================================

  /**
   * Record a user correction.
   *
   * @param original - Original agent output
   * @param corrected - User's correction
   * @param context - Optional context
   */
  recordCorrection(original: string, corrected: string, context?: string): void {
    this.longTermMemory.corrections.push({
      original,
      corrected,
      timestamp: Date.now(),
      context,
    });

    // Trim to max size, keeping most recent
    if (this.longTermMemory.corrections.length > this.config.maxCorrections) {
      this.longTermMemory.corrections = this.longTermMemory.corrections.slice(
        -this.config.maxCorrections
      );
    }

    this.longTermMemory.lastUpdatedAt = Date.now();

    logger.debug('Correction recorded', { original, corrected });
  }

  /**
   * Get corrections that might apply to given text.
   *
   * @param text - Text to check for applicable corrections
   * @returns Matching corrections
   */
  findRelevantCorrections(text: string): UserCorrection[] {
    const lowerText = text.toLowerCase();
    return this.longTermMemory.corrections.filter((c) =>
      lowerText.includes(c.original.toLowerCase())
    );
  }

  /**
   * Get all corrections.
   */
  getCorrections(): UserCorrection[] {
    return [...this.longTermMemory.corrections];
  }

  // ===========================================================================
  // Long-Term Memory - Preferences
  // ===========================================================================

  /**
   * Set a preference.
   *
   * @param key - Preference key
   * @param value - Preference value
   */
  setPreference(key: string, value: unknown): void {
    this.longTermMemory.preferences[key] = value;
    this.longTermMemory.lastUpdatedAt = Date.now();
  }

  /**
   * Get a preference.
   *
   * @param key - Preference key
   * @param defaultValue - Default value if not set
   * @returns The preference value
   */
  getPreference<T>(key: string, defaultValue?: T): T | undefined {
    return (this.longTermMemory.preferences[key] as T) ?? defaultValue;
  }

  /**
   * Get all preferences.
   */
  getAllPreferences(): Record<string, unknown> {
    return { ...this.longTermMemory.preferences };
  }

  // ===========================================================================
  // Long-Term Memory - Project Memory
  // ===========================================================================

  /**
   * Get or create project memory.
   *
   * @param projectId - Project ID
   * @returns Project memory
   */
  getProjectMemory(projectId: string): ProjectMemory {
    let memory = this.longTermMemory.projectMemory.get(projectId);

    if (!memory) {
      memory = {
        projectId,
        frequentAssets: [],
        commonSequences: [],
        notes: [],
        preferences: {},
      };
      this.longTermMemory.projectMemory.set(projectId, memory);
    }

    return memory;
  }

  /**
   * Record asset access for a project.
   *
   * @param projectId - Project ID
   * @param assetId - Accessed asset ID
   */
  recordAssetAccess(projectId: string, assetId: string): void {
    const memory = this.getProjectMemory(projectId);

    // Move to front if exists, otherwise add
    const index = memory.frequentAssets.indexOf(assetId);
    if (index > -1) {
      memory.frequentAssets.splice(index, 1);
    }
    memory.frequentAssets.unshift(assetId);

    // Keep top 20
    memory.frequentAssets = memory.frequentAssets.slice(0, 20);
    this.longTermMemory.lastUpdatedAt = Date.now();
  }

  /**
   * Add a note to project memory.
   *
   * @param projectId - Project ID
   * @param note - Note text
   */
  addProjectNote(projectId: string, note: string): void {
    const memory = this.getProjectMemory(projectId);
    memory.notes.push(note);
    this.longTermMemory.lastUpdatedAt = Date.now();
  }

  // ===========================================================================
  // Serialization
  // ===========================================================================

  /**
   * Export long-term memory for persistence.
   */
  exportLongTermMemory(): string {
    const data = {
      ...this.longTermMemory,
      projectMemory: Array.from(this.longTermMemory.projectMemory.entries()),
    };
    return JSON.stringify(data);
  }

  /**
   * Import long-term memory from persistence.
   *
   * @param data - Serialized memory data
   */
  importLongTermMemory(data: string): void {
    try {
      const parsed = JSON.parse(data);
      this.longTermMemory = {
        preferences: parsed.preferences ?? {},
        frequentOperations: parsed.frequentOperations ?? [],
        corrections: parsed.corrections ?? [],
        projectMemory: new Map(parsed.projectMemory ?? []),
        lastUpdatedAt: parsed.lastUpdatedAt ?? Date.now(),
      };
      logger.info('Long-term memory imported');
    } catch (error) {
      logger.error('Failed to import long-term memory', { error });
      throw new Error('Failed to import memory data');
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Clear all memory.
   */
  clearAll(): void {
    this.shortTermMemory.clear();
    this.longTermMemory = {
      preferences: {},
      frequentOperations: [],
      corrections: [],
      projectMemory: new Map(),
      lastUpdatedAt: Date.now(),
    };
    logger.debug('All memory cleared');
  }

  /**
   * Clear only short-term memory.
   */
  clearShortTerm(): void {
    this.shortTermMemory.clear();
    logger.debug('Short-term memory cleared');
  }

  /**
   * Clear only long-term memory.
   */
  clearLongTerm(): void {
    this.longTermMemory = {
      preferences: {},
      frequentOperations: [],
      corrections: [],
      projectMemory: new Map(),
      lastUpdatedAt: Date.now(),
    };
    logger.debug('Long-term memory cleared');
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new MemoryManager instance.
 */
export function createMemoryManager(config?: MemoryConfig): MemoryManager {
  return new MemoryManager(config);
}
