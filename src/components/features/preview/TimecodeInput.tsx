/**
 * Editable timecode display for Source Monitor and Program Monitor.
 * Click to enter edit mode, type SMPTE timecode (HH:MM:SS:FF), press Enter to jump.
 */

import { type FC, useState, useCallback, useRef, useEffect } from 'react';
import { formatTimecode, parseTimecode, isValidTimecode } from '@/utils/formatters';
import { PLAYBACK } from '@/constants/preview';

export interface TimecodeInputProps {
  /** Current time in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
  /** Frames per second (default: TARGET_FPS) */
  fps?: number;
  /** Callback when user enters a valid timecode to seek to */
  onSeek?: (time: number) => void;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/** Duration in ms to show the error state before auto-clearing */
const ERROR_DISPLAY_MS = 1500;

export const TimecodeInput: FC<TimecodeInputProps> = ({
  currentTime,
  duration,
  fps = PLAYBACK.TARGET_FPS,
  onSeek,
  disabled = false,
  className,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [hasError, setHasError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    return () => {
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, []);

  const showError = useCallback(() => {
    setHasError(true);
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    errorTimeoutRef.current = setTimeout(() => setHasError(false), ERROR_DISPLAY_MS);
  }, []);

  const enterEditMode = useCallback(() => {
    if (disabled) {
      return;
    }

    setEditValue(formatTimecode(currentTime, fps));
    setHasError(false);
    setIsEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.select();
    });
  }, [currentTime, disabled, fps]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditValue('');
    setHasError(false);
  }, []);

  useEffect(() => {
    if (disabled && isEditing) {
      cancelEdit();
    }
  }, [cancelEdit, disabled, isEditing]);

  const confirmEdit = useCallback(() => {
    if (disabled) {
      return;
    }

    const trimmed = editValue.trim();

    if (!isValidTimecode(trimmed, fps)) {
      showError();
      return;
    }

    const targetTime = parseTimecode(trimmed, fps);

    if (targetTime > duration) {
      showError();
      return;
    }

    onSeek?.(targetTime);
    setIsEditing(false);
    setEditValue('');
    setHasError(false);
  }, [disabled, editValue, fps, duration, onSeek, showError]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Prevent parent keyboard handlers (JKL shuttle, transport, etc.)
      e.stopPropagation();

      if (e.key === 'Enter') {
        e.preventDefault();
        confirmEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    },
    [confirmEdit, cancelEdit],
  );

  const handleBlur = useCallback(() => {
    cancelEdit();
  }, [cancelEdit]);

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        data-testid="timecode-input"
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={`w-[90px] bg-black/60 text-center font-mono text-xs outline-none border ${
          hasError ? 'border-red-500 text-red-400' : 'border-cyan-500 text-white'
        } rounded px-1 py-0.5 ${className ?? ''}`}
        aria-invalid={hasError}
        aria-label="Enter timecode"
        maxLength={11}
        placeholder="HH:MM:SS:FF"
        disabled={disabled}
        autoFocus
      />
    );
  }

  return (
    <button
      type="button"
      data-testid="timecode-display"
      onClick={enterEditMode}
      className={`font-mono text-xs text-gray-400 transition-colors disabled:cursor-not-allowed disabled:text-gray-600 ${disabled ? '' : 'cursor-text hover:text-white'} ${className ?? ''}`}
      aria-label="Click to enter timecode"
      title="Click to enter timecode (HH:MM:SS:FF)"
      disabled={disabled}
    >
      {formatTimecode(currentTime, fps)}
    </button>
  );
};
