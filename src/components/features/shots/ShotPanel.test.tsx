/**
 * ShotPanel Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShotPanel, type ShotPanelProps } from './ShotPanel';
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

const defaultProps: ShotPanelProps = {
  shots: [],
  isDetecting: false,
  isLoading: false,
  error: null,
  currentTime: 0,
  onDetectShots: vi.fn(),
  onNavigateToShot: vi.fn(),
};

// =============================================================================
// Tests
// =============================================================================

describe('ShotPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Initial State
  // ---------------------------------------------------------------------------

  it('should render panel with detect button when no shots', () => {
    render(<ShotPanel {...defaultProps} />);

    expect(screen.getByTestId('shot-panel')).toBeInTheDocument();
    expect(screen.getByTestId('detect-shots-button')).toBeInTheDocument();
    expect(screen.getByText('Detect Shots')).toBeInTheDocument();
  });

  it('should render shot list when shots are detected', () => {
    render(<ShotPanel {...defaultProps} shots={mockShots} />);

    expect(screen.getByTestId('shot-item-shot-1')).toBeInTheDocument();
    expect(screen.getByTestId('shot-item-shot-2')).toBeInTheDocument();
    expect(screen.getByTestId('shot-item-shot-3')).toBeInTheDocument();
    expect(screen.getByText('3 total shots')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------

  it('should call onDetectShots when detect button is clicked', async () => {
    const onDetectShots = vi.fn().mockResolvedValue(undefined);

    render(<ShotPanel {...defaultProps} onDetectShots={onDetectShots} />);

    fireEvent.click(screen.getByTestId('detect-shots-button'));

    await waitFor(() => {
      expect(onDetectShots).toHaveBeenCalledWith({
        threshold: 0.3,
        minShotDuration: 0.5,
      });
    });
  });

  it('should show loading state when detecting', () => {
    render(<ShotPanel {...defaultProps} isDetecting={true} />);

    expect(screen.getByText('Detecting shots...')).toBeInTheDocument();
    expect(screen.queryByTestId('detect-shots-button')).not.toBeInTheDocument();
  });

  it('should show loading state when loading', () => {
    render(<ShotPanel {...defaultProps} isLoading={true} />);

    expect(screen.getByText('Loading shots...')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  it('should display error message', () => {
    render(<ShotPanel {...defaultProps} error="FFmpeg not found" />);

    expect(screen.getByText('FFmpeg not found')).toBeInTheDocument();
  });

  it('should call onClearError when dismiss is clicked', () => {
    const onClearError = vi.fn();

    render(
      <ShotPanel
        {...defaultProps}
        error="Test error"
        onClearError={onClearError}
      />
    );

    fireEvent.click(screen.getByText('Dismiss'));

    expect(onClearError).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  it('should call onNavigateToShot when a shot is clicked', () => {
    const onNavigateToShot = vi.fn();

    render(
      <ShotPanel
        {...defaultProps}
        shots={mockShots}
        onNavigateToShot={onNavigateToShot}
      />
    );

    fireEvent.click(screen.getByTestId('shot-item-shot-2'));

    expect(onNavigateToShot).toHaveBeenCalledWith(mockShots[1]);
  });

  it('should highlight current shot based on currentTime', () => {
    render(<ShotPanel {...defaultProps} shots={mockShots} currentTime={7.5} />);

    // At 7.5s, we should be in shot-2 (5.0 - 12.5s)
    const shotItem = screen.getByTestId('shot-item-shot-2');
    expect(shotItem).toHaveClass('bg-primary-500/20');
  });

  it('should navigate to previous shot', () => {
    const onNavigateToShot = vi.fn();

    render(
      <ShotPanel
        {...defaultProps}
        shots={mockShots}
        currentTime={7.5} // In shot 2, 2.5s into it (past 0.5s threshold)
        onNavigateToShot={onNavigateToShot}
      />
    );

    fireEvent.click(screen.getByTestId('prev-shot-button'));

    // When more than 0.5s into current shot, goes to start of current shot (shot 2)
    expect(onNavigateToShot).toHaveBeenCalledWith(mockShots[1]);
  });

  it('should navigate to next shot', () => {
    const onNavigateToShot = vi.fn();

    render(
      <ShotPanel
        {...defaultProps}
        shots={mockShots}
        currentTime={7.5} // In shot 2
        onNavigateToShot={onNavigateToShot}
      />
    );

    fireEvent.click(screen.getByTestId('next-shot-button'));

    // Should navigate to shot 3 (next shot)
    expect(onNavigateToShot).toHaveBeenCalledWith(mockShots[2]);
  });

  it('should disable previous button at first shot start', () => {
    render(
      <ShotPanel
        {...defaultProps}
        shots={mockShots}
        currentTime={0.2} // At very start of shot 1 (within 0.5s threshold)
      />
    );

    const prevButton = screen.getByTestId('prev-shot-button');
    expect(prevButton).toBeDisabled();
  });

  it('should disable next button at last shot', () => {
    render(
      <ShotPanel
        {...defaultProps}
        shots={mockShots}
        currentTime={15.0} // In shot 3 (last)
      />
    );

    const nextButton = screen.getByTestId('next-shot-button');
    expect(nextButton).toBeDisabled();
  });

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  it('should toggle settings panel', () => {
    render(<ShotPanel {...defaultProps} />);

    // Settings should be hidden initially
    expect(screen.queryByText('Sensitivity (Threshold)')).not.toBeInTheDocument();

    // Click settings button
    fireEvent.click(screen.getByTitle('Detection settings'));

    // Settings should be visible
    expect(screen.getByText('Sensitivity (Threshold)')).toBeInTheDocument();
    expect(screen.getByText('Min Shot Duration (sec)')).toBeInTheDocument();
  });

  it('should use custom settings when detecting', async () => {
    const onDetectShots = vi.fn().mockResolvedValue(undefined);

    render(<ShotPanel {...defaultProps} onDetectShots={onDetectShots} />);

    // Open settings
    fireEvent.click(screen.getByTitle('Detection settings'));

    // Change threshold slider (simplified - in real test you'd need more specific targeting)
    const thresholdSlider = screen.getAllByRole('slider')[0];
    fireEvent.change(thresholdSlider, { target: { value: '0.5' } });

    // Detect with new settings
    fireEvent.click(screen.getByTestId('detect-shots-button'));

    await waitFor(() => {
      expect(onDetectShots).toHaveBeenCalledWith({
        threshold: 0.5,
        minShotDuration: 0.5,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Re-detection
  // ---------------------------------------------------------------------------

  it('should show re-detect button when shots exist', () => {
    render(<ShotPanel {...defaultProps} shots={mockShots} />);

    expect(screen.getByText('Re-detect with current settings')).toBeInTheDocument();
  });

  it('should call onDetectShots when re-detect is clicked', async () => {
    const onDetectShots = vi.fn().mockResolvedValue(undefined);

    render(
      <ShotPanel
        {...defaultProps}
        shots={mockShots}
        onDetectShots={onDetectShots}
      />
    );

    fireEvent.click(screen.getByText('Re-detect with current settings'));

    await waitFor(() => {
      expect(onDetectShots).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Shot Display
  // ---------------------------------------------------------------------------

  it('should display shot duration', () => {
    render(<ShotPanel {...defaultProps} shots={mockShots} />);

    // Shot 1: 0-5s = 5s duration
    expect(screen.getByTestId('shot-item-shot-1')).toHaveTextContent('5.0s');

    // Shot 2: 5-12.5s = 7.5s duration
    expect(screen.getByTestId('shot-item-shot-2')).toHaveTextContent('7.5s');
  });

  it('should display shot time range', () => {
    render(<ShotPanel {...defaultProps} shots={mockShots} />);

    // Check shot 1 has time range 0:00.00 - 0:05.00 (or similar format)
    const shotItem = screen.getByTestId('shot-item-shot-1');
    expect(shotItem).toHaveTextContent('0:00');
    expect(shotItem).toHaveTextContent('0:05');
  });

  it('should display current shot indicator', () => {
    render(<ShotPanel {...defaultProps} shots={mockShots} currentTime={7.5} />);

    // Should show "Shot 2" in the navigation indicator (there are multiple "Shot 2" texts)
    // Check the navigation area shows the current shot number
    const navArea = screen.getByText('3 total shots').parentElement;
    expect(navArea).toHaveTextContent('Shot 2');
  });

  it('should show "No shot" when currentTime is not in any shot range', () => {
    // This case might not happen in normal use, but let's test it
    const gappedShots: Shot[] = [
      { id: 's1', assetId: 'a', startSec: 0, endSec: 5, keyframePath: null, qualityScore: null, tags: [] },
      { id: 's2', assetId: 'a', startSec: 10, endSec: 15, keyframePath: null, qualityScore: null, tags: [] },
    ];

    render(<ShotPanel {...defaultProps} shots={gappedShots} currentTime={7.5} />);

    expect(screen.getByText('No shot')).toBeInTheDocument();
  });
});
