/**
 * VideoScopesPanel Component
 *
 * Container panel for video scopes (Histogram, Waveform, Vectorscope, RGB Parade).
 * Provides tabbed navigation between different scope types.
 *
 * Features:
 * - Tab-based scope selection
 * - Real-time frame analysis
 * - Settings for each scope type
 * - Exposure indicator
 */

import { memo, useState, useCallback } from 'react';
import {
  BarChart3,
  Activity,
  Circle,
  Layers,
  Settings,
  AlertTriangle,
} from 'lucide-react';
import type { FrameAnalysis } from '@/utils/scopeAnalysis';
import { calculateExposureLevel, createEmptyAnalysis } from '@/utils/scopeAnalysis';
import { HistogramDisplay, type HistogramMode } from './HistogramDisplay';
import { WaveformDisplay, type WaveformMode } from './WaveformDisplay';
import { VectorscopeDisplay } from './VectorscopeDisplay';
import { RGBParadeDisplay, type ParadeMode } from './RGBParadeDisplay';

// =============================================================================
// Types
// =============================================================================

export type ScopeType = 'histogram' | 'waveform' | 'vectorscope' | 'parade';

export interface VideoScopesPanelProps {
  /** Frame analysis data */
  analysis?: FrameAnalysis;
  /** Initial scope type */
  initialScope?: ScopeType;
  /** Panel width */
  width?: number;
  /** Panel height (for scope display area) */
  height?: number;
  /** Whether analysis is active/updating */
  isAnalyzing?: boolean;
  /** Callback when scope type changes */
  onScopeChange?: (scope: ScopeType) => void;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const SCOPE_TABS: { id: ScopeType; label: string; icon: typeof BarChart3 }[] = [
  { id: 'histogram', label: 'Histogram', icon: BarChart3 },
  { id: 'waveform', label: 'Waveform', icon: Activity },
  { id: 'vectorscope', label: 'Vectorscope', icon: Circle },
  { id: 'parade', label: 'RGB Parade', icon: Layers },
];

// =============================================================================
// Sub-components
// =============================================================================

interface ExposureIndicatorProps {
  level: number; // -1 to 1
}

const ExposureIndicator = memo(function ExposureIndicator({ level }: ExposureIndicatorProps) {
  const isUnderexposed = level < -0.3;
  const isOverexposed = level > 0.3;
  const isBalanced = !isUnderexposed && !isOverexposed;

  return (
    <div className="flex items-center gap-2 text-xs">
      {!isBalanced && (
        <AlertTriangle
          className={`w-3 h-3 ${isUnderexposed ? 'text-blue-400' : 'text-yellow-400'}`}
        />
      )}
      <div className="flex items-center gap-1">
        <span className="text-editor-text-muted">Exposure:</span>
        <div className="w-16 h-2 bg-editor-border rounded-full overflow-hidden">
          <div
            className="h-full transition-all duration-200"
            style={{
              width: `${Math.abs(level) * 50}%`,
              marginLeft: level < 0 ? `${50 - Math.abs(level) * 50}%` : '50%',
              backgroundColor: isBalanced
                ? 'rgb(34, 197, 94)'
                : isUnderexposed
                ? 'rgb(59, 130, 246)'
                : 'rgb(250, 204, 21)',
            }}
          />
        </div>
        <span
          className={`font-mono ${
            isBalanced
              ? 'text-green-400'
              : isUnderexposed
              ? 'text-blue-400'
              : 'text-yellow-400'
          }`}
        >
          {level > 0 ? '+' : ''}
          {level.toFixed(2)}
        </span>
      </div>
    </div>
  );
});

interface ScopeSettingsProps {
  scope: ScopeType;
  histogramMode: HistogramMode;
  waveformMode: WaveformMode;
  paradeMode: ParadeMode;
  logarithmic: boolean;
  onHistogramModeChange: (mode: HistogramMode) => void;
  onWaveformModeChange: (mode: WaveformMode) => void;
  onParadeModeChange: (mode: ParadeMode) => void;
  onLogarithmicChange: (enabled: boolean) => void;
}

const ScopeSettings = memo(function ScopeSettings({
  scope,
  histogramMode,
  waveformMode,
  paradeMode,
  logarithmic,
  onHistogramModeChange,
  onWaveformModeChange,
  onParadeModeChange,
  onLogarithmicChange,
}: ScopeSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text transition-colors"
        aria-label="Scope settings"
      >
        <Settings className="w-4 h-4" />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 z-10 bg-editor-sidebar border border-editor-border rounded-lg shadow-lg p-3 min-w-[180px]">
          {scope === 'histogram' && (
            <div className="space-y-2">
              <label className="block text-xs text-editor-text-muted">Display Mode</label>
              <select
                value={histogramMode}
                onChange={(e) => onHistogramModeChange(e.target.value as HistogramMode)}
                className="w-full px-2 py-1 bg-editor-input border border-editor-border rounded text-xs text-editor-text"
              >
                <option value="rgb">RGB Overlay</option>
                <option value="luminance">Luminance</option>
                <option value="parade">Parade</option>
              </select>
              <label className="flex items-center gap-2 text-xs text-editor-text cursor-pointer">
                <input
                  type="checkbox"
                  checked={logarithmic}
                  onChange={(e) => onLogarithmicChange(e.target.checked)}
                  className="w-3 h-3 accent-primary-500"
                />
                Logarithmic Scale
              </label>
            </div>
          )}

          {scope === 'waveform' && (
            <div className="space-y-2">
              <label className="block text-xs text-editor-text-muted">Display Mode</label>
              <select
                value={waveformMode}
                onChange={(e) => onWaveformModeChange(e.target.value as WaveformMode)}
                className="w-full px-2 py-1 bg-editor-input border border-editor-border rounded text-xs text-editor-text"
              >
                <option value="filled">Filled</option>
                <option value="line">Line</option>
                <option value="intensity">Intensity</option>
              </select>
            </div>
          )}

          {scope === 'parade' && (
            <div className="space-y-2">
              <label className="block text-xs text-editor-text-muted">Display Mode</label>
              <select
                value={paradeMode}
                onChange={(e) => onParadeModeChange(e.target.value as ParadeMode)}
                className="w-full px-2 py-1 bg-editor-input border border-editor-border rounded text-xs text-editor-text"
              >
                <option value="filled">Filled</option>
                <option value="line">Line</option>
              </select>
            </div>
          )}

          {scope === 'vectorscope' && (
            <div className="text-xs text-editor-text-muted">
              No additional settings
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// =============================================================================
// Main Component
// =============================================================================

export const VideoScopesPanel = memo(function VideoScopesPanel({
  analysis,
  initialScope = 'histogram',
  width = 300,
  height = 200,
  isAnalyzing = false,
  onScopeChange,
  className = '',
}: VideoScopesPanelProps) {
  // State
  const [activeScope, setActiveScope] = useState<ScopeType>(initialScope);
  const [histogramMode, setHistogramMode] = useState<HistogramMode>('rgb');
  const [waveformMode, setWaveformMode] = useState<WaveformMode>('filled');
  const [paradeMode, setParadeMode] = useState<ParadeMode>('filled');
  const [logarithmic, setLogarithmic] = useState(false);

  // Use provided analysis or empty
  const data = analysis ?? createEmptyAnalysis();

  // Calculate exposure level
  const exposureLevel = calculateExposureLevel(data.histogram);

  // Handlers
  const handleScopeChange = useCallback(
    (scope: ScopeType) => {
      setActiveScope(scope);
      onScopeChange?.(scope);
    },
    [onScopeChange]
  );

  return (
    <div
      data-testid="video-scopes-panel"
      className={`flex flex-col bg-editor-sidebar rounded-lg overflow-hidden ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-editor-border">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-purple-400" />
          <span className="text-sm font-medium text-editor-text">Video Scopes</span>
          {isAnalyzing && (
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          )}
        </div>
        <ScopeSettings
          scope={activeScope}
          histogramMode={histogramMode}
          waveformMode={waveformMode}
          paradeMode={paradeMode}
          logarithmic={logarithmic}
          onHistogramModeChange={setHistogramMode}
          onWaveformModeChange={setWaveformMode}
          onParadeModeChange={setParadeMode}
          onLogarithmicChange={setLogarithmic}
        />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-editor-border">
        {SCOPE_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => handleScopeChange(id)}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-2 text-xs transition-colors ${
              activeScope === id
                ? 'bg-editor-border text-editor-text border-b-2 border-primary-500'
                : 'text-editor-text-muted hover:text-editor-text hover:bg-editor-border/50'
            }`}
            aria-selected={activeScope === id}
            role="tab"
          >
            <Icon className="w-3 h-3" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Scope Display */}
      <div className="flex-1 p-2 flex items-center justify-center">
        {activeScope === 'histogram' && (
          <HistogramDisplay
            data={data.histogram}
            mode={histogramMode}
            width={width - 16}
            height={height}
            logarithmic={logarithmic}
          />
        )}

        {activeScope === 'waveform' && (
          <WaveformDisplay
            data={data.waveform}
            mode={waveformMode}
            width={width - 16}
            height={height}
          />
        )}

        {activeScope === 'vectorscope' && (
          <VectorscopeDisplay
            data={data.vectorscope}
            size={Math.min(width - 16, height)}
          />
        )}

        {activeScope === 'parade' && (
          <RGBParadeDisplay
            data={data.rgbParade}
            mode={paradeMode}
            width={width - 16}
            height={height}
          />
        )}
      </div>

      {/* Footer with exposure indicator */}
      <div className="px-3 py-2 border-t border-editor-border">
        <ExposureIndicator level={exposureLevel} />
      </div>
    </div>
  );
});

export default VideoScopesPanel;
