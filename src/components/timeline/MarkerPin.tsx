/**
 * MarkerPin Component
 *
 * Displays a single marker on the timeline ruler.
 * Supports different marker types with distinct visual styles.
 */

import { useMemo, type MouseEvent } from 'react';
import { Flag, Bookmark, Megaphone, CheckSquare, Circle } from 'lucide-react';
import type { Marker, Color, ClickModifiers } from '@/types';

// Re-export for backward compatibility
export type { ClickModifiers } from '@/types';

// =============================================================================
// Types
// =============================================================================

interface MarkerPinProps {
  /** Marker data */
  marker: Marker;
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Whether marker is selected */
  selected: boolean;
  /** Whether interaction is disabled */
  disabled?: boolean;
  /** Click handler */
  onClick?: (markerId: string, modifiers: ClickModifiers) => void;
  /** Double-click handler (opens editor) */
  onDoubleClick?: (markerId: string) => void;
  /** Context menu handler */
  onContextMenu?: (markerId: string, event: MouseEvent) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Marker icon size */
const ICON_SIZE = 12;

/** Marker pin height */
const PIN_HEIGHT = 20;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert Color to CSS rgba string
 * Color.a is optional, defaults to 1 (fully opaque) when undefined
 * When a is provided, it's expected to be 0-1 range (matching CSS standard)
 */
function colorToRgba(color: Color): string {
  // If alpha is not provided, default to fully opaque
  const alpha = color.a ?? 1;
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

/**
 * Get contrasting text color
 */
function getContrastColor(bgColor: Color): string {
  const luminance = (0.299 * bgColor.r + 0.587 * bgColor.g + 0.114 * bgColor.b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

/**
 * Get marker icon based on type
 */
function getMarkerIcon(markerType: Marker['markerType']) {
  switch (markerType) {
    case 'chapter':
      return Bookmark;
    case 'hook':
      return Megaphone;
    case 'cta':
      return Flag;
    case 'todo':
      return CheckSquare;
    case 'generic':
    default:
      return Circle;
  }
}

/**
 * Get default color for marker type
 */
function getDefaultMarkerColor(markerType: Marker['markerType']): Color {
  switch (markerType) {
    case 'chapter':
      return { r: 59, g: 130, b: 246 }; // Blue
    case 'hook':
      return { r: 236, g: 72, b: 153 }; // Pink
    case 'cta':
      return { r: 245, g: 158, b: 11 }; // Amber
    case 'todo':
      return { r: 34, g: 197, b: 94 }; // Green
    case 'generic':
    default:
      return { r: 156, g: 163, b: 175 }; // Gray
  }
}

// =============================================================================
// Component
// =============================================================================

export function MarkerPin({
  marker,
  zoom,
  selected,
  disabled = false,
  onClick,
  onDoubleClick,
  onContextMenu,
}: MarkerPinProps) {
  // Calculate position
  const left = marker.timeSec * zoom;

  // Get marker color (use marker's color or default for type)
  const markerColor = useMemo(() => {
    if (marker.color && (marker.color.r || marker.color.g || marker.color.b)) {
      return marker.color;
    }
    return getDefaultMarkerColor(marker.markerType);
  }, [marker.color, marker.markerType]);

  const backgroundColor = colorToRgba(markerColor);
  const textColor = getContrastColor(markerColor);

  // Get icon component
  const Icon = getMarkerIcon(marker.markerType);

  // Handle click
  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!disabled && onClick) {
      onClick(marker.id, {
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
      });
    }
  };

  // Handle double-click
  const handleDoubleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!disabled && onDoubleClick) {
      onDoubleClick(marker.id);
    }
  };

  // Handle context menu
  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && onContextMenu) {
      onContextMenu(marker.id, e);
    }
  };

  return (
    <div
      data-testid={`marker-pin-${marker.id}`}
      className={`
        absolute flex flex-col items-center cursor-pointer select-none
        transition-transform duration-100
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:scale-110'}
        ${selected ? 'z-20' : 'z-10'}
      `}
      style={{
        left: `${left}px`,
        transform: 'translateX(-50%)',
        top: 0,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      title={`${marker.label}\n${marker.markerType}`}
    >
      {/* Marker head */}
      <div
        className={`
          flex items-center justify-center rounded-sm
          ${selected ? 'ring-2 ring-white ring-offset-1 ring-offset-black' : ''}
        `}
        style={{
          width: `${PIN_HEIGHT}px`,
          height: `${PIN_HEIGHT}px`,
          backgroundColor,
        }}
      >
        <Icon
          size={ICON_SIZE}
          style={{ color: textColor }}
          strokeWidth={2}
        />
      </div>

      {/* Marker stem/line */}
      <div
        className="w-px h-full"
        style={{
          backgroundColor,
          opacity: 0.7,
        }}
      />

      {/* Label (shown on hover or when selected) */}
      {(selected || marker.label) && (
        <div
          className={`
            absolute top-full mt-0.5 px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap
            ${selected ? 'opacity-100' : 'opacity-0 hover:opacity-100'}
            transition-opacity duration-150
          `}
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            color: '#ffffff',
            maxWidth: '100px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {marker.label || marker.markerType}
        </div>
      )}
    </div>
  );
}

export default MarkerPin;
