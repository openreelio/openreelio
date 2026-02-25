/**
 * Compaction - Two-Tier Context Management for AI Agent Conversations
 *
 * Manages conversation context size through two complementary strategies:
 *
 * **Tier 1 (Prune):** Lightweight, zero-LLM-call removal of verbose tool
 * output data from old messages. Keeps message structure intact but replaces
 * bulky `data` payloads and removes thinking parts outside a protected
 * recency window.
 *
 * **Tier 2 (Compact):** AI-powered summarisation that condenses the full
 * conversation into a single system message preserving goal, instructions,
 * progress, timeline state and key decisions. Uses an LLM call to produce a
 * video-editing-aware summary.
 *
 * Both tiers are pure functions that never mutate their inputs.
 */

import type { ConversationMessage, TokenUsage, MessagePart, ToolResultPart } from './conversation';
import { createSystemMessage, toSimpleLLMMessage } from './conversation';
import type { ILLMClient } from '../ports/ILLMClient';

// =============================================================================
// Constants
// =============================================================================

/** Token budget that protects the most recent messages from pruning. */
export const PRUNE_PROTECT_TOKENS = 40_000;

/** Minimum estimated token count before pruning is considered worthwhile. */
export const PRUNE_MINIMUM_TOKENS = 20_000;

/** Fraction of context limit that triggers compaction (85%). */
export const COMPACT_THRESHOLD = 0.85;

/** Conservative characters-per-token ratio for estimation. */
export const CHARS_PER_TOKEN = 4;

// =============================================================================
// Result Types
// =============================================================================

/**
 * Result returned by {@link Compaction.prune}.
 */
export interface PruneResult {
  /** New message array with pruned tool outputs (input is NOT mutated). */
  messages: ConversationMessage[];
  /** Number of tool_result / thinking parts that were pruned. */
  prunedCount: number;
  /** Estimated tokens saved by the pruning operation. */
  estimatedTokensSaved: number;
}

/**
 * Result returned by {@link Compaction.compact}.
 */
export interface CompactResult {
  /** New message array containing a single system summary message. */
  messages: ConversationMessage[];
  /** The raw summary text produced by the LLM. */
  summary: string;
  /** Number of messages that were replaced by the summary. */
  originalMessageCount: number;
  /** Estimated tokens saved by the compaction operation. */
  estimatedTokensSaved: number;
}

// =============================================================================
// Summary Prompt
// =============================================================================

const SUMMARY_PROMPT = `You are summarizing a conversation between a user and an AI video editing assistant.
Create a concise summary that preserves all critical context for continuation.

Format your summary as:

## Goal
[What the user is trying to accomplish]

## Instructions
[Important user instructions or preferences mentioned]

## Accomplished
[What has been completed so far, bullet points]

## In Progress
[What was being worked on when interrupted]

## Timeline State
[Current playhead position, selected clips, track state if mentioned]

## Key Decisions
[Important decisions made during the conversation]`;

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Estimate the character count of a single message part.
 * Used internally to derive token estimates.
 */
function partCharCount(part: MessagePart): number {
  switch (part.type) {
    case 'text':
      return part.content.length;
    case 'thinking':
      return (
        part.thought.understanding.length +
        part.thought.requirements.join(' ').length +
        part.thought.uncertainties.join(' ').length +
        part.thought.approach.length +
        (part.thought.clarificationQuestion?.length ?? 0)
      );
    case 'plan':
      return (
        part.plan.goal.length +
        part.plan.steps.reduce(
          (acc, s) => acc + s.description.length + s.tool.length + JSON.stringify(s.args).length,
          0,
        ) +
        part.plan.rollbackStrategy.length
      );
    case 'tool_call':
      return part.tool.length + part.description.length + JSON.stringify(part.args).length;
    case 'tool_result': {
      const dataLen = part.data !== undefined ? JSON.stringify(part.data).length : 0;
      return part.tool.length + dataLen + (part.error?.length ?? 0);
    }
    case 'error':
      return part.code.length + part.message.length + part.phase.length;
    case 'approval':
      return (
        part.plan.goal.length +
        part.plan.steps.reduce((acc, s) => acc + s.description.length, 0) +
        (part.reason?.length ?? 0)
      );
    case 'tool_approval':
      return part.tool.length + part.description.length + JSON.stringify(part.args).length;
    default:
      return 0;
  }
}

