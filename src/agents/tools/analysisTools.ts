/**
 * Analysis Tools
 *
 * Timeline analysis tools for the AI agent system.
 * Provides read-only operations to query timeline state.
 *
 * These tools read from Zustand stores (frontend state) instead of calling
 * backend IPC handlers. The data is already available in projectStore,
 * timelineStore, and playbackStore.
 *
 * This module is a thin barrel: the tool definitions and their helpers live in
 * the `analysis/` submodules, grouped by category for navigability.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { ASSET_TOOLS } from './analysis/assetTools';
import { TIMELINE_TOOLS } from './analysis/timelineTools';
import { CLIP_ANALYSIS_TOOLS } from './analysis/clipAnalysisTools';
import { WORKSPACE_TOOLS } from './analysis/workspaceTools';
import { SOURCE_REPORT_TOOLS } from './analysis/sourceReportTools';

const logger = createLogger('AnalysisTools');

const ANALYSIS_TOOLS: ToolDefinition[] = [
  ...ASSET_TOOLS,
  ...TIMELINE_TOOLS,
  ...CLIP_ANALYSIS_TOOLS,
  ...WORKSPACE_TOOLS,
  ...SOURCE_REPORT_TOOLS,
];

// =============================================================================
// Registration Functions
// =============================================================================

/**
 * Register all analysis tools with the global registry.
 */
export function registerAnalysisTools(): void {
  globalToolRegistry.registerMany(ANALYSIS_TOOLS);
  logger.info('Analysis tools registered', { count: ANALYSIS_TOOLS.length });
}

/**
 * Unregister all analysis tools from the global registry.
 */
export function unregisterAnalysisTools(): void {
  for (const tool of ANALYSIS_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Analysis tools unregistered', { count: ANALYSIS_TOOLS.length });
}

/**
 * Get the list of analysis tool names.
 */
export function getAnalysisToolNames(): string[] {
  return ANALYSIS_TOOLS.map((t) => t.name);
}
