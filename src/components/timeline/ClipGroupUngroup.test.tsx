/**
 * Clip Group/Ungroup Tests
 *
 * Integration tests for the Group and Ungroup feature.
 * Tests context menu items (Track.tsx), visual indicator (Clip.tsx),
 * and handler functions (useTimelineActions.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import type { Clip as ClipType, Track as TrackType, Sequence } from '@/types';
import { useEditorToolStore } from '@/stores/editorToolStore';
import { useProjectStore } from '@/stores/projectStore';

vi.mock('./LazyThumbnailStrip', () => ({
  LazyThumbnailStrip: () => <div data-testid="lazy-thumbnail-strip-mock" />,
}));

vi.mock('./AudioClipWaveform', () => ({
  AudioClipWaveform: () => <div data-testid="audio-clip-waveform-mock" />,
}));

import { Clip } from './Clip';
import { Track } from './Track';
import { useTimelineActions } from '@/hooks/useTimelineActions';

// =============================================================================
// Test Data
// =============================================================================

const baseClip: ClipType = {
  id: 'clip_001',
  assetId: 'asset_001',
  range: { sourceInSec: 0, sourceOutSec: 10 },
  place: { timelineInSec: 5, durationSec: 10 },
  transform: {
    position: { x: 0.5, y: 0.5 },
    scale: { x: 1, y: 1 },
    rotationDeg: 0,
    anchor: { x: 0.5, y: 0.5 },
  },
  opacity: 1,
  speed: 1,
  effects: [],
  audio: { volumeDb: 0, pan: 0, muted: false },
  label: 'Test Clip',
};

const secondClip: ClipType = {
  ...baseClip,
  id: 'clip_002',
  assetId: 'asset_002',
  place: { timelineInSec: 20, durationSec: 10 },
  label: 'Second Clip',
};

const videoTrack: TrackType = {
  id: 'track_001',
  kind: 'video',
  name: 'Video 1',
  clips: [],
  blendMode: 'normal',
  muted: false,
  locked: false,
  visible: true,
  volume: 1.0,
};

const mockSequence: Sequence = {
  id: 'seq_001',
  name: 'Test Sequence',
  tracks: [videoTrack],
  markers: [],
  format: {
    canvas: { width: 1920, height: 1080 },
    fps: { num: 30, den: 1 },
    audioSampleRate: 48000,
    audioChannels: 2,
  },
};

// =============================================================================
// Tests
// =============================================================================

describe('Clip Group/Ungroup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditorToolStore.setState({ activeTool: 'select', previousTool: null });
  });

  // ===========================================================================
  // Context Menu — Group
  // ===========================================================================

  describe('context menu: Group', () => {
    it('should show "Group" as disabled when fewer than 2 clips are selected', () => {
      // Given a track with one clip, only that clip selected
      const onClipGroup = vi.fn();
      const clip = { ...baseClip };

      render(
        <Track
          track={{ ...videoTrack, clips: [clip] }}
          clips={[clip]}
          zoom={100}
          selectedClipIds={['clip_001']}
          onClipGroup={onClipGroup}
        />,
      );

      // When right-clicking the clip
      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      // Then "Group" should be disabled
      const groupButton = screen.getByRole('button', { name: /^Group/ });
      expect(groupButton).toBeInTheDocument();
      expect(groupButton).toBeDisabled();
    });

    it('should show "Group" as enabled when 2+ clips are selected', () => {
      // Given a track with two clips, both selected
      const onClipGroup = vi.fn();
      const clips = [baseClip, secondClip];

      render(
        <Track
          track={{ ...videoTrack, clips }}
          clips={clips}
          zoom={100}
          selectedClipIds={['clip_001', 'clip_002']}
          onClipGroup={onClipGroup}
        />,
      );

      // When right-clicking a clip
      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      // Then "Group" should be enabled
      const groupButton = screen.getByRole('button', { name: /^Group/ });
      expect(groupButton).toBeInTheDocument();
      expect(groupButton).not.toBeDisabled();
    });

    it('should call onClipGroup with selected clip IDs when clicked', () => {
      // Given a track with two clips, both selected
      const onClipGroup = vi.fn();
      const clips = [baseClip, secondClip];

      render(
        <Track
          track={{ ...videoTrack, clips }}
          clips={clips}
          zoom={100}
          selectedClipIds={['clip_001', 'clip_002']}
          onClipGroup={onClipGroup}
        />,
      );

      // When right-clicking and clicking "Group"
      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      fireEvent.click(screen.getByRole('button', { name: /^Group/ }));

      // Then handler should be called with selected clip IDs
      expect(onClipGroup).toHaveBeenCalledWith(['clip_001', 'clip_002']);
    });

    it('should show "Group" as disabled when no onClipGroup handler provided', () => {
      // Given no handler
      const clips = [baseClip, secondClip];

      render(
        <Track
          track={{ ...videoTrack, clips }}
          clips={clips}
          zoom={100}
          selectedClipIds={['clip_001', 'clip_002']}
        />,
      );

      // When right-clicking
      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      // Then "Group" should be disabled
      const groupButton = screen.getByRole('button', { name: /^Group/ });
      expect(groupButton).toBeDisabled();
    });
  });

  // ===========================================================================
  // Context Menu — Ungroup
  // ===========================================================================

  describe('context menu: Ungroup', () => {
    it('should show "Ungroup" as disabled when clip is not grouped', () => {
      // Given a clip without groupId
      const onClipUngroup = vi.fn();
      const resolveGroupClipRefs = vi.fn().mockReturnValue([]);
      const clip = { ...baseClip };

      render(
        <Track
          track={{ ...videoTrack, clips: [clip] }}
          clips={[clip]}
          zoom={100}
          selectedClipIds={['clip_001']}
          onClipUngroup={onClipUngroup}
          resolveGroupClipRefs={resolveGroupClipRefs}
        />,
      );

      // When right-clicking the clip
      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      // Then "Ungroup" should be disabled
      const ungroupButton = screen.getByRole('button', { name: /Ungroup/ });
      expect(ungroupButton).toBeInTheDocument();
      expect(ungroupButton).toBeDisabled();
    });

    it('should show "Ungroup" as enabled when clip is grouped', () => {
      // Given a grouped clip with resolveGroupClipRefs returning group members
      const onClipUngroup = vi.fn();
      const groupedClip = { ...baseClip, groupId: 'group-abc' };
      const resolveGroupClipRefs = vi.fn().mockReturnValue([
        { trackId: 'track_001', clipId: 'clip_001' },
        { trackId: 'track_001', clipId: 'clip_002' },
      ]);

      render(
        <Track
          track={{ ...videoTrack, clips: [groupedClip, secondClip] }}
          clips={[groupedClip, secondClip]}
          zoom={100}
          selectedClipIds={['clip_001']}
          onClipUngroup={onClipUngroup}
          resolveGroupClipRefs={resolveGroupClipRefs}
        />,
      );

      // When right-clicking the grouped clip
      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      // Then "Ungroup" should be enabled
      const ungroupButton = screen.getByRole('button', { name: /Ungroup/ });
      expect(ungroupButton).toBeInTheDocument();
      expect(ungroupButton).not.toBeDisabled();
    });

    it('should call onClipUngroup with group clip refs when clicked', () => {
      // Given a grouped clip
      const onClipUngroup = vi.fn();
      const groupedClip = { ...baseClip, groupId: 'group-abc' };
      const groupRefs = [
        { trackId: 'track_001', clipId: 'clip_001' },
        { trackId: 'track_002', clipId: 'clip_002' },
      ];
      const resolveGroupClipRefs = vi.fn().mockReturnValue(groupRefs);

      render(
        <Track
          track={{ ...videoTrack, clips: [groupedClip] }}
          clips={[groupedClip]}
          zoom={100}
          selectedClipIds={['clip_001']}
          onClipUngroup={onClipUngroup}
          resolveGroupClipRefs={resolveGroupClipRefs}
        />,
      );

      // When clicking "Ungroup"
      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      fireEvent.click(screen.getByRole('button', { name: /Ungroup/ }));

      // Then handler should be called with resolved group refs
      expect(onClipUngroup).toHaveBeenCalledWith(groupRefs);
    });
  });

  // ===========================================================================
  // Visual Indicator — GRP Badge
  // ===========================================================================

  describe('visual indicator: GRP badge', () => {
    it('should show GRP badge when clip has groupId', () => {
      // Given a clip with groupId set
      const groupedClip: ClipType = { ...baseClip, groupId: 'group-123' };

      render(<Clip clip={groupedClip} zoom={100} selected={false} />);

      // Then GRP badge should be visible
      const badge = screen.getByTestId('group-indicator');
      expect(badge).toBeInTheDocument();
      expect(badge.textContent).toBe('GRP');
    });

    it('should not show GRP badge when clip has no groupId', () => {
      // Given a clip without groupId
      render(<Clip clip={baseClip} zoom={100} selected={false} />);

      // Then GRP badge should not be present
      expect(screen.queryByTestId('group-indicator')).toBeNull();
    });

    it('should show emerald ring on grouped clip when not selected', () => {
      // Given a grouped clip that is not selected
      const groupedClip: ClipType = { ...baseClip, groupId: 'group-abc' };

      render(<Clip clip={groupedClip} zoom={100} selected={false} />);

      // Then the clip container should have the emerald ring class
      const clipEl = screen.getByTestId(`clip-${groupedClip.id}`);
      expect(clipEl.className).toContain('ring-emerald');
    });

    it('should show primary ring instead of emerald when selected', () => {
      // Given a grouped clip that is selected
      const groupedClip: ClipType = { ...baseClip, groupId: 'group-abc' };

      render(<Clip clip={groupedClip} zoom={100} selected={true} />);

      // Then primary selection ring should take precedence
      const clipEl = screen.getByTestId(`clip-${groupedClip.id}`);
      expect(clipEl.className).toContain('ring-primary');
      expect(clipEl.className).not.toContain('ring-emerald');
    });
  });

  // ===========================================================================
  // Handler Functions
  // ===========================================================================

  describe('useTimelineActions group handlers', () => {
    const mockExecuteCommand = vi.fn().mockResolvedValue({ opId: 'op1', changes: [] });

    beforeEach(() => {
      useProjectStore.setState({
        executeCommand: mockExecuteCommand,
        sequences: new Map([[mockSequence.id, mockSequence]]),
      });
    });

    it('should expose handleGroupClips and handleUngroupClips', () => {
      // Given a sequence
      const sequence: Sequence = {
        ...mockSequence,
        tracks: [{ ...videoTrack, clips: [baseClip] }],
      };

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      // Then both handlers should be defined
      expect(result.current.handleGroupClips).toBeDefined();
      expect(result.current.handleUngroupClips).toBeDefined();
    });

    it('should not execute command with fewer than 2 clips in handleGroupClips', async () => {
      // Given a sequence with one clip
      const sequence: Sequence = {
        ...mockSequence,
        tracks: [{ ...videoTrack, clips: [baseClip] }],
      };

      useProjectStore.setState({
        executeCommand: mockExecuteCommand,
        sequences: new Map([[sequence.id, sequence]]),
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      // When calling handleGroupClips with only 1 clip
      await result.current.handleGroupClips(['clip_001']);

      // Then no command should be executed
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it('should execute GroupClips command when 2+ valid clips are provided', async () => {
      // Given a sequence with two clips on the same track
      const sequence: Sequence = {
        ...mockSequence,
        tracks: [{ ...videoTrack, clips: [baseClip, secondClip] }],
      };

      useProjectStore.setState({
        executeCommand: mockExecuteCommand,
        sequences: new Map([[sequence.id, sequence]]),
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      // When calling handleGroupClips with 2 clip IDs
      await result.current.handleGroupClips(['clip_001', 'clip_002']);

      // Then executeCommand should be called with GroupClips command
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'GroupClips',
          payload: expect.objectContaining({
            sequenceId: 'seq_001',
            clipRefs: expect.arrayContaining([
              { trackId: 'track_001', clipId: 'clip_001' },
              { trackId: 'track_001', clipId: 'clip_002' },
            ]),
          }),
        }),
      );
    });

    it('should not execute command with empty refs in handleUngroupClips', async () => {
      // Given a sequence
      const sequence: Sequence = {
        ...mockSequence,
        tracks: [{ ...videoTrack, clips: [baseClip] }],
      };

      useProjectStore.setState({
        executeCommand: mockExecuteCommand,
        sequences: new Map([[sequence.id, sequence]]),
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      // When calling handleUngroupClips with empty refs
      await result.current.handleUngroupClips([]);

      // Then no command should be executed
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });
  });
});
