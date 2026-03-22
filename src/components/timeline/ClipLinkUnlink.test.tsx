/**
 * Clip Link/Unlink/Detach Audio Tests
 *
 * Integration tests for the Link Clips, Unlink, and Detach Audio feature.
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

const audioTrack: TrackType = {
  ...videoTrack,
  id: 'track_002',
  kind: 'audio',
  name: 'Audio 1',
};

const overlayTrack: TrackType = {
  ...videoTrack,
  id: 'track_003',
  kind: 'overlay',
  name: 'Overlay 1',
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

describe('Clip Link/Unlink/Detach Audio', () => {
  beforeEach(() => {
    useEditorToolStore.setState({ activeTool: 'select', previousTool: null });
  });

  // ===========================================================================
  // Context Menu: "Link Clips" menu item
  // ===========================================================================

  describe('context menu: Link Clips', () => {
    it('should show "Link Clips" as disabled when fewer than 2 clips are selected', () => {
      const onClipLink = vi.fn();
      const clip = { ...baseClip };

      render(
        <Track
          track={{ ...videoTrack, clips: [clip] }}
          clips={[clip]}
          zoom={100}
          selectedClipIds={['clip_001']}
          onClipLink={onClipLink}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      const linkButton = screen.getByRole('button', { name: /Link Clips/ });
      expect(linkButton).toBeInTheDocument();
      expect(linkButton).toBeDisabled();
    });

    it('should show "Link Clips" as enabled when 2 or more clips are selected', () => {
      const onClipLink = vi.fn();
      const clips = [baseClip, secondClip];

      render(
        <Track
          track={{ ...videoTrack, clips }}
          clips={clips}
          zoom={100}
          selectedClipIds={['clip_001', 'clip_002']}
          onClipLink={onClipLink}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      const linkButton = screen.getByRole('button', { name: /Link Clips/ });
      expect(linkButton).toBeInTheDocument();
      expect(linkButton).not.toBeDisabled();
    });

    it('should show "Link Clips" as disabled when no onClipLink handler is provided', () => {
      const clips = [baseClip, secondClip];

      render(
        <Track
          track={{ ...videoTrack, clips }}
          clips={clips}
          zoom={100}
          selectedClipIds={['clip_001', 'clip_002']}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      const linkButton = screen.getByRole('button', { name: /Link Clips/ });
      expect(linkButton).toBeDisabled();
    });

    it('should call onClipLink with clip refs when Link Clips is clicked', () => {
      const onClipLink = vi.fn();
      const clips = [baseClip, secondClip];

      render(
        <Track
          track={{ ...videoTrack, clips }}
          clips={clips}
          zoom={100}
          selectedClipIds={['clip_001', 'clip_002']}
          onClipLink={onClipLink}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      fireEvent.click(screen.getByRole('button', { name: /Link Clips/ }));

      expect(onClipLink).toHaveBeenCalledWith(['clip_001', 'clip_002']);
    });
  });

  // ===========================================================================
  // Context Menu: "Unlink" menu item
  // ===========================================================================

  describe('context menu: Unlink', () => {
    it('should show "Unlink" as disabled when clip has no linkGroupId', () => {
      const onClipUnlink = vi.fn();
      const clip = { ...baseClip };

      render(
        <Track
          track={{ ...videoTrack, clips: [clip] }}
          clips={[clip]}
          zoom={100}
          onClipUnlink={onClipUnlink}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      const unlinkButton = screen.getByRole('button', { name: /^Unlink$/ });
      expect(unlinkButton).toBeInTheDocument();
      expect(unlinkButton).toBeDisabled();
    });

    it('should show "Unlink" as disabled when clip has linkGroupId but no resolver is provided', () => {
      const onClipUnlink = vi.fn();
      const linkedClip: ClipType = { ...baseClip, linkGroupId: 'link_group_001' };

      render(
        <Track
          track={{ ...videoTrack, clips: [linkedClip] }}
          clips={[linkedClip]}
          zoom={100}
          onClipUnlink={onClipUnlink}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      const unlinkButton = screen.getByRole('button', { name: /^Unlink$/ });
      expect(unlinkButton).toBeInTheDocument();
      expect(unlinkButton).toBeDisabled();
    });

    it('should show "Unlink" as disabled when no onClipUnlink handler is provided', () => {
      const linkedClip: ClipType = { ...baseClip, linkGroupId: 'link_group_001' };

      render(
        <Track
          track={{ ...videoTrack, clips: [linkedClip] }}
          clips={[linkedClip]}
          zoom={100}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      const unlinkButton = screen.getByRole('button', { name: /^Unlink$/ });
      expect(unlinkButton).toBeDisabled();
    });

    it('should call onClipUnlink with resolved linked group when Unlink is clicked', () => {
      const onClipUnlink = vi.fn();
      const linkedClip: ClipType = { ...baseClip, linkGroupId: 'link_group_001' };

      render(
        <Track
          track={{ ...videoTrack, clips: [linkedClip] }}
          clips={[linkedClip]}
          zoom={100}
          onClipUnlink={onClipUnlink}
          resolveLinkedClipRefs={() => [
            { trackId: 'track_001', clipId: 'clip_001' },
            { trackId: 'track_003', clipId: 'clip_003' },
          ]}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      fireEvent.click(screen.getByRole('button', { name: /^Unlink$/ }));

      expect(onClipUnlink).toHaveBeenCalledWith([
        { trackId: 'track_001', clipId: 'clip_001' },
        { trackId: 'track_003', clipId: 'clip_003' },
      ]);
    });

    it('should call onClipUnlink with the full linked group when resolver is provided', () => {
      const onClipUnlink = vi.fn();
      const linkedClip: ClipType = { ...baseClip, linkGroupId: 'link_group_001' };

      render(
        <Track
          track={{ ...videoTrack, clips: [linkedClip] }}
          clips={[linkedClip]}
          zoom={100}
          onClipUnlink={onClipUnlink}
          resolveLinkedClipRefs={() => [
            { trackId: 'track_001', clipId: 'clip_001' },
            { trackId: 'track_002', clipId: 'clip_002' },
          ]}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      fireEvent.click(screen.getByRole('button', { name: /^Unlink$/ }));

      expect(onClipUnlink).toHaveBeenCalledWith([
        { trackId: 'track_001', clipId: 'clip_001' },
        { trackId: 'track_002', clipId: 'clip_002' },
      ]);
    });
  });

  // ===========================================================================
  // Context Menu: "Detach Audio" menu item
  // ===========================================================================

  describe('context menu: Detach Audio', () => {
    it('should show "Detach Audio" on video tracks', () => {
      const onClipDetachAudio = vi.fn();
      const clip = { ...baseClip };

      render(
        <Track
          track={{ ...videoTrack, clips: [clip] }}
          clips={[clip]}
          zoom={100}
          onClipDetachAudio={onClipDetachAudio}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      expect(screen.getByRole('button', { name: /Detach Audio/ })).toBeInTheDocument();
    });

    it('should show "Detach Audio" on overlay tracks', () => {
      const onClipDetachAudio = vi.fn();
      const clip = { ...baseClip };

      render(
        <Track
          track={{ ...overlayTrack, clips: [clip] }}
          clips={[clip]}
          zoom={100}
          onClipDetachAudio={onClipDetachAudio}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      expect(screen.getByRole('button', { name: /Detach Audio/ })).toBeInTheDocument();
    });

    it('should NOT show "Detach Audio" on audio tracks', () => {
      const onClipDetachAudio = vi.fn();
      const clip = { ...baseClip };

      render(
        <Track
          track={{ ...audioTrack, clips: [clip] }}
          clips={[clip]}
          zoom={100}
          onClipDetachAudio={onClipDetachAudio}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      expect(screen.queryByRole('button', { name: /Detach Audio/ })).not.toBeInTheDocument();
    });

    it('should call onClipDetachAudio when Detach Audio is clicked', () => {
      const onClipDetachAudio = vi.fn();
      const clip = { ...baseClip };

      render(
        <Track
          track={{ ...videoTrack, clips: [clip] }}
          clips={[clip]}
          zoom={100}
          onClipDetachAudio={onClipDetachAudio}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      fireEvent.click(screen.getByRole('button', { name: /Detach Audio/ }));

      expect(onClipDetachAudio).toHaveBeenCalledWith('clip_001', 'track_001');
    });

    it('should show "Detach Audio" as disabled when no onClipDetachAudio handler is provided', () => {
      const clip = { ...baseClip };

      render(
        <Track
          track={{ ...videoTrack, clips: [clip] }}
          clips={[clip]}
          zoom={100}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));

      const detachButton = screen.getByRole('button', { name: /Detach Audio/ });
      expect(detachButton).toBeDisabled();
    });
  });

  // ===========================================================================
  // Visual Indicator: "LK" badge (Clip.tsx)
  // ===========================================================================

  describe('link indicator badge', () => {
    it('should show "LK" badge when clip has linkGroupId', () => {
      const linkedClip: ClipType = { ...baseClip, linkGroupId: 'link_group_001' };

      render(<Clip clip={linkedClip} zoom={100} selected={false} />);

      const indicator = screen.getByTestId('link-indicator');
      expect(indicator).toBeInTheDocument();
      expect(indicator).toHaveTextContent('LK');
    });

    it('should not show "LK" badge when clip has no linkGroupId', () => {
      render(<Clip clip={baseClip} zoom={100} selected={false} />);

      expect(screen.queryByTestId('link-indicator')).not.toBeInTheDocument();
    });

    it('should not show "LK" badge when linkGroupId is undefined', () => {
      const clipWithoutLink: ClipType = { ...baseClip, linkGroupId: undefined };

      render(<Clip clip={clipWithoutLink} zoom={100} selected={false} />);

      expect(screen.queryByTestId('link-indicator')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Handler Functions (useTimelineActions.ts)
  // ===========================================================================

  describe('useTimelineActions handlers', () => {
    const mockExecuteCommand = vi.fn().mockResolvedValue({ success: true });

    beforeEach(() => {
      mockExecuteCommand.mockClear();
      useProjectStore.setState({
        executeCommand: mockExecuteCommand,
        sequences: new Map([[mockSequence.id, mockSequence]]),
      });
    });

    it('should resolve track IDs and call executeCommand with LinkClips type', async () => {
      const sequenceWithLinkedTracks: Sequence = {
        ...mockSequence,
        tracks: [
          { ...videoTrack, clips: [baseClip] },
          { ...audioTrack, clips: [secondClip] },
        ],
      };

      useProjectStore.setState({
        executeCommand: mockExecuteCommand,
        sequences: new Map([[sequenceWithLinkedTracks.id, sequenceWithLinkedTracks]]),
      });

      const { result } = renderHook(() =>
        useTimelineActions({ sequence: sequenceWithLinkedTracks }),
      );

      await result.current.handleLinkClips(['clip_001', 'clip_002']);

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'LinkClips',
        payload: {
          sequenceId: sequenceWithLinkedTracks.id,
          clipRefs: [
            { trackId: 'track_001', clipId: 'clip_001' },
            { trackId: 'track_002', clipId: 'clip_002' },
          ],
        },
      });
    });

    it('should call executeCommand with UnlinkClips type when handleUnlinkClips is invoked', async () => {
      const { result } = renderHook(() =>
        useTimelineActions({ sequence: mockSequence }),
      );

      const clipRefs = [{ trackId: 'track_001', clipId: 'clip_001' }];

      await result.current.handleUnlinkClips(clipRefs);

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'UnlinkClips',
        payload: {
          sequenceId: mockSequence.id,
          clipRefs,
        },
      });
    });

    it('should call executeCommand with DetachAudio type when handleDetachAudio is invoked', async () => {
      const { result } = renderHook(() =>
        useTimelineActions({ sequence: mockSequence }),
      );

      await result.current.handleDetachAudio('clip_001', 'track_001');

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'DetachAudio',
        payload: {
          sequenceId: mockSequence.id,
          trackId: 'track_001',
          clipId: 'clip_001',
        },
      });
    });

    it('should not call executeCommand when handleLinkClips receives fewer than 2 refs', async () => {
      const { result } = renderHook(() =>
        useTimelineActions({ sequence: mockSequence }),
      );

      await result.current.handleLinkClips(['clip_001']);

      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it('should not call executeCommand when handleUnlinkClips receives empty refs', async () => {
      const { result } = renderHook(() =>
        useTimelineActions({ sequence: mockSequence }),
      );

      await result.current.handleUnlinkClips([]);

      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it('should not call executeCommand when sequence is null', async () => {
      const { result } = renderHook(() =>
        useTimelineActions({ sequence: null }),
      );

      await result.current.handleLinkClips(['clip_001', 'clip_002']);

      await result.current.handleUnlinkClips([
        { trackId: 'track_001', clipId: 'clip_001' },
      ]);

      await result.current.handleDetachAudio('clip_001', 'track_001');

      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });
  });
});
