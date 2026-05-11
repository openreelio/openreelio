import { describe, expect, it } from 'vitest';

import {
  buildExternalAgentHostSummary,
  getRuntimeReadiness,
  isRuntimeReadyForUse,
} from './host';
import type { ExternalAgentRuntimeCapabilities, ExternalAgentRuntimeStatus } from './types';

const codexCapabilities: ExternalAgentRuntimeCapabilities = {
  streamingEvents: true,
  interrupt: true,
  mcpClient: true,
  approvalAware: true,
  localAccountAuth: true,
  sessionResume: false,
  structuredToolCalls: true,
};

function status(
  overrides: Partial<ExternalAgentRuntimeStatus> = {}
): ExternalAgentRuntimeStatus {
  return {
    runtimeId: 'codex',
    displayName: 'Codex',
    installStatus: 'installed',
    authStatus: 'signed-in',
    available: true,
    version: '1.0.0',
    reason: null,
    ...overrides,
  };
}

describe('ExternalAgentHost readiness', () => {
  it('should report disabled when the host feature flag is off', () => {
    const readiness = getRuntimeReadiness({
      hostEnabled: false,
      adapterEnabled: true,
      status: status(),
      capabilities: codexCapabilities,
    });

    expect(readiness).toEqual({
      ready: false,
      reason: 'External Agent Host is disabled',
    });
  });

  it('should report unavailable when runtime is missing', () => {
    const readiness = getRuntimeReadiness({
      hostEnabled: true,
      adapterEnabled: true,
      status: status({
        installStatus: 'missing',
        available: false,
        reason: 'codex executable not found',
      }),
      capabilities: codexCapabilities,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe('codex executable not found');
  });

  it('should require an authenticated runtime before use', () => {
    const readiness = getRuntimeReadiness({
      hostEnabled: true,
      adapterEnabled: true,
      status: status({ authStatus: 'signed-out', available: false }),
      capabilities: codexCapabilities,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe('Codex is not authenticated');
  });

  it('should be ready when host and adapter are enabled and runtime is authenticated', () => {
    const readiness = getRuntimeReadiness({
      hostEnabled: true,
      adapterEnabled: true,
      status: status(),
      capabilities: codexCapabilities,
    });

    expect(readiness).toEqual({ ready: true, reason: null });
    expect(isRuntimeReadyForUse(readiness)).toBe(true);
  });

  it('should build a stable host summary for UI status surfaces', () => {
    const summary = buildExternalAgentHostSummary({
      hostEnabled: true,
      runtimes: [
        {
          status: status(),
          capabilities: codexCapabilities,
          adapterEnabled: true,
        },
      ],
    });

    expect(summary.enabled).toBe(true);
    expect(summary.readyRuntimeCount).toBe(1);
    expect(summary.runtimes[0]).toMatchObject({
      runtimeId: 'codex',
      displayName: 'Codex',
      ready: true,
      installStatus: 'installed',
      authStatus: 'signed-in',
    });
  });
});
