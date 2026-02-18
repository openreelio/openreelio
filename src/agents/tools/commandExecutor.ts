/**
 * Agent Tool Command Executor
 *
 * Executes backend edit commands with store synchronization when a project
 * is actively loaded. In non-project contexts (unit tests, early bootstrap),
 * it falls back to direct IPC execution.
 */

import { invoke } from '@tauri-apps/api/core';
import type { CommandResult, CommandType } from '@/types';
import { useProjectStore } from '@/stores/projectStore';

export async function executeAgentCommand(
  commandType: string,
  payload: Record<string, unknown>,
): Promise<CommandResult> {
  const project = useProjectStore.getState();

  if (project.isLoaded && project.meta) {
    return project.executeCommand({
      type: commandType as CommandType,
      payload,
    });
  }

  return invoke<CommandResult>('execute_command', {
    commandType,
    payload,
  });
}
