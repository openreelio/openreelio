/**
 * ToolRegistryAdapter - Bridge to Existing ToolRegistry
 *
 * Adapts the existing ToolRegistry to the IToolExecutor interface
 * used by the agentic engine.
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
import type { RiskLevel, ValidationResult, SideEffect } from '../../core/types';
import { ToolRegistry, type ToolDefinition as LegacyToolDef } from '@/agents/ToolRegistry';
import {
  getAssetCatalogSnapshot,
  getSelectionContext,
  getTimelineSnapshot,
} from '@/agents/tools/storeAccessor';
import { useProjectStore } from '@/stores/projectStore';

// =============================================================================
// Types
// =============================================================================

/**
 * Mapping from legacy category to risk level
 */
const CATEGORY_RISK_MAP: Record<string, RiskLevel> = {
  timeline: 'medium',
  clip: 'medium',
  track: 'medium',
  effect: 'low',
  transition: 'low',
  audio: 'low',
  export: 'high',
  project: 'high',
  analysis: 'low',
  utility: 'low',
  generation: 'high',
};

/**
 * Estimated duration by category
 */
const CATEGORY_DURATION_MAP: Record<string, 'instant' | 'fast' | 'slow'> = {
  timeline: 'instant',
  clip: 'instant',
  track: 'instant',
  effect: 'fast',
  transition: 'fast',
  audio: 'fast',
  export: 'slow',
  project: 'fast',
  analysis: 'instant',
  utility: 'instant',
  generation: 'slow',
};

const READ_ONLY_TOOL_PREFIXES = [
  'get_',
  'list_',
  'find_',
  'search_',
  'analyze_',
  'inspect_',
  'query_',
  'read_',
];

const ID_PLACEHOLDER_PATTERNS: RegExp[] = [
  /(?:^|[_-])(placeholder|example|sample|dummy|temp|todo|tbd|unknown)(?:$|[_-])/i,
  /_from_(catalog|list|lookup|response|result)/i,
  /^asset_id(?:_|$)/i,
];

const TRACK_ALIAS_PATTERNS: RegExp[] = [/^(video|audio)_[0-9]+$/i];

// =============================================================================
// ToolRegistryAdapter
// =============================================================================

/**
 * Adapter that bridges the existing ToolRegistry to IToolExecutor.
 *
 * This allows the new agentic engine to use existing tool definitions
 * while maintaining backward compatibility.
 *
 * @example
 * ```typescript
 * import { globalToolRegistry } from '@/agents';
 *
 * const adapter = createToolRegistryAdapter(globalToolRegistry);
 * const result = await adapter.execute('split_clip', { clipId: 'clip-1', atTimelineSec: 5 }, context);
 * ```
 */
