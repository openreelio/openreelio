/**
 * useMulticam Hook Tests
 *
 * Tests for the multicam editing hook that manages multicam groups,
 * angle switching, and state synchronization.
 *
 * Following TDD methodology.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMulticam } from './useMulticam';
import type { MulticamGroup, MulticamAngle } from '@/utils/multicam';

describe('useMulticam', () => {
  const mockGroup: MulticamGroup = {
    id: 'group-1',
    sequenceId: 'seq-1',
    name: 'Test Multicam',
    angles: [
      { id: 'angle-1', clipId: 'clip-1', trackId: 'track-1', label: 'Camera 1' },
      { id: 'angle-2', clipId: 'clip-2', trackId: 'track-2', label: 'Camera 2' },
      { id: 'angle-3', clipId: 'clip-3', trackId: 'track-3', label: 'Camera 3' },
      { id: 'angle-4', clipId: 'clip-4', trackId: 'track-4', label: 'Camera 4' },
    ],
    activeAngleIndex: 0,
    timelineInSec: 0,
    durationSec: 60,
    audioMixMode: 'active',
    angleSwitches: [],
  };

  describe('initialization', () => {
    it('should initialize with provided group', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      expect(result.current.group).toEqual(mockGroup);
      expect(result.current.activeAngle).toEqual(mockGroup.angles[0]);
      expect(result.current.activeAngleIndex).toBe(0);
    });

    it('should initialize with null group', () => {
      const { result } = renderHook(() => useMulticam({}));

      expect(result.current.group).toBeNull();
      expect(result.current.activeAngle).toBeNull();
    });

    it('should default to 2x2 grid layout', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      expect(result.current.gridLayout).toEqual({ rows: 2, cols: 2 });
    });

    it('should allow custom grid layout', () => {
      const { result } = renderHook(() =>
        useMulticam({ group: mockGroup, initialGridLayout: { rows: 1, cols: 4 } })
      );

      expect(result.current.gridLayout).toEqual({ rows: 1, cols: 4 });
    });
  });

  describe('angle switching', () => {
    it('should switch active angle', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      act(() => {
        result.current.switchAngle(2);
      });

      expect(result.current.activeAngleIndex).toBe(2);
      expect(result.current.activeAngle?.id).toBe('angle-3');
    });

    it('should not switch to invalid angle index', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      act(() => {
        result.current.switchAngle(10);
      });

      // Should remain at original angle
      expect(result.current.activeAngleIndex).toBe(0);
    });

    it('should call onChange when angle switches', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useMulticam({ group: mockGroup, onChange })
      );

      act(() => {
        result.current.switchAngle(1);
      });

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          activeAngleIndex: 1,
        })
      );
    });

    it('should not call onChange when switching to same angle', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useMulticam({ group: mockGroup, onChange })
      );

      act(() => {
        result.current.switchAngle(0);
      });

      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('angle switching with recording', () => {
    it('should record angle switch when recording is enabled', () => {
      const { result } = renderHook(() =>
        useMulticam({ group: mockGroup, isRecording: true })
      );

      act(() => {
        result.current.switchAngleAt(1, 10.5);
      });

      expect(result.current.group?.angleSwitches).toHaveLength(1);
      expect(result.current.group?.angleSwitches[0]).toMatchObject({
        fromAngleIndex: 0,
        toAngleIndex: 1,
        timeSec: 10.5,
      });
    });

    it('should not record switch when recording is disabled', () => {
      const { result } = renderHook(() =>
        useMulticam({ group: mockGroup, isRecording: false })
      );

      act(() => {
        result.current.switchAngleAt(1, 10.5);
      });

      // Switch happens but is not recorded
      expect(result.current.activeAngleIndex).toBe(1);
      expect(result.current.group?.angleSwitches).toHaveLength(0);
    });

    it('should sort switches by time when recording', () => {
      const { result } = renderHook(() =>
        useMulticam({ group: mockGroup, isRecording: true })
      );

      act(() => {
        result.current.switchAngleAt(1, 20);
        result.current.switchAngleAt(2, 10);
        result.current.switchAngleAt(3, 15);
      });

      const times = result.current.group?.angleSwitches.map((s) => s.timeSec);
      expect(times).toEqual([10, 15, 20]);
    });
  });

  describe('angle switch management', () => {
    const groupWithSwitches: MulticamGroup = {
      ...mockGroup,
      angleSwitches: [
        { id: 'sw-1', timeSec: 10, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
        { id: 'sw-2', timeSec: 20, fromAngleIndex: 1, toAngleIndex: 2, transitionType: 'cut' },
        { id: 'sw-3', timeSec: 30, fromAngleIndex: 2, toAngleIndex: 0, transitionType: 'cut' },
      ],
    };

    it('should remove an angle switch', () => {
      const { result } = renderHook(() =>
        useMulticam({ group: groupWithSwitches })
      );

      act(() => {
        result.current.removeSwitch('sw-2');
      });

      expect(result.current.group?.angleSwitches).toHaveLength(2);
      expect(result.current.group?.angleSwitches.find((s) => s.id === 'sw-2')).toBeUndefined();
    });

    it('should update an angle switch time', () => {
      const { result } = renderHook(() =>
        useMulticam({ group: groupWithSwitches })
      );

      act(() => {
        result.current.updateSwitchTime('sw-2', 25);
      });

      const updatedSwitch = result.current.group?.angleSwitches.find((s) => s.id === 'sw-2');
      expect(updatedSwitch?.timeSec).toBe(25);
    });

    it('should clear all switches', () => {
      const { result } = renderHook(() =>
        useMulticam({ group: groupWithSwitches })
      );

      act(() => {
        result.current.clearSwitches();
      });

      expect(result.current.group?.angleSwitches).toHaveLength(0);
    });
  });

  describe('grid layout', () => {
    it('should update grid layout', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      act(() => {
        result.current.setGridLayout({ rows: 3, cols: 3 });
      });

      expect(result.current.gridLayout).toEqual({ rows: 3, cols: 3 });
    });

    it('should get visible angles based on grid layout', () => {
      // 4 angles, 2x2 grid = all visible
      const { result } = renderHook(() =>
        useMulticam({ group: mockGroup, initialGridLayout: { rows: 2, cols: 2 } })
      );

      expect(result.current.visibleAngles).toHaveLength(4);

      // Change to 1x2 grid = only 2 visible
      act(() => {
        result.current.setGridLayout({ rows: 1, cols: 2 });
      });

      expect(result.current.visibleAngles).toHaveLength(2);
    });

    it('should get angle at grid position', () => {
      const { result } = renderHook(() =>
        useMulticam({ group: mockGroup, initialGridLayout: { rows: 2, cols: 2 } })
      );

      // Grid positions: [0,0] [0,1]
      //                 [1,0] [1,1]
      expect(result.current.getAngleAtGridPosition(0, 0)?.id).toBe('angle-1');
      expect(result.current.getAngleAtGridPosition(0, 1)?.id).toBe('angle-2');
      expect(result.current.getAngleAtGridPosition(1, 0)?.id).toBe('angle-3');
      expect(result.current.getAngleAtGridPosition(1, 1)?.id).toBe('angle-4');
    });
  });

  describe('audio mix mode', () => {
    it('should get current audio mix mode', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      expect(result.current.audioMixMode).toBe('active');
    });

    it('should update audio mix mode', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      act(() => {
        result.current.setAudioMixMode('mix');
      });

      expect(result.current.audioMixMode).toBe('mix');
    });
  });

  describe('angle at time', () => {
    const groupWithSwitches: MulticamGroup = {
      ...mockGroup,
      angleSwitches: [
        { id: 'sw-1', timeSec: 10, fromAngleIndex: 0, toAngleIndex: 1, transitionType: 'cut' },
        { id: 'sw-2', timeSec: 20, fromAngleIndex: 1, toAngleIndex: 2, transitionType: 'cut' },
      ],
    };

    it('should return correct angle at various times', () => {
      const { result } = renderHook(() =>
        useMulticam({ group: groupWithSwitches })
      );

      expect(result.current.getAngleIndexAtTime(5)?.angleIndex).toBe(0);
      expect(result.current.getAngleIndexAtTime(15)?.angleIndex).toBe(1);
      expect(result.current.getAngleIndexAtTime(25)?.angleIndex).toBe(2);
    });
  });

  describe('keyboard shortcuts', () => {
    it('should switch angles with number keys', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      act(() => {
        result.current.handleKeyPress('1');
      });
      expect(result.current.activeAngleIndex).toBe(0);

      act(() => {
        result.current.handleKeyPress('2');
      });
      expect(result.current.activeAngleIndex).toBe(1);

      act(() => {
        result.current.handleKeyPress('3');
      });
      expect(result.current.activeAngleIndex).toBe(2);

      act(() => {
        result.current.handleKeyPress('4');
      });
      expect(result.current.activeAngleIndex).toBe(3);
    });

    it('should ignore invalid number keys', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      act(() => {
        result.current.handleKeyPress('9'); // Only 4 angles
      });

      expect(result.current.activeAngleIndex).toBe(0);
    });
  });

  describe('group updates', () => {
    it('should update group name', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      act(() => {
        result.current.updateGroupName('New Name');
      });

      expect(result.current.group?.name).toBe('New Name');
    });

    it('should add an angle to the group', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      const newAngle: MulticamAngle = {
        id: 'angle-5',
        clipId: 'clip-5',
        trackId: 'track-5',
        label: 'Camera 5',
      };

      act(() => {
        result.current.addAngle(newAngle);
      });

      expect(result.current.group?.angles).toHaveLength(5);
    });

    it('should remove an angle from the group', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      act(() => {
        result.current.removeAngle('angle-2');
      });

      expect(result.current.group?.angles).toHaveLength(3);
      expect(result.current.group?.angles.find((a) => a.id === 'angle-2')).toBeUndefined();
    });
  });

  describe('preview integration', () => {
    it('should track hovered angle', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      expect(result.current.hoveredAngleIndex).toBeNull();

      act(() => {
        result.current.setHoveredAngle(2);
      });

      expect(result.current.hoveredAngleIndex).toBe(2);

      act(() => {
        result.current.setHoveredAngle(null);
      });

      expect(result.current.hoveredAngleIndex).toBeNull();
    });

    it('should provide preview angle (hovered or active)', () => {
      const { result } = renderHook(() => useMulticam({ group: mockGroup }));

      // No hover, should return active
      expect(result.current.previewAngle?.id).toBe('angle-1');

      // With hover, should return hovered
      act(() => {
        result.current.setHoveredAngle(2);
      });
      expect(result.current.previewAngle?.id).toBe('angle-3');
    });
  });
});
