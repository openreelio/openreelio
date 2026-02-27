/**
 * TraceWriter — Writes agent traces to the project's trace directory.
 *
 * Traces are written as JSON files to `{project}/.openreelio/traces/{traceId}.json`.
 * Implements rotation to keep at most MAX_TRACE_FILES per project.
 *
 * Uses a dedicated Tauri IPC command (`write_agent_trace`) for file operations.
 * If the command is not available, fails silently with a warning log.
 */

import { invoke } from '@tauri-apps/api/core';
import type { AgentTrace } from './traceRecorder';
import { createLogger } from '@/services/logger';

const logger = createLogger('TraceWriter');

/** Maximum trace files per project before rotation */
export const MAX_TRACE_FILES = 100;

/**
 * Write a trace to the project's trace directory via backend IPC.
 * Automatically handles directory creation and rotation on the backend.
 *
 * Fails silently if the IPC command is not available.
 */
export async function writeTrace(trace: AgentTrace): Promise<void> {
  try {
    await invoke('write_agent_trace', {
      traceJson: JSON.stringify(trace),
      traceId: trace.traceId,
      maxFiles: MAX_TRACE_FILES,
    });

    logger.info('Trace written', { traceId: trace.traceId });
  } catch (error) {
    logger.warn('Failed to write trace file', {
      traceId: trace.traceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
