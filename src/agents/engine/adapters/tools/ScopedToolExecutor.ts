import type {
  BatchExecutionRequest,
  BatchExecutionResult,
  ExecutionContext,
  IToolExecutor,
  ToolDefinition,
  ToolExecutionResult,
  ToolInfo,
} from '../../ports/IToolExecutor';
import type { RiskLevel, ValidationResult } from '../../core/types';

function createToolBlockedResult(toolName: string): ToolExecutionResult {
  return {
    success: false,
    error: `Tool '${toolName}' is not available in the active agent profile.`,
    duration: 0,
    undoable: false,
  };
}

export class ScopedToolExecutor implements IToolExecutor {
  constructor(
    private readonly baseExecutor: IToolExecutor,
    private readonly allowedToolNames: ReadonlySet<string>,
  ) {}

  private isAllowed(toolName: string): boolean {
    return this.allowedToolNames.has(toolName);
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.isAllowed(toolName)) {
      return createToolBlockedResult(toolName);
    }

    return this.baseExecutor.execute(toolName, args, context);
  }

  async executeBatch(
    request: BatchExecutionRequest,
    context: ExecutionContext,
  ): Promise<BatchExecutionResult> {
    if (
      request.tools.every((tool) => this.isAllowed(tool.name)) &&
      request.mode === 'sequential' &&
      typeof this.baseExecutor.canExecuteBatchAtomically === 'function' &&
      this.baseExecutor.canExecuteBatchAtomically(request)
    ) {
      return this.baseExecutor.executeBatch(request, context);
    }

    const results =
      request.mode === 'parallel'
        ? await Promise.all(
            request.tools.map(async (tool) => ({
              tool: tool.name,
              result: await this.execute(tool.name, tool.args, context),
            })),
          )
        : await this.executeSequentially(request, context);

    const successCount = results.filter((entry) => entry.result.success).length;
    const failureCount = results.length - successCount;

    return {
      success: failureCount === 0,
      results,
      totalDuration: results.reduce((total, entry) => total + entry.result.duration, 0),
      successCount,
      failureCount,
    };
  }

  private async executeSequentially(
    request: BatchExecutionRequest,
    context: ExecutionContext,
  ): Promise<Array<{ tool: string; result: ToolExecutionResult }>> {
    const results: Array<{ tool: string; result: ToolExecutionResult }> = [];

    for (const tool of request.tools) {
      const result = await this.execute(tool.name, tool.args, context);
      results.push({ tool: tool.name, result });

      if (!result.success && request.stopOnError) {
        break;
      }
    }

    return results;
  }

  canExecuteBatchAtomically(request: BatchExecutionRequest): boolean {
    return (
      request.tools.every((tool) => this.isAllowed(tool.name)) &&
      typeof this.baseExecutor.canExecuteBatchAtomically === 'function' &&
      this.baseExecutor.canExecuteBatchAtomically(request)
    );
  }

  getAvailableTools(category?: string): ToolInfo[] {
    return this.baseExecutor
      .getAvailableTools(category)
      .filter((tool) => this.isAllowed(tool.name));
  }

  getToolDefinition(name: string): ToolDefinition | null {
    if (!this.isAllowed(name)) {
      return null;
    }

    return this.baseExecutor.getToolDefinition(name);
  }

  validateArgs(toolName: string, args: Record<string, unknown>): ValidationResult {
    if (!this.isAllowed(toolName)) {
      return {
        valid: false,
        errors: [`Tool '${toolName}' is not available in the active agent profile.`],
      };
    }

    return this.baseExecutor.validateArgs(toolName, args);
  }

  hasTool(name: string): boolean {
    return this.isAllowed(name) && this.baseExecutor.hasTool(name);
  }

  getToolsByCategory(): Map<string, ToolInfo[]> {
    const scoped = new Map<string, ToolInfo[]>();

    for (const [category, tools] of this.baseExecutor.getToolsByCategory()) {
      const filtered = tools.filter((tool) => this.isAllowed(tool.name));
      if (filtered.length > 0) {
        scoped.set(category, filtered);
      }
    }

    return scoped;
  }

  getToolsByRisk(maxRisk: RiskLevel): ToolInfo[] {
    return this.baseExecutor.getToolsByRisk(maxRisk).filter((tool) => this.isAllowed(tool.name));
  }
}

export function createScopedToolExecutor(
  baseExecutor: IToolExecutor,
  allowedToolNames: ReadonlySet<string>,
): ScopedToolExecutor {
  return new ScopedToolExecutor(baseExecutor, allowedToolNames);
}
