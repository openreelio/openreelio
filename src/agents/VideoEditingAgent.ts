/**
 * Video Editing Agent
 *
 * An AI-powered agent specialized for video editing operations.
 * Processes user intents and generates edit scripts using the AI backend.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  Agent,
  AgentConfig,
  AgentContext,
  AgentMessage,
  AgentResponse,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
} from './Agent';
import { globalToolRegistry } from './ToolRegistry';
import { createLogger } from '@/services/logger';

const logger = createLogger('VideoEditingAgent');

// =============================================================================
// Types
// =============================================================================

/** EditScript command structure from backend */
interface EditScriptCommand {
  commandType: string;
  params: Record<string, unknown>;
  description?: string;
}

/** EditScript structure from backend */
interface EditScript {
  intent: string;
  commands: EditScriptCommand[];
  requires: string[];
  qcRules: string[];
  risk: {
    copyright: string;
    nsfw: string;
  };
  explanation: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

/** Context sent to the AI backend */
interface AIGenerationContext {
  projectId?: string;
  sequenceId?: string;
  selectedClips?: string[];
  selectedTracks?: string[];
  playheadPosition?: number;
  timelineDuration?: number;
  availableTools?: string[];
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant specialized in video editing.
You help users edit their videos by understanding their intent and generating precise editing commands.

Key responsibilities:
1. Understand user's editing intent from natural language
2. Generate appropriate editing commands (split, trim, move, delete, etc.)
3. Consider the current context (selected clips, playhead position, etc.)
4. Provide clear explanations of what will be done
5. Assess risks (copyright, content appropriateness)

Always respond with a clear explanation of what you'll do before executing commands.`;

// =============================================================================
// Video Editing Agent
// =============================================================================

/**
 * AI-powered video editing agent.
 *
 * This agent processes natural language editing requests and generates
 * EditScripts that can be applied to the timeline.
 *
 * Features:
 * - Natural language understanding for video editing
 * - Context-aware command generation
 * - Fallback to local intent analysis
 * - Tool execution through ToolRegistry
 *
 * Usage:
 * ```typescript
 * const agent = new VideoEditingAgent({
 *   name: 'editor',
 *   description: 'Video editing assistant',
 * });
 *
 * const response = await agent.runWithContext('Split the clip at 5 seconds', {
 *   selectedClipIds: ['clip_001'],
 *   playheadPosition: 5.0,
 * });
 * ```
 */
export class VideoEditingAgent extends Agent {
  /** Current execution context for tool calls */
  private currentContext: AgentContext = {};

  constructor(config: Omit<AgentConfig, 'systemPrompt'> & { systemPrompt?: string }) {
    super({
      ...config,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      tools: config.tools ?? globalToolRegistry.toAgentTools(),
    });
  }

  // ===========================================================================
  // Agent Implementation
  // ===========================================================================

  /**
   * Process a message and generate an edit script response.
   */
  protected async processMessage(
    message: AgentMessage,
    context: AgentContext
  ): Promise<AgentResponse> {
    // Store context for tool execution
    this.currentContext = context;

    // Only process user messages
    if (message.role !== 'user') {
      return this.createSimpleResponse('Ready for your next editing request.');
    }

    const userIntent = message.content;

    try {
      // Try AI-powered edit script generation
      const editScript = await this.generateEditScript(userIntent, context);
      return this.createResponseFromEditScript(editScript);
    } catch (aiError) {
      logger.warn('AI generation failed, falling back to local analysis', { error: aiError });

      try {
        // Fallback to local intent analysis
        const localScript = await this.generateLocalEditScript(userIntent, context);
        return this.createResponseFromEditScript(localScript);
      } catch (localError) {
        logger.error('Local analysis also failed', { error: localError });
        throw localError;
      }
    }
  }

  /**
   * Execute a tool call through the ToolRegistry.
   */
  protected async executeToolCall(
    tool: AgentTool,
    args: Record<string, unknown>
  ): Promise<AgentToolResult> {
    logger.debug('Executing tool call', { tool: tool.name, args });

    // Execute through the global tool registry with current context
    const result = await globalToolRegistry.execute(tool.name, args, {
      projectId: this.currentContext.projectId,
      sequenceId: this.currentContext.sequenceId,
    });

    if (!result.success) {
      logger.error('Tool execution failed', { tool: tool.name, error: result.error });
    }

    return result;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Generate edit script using the AI backend.
   */
  private async generateEditScript(
    intent: string,
    context: AgentContext
  ): Promise<EditScript> {
    const aiContext: AIGenerationContext = {
      projectId: context.projectId,
      sequenceId: context.sequenceId,
      selectedClips: context.selectedClipIds,
      selectedTracks: context.selectedTrackIds,
      playheadPosition: context.playheadPosition,
      timelineDuration: context.timelineDuration,
      availableTools: this.tools.map((t) => t.name),
    };

    const editScript = await invoke<EditScript>('generate_edit_script_with_ai', {
      intent,
      context: aiContext,
      conversationHistory: this.conversationHistory.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
    });

    logger.info('Generated edit script', {
      intent,
      commandCount: editScript.commands.length,
    });

    return editScript;
  }

  /**
   * Generate edit script using local intent analysis (fallback).
   */
  private async generateLocalEditScript(
    intent: string,
    context: AgentContext
  ): Promise<EditScript> {
    const editScript = await invoke<EditScript>('analyze_intent', {
      intent,
      context: {
        selectedClips: context.selectedClipIds,
        selectedTracks: context.selectedTrackIds,
        playheadPosition: context.playheadPosition,
      },
    });

    logger.info('Generated local edit script', {
      intent,
      commandCount: editScript.commands.length,
    });

    return editScript;
  }

  /**
   * Create an AgentResponse from an EditScript.
   */
  private createResponseFromEditScript(editScript: EditScript): AgentResponse {
    // Convert EditScript commands to tool calls if they match registered tools
    const toolCalls: AgentToolCall[] = [];

    if (editScript.toolCalls) {
      // Use explicit tool calls from AI
      for (const tc of editScript.toolCalls) {
        if (globalToolRegistry.has(tc.name)) {
          toolCalls.push({
            name: tc.name,
            arguments: tc.arguments,
            id: crypto.randomUUID(),
          });
        }
      }
    } else {
      // Try to match commands to tools
      for (const cmd of editScript.commands) {
        const toolName = this.commandTypeToToolName(cmd.commandType);

        if (globalToolRegistry.has(toolName)) {
          toolCalls.push({
            name: toolName,
            arguments: cmd.params,
            id: crypto.randomUUID(),
          });
        }
      }
    }

    return {
      message: {
        role: 'assistant',
        content: editScript.explanation,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      toolCalls,
      shouldContinue: toolCalls.length > 0,
    };
  }

  /**
   * Create a simple response without tool calls.
   */
  private createSimpleResponse(content: string): AgentResponse {
    return {
      message: {
        role: 'assistant',
        content,
      },
      toolCalls: [],
      shouldContinue: false,
    };
  }

  /**
   * Convert a command type to a tool name.
   * E.g., "SplitClip" -> "split_clip"
   */
  private commandTypeToToolName(commandType: string): string {
    return commandType
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '');
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new VideoEditingAgent with default configuration.
 *
 * @param name - Optional agent name
 * @returns A configured VideoEditingAgent instance
 */
export function createVideoEditingAgent(name = 'video-editor'): VideoEditingAgent {
  return new VideoEditingAgent({
    name,
    description: 'AI-powered video editing assistant',
    tools: globalToolRegistry.toAgentTools(),
    maxIterations: 5,
  });
}
