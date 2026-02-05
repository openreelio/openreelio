/**
 * TextPresetPicker Component
 *
 * A grid of preset text styles that users can click to apply
 * predefined styling to their text clips.
 *
 * @module components/features/text/TextPresetPicker
 */

import { useCallback, useMemo } from 'react';
import { Palette } from 'lucide-react';
import { TEXT_PRESETS, type TextPreset } from '@/data/textPresets';

// =============================================================================
// Types
// =============================================================================

export interface TextPresetPickerProps {
  /** Called when a preset is selected */
  onSelect: (preset: TextPreset) => void;
  /** Currently selected preset ID */
  selectedPresetId?: string;
  /** Whether the picker is disabled */
  disabled?: boolean;
  /** Compact mode with smaller previews */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Preview Component
// =============================================================================

interface PresetPreviewProps {
  preset: TextPreset;
  compact?: boolean;
}

function PresetPreview({ preset, compact = false }: PresetPreviewProps): JSX.Element {
  const previewStyle = useMemo(() => {
    const style: React.CSSProperties = {
      fontFamily: preset.style.fontFamily,
      fontSize: compact ? '10px' : '12px',
      fontWeight: preset.style.bold ? 'bold' : 'normal',
      fontStyle: preset.style.italic ? 'italic' : 'normal',
      textDecoration: preset.style.underline ? 'underline' : 'none',
      color: preset.style.color,
      textAlign: preset.style.alignment as React.CSSProperties['textAlign'],
      letterSpacing: `${preset.style.letterSpacing * 0.1}px`,
      lineHeight: preset.style.lineHeight,
      opacity: preset.opacity,
    };

    if (preset.style.backgroundColor) {
      style.backgroundColor = preset.style.backgroundColor;
      style.padding = `${preset.style.backgroundPadding * 0.2}px`;
      style.borderRadius = '2px';
    }

    if (preset.shadow) {
      style.textShadow = `${preset.shadow.offsetX * 0.3}px ${preset.shadow.offsetY * 0.3}px ${preset.shadow.blur * 0.3}px ${preset.shadow.color}`;
    }

    if (preset.outline) {
      // CSS text-stroke for outline effect
      style.WebkitTextStroke = `${preset.outline.width * 0.2}px ${preset.outline.color}`;
    }

    return style;
  }, [preset, compact]);

  // Calculate vertical position class based on preset position
  const positionClass = useMemo(() => {
    const y = preset.position.y;
    if (y < 0.3) return 'items-start pt-1';
    if (y > 0.7) return 'items-end pb-1';
    return 'items-center';
  }, [preset.position.y]);

  const horizontalClass = useMemo(() => {
    const x = preset.position.x;
    if (x < 0.3) return 'justify-start pl-1';
    if (x > 0.7) return 'justify-end pr-1';
    return 'justify-center';
  }, [preset.position.x]);

  return (
    <div
      data-testid={`preset-preview-${preset.id}`}
      className={`w-full h-full flex ${positionClass} ${horizontalClass} bg-zinc-800 overflow-hidden`}
    >
      <span
        style={previewStyle}
        className="truncate max-w-full text-center px-0.5"
      >
        Aa
      </span>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function TextPresetPicker({
  onSelect,
  selectedPresetId,
  disabled = false,
  compact = false,
  className = '',
}: TextPresetPickerProps): JSX.Element {
  const handlePresetClick = useCallback(
    (preset: TextPreset) => {
      if (!disabled) {
        onSelect(preset);
      }
    },
    [disabled, onSelect]
  );

  const containerClasses = useMemo(
    () =>
      [
        'space-y-2',
        compact ? 'compact' : '',
        disabled ? 'opacity-50 pointer-events-none' : '',
        className,
      ]
        .filter(Boolean)
        .join(' '),
    [compact, disabled, className]
  );

  const gridClasses = useMemo(
    () =>
      ['grid', 'gap-2', compact ? 'grid-cols-4' : 'grid-cols-2'].join(' '),
    [compact]
  );

  return (
    <div
      data-testid="text-preset-picker"
      className={containerClasses}
    >
      {/* Header */}
      <div className="flex items-center gap-2 text-xs text-editor-text-muted">
        <Palette className="w-3 h-3" />
        <span>Presets</span>
      </div>

      {/* Preset Grid */}
      <div
        data-testid="preset-grid"
        className={gridClasses}
      >
        {TEXT_PRESETS.map((preset) => {
          const isSelected = selectedPresetId === preset.id;

          return (
            <button
              key={preset.id}
              data-testid={`preset-button-${preset.id}`}
              type="button"
              onClick={() => handlePresetClick(preset)}
              disabled={disabled}
              className={`
                flex flex-col overflow-hidden rounded border transition-all
                ${compact ? 'h-12' : 'h-16'}
                ${
                  isSelected
                    ? 'ring-2 ring-primary-500 border-primary-500'
                    : 'border-editor-border hover:border-primary-400'
                }
                ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
              `}
              title={preset.description}
            >
              {/* Preview */}
              <div className={`flex-1 w-full ${compact ? 'h-8' : 'h-10'}`}>
                <PresetPreview preset={preset} compact={compact} />
              </div>

              {/* Name */}
              <div
                className={`
                  w-full bg-editor-bg text-editor-text truncate text-center
                  ${compact ? 'text-[9px] py-0.5' : 'text-[10px] py-1'}
                `}
              >
                {preset.name}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default TextPresetPicker;
