/**
 * CaptionTrack Component
 *
 * Displays a caption track with its captions and controls.
 * Similar to Track component but specialized for caption display.
 */

import { useRef, useMemo } from 'react';
import { Type, Eye, EyeOff, Lock, Unlock, Globe, Download } from 'lucide-react';
import type { Caption, CaptionTrack as CaptionTrackType, CaptionColor } from '@/types';
import { CaptionClip, type ClickModifiers } from './CaptionClip';

// =============================================================================
// Types
// =============================================================================

interface CaptionTrackProps {
  /** Caption track data */
  track: CaptionTrackType;
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Horizontal scroll offset in pixels */
  scrollX?: number;
  /** Total timeline duration in seconds */
  duration?: number;
  /** Visible viewport width in pixels */
  viewportWidth?: number;
  /** Selected caption IDs */
  selectedCaptionIds?: string[];
  /** Map of speaker name to color (for consistent speaker colors) */
  speakerColors?: Map<string, CaptionColor>;
  /** Lock toggle handler */
  onLockToggle?: (trackId: string) => void;
  /** Visibility toggle handler */
  onVisibilityToggle?: (trackId: string) => void;
  /** Caption click handler with modifier keys */
  onCaptionClick?: (captionId: string, modifiers: ClickModifiers) => void;
  /** Caption double-click handler (opens editor) */
  onCaptionDoubleClick?: (captionId: string) => void;
  /** Track header click handler */
  onTrackClick?: (trackId: string) => void;
  /** Export click handler - receives track ID and all captions */
  onExportClick?: (trackId: string, captions: Caption[]) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Default viewport width for virtualization fallback */
const DEFAULT_VIEWPORT_WIDTH = 1200;

/** Buffer zone in pixels for pre-rendering off-screen captions */
const VIRTUALIZATION_BUFFER_PX = 100;

/** Language code display names */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ko: 'Korean',
  ja: 'Japanese',
  zh: 'Chinese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ru: 'Russian',
  ar: 'Arabic',
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get display name for language code
 */
function getLanguageDisplayName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] || code.toUpperCase();
}

/**
 * Virtualize captions - only return captions visible in viewport
 */
function virtualizeCaptions(
  captions: Caption[],
  zoom: number,
  scrollX: number,
  viewportWidth: number,
  bufferPx: number,
): Caption[] {
  // Guard against division by zero or invalid zoom values
  if (zoom <= 0 || !Number.isFinite(zoom)) {
    return captions;
  }

  // Ensure non-negative scroll position for time calculation
  const effectiveScrollX = Math.max(0, scrollX - bufferPx);
  const startTime = effectiveScrollX / zoom;
  const endTime = (scrollX + viewportWidth + bufferPx) / zoom;

  return captions.filter((caption) => {
    return caption.endSec >= startTime && caption.startSec <= endTime;
  });
}

// =============================================================================
// Component
// =============================================================================

export function CaptionTrack({
  track,
  zoom,
  scrollX = 0,
  duration = 60,
  viewportWidth,
  selectedCaptionIds = [],
  speakerColors,
  onLockToggle,
  onVisibilityToggle,
  onCaptionClick,
  onCaptionDoubleClick,
  onTrackClick,
  onExportClick,
}: CaptionTrackProps) {
  // Ref for measuring viewport width if not provided
  const contentRef = useRef<HTMLDivElement>(null);

  // Calculate actual viewport width
  const actualViewportWidth =
    viewportWidth ?? contentRef.current?.clientWidth ?? DEFAULT_VIEWPORT_WIDTH;

  // Virtualize captions - only render captions visible in viewport + buffer
  const visibleCaptions = useMemo(
    () =>
      virtualizeCaptions(
        track.captions,
        zoom,
        scrollX,
        actualViewportWidth,
        VIRTUALIZATION_BUFFER_PX,
      ),
    [track.captions, zoom, scrollX, actualViewportWidth],
  );

  // Calculate track content width based on duration and zoom
  const contentWidth = duration * zoom;

  // Language display
  const languageDisplay = getLanguageDisplayName(track.language);

  return (
    <div
      data-track-row="true"
      data-track-id={track.id}
      data-track-kind="caption"
      className="flex border-b border-editor-border"
    >
      {/* Track Header */}
      <div
        data-testid="caption-track-header"
        className="w-48 flex-shrink-0 bg-editor-sidebar p-2 flex items-center gap-2 border-r border-editor-border cursor-pointer hover:bg-editor-border/50"
        onClick={() => onTrackClick?.(track.id)}
      >
        {/* Track type icon */}
        <Type className="w-4 h-4 text-teal-400" />

        {/* Track info */}
        <div className="flex-1 min-w-0">
          <span className="text-sm text-editor-text truncate block">{track.name}</span>
          <div className="flex items-center gap-1 text-[10px] text-editor-text-muted">
            <Globe className="w-3 h-3" />
            <span>{languageDisplay}</span>
          </div>
        </div>

        {/* Track controls */}
        <div className="flex items-center gap-1">
          {/* Export button */}
          <button
            data-testid="caption-export-button"
            className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            onClick={(e) => {
              e.stopPropagation();
              if (track.captions.length > 0) {
                onExportClick?.(track.id, track.captions);
              }
            }}
            disabled={track.captions.length === 0}
            title="Export captions"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          {/* Lock button */}
          <button
            data-testid="caption-lock-button"
            className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
            onClick={(e) => {
              e.stopPropagation();
              onLockToggle?.(track.id);
            }}
            title={track.locked ? 'Unlock' : 'Lock'}
          >
            {track.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
          </button>

          {/* Visibility button */}
          <button
            data-testid="caption-visibility-button"
            className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
            onClick={(e) => {
              e.stopPropagation();
              onVisibilityToggle?.(track.id);
            }}
            title={track.visible ? 'Hide' : 'Show'}
          >
            {track.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Track Content (Captions Area) */}
      <div
        ref={contentRef}
        data-testid="caption-track-content"
        className={`flex-1 h-12 bg-editor-bg relative overflow-hidden ${
          !track.visible ? 'opacity-50' : ''
        }`}
      >
        {/* Background pattern for caption track */}
        <div
          className="absolute inset-0 opacity-5"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, currentColor, currentColor 1px, transparent 1px, transparent 6px)',
          }}
        />

        {/* Scrollable captions container */}
        <div
          className="absolute inset-0"
          style={{
            width: `${contentWidth}px`,
            transform: `translateX(-${scrollX}px)`,
          }}
        >
          {/* Only render visible captions (virtualized) */}
          {visibleCaptions.map((caption) => (
            <CaptionClip
              key={caption.id}
              caption={caption}
              zoom={zoom}
              selected={selectedCaptionIds.includes(caption.id)}
              disabled={track.locked}
              speakerColor={caption.speaker ? speakerColors?.get(caption.speaker) : undefined}
              onClick={onCaptionClick}
              onDoubleClick={onCaptionDoubleClick}
            />
          ))}
        </div>

        {/* Empty state */}
        {track.captions.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-editor-text-muted text-sm">
            No captions
          </div>
        )}
      </div>
    </div>
  );
}

export default CaptionTrack;
