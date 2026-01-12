/**
 * Inspector Component Tests
 *
 * TDD: Tests for the property inspector panel
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Inspector } from './Inspector';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('Inspector', () => {
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
});
