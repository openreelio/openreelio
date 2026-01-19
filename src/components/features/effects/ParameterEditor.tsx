/**
 * ParameterEditor Component
 *
 * Renders appropriate control for editing an effect parameter based on its type.
 * Supports float sliders, integer inputs, boolean toggles, and more.
 */

import { useCallback, useMemo, useState, useEffect } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ParamDef, ParamValue, SimpleParamValue } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface ParameterEditorProps {
  /** Parameter definition with constraints */
  paramDef: ParamDef;
  /** Current value */
  value: SimpleParamValue;
  /** Callback when value changes */
  onChange: (paramName: string, value: SimpleParamValue) => void;
  /** Whether the editor is read-only */
  readOnly?: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract simple value from ParamValue
 */
function getDefaultSimpleValue(paramValue: ParamValue): SimpleParamValue {
  switch (paramValue.type) {
    case 'float':
    case 'int':
      return paramValue.value;
    case 'bool':
      return paramValue.value;
    case 'string':
      return paramValue.value;
    case 'color':
      return paramValue.value;
    case 'point':
    case 'range':
      return paramValue.value;
    default:
      return 0;
  }
}

/**
 * Check if value is different from default
 */
function isDifferentFromDefault(value: SimpleParamValue, defaultValue: ParamValue): boolean {
  const defaultSimple = getDefaultSimpleValue(defaultValue);

  if (typeof value !== typeof defaultSimple) return true;

  if (Array.isArray(value) && Array.isArray(defaultSimple)) {
    return value.length !== defaultSimple.length ||
      value.some((v, i) => v !== defaultSimple[i]);
  }

  return value !== defaultSimple;
}

/**
 * Determine if parameter is a boolean type
 */
function isBooleanParam(paramDef: ParamDef): boolean {
  return paramDef.default.type === 'bool';
}

/**
 * Determine if parameter is an integer type
 */
function isIntegerParam(paramDef: ParamDef): boolean {
  return paramDef.default.type === 'int';
}

/**
 * Clamp value to min/max range
 */
function clampValue(value: number, min?: number, max?: number): number {
  let result = value;
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
}

// =============================================================================
// Component
// =============================================================================

export function ParameterEditor({
  paramDef,
  value,
  onChange,
  readOnly = false,
}: ParameterEditorProps): JSX.Element {
  const isBoolean = isBooleanParam(paramDef);
  const isInteger = isIntegerParam(paramDef);

  const showResetButton = useMemo(
    () => isDifferentFromDefault(value, paramDef.default),
    [value, paramDef.default]
  );

  // Handle numeric value change
  const handleNumericChange = useCallback(
    (newValue: number) => {
      // Clamp to range
      let clamped = clampValue(newValue, paramDef.min, paramDef.max);

      // Round to integer if needed
      if (isInteger) {
        clamped = Math.round(clamped);
      }

      onChange(paramDef.name, clamped);
    },
    [paramDef.name, paramDef.min, paramDef.max, isInteger, onChange]
  );

  // Handle boolean toggle
  const handleBooleanChange = useCallback(
    (newValue: boolean) => {
      onChange(paramDef.name, newValue);
    },
    [paramDef.name, onChange]
  );

  // Handle reset to default
  const handleReset = useCallback(() => {
    const defaultValue = getDefaultSimpleValue(paramDef.default);
    onChange(paramDef.name, defaultValue);
  }, [paramDef.name, paramDef.default, onChange]);

  // Render boolean toggle
  if (isBoolean) {
    const checked = Boolean(value);
    const inputId = `param-${paramDef.name}`;

    return (
      <div className="flex items-center justify-between py-1.5">
        <label htmlFor={inputId} className="text-sm text-editor-text">{paramDef.label}</label>
        <div className="flex items-center gap-2">
          <input
            id={inputId}
            type="checkbox"
            checked={checked}
            onChange={(e) => handleBooleanChange(e.target.checked)}
            disabled={readOnly}
            className="w-4 h-4 accent-primary-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          />
          {showResetButton && !readOnly && (
            <button
              data-testid="reset-button"
              onClick={handleReset}
              className="p-0.5 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
              title="Reset to default"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  }

  // Render numeric slider + input
  const numericValue = typeof value === 'number' ? value : 0;
  const min = paramDef.min ?? 0;
  const max = paramDef.max ?? 100;
  const step = paramDef.step ?? (isInteger ? 1 : 0.01);
  const inputId = `param-${paramDef.name}`;
  const sliderId = `param-slider-${paramDef.name}`;

  // Local state for text input to allow typing negative/decimal values
  // (e.g., "-" or "0." which would be invalid as immediate numbers)
  const [inputText, setInputText] = useState(String(numericValue));
  const [isEditing, setIsEditing] = useState(false);

  // Sync local text with external value when not editing
  useEffect(() => {
    if (!isEditing) {
      setInputText(String(numericValue));
    }
  }, [numericValue, isEditing]);

  // Commit the text input value
  const commitInputValue = useCallback(() => {
    const parsed = parseFloat(inputText);
    if (!Number.isNaN(parsed)) {
      handleNumericChange(parsed);
    } else {
      // Reset to current value if invalid
      setInputText(String(numericValue));
    }
    setIsEditing(false);
  }, [inputText, numericValue, handleNumericChange]);

  // Handle key down for Enter key
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        commitInputValue();
        e.currentTarget.blur();
      }
    },
    [commitInputValue]
  );

  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={inputId} className="text-sm text-editor-text">{paramDef.label}</label>
        <div className="flex items-center gap-2">
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            value={inputText}
            onChange={(e) => {
              setIsEditing(true);
              setInputText(e.target.value);
            }}
            onFocus={() => setIsEditing(true)}
            onBlur={commitInputValue}
            onKeyDown={handleKeyDown}
            disabled={readOnly}
            aria-describedby={sliderId}
            className="w-16 px-1.5 py-0.5 text-sm text-right bg-editor-bg border border-editor-border rounded text-editor-text disabled:opacity-50 disabled:cursor-not-allowed"
          />
          {showResetButton && !readOnly && (
            <button
              data-testid="reset-button"
              onClick={handleReset}
              className="p-0.5 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
              title="Reset to default"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <input
        id={sliderId}
        type="range"
        value={numericValue}
        onChange={(e) => handleNumericChange(parseFloat(e.target.value))}
        min={min}
        max={max}
        step={step}
        disabled={readOnly}
        aria-label={`${paramDef.label} slider`}
        className="w-full h-1.5 bg-editor-border rounded-lg appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed accent-primary-500"
      />
    </div>
  );
}
