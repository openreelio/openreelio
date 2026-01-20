/**
 * MarkerLayer Component
 *
 * Displays all markers as an overlay on the timeline.
 * Markers are rendered above the time ruler.
 */

import { useMemo, type MouseEvent } from 'react';
import type { Marker } from '@/types';
import { MarkerPin, type ClickModifiers } from './MarkerPin';

// =============================================================================
// Types
// =============================================================================

interface MarkerLayerProps {
  /** Array of markers to display */
  markers: Marker[];
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Horizontal scroll offset in pixels */
  scrollX?: number;
  /** Visible viewport width in pixels */
  viewportWidth?: number;
  /** Total timeline duration in seconds */
  duration?: number;
  /** Selected marker IDs */
  selectedMarkerIds?: string[];
  /** Whether interaction is disabled */
  disabled?: boolean;
  /** Marker click handler */
  onMarkerClick?: (markerId: string, modifiers: ClickModifiers) => void;
  /** Marker double-click handler */
  onMarkerDoubleClick?: (markerId: string) => void;
  /** Marker context menu handler */
  onMarkerContextMenu?: (markerId: string, event: MouseEvent) => void;
  /** Click on empty area to add marker */
  onAddMarker?: (timeSec: number) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Buffer zone in pixels for virtualization */
const VIRTUALIZATION_BUFFER_PX = 50;

/** Marker layer height */
const LAYER_HEIGHT = 24;

// =============================================================================
// Component
// =============================================================================

export function MarkerLayer({
  markers,
  zoom,
  scrollX = 0,
  viewportWidth = 1200,
  duration = 60,
  selectedMarkerIds = [],
  disabled = false,
  onMarkerClick,
  onMarkerDoubleClick,
  onMarkerContextMenu,
  onAddMarker,
}: MarkerLayerProps) {
  // Calculate content width
  const contentWidth = duration * zoom;

  // Virtualize markers - only render visible markers
  const visibleMarkers = useMemo(() => {
    const startTime = (scrollX - VIRTUALIZATION_BUFFER_PX) / zoom;
    const endTime = (scrollX + viewportWidth + VIRTUALIZATION_BUFFER_PX) / zoom;

    return markers.filter((marker) => {
      return marker.timeSec >= startTime && marker.timeSec <= endTime;
    });
  }, [markers, zoom, scrollX, viewportWidth]);

  // Handle double-click on empty space to add marker
  const handleLayerDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onAddMarker || disabled) return;

    // Check if clicking on the layer itself, not a marker
    const target = e.target as HTMLElement;
    if (target.closest('[data-testid^="marker-pin-"]')) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left + scrollX;
    const timeSec = Math.max(0, Math.min(duration, clickX / zoom));

    onAddMarker(timeSec);
  };

  return (
    <div
      data-testid="marker-layer"
      className="relative overflow-hidden"
      style={{
        height: `${LAYER_HEIGHT}px`,
        width: '100%',
      }}
      onDoubleClick={handleLayerDoubleClick}
    >
      {/* Scrollable container */}
      <div
        className="absolute inset-0"
        style={{
          width: `${contentWidth}px`,
          transform: `translateX(-${scrollX}px)`,
        }}
      >
        {/* Render visible markers */}
        {visibleMarkers.map((marker) => (
          <MarkerPin
            key={marker.id}
            marker={marker}
            zoom={zoom}
            selected={selectedMarkerIds.includes(marker.id)}
            disabled={disabled}
            onClick={onMarkerClick}
            onDoubleClick={onMarkerDoubleClick}
            onContextMenu={onMarkerContextMenu}
          />
        ))}
      </div>

      {/* Empty state hint (only when no markers and not disabled) */}
      {markers.length === 0 && !disabled && onAddMarker && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[10px] text-editor-text-muted opacity-50">
            Double-click to add marker
          </span>
        </div>
      )}
    </div>
  );
}

export default MarkerLayer;