/**
 * Estimate the character count of a single conversation message.
 */
function messageCharCount(msg: ConversationMessage): number {
  return msg.parts.reduce((sum, part) => sum + partCharCount(part), 0);
}

/**
 * Deep-clone a message without mutating the original.
 * Uses structured clone where available, falls back to JSON round-trip.
 */
function cloneMessage(msg: ConversationMessage): ConversationMessage {
  if (typeof structuredClone === 'function') {
    return structuredClone(msg);
  }
  return JSON.parse(JSON.stringify(msg)) as ConversationMessage;
}

// =============================================================================
// Compaction Namespace
// =============================================================================

/**
 * Two-tier context management for AI agent conversations.
 *
 * Provides lightweight pruning (Tier 1) and AI-powered summarisation (Tier 2)
 * to keep conversation context within LLM token limits while preserving the
 * information needed for coherent continuation.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Compaction {
  // ---------------------------------------------------------------------------
  // Token Estimation
  // ---------------------------------------------------------------------------

  /**
   * Estimate the token count for an array of conversation messages.
   *
   * Uses a conservative `CHARS_PER_TOKEN` (4) ratio. This is intentionally an
   * over-estimate so that threshold checks err on the side of triggering
   * compaction rather than exceeding context limits.
   *
   * @param messages - The messages to estimate tokens for.
   * @returns Estimated token count.
   */
  export function estimateTokens(messages: ConversationMessage[]): number {
    if (messages.length === 0) return 0;
    const totalChars = messages.reduce((sum, msg) => sum + messageCharCount(msg), 0);
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }

  // ---------------------------------------------------------------------------
  // Tier 1: Prune
  // ---------------------------------------------------------------------------

  /**
   * Tier 1 context reduction: prune verbose tool outputs from old messages.
   *
   * Behaviour:
   * 1. Walks messages from newest to oldest, accumulating estimated tokens.
   *    Messages within `PRUNE_PROTECT_TOKENS` are left untouched.
   * 2. For older messages, `tool_result` parts have their `data` field replaced
   *    with the string `"[pruned]"`.
   * 3. `thinking` parts are removed entirely from older messages (reasoning is
   *    less useful for ongoing context than actions/results).
   * 4. Returns a **new** array; the input is never mutated.
   *
   * @param messages - The conversation messages to prune.
   * @returns A {@link PruneResult} with the pruned messages and statistics.
   */
  export function prune(messages: ConversationMessage[]): PruneResult {
    if (messages.length === 0) {
      return { messages: [], prunedCount: 0, estimatedTokensSaved: 0 };
    }

    // Walk from the end to find the protection boundary.
    let protectedTokens = 0;
    let protectBoundary = messages.length; // index of the first protected message

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = Math.ceil(messageCharCount(messages[i]) / CHARS_PER_TOKEN);
      if (protectedTokens + msgTokens > PRUNE_PROTECT_TOKENS) {
        protectBoundary = i + 1;
        break;
      }
      protectedTokens += msgTokens;
      if (i === 0) {
        protectBoundary = 0;
      }
    }

    let prunedCount = 0;
    let charsSaved = 0;

    const result: ConversationMessage[] = messages.map((msg, index) => {
      // Protected messages are cloned but not modified.
      if (index >= protectBoundary) {
        return cloneMessage(msg);
      }

      // Older messages: prune tool_result data and remove thinking parts.
      const clone = cloneMessage(msg);
      const newParts: MessagePart[] = [];

      for (const part of clone.parts) {
        if (part.type === 'thinking') {
          // Remove thinking parts from old messages entirely.
          charsSaved += partCharCount(part);
          prunedCount++;
          continue;
        }

        if (part.type === 'tool_result') {
          const resultPart = part as ToolResultPart;
          if (resultPart.data !== undefined && resultPart.data !== '[pruned]') {
            const originalLen = JSON.stringify(resultPart.data).length;
            const prunedLen = '[pruned]'.length;
            charsSaved += Math.max(0, originalLen - prunedLen);
            resultPart.data = '[pruned]';
            prunedCount++;
          }
        }

        newParts.push(part);
      }

      clone.parts = newParts;
      return clone;
    });

    return {
      messages: result,
      prunedCount,
      estimatedTokensSaved: Math.ceil(charsSaved / CHARS_PER_TOKEN),
    };
  }

  // ---------------------------------------------------------------------------
  // Tier 2: Compact
  // ---------------------------------------------------------------------------

  /**
   * Tier 2 context reduction: AI-powered conversation summarisation.
   *
   * Converts the entire conversation into a text transcript, asks the LLM to
   * produce a structured summary (goal, instructions, progress, timeline state,
   * key decisions), and returns a single system message containing the summary.
   *
   * @param messages - The conversation messages to summarise.
   * @param llmClient - An {@link ILLMClient} used to generate the summary.
   * @param contextLimit - The total context token limit for the target model.
   * @returns A {@link CompactResult} with the summary message and statistics.
   */
  export async function compact(
    messages: ConversationMessage[],
    llmClient: ILLMClient,
    contextLimit: number,
  ): Promise<CompactResult> {
    if (messages.length === 0) {
      return {
        messages: [],
        summary: '',
        originalMessageCount: 0,
        estimatedTokensSaved: 0,
      };
    }

    const originalTokens = estimateTokens(messages);

    // Build a text transcript for the LLM to summarise.
    const transcript = messages
      .map((msg) => {
        const llmMsg = toSimpleLLMMessage(msg);
        return `[${llmMsg.role.toUpperCase()}]\n${llmMsg.content}`;
      })
      .join('\n\n---\n\n');

    // Call the LLM to produce the summary.
    const result = await llmClient.complete([
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: `Here is the conversation to summarize:\n\n${transcript}` },
    ], {
      temperature: 0.3,
      maxTokens: Math.min(2048, Math.floor(contextLimit * 0.1)),
    });

    const summary = result.content;
    const summaryMessage = createSystemMessage(
      `[Conversation Summary]\n\n${summary}`,
    );

    const summaryTokens = estimateTokens([summaryMessage]);

    return {
      messages: [summaryMessage],
      summary,
      originalMessageCount: messages.length,
      estimatedTokensSaved: Math.max(0, originalTokens - summaryTokens),
    };
  }

  // ---------------------------------------------------------------------------
  // Threshold Checks
  // ---------------------------------------------------------------------------

  /**
   * Check whether compaction (Tier 2) should be triggered.
   *
   * Returns `true` when the total token usage reported by the provider
   * exceeds {@link COMPACT_THRESHOLD} (85%) of the model's context limit.
   *
   * @param usage - The most recent token usage report.
   * @param contextLimit - The total context token limit.
   * @returns `true` if compaction should be performed.
   */
  export function shouldCompact(usage: TokenUsage, contextLimit: number): boolean {
    if (contextLimit <= 0) return false;
    return usage.totalTokens >= contextLimit * COMPACT_THRESHOLD;
  }

  /**
   * Check whether pruning (Tier 1) should be triggered.
   *
   * Returns `true` when the estimated token count of the messages exceeds
   * {@link PRUNE_MINIMUM_TOKENS}.
   *
   * @param messages - The conversation messages to evaluate.
   * @returns `true` if pruning should be performed.
   */
  export function shouldPrune(messages: ConversationMessage[]): boolean {
    if (messages.length === 0) return false;
    return estimateTokens(messages) >= PRUNE_MINIMUM_TOKENS;
  }
}
