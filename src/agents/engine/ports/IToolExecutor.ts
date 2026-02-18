/**
 * IToolExecutor - Tool Execution Interface
 *
 * Defines the contract for executing tools in the agentic loop.
 * This is a port in the hexagonal architecture.
 */

import type { RiskLevel, SideEffect, ValidationResult } from '../core/types';

// =============================================================================
// Types
// =============================================================================

/**
 * Context for tool execution
 */
export interface ExecutionContext {
  /** Project identifier */
  projectId: string;
  /** Sequence identifier */
  sequenceId?: string;
  /** Session identifier for tracking */
  sessionId: string;
  /** Expected project state version for optimistic consistency checks */
  expectedStateVersion?: number;
  /** Whether this is a dry run */
  dryRun?: boolean;
}

/**
 * Result from executing a tool
 */
export interface ToolExecutionResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Result data if successful */
  data?: unknown;
  /** Error message if failed */
  error?: string;
  /** Execution duration in milliseconds */
  duration: number;
  /** Side effects caused by the execution */
  sideEffects?: SideEffect[];
  /** Whether the operation can be undone */
  undoable?: boolean;
  /** Undo operation details */
  undoOperation?: UndoOperation;
}

/**
 * Undo operation information
 */
export interface UndoOperation {
  /** Tool to call for undo */
  tool: string;
  /** Arguments for undo */
  args: Record<string, unknown>;
  /** Description of undo */
  description: string;
}

/**
 * Information about an available tool
 */
export interface ToolInfo {
  /** Tool name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Tool category */
  category: string;
  /** Risk level of the tool */
  riskLevel: RiskLevel;
  /** Whether the tool supports undo */
  supportsUndo: boolean;
  /** Estimated duration */
  estimatedDuration?: 'instant' | 'fast' | 'slow';
  /** Whether tool can run in parallel */
  parallelizable: boolean;
}

/**
 * Full tool definition including schema
 */
export interface ToolDefinition extends ToolInfo {
  /** JSON Schema for parameters */
  parameters: Record<string, unknown>;
  /** Required parameters */
  required?: string[];
  /** Example usage */
  examples?: Array<{
    description: string;
    args: Record<string, unknown>;
  }>;
}

/**
 * Batch execution request
 */
export interface BatchExecutionRequest {
  /** Tools to execute */
  tools: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
  /** Execution mode */
  mode: 'sequential' | 'parallel';
  /** Stop on first error */
  stopOnError: boolean;
}

/**
 * Batch execution result
 */
export interface BatchExecutionResult {
  /** Overall success */
  success: boolean;
  /** Individual results */
  results: Array<{
    tool: string;
    result: ToolExecutionResult;
  }>;
  /** Total duration */
  totalDuration: number;
  /** Number of successful executions */
  successCount: number;
  /** Number of failed executions */
  failureCount: number;
}

// =============================================================================
// Interface
// =============================================================================

/**
 * Tool Executor interface for executing tools
 *
 * Implementations:
 * - ToolRegistryAdapter: Uses existing ToolRegistry
 * - MockToolExecutor: Testing
 */
export interface IToolExecutor {
  /**
   * Execute a single tool
   *
   * @param toolName - Name of the tool to execute
   * @param args - Arguments to pass to the tool
   * @param context - Execution context
   * @returns Execution result
   */
  execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolExecutionResult>;

  /**
   * Execute multiple tools
   *
   * @param request - Batch execution request
   * @param context - Execution context
   * @returns Batch execution result
   */
  executeBatch(
    request: BatchExecutionRequest,
    context: ExecutionContext,
  ): Promise<BatchExecutionResult>;

  /**
   * Get list of available tools
   *
   * @param category - Optional category filter
   * @returns Array of tool information
   */
  getAvailableTools(category?: string): ToolInfo[];

  /**
   * Get full definition of a tool
   *
   * @param name - Tool name
   * @returns Tool definition or null if not found
   */
  getToolDefinition(name: string): ToolDefinition | null;

  /**
   * Validate tool arguments
   *
   * @param toolName - Tool name
   * @param args - Arguments to validate
   * @returns Validation result
   */
  validateArgs(toolName: string, args: Record<string, unknown>): ValidationResult;

  /**
   * Check if a tool exists
   *
   * @param name - Tool name
   * @returns Whether tool exists
   */
  hasTool(name: string): boolean;

  /**
   * Get tools by category
   *
   * @returns Map of category to tools
   */
  getToolsByCategory(): Map<string, ToolInfo[]>;

  /**
   * Get tools by risk level
   *
   * @param maxRisk - Maximum risk level to include
   * @returns Array of tools
   */
  getToolsByRisk(maxRisk: RiskLevel): ToolInfo[];
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create a successful tool result
 */
export function createSuccessResult(
  data: unknown,
  duration: number,
  sideEffects?: SideEffect[],
): ToolExecutionResult {
  return {
    success: true,
    data,
    duration,
    sideEffects,
    undoable: false,
  };
}

/**
 * Create a failed tool result
 */
export function createFailureResult(error: string, duration: number): ToolExecutionResult {
  return {
    success: false,
    error,
    duration,
    undoable: false,
  };
}

/**
 * Create an undoable tool result
 */
export function createUndoableResult(
  data: unknown,
  duration: number,
  undoOperation: UndoOperation,
  sideEffects?: SideEffect[],
): ToolExecutionResult {
  return {
    success: true,
    data,
    duration,
    sideEffects,
    undoable: true,
    undoOperation,
  };
}
