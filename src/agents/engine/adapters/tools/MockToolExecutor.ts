/**
 * MockToolExecutor - Mock Tool Executor for Testing
 *
 * Provides controllable tool execution for unit testing.
 * Simulates tool behavior without actual IPC calls.
 */

import type {
  IToolExecutor,
  ExecutionContext,
  ToolExecutionResult,
  ToolInfo,
  ToolDefinition,
  BatchExecutionRequest,
  BatchExecutionResult,
} from '../../ports/IToolExecutor';
import type { RiskLevel, ValidationResult } from '../../core/types';

// =============================================================================
// Types
// =============================================================================

/**
 * Mock tool configuration
 */
export interface MockToolConfig {
  /** Tool information */
  info: ToolInfo;
  /** JSON Schema for parameters */
  parameters: Record<string, unknown>;
  /** Required parameters */
  required?: string[];
  /** Mock result to return */
  result?: ToolExecutionResult;
  /** Error to throw */
  error?: Error;
  /** Delay before response (ms) */
  delay?: number;
  /** Custom executor function */
  executor?: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
}

/**
 * Captured tool execution
 */
export interface CapturedExecution {
  toolName: string;
  args: Record<string, unknown>;
  context: ExecutionContext;
  timestamp: number;
  result?: ToolExecutionResult;
}

// =============================================================================
// MockToolExecutor
// =============================================================================

/**
 * Mock tool executor for testing
 *
 * Features:
 * - Register mock tools
 * - Configure results per tool
 * - Capture executions for verification
 * - Simulate delays and errors
 *
 * @example
 * ```typescript
 * const mock = new MockToolExecutor();
 *
 * // Register a mock tool
 * mock.registerTool({
 *   info: { name: 'split_clip', ... },
 *   parameters: { ... },
 *   result: { success: true, data: { newClipId: 'clip-2' }, duration: 100 }
 * });
 *
 * // Execute
 * const result = await mock.execute('split_clip', { clipId: 'clip-1', position: 5 }, context);
 *
 * // Verify
 * expect(mock.getExecutionCount()).toBe(1);
 * ```
 */
export class MockToolExecutor implements IToolExecutor {
  private tools: Map<string, MockToolConfig> = new Map();
  private capturedExecutions: CapturedExecution[] = [];
  private defaultResult: ToolExecutionResult = {
    success: true,
    data: {},
    duration: 10,
  };

  // ===========================================================================
  // Tool Registration
  // ===========================================================================

  /**
   * Register a mock tool
   */
  registerTool(config: MockToolConfig): void {
    this.tools.set(config.info.name, config);
  }

  /**
   * Register multiple mock tools
   */
  registerTools(configs: MockToolConfig[]): void {
    for (const config of configs) {
      this.registerTool(config);
    }
  }

  /**
   * Unregister a tool
   */
  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Set result for a specific tool
   */
  setToolResult(toolName: string, result: ToolExecutionResult): void {
    const config = this.tools.get(toolName);
    if (config) {
      config.result = result;
    }
  }

  /**
   * Set error for a specific tool
   */
  setToolError(toolName: string, error: Error): void {
    const config = this.tools.get(toolName);
    if (config) {
      config.error = error;
    }
  }

  /**
   * Set default result for unregistered tools
   */
  setDefaultResult(result: ToolExecutionResult): void {
    this.defaultResult = result;
  }

  /**
   * Reset all tools and captures
   */
  reset(): void {
    this.tools.clear();
    this.capturedExecutions = [];
  }

  /**
   * Reset only captured executions
   */
  clearExecutions(): void {
    this.capturedExecutions = [];
  }

  // ===========================================================================
  // Execution Verification
  // ===========================================================================

  /**
   * Get all captured executions
   */
  getCapturedExecutions(): CapturedExecution[] {
    return [...this.capturedExecutions];
  }

  /**
   * Get executions for a specific tool
   */
  getExecutionsFor(toolName: string): CapturedExecution[] {
    return this.capturedExecutions.filter((e) => e.toolName === toolName);
  }

