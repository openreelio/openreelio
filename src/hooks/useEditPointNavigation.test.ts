/**
 * Edit Point Navigation Integration Tests (BDD)
 *
 * Feature: Edit Point Navigation (S27-002)
 *   Professional NLE keyboard navigation for jumping between clip boundaries and markers.
 *
 *   Scenario: Down Arrow jumps to next edit point
 *     Given a timeline with clips and playhead at 0.0
 *     When Down Arrow is pressed
 *     Then the backend is queried for the next edit point
 *     And the playhead seeks to the returned position
 *
 *   Scenario: Up Arrow jumps to previous edit point
 *     Given a timeline with clips and playhead at 5.0
 *     When Up Arrow is pressed
 *     Then the backend is queried for the previous edit point
 *     And the playhead seeks to the returned position
 *
 *   Scenario: Shift+Down jumps to next marker
 *     Given a timeline with markers
 *     When Shift+Down is pressed
 *     Then the backend is queried for the next marker
 *     And the playhead seeks to the marker position
 *
 *   Scenario: Shift+Up jumps to previous marker
 *     Given a timeline with markers and playhead past the first marker
 *     When Shift+Up is pressed
 *     Then the backend is queried for the previous marker
 *     And the playhead seeks to the marker position
 *
 *   Scenario: No action when no sequence is active
 *     Given no active sequence
 *     When Down Arrow is pressed
 *     Then no IPC call is made
 *
 *   Scenario: No seek when at last edit point
 *     Given the playhead is at the last clip boundary
 *     When Down Arrow is pressed
 *     Then the backend returns null
 *     And the playhead does not move
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock: Tauri IPC (external boundary — only allowed mock per Testing Trophy)
// ---------------------------------------------------------------------------

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Import after mock registration
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';

// =============================================================================
// Helpers
// =============================================================================

async function fireKeyDown(key: string, opts: Partial<KeyboardEventInit> = {}): Promise<void> {
  await act(async () => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...opts,
    });
    window.dispatchEvent(event);
    await Promise.resolve();
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('Edit Point Navigation (S27-002)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset stores to known state
    usePlaybackStore.setState({
      currentTime: 0,
      duration: 30,
      isPlaying: false,
    });
    // Set up an active sequence
    useProjectStore.setState({
      activeSequenceId: 'seq-001',
      isLoaded: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Down Arrow — next edit point
  // ---------------------------------------------------------------------------

  describe('Down Arrow (next edit point)', () => {
    it('should invoke get_next_edit_point with current time when Down is pressed', async () => {
      // Given: playhead at 2.0 with an active sequence
      usePlaybackStore.setState({ currentTime: 2.0 });
      invokeMock.mockResolvedValue(5.0);

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Down Arrow is pressed
      await fireKeyDown('ArrowDown');

      // Then: IPC should be called with correct params
      expect(invokeMock).toHaveBeenCalledWith('get_next_edit_point', {
        sequenceId: 'seq-001',
        currentTime: 2.0,
      });
    });

    it('should seek to the returned edit point position', async () => {
      // Given: backend returns next edit point at 5.0
      usePlaybackStore.setState({ currentTime: 2.0 });
      invokeMock.mockResolvedValue(5.0);

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Down Arrow is pressed
      await fireKeyDown('ArrowDown');

      // Then: after IPC resolves, playhead should seek to 5.0
      await vi.waitFor(() => {
        expect(usePlaybackStore.getState().currentTime).toBe(5.0);
      });
    });

    it('should not seek when backend returns null (at last edit point)', async () => {
      // Given: playhead at end, no more edit points
      usePlaybackStore.setState({ currentTime: 30.0 });
      invokeMock.mockResolvedValue(null);

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Down Arrow is pressed
      await fireKeyDown('ArrowDown');

      // Then: playhead should not move
      await vi.waitFor(() => {
        expect(invokeMock).toHaveBeenCalled();
      });
      expect(usePlaybackStore.getState().currentTime).toBe(30.0);
    });
  });

  // ---------------------------------------------------------------------------
  // Up Arrow — previous edit point
  // ---------------------------------------------------------------------------

  describe('Up Arrow (previous edit point)', () => {
    it('should invoke get_prev_edit_point with current time when Up is pressed', async () => {
      // Given: playhead at 5.0
      usePlaybackStore.setState({ currentTime: 5.0 });
      invokeMock.mockResolvedValue(2.0);

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Up Arrow is pressed
      await fireKeyDown('ArrowUp');

      // Then: IPC should query previous edit point
      expect(invokeMock).toHaveBeenCalledWith('get_prev_edit_point', {
        sequenceId: 'seq-001',
        currentTime: 5.0,
      });
    });

    it('should seek to the returned previous edit point', async () => {
      // Given: backend returns previous edit point at 2.0
      usePlaybackStore.setState({ currentTime: 5.0 });
      invokeMock.mockResolvedValue(2.0);

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Up Arrow is pressed
      await fireKeyDown('ArrowUp');

      // Then: playhead should seek to 2.0
      await vi.waitFor(() => {
        expect(usePlaybackStore.getState().currentTime).toBe(2.0);
      });
    });

    it('should not seek when at timeline start (null returned)', async () => {
      // Given: playhead at 0, no previous edit points
      usePlaybackStore.setState({ currentTime: 0 });
      invokeMock.mockResolvedValue(null);

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Up Arrow is pressed
      await fireKeyDown('ArrowUp');

      // Then: playhead stays at 0
      await vi.waitFor(() => {
        expect(invokeMock).toHaveBeenCalled();
      });
      expect(usePlaybackStore.getState().currentTime).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Shift+Down — next marker
  // ---------------------------------------------------------------------------

  describe('Shift+Down (next marker)', () => {
    it('should invoke get_next_marker when Shift+Down is pressed', async () => {
      // Given: playhead at 1.0
      usePlaybackStore.setState({ currentTime: 1.0 });
      invokeMock.mockResolvedValue(3.5);

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Shift+Down is pressed
      await fireKeyDown('ArrowDown', { shiftKey: true });

      // Then: IPC should query next marker
      expect(invokeMock).toHaveBeenCalledWith('get_next_marker', {
        sequenceId: 'seq-001',
        currentTime: 1.0,
      });
    });

    it('should seek to the next marker position', async () => {
      // Given: backend returns marker at 3.5
      usePlaybackStore.setState({ currentTime: 1.0 });
      invokeMock.mockResolvedValue(3.5);

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Shift+Down is pressed
      await fireKeyDown('ArrowDown', { shiftKey: true });

      // Then: playhead should seek to 3.5
      await vi.waitFor(() => {
        expect(usePlaybackStore.getState().currentTime).toBe(3.5);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Shift+Up — previous marker
  // ---------------------------------------------------------------------------

  describe('Shift+Up (previous marker)', () => {
    it('should invoke get_prev_marker when Shift+Up is pressed', async () => {
      // Given: playhead at 8.0
      usePlaybackStore.setState({ currentTime: 8.0 });
      invokeMock.mockResolvedValue(5.0);

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Shift+Up is pressed
      await fireKeyDown('ArrowUp', { shiftKey: true });

      // Then: IPC should query previous marker
      expect(invokeMock).toHaveBeenCalledWith('get_prev_marker', {
        sequenceId: 'seq-001',
        currentTime: 8.0,
      });
    });

    it('should seek to the previous marker position', async () => {
      // Given: backend returns marker at 5.0
      usePlaybackStore.setState({ currentTime: 8.0 });
      invokeMock.mockResolvedValue(5.0);

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Shift+Up is pressed
      await fireKeyDown('ArrowUp', { shiftKey: true });

      // Then: playhead should seek to 5.0
      await vi.waitFor(() => {
        expect(usePlaybackStore.getState().currentTime).toBe(5.0);
      });
    });

    it('should not seek when no markers exist (null returned)', async () => {
      // Given: no markers in sequence
      usePlaybackStore.setState({ currentTime: 2.0 });
      invokeMock.mockResolvedValue(null);

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Shift+Up is pressed
      await fireKeyDown('ArrowUp', { shiftKey: true });

      // Then: playhead stays at 2.0
      await vi.waitFor(() => {
        expect(invokeMock).toHaveBeenCalled();
      });
      expect(usePlaybackStore.getState().currentTime).toBe(2.0);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('Edge cases', () => {
    it('should not invoke IPC when no active sequence exists', async () => {
      // Given: no active sequence
      useProjectStore.setState({ activeSequenceId: null });

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Down Arrow is pressed
      await fireKeyDown('ArrowDown');

      // Then: no IPC call should be made
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('should not invoke IPC when shortcuts are disabled', async () => {
      // Given: shortcuts disabled
      renderHook(() => useKeyboardShortcuts({ enabled: false }));

      // When: Down Arrow is pressed
      await fireKeyDown('ArrowDown');

      // Then: no IPC call should be made
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('should not trigger edit point navigation when input element is focused', () => {
      // Given: focus is on an input element
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // When: Down Arrow is pressed on the input
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);

      // Then: no IPC call should be made
      expect(invokeMock).not.toHaveBeenCalled();

      // Cleanup
      document.body.removeChild(input);
    });
  });
});
