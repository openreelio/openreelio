/**
 * CommandPopover
 *
 * Floating popover for / commands in the chat prompt.
 * Provides a list of available slash commands with descriptions.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface CommandItem {
  id: string;
  name: string;
  description: string;
  /** Template text inserted when selected */
  template: string;
}

interface CommandPopoverProps {
  query: string;
  position: { top: number; left: number };
  onSelect: (item: CommandItem) => void;
  onClose: () => void;
  visible: boolean;
}

// =============================================================================
// Built-in Commands
// =============================================================================

const BUILT_IN_COMMANDS: CommandItem[] = [
  {
    id: 'cmd:split',
    name: 'split',
    description: 'Split clip at playhead position',
    template: 'Split the clip at the current playhead position',
  },
  {
    id: 'cmd:trim',
    name: 'trim',
    description: 'Trim selected clip',
    template: 'Trim the selected clip to ',
  },
  {
    id: 'cmd:color-correct',
    name: 'color-correct',
    description: 'Auto color correction on selection',
    template: 'Apply auto color correction to the selected clips',
  },
  {
    id: 'cmd:add-subtitles',
    name: 'add-subtitles',
    description: 'Generate captions from audio',
    template: 'Generate subtitles from the audio track',
  },
  {
    id: 'cmd:montage',
    name: 'montage',
    description: 'Auto-montage from marked clips',
    template: 'Create a montage from the selected clips',
  },
  {
    id: 'cmd:analyze',
    name: 'analyze',
    description: 'Analyze timeline for issues',
    template: 'Analyze the timeline for gaps, pacing issues, and audio levels',
  },
  {
    id: 'cmd:export',
    name: 'export',
    description: 'Export with preset settings',
    template: 'Export the timeline as ',
  },
  {
    id: 'cmd:fade',
    name: 'fade',
    description: 'Add fade in/out to selection',
    template: 'Add a fade in and fade out to the selected clips',
  },
  {
    id: 'cmd:speed',
    name: 'speed',
    description: 'Change playback speed',
    template: 'Change the speed of the selected clip to ',
  },
  {
    id: 'cmd:remove-silence',
    name: 'remove-silence',
    description: 'Detect and remove silent segments',
    template: 'Detect and remove silent segments from the audio',
  },
];

// =============================================================================
// Component
// =============================================================================

export function CommandPopover({
  query,
  position,
  onSelect,
  onClose,
  visible,
}: CommandPopoverProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter by query
  const filtered = query
    ? BUILT_IN_COMMANDS.filter(
        (cmd) =>
          cmd.name.toLowerCase().includes(query.toLowerCase()) ||
          cmd.description.toLowerCase().includes(query.toLowerCase()),
      )
    : BUILT_IN_COMMANDS;

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible || filtered.length === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
        case 'Tab':
          e.preventDefault();
          onSelect(filtered[selectedIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [visible, filtered, selectedIndex, onSelect, onClose],
  );

  useEffect(() => {
    if (!visible) return;
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown, visible]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!visible || filtered.length === 0) return null;

  return (
    <div
      className="absolute z-50 w-72 max-h-64 overflow-y-auto rounded-lg border border-border-subtle bg-surface-elevated shadow-xl"
      style={{ top: position.top, left: position.left }}
      data-testid="command-popover"
    >
      <div className="px-3 py-1.5 border-b border-border-subtle">
        <span className="text-xs font-medium text-text-tertiary">Commands</span>
      </div>
      <div ref={listRef} role="listbox" aria-label="Command suggestions">
        {filtered.map((cmd, i) => (
          <button
            key={cmd.id}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onSelect(cmd)}
            onMouseEnter={() => setSelectedIndex(i)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
              i === selectedIndex
                ? 'bg-primary-500/20 text-text-primary'
                : 'text-text-secondary hover:bg-surface-active'
            }`}
          >
            <span className="text-xs text-primary-400 font-mono flex-shrink-0">/{cmd.name}</span>
            <span className="text-xs text-text-tertiary truncate">{cmd.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
