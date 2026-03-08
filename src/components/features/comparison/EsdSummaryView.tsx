/**
 * EsdSummaryView Component
 *
 * Compact summary display of an Editing Style Document (ESD).
 * Shows key metrics and a mini pacing sparkline with an "Apply Style" action.
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import type { EditingStyleDocument } from '@/bindings';

// =============================================================================
// Types
// =============================================================================

/** Props for the EsdSummaryView component */
export interface EsdSummaryViewProps {
  /** The Editing Style Document to display */
  esd: EditingStyleDocument;
  /** Callback when user clicks "Apply Style" */
  onApply: (esdId: string) => void;
  /** Optional CSS class name */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const SPARKLINE_WIDTH = 100;
const SPARKLINE_HEIGHT = 30;
const SPARKLINE_COLOR = 'rgb(56, 189, 248)'; // sky-400

const TEMPO_BADGE_STYLES: Record<string, string> = {
  fast: 'bg-red-500/20 text-red-400',
  moderate: 'bg-yellow-500/20 text-yellow-400',
  slow: 'bg-blue-500/20 text-blue-400',
};

// =============================================================================
// Sub-components
// =============================================================================

interface PacingSparklineProps {
  /** Pacing curve points */
  points: { normalizedPosition: number; normalizedDuration: number }[];
}

const PacingSparkline = memo(function PacingSparkline({ points }: PacingSparklineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = SPARKLINE_WIDTH * dpr;
    canvas.height = SPARKLINE_HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, SPARKLINE_WIDTH, SPARKLINE_HEIGHT);

    if (points.length === 0) return;

    const padding = 2;
    const plotW = SPARKLINE_WIDTH - padding * 2;
    const plotH = SPARKLINE_HEIGHT - padding * 2;

    ctx.strokeStyle = SPARKLINE_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    for (let i = 0; i < points.length; i++) {
      const x = padding + points[i].normalizedPosition * plotW;
      const y = padding + plotH - points[i].normalizedDuration * plotH;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
  }, [points]);

  return (
    <canvas
      ref={canvasRef}
      width={SPARKLINE_WIDTH}
      height={SPARKLINE_HEIGHT}
      className="block"
      style={{ width: SPARKLINE_WIDTH, height: SPARKLINE_HEIGHT }}
      data-testid="pacing-sparkline"
    />
  );
});

// =============================================================================
// Main Component
// =============================================================================

export const EsdSummaryView = memo(function EsdSummaryView({
  esd,
  onApply,
  className = '',
}: EsdSummaryViewProps) {
  const tempo = esd.rhythmProfile.tempoClassification;
  const shotCount = esd.rhythmProfile.shotDurations.length;
  const dominantTransition = esd.transitionInventory.dominantType;
  const badgeStyle = TEMPO_BADGE_STYLES[tempo] ?? TEMPO_BADGE_STYLES.moderate;

  const handleApply = useCallback(() => {
    onApply(esd.id);
  }, [esd.id, onApply]);

  return (
    <div
      className={`flex flex-col gap-2 p-3 bg-editor-sidebar rounded-lg border border-editor-border ${className}`}
      data-testid="esd-summary-view"
    >
      {/* Header row: name + tempo badge */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-editor-text truncate" title={esd.name}>
          {esd.name}
        </span>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${badgeStyle}`}>
          {tempo}
        </span>
      </div>

      {/* Metrics row */}
      <div className="flex items-center gap-4 text-xs text-editor-text-muted">
        <span>
          <span className="text-editor-text font-mono">{shotCount}</span> shots
        </span>
        <span>
          <span className="text-editor-text font-mono capitalize">
            {dominantTransition.replace(/_/g, ' ')}
          </span>{' '}
          dominant
        </span>
      </div>

      {/* Sparkline + Apply button */}
      <div className="flex items-center justify-between gap-3">
        <PacingSparkline points={esd.pacingCurve} />
        <button
          type="button"
          onClick={handleApply}
          className="px-3 py-1 text-xs font-medium rounded bg-primary-600 hover:bg-primary-500 text-white transition-colors whitespace-nowrap"
        >
          Apply Style
        </button>
      </div>
    </div>
  );
});

export default EsdSummaryView;
