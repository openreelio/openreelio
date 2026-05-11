import { useEffect, useRef, useState } from 'react';

import { isCodexAgentEnabled, isExternalAgentHostEnabled } from '@/config/featureFlags';

import { CodexReferenceAdapter, type CodexStatusProbe } from './adapters/CodexReferenceAdapter';
import { buildExternalAgentHostSummary, type ExternalAgentHostSummary } from './host';
import type { ExternalAgentRuntimeCapabilities, ExternalAgentRuntimeStatus } from './types';

export const EXTERNAL_AGENT_STATUS_REFRESH_EVENT = 'openreelio:external-agent-status-refresh';

export interface UseExternalAgentHostStatusOptions {
  codexProbe?: CodexStatusProbe;
  hostEnabled?: boolean;
  codexEnabled?: boolean;
}

export interface UseExternalAgentHostStatusResult {
  loading: boolean;
  summary: ExternalAgentHostSummary;
}

const EMPTY_SUMMARY: ExternalAgentHostSummary = {
  enabled: false,
  readyRuntimeCount: 0,
  runtimes: [],
};

const FALLBACK_CODEX_CAPABILITIES: ExternalAgentRuntimeCapabilities = {
  streamingEvents: false,
  interrupt: false,
  mcpClient: false,
  approvalAware: false,
  localAccountAuth: false,
  sessionResume: false,
  structuredToolCalls: false,
};

export function useExternalAgentHostStatus(
  options: UseExternalAgentHostStatusOptions = {},
): UseExternalAgentHostStatusResult {
  const hostEnabled = options.hostEnabled ?? isExternalAgentHostEnabled();
  const codexEnabled = options.codexEnabled ?? isCodexAgentEnabled();
  const codexProbeRef = useRef(options.codexProbe);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<ExternalAgentHostSummary>(EMPTY_SUMMARY);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    codexProbeRef.current = options.codexProbe;
  }, [options.codexProbe]);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      setLoading(true);
      const codexAdapter = new CodexReferenceAdapter(codexProbeRef.current);
      try {
        const codexCapabilities = await codexAdapter.capabilities();
        const codexStatus =
          hostEnabled && codexEnabled
            ? await codexAdapter.detect()
            : {
                runtimeId: codexAdapter.id,
                displayName: codexAdapter.displayName,
                installStatus: 'unknown' as const,
                authStatus: 'unknown' as const,
                available: false,
                version: null,
                reason: null,
              };

        if (cancelled) {
          return;
        }

        setSummary(
          buildExternalAgentHostSummary({
            hostEnabled,
            runtimes: [
              {
                status: codexStatus,
                capabilities: codexCapabilities,
                adapterEnabled: codexEnabled,
              },
            ],
          }),
        );
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        const fallbackStatus: ExternalAgentRuntimeStatus = {
          runtimeId: codexAdapter.id,
          displayName: codexAdapter.displayName,
          installStatus: 'unknown',
          authStatus: 'error',
          available: false,
          version: null,
          reason: message,
        };

        setSummary(
          buildExternalAgentHostSummary({
            hostEnabled,
            runtimes: [
              {
                status: fallbackStatus,
                capabilities: FALLBACK_CODEX_CAPABILITIES,
                adapterEnabled: codexEnabled,
              },
            ],
          }),
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void refresh();

    return () => {
      cancelled = true;
    };
  }, [codexEnabled, hostEnabled, refreshNonce]);

  useEffect(() => {
    const refresh = () => setRefreshNonce((value) => value + 1);
    window.addEventListener(EXTERNAL_AGENT_STATUS_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(EXTERNAL_AGENT_STATUS_REFRESH_EVENT, refresh);
  }, []);

  return { loading, summary };
}
