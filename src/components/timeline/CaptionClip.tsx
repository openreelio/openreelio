/**
 * CaptionClip Component
 *
 * Displays a caption entry on the timeline with text preview and selection support.
 * Unlike video/audio clips, caption clips show the text content directly.
 */

import { useMemo, type MouseEvent } from 'react';
import type { Caption, CaptionStyle, CaptionColor, ClickModifiers } from '@/types';

// Re-export for backward compatibility
export type { ClickModifiers } from '@/types';

// =============================================================================
// Types
// =============================================================================

interface CaptionClipProps {
  /** Caption data */
  caption: Caption;
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Whether caption is selected */
  selected: boolean;
  /** Whether interaction is disabled */
  disabled?: boolean;
  /** Default caption style from track */
  defaultStyle?: CaptionStyle;
  /** Highlight color based on speaker */
  speakerColor?: CaptionColor;
  /** Click handler with modifier keys */
  onClick?: (captionId: string, modifiers: ClickModifiers) => void;
  /** Double-click handler (opens editor) */
  onDoubleClick?: (captionId: string) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Minimum clip width in pixels */
const MIN_CLIP_WIDTH_PX = 20;

/** Maximum text preview characters */
const MAX_TEXT_PREVIEW_CHARS = 50;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert CaptionColor to CSS rgba string
 */
function colorToRgba(color: CaptionColor): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a / 255})`;
}

/**
 * Get contrasting text color (black or white) based on background
 */
function getContrastColor(bgColor: CaptionColor): string {
  // Calculate relative luminance
  const luminance = (0.299 * bgColor.r + 0.587 * bgColor.g + 0.114 * bgColor.b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

/**
 * Truncate text with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  // Remove newlines and extra whitespace
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength - 1) + '\u2026';
}

/**
 * Generate a consistent color from speaker name
 */
function getSpeakerColor(speaker: string): CaptionColor {
  // Simple hash-based color generation
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
  }

  // Generate hue from hash (0-360)
  const hue = Math.abs(hash) % 360;

  // Convert HSL to RGB (saturation=70%, lightness=50%)
  const s = 0.7;
  const l = 0.5;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0,
    g = 0,
    b = 0;
  if (hue < 60) {
    r = c;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = c;
  } else if (hue < 180) {
    g = c;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = c;
  } else if (hue < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    a: 255,
  };
}

// =============================================================================
// Component
// =============================================================================

export function CaptionClip(props: CaptionClipProps) {
  const { caption, zoom, selected, disabled = false, speakerColor, onClick, onDoubleClick } =
    props;
  // Calculate display dimensions
  const displayPosition = useMemo(() => {
    const duration = caption.endSec - caption.startSec;
    return {
      duration,
      left: caption.startSec * zoom,
      width: Math.max(duration * zoom, MIN_CLIP_WIDTH_PX),
    };
  }, [caption, zoom]);

  // Determine background color
  const backgroundColor = useMemo(() => {
    if (speakerColor) {
      return colorToRgba(speakerColor);
    }
    if (caption.speaker) {
      return colorToRgba(getSpeakerColor(caption.speaker));
    }
    // Default caption color (teal)
    return 'rgb(20, 184, 166)';
  }, [speakerColor, caption.speaker]);

  // Text color for contrast
  const textColor = useMemo(() => {
    const bgColor = speakerColor || (caption.speaker ? getSpeakerColor(caption.speaker) : null);
    if (bgColor) {
      return getContrastColor(bgColor);
    }
    return '#ffffff';
  }, [speakerColor, caption.speaker]);

  // Truncated text for display
  const displayText = useMemo(() => {
    return truncateText(caption.text, MAX_TEXT_PREVIEW_CHARS);
  }, [caption.text]);

  // Handle click
  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!disabled && onClick) {
      onClick(caption.id, {
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
      onDoubleClick(caption.id);
    }
  };

  return (
    <div
      data-testid={`caption-clip-${caption.id}`}
      className={`
        absolute h-full rounded-sm cursor-pointer transition-shadow select-none overflow-hidden
        ${selected ? 'ring-2 ring-primary-400 z-10' : ''}
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:brightness-110'}
      `}
      style={{
        left: `${displayPosition.left}px`,
        width: `${displayPosition.width}px`,
        backgroundColor,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title={caption.text}
    >
      {/* Caption content */}
      <div className="h-full px-2 py-1 flex flex-col justify-center overflow-hidden">
        {/* Speaker badge */}
        {caption.speaker && (
          <span
            className="text-[10px] font-medium opacity-80 truncate mb-0.5"
            style={{ color: textColor }}
          >
            {caption.speaker}
          </span>
        )}

        {/* Caption text */}
        <span
          className="text-xs truncate leading-tight"
          style={{ color: textColor }}
        >
          {displayText}
        </span>
      </div>

      {/* Selection/hover border overlay */}
      <div
        className={`
          absolute inset-0 border rounded-sm pointer-events-none
          ${selected ? 'border-primary-400' : 'border-transparent'}
        `}
      />
    </div>
  );
}

export default CaptionClip;
