/**
 * Project Mutation Gateway
 *
 * Frontend entry point for project/timeline mutations. Production code should
 * use this module instead of calling `execute_command` or project-mutating IPC
 * endpoints directly so the project store can serialize mutations and refresh
 * its Rust-owned projection consistently.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Command, CommandResult } from '@/types';

export interface ProjectBackendMutationOptions {
  /** Refresh the project projection after the backend mutation completes. */
  refreshProjectState?: boolean;
  /** Mark the project dirty when the mutation succeeds. */
  markDirty?: boolean;
  /** Operation timeout in milliseconds for long-running backend mutations. */
  timeoutMs?: number;
}

interface ProjectMutationExecutor {
  executeCommand: (command: Command) => Promise<CommandResult>;
  executeCommandByType: (commandType: string, payload: unknown) => Promise<CommandResult>;
  executeBackendMutation: <T>(
    operationName: string,
    mutation: () => Promise<T>,
    options?: ProjectBackendMutationOptions,
  ) => Promise<T>;
}

let executor: ProjectMutationExecutor | null = null;

export function configureProjectMutationGateway(nextExecutor: ProjectMutationExecutor): void {
  executor = nextExecutor;
}

/**
 * Test-only reset hook. Production code should never clear the registered executor.
 */
export function _resetProjectMutationGatewayForTesting(): void {
  executor = null;
}

export async function executeProjectCommand(command: Command): Promise<CommandResult> {
  if (executor) {
    return executor.executeCommand(command);
  }

  return executeProjectCommandByType(command.type, command.payload);
}

export async function executeProjectCommandByType(
  commandType: string,
  payload: unknown,
): Promise<CommandResult> {
  if (executor) {
    return executor.executeCommandByType(commandType, payload);
  }

  return invoke<CommandResult>('execute_command', { commandType, payload });
}

export async function runProjectBackendMutation<T>(
  operationName: string,
  mutation: () => Promise<T>,
  options?: ProjectBackendMutationOptions,
): Promise<T> {
  if (executor) {
    return executor.executeBackendMutation(operationName, mutation, options);
  }

  return mutation();
}
