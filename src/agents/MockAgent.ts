/**
 * Mock Agent
 *
 * A mock implementation of the Agent class for testing purposes.
 * Allows setting predefined responses to simulate LLM behavior.
 */

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

// =============================================================================
// Types
// =============================================================================

/** Mock response from the simulated LLM */
export interface MockLLMResponse {
  /** The content of the assistant's response */
  content: string;
  /** Tool calls to make */
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

// =============================================================================
// Mock Agent
// =============================================================================

/**
 * Mock Agent for testing purposes.
 *
 * Allows setting predefined responses to simulate LLM interactions
 * without making actual API calls.
 *
 * Usage:
 * ```typescript
 * const agent = new MockAgent(config);
 *
 * // Set a single response
 * agent.setMockResponse({ content: 'Hello', toolCalls: [] });
 *
 * // Or set multiple responses for multi-turn conversations
 * agent.setMockResponses([
 *   { content: 'Calling tool', toolCalls: [{ name: 'tool', arguments: {} }] },
 *   { content: 'Done', toolCalls: [] },
 * ]);
 *
 * const result = await agent.run('User message');
 * ```
 */
export class MockAgent extends Agent {
  /** Queue of mock responses */
  private responseQueue: MockLLMResponse[] = [];

  /** Default response when queue is empty */
  private defaultResponse: MockLLMResponse = {
    content: 'I am a mock agent with no configured response.',
    toolCalls: [],
  };

  /** Record of executed tool calls for verification */
  public executedToolCalls: AgentToolCall[] = [];

  /** Last context received */
  public lastReceivedContext: AgentContext | null = null;

  /** Tool handlers map */
  private toolHandlers: Map<string, (args: Record<string, unknown>, ctx: AgentContext) => Promise<AgentToolResult>> = new Map();

  constructor(config: AgentConfig) {
    super(config);

    // Initialize default tool handlers that return success
    for (const tool of config.tools ?? []) {
      this.toolHandlers.set(tool.name, async () => ({
        success: true,
        result: { done: true },
      }));
    }
  }

  // ===========================================================================
  // Mock Configuration
  // ===========================================================================

  /**
   * Set a single mock response.
   *
   * @param response - The response to return
   */
  setMockResponse(response: MockLLMResponse): void {
    this.responseQueue = [response];
  }

  /**
   * Set multiple mock responses for multi-turn conversations.
   *
   * @param responses - The responses to return in order
   */
  setMockResponses(responses: MockLLMResponse[]): void {
    this.responseQueue = [...responses];
  }

  /**
   * Set the default response when queue is empty.
   *
   * @param response - The default response
   */
  setDefaultResponse(response: MockLLMResponse): void {
    this.defaultResponse = response;
  }

  /**
   * Set a custom handler for a specific tool.
   *
   * @param toolName - The tool name
   * @param handler - The handler function
   */
  setToolHandler(
    toolName: string,
    handler: (args: Record<string, unknown>, ctx: AgentContext) => Promise<AgentToolResult>
  ): void {
    this.toolHandlers.set(toolName, handler);
  }

  /**
   * Clear all mock responses and executed calls.
   */
  clearMocks(): void {
    this.responseQueue = [];
    this.executedToolCalls = [];
    this.lastReceivedContext = null;
  }

  // ===========================================================================
  // Agent Implementation
  // ===========================================================================

  protected async processMessage(
    _message: AgentMessage,
    context: AgentContext
  ): Promise<AgentResponse> {
    // Store context for verification
    this.lastReceivedContext = context;

    // Get next response from queue or use default
    const mockResponse = this.responseQueue.shift() ?? this.defaultResponse;

    // Convert to AgentResponse
    const toolCalls: AgentToolCall[] = mockResponse.toolCalls.map((tc, index) => ({
      name: tc.name,
      arguments: tc.arguments,
      id: `call_${Date.now()}_${index}`,
    }));

    return {
      message: {
        role: 'assistant',
        content: mockResponse.content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      toolCalls,
      shouldContinue: toolCalls.length > 0,
    };
  }

  protected async executeToolCall(
    tool: AgentTool,
    args: Record<string, unknown>
  ): Promise<AgentToolResult> {
    // Record the tool call
    this.executedToolCalls.push({
      name: tool.name,
      arguments: args,
    });

    // Get handler or use default
    const handler = this.toolHandlers.get(tool.name);
    if (handler) {
      return handler(args, this.lastReceivedContext ?? {});
    }

    // Default success response
    return {
      success: true,
      result: { toolName: tool.name, args },
    };
  }

  // ===========================================================================
  // Reset Override
  // ===========================================================================

  /**
   * Reset the agent state including mock data.
   */
  reset(): void {
    super.reset();
    this.executedToolCalls = [];
    this.lastReceivedContext = null;
  }
}
