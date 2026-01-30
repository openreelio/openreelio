/**
 * ParameterEditor Component
 *
 * Renders appropriate control for editing an effect parameter based on its type.
 * Supports float sliders, integer inputs, boolean toggles, select dropdowns,
 * file pickers, and text inputs.
 */

import { useCallback, useMemo, useState, useEffect } from 'react';
import { RotateCcw, Folder, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
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
 * Determine if parameter is a string type
 */
function isStringParam(paramDef: ParamDef): boolean {
  return paramDef.default.type === 'string';
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
  const isString = isStringParam(paramDef);

  // Compute numeric values (used for non-boolean params, but computed always for hooks)
  const numericValue = typeof value === 'number' ? value : 0;
  const stringValue = typeof value === 'string' ? value : '';

  // All hooks must be called unconditionally at the top level
  const showResetButton = useMemo(
    () => isDifferentFromDefault(value, paramDef.default),
    [value, paramDef.default]
  );

  // Local state for text input to allow typing negative/decimal values
  // (e.g., "-" or "0." which would be invalid as immediate numbers)
  const [inputText, setInputText] = useState(String(numericValue));
  const [isEditing, setIsEditing] = useState(false);

  // Local state for string text input
  const [textInputValue, setTextInputValue] = useState(stringValue);
  const [isEditingText, setIsEditingText] = useState(false);

  // Sync local text with external value when not editing
  useEffect(() => {
    if (!isEditing && !isBoolean && !isString) {
      setInputText(String(numericValue));
    }
  }, [numericValue, isEditing, isBoolean, isString]);

  // Sync text input with external string value when not editing
  useEffect(() => {
    if (!isEditingText && isString) {
      setTextInputValue(stringValue);
    }
  }, [stringValue, isEditingText, isString]);

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

  // Handle string change
  const handleStringChange = useCallback(
    (newValue: string) => {
      onChange(paramDef.name, newValue);
    },
    [paramDef.name, onChange]
  );

  // Handle reset to default
  const handleReset = useCallback(() => {
    const defaultValue = getDefaultSimpleValue(paramDef.default);
    onChange(paramDef.name, defaultValue);
  }, [paramDef.name, paramDef.default, onChange]);

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

  // Commit the string text input value
  const commitTextInputValue = useCallback(() => {
    handleStringChange(textInputValue);
    setIsEditingText(false);
  }, [textInputValue, handleStringChange]);

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

  // Handle key down for text input
  const handleTextKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        commitTextInputValue();
        e.currentTarget.blur();
      }
    },
    [commitTextInputValue]
  );

  // Handle file browse
  const handleFileBrowse = useCallback(async () => {
    try {
      const extensions = paramDef.fileExtensions ?? [];
      const result = await open({
        multiple: false,
        filters: extensions.length > 0
          ? [{ name: paramDef.label, extensions }]
          : undefined,
      });

      if (result && typeof result === 'string') {
        onChange(paramDef.name, result);
      }
    } catch {
      // User cancelled or error
    }
  }, [paramDef.name, paramDef.label, paramDef.fileExtensions, onChange]);

  // Handle file clear
  const handleFileClear = useCallback(() => {
    onChange(paramDef.name, '');
  }, [paramDef.name, onChange]);

  const inputId = `param-${paramDef.name}`;

  // -------------------------------------------------------------------------
  // Render boolean toggle
  // -------------------------------------------------------------------------
  if (isBoolean) {
    const checked = Boolean(value);

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

  // -------------------------------------------------------------------------
  // Render select dropdown
  // -------------------------------------------------------------------------
  if (isString && paramDef.inputType === 'select' && paramDef.options) {
    return (
      <div className="flex items-center justify-between py-1.5">
        <label htmlFor={inputId} className="text-sm text-editor-text">{paramDef.label}</label>
        <div className="flex items-center gap-2">
          <select
            id={inputId}
            value={stringValue}
            onChange={(e) => handleStringChange(e.target.value)}
            disabled={readOnly}
            className="px-2 py-0.5 text-sm bg-editor-bg border border-editor-border rounded text-editor-text disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {paramDef.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
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

  // -------------------------------------------------------------------------
  // Render file picker
  // -------------------------------------------------------------------------
  if (isString && paramDef.inputType === 'file') {
    const hasFile = stringValue.length > 0;

    return (
      <div className="py-1.5">
        <div className="flex items-center justify-between mb-1">
          <label htmlFor={inputId} className="text-sm text-editor-text">{paramDef.label}</label>
          <div className="flex items-center gap-1">
            {hasFile && !readOnly && (
              <button
                onClick={handleFileClear}
                className="p-0.5 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
                title="Clear file"
                aria-label="Clear file"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
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
        <div className="flex items-center gap-2">
          <input
            id={inputId}
            type="text"
            value={stringValue}
            onChange={(e) => handleStringChange(e.target.value)}
            disabled={readOnly}
            readOnly
            placeholder="No file selected"
            className="flex-1 px-2 py-1 text-sm bg-editor-bg border border-editor-border rounded text-editor-text truncate disabled:opacity-50"
          />
          <button
            onClick={handleFileBrowse}
            disabled={readOnly}
            className="flex items-center gap-1 px-2 py-1 text-sm bg-editor-bg border border-editor-border rounded text-editor-text hover:bg-editor-border disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Browse files"
          >
            <Folder className="w-3.5 h-3.5" />
            Browse
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render text input for string params without special inputType
  // -------------------------------------------------------------------------
  if (isString) {
    return (
      <div className="py-1.5">
        <div className="flex items-center justify-between mb-1">
          <label htmlFor={inputId} className="text-sm text-editor-text">{paramDef.label}</label>
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
        <input
          id={inputId}
          type="text"
          value={textInputValue}
          onChange={(e) => {
            setIsEditingText(true);
            setTextInputValue(e.target.value);
          }}
          onFocus={() => setIsEditingText(true)}
          onBlur={commitTextInputValue}
          onKeyDown={handleTextKeyDown}
          disabled={readOnly}
          className="w-full px-2 py-1 text-sm bg-editor-bg border border-editor-border rounded text-editor-text disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render numeric slider + input
  // -------------------------------------------------------------------------
  const min = paramDef.min ?? 0;
  const max = paramDef.max ?? 100;
  const step = paramDef.step ?? (isInteger ? 1 : 0.01);
  const sliderId = `param-slider-${paramDef.name}`;

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
