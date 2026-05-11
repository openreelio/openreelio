import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { setFeatureFlag, resetFeatureFlags } from '@/config/featureFlags';
import { useExternalAgentHostStatus } from './useExternalAgentHostStatus';
import type { ExternalAgentHostSummary, ExternalAgentRuntimeSummary } from './host';

function findRuntime(
  summary: ExternalAgentHostSummary,
  runtimeId: string,
): ExternalAgentRuntimeSummary {
  const runtime = summary.runtimes.find((candidate) => candidate.runtimeId === runtimeId);
  if (!runtime) {
    throw new Error(`Expected ${runtimeId} runtime summary`);
  }
  return runtime;
}

describe('useExternalAgentHostStatus', () => {
  beforeEach(() => {
    resetFeatureFlags();
  });

  it('should return a disabled summary by default', async () => {
    const { result } = renderHook(() =>
      useExternalAgentHostStatus({
        codexProbe: async () => ({
          installed: true,
          authStatus: 'signed-in',
        }),
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.summary).toMatchObject({
      enabled: false,
      readyRuntimeCount: 0,
    });
    expect(findRuntime(result.current.summary, 'codex')).toMatchObject({
      runtimeId: 'codex',
      ready: false,
      reason: 'External Agent Host is disabled',
    });
  });

  it('should report Codex ready when host and adapter flags are enabled', async () => {
    setFeatureFlag('USE_EXTERNAL_AGENT_HOST', true);
    setFeatureFlag('USE_CODEX_AGENT', true);

    const { result } = renderHook(() =>
      useExternalAgentHostStatus({
        codexProbe: async () => ({
          installed: true,
          version: '0.50.0',
          authStatus: 'signed-in',
        }),
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.summary.enabled).toBe(true);
    expect(result.current.summary.readyRuntimeCount).toBe(1);
    expect(findRuntime(result.current.summary, 'codex')).toMatchObject({
      runtimeId: 'codex',
      displayName: 'Codex',
      ready: true,
      installStatus: 'installed',
      authStatus: 'signed-in',
    });
  });

  it('should report Codex ready when enabled by runtime settings without feature flags', async () => {
    const { result } = renderHook(() =>
      useExternalAgentHostStatus({
        hostEnabled: true,
        codexEnabled: true,
        codexProbe: async () => ({
          installed: true,
          version: '0.50.0',
          authStatus: 'signed-in',
        }),
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.summary.enabled).toBe(true);
    expect(result.current.summary.readyRuntimeCount).toBe(1);
    expect(findRuntime(result.current.summary, 'codex')).toMatchObject({
      runtimeId: 'codex',
      ready: true,
      authStatus: 'signed-in',
    });
  });

  it('should stop loading and expose a failed Codex summary when probing rejects', async () => {
    const { result } = renderHook(() =>
      useExternalAgentHostStatus({
        hostEnabled: true,
        codexEnabled: true,
        codexProbe: async () => {
          throw new Error('probe failed');
        },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.summary.enabled).toBe(true);
    expect(result.current.summary.readyRuntimeCount).toBe(0);
    expect(findRuntime(result.current.summary, 'codex')).toMatchObject({
      runtimeId: 'codex',
      ready: false,
      authStatus: 'error',
      reason: 'probe failed',
    });
  });
});
