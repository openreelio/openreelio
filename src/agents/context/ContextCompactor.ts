/**
 * Context Compactor
 *
 * Manages conversation history size by summarizing older messages.
 * Prevents unbounded context growth while preserving important information.
 */

import type { AgentMessage } from '../Agent';
import { createLogger } from '@/services/logger';

const logger = createLogger('ContextCompactor');

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for context compaction.
 */
export interface CompactionConfig {
  /** Maximum messages before triggering compaction */
  maxMessages: number;
  /** Number of oldest messages to summarize when compacting */
  summarizeCount: number;
  /** Number of recent messages to always preserve verbatim */
  preserveRecent: number;
  /** Optional custom summarizer function */
  summarizer?: MessageSummarizer;
}

/**
 * Function to summarize a set of messages.
 */
export type MessageSummarizer = (
  messages: AgentMessage[]
) => Promise<string> | string;

/**
 * Result of a compaction operation.
 */
export interface CompactionResult {
  /** Whether compaction was performed */
  compacted: boolean;
  /** Original message count */
  originalCount: number;
  /** New message count */
  newCount: number;
  /** Number of messages summarized */
  summarizedCount: number;
  /** The summary that was created (if compacted) */
  summary?: string;
}

/**
 * A summary entry in conversation history.
 */
export interface ConversationSummary {
  /** When the summary was created */
  createdAt: number;
  /** The summary text */
  content: string;
  /** How many messages were summarized */
  messageCount: number;
  /** Time range covered by the summary */
  timeRange?: { start: number; end: number };
}

// =============================================================================
// Default Summarizer
// =============================================================================

/**
 * Default message summarizer that creates a simple bullet-point summary.
 * For production use, replace with an AI-powered summarizer.
 */
export function defaultSummarizer(messages: AgentMessage[]): string {
  const userMessages = messages.filter((m) => m.role === 'user');
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  const toolMessages = messages.filter((m) => m.role === 'tool');

  const lines: string[] = ['[Conversation Summary]'];

  if (userMessages.length > 0) {
    lines.push(`User requests (${userMessages.length}):`);
    for (const msg of userMessages.slice(0, 3)) {
      const preview = msg.content.slice(0, 100) + (msg.content.length > 100 ? '...' : '');
      lines.push(`  - ${preview}`);
    }
    if (userMessages.length > 3) {
      lines.push(`  - ... and ${userMessages.length - 3} more`);
    }
  }

  if (assistantMessages.length > 0) {
    lines.push(`\nAssistant responses (${assistantMessages.length}):`);
    for (const msg of assistantMessages.slice(0, 3)) {
      const preview = msg.content.slice(0, 100) + (msg.content.length > 100 ? '...' : '');
      lines.push(`  - ${preview}`);
    }
    if (assistantMessages.length > 3) {
      lines.push(`  - ... and ${assistantMessages.length - 3} more`);
    }
  }

  if (toolMessages.length > 0) {
    lines.push(`\nTool calls executed: ${toolMessages.length}`);
  }

  return lines.join('\n');
}

// =============================================================================
// Context Compactor
// =============================================================================

/**
 * Manages conversation history compaction.
 *
 * Features:
 * - Configurable compaction thresholds
 * - Preserves recent messages verbatim
 * - Summarizes older messages
 * - Tracks compaction history
 *
 * @example
 * ```typescript
 * const compactor = new ContextCompactor({
 *   maxMessages: 50,
 *   summarizeCount: 30,
 *   preserveRecent: 10,
 * });
 *
 * // Check if compaction needed
 * if (compactor.shouldCompact(messages)) {
 *   const result = await compactor.compact(messages);
 *   messages = result.messages;
 * }
 * ```
 */
export class ContextCompactor {
  private config: Required<CompactionConfig>;
  private compactionHistory: ConversationSummary[] = [];

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = {
      maxMessages: config.maxMessages ?? 50,
      summarizeCount: config.summarizeCount ?? 30,
      preserveRecent: config.preserveRecent ?? 10,
      summarizer: config.summarizer ?? defaultSummarizer,
    };

    // Validate configuration
    if (this.config.preserveRecent >= this.config.maxMessages) {
      throw new Error('preserveRecent must be less than maxMessages');
    }

