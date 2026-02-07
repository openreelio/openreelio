/**
 * useMulticamSession Hook Tests
 *
 * TDD: Tests for the orchestration hook that bridges
 * useMulticam + useMulticamKeyboardShortcuts + playbackStore.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMulticamSession } from './useMulticamSession';
import type { MulticamGroup } from '@/utils/multicam';

// =============================================================================
// Mock stores and hooks
// =============================================================================

const mockPlaybackState = {
  currentTime: 5.0,
  isPlaying: false,
};

vi.mock('@/stores', () => ({
  usePlaybackStore: (selector: (state: typeof mockPlaybackState) => unknown) =>
    selector(mockPlaybackState),
}));

// Track calls to useMulticamKeyboardShortcuts
const mockKeyboardShortcutsOptions: Record<string, unknown>[] = [];

vi.mock('./useMulticamKeyboardShortcuts', () => ({
  useMulticamKeyboardShortcuts: (options: Record<string, unknown>) => {
    mockKeyboardShortcutsOptions.push(options);
    return { shortcuts: [] };
  },
}));

// =============================================================================
// Test Data
// =============================================================================

function createTestGroup(overrides?: Partial<MulticamGroup>): MulticamGroup {
  return {
    id: 'group-1',
    sequenceId: 'seq-1',
    name: 'Test Group',
    angles: [
      { id: 'angle-0', label: 'Camera 1', clipId: 'clip-0', trackId: 'track-0' },
      { id: 'angle-1', label: 'Camera 2', clipId: 'clip-1', trackId: 'track-1' },
      { id: 'angle-2', label: 'Camera 3', clipId: 'clip-2', trackId: 'track-2' },
    ],
    activeAngleIndex: 0,
    timelineInSec: 0,
    durationSec: 30,
    angleSwitches: [],
    audioMixMode: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('useMulticamSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKeyboardShortcutsOptions.length = 0;
    mockPlaybackState.currentTime = 5.0;
    mockPlaybackState.isPlaying = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Inactive State
  // ===========================================================================

  describe('inactive state', () => {
    it('should return isActive=false when no group', () => {
      const { result } = renderHook(() =>
        useMulticamSession({ group: null, mode: 'view' })
      );

      expect(result.current.isActive).toBe(false);
    });

    it('should return null multicam state when no group', () => {
      const { result } = renderHook(() =>
        useMulticamSession({ group: null, mode: 'view' })
      );

      expect(result.current.activeAngle).toBeNull();
      expect(result.current.group).toBeNull();
    });
  });

  // ===========================================================================
  // Active State
  // ===========================================================================

  describe('active state', () => {
    it('should return isActive=true when group is provided', () => {
      const group = createTestGroup();
      const { result } = renderHook(() =>
        useMulticamSession({ group, mode: 'view' })
      );

      expect(result.current.isActive).toBe(true);
    });

    it('should expose multicam state from useMulticam', () => {
      const group = createTestGroup();
      const { result } = renderHook(() =>
        useMulticamSession({ group, mode: 'view' })
      );

      expect(result.current.group).not.toBeNull();
      expect(result.current.activeAngle).not.toBeNull();
      expect(result.current.activeAngleIndex).toBe(0);
    });
  });

  // ===========================================================================
  // Keyboard Shortcuts Integration
  // ===========================================================================

  describe('keyboard shortcuts', () => {
    it('should call keyboard hook with enabled=true when group active', () => {
      const group = createTestGroup();
      renderHook(() => useMulticamSession({ group, mode: 'view' }));

      const lastCall = mockKeyboardShortcutsOptions[mockKeyboardShortcutsOptions.length - 1];
      expect(lastCall.enabled).toBe(true);
      expect(lastCall.angleCount).toBe(3);
    });

    it('should call keyboard hook with enabled=false when no group', () => {
      renderHook(() => useMulticamSession({ group: null, mode: 'view' }));

      const lastCall = mockKeyboardShortcutsOptions[mockKeyboardShortcutsOptions.length - 1];
      expect(lastCall.enabled).toBe(false);
    });

    it('should pass playbackStore.currentTime as currentTimeSec', () => {
      const group = createTestGroup();
      mockPlaybackState.currentTime = 12.5;

      renderHook(() => useMulticamSession({ group, mode: 'record' }));

      const lastCall = mockKeyboardShortcutsOptions[mockKeyboardShortcutsOptions.length - 1];
      expect(lastCall.currentTimeSec).toBe(12.5);
    });

    it('should set isRecording=true in record mode', () => {
      const group = createTestGroup();
      renderHook(() => useMulticamSession({ group, mode: 'record' }));

      const lastCall = mockKeyboardShortcutsOptions[mockKeyboardShortcutsOptions.length - 1];
      expect(lastCall.isRecording).toBe(true);
    });

    it('should set isRecording=false in view mode', () => {
      const group = createTestGroup();
      renderHook(() => useMulticamSession({ group, mode: 'view' }));

      const lastCall = mockKeyboardShortcutsOptions[mockKeyboardShortcutsOptions.length - 1];
      expect(lastCall.isRecording).toBe(false);
    });
  });

  // ===========================================================================
  // Angle Switching
  // ===========================================================================

  describe('angle switching', () => {
    it('should provide onSwitchAngle callback to keyboard hook', () => {
      const group = createTestGroup();
      renderHook(() => useMulticamSession({ group, mode: 'view' }));

      const lastCall = mockKeyboardShortcutsOptions[mockKeyboardShortcutsOptions.length - 1];
      expect(lastCall.onSwitchAngle).toBeInstanceOf(Function);
    });

    it('should provide onSwitchAngleAt callback to keyboard hook', () => {
      const group = createTestGroup();
      renderHook(() => useMulticamSession({ group, mode: 'record' }));

      const lastCall = mockKeyboardShortcutsOptions[mockKeyboardShortcutsOptions.length - 1];
      expect(lastCall.onSwitchAngleAt).toBeInstanceOf(Function);
    });

    it('should call onChange when angle switches in view mode', () => {
      const group = createTestGroup();
      const onChange = vi.fn();

      renderHook(() =>
        useMulticamSession({ group, mode: 'view', onChange })
      );

      // Get the onSwitchAngle callback and invoke it
      const lastCall = mockKeyboardShortcutsOptions[mockKeyboardShortcutsOptions.length - 1];
      const onSwitchAngle = lastCall.onSwitchAngle as (index: number) => void;

      act(() => {
        onSwitchAngle(1);
      });

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          activeAngleIndex: 1,
        })
      );
    });
  });

  // ===========================================================================
  // Recording Mode
  // ===========================================================================

  describe('recording mode', () => {
    it('should expose isRecording flag', () => {
      const group = createTestGroup();
      const { result } = renderHook(() =>
        useMulticamSession({ group, mode: 'record' })
      );

      expect(result.current.isRecording).toBe(true);
    });

    it('should not be recording in view mode', () => {
      const group = createTestGroup();
      const { result } = renderHook(() =>
        useMulticamSession({ group, mode: 'view' })
      );

      expect(result.current.isRecording).toBe(false);
    });
  });
});
