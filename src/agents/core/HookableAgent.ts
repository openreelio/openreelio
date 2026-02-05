/**
 * Hookable Agent
 *
 * Extends the base Agent class with hook system support.
 * Allows interception of tool calls and message processing.
 */

import {
  Agent,
  AgentConfig,
  AgentContext,
  AgentMessage,
  AgentResponse,
  AgentTool,
  AgentToolResult,
} from '../Agent';
import {
  HookManager,
  createHookManager,
  type PreToolUseHook,
  type PostToolUseHook,
  type PreMessageHook,
  type PostMessageHook,
  type HookRegistrationOptions,
  type UnsubscribeHook,
} from './AgentHooks';
import { createLogger } from '@/services/logger';

const logger = createLogger('HookableAgent');

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for HookableAgent.
 * Extends AgentConfig with optional hook manager.
 */
export interface HookableAgentConfig extends AgentConfig {
  /** Optional pre-configured hook manager */
  hookManager?: HookManager;
}

/**
 * Result from hook execution during tool calls.
 */
export interface HookExecutionResult {
  /** Whether the tool was executed */
  executed: boolean;
  /** The tool result (if executed) */
  result?: AgentToolResult;
  /** Reason for not executing (if blocked) */
  blockedReason?: string;
}

// =============================================================================
// Hookable Agent
// =============================================================================

/**
 * Abstract agent class with hook system support.
 *
 * Provides hook integration for:
 * - Pre/post tool execution
 * - Pre/post message processing
 *
 * Subclasses must implement:
 * - processMessageImpl(): Core message processing logic
 * - executeToolCallImpl(): Core tool execution logic
 *
 * @example
 * ```typescript
 * class MyAgent extends HookableAgent {
 *   protected async processMessageImpl(message, context) {
 *     // Implementation
 *   }
 *
 *   protected async executeToolCallImpl(tool, args) {
 *     // Implementation
 *   }
 * }
 *
 * const agent = new MyAgent(config);
 * agent.onPreToolUse((ctx) => {
 *   console.log('About to call:', ctx.toolName);
 *   return { shouldProceed: true };
 * });
 * ```
 */
export abstract class HookableAgent extends Agent {
  /** Hook manager for this agent */
  protected readonly hookManager: HookManager;

  /** Current conversation turn number */
  private turnNumber = 0;

  constructor(config: HookableAgentConfig) {
    super(config);
    this.hookManager = config.hookManager ?? createHookManager();
  }

  // ===========================================================================
  // Hook Registration (Public API)
  // ===========================================================================

  /**
   * Register a pre-tool-use hook.
   *
   * @param hook - Hook function called before tool execution
   * @param options - Registration options
   * @returns Unsubscribe function
   */
  onPreToolUse(
    hook: PreToolUseHook,
    options?: HookRegistrationOptions
  ): UnsubscribeHook {
    return this.hookManager.onPreToolUse(hook, options);
  }

  /**
   * Register a post-tool-use hook.
   *
   * @param hook - Hook function called after tool execution
   * @param options - Registration options
   * @returns Unsubscribe function
   */
  onPostToolUse(
    hook: PostToolUseHook,
    options?: HookRegistrationOptions
  ): UnsubscribeHook {
    return this.hookManager.onPostToolUse(hook, options);
  }

  /**
   * Register a pre-message hook.
   *
   * @param hook - Hook function called before message processing
   * @param options - Registration options
   * @returns Unsubscribe function
   */
  onPreMessage(
    hook: PreMessageHook,
    options?: HookRegistrationOptions
  ): UnsubscribeHook {
    return this.hookManager.onPreMessage(hook, options);
  }

  /**
   * Register a post-message hook.
   *
   * @param hook - Hook function called after message processing
   * @param options - Registration options
   * @returns Unsubscribe function
   */
  onPostMessage(
    hook: PostMessageHook,
    options?: HookRegistrationOptions
  ): UnsubscribeHook {
    return this.hookManager.onPostMessage(hook, options);
  }

