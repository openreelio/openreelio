/**
 * TextInspector Component
 *
 * Property inspector panel for text clips.
 * Provides comprehensive text editing with styling controls.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  Type,
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Eye,
  EyeOff,
  RotateCcw,
  Palette,
  Square,
  Box,
  Sun,
} from 'lucide-react';
import type {
  TextClipData,
  TextStyle,
  TextShadow,
  TextOutline,
  TextPosition,
  TextClipAlignment,
  ClipId,
} from '@/types';
import {
  DEFAULT_TEXT_STYLE,
  DEFAULT_TEXT_POSITION,
  DEFAULT_TEXT_SHADOW,
  DEFAULT_TEXT_OUTLINE,
  isValidHexColor,
} from '@/types';

// =============================================================================
// Types
// =============================================================================

/** Selected text clip data for inspector */
export interface SelectedTextClip {
  /** Clip ID */
  id: ClipId;
  /** Text content and styling */
  textData: TextClipData;
  /** Timeline position */
  timelineInSec: number;
  /** Duration */
  durationSec: number;
}

/** TextInspector component props */
export interface TextInspectorProps {
  /** Selected text clip */
  selectedTextClip: SelectedTextClip;
  /** Callback when text data changes */
  onTextDataChange: (clipId: ClipId, textData: TextClipData) => void;
  /** Whether the panel is read-only */
  readOnly?: boolean;
}

// =============================================================================
// Sub-components
// =============================================================================

interface SectionProps {
  title: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  collapsible?: boolean;
  defaultExpanded?: boolean;
}

function Section({
  title,
  children,
  icon,
  collapsible = true,
  defaultExpanded = true,
}: SectionProps): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="border-b border-editor-border last:border-b-0">
      <button
        type="button"
        className="flex items-center justify-between w-full py-3 text-left text-sm font-medium text-editor-text hover:text-primary-500 transition-colors"
        onClick={() => collapsible && setIsExpanded(!isExpanded)}
        disabled={!collapsible}
      >
        <span className="flex items-center gap-2">
          {icon}
          {title}
        </span>
        {collapsible && (
          <span className="text-editor-text-muted text-xs">
            {isExpanded ? '-' : '+'}
          </span>
        )}
      </button>
      {isExpanded && <div className="pb-4 space-y-3">{children}</div>}
    </div>
  );
}

interface ColorInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  showAlpha?: boolean;
  disabled?: boolean;
}

function ColorInput({
  label,
  value,
  onChange,
  disabled = false,
}: ColorInputProps): JSX.Element {
  const [localValue, setLocalValue] = useState(value);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleChange = useCallback(
    (newValue: string) => {
      setLocalValue(newValue);
      if (isValidHexColor(newValue) || newValue === '') {
        onChange(newValue);
      }
    },
    [onChange]
  );

  return (
    <div className="flex items-center justify-between">
      <label className="text-xs text-editor-text-muted">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={localValue || '#FFFFFF'}
          onChange={(e) => handleChange(e.target.value)}
          disabled={disabled}
          className="w-8 h-8 rounded border border-editor-border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <input
          type="text"
          value={localValue}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="#FFFFFF"
          disabled={disabled}
          className="w-20 px-2 py-1 text-xs bg-editor-input border border-editor-border rounded text-editor-text placeholder-editor-text-muted focus:border-primary-500 focus:outline-none disabled:opacity-50"
        />
      </div>
    </div>
  );
}

interface NumberInputProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  disabled = false,
}: NumberInputProps): JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <label className="text-xs text-editor-text-muted">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          className="w-16 px-2 py-1 text-xs bg-editor-input border border-editor-border rounded text-editor-text text-right focus:border-primary-500 focus:outline-none disabled:opacity-50"
        />
        {unit && <span className="text-xs text-editor-text-muted">{unit}</span>}
      </div>
    </div>
  );
}

interface SliderInputProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
}

function SliderInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
  disabled = false,
}: SliderInputProps): JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs text-editor-text-muted">{label}</label>
        <span className="text-xs text-editor-text">{(value * 100).toFixed(0)}%</span>
      </div>
      <input
        type="range"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="w-full h-2 bg-editor-input rounded-lg appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function TextInspector({
  selectedTextClip,
  onTextDataChange,
  readOnly = false,
}: TextInspectorProps): JSX.Element {
  // ===========================================================================
  // Local State
  // ===========================================================================

  const [localTextData, setLocalTextData] = useState<TextClipData>(
    selectedTextClip.textData
  );

  // Sync local state with prop changes
  useEffect(() => {
    setLocalTextData(selectedTextClip.textData);
  }, [selectedTextClip.textData]);

  // ===========================================================================
  // Computed Values
  // ===========================================================================

  const hasShadow = useMemo(() => !!localTextData.shadow, [localTextData.shadow]);
  const hasOutline = useMemo(() => !!localTextData.outline, [localTextData.outline]);
  const hasBackground = useMemo(
    () => !!localTextData.style.backgroundColor,
    [localTextData.style.backgroundColor]
  );

  // ===========================================================================
  // Update Handlers
  // ===========================================================================

  const updateTextData = useCallback(
    (updates: Partial<TextClipData>) => {
      const newTextData = { ...localTextData, ...updates };
      setLocalTextData(newTextData);
      onTextDataChange(selectedTextClip.id, newTextData);
    },
    [localTextData, selectedTextClip.id, onTextDataChange]
  );

  const updateStyle = useCallback(
    (updates: Partial<TextStyle>) => {
      updateTextData({
        style: { ...localTextData.style, ...updates },
      });
    },
    [localTextData.style, updateTextData]
  );

  const updatePosition = useCallback(
    (updates: Partial<TextPosition>) => {
      updateTextData({
        position: { ...localTextData.position, ...updates },
      });
    },
    [localTextData.position, updateTextData]
  );

  const updateShadow = useCallback(
    (updates: Partial<TextShadow>) => {
      const currentShadow = localTextData.shadow || DEFAULT_TEXT_SHADOW;
      updateTextData({
        shadow: { ...currentShadow, ...updates },
      });
    },
    [localTextData.shadow, updateTextData]
  );

  const updateOutline = useCallback(
    (updates: Partial<TextOutline>) => {
      const currentOutline = localTextData.outline || DEFAULT_TEXT_OUTLINE;
      updateTextData({
        outline: { ...currentOutline, ...updates },
      });
    },
    [localTextData.outline, updateTextData]
  );

  // ===========================================================================
  // Toggle Handlers
  // ===========================================================================

  const toggleShadow = useCallback(() => {
    if (hasShadow) {
      updateTextData({ shadow: undefined });
    } else {
      updateTextData({ shadow: { ...DEFAULT_TEXT_SHADOW } });
    }
  }, [hasShadow, updateTextData]);

  const toggleOutline = useCallback(() => {
    if (hasOutline) {
      updateTextData({ outline: undefined });
    } else {
      updateTextData({ outline: { ...DEFAULT_TEXT_OUTLINE } });
    }
  }, [hasOutline, updateTextData]);

  const toggleBackground = useCallback(() => {
    if (hasBackground) {
      updateStyle({ backgroundColor: undefined });
    } else {
      updateStyle({ backgroundColor: '#000000' });
    }
  }, [hasBackground, updateStyle]);

  // ===========================================================================
  // Reset Handler
  // ===========================================================================

  const handleReset = useCallback(() => {
    const resetData: TextClipData = {
      content: localTextData.content,
      style: { ...DEFAULT_TEXT_STYLE },
      position: { ...DEFAULT_TEXT_POSITION },
      rotation: 0,
      opacity: 1.0,
    };
    setLocalTextData(resetData);
    onTextDataChange(selectedTextClip.id, resetData);
  }, [localTextData.content, selectedTextClip.id, onTextDataChange]);

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="text-inspector"
      role="complementary"
      aria-label="Text properties inspector"
      className="p-4 overflow-y-auto"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-editor-text flex items-center gap-2">
          <Type className="w-4 h-4 text-primary-500" />
          Text Properties
        </h3>
        <button
          type="button"
          onClick={handleReset}
          disabled={readOnly}
          className="p-1.5 text-editor-text-muted hover:text-primary-500 rounded transition-colors disabled:opacity-50"
          title="Reset to defaults"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      {/* Content Section */}
      <Section title="Content" icon={<Type className="w-4 h-4" />} collapsible={false}>
        <textarea
          value={localTextData.content}
          onChange={(e) => updateTextData({ content: e.target.value })}
          placeholder="Enter text..."
          disabled={readOnly}
          className="w-full h-24 px-3 py-2 bg-editor-input border border-editor-border rounded text-sm text-editor-text placeholder-editor-text-muted focus:border-primary-500 focus:outline-none resize-none disabled:opacity-50"
          data-testid="text-content-input"
        />
      </Section>

      {/* Font Section */}
      <Section title="Font" icon={<Type className="w-4 h-4" />}>
        <div className="space-y-3">
          {/* Font Family */}
          <div className="flex items-center justify-between">
            <label className="text-xs text-editor-text-muted">Family</label>
            <select
              value={localTextData.style.fontFamily}
              onChange={(e) => updateStyle({ fontFamily: e.target.value })}
              disabled={readOnly}
              className="w-32 px-2 py-1 text-xs bg-editor-input border border-editor-border rounded text-editor-text focus:border-primary-500 focus:outline-none disabled:opacity-50"
            >
              <option value="Arial">Arial</option>
              <option value="Helvetica">Helvetica</option>
              <option value="Verdana">Verdana</option>
              <option value="Georgia">Georgia</option>
              <option value="Times New Roman">Times New Roman</option>
              <option value="Courier New">Courier New</option>
              <option value="Impact">Impact</option>
            </select>
          </div>

          {/* Font Size */}
          <NumberInput
            label="Size"
            value={localTextData.style.fontSize}
            onChange={(value) => updateStyle({ fontSize: Math.max(1, value) })}
            min={1}
            max={500}
            unit="pt"
            disabled={readOnly}
          />

          {/* Font Style Toggles */}
          <div className="flex items-center justify-between">
            <label className="text-xs text-editor-text-muted">Style</label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => updateStyle({ bold: !localTextData.style.bold })}
                disabled={readOnly}
                className={`p-1.5 rounded border transition-colors ${
                  localTextData.style.bold
                    ? 'bg-primary-500 border-primary-500 text-white'
                    : 'bg-editor-input border-editor-border text-editor-text-muted hover:border-primary-500'
                } disabled:opacity-50`}
                title="Bold"
              >
                <Bold className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => updateStyle({ italic: !localTextData.style.italic })}
                disabled={readOnly}
                className={`p-1.5 rounded border transition-colors ${
                  localTextData.style.italic
                    ? 'bg-primary-500 border-primary-500 text-white'
                    : 'bg-editor-input border-editor-border text-editor-text-muted hover:border-primary-500'
                } disabled:opacity-50`}
                title="Italic"
              >
                <Italic className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => updateStyle({ underline: !localTextData.style.underline })}
                disabled={readOnly}
                className={`p-1.5 rounded border transition-colors ${
                  localTextData.style.underline
                    ? 'bg-primary-500 border-primary-500 text-white'
                    : 'bg-editor-input border-editor-border text-editor-text-muted hover:border-primary-500'
                } disabled:opacity-50`}
                title="Underline"
              >
                <Underline className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Text Alignment */}
          <div className="flex items-center justify-between">
            <label className="text-xs text-editor-text-muted">Alignment</label>
            <div className="flex gap-1">
              {(['left', 'center', 'right'] as TextClipAlignment[]).map((alignment) => (
                <button
                  key={alignment}
                  type="button"
                  onClick={() => updateStyle({ alignment })}
                  disabled={readOnly}
                  className={`p-1.5 rounded border transition-colors ${
                    localTextData.style.alignment === alignment
                      ? 'bg-primary-500 border-primary-500 text-white'
                      : 'bg-editor-input border-editor-border text-editor-text-muted hover:border-primary-500'
                  } disabled:opacity-50`}
                  title={`Align ${alignment}`}
                >
                  {alignment === 'left' && <AlignLeft className="w-4 h-4" />}
                  {alignment === 'center' && <AlignCenter className="w-4 h-4" />}
                  {alignment === 'right' && <AlignRight className="w-4 h-4" />}
                </button>
              ))}
            </div>
          </div>

          {/* Line Height */}
          <NumberInput
            label="Line Height"
            value={localTextData.style.lineHeight}
            onChange={(value) => updateStyle({ lineHeight: Math.max(0.5, value) })}
            min={0.5}
            max={3}
            step={0.1}
            disabled={readOnly}
          />

          {/* Letter Spacing */}
          <NumberInput
            label="Letter Spacing"
            value={localTextData.style.letterSpacing}
            onChange={(value) => updateStyle({ letterSpacing: value })}
            min={-10}
            max={50}
            unit="px"
            disabled={readOnly}
          />
        </div>
      </Section>

      {/* Color Section */}
      <Section title="Color" icon={<Palette className="w-4 h-4" />}>
        <div className="space-y-3">
          <ColorInput
            label="Text Color"
            value={localTextData.style.color}
            onChange={(value) => updateStyle({ color: value || '#FFFFFF' })}
            disabled={readOnly}
          />

          {/* Background Toggle & Color */}
          <div className="flex items-center justify-between">
            <label className="text-xs text-editor-text-muted">Background</label>
            <button
              type="button"
              onClick={toggleBackground}
              disabled={readOnly}
              className={`p-1.5 rounded border transition-colors ${
                hasBackground
                  ? 'bg-primary-500 border-primary-500 text-white'
                  : 'bg-editor-input border-editor-border text-editor-text-muted hover:border-primary-500'
              } disabled:opacity-50`}
              title={hasBackground ? 'Remove background' : 'Add background'}
            >
              {hasBackground ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </button>
          </div>

          {hasBackground && (
            <>
              <ColorInput
                label="Background Color"
                value={localTextData.style.backgroundColor || '#000000'}
                onChange={(value) => updateStyle({ backgroundColor: value })}
                disabled={readOnly}
              />
              <NumberInput
                label="Background Padding"
                value={localTextData.style.backgroundPadding}
                onChange={(value) => updateStyle({ backgroundPadding: Math.max(0, value) })}
                min={0}
                max={100}
                unit="px"
                disabled={readOnly}
              />
            </>
          )}
        </div>
      </Section>

      {/* Position Section */}
      <Section title="Position" icon={<Box className="w-4 h-4" />}>
        <div className="space-y-3">
          <SliderInput
            label="Horizontal (X)"
            value={localTextData.position.x}
            onChange={(value) => updatePosition({ x: value })}
            min={0}
            max={1}
            disabled={readOnly}
          />
          <SliderInput
            label="Vertical (Y)"
            value={localTextData.position.y}
            onChange={(value) => updatePosition({ y: value })}
            min={0}
            max={1}
            disabled={readOnly}
          />
          <NumberInput
            label="Rotation"
            value={localTextData.rotation}
            onChange={(value) => updateTextData({ rotation: value })}
            min={-180}
            max={180}
            unit="deg"
            disabled={readOnly}
          />
          <SliderInput
            label="Opacity"
            value={localTextData.opacity}
            onChange={(value) => updateTextData({ opacity: value })}
            min={0}
            max={1}
            disabled={readOnly}
          />
        </div>
      </Section>

      {/* Shadow Section */}
      <Section title="Shadow" icon={<Sun className="w-4 h-4" />}>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs text-editor-text-muted">Enable Shadow</label>
            <button
              type="button"
              onClick={toggleShadow}
              title={hasShadow ? 'Disable shadow' : 'Enable shadow'}
              aria-label={hasShadow ? 'Disable shadow' : 'Enable shadow'}
              disabled={readOnly}
              className={`p-1.5 rounded border transition-colors ${
                hasShadow
                  ? 'bg-primary-500 border-primary-500 text-white'
                  : 'bg-editor-input border-editor-border text-editor-text-muted hover:border-primary-500'
              } disabled:opacity-50`}
            >
              {hasShadow ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </button>
          </div>

          {hasShadow && localTextData.shadow && (
            <>
              <ColorInput
                label="Shadow Color"
                value={localTextData.shadow.color}
                onChange={(value) => updateShadow({ color: value || '#000000' })}
                disabled={readOnly}
              />
              <NumberInput
                label="Offset X"
                value={localTextData.shadow.offsetX}
                onChange={(value) => updateShadow({ offsetX: value })}
                min={-50}
                max={50}
                unit="px"
                disabled={readOnly}
              />
              <NumberInput
                label="Offset Y"
                value={localTextData.shadow.offsetY}
                onChange={(value) => updateShadow({ offsetY: value })}
                min={-50}
                max={50}
                unit="px"
                disabled={readOnly}
              />
              <NumberInput
                label="Blur"
                value={localTextData.shadow.blur}
                onChange={(value) => updateShadow({ blur: Math.max(0, value) })}
                min={0}
                max={50}
                unit="px"
                disabled={readOnly}
              />
            </>
          )}
        </div>
      </Section>

      {/* Outline Section */}
      <Section title="Outline" icon={<Square className="w-4 h-4" />}>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs text-editor-text-muted">Enable Outline</label>
            <button
              type="button"
              onClick={toggleOutline}
              title={hasOutline ? 'Disable outline' : 'Enable outline'}
              aria-label={hasOutline ? 'Disable outline' : 'Enable outline'}
              disabled={readOnly}
              className={`p-1.5 rounded border transition-colors ${
                hasOutline
                  ? 'bg-primary-500 border-primary-500 text-white'
                  : 'bg-editor-input border-editor-border text-editor-text-muted hover:border-primary-500'
              } disabled:opacity-50`}
            >
              {hasOutline ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </button>
          </div>

          {hasOutline && localTextData.outline && (
            <>
              <ColorInput
                label="Outline Color"
                value={localTextData.outline.color}
                onChange={(value) => updateOutline({ color: value || '#000000' })}
                disabled={readOnly}
              />
              <NumberInput
                label="Width"
                value={localTextData.outline.width}
                onChange={(value) => updateOutline({ width: Math.max(0, value) })}
                min={0}
                max={20}
                unit="px"
                disabled={readOnly}
              />
            </>
          )}
        </div>
      </Section>
    </div>
  );
}

export default TextInspector;
