/**
 * ShuttleSpeedIndicator Component
 *
 * Displays the current JKL shuttle speed as an overlay badge.
 * Only visible when shuttle is active (speed != 0).
 */

import { memo } from 'react';
import { formatShuttleSpeed } from '@/utils/formatters';

export interface ShuttleSpeedIndicatorProps {
  /** Current shuttle speed (-8 to 8, 0 = hidden) */
  shuttleSpeed: number;
  /** Additional CSS classes */
  className?: string;
}

export const ShuttleSpeedIndicator = memo(function ShuttleSpeedIndicator({
  shuttleSpeed,
  className = '',
}: ShuttleSpeedIndicatorProps) {
  if (shuttleSpeed === 0) return null;

  const isReverse = shuttleSpeed < 0;
  const colorClass = isReverse ? 'bg-amber-600/80 text-amber-100' : 'bg-blue-600/80 text-blue-100';

  return (
    <div
      data-testid="shuttle-speed-indicator"
      className={`pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded px-2 py-0.5 text-xs font-mono font-bold ${colorClass} ${className}`}
    >
      {formatShuttleSpeed(shuttleSpeed)}
    </div>
  );
});