export class ToolRegistryAdapter implements IToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly sessionStateVersions = new Map<string, number>();

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  // ===========================================================================
  // IToolExecutor Implementation
  // ===========================================================================

  /**
   * Execute a single tool
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolExecutionResult> {
    const startTime = performance.now();
    const isReadOnlyTool = this.isReadOnlyToolName(toolName);

    if (!isReadOnlyTool) {
      const revisionError = this.validateStateRevision(context);
      if (revisionError) {
        return {
          success: false,
          error: revisionError,
          duration: performance.now() - startTime,
          undoable: false,
        };
      }
    }

    const preflightErrors = this.validateToolPreconditions(toolName, args, context);
    if (preflightErrors.length > 0) {
      return {
        success: false,
        error: `PRECONDITION_FAILED: ${preflightErrors.join('; ')}`,
        duration: performance.now() - startTime,
        undoable: false,
      };
    }

    // Convert context to legacy format, reading live state from stores.
    // Only inject active state when the context targets the active sequence.
    const selection = getSelectionContext();
    const isActiveSequence = context.sequenceId === selection.sequenceId;

    const legacyContext = {
      projectId: context.projectId,
      sequenceId: context.sequenceId,
      selectedClips: isActiveSequence ? selection.selectedClipIds : [],
      selectedTracks: isActiveSequence ? selection.selectedTrackIds : [],
      playheadPosition: isActiveSequence ? selection.playheadPosition : 0,
    };

    // Execute through registry with error handling
    let result;
    try {
      result = await this.registry.execute(toolName, args, legacyContext);
    } catch (error) {
      const duration = performance.now() - startTime;
      this.rememberSessionStateVersion(context.sessionId, useProjectStore.getState().stateVersion);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration,
        undoable: false,
      };
    }
    this.rememberSessionStateVersion(context.sessionId, useProjectStore.getState().stateVersion);
    const duration = performance.now() - startTime;

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? 'Unknown error',
        duration,
        undoable: false,
      };
    }

    // Determine side effects based on tool category
    const tool = this.registry.get(toolName);
    const sideEffects = this.inferSideEffects(tool, context);

    return {
      success: true,
      data: result.result,
      duration,
      sideEffects,
      undoable: this.isUndoable(tool),
    };
  }

  /**
   * Execute multiple tools
   */
  async executeBatch(
    request: BatchExecutionRequest,
    context: ExecutionContext,
  ): Promise<BatchExecutionResult> {
    const startTime = performance.now();
    const results: Array<{ tool: string; result: ToolExecutionResult }> = [];
    let successCount = 0;
    let failureCount = 0;

    if (request.mode === 'parallel') {
      // Execute all in parallel
      const promises = request.tools.map(async (tool) => {
        const result = await this.execute(tool.name, tool.args, context);
        return { tool: tool.name, result };
      });

      const settledResults = await Promise.all(promises);

      for (const { tool, result } of settledResults) {
        results.push({ tool, result });
        if (result.success) {
          successCount++;
        } else {
          failureCount++;
        }
      }
    } else {
      // Execute sequentially
      for (const tool of request.tools) {
        const result = await this.execute(tool.name, tool.args, context);
        results.push({ tool: tool.name, result });

        if (result.success) {
          successCount++;
        } else {
          failureCount++;

          if (request.stopOnError) {
            break;
          }
        }
      }
    }

    const totalDuration = performance.now() - startTime;

    return {
      success: failureCount === 0,
      results,
      totalDuration,
      successCount,
      failureCount,
    };
  }

  /**
   * Get available tools
   */
  getAvailableTools(category?: string): ToolInfo[] {
    const tools = category
      ? this.registry.listByCategory(category as Parameters<typeof this.registry.listByCategory>[0])
      : this.registry.listAll();

    return tools.map((tool) => this.toToolInfo(tool));
  }

  /**
   * Get full tool definition
   */
  getToolDefinition(name: string): ToolDefinition | null {
    const tool = this.registry.get(name);
    if (!tool) return null;

    return this.toToolDefinition(tool);
  }

  /**
   * Validate tool arguments
   */
  validateArgs(toolName: string, args: Record<string, unknown>): ValidationResult {
    const tool = this.registry.get(toolName);

    if (!tool) {
      return {
        valid: false,
        errors: [`Tool '${toolName}' not found`],
      };
    }

    const errors: string[] = [];

    // Check required parameters
    const schema = tool.parameters;
    if (schema.required) {
      for (const required of schema.required) {
        if (!(required in args) || args[required] === undefined) {
          errors.push(`Missing required parameter: '${required}'`);
        }
      }
    }

    // Check parameter types
    if (schema.properties) {
      for (const [key, value] of Object.entries(args)) {
        const propSchema = schema.properties[key];
        if (!propSchema) continue;

        const typeError = this.validateType(key, value, propSchema);
        if (typeError) errors.push(typeError);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Check if tool exists
   */
  hasTool(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Get tools by category
   */
  getToolsByCategory(): Map<string, ToolInfo[]> {
    const result = new Map<string, ToolInfo[]>();

    for (const category of this.registry.listCategories()) {
      const tools = this.registry.listByCategory(category);
      result.set(
        category,
        tools.map((t) => this.toToolInfo(t)),
      );
    }

    return result;
  }

  /**
   * Get tools by risk level
   */
  getToolsByRisk(maxRisk: RiskLevel): ToolInfo[] {
    const riskOrder: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    const maxIndex = riskOrder.indexOf(maxRisk);

    return this.getAvailableTools().filter((tool) => {
      const toolIndex = riskOrder.indexOf(tool.riskLevel);
      return toolIndex <= maxIndex;
    });
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private validateStateRevision(context: ExecutionContext): string | null {
    const projectState = useProjectStore.getState();
    if (!projectState.isLoaded) {
      return null;
    }

    const currentVersion = projectState.stateVersion;
    const trackedVersion = this.sessionStateVersions.get(context.sessionId);
    const expectedVersion = trackedVersion ?? context.expectedStateVersion ?? currentVersion;

    if (expectedVersion !== currentVersion) {
      this.rememberSessionStateVersion(context.sessionId, currentVersion);
      return `REV_CONFLICT: expected state version ${expectedVersion}, current version ${currentVersion}. Refresh context and re-plan with current IDs.`;
    }

    return null;
  }

  private validateToolPreconditions(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): string[] {
    const errors: string[] = [];

    for (const [key, value] of Object.entries(args)) {
      if (!key.endsWith('Id') || typeof value !== 'string') {
        continue;
      }

      if (this.isPlaceholderId(value, key)) {
        errors.push(`${key} '${value}' looks like a placeholder or alias, not a real ID`);
      }
    }

    if (this.isReadOnlyToolName(toolName)) {
      return errors;
    }

    const timeline = getTimelineSnapshot();
    const catalog = getAssetCatalogSnapshot();

    if (!timeline.sequenceId) {
      return errors;
    }

    if (context.sequenceId && context.sequenceId !== timeline.sequenceId) {
      return errors;
    }

    if (typeof args.sequenceId === 'string' && args.sequenceId !== timeline.sequenceId) {
      errors.push(
        `sequenceId '${args.sequenceId}' does not match active sequence '${timeline.sequenceId}'`,
      );
    }

    const trackIds = new Set(timeline.tracks.map((track) => track.id));
    for (const trackKey of ['trackId', 'newTrackId', 'sourceTrackId', 'targetTrackId']) {
      const value = args[trackKey];
      if (typeof value === 'string' && !trackIds.has(value)) {
        errors.push(`${trackKey} '${value}' is not present in active timeline tracks`);
      }
    }

    const assetIds = new Set(catalog.assets.map((asset) => asset.id));
    for (const assetKey of ['assetId', 'sourceAssetId', 'targetAssetId']) {
      const value = args[assetKey];
      if (typeof value === 'string' && !assetIds.has(value)) {
        errors.push(`${assetKey} '${value}' is not present in project asset catalog`);
      }
    }

    const clipIds = new Set(timeline.clips.map((clip) => clip.id));
    for (const clipKey of ['clipId', 'sourceClipId', 'targetClipId']) {
      const value = args[clipKey];
      if (typeof value === 'string' && !clipIds.has(value)) {
        errors.push(`${clipKey} '${value}' is not present on the active timeline`);
      }
    }

    return errors;
  }

  private isReadOnlyToolName(toolName: string): boolean {
    const normalized = toolName.trim().toLowerCase();
    return READ_ONLY_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }

  private isPlaceholderId(value: string, key: string): boolean {
    if (ID_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
      return true;
    }

    if (
      key.toLowerCase().includes('track') &&
      TRACK_ALIAS_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      return true;
    }

    return false;
  }

  private rememberSessionStateVersion(sessionId: string, stateVersion: number): void {
    this.sessionStateVersions.set(sessionId, stateVersion);
    if (this.sessionStateVersions.size <= 200) {
      return;
    }

    const oldest = this.sessionStateVersions.keys().next().value;
    if (typeof oldest === 'string') {
      this.sessionStateVersions.delete(oldest);
    }
  }

  /**
   * Convert legacy tool to ToolInfo
   */
  private toToolInfo(tool: LegacyToolDef): ToolInfo {
    return {
      name: tool.name,
      description: tool.description,
      category: tool.category,
      riskLevel: CATEGORY_RISK_MAP[tool.category] ?? 'low',
      supportsUndo: this.isUndoable(tool),
      estimatedDuration: CATEGORY_DURATION_MAP[tool.category] ?? 'fast',
      parallelizable: this.isParallelizable(tool),
    };
  }

  /**
   * Convert legacy tool to full ToolDefinition
   */
  private toToolDefinition(tool: LegacyToolDef): ToolDefinition {
    return {
      ...this.toToolInfo(tool),
      parameters: tool.parameters as unknown as Record<string, unknown>,
      required: (tool.parameters as { required?: string[] }).required,
    };
  }

  /**
   * Infer side effects from tool category
   */
  private inferSideEffects(
    tool: LegacyToolDef | undefined,
    context: ExecutionContext,
  ): SideEffect[] | undefined {
    if (!tool) return undefined;

    const effects: SideEffect[] = [];

    switch (tool.category) {
      case 'timeline':
      case 'clip':
      case 'track':
      case 'effect':
      case 'transition':
      case 'audio':
        effects.push({
          type: 'modified',
          entity: 'sequence',
          entityId: context.sequenceId ?? context.projectId,
        });
        break;
      case 'export':
        effects.push({
          type: 'created',
          entity: 'export',
          entityId: context.sessionId,
        });
        break;
      case 'project':
        effects.push({
          type: 'modified',
          entity: 'project',
          entityId: context.projectId,
        });
        break;
      case 'generation':
        effects.push({
          type: 'created',
          entity: 'asset',
          entityId: context.sessionId,
        });
        break;
    }

    return effects.length > 0 ? effects : undefined;
  }

  /**
   * Determine if tool supports undo
   */
  private isUndoable(tool: LegacyToolDef | undefined): boolean {
    if (!tool) return false;

    // Most editing operations are undoable
    const undoableCategories = ['timeline', 'clip', 'track', 'effect', 'transition', 'audio'];
    return undoableCategories.includes(tool.category);
  }

  /**
   * Determine if tool can run in parallel
   */
  private isParallelizable(tool: LegacyToolDef): boolean {
    // Analysis tools can run in parallel
    // Most editing tools should run sequentially
    const parallelCategories = ['analysis', 'utility'];
    return parallelCategories.includes(tool.category);
  }

  /**
   * Validate parameter type
   */
  private validateType(
    name: string,
    value: unknown,
    schema: { type?: string; enum?: unknown[] },
  ): string | undefined {
    const actualType = typeof value;

    switch (schema.type) {
      case 'string':
        if (actualType !== 'string') {
          return `Parameter '${name}' must be a string, got ${actualType}`;
        }
        if (schema.enum && !schema.enum.includes(value)) {
          return `Parameter '${name}' must be one of: ${schema.enum.join(', ')}`;
        }
        break;

      case 'number':
      case 'integer':
        if (actualType !== 'number') {
          return `Parameter '${name}' must be a number, got ${actualType}`;
        }
        if (schema.type === 'integer' && !Number.isInteger(value)) {
          return `Parameter '${name}' must be an integer`;
        }
        break;

      case 'boolean':
        if (actualType !== 'boolean') {
          return `Parameter '${name}' must be a boolean, got ${actualType}`;
        }
        break;

      case 'array':
        if (!Array.isArray(value)) {
          return `Parameter '${name}' must be an array`;
        }
        break;

      case 'object':
        if (actualType !== 'object' || value === null || Array.isArray(value)) {
          return `Parameter '${name}' must be an object`;
        }
        break;
    }

    return undefined;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a ToolRegistryAdapter
 */
export function createToolRegistryAdapter(registry: ToolRegistry): ToolRegistryAdapter {
  return new ToolRegistryAdapter(registry);
}
