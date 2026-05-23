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

    it('passes readOnly prop to TextInspector', () => {
      const selectedTextClip = createTestTextClip('Read Only Text');

      render(<Inspector selectedTextClip={selectedTextClip} readOnly={true} />);

      const textarea = screen.getByTestId('text-content-input');
      expect(textarea).toBeDisabled();
    });
  });
});
