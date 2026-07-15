import { useCallback, useEffect } from 'react';

import type { AISettings, AssistantRuntime } from '@/stores/settingsStore';

import { ClaudeRuntimeControls } from './ClaudeRuntimeControls';
import { CodexRuntimeControls } from './CodexRuntimeControls';

interface ExternalAgentRuntimeSettingsProps {
  settings: AISettings;
  onUpdate: (values: Partial<AISettings>) => void;
  disabled?: boolean;
  diagnosticsEnabled?: boolean;
}

const RUNTIME_OPTIONS: Array<{
  value: Exclude<AssistantRuntime, 'api'>;
  title: string;
  badge: string;
}> = [
  { value: 'codex', title: 'Codex account agent', badge: 'OAuth' },
  { value: 'claude_code', title: 'Claude account agent', badge: 'OAuth / API key' },
];

/**
 * Assistant runtime selector. Routes assistant work through a local account
 * agent (Codex or Claude Code). The legacy built-in API runtime is not
 * selectable here; saved `api` settings are coerced to Codex.
 */
export function ExternalAgentRuntimeSettings({
  settings,
  onUpdate,
  disabled = false,
  diagnosticsEnabled = true,
}: ExternalAgentRuntimeSettingsProps): JSX.Element {
  const showDiagnostics = import.meta.env.DEV && diagnosticsEnabled;
  const effectiveAssistantRuntime: Exclude<AssistantRuntime, 'api'> =
    settings.assistantRuntime === 'claude_code' ? 'claude_code' : 'codex';
  const codexSelected = effectiveAssistantRuntime === 'codex';
  const claudeSelected = effectiveAssistantRuntime === 'claude_code';

  // Coerce the legacy API runtime to Codex; Codex and Claude selections persist.
  useEffect(() => {
    if (!disabled && settings.assistantRuntime === 'api') {
      onUpdate({ assistantRuntime: 'codex' });
    }
  }, [disabled, onUpdate, settings.assistantRuntime]);

  const handleRuntimeSelect = useCallback(
    (runtime: Exclude<AssistantRuntime, 'api'>) => {
      onUpdate({ assistantRuntime: runtime });
    },
    [onUpdate],
  );

  return (
    <section>
      <div className="mb-3 border-b border-editor-border pb-2">
        <h3 className="text-sm font-medium text-editor-text">Assistant Runtime</h3>
        <p className="mt-1 text-xs text-editor-text-muted">
          OpenReelio routes assistant work through a local account agent.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {RUNTIME_OPTIONS.map((option) => {
          const selected = effectiveAssistantRuntime === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => handleRuntimeSelect(option.value)}
              disabled={disabled}
              aria-pressed={selected}
              className={`flex min-h-12 items-center justify-between gap-2 rounded border px-3 py-2 text-left transition-colors ${
                selected
                  ? 'border-primary-500 bg-primary-500/10 text-editor-text'
                  : 'border-editor-border bg-editor-bg text-editor-text-muted hover:bg-editor-bg-hover'
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <span className="min-w-0 truncate text-sm font-medium">{option.title}</span>
              <span className="shrink-0 rounded border border-editor-border px-1.5 py-0.5 text-[10px] text-editor-text-muted">
                {option.badge}
              </span>
            </button>
          );
        })}
      </div>

      {codexSelected && (
        <CodexRuntimeControls
          settings={settings}
          onUpdate={onUpdate}
          disabled={disabled}
          showDiagnostics={showDiagnostics}
        />
      )}

      {claudeSelected && (
        <ClaudeRuntimeControls
          settings={settings}
          onUpdate={onUpdate}
          disabled={disabled}
          showDiagnostics={showDiagnostics}
        />
      )}
    </section>
  );
}

export default ExternalAgentRuntimeSettings;
