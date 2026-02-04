/**
 * Undo Registry
 *
 * Manages undo operations for tool executions.
 * Tracks tool results and generates inverse operations.
 */

import type { AgentToolResult } from '../Agent';
import { createLogger } from '@/services/logger';

const logger = createLogger('UndoRegistry');

// =============================================================================
// Types
// =============================================================================

/**
 * An operation that can be undone.
 */
export interface UndoOperation {
  /** Unique identifier for this undo operation */
  id: string;
  /** The original tool name */
  toolName: string;
  /** Original arguments passed to the tool */
  originalArgs: Record<string, unknown>;
  /** Result from the original execution */
  originalResult: AgentToolResult;
  /** Timestamp of the original execution */
  timestamp: number;
  /** Description of what the undo will do */
  description: string;
  /** The inverse operation to execute for undo */
  inverseOperation: InverseOperation;
}

/**
 * The inverse operation to perform when undoing.
 */
export interface InverseOperation {
  /** Tool to call for undo (may be different from original) */
  toolName: string;
  /** Arguments for the inverse operation */
  args: Record<string, unknown>;
}

/**
 * Function to generate an undo operation from tool execution.
 */
export type UndoGenerator = (
  toolName: string,
  args: Record<string, unknown>,
  result: AgentToolResult
) => UndoOperation | null;

/**
 * Configuration for undo registry.
 */
export interface UndoRegistryConfig {
  /** Maximum number of undo operations to store */
  maxHistory?: number;
}

// =============================================================================
// Undo Registry
// =============================================================================

/**
 * Registry for managing undo operations.
 *
 * Features:
 * - Tracks tool executions and their results
 * - Generates inverse operations for undo
 * - Limited history with LIFO ordering
 *
 * @example
 * ```typescript
 * const registry = new UndoRegistry({ maxHistory: 50 });
 *
 * // Register a generator for a specific tool
 * registry.registerGenerator('move_clip', (toolName, args, result) => ({
 *   id: crypto.randomUUID(),
 *   toolName,
 *   originalArgs: args,
 *   originalResult: result,
 *   timestamp: Date.now(),
 *   description: 'Move clip back to original position',
 *   inverseOperation: {
 *     toolName: 'move_clip',
 *     args: { ...args, newTimelineIn: args.originalTimelineIn }
 *   }
 * }));
 *
 * // Record an execution
 * const undoOp = registry.recordExecution('move_clip', args, result);
 *
 * // Get undo operation
 * const canUndo = registry.canUndo();
 * const op = registry.popUndo();
 * ```
 */
export class UndoRegistry {
  private undoStack: UndoOperation[] = [];
  private generators: Map<string, UndoGenerator> = new Map();
  private maxHistory: number;

  constructor(config: UndoRegistryConfig = {}) {
    this.maxHistory = config.maxHistory ?? 100;
  }

  // ===========================================================================
  // Generator Registration
  // ===========================================================================

  /**
   * Register an undo generator for a tool.
   *
   * @param toolName - Name of the tool
   * @param generator - Function to generate undo operations
   */
  registerGenerator(toolName: string, generator: UndoGenerator): void {
    this.generators.set(toolName, generator);
    logger.debug('Undo generator registered', { toolName });
  }

  /**
   * Unregister an undo generator.
   *
   * @param toolName - Name of the tool
   */
  unregisterGenerator(toolName: string): void {
    this.generators.delete(toolName);
    logger.debug('Undo generator unregistered', { toolName });
  }

  /**
   * Check if a tool has an undo generator.
   *
   * @param toolName - Name of the tool
   * @returns Whether the tool supports undo
   */
  hasGenerator(toolName: string): boolean {
    return this.generators.has(toolName);
  }

  // ===========================================================================
  // Execution Recording
  // ===========================================================================

  /**
   * Record a tool execution and generate an undo operation.
   *
   * @param toolName - Name of the executed tool
   * @param args - Arguments passed to the tool
   * @param result - Result from the tool execution
   * @returns The undo operation if one was generated
   */
  recordExecution(
    toolName: string,
    args: Record<string, unknown>,
    result: AgentToolResult
  ): UndoOperation | null {
    // Only record successful executions
    if (!result.success) {
      return null;
    }

    const generator = this.generators.get(toolName);
    if (!generator) {
      return null;
    }

    try {
      const undoOp = generator(toolName, args, result);
      if (undoOp) {
        this.pushUndo(undoOp);
        logger.debug('Undo operation recorded', {
          toolName,
          undoId: undoOp.id,
        });
        return undoOp;
      }
    } catch (error) {
      logger.error('Failed to generate undo operation', { toolName, error });
    }

    return null;
  }