  /**
   * Get the last execution
   */
  getLastExecution(): CapturedExecution | undefined {
    return this.capturedExecutions[this.capturedExecutions.length - 1];
  }

  /**
   * Get total execution count
   */
  getExecutionCount(): number {
    return this.capturedExecutions.length;
  }

  /**
   * Check if a tool was called
   */
  wasToolCalled(toolName: string): boolean {
    return this.capturedExecutions.some((e) => e.toolName === toolName);
  }

  /**
   * Check if a tool was called with specific args
   */
  wasToolCalledWith(
    toolName: string,
    args: Record<string, unknown>
  ): boolean {
    return this.capturedExecutions.some(
      (e) =>
        e.toolName === toolName &&
        JSON.stringify(e.args) === JSON.stringify(args)
    );
  }

  // ===========================================================================
  // IToolExecutor Implementation
  // ===========================================================================

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const config = this.tools.get(toolName);

    // Capture the execution
    const capture: CapturedExecution = {
      toolName,
      args: { ...args },
      context: { ...context },
      timestamp: startTime,
    };

    // Handle unknown tool
    if (!config) {
      const result: ToolExecutionResult = {
        success: false,
        error: `Tool not found: ${toolName}`,
        duration: Date.now() - startTime,
      };
      capture.result = result;
      this.capturedExecutions.push(capture);
      return result;
    }

    // Handle configured error
    if (config.error) {
      const result: ToolExecutionResult = {
        success: false,
        error: config.error.message,
        duration: Date.now() - startTime,
      };
      capture.result = result;
      this.capturedExecutions.push(capture);
      throw config.error;
    }

    // Apply delay
    if (config.delay) {
      await this.delay(config.delay);
    }

    // Use custom executor if provided
    if (config.executor) {
      const result = await config.executor(args);
      capture.result = result;
      this.capturedExecutions.push(capture);
      return result;
    }

