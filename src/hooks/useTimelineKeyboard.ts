/**
 * useTimelineKeyboard Hook
 *
 * Handles keyboard shortcuts for timeline interactions using the Command Pattern.
 * Each shortcut is mapped to a specific action, making it easy to extend and maintain.
 */

import { useCallback, useMemo, type KeyboardEvent } from 'react';
import type { Sequence } from '@/types';
import { getSplitTargetsAtTime } from '@/utils/clipLinking';

// =============================================================================
// Types
// =============================================================================

export interface ClipSplitData {
  sequenceId: string;
  trackId: string;
  clipId: string;
  splitTime: number;
}

export interface UseTimelineKeyboardOptions {
  /** Current sequence data */
  sequence: Sequence | null;
  /** Currently selected clip IDs */
  selectedClipIds: string[];
  /** Whether linked selection should be treated as a single split group */
  linkedSelectionEnabled?: boolean;
  /** Current playhead position */
  playhead: number;
  /** Toggle playback state */
  togglePlayback: () => void;
  /** Step forward one frame */
  stepForward: () => void;
  /** Step backward one frame */
  stepBackward: () => void;
  /** Clear clip selection */
  clearClipSelection: () => void;
  /** Select multiple clips */
  selectClips: (clipIds: string[]) => void;
  /** Callback to delete clips */
  onDeleteClips?: (clipIds: string[]) => void | Promise<void>;
  /** Callback to split clip */
  onClipSplit?: (data: ClipSplitData) => void;
}

export interface UseTimelineKeyboardResult {
  /** Handler for keydown events */
  handleKeyDown: (e: KeyboardEvent) => void;
}

// =============================================================================
// Command Registry
// =============================================================================

interface KeyboardCommand {
  /** Keys that trigger this command */
  keys: string[];
  /**
   * Ctrl/Cmd modifier requirement:
   * - true: Command requires Ctrl/Cmd to be pressed
   * - false: Command requires Ctrl/Cmd to NOT be pressed
   * - undefined: Command works regardless of Ctrl/Cmd state
   */
  requiresCtrl?: boolean;
  /** Command handler */
  execute: (context: CommandContext) => void;
}

interface CommandContext {
  sequence: Sequence | null;
  selectedClipIds: string[];
  linkedSelectionEnabled: boolean;
  playhead: number;
  togglePlayback: () => void;
  stepForward: () => void;
  stepBackward: () => void;
  clearClipSelection: () => void;
  selectClips: (clipIds: string[]) => void;
  onDeleteClips?: (clipIds: string[]) => void | Promise<void>;
  onClipSplit?: (data: ClipSplitData) => void;
}

/**
 * Registry of keyboard commands for the timeline
 */
const KEYBOARD_COMMANDS: KeyboardCommand[] = [
  // Playback: Space to toggle
  {
    keys: [' '],
    execute: (ctx) => ctx.togglePlayback(),
  },
  // Navigation: Arrow keys for frame stepping
  {
    keys: ['ArrowLeft'],
    execute: (ctx) => ctx.stepBackward(),
  },
  {
    keys: ['ArrowRight'],
    execute: (ctx) => ctx.stepForward(),
  },
  // Selection: Escape to clear
  {
    keys: ['Escape'],
    execute: (ctx) => ctx.clearClipSelection(),
  },
  // Delete: Delete or Backspace to remove selected clips
  {
    keys: ['Delete', 'Backspace'],
    execute: (ctx) => {
      if (ctx.selectedClipIds.length > 0 && ctx.onDeleteClips) {
        ctx.onDeleteClips(ctx.selectedClipIds);
      }
    },
  },
  // Split: S key to split clip at playhead (without Ctrl to avoid Ctrl+S conflict)
  {
    keys: ['s', 'S'],
    requiresCtrl: false,
    execute: (ctx) => {
      if (!ctx.sequence || ctx.selectedClipIds.length === 0 || !ctx.onClipSplit) {
        return;
      }

      const splitTargets = getSplitTargetsAtTime(
        ctx.sequence,
        ctx.selectedClipIds,
        ctx.playhead,
        ctx.linkedSelectionEnabled,
      );

      for (const splitTarget of splitTargets) {
        ctx.onClipSplit({
          sequenceId: ctx.sequence.id,
          trackId: splitTarget.trackId,
          clipId: splitTarget.clipId,
          splitTime: ctx.playhead,
        });
      }
    },
  },
  // Select All: Ctrl+A to select all clips
  {
    keys: ['a', 'A'],
    requiresCtrl: true,
    execute: (ctx) => {
      if (!ctx.sequence) return;
      const allClipIds = ctx.sequence.tracks.flatMap((track) => track.clips.map((clip) => clip.id));
      ctx.selectClips(allClipIds);
    },
  },
];

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for handling keyboard shortcuts on the timeline.
 *
 * @param options - Keyboard handling options
 * @returns Keyboard event handler
 *
 * @example
 * ```tsx
 * const { handleKeyDown } = useTimelineKeyboard({
 *   sequence,
 *   selectedClipIds,
 *   playhead,
 *   togglePlayback,
 *   stepForward,
 *   stepBackward,
 *   clearClipSelection,
 *   selectClips,
 *   onDeleteClips,
 *   onClipSplit,
 * });
 *
 * return <div onKeyDown={handleKeyDown} tabIndex={0}>...</div>;
 * ```
 */
export function useTimelineKeyboard({
  sequence,
  selectedClipIds,
  linkedSelectionEnabled = false,
  playhead,
  togglePlayback,
  stepForward,
  stepBackward,
  clearClipSelection,
  selectClips,
  onDeleteClips,
  onClipSplit,
}: UseTimelineKeyboardOptions): UseTimelineKeyboardResult {
  // Create command context
  const context: CommandContext = useMemo(
    () => ({
      sequence,
      selectedClipIds,
      linkedSelectionEnabled,
      playhead,
      togglePlayback,
      stepForward,
      stepBackward,
      clearClipSelection,
      selectClips,
      onDeleteClips,
      onClipSplit,
    }),
    [
      sequence,
      selectedClipIds,
      linkedSelectionEnabled,
      playhead,
      togglePlayback,
      stepForward,
      stepBackward,
      clearClipSelection,
      selectClips,
      onDeleteClips,
      onClipSplit,
    ],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const hasCtrlOrMeta = e.ctrlKey || e.metaKey;

      // Find matching command
      const command = KEYBOARD_COMMANDS.find((cmd) => {
        const keyMatches = cmd.keys.includes(e.key);

        // Check Ctrl/Cmd modifier requirement
        let ctrlMatches: boolean;
        if (cmd.requiresCtrl === undefined) {
          // No requirement - works with or without Ctrl
          ctrlMatches = true;
        } else if (cmd.requiresCtrl) {
          // Requires Ctrl/Cmd to be pressed
          ctrlMatches = hasCtrlOrMeta;
        } else {
          // Requires Ctrl/Cmd to NOT be pressed
          ctrlMatches = !hasCtrlOrMeta;
        }

        return keyMatches && ctrlMatches;
      });

      if (command) {
        e.preventDefault();
        command.execute(context);
      }
    },
    [context],
  );

  return {
    handleKeyDown,
  };
}
