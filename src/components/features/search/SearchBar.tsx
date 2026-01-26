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
// Constants
// =============================================================================

/** Maximum allowed search query length */
const MAX_QUERY_LENGTH = 500;

/** Minimum debounce delay to prevent excessive API calls */
const MIN_DEBOUNCE_MS = 50;

/** Maximum debounce delay to ensure responsiveness */
const MAX_DEBOUNCE_MS = 2000;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Sanitizes search input to prevent security issues and excessive length.
 *
 * @param input - Raw input string
 * @param trimWhitespace - Whether to trim leading/trailing whitespace (default: false)
 * @returns Sanitized string safe for display and search
 *
 * @remarks
 * - Limits length to MAX_QUERY_LENGTH
 * - Removes null bytes and control characters (except spaces, newlines, tabs)
 * - Does NOT strip HTML entities (handled by React's JSX escaping)
 * - Optionally trims whitespace (should only be done on submission, not during typing)
 */
function sanitizeSearchInput(input: string, trimWhitespace: boolean = false): string {
  if (typeof input !== 'string') {
    return '';
  }

  // Remove null bytes and control characters (except spaces, newlines, tabs)
  // Keep space (0x20), tab (0x09), and newline (0x0A, 0x0D)
  // eslint-disable-next-line no-control-regex -- Intentionally matching control characters for sanitization
  const cleaned = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Limit length and optionally trim
  const limited = cleaned.slice(0, MAX_QUERY_LENGTH);
  return trimWhitespace ? limited.trim() : limited;
}

/**
 * Validates and normalizes debounce delay.
 */
function normalizeDebounceMs(delay: number | undefined): number {
  if (typeof delay !== 'number' || !Number.isFinite(delay)) {
    return 300; // default
  }
  return Math.max(MIN_DEBOUNCE_MS, Math.min(MAX_DEBOUNCE_MS, delay));
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
  debounceMs: rawDebounceMs = 300,
  id,
  label,
  'aria-label': ariaLabel,
}: SearchBarProps) {
  // Normalize debounce delay
  const debounceMs = normalizeDebounceMs(rawDebounceMs);

  // Use controlled value if provided, otherwise use internal state
  const isControlled = controlledValue !== undefined;
  const [internalValue, setInternalValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);

  // Track mounted state for safe async updates
  const isMountedRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sanitize controlled value if provided
  const value = isControlled
    ? sanitizeSearchInput(controlledValue)
    : internalValue;

  // Track mounted state
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      // Sanitize input to prevent XSS and limit length
      const newValue = sanitizeSearchInput(e.target.value);

      if (isControlled) {
        onChange?.(newValue);
      } else {
        setInternalValue(newValue);
      }

      // Clear existing debounce timer
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      // Set up new debounce timer for onSearch
      if (onSearch) {
        debounceRef.current = setTimeout(() => {
          // Verify component is still mounted before triggering search
          if (isMountedRef.current) {
            try {
              onSearch(newValue);
            } catch (error) {
              // Defensive: Log but don't crash if search callback fails
              console.error('Search callback failed:', error);
            }
          }
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

    try {
      onClear?.();
    } catch (error) {
      // Defensive: Log but don't crash if clear callback fails
      console.error('Clear callback failed:', error);
    }

    inputRef.current?.focus();
  }, [isControlled, onChange, onClear]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Cancel pending debounced search since we're submitting immediately
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        try {
          // Trim whitespace on submission
          onSubmit?.(value.trim());
        } catch (error) {
          // Defensive: Log but don't crash if submit callback fails
          console.error('Submit callback failed:', error);
        }
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
        debounceRef.current = null;
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
        className="absolute left-3 pointer-events-none text-text-secondary"
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
        maxLength={MAX_QUERY_LENGTH}
        autoComplete="off"
        spellCheck="false"
        aria-busy={isLoading}
        aria-describedby={isLoading ? `${id}-loading` : undefined}
        className={`
          w-full pl-10 pr-8 py-2
          bg-surface-active border border-border-default rounded-lg
          text-text-primary placeholder-text-muted
          focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent
          disabled:opacity-50 disabled:cursor-not-allowed
          transition-colors duration-150
        `}
      />

      {/* Loading Indicator */}
      {isLoading && (
        <div
          id={id ? `${id}-loading` : undefined}
          data-testid="search-loading"
          className="absolute right-3 text-text-secondary"
          role="status"
          aria-label="Searching"
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
          <span className="sr-only">Searching...</span>
        </div>
      )}

      {/* Clear Button */}
      {value && !isLoading && (
        <button
          type="button"
          data-testid="search-clear-button"
          onClick={handleClear}
          className="absolute right-3 text-text-secondary hover:text-text-primary transition-colors"
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
