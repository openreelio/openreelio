import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  _resetProjectMutationGatewayForTesting,
  configureProjectMutationGateway,
  executeProjectCommandByType,
  runProjectBackendMutation,
} from './projectMutationGateway';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

describe('projectMutationGateway', () => {
  afterEach(() => {
    _resetProjectMutationGatewayForTesting();
    vi.clearAllMocks();
  });

  it('should fallback to execute_command IPC when no project executor is registered', async () => {
    mockedInvoke.mockResolvedValueOnce({
      opId: 'op-1',
      changes: [],
      createdIds: [],
      deletedIds: [],
    });

    const result = await executeProjectCommandByType('AddMask', { effectId: 'effect-1' });

    expect(result.opId).toBe('op-1');
    expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
      commandType: 'AddMask',
      payload: { effectId: 'effect-1' },
    });
  });

  it('should route mutations through the registered project executor', async () => {
    const executeBackendMutation = vi.fn(async (_name, mutation) => mutation());
    configureProjectMutationGateway({
      executeCommand: vi.fn(),
      executeCommandByType: vi.fn(),
      executeBackendMutation,
    });

    const result = await runProjectBackendMutation('customMutation', async () => 'ok');

    expect(result).toBe('ok');
    expect(executeBackendMutation).toHaveBeenCalledWith(
      'customMutation',
      expect.any(Function),
      undefined,
    );
  });
});
