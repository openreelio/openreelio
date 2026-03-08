/**
 * TransitionDiffTable Component
 *
 * Displays a comparison table of transition types between a reference ESD
 * and the current timeline output. Shows match status indicators.
 */

import { memo } from 'react';

// =============================================================================
// Types
// =============================================================================

/** A row in the transition comparison table */
export interface TransitionDiffRow {
  /** Transition type name (e.g., 'dissolve', 'cut', 'fade_in') */
  type: string;
  /** Count in reference ESD */
  referenceCount: number;
  /** Count in current output */
  outputCount: number;
}

/** Match status for transition comparison */
type MatchStatus = 'exact' | 'close' | 'missing';

/** Props for the TransitionDiffTable component */
export interface TransitionDiffTableProps {
  /** Transition comparison rows */
  rows: TransitionDiffRow[];
  /** Optional CSS class name */
  className?: string;
}

// =============================================================================
// Helpers
// =============================================================================

function getMatchStatus(row: TransitionDiffRow): MatchStatus {
  if (row.outputCount === 0 && row.referenceCount > 0) {
    return 'missing';
  }
  if (row.referenceCount === row.outputCount) {
    return 'exact';
  }
  if (Math.abs(row.referenceCount - row.outputCount) <= 2) {
    return 'close';
  }
  return 'missing';
}

const STATUS_STYLES: Record<MatchStatus, { dot: string; label: string }> = {
  exact: { dot: 'bg-green-400', label: 'Exact' },
  close: { dot: 'bg-yellow-400', label: 'Close' },
  missing: { dot: 'bg-red-400', label: 'Missing' },
};

function formatTransitionType(type: string): string {
  return type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// =============================================================================
// Component
// =============================================================================

export const TransitionDiffTable = memo(function TransitionDiffTable({
  rows,
  className = '',
}: TransitionDiffTableProps) {
  if (rows.length === 0) {
    return (
      <div
        className={`text-xs text-editor-text-muted text-center py-4 ${className}`}
        data-testid="transition-diff-empty"
      >
        No transition data available
      </div>
    );
  }

  return (
    <div className={`overflow-auto ${className}`} data-testid="transition-diff-table">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-editor-border">
            <th className="text-left py-1.5 px-2 text-editor-text-muted font-medium">
              Type
            </th>
            <th className="text-right py-1.5 px-2 text-editor-text-muted font-medium">
              Ref
            </th>
            <th className="text-right py-1.5 px-2 text-editor-text-muted font-medium">
              Output
            </th>
            <th className="text-center py-1.5 px-2 text-editor-text-muted font-medium">
              Match
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = getMatchStatus(row);
            const styles = STATUS_STYLES[status];

            return (
              <tr
                key={row.type}
                className="border-b border-editor-border/50 hover:bg-editor-border/30 transition-colors"
              >
                <td className="py-1.5 px-2 text-editor-text font-mono">
                  {formatTransitionType(row.type)}
                </td>
                <td className="py-1.5 px-2 text-right text-editor-text tabular-nums">
                  {row.referenceCount}
                </td>
                <td className="py-1.5 px-2 text-right text-editor-text tabular-nums">
                  {row.outputCount}
                </td>
                <td className="py-1.5 px-2">
                  <div className="flex items-center justify-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full ${styles.dot}`}
                      aria-label={styles.label}
                    />
                    <span className="text-editor-text-muted">{styles.label}</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});

export default TransitionDiffTable;
