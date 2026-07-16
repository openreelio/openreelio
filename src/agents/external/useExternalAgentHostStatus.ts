import { useEffect, useRef, useState } from 'react';

import {
  isClaudeCodeAgentEnabled,
  isCodexAgentEnabled,
  isExternalAgentHostEnabled,
} from '@/config/featureFlags';

import type { CodexStatusProbe } from './adapters/CodexReferenceAdapter';
import type { ClaudeStatusProbe } from './adapters/ClaudeCodeAdapter';
import { buildExternalAgentHostSummary, type ExternalAgentHostSummary } from './host';
import type {
  ExternalAgentRuntimeCapabilities,
  ExternalAgentRuntimeId,
  ExternalAgentRuntimeStatus,
} from './types';

export const EXTERNAL_AGENT_STATUS_REFRESH_EVENT = 'openreelio:external-agent-status-refresh';

export interface UseExternalAgentHostStatusOptions {
  codexProbe?: CodexStatusProbe;
  claudeProbe?: ClaudeStatusProbe;
  hostEnabled?: boolean;
  codexEnabled?: boolean;
  claudeEnabled?: boolean;
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

const FALLBACK_CAPABILITIES: ExternalAgentRuntimeCapabilities = {
  streamingEvents: false,
  interrupt: false,
  mcpClient: false,
  approvalAware: false,
  localAccountAuth: false,
  sessionResume: false,
  structuredToolCalls: false,
};

interface RuntimeSummaryEntry {
  status: ExternalAgentRuntimeStatus;
  capabilities: ExternalAgentRuntimeCapabilities;
  adapterEnabled: boolean;
}

/** Minimal adapter surface this hook relies on for status probing. */
interface StatusProbeAdapter {
  readonly id: ExternalAgentRuntimeId;
  readonly displayName: string;
  detect(): Promise<ExternalAgentRuntimeStatus>;
  capabilities(): Promise<ExternalAgentRuntimeCapabilities>;
}

function placeholderStatus(
  runtimeId: ExternalAgentRuntimeId,
  displayName: string,
  authStatus: ExternalAgentRuntimeStatus['authStatus'],
  reason: string | null,
): ExternalAgentRuntimeStatus {
  return {
    runtimeId,
    displayName,
    installStatus: 'unknown',
    authStatus,
    available: false,
    version: null,
    reason,
  };
}

/**
 * Probe a single runtime. Adapters (and their heavy tool definitions) are only
 * imported when that runtime is the enabled/selected one; otherwise a
 * placeholder entry is returned so the summary still lists the runtime.
 */
async function buildRuntimeEntry(params: {
  runtimeId: ExternalAgentRuntimeId;
  displayName: string;
  hostEnabled: boolean;
  adapterEnabled: boolean;
  loadAdapter: () => Promise<StatusProbeAdapter>;
}): Promise<RuntimeSummaryEntry> {
  const { runtimeId, displayName, hostEnabled, adapterEnabled } = params;

  if (!adapterEnabled) {
    return {
      status: placeholderStatus(runtimeId, displayName, 'unknown', null),
      capabilities: FALLBACK_CAPABILITIES,
      adapterEnabled: false,
    };
  }

  try {
    const adapter = await params.loadAdapter();
    const capabilities = await adapter.capabilities();
    const status = hostEnabled
      ? await adapter.detect()
      : placeholderStatus(adapter.id, adapter.displayName, 'unknown', null);
    return { status, capabilities, adapterEnabled: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: placeholderStatus(runtimeId, displayName, 'error', message),
      capabilities: FALLBACK_CAPABILITIES,
      adapterEnabled: true,
    };
  }
}

export function useExternalAgentHostStatus(
  options: UseExternalAgentHostStatusOptions = {},
): UseExternalAgentHostStatusResult {
  const hostEnabled = options.hostEnabled ?? isExternalAgentHostEnabled();
  const codexEnabled = options.codexEnabled ?? isCodexAgentEnabled();
  const claudeEnabled = options.claudeEnabled ?? isClaudeCodeAgentEnabled();
  const codexProbeRef = useRef(options.codexProbe);
  const claudeProbeRef = useRef(options.claudeProbe);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<ExternalAgentHostSummary>(EMPTY_SUMMARY);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    codexProbeRef.current = options.codexProbe;
  }, [options.codexProbe]);

  useEffect(() => {
    claudeProbeRef.current = options.claudeProbe;
  }, [options.claudeProbe]);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      setLoading(true);

      // The runtimes are independent — probe them in parallel so a slow or
      // missing CLI for one runtime never delays the other's status.
      const codexEntryPromise = buildRuntimeEntry({
        runtimeId: 'codex',
        displayName: 'Codex',
        hostEnabled,
        adapterEnabled: codexEnabled,
        loadAdapter: async () => {
          const { CodexReferenceAdapter } = await import('./adapters/CodexReferenceAdapter');
          return new CodexReferenceAdapter(codexProbeRef.current);
        },
      });

      const claudeEntryPromise = claudeEnabled
        ? buildRuntimeEntry({
            runtimeId: 'claude_code',
            displayName: 'Claude Code',
            hostEnabled,
            adapterEnabled: claudeEnabled,
            loadAdapter: async () => {
              const { ClaudeCodeAdapter } = await import('./adapters/ClaudeCodeAdapter');
              return new ClaudeCodeAdapter(claudeProbeRef.current);
            },
          })
        : null;

      const [codexEntry, claudeEntry] = await Promise.all([
        codexEntryPromise,
        claudeEntryPromise,
      ]);

      const runtimes: RuntimeSummaryEntry[] = [codexEntry];
      if (claudeEntry) {
        runtimes.push(claudeEntry);
      }

      if (cancelled) {
        return;
      }

      setSummary(buildExternalAgentHostSummary({ hostEnabled, runtimes }));
      setLoading(false);
    }

    void refresh();

    return () => {
      cancelled = true;
    };
  }, [codexEnabled, claudeEnabled, hostEnabled, refreshNonce]);

  useEffect(() => {
    const refresh = () => setRefreshNonce((value) => value + 1);
    window.addEventListener(EXTERNAL_AGENT_STATUS_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(EXTERNAL_AGENT_STATUS_REFRESH_EVENT, refresh);
  }, []);

  return { loading, summary };
}
