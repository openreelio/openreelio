/**
 * useMentionAndCommand Hook
 *
 * Manages @ mention and / command trigger detection and popover state
 * for the prompt input. Extracted from PromptInput to keep components
 * under the 200-line limit.
 */

import { useState, useCallback, useRef } from 'react';
import type { MentionItem } from '@/components/features/agent/MentionPopover';
import type { CommandItem } from '@/components/features/agent/CommandPopover';

// =============================================================================
// Types
// =============================================================================

export interface PopoverState {
  type: 'mention' | 'command' | null;
  query: string;
  position: { top: number; left: number };
}

export interface UseMentionAndCommandReturn {
  popover: PopoverState;
  detectTrigger: () => void;
  handleMentionSelect: (item: MentionItem) => void;
  handleCommandSelect: (item: CommandItem) => void;
  closePopover: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useMentionAndCommand(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  onChange: (value: string) => void,
): UseMentionAndCommandReturn {
  const [popover, setPopover] = useState<PopoverState>({
    type: null,
    query: '',
    position: { top: 0, left: 0 },
  });

  // Track the trigger position in the text
  const triggerStartRef = useRef<number>(-1);

  const detectTrigger = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBefore = value.slice(0, cursorPos);

    // Detect @ mention trigger
    const mentionMatch = textBefore.match(/@(\w*)$/);
    if (mentionMatch) {
      triggerStartRef.current = cursorPos - mentionMatch[0].length;
      const rect = textarea.getBoundingClientRect();
      setPopover({
        type: 'mention',
        query: mentionMatch[1],
        position: { top: rect.top - 8, left: rect.left },
      });
      return;
    }

    // Detect / command trigger (only at start of input or after whitespace)
    const commandMatch = textBefore.match(/(?:^|\s)\/(\w*)$/);
    if (commandMatch) {
      triggerStartRef.current = cursorPos - commandMatch[0].length + (commandMatch[0].startsWith('/') ? 0 : 1);
      const rect = textarea.getBoundingClientRect();
      setPopover({
        type: 'command',
        query: commandMatch[1],
        position: { top: rect.top - 8, left: rect.left },
      });
      return;
    }

    // No trigger detected
    if (popover.type) {
      setPopover({ type: null, query: '', position: { top: 0, left: 0 } });
    }
  }, [value, popover.type, textareaRef]);

  const handleMentionSelect = useCallback(
    (item: MentionItem) => {
      const start = triggerStartRef.current;
      const textarea = textareaRef.current;
      if (start < 0 || !textarea) return;

      const cursorPos = textarea.selectionStart;
      const before = value.slice(0, start);
      const after = value.slice(cursorPos);
      const newValue = before + item.value + ' ' + after;

      onChange(newValue);
      setPopover({ type: null, query: '', position: { top: 0, left: 0 } });
      triggerStartRef.current = -1;

      // Restore focus and cursor position
      requestAnimationFrame(() => {
        const newCursorPos = start + item.value.length + 1;
        textarea.focus();
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      });
    },
    [value, onChange, textareaRef],
  );

  const handleCommandSelect = useCallback(
    (item: CommandItem) => {
      const start = triggerStartRef.current;
      const textarea = textareaRef.current;
      if (start < 0 || !textarea) return;

      const before = value.slice(0, start);
      const newValue = before + item.template;

      onChange(newValue);
      setPopover({ type: null, query: '', position: { top: 0, left: 0 } });
      triggerStartRef.current = -1;

      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(newValue.length, newValue.length);
      });
    },
    [value, onChange, textareaRef],
  );

  const closePopover = useCallback(() => {
    setPopover({ type: null, query: '', position: { top: 0, left: 0 } });
    triggerStartRef.current = -1;
  }, []);

  return {
    popover,
    detectTrigger,
    handleMentionSelect,
    handleCommandSelect,
    closePopover,
  };
}
