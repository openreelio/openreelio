/**
 * Agent Base Class
 *
 * Abstract base class for AI agents that can process messages and execute tools.
 * Provides core functionality for conversation management, tool execution,
 * and event handling.
 */

import { createLogger } from '@/services/logger';

const logger = createLogger('Agent');

// =============================================================================
// Types
// =============================================================================

/** Agent status values */
export type AgentStatus = 'idle' | 'processing' | 'error';

/** Message roles in a conversation */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A message in the agent conversation */
export interface AgentMessage {
  /** The role of the message sender */
  role: MessageRole;
  /** The content of the message */
  content: string;
  /** Optional tool calls from assistant messages */
  toolCalls?: AgentToolCall[];
  /** Tool call ID for tool result messages */
  toolCallId?: string;
}

/** A tool call from the assistant */
export interface AgentToolCall {
  /** The name of the tool to call */
  name: string;
  /** The arguments to pass to the tool */
  arguments: Record<string, unknown>;
  /** Optional call ID for tracking */
  id?: string;
}

/** JSON Schema for tool parameters */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: unknown[];
}

/** A tool that an agent can use */
export interface AgentTool {
  /** The name of the tool */
  name: string;
  /** A description of what the tool does */
  description: string;
  /** JSON Schema for the tool's parameters */
  parameters: JsonSchema;
}

/** Result of executing a tool */
export interface AgentToolResult {
  /** Whether the tool execution succeeded */
  success: boolean;
  /** The result data (if successful) */
  result?: unknown;
  /** Error message (if failed) */
  error?: string;
}

/** Context provided to the agent for processing */
export interface AgentContext {
  /** The project ID */
  projectId?: string;
  /** The active sequence ID */
  sequenceId?: string;
  /** Currently selected clip IDs */
  selectedClipIds?: string[];
  /** Currently selected track IDs */
  selectedTrackIds?: string[];
  /** Current playhead position in seconds */
  playheadPosition?: number;
  /** Total timeline duration in seconds */
  timelineDuration?: number;
  /** Additional context data */
  metadata?: Record<string, unknown>;
}

/** Response from processing a message */
export interface AgentResponse {
  /** The assistant's response message */
  message: AgentMessage;
  /** Tool calls to execute */
  toolCalls: AgentToolCall[];
  /** Whether to continue processing (for tool calls) */
  shouldContinue: boolean;
}

/** Configuration for creating an agent */
export interface AgentConfig {
  /** The name of the agent */
  name: string;
  /** A description of the agent's purpose */
  description: string;
  /** Maximum iterations for tool calls */
  maxIterations?: number;
  /** Tools available to the agent */
  tools?: AgentTool[];
  /** System prompt for the agent */
  systemPrompt?: string;
}

/** Event types for agent */
export type AgentEventType = 'message' | 'statusChange' | 'toolCall' | 'error';

/** Event listener function */
export type AgentEventListener<T = unknown> = (data: T) => void;

// =============================================================================
// Agent Base Class
// =============================================================================

/**
 * Abstract base class for AI agents.
 *
 * Subclasses must implement:
 * - processMessage(): Process a message and return a response
 * - executeToolCall(): Execute a tool and return the result
 */
export abstract class Agent {
  /** The agent's name */
  public readonly name: string;

  /** The agent's description */
  public readonly description: string;

  /** Maximum number of iterations for tool calls */
  protected readonly maxIterations: number;

  /** Current agent status */
  private _status: AgentStatus = 'idle';

  /** Conversation history */
  private _conversationHistory: AgentMessage[] = [];

  /** Registered tools */
  private _tools: Map<string, AgentTool> = new Map();

  /** Event listeners */
  private _listeners: Map<AgentEventType, Set<AgentEventListener>> = new Map();

  /** System prompt */
  protected readonly systemPrompt: string | undefined;

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.description = config.description;
    this.maxIterations = config.maxIterations ?? 10;
    this.systemPrompt = config.systemPrompt;

    // Register initial tools
    if (config.tools) {
      for (const tool of config.tools) {
        this._tools.set(tool.name, tool);
      }
    }