  /**
   * Get the hook manager for advanced configuration.
   */
  getHookManager(): HookManager {
    return this.hookManager;
  }

  // ===========================================================================
  // Agent Implementation (Final - delegates to hooks + impl)
  // ===========================================================================

  /**
   * Process a message with hook integration.
   * Executes preMessage hooks -> processMessageImpl -> postMessage hooks.
   */
  protected async processMessage(
    message: AgentMessage,
    context: AgentContext
  ): Promise<AgentResponse> {
    this.turnNumber++;

    // Only apply message hooks to user messages
    if (message.role === 'user') {
      // Execute pre-message hooks
      const preResult = await this.hookManager.executePreMessageHooks({
        content: message.content,
        turnNumber: this.turnNumber,
      });

      if (!preResult.shouldProceed) {
        logger.debug('Message blocked by pre-message hook', {
          reason: preResult.reason,
        });
        return {
          message: {
            role: 'assistant',
            content: preResult.reason ?? 'Message blocked by policy.',
          },
          toolCalls: [],
          shouldContinue: false,
        };
      }

      // Apply content modifications
      const processedMessage: AgentMessage = {
        ...message,
        content: preResult.modifiedContent ?? message.content,
      };

      // Process the message
      const response = await this.processMessageImpl(processedMessage, context);

      // Execute post-message hooks
      const postResult = await this.hookManager.executePostMessageHooks({
        userContent: processedMessage.content,
        assistantContent: response.message.content,
        turnNumber: this.turnNumber,
      });

      // Apply response modifications
      if (postResult.modifiedContent !== undefined) {
        return {
          ...response,
          message: {
            ...response.message,
            content: postResult.modifiedContent,
          },
        };
      }

      return response;
    }

    // Non-user messages bypass message hooks
    return this.processMessageImpl(message, context);
  }

  /**
   * Execute a tool call with hook integration.
   * Executes preToolUse hooks -> executeToolCallImpl -> postToolUse hooks.
   */
  protected async executeToolCall(
    tool: AgentTool,
    args: Record<string, unknown>
  ): Promise<AgentToolResult> {
    const callId = crypto.randomUUID();
    const startTime = performance.now();

    // Execute pre-tool-use hooks
    const preResult = await this.hookManager.executePreToolUseHooks({
      toolName: tool.name,
      args,
      callId,
    });

    if (!preResult.shouldProceed) {
      logger.debug('Tool call blocked by pre-tool-use hook', {
        toolName: tool.name,
        reason: preResult.reason,
      });
      return {
        success: false,
        error: preResult.reason ?? 'Tool call blocked by policy.',
      };
    }

    // Use modified arguments if provided
    const finalArgs = preResult.modifiedArgs ?? args;

    // Execute the tool
    let result: AgentToolResult;
    try {
      result = await this.executeToolCallImpl(tool, finalArgs);
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const durationMs = performance.now() - startTime;

    // Execute post-tool-use hooks
    const postResult = await this.hookManager.executePostToolUseHooks({
      toolName: tool.name,
      args: finalArgs,
      result,
      callId,
      durationMs,
    });

    // Return modified result if provided
    return postResult.modifiedResult ?? result;
  }

  // ===========================================================================
  // Abstract Methods (To be implemented by subclasses)
  // ===========================================================================

  /**
   * Core message processing logic.
   * Implement this instead of processMessage.
   */
  protected abstract processMessageImpl(
    message: AgentMessage,
    context: AgentContext
  ): Promise<AgentResponse>;

  /**
   * Core tool execution logic.
   * Implement this instead of executeToolCall.
   */
  protected abstract executeToolCallImpl(
    tool: AgentTool,
    args: Record<string, unknown>
  ): Promise<AgentToolResult>;

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Reset the agent state including turn counter.
   */
  reset(): void {
    super.reset();
    this.turnNumber = 0;
  }

  /**
   * Get current turn number.
   */
  getCurrentTurn(): number {
    return this.turnNumber;
  }
}