    // Return configured result or default
    const result = config.result ?? this.defaultResult;
    const finalResult = {
      ...result,
      duration: Date.now() - startTime,
    };
    capture.result = finalResult;
    this.capturedExecutions.push(capture);
    return finalResult;
  }

  async executeBatch(
    request: BatchExecutionRequest,
    context: ExecutionContext
  ): Promise<BatchExecutionResult> {
    const startTime = Date.now();
    const results: Array<{ tool: string; result: ToolExecutionResult }> = [];
    let successCount = 0;
    let failureCount = 0;

    if (request.mode === 'parallel') {
      // Execute all in parallel
      const promises = request.tools.map(async ({ name, args }) => {
        try {
          const result = await this.execute(name, args, context);
          return { tool: name, result };
        } catch (error) {
          return {
            tool: name,
            result: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
              duration: 0,
            },
          };
        }
      });

      const executed = await Promise.all(promises);
      results.push(...executed);
    } else {
      // Execute sequentially
      for (const { name, args } of request.tools) {
        try {
          const result = await this.execute(name, args, context);
          results.push({ tool: name, result });

          if (!result.success && request.stopOnError) {
            break;
          }
        } catch (error) {
          const result: ToolExecutionResult = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            duration: 0,
          };
          results.push({ tool: name, result });

          if (request.stopOnError) {
            break;
          }
        }
      }
    }

    // Count results
    for (const { result } of results) {
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    return {
      success: failureCount === 0,
      results,
      totalDuration: Date.now() - startTime,
      successCount,
      failureCount,
    };
  }

  getAvailableTools(category?: string): ToolInfo[] {
    const tools: ToolInfo[] = [];

    for (const config of this.tools.values()) {
      if (!category || config.info.category === category) {
        tools.push(config.info);
      }
    }

    return tools;
  }

  getToolDefinition(name: string): ToolDefinition | null {
    const config = this.tools.get(name);
    if (!config) {
      return null;
    }

    return {
      ...config.info,
      parameters: config.parameters,
      required: config.required,
    };
  }

  validateArgs(
    toolName: string,
    args: Record<string, unknown>
  ): ValidationResult {
    const config = this.tools.get(toolName);

    if (!config) {
      return {
        valid: false,
        errors: [`Tool not found: ${toolName}`],
      };
    }

    const errors: string[] = [];

    // Check required fields
    if (config.required) {
      for (const field of config.required) {
        if (args[field] === undefined) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getToolsByCategory(): Map<string, ToolInfo[]> {
    const result = new Map<string, ToolInfo[]>();

    for (const config of this.tools.values()) {
      const category = config.info.category;
      const existing = result.get(category) ?? [];
      existing.push(config.info);
      result.set(category, existing);
    }

    return result;
  }

  getToolsByRisk(maxRisk: RiskLevel): ToolInfo[] {
    const riskOrder: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    const maxIndex = riskOrder.indexOf(maxRisk);

    return this.getAvailableTools().filter((tool) => {
      const toolIndex = riskOrder.indexOf(tool.riskLevel);
      return toolIndex <= maxIndex;
    });
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create empty mock tool executor
 */
export function createMockToolExecutor(): MockToolExecutor {
  return new MockToolExecutor();
}

/**
 * Create mock tool executor with common video editing tools
 */
export function createMockToolExecutorWithVideoTools(): MockToolExecutor {
  const executor = new MockToolExecutor();

  const videoTools: MockToolConfig[] = [
    {
      info: {
        name: 'split_clip',
        description: 'Split a clip at a specific position',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          position: { type: 'number' },
        },
      },
      required: ['clipId', 'position'],
      result: {
        success: true,
        data: { newClipId: 'clip-new' },
        duration: 50,
      },
    },
    {
      info: {
        name: 'move_clip',
        description: 'Move a clip to a new position',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          trackId: { type: 'string' },
          position: { type: 'number' },
        },
      },
      required: ['clipId', 'position'],
      result: {
        success: true,
        data: { moved: true },
        duration: 30,
      },
    },
    {
      info: {
        name: 'delete_clip',
        description: 'Delete a clip from the timeline',
        category: 'editing',
        riskLevel: 'medium',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
        },
      },
      required: ['clipId'],
      result: {
        success: true,
        data: { deleted: true },
        duration: 20,
      },
    },
    {
      info: {
        name: 'trim_clip',
        description: 'Trim a clip start or end',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          startDelta: { type: 'number' },
          endDelta: { type: 'number' },
        },
      },
      required: ['clipId'],
      result: {
        success: true,
        data: { trimmed: true },
        duration: 40,
      },
    },
    {
      info: {
        name: 'get_timeline_info',
        description: 'Get timeline information',
        category: 'analysis',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: true,
      },
      parameters: {
        type: 'object',
        properties: {
          sequenceId: { type: 'string' },
        },
      },
      required: ['sequenceId'],
      result: {
        success: true,
        data: {
          duration: 120,
          tracks: [
            { id: 'track-1', name: 'Video 1', type: 'video', clipCount: 3 },
            { id: 'track-2', name: 'Audio 1', type: 'audio', clipCount: 2 },
          ],
          clips: [
            { id: 'clip-1', trackId: 'track-1', start: 0, end: 30 },
            { id: 'clip-2', trackId: 'track-1', start: 30, end: 60 },
            { id: 'clip-3', trackId: 'track-1', start: 60, end: 120 },
          ],
        },
        duration: 10,
      },
    },
    {
      info: {
        name: 'delete_all_clips',
        description: 'Delete all clips from timeline',
        category: 'editing',
        riskLevel: 'critical',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          sequenceId: { type: 'string' },
          confirm: { type: 'boolean' },
        },
      },
      required: ['sequenceId', 'confirm'],
      result: {
        success: true,
        data: { deletedCount: 5 },
        duration: 100,
      },
    },
  ];

  executor.registerTools(videoTools);
  return executor;
}
