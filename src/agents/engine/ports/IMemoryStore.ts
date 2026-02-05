/**
 * IMemoryStore - Memory Storage Interface
 *
 * Defines the contract for storing and retrieving agent memory.
 * This enables learning from user patterns and preferences.
 */

import type {
  OperationRecord,
  CorrectionRecord,
  AgentContext,
} from '../core/types';

// =============================================================================
// Types
// =============================================================================

/**
 * Conversation memory entry
 */
export interface ConversationMemory {
  /** Conversation identifier */
  conversationId: string;
  /** Project identifier */
  projectId: string;
  /** Conversation messages */
  messages: ConversationMessage[];
  /** Context at conversation start */
  initialContext: AgentContext;
  /** When conversation started */
  startedAt: number;
  /** When last updated */
  lastUpdatedAt: number;
  /** Metadata */
  metadata: Record<string, unknown>;
}

/**
 * A message in conversation memory
 */
export interface ConversationMessage {
  /** Message role */
  role: 'user' | 'assistant' | 'system';
  /** Message content */
  content: string;
  /** Timestamp */
  timestamp: number;
  /** Associated tool calls */
  toolCalls?: Array<{
    tool: string;
    args: Record<string, unknown>;
    result?: unknown;
  }>;
}

/**
 * User preferences storage
 */
export interface UserPreferences {
  /** Preferred transition type */
  defaultTransitionType?: string;
  /** Preferred transition duration */
  defaultTransitionDuration?: number;
  /** Preferred volume level */
  defaultVolume?: number;
  /** Language preference */
  language?: string;
  /** Custom preferences */
  custom: Record<string, unknown>;
}

/**
 * Project-specific memory
 */
export interface ProjectMemory {
  /** Project identifier */
  projectId: string;
  /** Frequently used assets */
  frequentAssets: string[];
  /** Common operations in this project */
  commonOperations: string[];
  /** Notes */
  notes: string[];
  /** Last accessed */
  lastAccessed: number;
}

/**
 * Memory query options
 */
export interface MemoryQueryOptions {
  /** Maximum results */
  limit?: number;
  /** Minimum recency (timestamp) */
  since?: number;
  /** Project filter */
  projectId?: string;
}

// =============================================================================
// Interface
// =============================================================================

/**
 * Memory Store interface for persistent learning
 *
 * Implementations:
 * - MemoryManagerAdapter: Uses existing MemoryManager
 * - LocalStorageMemory: Browser localStorage
 * - MockMemoryStore: Testing
 */
export interface IMemoryStore {
  // ===========================================================================
  // Conversation Memory
  // ===========================================================================

  /**
   * Store a conversation
   *
   * @param conversation - Conversation to store
   */
  storeConversation(conversation: ConversationMemory): Promise<void>;

  /**
   * Retrieve a conversation
   *
   * @param conversationId - Conversation identifier
   * @returns Conversation or null
   */
  getConversation(conversationId: string): Promise<ConversationMemory | null>;

  /**
   * Get recent conversations
   *
   * @param options - Query options
   * @returns Array of conversations
   */
  getRecentConversations(
    options?: MemoryQueryOptions
  ): Promise<ConversationMemory[]>;

  /**
   * Delete a conversation
   *
   * @param conversationId - Conversation to delete
   */
  deleteConversation(conversationId: string): Promise<void>;

  // ===========================================================================
  // Operation Tracking
  // ===========================================================================

  /**
   * Record an operation usage
   *
   * @param operation - Operation name
   * @param projectId - Optional project context
   */
  recordOperation(operation: string, projectId?: string): Promise<void>;

  /**
   * Get frequently used operations
   *
   * @param limit - Maximum results
   * @returns Array of operation records
   */
  getFrequentOperations(limit?: number): Promise<OperationRecord[]>;

  /**
   * Get recent operations
   *
   * @param limit - Maximum results
   * @returns Array of operation records
   */
  getRecentOperations(limit?: number): Promise<OperationRecord[]>;

  // ===========================================================================
  // Corrections (Learning)
  // ===========================================================================

  /**
   * Record a user correction
   *
   * @param original - Original agent output
   * @param corrected - User's correction
   * @param context - Context when correction made
   */
  recordCorrection(
    original: string,
    corrected: string,
    context?: string
  ): Promise<void>;

  /**
   * Get recorded corrections
   *
   * @param limit - Maximum results
   * @returns Array of corrections
   */
  getCorrections(limit?: number): Promise<CorrectionRecord[]>;

  /**
   * Search corrections for relevant examples
   *
   * @param query - Search query
   * @param limit - Maximum results
   * @returns Matching corrections
   */
  searchCorrections(query: string, limit?: number): Promise<CorrectionRecord[]>;

  // ===========================================================================
  // User Preferences
  // ===========================================================================

  /**
   * Store user preferences
   *
   * @param preferences - Preferences to store
   */
  setPreferences(preferences: Partial<UserPreferences>): Promise<void>;

  /**
   * Get user preferences
   *
   * @returns Current preferences
   */
  getPreferences(): Promise<UserPreferences>;

  /**
   * Set a single preference
   *
   * @param key - Preference key
   * @param value - Preference value
   */
  setPreference(key: string, value: unknown): Promise<void>;

  /**
   * Get a single preference
   *
   * @param key - Preference key
   * @param defaultValue - Default if not set
   * @returns Preference value
   */
  getPreference<T>(key: string, defaultValue?: T): Promise<T | undefined>;

  // ===========================================================================
  // Project Memory
  // ===========================================================================

  /**
   * Get project-specific memory
   *
   * @param projectId - Project identifier
   * @returns Project memory
   */
  getProjectMemory(projectId: string): Promise<ProjectMemory | null>;

  /**
   * Update project memory
   *
   * @param projectId - Project identifier
   * @param updates - Updates to apply
   */
  updateProjectMemory(
    projectId: string,
    updates: Partial<ProjectMemory>
  ): Promise<void>;

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Clear all memory
   */
  clearAll(): Promise<void>;

  /**
   * Clear memory for a specific project
   *
   * @param projectId - Project identifier
   */
  clearProject(projectId: string): Promise<void>;

  /**
   * Clear old memory entries
   *
   * @param olderThan - Timestamp threshold
   */
  pruneOld(olderThan: number): Promise<void>;

  /**
   * Export all memory
   *
   * @returns Serializable memory export
   */
  export(): Promise<Record<string, unknown>>;

  /**
   * Import memory
   *
   * @param data - Data to import
   */
  import(data: Record<string, unknown>): Promise<void>;
}

// =============================================================================
// Default Preferences
// =============================================================================

/**
 * Default user preferences
 */
export const DEFAULT_PREFERENCES: UserPreferences = {
  custom: {},
};

/**
 * Create empty project memory
 */
export function createEmptyProjectMemory(projectId: string): ProjectMemory {
  return {
    projectId,
    frequentAssets: [],
    commonOperations: [],
    notes: [],
    lastAccessed: Date.now(),
  };
}
