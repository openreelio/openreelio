/**
 * Agent Hooks
 *
 * Defines hook types and management utilities for intercepting agent operations.
 * Hooks enable validation, modification, and side effects during agent execution.
 */

import type { AgentToolResult } from '../Agent';

// =============================================================================
// Types
// =============================================================================

/**
 * Result from a pre-tool-use hook.
 * Determines whether tool execution should proceed and with what arguments.
 */
export interface PreToolUseHookResult {
  /** Whether tool execution should proceed */
  shouldProceed: boolean;
  /** Modified arguments to pass to the tool (optional) */
  modifiedArgs?: Record<string, unknown>;
  /** Reason for blocking execution (if shouldProceed is false) */
  reason?: string;
}

/**
 * Result from a post-tool-use hook.
 * Can modify the result before it's returned.
 */
export interface PostToolUseHookResult {
  /** Modified result to return (optional) */
  modifiedResult?: AgentToolResult;
}

/**
 * Result from a pre-message hook.
 * Can modify or filter user input before processing.
 */
export interface PreMessageHookResult {
  /** Whether message processing should proceed */
  shouldProceed: boolean;
  /** Modified message content (optional) */
  modifiedContent?: string;
  /** Reason for blocking (if shouldProceed is false) */
  reason?: string;
}

/**
 * Result from a post-message hook.
 * Can modify the assistant response before it's returned.
 */
export interface PostMessageHookResult {
  /** Modified response content (optional) */
  modifiedContent?: string;
}

/**
 * Context passed to pre-tool-use hooks.
 */
export interface PreToolUseContext {
  /** Name of the tool being called */
  toolName: string;
  /** Arguments being passed to the tool */
  args: Record<string, unknown>;
  /** Unique ID for this tool call */
  callId: string;
}

/**
 * Context passed to post-tool-use hooks.
 */
export interface PostToolUseContext {
  /** Name of the tool that was called */
  toolName: string;
  /** Arguments that were passed to the tool */
  args: Record<string, unknown>;
  /** Result from tool execution */
  result: AgentToolResult;
  /** Unique ID for this tool call */
  callId: string;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Context passed to pre-message hooks.
 */
export interface PreMessageContext {
  /** The user's message content */
  content: string;
  /** Conversation turn number */
  turnNumber: number;
}

/**
 * Context passed to post-message hooks.
 */
export interface PostMessageContext {
  /** The user's original message */
  userContent: string;
  /** The assistant's response content */
  assistantContent: string;
  /** Conversation turn number */
  turnNumber: number;
}

/**
 * Pre-tool-use hook function type.
 * Called before each tool execution.
 */
export type PreToolUseHook = (
  context: PreToolUseContext
) => PreToolUseHookResult | Promise<PreToolUseHookResult>;

/**
 * Post-tool-use hook function type.
 * Called after each tool execution.
 */
export type PostToolUseHook = (
  context: PostToolUseContext
) => PostToolUseHookResult | Promise<PostToolUseHookResult>;

/**
 * Pre-message hook function type.
 * Called before processing user messages.
 */
export type PreMessageHook = (
  context: PreMessageContext
) => PreMessageHookResult | Promise<PreMessageHookResult>;

/**
 * Post-message hook function type.
 * Called after generating assistant responses.
 */
export type PostMessageHook = (
  context: PostMessageContext
) => PostMessageHookResult | Promise<PostMessageHookResult>;

/**
 * Function to unsubscribe a hook.
 */
export type UnsubscribeHook = () => void;

/**
 * Hook priority levels for ordering.
 */
export type HookPriority = 'high' | 'normal' | 'low';

/**
 * Registration options for hooks.
 */
export interface HookRegistrationOptions {
  /** Priority determines execution order (high runs first) */
  priority?: HookPriority;
  /** Optional name for debugging */
  name?: string;
}

// =============================================================================
// Internal Types
// =============================================================================

interface RegisteredHook<T> {
  id: string;
  hook: T;
  priority: HookPriority;
  name?: string;
}

// =============================================================================
// Hook Manager
// =============================================================================

/**
 * Manages registration and execution of agent hooks.
 *
 * Features:
 * - Type-safe hook registration
 * - Priority-based execution ordering
 * - Cleanup via unsubscribe functions
 * - Error isolation (one failing hook doesn't affect others)
 *
 * @example
 * ```typescript
 * const manager = new HookManager();
 *
 * // Register a pre-tool-use hook
 * const unsubscribe = manager.onPreToolUse(
 *   (ctx) => ({ shouldProceed: true }),
 *   { name: 'validation-hook' }
 * );
 *
 * // Later, remove the hook
 * unsubscribe();
 * ```
 */
export class HookManager {
  private preToolUseHooks: RegisteredHook<PreToolUseHook>[] = [];
  private postToolUseHooks: RegisteredHook<PostToolUseHook>[] = [];
  private preMessageHooks: RegisteredHook<PreMessageHook>[] = [];
  private postMessageHooks: RegisteredHook<PostMessageHook>[] = [];

