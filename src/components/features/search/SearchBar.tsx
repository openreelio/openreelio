/**
 * SearchBar Component
 *
 * A search input component with debouncing, clear button, loading state,
 * and keyboard shortcuts support.
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type ChangeEvent,
  type KeyboardEvent,
  type FocusEvent,
} from 'react';

// =============================================================================
// Types
// =============================================================================

export interface SearchBarProps {
  /** Current search value (controlled) */
  value?: string;
  /** Callback when value changes (for controlled mode) */
  onChange?: (value: string) => void;
  /** Callback when search is triggered (debounced) */
  onSearch?: (query: string) => void;
  /** Callback when search is submitted (Enter key) */
  onSubmit?: (query: string) => void;
  /** Callback when input is cleared */
  onClear?: () => void;
  /** Callback when input is focused */
  onFocus?: (event: FocusEvent<HTMLInputElement>) => void;
  /** Callback when input loses focus */
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Additional CSS classes */
  className?: string;
  /** Whether search is in progress */
  isLoading?: boolean;
  /** Whether input is disabled */
  disabled?: boolean;
  /** Debounce delay in milliseconds */
  debounceMs?: number;
  /** Input ID for label association */
  id?: string;
  /** Label text (for accessibility) */
  label?: string;
  /** ARIA label */
  'aria-label'?: string;
}

// =============================================================================
// Component
// =============================================================================

export function SearchBar({
  value: controlledValue,
  onChange,
  onSearch,
  onSubmit,
  onClear,
  onFocus,
  onBlur,
  placeholder = 'Search...',
  className = '',
  isLoading = false,
  disabled = false,
  debounceMs = 300,
  id,
  label,
  'aria-label': ariaLabel,
}: SearchBarProps) {
  // Use controlled value if provided, otherwise use internal state
  const isControlled = controlledValue !== undefined;
  const [internalValue, setInternalValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const value = isControlled ? controlledValue : internalValue;

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;

      if (isControlled) {
        onChange?.(newValue);
      } else {
        setInternalValue(newValue);
      }

      // Clear existing debounce timer
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      // Set up new debounce timer for onSearch
      if (onSearch) {
        debounceRef.current = setTimeout(() => {
          onSearch(newValue);
        }, debounceMs);
      }
    },
    [isControlled, onChange, onSearch, debounceMs]
  );

  const handleClear = useCallback(() => {
    if (isControlled) {
      onChange?.('');
    } else {
      setInternalValue('');
    }

    // Clear debounce timer
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    onClear?.();
    inputRef.current?.focus();
  }, [isControlled, onChange, onClear]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onSubmit?.(value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClear();
      }
    },
    [value, onSubmit, handleClear]
  );

  const handleFocus = useCallback(
    (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      onFocus?.(e);
    },
    [onFocus]
  );

  const handleBlur = useCallback(
    (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(false);
      onBlur?.(e);
    },
    [onBlur]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="search-bar"
      data-focused={isFocused ? 'true' : undefined}
      className={`relative flex items-center ${className}`}
    >
      {/* Label (visually hidden if no visible label) */}
      {label && (
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
      )}

      {/* Search Icon */}
      <div
        data-testid="search-icon"
        className="absolute left-3 pointer-events-none text-gray-400"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      </div>

      {/* Input */}
      <input
        ref={inputRef}
        id={id}
        type="search"
        role="searchbox"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        className={`
          w-full pl-10 pr-8 py-2
          bg-gray-800 border border-gray-700 rounded-lg
          text-white placeholder-gray-500
          focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
          disabled:opacity-50 disabled:cursor-not-allowed
          transition-colors duration-150
        `}
      />

      {/* Loading Indicator */}
      {isLoading && (
        <div
          data-testid="search-loading"
          className="absolute right-3 text-gray-400"
        >
          <svg
            className="w-4 h-4 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </div>
      )}

      {/* Clear Button */}
      {value && !isLoading && (
        <button
          type="button"
          data-testid="search-clear-button"
          onClick={handleClear}
          className="absolute right-3 text-gray-400 hover:text-white transition-colors"
          aria-label="Clear search"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