    // Initialize event listener maps
    this._listeners.set('message', new Set());
    this._listeners.set('statusChange', new Set());
    this._listeners.set('toolCall', new Set());
    this._listeners.set('error', new Set());
  }

  // ===========================================================================
  // Public Getters
  // ===========================================================================

  /** Get current agent status */
  get status(): AgentStatus {
    return this._status;
  }

  /** Get conversation history */
  get conversationHistory(): AgentMessage[] {
    return [...this._conversationHistory];
  }

  /** Get registered tools */
  get tools(): AgentTool[] {
    return Array.from(this._tools.values());
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Run the agent with a user message.
   *
   * @param input - The user's input message
   * @returns The agent's final response
   */
  async run(input: string): Promise<AgentResponse> {
    return this.runWithContext(input, {});
  }

  /**
   * Run the agent with a user message and context.
   *
   * @param input - The user's input message
   * @param context - Context for the agent
   * @returns The agent's final response
   */
  async runWithContext(
    input: string,
    context: AgentContext
  ): Promise<AgentResponse> {
    this.setStatus('processing');

    const userMessage: AgentMessage = {
      role: 'user',
      content: input,
    };

    this._conversationHistory.push(userMessage);

    try {
      let response = await this.processMessage(userMessage, context);
      let iterations = 0;

      // Add the assistant's response to history
      this._conversationHistory.push(response.message);
      this.emit('message', response.message);

      // Process tool calls in a loop
      while (response.shouldContinue && iterations < this.maxIterations) {
        iterations++;

        // Execute any tool calls
        if (response.toolCalls.length > 0) {
          for (const toolCall of response.toolCalls) {
            const tool = this._tools.get(toolCall.name);

            if (!tool) {
              logger.warn('Tool not found', { toolName: toolCall.name });
              continue;
            }

            this.emit('toolCall', toolCall);

            const result = await this.executeToolCall(tool, toolCall.arguments);

            // Add tool result to history
            const toolMessage: AgentMessage = {
              role: 'tool',
              content: JSON.stringify(result),
              toolCallId: toolCall.id,
            };
            this._conversationHistory.push(toolMessage);
          }
        }

        // Get next response
        const lastMessage =
          this._conversationHistory[this._conversationHistory.length - 1];
        response = await this.processMessage(lastMessage, context);

        this._conversationHistory.push(response.message);
        this.emit('message', response.message);
      }

      this.setStatus('idle');
      return response;
    } catch (error) {
      this.setStatus('error');
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Reset the agent state.
   */
  reset(): void {
    this._conversationHistory = [];
    this._status = 'idle';
  }

  /**
   * Register a tool with the agent.
   *
   * @param tool - The tool to register
   */
  registerTool(tool: AgentTool): void {
    this._tools.set(tool.name, tool);
  }

  /**
   * Unregister a tool from the agent.
   *
   * @param toolName - The name of the tool to unregister
   */
  unregisterTool(toolName: string): void {
    this._tools.delete(toolName);
  }

  /**
   * Add an event listener.
   *
   * @param event - The event type
   * @param listener - The listener function
   */
  on<T = unknown>(event: AgentEventType, listener: AgentEventListener<T>): void {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.add(listener as AgentEventListener);
    }
  }

  /**
   * Remove an event listener.
   *
   * @param event - The event type
   * @param listener - The listener function to remove
   */
  off<T = unknown>(event: AgentEventType, listener: AgentEventListener<T>): void {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.delete(listener as AgentEventListener);
    }
  }

  // ===========================================================================
  // Protected Methods (To be implemented by subclasses)
  // ===========================================================================

  /**
   * Process a message and generate a response.
   * Must be implemented by subclasses.
   *
   * @param message - The message to process
   * @param context - The agent context
   * @returns The agent's response
   */
  protected abstract processMessage(
    message: AgentMessage,
    context: AgentContext
  ): Promise<AgentResponse>;

  /**
   * Execute a tool call.
   * Must be implemented by subclasses.
   *
   * @param tool - The tool to execute
   * @param args - The arguments for the tool
   * @returns The tool execution result
   */
  protected abstract executeToolCall(
    tool: AgentTool,
    args: Record<string, unknown>
  ): Promise<AgentToolResult>;

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Set the agent status and emit event.
   */
  private setStatus(status: AgentStatus): void {
    this._status = status;
    this.emit('statusChange', status);
  }

  /**
   * Emit an event to all listeners.
   */
  private emit<T>(event: AgentEventType, data: T): void {
    const listeners = this._listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (error) {
          logger.error('Error in event listener', { event, error });
        }
      }
    }
  }
}