  private idCounter = 0;

  // ===========================================================================
  // Registration Methods
  // ===========================================================================

  /**
   * Register a pre-tool-use hook.
   *
   * @param hook - The hook function
   * @param options - Registration options
   * @returns Unsubscribe function
   */
  onPreToolUse(
    hook: PreToolUseHook,
    options: HookRegistrationOptions = {}
  ): UnsubscribeHook {
    return this.registerHook(this.preToolUseHooks, hook, options);
  }

  /**
   * Register a post-tool-use hook.
   *
   * @param hook - The hook function
   * @param options - Registration options
   * @returns Unsubscribe function
   */
  onPostToolUse(
    hook: PostToolUseHook,
    options: HookRegistrationOptions = {}
  ): UnsubscribeHook {
    return this.registerHook(this.postToolUseHooks, hook, options);
  }

  /**
   * Register a pre-message hook.
   *
   * @param hook - The hook function
   * @param options - Registration options
   * @returns Unsubscribe function
   */
  onPreMessage(
    hook: PreMessageHook,
    options: HookRegistrationOptions = {}
  ): UnsubscribeHook {
    return this.registerHook(this.preMessageHooks, hook, options);
  }

  /**
   * Register a post-message hook.
   *
   * @param hook - The hook function
   * @param options - Registration options
   * @returns Unsubscribe function
   */
  onPostMessage(
    hook: PostMessageHook,
    options: HookRegistrationOptions = {}
  ): UnsubscribeHook {
    return this.registerHook(this.postMessageHooks, hook, options);
  }

  // ===========================================================================
  // Execution Methods
  // ===========================================================================

  /**
   * Execute all pre-tool-use hooks.
   *
   * @param context - The hook context
   * @returns Combined result from all hooks
   */
  async executePreToolUseHooks(
    context: PreToolUseContext
  ): Promise<PreToolUseHookResult> {
    let currentArgs = { ...context.args };

    for (const registered of this.getSortedHooks(this.preToolUseHooks)) {
      try {
        const result = await registered.hook({
          ...context,
          args: currentArgs,
        });

        if (!result.shouldProceed) {
          return {
            shouldProceed: false,
            reason: result.reason ?? `Blocked by hook: ${registered.name ?? registered.id}`,
          };
        }

        if (result.modifiedArgs) {
          currentArgs = { ...currentArgs, ...result.modifiedArgs };
        }
      } catch (error) {
        console.error(
          `Error in pre-tool-use hook "${registered.name ?? registered.id}":`,
          error
        );
        // Continue to next hook on error
      }
    }

    return {
      shouldProceed: true,
      modifiedArgs: currentArgs,
    };
  }

