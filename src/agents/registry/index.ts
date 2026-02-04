/**
 * Agent Registry Module
 *
 * Exports registry-related functionality including tool metadata and undo operations.
 */

// Tool metadata
export {
  createToolMetadata,
  requiresApproval,
  getRiskIndicator,
  canRunInParallel,
  getCombinedRiskLevel,
  filterToolsByMetadata,
  DEFAULT_TOOL_METADATA,
  HIGH_RISK_METADATA,
  TIMELINE_AFFECTING_METADATA,
  type ToolMetadata,
  type RiskLevel,
  type ExecutionDuration,
} from './ToolMetadata';

// Undo registry
export {
  UndoRegistry,
  createUndoRegistry,
  moveClipUndoGenerator,
  deleteClipUndoGenerator,
  insertClipUndoGenerator,
  type UndoOperation,
  type InverseOperation,
  type UndoGenerator,
  type UndoRegistryConfig,
} from './UndoRegistry';
