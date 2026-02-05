/**
 * Adapters Index
 *
 * Exports all adapters for the Agentic Engine.
 */

// =============================================================================
// LLM Adapters
// =============================================================================

// Mock adapter for testing
export {
  MockLLMAdapter,
  createMockLLMAdapter,
  createMockLLMAdapterWithResponses,
  type MockResponse,
  type CapturedRequest,
} from './llm/MockLLMAdapter';

// Tauri backend adapter
export {
  TauriLLMAdapter,
  createTauriLLMAdapter,
  type TauriLLMAdapterConfig,
} from './llm/TauriLLMAdapter';

// =============================================================================
// Tool Adapters
// =============================================================================

// Mock executor for testing
export {
  MockToolExecutor,
  createMockToolExecutor,
  createMockToolExecutorWithVideoTools,
  type MockToolConfig,
  type CapturedExecution,
} from './tools/MockToolExecutor';

// Bridge to existing ToolRegistry
export {
  ToolRegistryAdapter,
  createToolRegistryAdapter,
} from './tools/ToolRegistryAdapter';
