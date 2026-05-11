import type {
  AgentRuntimeReadiness,
  ExternalAgentAuthStatus,
  ExternalAgentRuntimeCapabilities,
  ExternalAgentRuntimeId,
  ExternalAgentRuntimeStatus,
} from './types';

export interface RuntimeReadinessInput {
  hostEnabled: boolean;
  adapterEnabled: boolean;
  status: ExternalAgentRuntimeStatus;
  capabilities: ExternalAgentRuntimeCapabilities;
}

export interface ExternalAgentHostSummaryInput {
  hostEnabled: boolean;
  runtimes: Array<{
    status: ExternalAgentRuntimeStatus;
    capabilities: ExternalAgentRuntimeCapabilities;
    adapterEnabled: boolean;
  }>;
}

export interface ExternalAgentRuntimeSummary {
  runtimeId: ExternalAgentRuntimeId;
  displayName: string;
  ready: boolean;
  reason: string | null;
  installStatus: ExternalAgentRuntimeStatus['installStatus'];
  authStatus: ExternalAgentAuthStatus;
  capabilities: ExternalAgentRuntimeCapabilities;
}

export interface ExternalAgentHostSummary {
  enabled: boolean;
  readyRuntimeCount: number;
  runtimes: ExternalAgentRuntimeSummary[];
}

export function getRuntimeReadiness(input: RuntimeReadinessInput): AgentRuntimeReadiness {
  if (!input.hostEnabled) {
    return { ready: false, reason: 'External Agent Host is disabled' };
  }

  if (!input.adapterEnabled) {
    return {
      ready: false,
      reason: `${input.status.displayName} adapter is disabled`,
    };
  }

  if (input.status.installStatus !== 'installed') {
    return {
      ready: false,
      reason: input.status.reason ?? `${input.status.displayName} is not installed`,
    };
  }

  if (!isAuthenticated(input.status.authStatus)) {
    return {
      ready: false,
      reason: input.status.reason ?? `${input.status.displayName} is not authenticated`,
    };
  }

  if (!input.capabilities.mcpClient && !input.capabilities.structuredToolCalls) {
    return {
      ready: false,
      reason: `${input.status.displayName} cannot access OpenReelio tools`,
    };
  }

  if (!input.status.available) {
    return {
      ready: false,
      reason: input.status.reason ?? `${input.status.displayName} is unavailable`,
    };
  }

  return { ready: true, reason: null };
}

export function isRuntimeReadyForUse(readiness: AgentRuntimeReadiness): boolean {
  return readiness.ready;
}

export function buildExternalAgentHostSummary(
  input: ExternalAgentHostSummaryInput
): ExternalAgentHostSummary {
  const runtimes = input.runtimes.map((runtime) => {
    const readiness = getRuntimeReadiness({
      hostEnabled: input.hostEnabled,
      adapterEnabled: runtime.adapterEnabled,
      status: runtime.status,
      capabilities: runtime.capabilities,
    });

    return {
      runtimeId: runtime.status.runtimeId,
      displayName: runtime.status.displayName,
      ready: readiness.ready,
      reason: readiness.reason,
      installStatus: runtime.status.installStatus,
      authStatus: runtime.status.authStatus,
      capabilities: runtime.capabilities,
    };
  });

  return {
    enabled: input.hostEnabled,
    readyRuntimeCount: runtimes.filter((runtime) => runtime.ready).length,
    runtimes,
  };
}

function isAuthenticated(authStatus: ExternalAgentAuthStatus): boolean {
  return authStatus === 'signed-in' || authStatus === 'api-key';
}
