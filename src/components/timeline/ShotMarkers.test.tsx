/**
 * ShotMarkers Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShotMarkers } from './ShotMarkers';
import type { Shot } from '@/hooks/useShotDetection';

// =============================================================================
// Test Data
// =============================================================================

const mockShots: Shot[] = [
  {
    id: 'shot-1',
    assetId: 'asset-001',
    startSec: 0.0,
    endSec: 5.0,
    keyframePath: null,
    qualityScore: null,
    tags: [],
  },
  {
    id: 'shot-2',
    assetId: 'asset-001',
    startSec: 5.0,
    endSec: 12.5,
    keyframePath: null,
    qualityScore: null,
    tags: [],
  },
  {
    id: 'shot-3',
    assetId: 'asset-001',
    startSec: 12.5,
    endSec: 20.0,
    keyframePath: null,
    qualityScore: null,
    tags: [],
  },
];

// =============================================================================
// Tests
// =============================================================================

describe('ShotMarkers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render nothing when shots array is empty', () => {
    const { container } = render(<ShotMarkers shots={[]} zoom={100} />);

    expect(container.querySelector('[data-testid="shot-markers"]')).toBeNull();
  });

  it('should render shot markers container', () => {
    render(<ShotMarkers shots={mockShots} zoom={100} />);

    expect(screen.getByTestId('shot-markers')).toBeInTheDocument();
  });

  it('should render markers for shot boundaries (excluding first at 0)', () => {
    render(<ShotMarkers shots={mockShots} zoom={100} />);

    // Shot 1 starts at 0, so no marker
    // Shot 2 starts at 5.0, so marker at 5.0
    // Shot 3 starts at 12.5, so marker at 12.5
    expect(screen.getByTestId('shot-marker-shot-2')).toBeInTheDocument();
    expect(screen.getByTestId('shot-marker-shot-3')).toBeInTheDocument();

    // First shot marker should not exist (starts at 0)
    expect(screen.queryByTestId('shot-marker-shot-1')).not.toBeInTheDocument();
  });

  it('should virtualize markers outside viewport', () => {
    // Zoom = 100 means 100px per second
    // viewportWidth = 500, scrollX = 0 means visible range is 0-5 seconds
    render(
      <ShotMarkers
        shots={mockShots}
        zoom={100}
        scrollX={0}
        viewportWidth={500}
        duration={20}
      />
    );

    // Shot 2 at 5.0s is just at the edge (within buffer)
    expect(screen.getByTestId('shot-marker-shot-2')).toBeInTheDocument();

    // Shot 3 at 12.5s should still render due to buffer, but let's test a more extreme case
  });

  it('should call onShotClick when a marker is clicked', () => {
    const handleShotClick = vi.fn();

    render(
      <ShotMarkers
        shots={mockShots}
        zoom={100}
        onShotClick={handleShotClick}
      />
    );

    fireEvent.click(screen.getByTestId('shot-marker-shot-2'));

    expect(handleShotClick).toHaveBeenCalledWith('shot-2', 5.0);
  });

  it('should call onSeek when a marker is clicked', () => {
    const handleSeek = vi.fn();

    render(<ShotMarkers shots={mockShots} zoom={100} onSeek={handleSeek} />);

    fireEvent.click(screen.getByTestId('shot-marker-shot-2'));

    expect(handleSeek).toHaveBeenCalledWith(5.0);
  });

  it('should not call handlers when disabled', () => {
    const handleShotClick = vi.fn();
    const handleSeek = vi.fn();

    render(
      <ShotMarkers
        shots={mockShots}
        zoom={100}
        disabled={true}
        onShotClick={handleShotClick}
        onSeek={handleSeek}
      />
    );

    fireEvent.click(screen.getByTestId('shot-marker-shot-2'));

    expect(handleShotClick).not.toHaveBeenCalled();
    expect(handleSeek).not.toHaveBeenCalled();
  });

  it('should highlight selected shots', () => {
    render(
      <ShotMarkers
        shots={mockShots}
        zoom={100}
        selectedShotIds={['shot-2']}
      />
    );

    const marker = screen.getByTestId('shot-marker-shot-2');

    // Selected marker should have the selected color (checked via style)
    expect(marker).toHaveStyle({
      backgroundColor: 'rgba(251, 191, 36, 1)',
    });
  });

  it('should position markers correctly based on zoom', () => {
    const zoom = 50; // 50px per second

    render(<ShotMarkers shots={mockShots} zoom={zoom} scrollX={0} />);

    const marker = screen.getByTestId('shot-marker-shot-2');
    // Shot 2 starts at 5.0s, so position should be 5.0 * 50 = 250px
    expect(marker).toHaveStyle({ left: '250px' });
  });

  it('should handle scroll offset', () => {
    const zoom = 100;
    const scrollX = 200; // Scrolled 200px (2 seconds)

    const { container } = render(
      <ShotMarkers shots={mockShots} zoom={zoom} scrollX={scrollX} />
    );

    // The container should have a transform applied
    const scrollContainer = container.querySelector('[data-testid="shot-markers"] > div');
    expect(scrollContainer).toHaveStyle({ transform: 'translateX(-200px)' });
  });

  it('should show tooltip on hover', () => {
    render(<ShotMarkers shots={mockShots} zoom={100} />);

    const marker = screen.getByTestId('shot-marker-shot-2');

    // Check the title attribute (tooltip)
    expect(marker).toHaveAttribute('title', 'Shot 2 at 5.00s');
  });

  it('should render correct shot index in tooltip', () => {
    render(<ShotMarkers shots={mockShots} zoom={100} />);

    // Shot at index 1 (shot-2) should show "Shot 2"
    const marker2 = screen.getByTestId('shot-marker-shot-2');
    expect(marker2).toHaveAttribute('title', 'Shot 2 at 5.00s');

    // Shot at index 2 (shot-3) should show "Shot 3"
    const marker3 = screen.getByTestId('shot-marker-shot-3');
    expect(marker3).toHaveAttribute('title', 'Shot 3 at 12.50s');
  });

  it('should handle shots with very small durations', () => {
    const shortShots: Shot[] = [
      { id: 's1', assetId: 'a', startSec: 0, endSec: 0.1, keyframePath: null, qualityScore: null, tags: [] },
      { id: 's2', assetId: 'a', startSec: 0.1, endSec: 0.2, keyframePath: null, qualityScore: null, tags: [] },
    ];

    render(<ShotMarkers shots={shortShots} zoom={1000} />);

    expect(screen.getByTestId('shot-marker-s2')).toBeInTheDocument();
  });

  it('should handle shots array with single shot', () => {
    const singleShot: Shot[] = [
      { id: 's1', assetId: 'a', startSec: 0, endSec: 10, keyframePath: null, qualityScore: null, tags: [] },
    ];

    render(<ShotMarkers shots={singleShot} zoom={100} />);

    // Single shot starting at 0 should have no markers (no boundaries to show)
    expect(screen.queryByTestId('shot-markers')).not.toBeInTheDocument();
  });
});
