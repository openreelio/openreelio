/**
 * AudioClipWaveform Component Tests
 *
 * Tests for audio waveform display on timeline clips.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AudioClipWaveform } from './AudioClipWaveform';

// =============================================================================
// Mocks
// =============================================================================

// Mock the useAudioWaveform hook
const mockGetWaveform = vi.fn();
let isGeneratingMock = false;
vi.mock('@/hooks', () => ({
  useAudioWaveform: () => ({
    getWaveform: mockGetWaveform,
    hasWaveform: vi.fn(() => false),
    isGenerating: isGeneratingMock,
    error: null,
    cacheSize: 0,
    clearCache: vi.fn(),
  }),
}));

// =============================================================================
// Tests
// =============================================================================

describe('AudioClipWaveform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isGeneratingMock = false;

    // Default to a never-resolving promise so tests that don't await async updates
    // won't trigger React act(...) warnings due to post-render state updates.
    mockGetWaveform.mockImplementation(() => new Promise<string>(() => {}));
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render container with correct dimensions', () => {
      render(
        <AudioClipWaveform
          assetId="asset_001"
          inputPath="/path/to/audio.mp3"
          width={200}
          height={50}
        />
      );

      const container = screen.getByTestId('waveform-container');
      expect(container).toBeInTheDocument();
      expect(container).toHaveStyle({ width: '200px', height: '50px' });
    });

    it('should show loading indicator when generating waveform', () => {
      isGeneratingMock = true;

      render(
        <AudioClipWaveform
          assetId="asset_001"
          inputPath="/path/to/audio.mp3"
          width={200}
          height={50}
          showLoadingIndicator={true}
        />
      );

      // Loading indicator should be visible when generating
      const container = screen.getByTestId('waveform-container');
      expect(container).toBeInTheDocument();
    });

    it('should display waveform image when available', async () => {
      mockGetWaveform.mockResolvedValueOnce('http://localhost/waveform.png');

      render(
        <AudioClipWaveform
          assetId="asset_001"
          inputPath="/path/to/audio.mp3"
          width={200}
          height={50}
        />
      );

      // The component uses DEFAULT_GENERATION_HEIGHT (100) for waveform generation
      // regardless of display height, then scales via CSS
      await waitFor(() => {
        expect(mockGetWaveform).toHaveBeenCalledWith(
          'asset_001',
          '/path/to/audio.mp3',
          200,
          100 // DEFAULT_GENERATION_HEIGHT
        );
      });

      await waitFor(() => {
        const container = screen.getByTestId('waveform-container');
        const waveformImage = container.querySelector('img');
        expect(waveformImage).not.toBeNull();
        expect(waveformImage).toHaveAttribute('src', 'http://localhost/waveform.png');
      });
    });

    it('should not render when disabled', () => {
      render(
        <AudioClipWaveform
          assetId="asset_001"
          inputPath="/path/to/audio.mp3"
          width={200}
          height={50}
          disabled={true}
        />
      );

      expect(screen.queryByTestId('waveform-container')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Props Tests
  // ===========================================================================

  describe('props', () => {
    it('should apply custom color to waveform', () => {
      render(
        <AudioClipWaveform
          assetId="asset_001"
          inputPath="/path/to/audio.mp3"
          width={200}
          height={50}
          color="#00ff00"
        />
      );

      const container = screen.getByTestId('waveform-container');
      expect(container).toBeInTheDocument();
    });

    it('should apply custom opacity', () => {
      render(
        <AudioClipWaveform
          assetId="asset_001"
          inputPath="/path/to/audio.mp3"
          width={200}
          height={50}
          opacity={0.5}
        />
      );

      const container = screen.getByTestId('waveform-container');
      expect(container).toHaveStyle({ opacity: '0.5' });
    });

    it('should handle sourceIn and sourceOut for clip trimming', async () => {
      mockGetWaveform.mockResolvedValueOnce('http://localhost/waveform.png');

      render(
        <AudioClipWaveform
          assetId="asset_001"
          inputPath="/path/to/audio.mp3"
          width={200}
          height={50}
          sourceInSec={5}
          sourceOutSec={15}
          totalDurationSec={30}
        />
      );

      await waitFor(() => {
        expect(mockGetWaveform).toHaveBeenCalled();
      });

      // The component should clip the waveform image based on sourceIn/sourceOut
      const container = screen.getByTestId('waveform-container');
      expect(container).toBeInTheDocument();

      await waitFor(() => {
        const waveformImage = container.querySelector('img');
        expect(waveformImage).not.toBeNull();
        expect(waveformImage).toHaveAttribute('src', 'http://localhost/waveform.png');
      });
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should handle waveform generation failure gracefully', async () => {
      mockGetWaveform.mockResolvedValueOnce(null);

      render(
        <AudioClipWaveform
          assetId="asset_001"
          inputPath="/path/to/audio.mp3"
          width={200}
          height={50}
        />
      );

      await waitFor(() => {
        expect(mockGetWaveform).toHaveBeenCalled();
      });

      // Should still render container without crashing
      const container = screen.getByTestId('waveform-container');
      expect(container).toBeInTheDocument();

      await waitFor(() => {
        expect(container.querySelector('img')).toBeNull();
      });
    });

    it('should not generate waveform for invalid asset ID', () => {
      render(
        <AudioClipWaveform
          assetId=""
          inputPath="/path/to/audio.mp3"
          width={200}
          height={50}
        />
      );

      expect(mockGetWaveform).not.toHaveBeenCalled();
    });

    it('should not generate waveform for invalid input path', () => {
      render(
        <AudioClipWaveform
          assetId="asset_001"
          inputPath=""
          width={200}
          height={50}
        />
      );

      expect(mockGetWaveform).not.toHaveBeenCalled();
    });
  });
});
