/**
 * Tool Metadata
 *
 * Extended metadata for tools including approval requirements, risk levels,
 * and undo capabilities.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Risk level classification for tools.
 */
export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * Estimated execution duration.
 */
export type ExecutionDuration = 'instant' | 'fast' | 'slow';

/**
 * Extended metadata for a tool.
 */
export interface ToolMetadata {
  /** Whether the tool requires user confirmation before execution */
  needsApproval: boolean;
  /** Risk level of the operation */
  riskLevel: RiskLevel;
  /** Whether the tool supports undo operations */
  supportsUndo: boolean;
  /** Estimated execution duration */
  estimatedDuration: ExecutionDuration;
  /** Whether the tool affects the timeline state */
  affectsTimeline: boolean;
  /** Whether multiple calls can run in parallel */
  parallelizable: boolean;
  /** Optional category tags for filtering */
  tags?: string[];
  /** Optional human-readable warning message */
  warningMessage?: string;
}

/**
 * Default metadata for tools without explicit configuration.
 */
export const DEFAULT_TOOL_METADATA: ToolMetadata = {
  needsApproval: false,
  riskLevel: 'low',
  supportsUndo: false,
  estimatedDuration: 'instant',
  affectsTimeline: false,
  parallelizable: true,
  tags: [],
};

/**
 * High-risk metadata preset for destructive operations.
 */
export const HIGH_RISK_METADATA: Partial<ToolMetadata> = {
  needsApproval: true,
  riskLevel: 'high',
  warningMessage: 'This operation cannot be easily undone.',
};

/**
 * Timeline-affecting metadata preset.
 */
export const TIMELINE_AFFECTING_METADATA: Partial<ToolMetadata> = {
  affectsTimeline: true,
  supportsUndo: true,
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create tool metadata by merging with defaults.
 *
 * @param partial - Partial metadata to merge
 * @returns Complete ToolMetadata
 */
export function createToolMetadata(
  partial: Partial<ToolMetadata> = {}
): ToolMetadata {
  return {
    ...DEFAULT_TOOL_METADATA,
    ...partial,
  };
}

/**
 * Check if a tool requires approval based on its metadata.
 *
 * @param metadata - Tool metadata
 * @returns Whether approval is required
 */
export function requiresApproval(metadata: ToolMetadata): boolean {
  return metadata.needsApproval || metadata.riskLevel === 'high';
}

/**
 * Get a display-friendly risk indicator.
 *
 * @param level - Risk level
 * @returns Risk indicator string
 */
export function getRiskIndicator(level: RiskLevel): string {
  switch (level) {
    case 'low':
      return 'Low Risk';
    case 'medium':
      return 'Medium Risk';
    case 'high':
      return 'High Risk - Requires Approval';
    default:
      return 'Unknown Risk';
  }
}

/**
 * Check if multiple tools can be executed in parallel.
 *
 * @param metadataList - List of tool metadata
 * @returns Whether all tools can run in parallel
 */
export function canRunInParallel(metadataList: ToolMetadata[]): boolean {
  return metadataList.every((m) => m.parallelizable);
}

/**
 * Calculate combined risk level for multiple tools.
 *
 * @param metadataList - List of tool metadata
 * @returns Highest risk level among all tools
 */
export function getCombinedRiskLevel(metadataList: ToolMetadata[]): RiskLevel {
  const riskOrder: RiskLevel[] = ['low', 'medium', 'high'];
  let maxRiskIndex = 0;

  for (const metadata of metadataList) {
    const index = riskOrder.indexOf(metadata.riskLevel);
    if (index > maxRiskIndex) {
      maxRiskIndex = index;
    }
  }

  return riskOrder[maxRiskIndex];
}

/**
 * Filter tools by metadata criteria.
 *
 * @param tools - Map of tool names to metadata
 * @param filter - Filter criteria
 * @returns Filtered tool names
 */
export function filterToolsByMetadata(
  tools: Map<string, ToolMetadata>,
  filter: Partial<ToolMetadata>
): string[] {
  const result: string[] = [];

  for (const [name, metadata] of tools) {
    let matches = true;

    if (filter.needsApproval !== undefined && metadata.needsApproval !== filter.needsApproval) {
      matches = false;
    }
    if (filter.riskLevel !== undefined && metadata.riskLevel !== filter.riskLevel) {
      matches = false;
    }
    if (filter.supportsUndo !== undefined && metadata.supportsUndo !== filter.supportsUndo) {
      matches = false;
    }
    if (filter.affectsTimeline !== undefined && metadata.affectsTimeline !== filter.affectsTimeline) {
      matches = false;
    }
    if (filter.parallelizable !== undefined && metadata.parallelizable !== filter.parallelizable) {
      matches = false;
    }

    if (matches) {
      result.push(name);
    }
  }

  return result;
}