  /**
   * Execute all post-tool-use hooks.
   *
   * @param context - The hook context
   * @returns Combined result from all hooks
   */
  async executePostToolUseHooks(
    context: PostToolUseContext
  ): Promise<PostToolUseHookResult> {
    let currentResult = context.result;

    for (const registered of this.getSortedHooks(this.postToolUseHooks)) {
      try {
        const hookResult = await registered.hook({
          ...context,
          result: currentResult,
        });

        if (hookResult.modifiedResult) {
          currentResult = hookResult.modifiedResult;
        }
      } catch (error) {
        console.error(
          `Error in post-tool-use hook "${registered.name ?? registered.id}":`,
          error
        );
        // Continue to next hook on error
      }
    }

    return { modifiedResult: currentResult };
  }

  /**
   * Execute all pre-message hooks.
   *
   * @param context - The hook context
   * @returns Combined result from all hooks
   */
  async executePreMessageHooks(
    context: PreMessageContext
  ): Promise<PreMessageHookResult> {
    let currentContent = context.content;

    for (const registered of this.getSortedHooks(this.preMessageHooks)) {
      try {
        const result = await registered.hook({
          ...context,
          content: currentContent,
        });

        if (!result.shouldProceed) {
          return {
            shouldProceed: false,
            reason: result.reason ?? `Blocked by hook: ${registered.name ?? registered.id}`,
          };
        }

        if (result.modifiedContent !== undefined) {
          currentContent = result.modifiedContent;
        }
      } catch (error) {
        console.error(
          `Error in pre-message hook "${registered.name ?? registered.id}":`,
          error
        );
        // Continue to next hook on error
      }
    }

    return {
      shouldProceed: true,
      modifiedContent: currentContent,
    };
  }

  /**
   * Execute all post-message hooks.
   *
   * @param context - The hook context
   * @returns Combined result from all hooks
   */
  async executePostMessageHooks(
    context: PostMessageContext
  ): Promise<PostMessageHookResult> {
    let currentContent = context.assistantContent;

    for (const registered of this.getSortedHooks(this.postMessageHooks)) {
      try {
        const result = await registered.hook({
          ...context,
          assistantContent: currentContent,
        });

        if (result.modifiedContent !== undefined) {
          currentContent = result.modifiedContent;
        }
      } catch (error) {
        console.error(
          `Error in post-message hook "${registered.name ?? registered.id}":`,
          error
        );
        // Continue to next hook on error
      }
    }

    return { modifiedContent: currentContent };
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Get count of registered hooks by type.
   */
  getHookCounts(): {
    preToolUse: number;
    postToolUse: number;
    preMessage: number;
    postMessage: number;
  } {
    return {
      preToolUse: this.preToolUseHooks.length,
      postToolUse: this.postToolUseHooks.length,
      preMessage: this.preMessageHooks.length,
      postMessage: this.postMessageHooks.length,
    };
  }

  /**
   * Clear all registered hooks.
   */
  clearAll(): void {
    this.preToolUseHooks = [];
    this.postToolUseHooks = [];
    this.preMessageHooks = [];
    this.postMessageHooks = [];
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private registerHook<T>(
    hooks: RegisteredHook<T>[],
    hook: T,
    options: HookRegistrationOptions
  ): UnsubscribeHook {
    const id = `hook_${++this.idCounter}`;
    const registered: RegisteredHook<T> = {
      id,
      hook,
      priority: options.priority ?? 'normal',
      name: options.name,
    };

    hooks.push(registered);

    return () => {
      const index = hooks.findIndex((h) => h.id === id);
      if (index !== -1) {
        hooks.splice(index, 1);
      }
    };
  }

  private getSortedHooks<T>(hooks: RegisteredHook<T>[]): RegisteredHook<T>[] {
    const priorityOrder: Record<HookPriority, number> = {
      high: 0,
      normal: 1,
      low: 2,
    };

    return [...hooks].sort((a, b) => {
      const aPriority = priorityOrder[a.priority];
      const bPriority = priorityOrder[b.priority];
      return aPriority - bPriority;
    });
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new HookManager instance.
 */
export function createHookManager(): HookManager {
  return new HookManager();
}
