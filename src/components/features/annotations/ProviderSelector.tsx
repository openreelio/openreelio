/**
 * ProviderSelector Component
 *
 * Dropdown selector for analysis providers (FFmpeg, Google Cloud).
 * Shows provider capabilities and availability status.
 */

import type { ChangeEvent } from 'react';

import type { AnalysisProvider, ProviderCapabilities } from '@/bindings';

// =============================================================================
// Types
// =============================================================================

export interface ProviderSelectorProps {
  /** Available providers */
  providers: ProviderCapabilities[];
  /** Currently selected provider */
  selectedProvider: AnalysisProvider;
  /** Callback when provider changes */
  onProviderChange: (provider: AnalysisProvider) => void;
  /** Whether selector is disabled */
  disabled?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function ProviderSelector({
  providers,
  selectedProvider,
  onProviderChange,
  disabled = false,
}: ProviderSelectorProps): JSX.Element {
  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    onProviderChange(parseProviderValue(e.target.value));
  };

  const selectedProviderInfo = providers.find(
    (p) => getProviderValue(p.provider) === getProviderValue(selectedProvider)
  );

  return (
    <div className="space-y-2">
      <label
        htmlFor="provider-select"
        className="block text-xs font-medium text-editor-text-muted"
      >
        Analysis Provider
      </label>

      <select
        id="provider-select"
        value={getProviderValue(selectedProvider)}
        onChange={handleChange}
        disabled={disabled || providers.length === 0}
        className="w-full rounded border border-editor-border bg-editor-input px-3 py-2 text-sm text-editor-text focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="provider-selector"
      >
        {providers.map((provider) => (
          <option key={getProviderValue(provider.provider)} value={getProviderValue(provider.provider)}>
            {getProviderLabel(provider.provider)}
            {provider.hasCost ? ' (Paid)' : ' (Free)'}
          </option>
        ))}
      </select>

      {selectedProviderInfo && (
        <p className="text-xs text-editor-text-muted">{selectedProviderInfo.description}</p>
      )}

      {selectedProviderInfo?.hasCost && (
        <p className="text-xs text-status-warning">
          This provider has usage costs. Cost estimate will be shown before analysis.
        </p>
      )}
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function getProviderValue(provider: AnalysisProvider): string {
  if (typeof provider === 'string') {
    return provider;
  }
  if (typeof provider === 'object' && 'custom' in provider) {
    return `custom:${provider.custom}`;
  }
  return 'unknown';
}

function parseProviderValue(value: string): AnalysisProvider {
  if (value.startsWith('custom:')) {
    return { custom: value.slice(7) };
  }
  return value as AnalysisProvider;
}

function getProviderLabel(provider: AnalysisProvider): string {
  if (typeof provider === 'string') {
    switch (provider) {
      case 'ffmpeg':
        return 'FFmpeg (Local)';
      case 'google_cloud':
        return 'Google Cloud';
      case 'whisper':
        return 'Whisper (Local)';
      default:
        return provider;
    }
  }
  if (typeof provider === 'object' && 'custom' in provider) {
    return `Custom: ${provider.custom}`;
  }
  return 'Unknown';
}