    if (this.config.summarizeCount > this.config.maxMessages - this.config.preserveRecent) {
      throw new Error('summarizeCount too large for configured maxMessages and preserveRecent');
    }
  }

  // ===========================================================================
  // Compaction Operations
  // ===========================================================================

  /**
   * Check if messages need compaction.
   *
   * @param messages - Current message history
   * @returns Whether compaction should be performed
   */
  shouldCompact(messages: AgentMessage[]): boolean {
    return messages.length > this.config.maxMessages;
  }

  /**
   * Compact messages by summarizing older ones.
   *
   * @param messages - Current message history
   * @returns Compacted messages and operation result
   */
  async compact(
    messages: AgentMessage[]
  ): Promise<{ messages: AgentMessage[]; result: CompactionResult }> {
    const originalCount = messages.length;

    if (!this.shouldCompact(messages)) {
      return {
        messages,
        result: {
          compacted: false,
          originalCount,
          newCount: originalCount,
          summarizedCount: 0,
        },
      };
    }

    // Determine which messages to summarize
    const summarizeEndIndex = messages.length - this.config.preserveRecent;
    const summarizeStartIndex = Math.max(0, summarizeEndIndex - this.config.summarizeCount);

    const messagesToSummarize = messages.slice(summarizeStartIndex, summarizeEndIndex);
    const messagesBeforeSummary = messages.slice(0, summarizeStartIndex);
    const recentMessages = messages.slice(summarizeEndIndex);

    // Generate summary
    const summaryText = await this.config.summarizer(messagesToSummarize);

    // Create summary message
    const summaryMessage: AgentMessage = {
      role: 'system',
      content: summaryText,
    };

    // Track summary
    const summary: ConversationSummary = {
      createdAt: Date.now(),
      content: summaryText,
      messageCount: messagesToSummarize.length,
    };
    this.compactionHistory.push(summary);

    // Combine: messages before summary + summary + recent messages
    const compactedMessages = [
      ...messagesBeforeSummary,
      summaryMessage,
      ...recentMessages,
    ];

    logger.info('Context compacted', {
      originalCount,
      newCount: compactedMessages.length,
      summarizedCount: messagesToSummarize.length,
    });

    return {
      messages: compactedMessages,
      result: {
        compacted: true,
        originalCount,
        newCount: compactedMessages.length,
        summarizedCount: messagesToSummarize.length,
        summary: summaryText,
      },
    };
  }

  /**
   * Force compact to a specific size.
   *
   * @param messages - Current messages
   * @param targetSize - Target message count
   * @returns Compacted messages
   */
  async compactTo(
    messages: AgentMessage[],
    targetSize: number
  ): Promise<{ messages: AgentMessage[]; result: CompactionResult }> {
    if (messages.length <= targetSize) {
      return {
        messages,
        result: {
          compacted: false,
          originalCount: messages.length,
          newCount: messages.length,
          summarizedCount: 0,
        },
      };
    }

    const originalCount = messages.length;

    // Preserve most recent messages up to target size - 1 (for summary)
    const preserveCount = Math.min(targetSize - 1, this.config.preserveRecent);
    const summarizeCount = messages.length - preserveCount;

    const messagesToSummarize = messages.slice(0, summarizeCount);
    const recentMessages = messages.slice(summarizeCount);

    const summaryText = await this.config.summarizer(messagesToSummarize);

    const summaryMessage: AgentMessage = {
      role: 'system',
      content: summaryText,
    };

    this.compactionHistory.push({
      createdAt: Date.now(),
      content: summaryText,
      messageCount: summarizeCount,
    });

    const compactedMessages = [summaryMessage, ...recentMessages];

    return {
      messages: compactedMessages,
      result: {
        compacted: true,
        originalCount,
        newCount: compactedMessages.length,
        summarizedCount: summarizeCount,
        summary: summaryText,
      },
    };
  }

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  /**
   * Get the compaction configuration.
   */
  getConfig(): Required<CompactionConfig> {
    return { ...this.config };
  }

  /**
   * Get compaction history.
   */
  getCompactionHistory(): ConversationSummary[] {
    return [...this.compactionHistory];
  }

  /**
   * Get total messages summarized across all compactions.
   */
  getTotalSummarized(): number {
    return this.compactionHistory.reduce((sum, s) => sum + s.messageCount, 0);
  }

  /**
   * Clear compaction history.
   */
  clearHistory(): void {
    this.compactionHistory = [];
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Estimate token count for messages (rough approximation).
   * Assumes ~4 characters per token on average.
   *
   * @param messages - Messages to estimate
   * @returns Estimated token count
   */
  estimateTokens(messages: AgentMessage[]): number {
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(totalChars / 4);
  }

  /**
   * Get statistics about message history.
   *
   * @param messages - Current messages
   * @returns Statistics object
   */
  getStats(messages: AgentMessage[]): {
    totalMessages: number;
    byRole: Record<string, number>;
    estimatedTokens: number;
    needsCompaction: boolean;
    compactionHistory: number;
  } {
    const byRole: Record<string, number> = {};
    for (const msg of messages) {
      byRole[msg.role] = (byRole[msg.role] ?? 0) + 1;
    }

    return {
      totalMessages: messages.length,
      byRole,
      estimatedTokens: this.estimateTokens(messages),
      needsCompaction: this.shouldCompact(messages),
      compactionHistory: this.compactionHistory.length,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new ContextCompactor instance.
 */
export function createContextCompactor(
  config?: Partial<CompactionConfig>
): ContextCompactor {
  return new ContextCompactor(config);
}