  // ===========================================================================
  // Undo Stack Operations
  // ===========================================================================

  /**
   * Check if there are any undo operations available.
   */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Get the number of available undo operations.
   */
  getUndoCount(): number {
    return this.undoStack.length;
  }

  /**
   * Peek at the next undo operation without removing it.
   */
  peekUndo(): UndoOperation | null {
    if (this.undoStack.length === 0) {
      return null;
    }
    return this.undoStack[this.undoStack.length - 1];
  }

  /**
   * Pop the next undo operation from the stack.
   */
  popUndo(): UndoOperation | null {
    return this.undoStack.pop() ?? null;
  }

  /**
   * Get all undo operations (most recent first).
   */
  getUndoHistory(): UndoOperation[] {
    return [...this.undoStack].reverse();
  }

  /**
   * Clear all undo operations.
   */
  clearUndoStack(): void {
    this.undoStack = [];
    logger.debug('Undo stack cleared');
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private pushUndo(operation: UndoOperation): void {
    this.undoStack.push(operation);

    // Trim history if needed
    while (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new UndoRegistry instance.
 */
export function createUndoRegistry(config?: UndoRegistryConfig): UndoRegistry {
  return new UndoRegistry(config);
}

// =============================================================================
// Standard Undo Generators
// =============================================================================

/**
 * Standard undo generator for move_clip operations.
 * Assumes the result contains the original position.
 */
export const moveClipUndoGenerator: UndoGenerator = (
  toolName,
  args,
  result
) => {
  // Need original position from result or args
  const originalPosition = (result.result as { originalTimelineIn?: number })?.originalTimelineIn;
  const originalTrackId = (result.result as { originalTrackId?: string })?.originalTrackId;

  if (originalPosition === undefined) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    toolName,
    originalArgs: args,
    originalResult: result,
    timestamp: Date.now(),
    description: `Move clip back to ${originalPosition}s`,
    inverseOperation: {
      toolName: 'move_clip',
      args: {
        sequenceId: args.sequenceId,
        trackId: originalTrackId ?? args.trackId,
        clipId: args.clipId,
        newTimelineIn: originalPosition,
        newTrackId: originalTrackId !== args.trackId ? args.trackId : undefined,
      },
    },
  };
};

/**
 * Standard undo generator for delete_clip operations.
 * Requires the result to contain enough info to restore the clip.
 */
export const deleteClipUndoGenerator: UndoGenerator = (
  toolName,
  args,
  result
) => {
  const deletedClipData = result.result as {
    assetId?: string;
    timelineIn?: number;
    sourceIn?: number;
    sourceOut?: number;
  };

  if (!deletedClipData?.assetId || deletedClipData.timelineIn === undefined) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    toolName,
    originalArgs: args,
    originalResult: result,
    timestamp: Date.now(),
    description: 'Restore deleted clip',
    inverseOperation: {
      toolName: 'insert_clip',
      args: {
        sequenceId: args.sequenceId,
        trackId: args.trackId,
        assetId: deletedClipData.assetId,
        timelineStart: deletedClipData.timelineIn,
        sourceIn: deletedClipData.sourceIn,
        sourceOut: deletedClipData.sourceOut,
      },
    },
  };
};

/**
 * Standard undo generator for insert_clip operations.
 * The inverse is delete_clip.
 */
export const insertClipUndoGenerator: UndoGenerator = (
  toolName,
  args,
  result
) => {
  const insertedClipId = (result.result as { clipId?: string })?.clipId;

  if (!insertedClipId) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    toolName,
    originalArgs: args,
    originalResult: result,
    timestamp: Date.now(),
    description: 'Remove inserted clip',
    inverseOperation: {
      toolName: 'delete_clip',
      args: {
        sequenceId: args.sequenceId,
        trackId: args.trackId,
        clipId: insertedClipId,
      },
    },
  };
};
