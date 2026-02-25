/**
 * PromptInput
 *
 * Enhanced prompt input with:
 * - @ mentions for assets, clips, tracks, and context shortcuts
 * - / commands for common workflows
 * - Auto-resize textarea (1-6 rows)
 * - Enter to send, Shift+Enter for newline
 */

import { useCallback, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import { MentionPopover } from './MentionPopover';
import { CommandPopover } from './CommandPopover';
import { useMentionAndCommand } from '@/hooks/useMentionAndCommand';

// =============================================================================
// Types
// =============================================================================

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const TEXTAREA_MIN_ROWS = 1;
const TEXTAREA_MAX_ROWS = 6;
const TEXTAREA_LINE_HEIGHT = 20;

// =============================================================================
// Component
// =============================================================================

export function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = 'Ask the AI to edit your video...',
  disabled = false,
  className = '',
}: PromptInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    popover,
    detectTrigger,
    handleMentionSelect,
    handleCommandSelect,
    closePopover,
  } = useMentionAndCommand(textareaRef, value, onChange);

  // Auto-resize textarea
  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const minHeight = TEXTAREA_LINE_HEIGHT * TEXTAREA_MIN_ROWS;
    const maxHeight = TEXTAREA_LINE_HEIGHT * TEXTAREA_MAX_ROWS;
    const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${newHeight}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [value, resizeTextarea]);

  // Focus on mount
  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange],
  );

  // Detect triggers on input change and cursor movement
  useEffect(() => {
    detectTrigger();
  }, [value, detectTrigger]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // When a popover is open, intercept keys that the popover should handle
      // and explicitly prevent the textarea from acting on them.
      if (popover.type) {
        if (['ArrowDown', 'ArrowUp', 'Tab', 'Escape'].includes(e.key)) {
          // The popover's capture-phase listener will handle these.
          // We must NOT call preventDefault here so the popover listener fires.
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          // The popover handles Enter for item selection in capture phase.
          // Block the textarea from interpreting Enter as a submit or newline.
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Normal Enter = submit (only when no popover is open)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    },
    [onSubmit, popover.type],
  );

  // Compute popover position relative to container
  const popoverPosition = {
    top: -(containerRef.current?.offsetHeight ?? 0) - 8,
    left: 0,
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Mention Popover */}
      <MentionPopover
        query={popover.type === 'mention' ? popover.query : ''}
        position={popoverPosition}
        onSelect={handleMentionSelect}
        onClose={closePopover}
        visible={popover.type === 'mention'}
      />

      {/* Command Popover */}
      <CommandPopover
        query={popover.type === 'command' ? popover.query : ''}
        position={popoverPosition}
        onSelect={handleCommandSelect}
        onClose={closePopover}
        visible={popover.type === 'command'}
      />

      {/* Textarea */}
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={`
            flex-1 px-4 py-2 rounded-lg resize-none
            bg-surface-elevated border border-border-subtle
            text-text-primary placeholder-text-tertiary
            focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500
            disabled:opacity-50 disabled:cursor-not-allowed
            transition-colors
          `}
          style={{
            lineHeight: `${TEXTAREA_LINE_HEIGHT}px`,
            minHeight: `${TEXTAREA_LINE_HEIGHT * TEXTAREA_MIN_ROWS + 16}px`,
            maxHeight: `${TEXTAREA_LINE_HEIGHT * TEXTAREA_MAX_ROWS + 16}px`,
          }}
          data-testid="prompt-input"
        />

        <button
          onClick={onSubmit}
          disabled={!value.trim() || disabled}
          className={`
            p-2 rounded-lg transition-colors
            ${
              !value.trim() || disabled
                ? 'bg-surface-active text-text-tertiary cursor-not-allowed'
                : 'bg-primary-600 hover:bg-primary-500 text-white'
            }
          `}
          aria-label="Send"
          title="Send message"
          data-testid="prompt-send-btn"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>

      {/* Hints */}
      <div className="flex gap-3 mt-1 px-1">
        <span className="text-[10px] text-text-tertiary">
          @ mention assets
        </span>
        <span className="text-[10px] text-text-tertiary">
          / commands
        </span>
        <span className="flex-1" />
        <span className="text-[10px] text-text-tertiary">
          Shift+Enter for newline
        </span>
      </div>
    </div>
  );
}
