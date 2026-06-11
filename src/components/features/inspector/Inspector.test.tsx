/**
 * Inspector Component Tests
 *
 * TDD: Tests for the property inspector panel
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { Inspector } from './Inspector';
import { createTextClipData, createTitleTextClipData } from '@/types';
import type { SelectedTextClip } from './TextInspector';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock color feature sections — they have dedicated test suites and use hooks
// that cause re-render loops when rendered without full app context.
vi.mock('@/components/features/color', () => ({
  PowerWindowSection: () => null,
  ColorMatchSection: () => null,
}));

describe('Inspector', () => {
  const mockedInvoke = vi.mocked(invoke);

  // ===========================================================================
  // Empty State Tests
  // ===========================================================================

  it('renders empty state when no selection', () => {
    render(<Inspector />);

    expect(screen.getByTestId('inspector')).toBeInTheDocument();
    expect(screen.getByText(/no selection/i)).toBeInTheDocument();
  });

  // ===========================================================================
  // Clip Selection Tests
  // ===========================================================================

  it('renders clip properties when clip is selected', () => {
    const selectedClip = {
      id: 'clip-1',
      name: 'Test Clip',
      assetId: 'asset-1',
      range: {
        sourceInSec: 0,
        sourceOutSec: 10,
      },
      place: {
        trackId: 'track-1',
        timelineInSec: 5,
      },
    };

    render(<Inspector selectedClip={selectedClip} />);

    expect(screen.getByText('Clip Properties')).toBeInTheDocument();
    expect(screen.getByText('Test Clip')).toBeInTheDocument();
  });

  it('displays clip duration correctly', () => {
    const selectedClip = {
      id: 'clip-1',
      name: 'Test Clip',
      assetId: 'asset-1',
      range: {
        sourceInSec: 5,
        sourceOutSec: 15,
      },
      place: {
        trackId: 'track-1',
        timelineInSec: 0,
      },
    };

    render(<Inspector selectedClip={selectedClip} />);

    // Duration should be 10 seconds (15 - 5)
    expect(screen.getByTestId('clip-duration')).toHaveTextContent('10.00s');
  });

  it('commits clip transform changes from numeric controls', () => {
    const onClipTransformChange = vi.fn();
    const transform = {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    };

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          sequenceId: 'seq-1',
          name: 'Test Clip',
          assetId: 'asset-1',
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
          },
          transform,
        }}
        onClipTransformChange={onClipTransformChange}
      />,
    );

    const positionXInput = screen.getByTestId('clip-position-x-input');
    fireEvent.change(positionXInput, { target: { value: '62.5' } });
    fireEvent.blur(positionXInput);

    expect(onClipTransformChange).toHaveBeenCalledWith('clip-1', 'track-1', {
      ...transform,
      position: { x: 0.625, y: 0.5 },
    });
  });

  it('applies fit fill and reset transform presets', () => {
    const onClipTransformChange = vi.fn();
    const transform = {
      position: { x: 0.2, y: 0.3 },
      scale: { x: 1.5, y: 1.25 },
      rotationDeg: 12,
      anchor: { x: 0.1, y: 0.9 },
    };
    const defaultTransform = {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    };

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          sequenceId: 'seq-1',
          name: 'Test Clip',
          assetId: 'asset-1',
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
          },
          transform,
          sourceSize: { width: 1920, height: 1080 },
          canvasSize: { width: 1080, height: 1920 },
        }}
        onClipTransformChange={onClipTransformChange}
      />,
    );

    fireEvent.click(screen.getByTestId('clip-fit-button'));
    expect(onClipTransformChange).toHaveBeenLastCalledWith('clip-1', 'track-1', defaultTransform);

    fireEvent.click(screen.getByTestId('clip-fill-button'));
    expect(onClipTransformChange).toHaveBeenLastCalledWith('clip-1', 'track-1', {
      ...defaultTransform,
      scale: { x: 3.16, y: 3.16 },
    });

    fireEvent.click(screen.getByTestId('clip-reset-transform-button'));
    expect(onClipTransformChange).toHaveBeenLastCalledWith('clip-1', 'track-1', defaultTransform);
  });

  it('commits clip opacity changes as normalized values', () => {
    const onClipOpacityChange = vi.fn();

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          sequenceId: 'seq-1',
          name: 'Test Clip',
          assetId: 'asset-1',
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
          },
          opacity: 0.8,
        }}
        onClipOpacityChange={onClipOpacityChange}
      />,
    );

    const opacityInput = screen.getByTestId('clip-opacity-input');
    fireEvent.change(opacityInput, { target: { value: '45' } });
    fireEvent.blur(opacityInput);

    expect(onClipOpacityChange).toHaveBeenCalledWith('clip-1', 'track-1', 0.45);
  });

  it('commits clip audio changes from inspector controls', () => {
    const onClipAudioChange = vi.fn();

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          sequenceId: 'seq-1',
          name: 'Test Clip',
          assetId: 'asset-1',
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
          },
          audio: {
            volumeDb: -3,
            pan: 0.25,
            muted: false,
            fadeInSec: 0.5,
            fadeOutSec: 1,
            audioRole: 'dialogue',
            audioTags: ['interview', 'lav'],
          },
        }}
        onClipAudioChange={onClipAudioChange}
      />,
    );

    expect(screen.getByTestId('clip-audio-gain-input')).toHaveValue(-3);
    expect(screen.getByTestId('clip-audio-pan-input')).toHaveValue(0.25);
    expect(screen.getByTestId('clip-audio-role-select')).toHaveValue('dialogue');
    expect(screen.getByTestId('clip-audio-tags-input')).toHaveValue('interview, lav');

    fireEvent.change(screen.getByTestId('clip-audio-pan-input'), {
      target: { value: '-0.5' },
    });
    expect(onClipAudioChange).toHaveBeenCalledWith('clip-1', 'track-1', { pan: -0.5 });

    fireEvent.change(screen.getByTestId('clip-audio-fade-in-input'), {
      target: { value: '1.25' },
    });
    expect(onClipAudioChange).toHaveBeenCalledWith('clip-1', 'track-1', { fadeInSec: 1.25 });

    fireEvent.change(screen.getByTestId('clip-audio-role-select'), {
      target: { value: 'music' },
    });
    expect(onClipAudioChange).toHaveBeenCalledWith('clip-1', 'track-1', { audioRole: 'music' });

    fireEvent.change(screen.getByTestId('clip-audio-tags-input'), {
      target: { value: 'Score, Music, score' },
    });
    expect(onClipAudioChange).toHaveBeenCalledWith('clip-1', 'track-1', {
      audioTags: ['score', 'music'],
    });
  });

  it('creates editable motion keyframes from clip motion presets', () => {
    const onClipMotionKeyframesChange = vi.fn();

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          sequenceId: 'seq-1',
          name: 'Test Clip',
          assetId: 'asset-1',
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
            durationSec: 8,
          },
          transform: {
            position: { x: 0.5, y: 0.5 },
            scale: { x: 1, y: 1 },
            rotationDeg: 0,
            anchor: { x: 0.5, y: 0.5 },
          },
          sourceSize: { width: 1920, height: 1080 },
          canvasSize: { width: 1920, height: 1080 },
        }}
        onClipMotionKeyframesChange={onClipMotionKeyframesChange}
      />,
    );

    fireEvent.click(screen.getByTestId('clip-motion-zoom-in-button'));

    expect(onClipMotionKeyframesChange).toHaveBeenCalledWith(
      'clip-1',
      'track-1',
      expect.arrayContaining([
        expect.objectContaining({
          timeOffset: 0,
          interpolation: 'linear',
          transform: expect.objectContaining({ scale: { x: 1, y: 1 } }),
        }),
        expect.objectContaining({
          timeOffset: 8,
          interpolation: 'linear',
          transform: expect.objectContaining({ scale: { x: 1.2, y: 1.2 } }),
        }),
      ]),
    );
  });

  it('saves a selected effect as a preset through IPC', async () => {
    const user = userEvent.setup();

    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'save_effect_preset') {
        return Promise.resolve({
          id: 'preset-1',
          name: 'Brightness',
          description: null,
          effectType: 'brightness',
          category: 'color',
          params: { value: 0.5 },
          keyframes: {},
          createdAt: '2026-03-23T00:00:00Z',
          updatedAt: '2026-03-23T00:00:00Z',
        });
      }

      if (command === 'list_effect_presets') {
        return Promise.resolve([]);
      }

      return Promise.reject(new Error(`Unhandled command: ${command}`));
    });

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          name: 'Test Clip',
          assetId: 'asset-1',
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
          },
          effects: [
            {
              id: 'effect-1',
              effectType: 'brightness',
              enabled: true,
              params: { value: 0.5 },
              keyframes: {},
              order: 0,
            },
          ],
        }}
      />,
    );

    await user.click(screen.getByTestId('effect-item-effect-1'));
    await user.click(screen.getByTestId('save-selected-effect-preset-button'));

    await waitFor(() => {
      expect(screen.getByTestId('preset-name-input')).toHaveValue('Brightness');
    });

    await user.click(screen.getByTestId('preset-save-btn'));

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('save_effect_preset', {
        name: 'Brightness',
        description: null,
        effectType: 'brightness',
        params: { value: 0.5 },
        keyframes: null,
      });
    });
  });

  it('renders the selected effect inspector after choosing an effect', async () => {
    const user = userEvent.setup();

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          sequenceId: 'seq-1',
          name: 'Test Clip',
          assetId: 'asset-1',
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
          },
          effects: [
            {
              id: 'effect-1',
              effectType: 'brightness',
              enabled: true,
              params: { value: 0.5 },
              keyframes: {},
              order: 0,
            },
          ],
        }}
        onEffectChange={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('effect-item-effect-1'));

    expect(screen.getByTestId('effect-inspector')).toBeInTheDocument();
    expect(screen.getByLabelText('Brightness')).toBeInTheDocument();
  });

  // ===========================================================================
  // Asset Selection Tests
  // ===========================================================================

  it('renders asset properties when asset is selected', () => {
    const selectedAsset = {
      id: 'asset-1',
      name: 'video.mp4',
      kind: 'video' as const,
      uri: '/path/to/video.mp4',
      durationSec: 120,
      resolution: { width: 1920, height: 1080 },
    };

    render(<Inspector selectedAsset={selectedAsset} />);

    expect(screen.getByText('Asset Properties')).toBeInTheDocument();
    expect(screen.getByText('video.mp4')).toBeInTheDocument();
    expect(screen.getByTestId('asset-type')).toHaveTextContent('video');
  });

  // ===========================================================================
  // Property Display Tests
  // ===========================================================================

  it('displays asset resolution', () => {
    const selectedAsset = {
      id: 'asset-1',
      name: 'video.mp4',
      kind: 'video' as const,
      uri: '/path/to/video.mp4',
      durationSec: 120,
      resolution: { width: 1920, height: 1080 },
    };

    render(<Inspector selectedAsset={selectedAsset} />);

    expect(screen.getByTestId('asset-resolution')).toHaveTextContent('1920 x 1080');
  });

  it('displays asset duration formatted', () => {
    const selectedAsset = {
      id: 'asset-1',
      name: 'video.mp4',
      kind: 'video' as const,
      uri: '/path/to/video.mp4',
      durationSec: 125.5,
    };

    render(<Inspector selectedAsset={selectedAsset} />);

    // 125.5 seconds = 2:05.50
    expect(screen.getByTestId('asset-duration')).toHaveTextContent('2:05');
  });

  it('displays detailed asset metadata for editorial review', () => {
    const selectedAsset = {
      id: 'asset-1',
      name: 'interview.mov',
      kind: 'video' as const,
      uri: '/project/media/interview.mov',
      durationSec: 125.5,
      fileSize: 1024 * 1024 * 512,
      importedAt: '2026-03-23T12:30:00Z',
      resolution: { width: 3840, height: 2160 },
      video: {
        width: 3840,
        height: 2160,
        fps: { num: 30000, den: 1001 },
        codec: 'prores',
        bitrate: 120_000_000,
        hasAlpha: true,
      },
      audio: {
        sampleRate: 48000,
        channels: 2,
        codec: 'pcm_s24le',
        bitrate: 2304000,
      },
      proxyStatus: 'ready' as const,
      proxyUrl: 'asset://proxy/interview.mp4',
      missing: true,
      relativePath: 'media/interview.mov',
      workspaceManaged: true,
      tags: ['interview', 'a-roll'],
    };

    render(<Inspector selectedAsset={selectedAsset} />);

    expect(screen.getByTestId('asset-status')).toHaveTextContent('Missing');
    expect(screen.getByTestId('asset-video-codec')).toHaveTextContent('prores');
    expect(screen.getByTestId('asset-fps')).toHaveTextContent('29.97 fps');
    expect(screen.getByTestId('asset-audio-codec')).toHaveTextContent('pcm_s24le');
    expect(screen.getByTestId('asset-audio-channels')).toHaveTextContent('Stereo');
    expect(screen.getByTestId('asset-sample-rate')).toHaveTextContent('48,000 Hz');
    expect(screen.getByTestId('asset-file-size')).toHaveTextContent('512.0 MB');
    expect(screen.getByTestId('asset-proxy-status')).toHaveTextContent('Optimized');
    expect(screen.getByTestId('asset-workspace')).toHaveTextContent('Managed');
    expect(screen.getByTestId('asset-tags')).toHaveTextContent('interview, a-roll');
    expect(screen.getByTestId('asset-relative-path')).toHaveTextContent('media/interview.mov');
    expect(screen.queryByTestId('asset-proxy-url')).not.toBeInTheDocument();
  });

  it('keeps media optimization automatic for selected video assets', () => {
    const onGenerateProxy = vi.fn();
    const onCancelProxy = vi.fn();
    const onUseOriginalMedia = vi.fn();

    render(
      <Inspector
        selectedAsset={{
          id: 'asset-1',
          name: 'video.mp4',
          kind: 'video',
          uri: '/path/to/video.mp4',
          proxyStatus: 'ready',
          proxyUrl: '/proxy/video.mp4',
        }}
      />,
    );

    expect(screen.getByTestId('asset-proxy-status')).toHaveTextContent('Optimized');
    expect(onGenerateProxy).not.toHaveBeenCalled();
    expect(onCancelProxy).not.toHaveBeenCalled();
    expect(onUseOriginalMedia).not.toHaveBeenCalled();
    expect(screen.queryByTestId('asset-generate-proxy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('asset-use-original')).not.toBeInTheDocument();
    expect(screen.queryByTestId('asset-cancel-proxy')).not.toBeInTheDocument();
  });

  it('shows media optimization progress without exposing manual cancellation', () => {
    const onCancelProxy = vi.fn();

    render(
      <Inspector
        selectedAsset={{
          id: 'asset-1',
          name: 'video.mp4',
          kind: 'video',
          uri: '/path/to/video.mp4',
          proxyStatus: 'generating',
          proxyJobId: 'job-1',
        }}
      />,
    );

    expect(screen.getByTestId('asset-proxy-status')).toHaveTextContent('Optimizing media');
    expect(onCancelProxy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('asset-cancel-proxy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('asset-generate-proxy')).not.toBeInTheDocument();
  });

  it('exposes media cache status and cache generation controls for selected assets', async () => {
    const onGenerateThumbnail = vi.fn().mockResolvedValue('/cache/thumb.jpg');
    const onLoadWaveformData = vi.fn().mockResolvedValue({
      samplesPerSecond: 100,
      peaks: [0.2, 0.7],
      durationSec: 2,
      channels: 2,
    });
    const onGenerateWaveform = vi.fn().mockResolvedValue({
      samplesPerSecond: 100,
      peaks: [0.1, 0.3, 0.8],
      durationSec: 3,
      channels: 2,
    });
    const onEnsureAudioPreview = vi.fn().mockResolvedValue('/cache/audio-preview.mp3');
    const onClearWaveformUiCache = vi.fn();

    render(
      <Inspector
        selectedAsset={{
          id: 'asset-1',
          name: 'dialogue.wav',
          kind: 'audio',
          uri: '/path/to/dialogue.wav',
          thumbnailUrl: '/cache/existing-thumb.jpg',
        }}
        onGenerateThumbnail={onGenerateThumbnail}
        onLoadWaveformData={onLoadWaveformData}
        onGenerateWaveform={onGenerateWaveform}
        onEnsureAudioPreview={onEnsureAudioPreview}
        waveformUiCacheSize={3}
        onClearWaveformUiCache={onClearWaveformUiCache}
      />,
    );

    expect(screen.getByTestId('asset-thumbnail-cache')).toHaveTextContent('Ready');
    expect(onLoadWaveformData).toHaveBeenCalledWith('asset-1');

    await waitFor(() => {
      expect(screen.getByTestId('asset-waveform-cache')).toHaveTextContent('2 peaks @ 100 Hz');
    });

    fireEvent.click(screen.getByTestId('asset-regenerate-thumbnail'));
    fireEvent.click(screen.getByTestId('asset-generate-waveform'));
    fireEvent.click(screen.getByTestId('asset-ensure-audio-preview'));
    fireEvent.click(screen.getByTestId('asset-clear-waveform-ui-cache'));

    await waitFor(() => {
      expect(onGenerateThumbnail).toHaveBeenCalledWith('asset-1');
      expect(onGenerateWaveform).toHaveBeenCalledWith('asset-1');
      expect(onEnsureAudioPreview).toHaveBeenCalledWith('asset-1');
    });
    expect(onClearWaveformUiCache).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.getByTestId('asset-waveform-cache')).toHaveTextContent('3 peaks @ 100 Hz');
      expect(screen.getByTestId('asset-audio-preview-cache')).toHaveTextContent('Ready');
      expect(screen.getByTestId('asset-audio-preview-url')).toHaveTextContent(
        '/cache/audio-preview.mp3',
      );
    });
  });

  // ===========================================================================
  // Caption Selection Tests
  // ===========================================================================

  it('renders caption properties when caption is selected', () => {
    const selectedCaption = {
      id: 'cap-1',
      text: 'Hello World',
      startSec: 0,
      endSec: 5,
      style: {
        fontFamily: 'Arial',
        fontSize: 24,
        fontWeight: 'normal' as const,
        color: { r: 255, g: 255, b: 255, a: 255 },
        outlineColor: { r: 0, g: 0, b: 0, a: 255 },
        outlineWidth: 2,
        shadowColor: { r: 0, g: 0, b: 0, a: 128 },
        shadowOffset: 2,
        alignment: 'center' as const,
        italic: false,
        underline: false,
      },
    };

    render(<Inspector selectedCaption={selectedCaption} />);

    expect(screen.getByText('Caption Properties')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Hello World')).toBeInTheDocument();
  });

  it('calls onCaptionChange when text is updated', () => {
    const selectedCaption = {
      id: 'cap-1',
      text: 'Hello',
      startSec: 0,
      endSec: 5,
      style: {
        fontFamily: 'Arial',
        fontSize: 24,
        fontWeight: 'normal' as const,
        color: { r: 255, g: 255, b: 255, a: 255 },
        outlineColor: { r: 0, g: 0, b: 0, a: 255 },
        outlineWidth: 2,
        shadowColor: { r: 0, g: 0, b: 0, a: 128 },
        shadowOffset: 2,
        alignment: 'center' as const,
        italic: false,
        underline: false,
      },
    };

    const handleCaptionChange = vi.fn();

    render(<Inspector selectedCaption={selectedCaption} onCaptionChange={handleCaptionChange} />);

    const textarea = screen.getByDisplayValue('Hello');
    fireEvent.change(textarea, { target: { value: 'Hello World' } });

    expect(handleCaptionChange).toHaveBeenCalledWith('cap-1', 'text', 'Hello World');
  });

  it('calls onCaptionChange when caption style is updated', () => {
    const selectedCaption = {
      id: 'cap-1',
      text: 'Hello',
      startSec: 0,
      endSec: 5,
      style: {
        fontFamily: 'Arial',
        fontSize: 24,
        fontWeight: 'normal' as const,
        color: { r: 255, g: 255, b: 255, a: 255 },
        outlineColor: { r: 0, g: 0, b: 0, a: 255 },
        outlineWidth: 2,
        shadowColor: { r: 0, g: 0, b: 0, a: 128 },
        shadowOffset: 2,
        alignment: 'center' as const,
        italic: false,
        underline: false,
      },
    };

    const handleCaptionChange = vi.fn();

    render(<Inspector selectedCaption={selectedCaption} onCaptionChange={handleCaptionChange} />);

    fireEvent.change(screen.getByTestId('caption-font-size'), { target: { value: '48' } });

    expect(handleCaptionChange).toHaveBeenCalledWith(
      'cap-1',
      'style',
      expect.objectContaining({
        fontFamily: 'Arial',
        fontSize: 48,
        color: { r: 255, g: 255, b: 255, a: 255 },
        outlineWidth: 2,
      }),
    );
  });

  it('allows custom caption font names and numeric bold toggles', () => {
    const selectedCaption = {
      id: 'cap-1',
      text: 'Hello',
      startSec: 0,
      endSec: 5,
      style: {
        fontFamily: 'Arial',
        fontSize: 24,
        fontWeight: 'normal' as const,
        color: { r: 255, g: 255, b: 255, a: 255 },
        outlineColor: { r: 0, g: 0, b: 0, a: 255 },
        outlineWidth: 2,
        shadowColor: { r: 0, g: 0, b: 0, a: 128 },
        shadowOffset: 2,
        alignment: 'center' as const,
        italic: false,
        underline: false,
      },
    };

    const handleCaptionChange = vi.fn();

    render(<Inspector selectedCaption={selectedCaption} onCaptionChange={handleCaptionChange} />);

    fireEvent.change(screen.getByTestId('caption-font-family-input'), {
      target: { value: 'Brand Caption' },
    });
    expect(handleCaptionChange).toHaveBeenLastCalledWith(
      'cap-1',
      'style',
      expect.objectContaining({
        fontFamily: 'Brand Caption',
      }),
    );

    fireEvent.click(screen.getByTestId('caption-bold-toggle'));
    expect(handleCaptionChange).toHaveBeenLastCalledWith(
      'cap-1',
      'style',
      expect.objectContaining({
        fontWeight: 700,
        bold: true,
      }),
    );
  });

  it('disables caption editing controls when readOnly is true', () => {
    const selectedCaption = {
      id: 'cap-1',
      text: 'Hello',
      startSec: 0,
      endSec: 5,
      position: {
        type: 'preset' as const,
        vertical: 'bottom' as const,
        marginPercent: 5,
      },
      style: {
        fontFamily: 'Arial',
        fontSize: 24,
        fontWeight: 'normal' as const,
        color: { r: 255, g: 255, b: 255, a: 255 },
        outlineColor: { r: 0, g: 0, b: 0, a: 255 },
        outlineWidth: 2,
        shadowColor: { r: 0, g: 0, b: 0, a: 128 },
        shadowOffset: 2,
        alignment: 'center' as const,
        italic: false,
        underline: false,
      },
    };

    render(
      <Inspector selectedCaption={selectedCaption} onCaptionChange={vi.fn()} readOnly={true} />,
    );

    expect(screen.getByDisplayValue('Hello')).toBeDisabled();
    expect(screen.getByTestId('caption-position-mode')).toBeDisabled();
    expect(screen.getByTestId('caption-position-margin')).toBeDisabled();
    expect(screen.getByTestId('caption-font-size')).toBeDisabled();
    expect(screen.getByTestId('caption-bold-toggle')).toBeDisabled();
  });

  it('hides effect actions when clip inspector is readOnly', () => {
    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          name: 'Test Clip',
          assetId: 'asset-1',
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
          },
          effects: [
            {
              id: 'effect-1',
              effectType: 'brightness',
              enabled: true,
              params: { value: 0.5 },
              keyframes: {},
              order: 0,
            },
          ],
        }}
        onAddEffect={vi.fn()}
        onEffectToggle={vi.fn()}
        onEffectRemove={vi.fn()}
        onEffectChange={vi.fn()}
        readOnly={true}
      />,
    );

    expect(screen.queryByTestId('add-effect-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('toggle-effect-effect-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('remove-effect-effect-1')).not.toBeInTheDocument();
  });

  it('resets the speed input when the selected clip changes with the same speed', () => {
    const onClipSpeedChange = vi.fn();
    const { rerender } = render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          name: 'Clip One',
          assetId: 'asset-1',
          speed: 1,
          reverse: false,
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
          },
        }}
        onClipSpeedChange={onClipSpeedChange}
      />,
    );

    const input = screen.getByTestId('speed-input');
    fireEvent.change(input, { target: { value: '250' } });
    expect(input).toHaveValue(250);

    rerender(
      <Inspector
        selectedClip={{
          id: 'clip-2',
          name: 'Clip Two',
          assetId: 'asset-2',
          speed: 1,
          reverse: false,
          range: {
            sourceInSec: 5,
            sourceOutSec: 15,
          },
          place: {
            trackId: 'track-2',
            timelineInSec: 10,
          },
        }}
        onClipSpeedChange={onClipSpeedChange}
      />,
    );

    expect(screen.getByTestId('speed-input')).toHaveValue(100);
  });

  it('resets invalid speed input back to the committed value on blur', () => {
    const onClipSpeedChange = vi.fn();

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          name: 'Clip One',
          assetId: 'asset-1',
          speed: 1,
          reverse: false,
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
          },
        }}
        onClipSpeedChange={onClipSpeedChange}
      />,
    );

    const input = screen.getByTestId('speed-input');
    fireEvent.change(input, { target: { value: '5' } });
    expect(input).toHaveValue(5);

    fireEvent.blur(input);

    expect(onClipSpeedChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('speed-input')).toHaveValue(100);
  });

  it('applies constant speed presets from the clip inspector', async () => {
    const user = userEvent.setup();
    const onClipSpeedChange = vi.fn();

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          name: 'Clip One',
          assetId: 'asset-1',
          speed: 1,
          reverse: false,
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
          },
        }}
        onClipSpeedChange={onClipSpeedChange}
      />,
    );

    await user.click(screen.getByTestId('speed-preset-200'));

    expect(onClipSpeedChange).toHaveBeenCalledWith('clip-1', 'track-1', 2, false);
  });

  it('creates an editable ramp-up time remap curve from the clip inspector', async () => {
    const user = userEvent.setup();
    const onTimeRemapChange = vi.fn();

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          name: 'Clip One',
          assetId: 'asset-1',
          speed: 1,
          reverse: false,
          range: {
            sourceInSec: 5,
            sourceOutSec: 15,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
            durationSec: 10,
          },
        }}
        onTimeRemapChange={onTimeRemapChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Ramp Up' }));

    expect(onTimeRemapChange).toHaveBeenCalledWith('clip-1', 'track-1', {
      keyframes: [
        { timelineTime: 0, sourceTime: 5, interpolation: 'linear' },
        { timelineTime: 5, sourceTime: 8.5, interpolation: 'linear' },
        { timelineTime: 10, sourceTime: 15, interpolation: 'linear' },
      ],
    });
  });

  it('edits active time remap speed points from the clip inspector', () => {
    const onTimeRemapChange = vi.fn();

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          name: 'Clip One',
          assetId: 'asset-1',
          speed: 1,
          reverse: false,
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
            durationSec: 10,
          },
          timeRemap: {
            keyframes: [
              { timelineTime: 0, sourceTime: 0, interpolation: 'linear' },
              { timelineTime: 5, sourceTime: 4, interpolation: 'linear' },
              { timelineTime: 10, sourceTime: 10, interpolation: 'linear' },
            ],
          },
          hasTimeRemap: true,
        }}
        onTimeRemapChange={onTimeRemapChange}
      />,
    );

    const sourceInput = screen.getByLabelText('Speed point 2 source time');
    fireEvent.change(sourceInput, { target: { value: '6' } });
    fireEvent.blur(sourceInput);

    expect(onTimeRemapChange).toHaveBeenCalledWith('clip-1', 'track-1', {
      keyframes: [
        { timelineTime: 0, sourceTime: 0, interpolation: 'linear' },
        { timelineTime: 5, sourceTime: 6, interpolation: 'linear' },
        { timelineTime: 10, sourceTime: 10, interpolation: 'linear' },
      ],
    });
  });

  it('changes slow-motion interpolation from the clip inspector', () => {
    const onSlowMotionInterpolationChange = vi.fn();

    render(
      <Inspector
        selectedClip={{
          id: 'clip-1',
          name: 'Clip One',
          assetId: 'asset-1',
          speed: 0.5,
          reverse: false,
          slowMotionInterpolation: 'nearest',
          range: {
            sourceInSec: 0,
            sourceOutSec: 10,
          },
          place: {
            trackId: 'track-1',
            timelineInSec: 0,
            durationSec: 20,
          },
        }}
        onSlowMotionInterpolationChange={onSlowMotionInterpolationChange}
      />,
    );

    fireEvent.change(screen.getByTestId('slow-motion-interpolation-select'), {
      target: { value: 'motionCompensated' },
    });

    expect(onSlowMotionInterpolationChange).toHaveBeenCalledWith(
      'clip-1',
      'track-1',
      'motionCompensated',
    );
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  it('has proper role for inspector panel', () => {
    render(<Inspector />);

    expect(screen.getByTestId('inspector')).toHaveAttribute('role', 'complementary');
  });

  it('has proper aria-label', () => {
    render(<Inspector />);

    expect(screen.getByTestId('inspector')).toHaveAttribute('aria-label', 'Properties inspector');
  });

  // ===========================================================================
  // Text Clip Selection Tests
  // ===========================================================================

  describe('Text Clip Selection', () => {
    const createTestTextClip = (content: string = 'Test Text'): SelectedTextClip => ({
      id: 'text-clip-1',
      textData: createTextClipData(content),
      timelineInSec: 5.0,
      durationSec: 3.0,
    });

    it('renders TextInspector when text clip is selected', () => {
      const selectedTextClip = createTestTextClip('Hello World');

      render(<Inspector selectedTextClip={selectedTextClip} />);

      // TextInspector should be rendered
      expect(screen.getByTestId('text-inspector')).toBeInTheDocument();
      expect(screen.getByText('Text Properties')).toBeInTheDocument();
    });

    it('displays text content in TextInspector', () => {
      const selectedTextClip = createTestTextClip('My Title Text');

      render(<Inspector selectedTextClip={selectedTextClip} />);

      const textarea = screen.getByTestId('text-content-input');
      expect(textarea).toHaveValue('My Title Text');
    });

    it('calls onTextDataChange when text content is modified', async () => {
      const user = userEvent.setup();
      const handleTextDataChange = vi.fn();
      const selectedTextClip = createTestTextClip('Original');

      render(
        <Inspector selectedTextClip={selectedTextClip} onTextDataChange={handleTextDataChange} />,
      );

      const textarea = screen.getByTestId('text-content-input');
      await user.clear(textarea);
      await user.type(textarea, 'Updated');

      expect(handleTextDataChange).toHaveBeenCalled();
      // Last call should have the clip ID and updated text data
      const lastCall = handleTextDataChange.mock.calls[handleTextDataChange.mock.calls.length - 1];
      expect(lastCall[0]).toBe('text-clip-1');
      expect(lastCall[1].content).toBe('Updated');
    });

    it('renders TextInspector with title preset styling', () => {
      const selectedTextClip: SelectedTextClip = {
        id: 'title-clip-1',
        textData: createTitleTextClipData('Welcome'),
        timelineInSec: 0.0,
        durationSec: 5.0,
      };

      render(<Inspector selectedTextClip={selectedTextClip} />);

      expect(screen.getByTestId('text-inspector')).toBeInTheDocument();
      expect(screen.getByTestId('text-content-input')).toHaveValue('Welcome');
    });

    it('prioritizes text clip over regular clip when both provided', () => {
      // When both a text clip and a regular clip are selected,
      // the text inspector should take precedence
      const selectedTextClip = createTestTextClip('Text Clip');
      const selectedClip = {
        id: 'regular-clip-1',
        name: 'Regular Clip',
        assetId: 'asset-1',
        range: { sourceInSec: 0, sourceOutSec: 10 },
        place: { trackId: 'track-1', timelineInSec: 0 },
      };

      render(<Inspector selectedTextClip={selectedTextClip} selectedClip={selectedClip} />);

      // Should show TextInspector, not Clip Properties
      expect(screen.getByTestId('text-inspector')).toBeInTheDocument();
      expect(screen.queryByText('Clip Properties')).not.toBeInTheDocument();
    });

    it('allows toggling text styling options', async () => {
      const user = userEvent.setup();
      const handleTextDataChange = vi.fn();
      const selectedTextClip = createTestTextClip('Styled Text');

      render(
        <Inspector selectedTextClip={selectedTextClip} onTextDataChange={handleTextDataChange} />,
      );

      // Find and click Bold button
      const boldButton = screen.getByTitle('Bold');
      await user.click(boldButton);

      expect(handleTextDataChange).toHaveBeenCalledWith(
        'text-clip-1',
        expect.objectContaining({
          style: expect.objectContaining({ bold: true }),
        }),
      );
    });

    it('passes text timing edits to the parent handler', () => {
      const handleTextTimingChange = vi.fn();
      const selectedTextClip = createTestTextClip('Timed Text');

      render(
        <Inspector
          selectedTextClip={selectedTextClip}
          onTextTimingChange={handleTextTimingChange}
        />,
      );

      fireEvent.click(screen.getByText('Timing'));
      fireEvent.change(screen.getByLabelText('Start'), { target: { value: '7.25' } });

      expect(handleTextTimingChange).toHaveBeenCalledWith('text-clip-1', {
        timelineInSec: 7.25,
      });
    });

    it('passes readOnly prop to TextInspector', () => {
      const selectedTextClip = createTestTextClip('Read Only Text');

      render(<Inspector selectedTextClip={selectedTextClip} readOnly={true} />);

      const textarea = screen.getByTestId('text-content-input');
      expect(textarea).toBeDisabled();
    });
  });
});
