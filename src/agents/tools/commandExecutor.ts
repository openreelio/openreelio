/**
 * Agent Tool Command Executor
 *
 * Executes backend edit commands through the project store when a project
 * is actively loaded. Throws an explicit error when no project is loaded,
 * as editing tools require project context to function correctly.
 */

import type { CommandResult, CommandType } from '@/types';
import { useProjectStore } from '@/stores/projectStore';

export async function executeAgentCommand(
  commandType: string,
  payload: Record<string, unknown>,
): Promise<CommandResult> {
  const project = useProjectStore.getState();

  if (!project.isLoaded || !project.meta) {
    console.warn(
      `[executeAgentCommand] Rejected "${commandType}": no project is loaded`,
    );
    throw new Error(
      `Cannot execute agent command "${commandType}": no project is loaded. Open or create a project first.`,
    );
  }

  console.warn(
    `[executeAgentCommand] Executing "${commandType}" via projectStore`,
  );
  return project.executeCommand({
    type: commandType as CommandType,
    payload,
  });
}
