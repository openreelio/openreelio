/**
 * HDRIndicator Component
 *
 * Displays an HDR format badge on asset thumbnails.
 * Shows HDR10, HLG, or generic HDR label with appropriate styling.
 *
 * @module components/features/hdr/HDRIndicator
 */

import type { DetectedHdrInfo } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface HDRIndicatorProps {
  /** Detected HDR information from the asset */
  info: DetectedHdrInfo | null | undefined;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Whether to show tooltip with detailed info */
  showTooltip?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Badge colors by HDR format */
const FORMAT_COLORS: Record<string, string> = {
  HDR10: 'bg-orange-500',
  HLG: 'bg-purple-500',
  HDR: 'bg-blue-500',
  'Dolby Vision': 'bg-black',
};

/** Size classes */
const SIZE_CLASSES: Record<string, string> = {
  sm: 'text-xs px-1 py-0.5',
  md: 'text-xs px-1.5 py-0.5',
  lg: 'text-sm px-2 py-1',
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Gets the background color class for the HDR format.
 */
function getFormatColor(formatName: string): string {
  return FORMAT_COLORS[formatName] || FORMAT_COLORS.HDR;
}

/**
 * Builds the tooltip string with detailed HDR information.
 */
function buildTooltip(info: DetectedHdrInfo): string {
  const parts: string[] = [info.formatName];

  if (info.bitDepth) {
    parts.push(`${info.bitDepth}-bit`);
  }

  if (info.maxCll) {
    parts.push(`MaxCLL: ${info.maxCll} nits`);
  }

  if (info.maxFall) {
    parts.push(`MaxFALL: ${info.maxFall} nits`);
  }

  if (info.primaries) {
    const primariesDisplay =
      info.primaries === 'bt2020' ? 'BT.2020' : info.primaries.toUpperCase();
    parts.push(`Primaries: ${primariesDisplay}`);
  }

  return parts.join(' | ');
}

// =============================================================================
// Component
// =============================================================================

export function HDRIndicator({
  info,
  size = 'md',
  showTooltip = true,
  className = '',
}: HDRIndicatorProps) {
  // Early return for non-HDR or missing info
  if (!info || !info.isHdr) {
    return null;
  }

  const colorClass = getFormatColor(info.formatName);
  const sizeClass = SIZE_CLASSES[size];
  const tooltip = showTooltip ? buildTooltip(info) : undefined;

  return (
    <span
      data-testid="hdr-indicator"
      className={`
        inline-flex items-center justify-center
        rounded font-semibold text-white
        shadow-sm
        ${colorClass}
        ${sizeClass}
        ${className}
      `.trim()}
      title={tooltip}
    >
      {info.formatName}
    </span>
  );
}

export default HDRIndicator;
