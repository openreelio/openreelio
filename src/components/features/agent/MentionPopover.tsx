/**
 * MentionPopover
 *
 * Floating popover for @ mentions in the chat prompt.
 * Provides fuzzy search over assets, clips, tracks,
 * and context shortcuts (selection, playhead, timeline).
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useProjectStore } from '@/stores';
import { useTimelineStore } from '@/stores/timelineStore';

// =============================================================================
// Types
// =============================================================================

export interface MentionItem {
  id: string;
  label: string;
  description: string;
  category: 'asset' | 'clip' | 'track' | 'context';
  /** Value inserted into the prompt */
  value: string;
}

interface MentionPopoverProps {
  query: string;
  position: { top: number; left: number };
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
  visible: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function formatDuration(sec?: number): string {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// =============================================================================
// Component
// =============================================================================

export function MentionPopover({
  query,
  position,
  onSelect,
  onClose,
  visible,
}: MentionPopoverProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Subscribe only to the store slices needed for building the items list.
  // Notably we do NOT subscribe to playbackStore.currentTime because it
  // changes every animation frame and would re-render the popover at 60 fps.
  const assets = useProjectStore((s) => s.assets);
  const sequences = useProjectStore((s) => s.sequences);
  const activeSequenceId = useProjectStore((s) => s.activeSequenceId);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);

  const items: MentionItem[] = useMemo(() => {
    const result: MentionItem[] = [];

    // Context shortcuts (always available)
    result.push({
      id: 'ctx:selection',
      label: 'selection',
      description: `Current selection (${selectedClipIds.length} clips)`,
      category: 'context',
      value: '@selection',
    });
    result.push({
      id: 'ctx:playhead',
      label: 'playhead',
      description: 'Current playhead position',
      category: 'context',
      value: '@playhead',
    });
    result.push({
      id: 'ctx:timeline',
      label: 'timeline',
      description: 'Full timeline context',
      category: 'context',
      value: '@timeline',
    });

    // Assets
    for (const asset of assets.values()) {
      const mediaKinds = ['video', 'audio', 'image'];
      if (!mediaKinds.includes(asset.kind)) continue;
      result.push({
        id: `asset:${asset.id}`,
        label: asset.name,
        description: `${asset.kind}${asset.durationSec ? ' ' + formatDuration(asset.durationSec) : ''}`,
        category: 'asset',
        value: `@asset:${asset.name}`,
      });
    }

    // Tracks and clips from active sequence
    const activeSequence = activeSequenceId
      ? sequences.get(activeSequenceId)
      : undefined;

    if (activeSequence) {
      for (const track of activeSequence.tracks) {
        result.push({
          id: `track:${track.id}`,
          label: track.name || `Track ${track.id.slice(0, 6)}`,
          description: `${track.kind} track, ${track.clips.length} clips`,
          category: 'track',
          value: `@track:${track.name || track.id}`,
        });

        for (const clip of track.clips) {
          const clipAsset = assets.get(clip.assetId);
          const clipLabel = clip.label || clipAsset?.name || `Clip ${clip.id.slice(0, 6)}`;
          result.push({
            id: `clip:${clip.id}`,
            label: clipLabel,
            description: `on ${track.name || 'track'} at ${formatDuration(clip.place.timelineInSec)}`,
            category: 'clip',
            value: `@clip:${clipLabel}`,
          });
        }
      }
    }

    return result;
  }, [assets, sequences, activeSequenceId, selectedClipIds]);

  // Filter by query
  const filtered = query
    ? items.filter((item) => fuzzyMatch(item.label, query) || fuzzyMatch(item.category, query))
    : items;

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

  const categoryIcons: Record<string, string> = {
    context: '\uD83D\uDCCD',
    asset: '\uD83C\uDFAC',
    track: '\uD83C\uDFB5',
    clip: '\u2702\uFE0F',
  };

  return (
    <div
      className="absolute z-50 w-72 max-h-64 overflow-y-auto rounded-lg border border-border-subtle bg-surface-elevated shadow-xl"
      style={{ top: position.top, left: position.left }}
      data-testid="mention-popover"
    >
      <div ref={listRef} role="listbox" aria-label="Mention suggestions">
        {filtered.slice(0, 20).map((item, i) => (
          <button
            key={item.id}
            role="option"
            aria-selected={i === selectedIndex}
            onClick={() => onSelect(item)}
            onMouseEnter={() => setSelectedIndex(i)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
              i === selectedIndex
                ? 'bg-primary-500/20 text-text-primary'
                : 'text-text-secondary hover:bg-surface-active'
            }`}
          >
            <span className="text-xs w-5 text-center flex-shrink-0">
              {categoryIcons[item.category]}
            </span>
            <span className="truncate font-medium">{item.label}</span>
            <span className="text-xs text-text-tertiary truncate flex-1 text-right">
              {item.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
