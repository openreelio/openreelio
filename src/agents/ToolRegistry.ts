/**
 * Tool Registry
 *
 * Manages agent tools with registration, validation, and execution.
 * Provides tool schemas for AI function calling.
 */

import type { AgentContext, AgentTool, JsonSchema } from './Agent';
import { createLogger } from '@/services/logger';

const logger = createLogger('ToolRegistry');

// =============================================================================
// Types
// =============================================================================

/** Tool categories for organization */
export type ToolCategory =
  | 'timeline'
  | 'clip'
  | 'track'
  | 'effect'
  | 'transition'
  | 'audio'
  | 'export'
  | 'project'
  | 'analysis'
  | 'utility';

/** Handler function for a tool */
export type ToolHandler = (
  args: Record<string, unknown>,
  context: AgentContext
) => Promise<ToolExecutionResult>;

/** Full tool definition with handler */
export interface ToolDefinition {
  /** The name of the tool */
  name: string;
  /** A description of what the tool does */
  description: string;
  /** The category of the tool */
  category: ToolCategory;
  /** JSON Schema for the tool's parameters */
  parameters: JsonSchema;
  /** The handler function to execute the tool */
  handler: ToolHandler;
}

/** Result of executing a tool */
export interface ToolExecutionResult {
  /** Whether the execution succeeded */
  success: boolean;
  /** The result data (if successful) */
  result?: unknown;
  /** Error message (if failed) */
  error?: string;
}

/** AI function schema (for LLM function calling) */
export interface AIFunctionSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

// =============================================================================
// Tool Registry
// =============================================================================

/**
 * Registry for managing agent tools.
 *
 * Features:
 * - Tool registration and unregistration
 * - Tool execution with validation
 * - Category-based organization
 * - AI function schema export
 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  // ===========================================================================
  // Registration
  // ===========================================================================

  /**
   * Register a tool.
   *
   * @param tool - The tool definition to register
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    logger.debug('Tool registered', { name: tool.name, category: tool.category });
  }

  /**
   * Register multiple tools at once.
   *
   * @param tools - The tool definitions to register
   */
  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Unregister a tool.
   *
   * @param name - The name of the tool to unregister
   */
  unregister(name: string): void {
    this.tools.delete(name);
    logger.debug('Tool unregistered', { name });
  }

  /**
   * Clear all registered tools.
   */
  clear(): void {
    this.tools.clear();
    logger.debug('All tools cleared');
  }

  // ===========================================================================
  // Lookup
  // ===========================================================================

  /**
   * Check if a tool is registered.
   *
   * @param name - The tool name
   * @returns True if the tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get a tool by name.
   *
   * @param name - The tool name
   * @returns The tool definition, or undefined if not found
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * List all registered tools.
   *
   * @returns Array of all tool definitions
   */
  listAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * List tools by category.
   *
   * @param category - The category to filter by
   * @returns Array of tool definitions in the category
   */
  listByCategory(category: ToolCategory): ToolDefinition[] {
    return this.listAll().filter((tool) => tool.category === category);
  }

  /**
   * List all categories that have registered tools.
   *
   * @returns Array of unique categories
   */
  listCategories(): ToolCategory[] {
    const categories = new Set<ToolCategory>();
    for (const tool of this.tools.values()) {
      categories.add(tool.category);
    }
    return Array.from(categories);
  }

  // ===========================================================================
  // Execution
  // ===========================================================================

  /**
   * Execute a tool with the given arguments.
   *
   * @param name - The tool name
   * @param args - The arguments to pass to the tool
   * @param context - Optional agent context
   * @returns The execution result
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: AgentContext = {}
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        success: false,
        error: `Tool '${name}' not found`,
      };
    }

    // Validate parameters
    const validationError = this.validateParameters(tool.parameters, args);
    if (validationError) {
      return {
        success: false,
        error: validationError,
      };
    }

    try {
      const result = await tool.handler(args, context);
      logger.debug('Tool executed', { name, success: result.success });
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Tool execution failed', { name, error: errorMessage });
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  // ===========================================================================
  // AI Function Schemas
  // ===========================================================================

  /**
   * Get AI function schemas for all registered tools.
   * These can be passed to LLM function calling APIs.
   *
   * @returns Array of function schemas
   */
  getAIFunctionSchemas(): AIFunctionSchema[] {
    return this.listAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * Convert a tool to an AgentTool (for Agent class compatibility).
   *
   * @param name - The tool name
   * @returns The AgentTool, or undefined if not found
   */
  toAgentTool(name: string): AgentTool | undefined {
    const tool = this.get(name);
    if (!tool) return undefined;

    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  /**
   * Convert all tools to AgentTools.
   *
   * @returns Array of AgentTools
   */
  toAgentTools(): AgentTool[] {
    return this.listAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  // ===========================================================================
  // Validation
  // ===========================================================================

  /**
   * Validate parameters against a JSON Schema.
   *
   * @param schema - The parameter schema
   * @param args - The arguments to validate
   * @returns Error message if validation fails, undefined if valid
   */
  private validateParameters(
    schema: JsonSchema,
    args: Record<string, unknown>
  ): string | undefined {
    // Check required parameters
    if (schema.required) {
      for (const required of schema.required) {
        if (!(required in args) || args[required] === undefined) {
          return `Missing required parameter: '${required}'`;
        }
      }
    }

    // Check parameter types
    if (schema.properties) {
      for (const [key, value] of Object.entries(args)) {
        const propSchema = schema.properties[key];
        if (!propSchema) continue;

        const typeError = this.validateType(key, value, propSchema);
        if (typeError) return typeError;
      }
    }

    return undefined;
  }

  /**
   * Validate a value against a type.
   *
   * @param name - The parameter name
   * @param value - The value to validate
   * @param schema - The schema to validate against
   * @returns Error message if validation fails, undefined if valid
   */
  private validateType(
    name: string,
    value: unknown,
    schema: JsonSchema
  ): string | undefined {
    const actualType = typeof value;

    switch (schema.type) {
      case 'string':
        if (actualType !== 'string') {
          return `Parameter '${name}' must be a string, got ${actualType}`;
        }
        // Check enum
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
// Singleton Instance
// =============================================================================

/** Global tool registry instance */
export const globalToolRegistry = new ToolRegistry();
