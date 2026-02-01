/**
 * useKeyboardShortcutsHelp Hook
 *
 * Manages the keyboard shortcuts help dialog visibility.
 * Opens on '?' key press (Shift + /).
 */

import { useCallback, useEffect, useState } from 'react';

export interface UseKeyboardShortcutsHelpReturn {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export function useKeyboardShortcutsHelp(): UseKeyboardShortcutsHelpReturn {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  // Listen for '?' key to toggle help
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if '?' is pressed (Shift + /)
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        // Don't trigger when typing in input fields
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        toggle();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle]);

  return {
    isOpen,
    open,
    close,
    toggle,
  };
}

