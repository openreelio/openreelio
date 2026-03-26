/**
 * StabilizePanel Integration Tests
 *
 * BDD-style tests for the video stabilization effect panel.
 * Tests parameter controls, analysis button, progress indicator, and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StabilizePanel } from './StabilizePanel';

const { mockInvoke, mockListen } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue({ transformsPath: '/tmp/test.trf' }),
  mockListen: vi.fn().mockResolvedValue(vi.fn()),
}));

// Mock Tauri IPC — external boundary only
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

describe('StabilizePanel', () => {
  const defaultParams = {
    smoothing: 10,
    crop_mode: 'crop',
    zoom: 0,
    analysis_path: '',
  };

  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({ transformsPath: '/tmp/test.trf' });
    mockListen.mockResolvedValue(vi.fn());
  });

  // ===========================================================================
  // Rendering
  // ===========================================================================

  it('should render all control sections', () => {
    render(
      <StabilizePanel params={defaultParams} onChange={mockOnChange} />
    );

    expect(screen.getByTestId('stabilize-panel')).toBeInTheDocument();
    expect(screen.getByTestId('smoothing-slider')).toBeInTheDocument();
    expect(screen.getByTestId('crop-mode-select')).toBeInTheDocument();
    expect(screen.getByTestId('zoom-slider')).toBeInTheDocument();
  });

  it('should show analysis required message when not analyzed', () => {
    render(
      <StabilizePanel params={defaultParams} onChange={mockOnChange} />
    );

    expect(screen.getByTestId('analysis-required')).toBeInTheDocument();
    expect(screen.getByText(/motion analysis required/i)).toBeInTheDocument();
  });

  it('should show analysis complete when analysis_path is set', () => {
    render(
      <StabilizePanel
        params={{ ...defaultParams, analysis_path: '/tmp/test.trf' }}
        onChange={mockOnChange}
      />
    );

    expect(screen.getByTestId('analysis-complete')).toBeInTheDocument();
    expect(screen.getByText(/motion analysis complete/i)).toBeInTheDocument();
  });

  // ===========================================================================
  // Smoothing Control
  // ===========================================================================

  it('should display current smoothing value', () => {
    render(
      <StabilizePanel
        params={{ ...defaultParams, smoothing: 25 }}
        onChange={mockOnChange}
      />
    );

    const slider = screen.getByLabelText('Smoothing') as HTMLInputElement;
    expect(slider.value).toBe('25');
  });

  it('should call onChange when smoothing slider changes', () => {
    render(
      <StabilizePanel params={defaultParams} onChange={mockOnChange} />
    );

    const slider = screen.getByLabelText('Smoothing');
    fireEvent.change(slider, { target: { value: '50' } });

    expect(mockOnChange).toHaveBeenCalledWith('smoothing', 50);
  });

  it('should reset smoothing to default (10) when reset button clicked', () => {
    render(
      <StabilizePanel
        params={{ ...defaultParams, smoothing: 50 }}
        onChange={mockOnChange}
      />
    );

    const resetBtn = screen.getByLabelText('Reset smoothing');
    fireEvent.click(resetBtn);

    expect(mockOnChange).toHaveBeenCalledWith('smoothing', 10);
  });

  // ===========================================================================
  // Crop Mode Control
  // ===========================================================================

  it('should display current crop mode selection', () => {
    render(
      <StabilizePanel params={defaultParams} onChange={mockOnChange} />
    );

    const select = screen.getByLabelText('Crop Mode') as HTMLSelectElement;
    expect(select.value).toBe('crop');
  });

  it('should call onChange when crop mode changes', () => {
    render(
      <StabilizePanel params={defaultParams} onChange={mockOnChange} />
    );

    const select = screen.getByLabelText('Crop Mode');
    fireEvent.change(select, { target: { value: 'dynamic' } });

    expect(mockOnChange).toHaveBeenCalledWith('crop_mode', 'dynamic');
  });

  it('should show all three crop mode options', () => {
    render(
      <StabilizePanel params={defaultParams} onChange={mockOnChange} />
    );

    const options = screen.getByLabelText('Crop Mode').querySelectorAll('option');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveValue('crop');
    expect(options[1]).toHaveValue('none');
    expect(options[2]).toHaveValue('dynamic');
  });

  // ===========================================================================
  // Zoom Control
  // ===========================================================================

  it('should display current zoom value with percentage', () => {
    render(
      <StabilizePanel
        params={{ ...defaultParams, zoom: 15 }}
        onChange={mockOnChange}
      />
    );

    expect(screen.getByText('+15%')).toBeInTheDocument();
  });

  it('should call onChange when zoom slider changes', () => {
    render(
      <StabilizePanel params={defaultParams} onChange={mockOnChange} />
    );

    const slider = screen.getByLabelText('Zoom');
    fireEvent.change(slider, { target: { value: '20' } });

    expect(mockOnChange).toHaveBeenCalledWith('zoom', 20);
  });

  it('should reset zoom to 0 when reset button clicked', () => {
    render(
      <StabilizePanel
        params={{ ...defaultParams, zoom: 30 }}
        onChange={mockOnChange}
      />
    );

    const resetBtn = screen.getByLabelText('Reset zoom');
    fireEvent.click(resetBtn);

    expect(mockOnChange).toHaveBeenCalledWith('zoom', 0);
  });

  // ===========================================================================
  // Read-only Mode
  // ===========================================================================

  it('should disable all controls in read-only mode', () => {
    render(
      <StabilizePanel
        params={defaultParams}
        onChange={mockOnChange}
        readOnly
      />
    );

    expect(screen.getByLabelText('Smoothing')).toBeDisabled();
    expect(screen.getByLabelText('Crop Mode')).toBeDisabled();
    expect(screen.getByLabelText('Zoom')).toBeDisabled();
    expect(screen.getByTestId('analyze-button')).toBeDisabled();
  });

  // ===========================================================================
  // Analyze Button
  // ===========================================================================

  it('should show analyze button when not analyzing', () => {
    render(
      <StabilizePanel params={defaultParams} onChange={mockOnChange} />
    );

    expect(screen.getByTestId('analyze-button')).toBeInTheDocument();
    expect(screen.getByText('Analyze Motion')).toBeInTheDocument();
  });

  it('should show re-analyze label when already analyzed', () => {
    render(
      <StabilizePanel
        params={{ ...defaultParams, analysis_path: '/tmp/test.trf' }}
        onChange={mockOnChange}
        clipContext={{ sequenceId: 's1', trackId: 't1', clipId: 'c1' }}
      />
    );

    expect(screen.getByText('Re-analyze Motion')).toBeInTheDocument();
  });

  it('should disable analyze button when no clip context provided', () => {
    render(
      <StabilizePanel params={defaultParams} onChange={mockOnChange} />
    );

    expect(screen.getByTestId('analyze-button')).toBeDisabled();
  });

  it('should invoke stabilize_clip with the latest in-flight parameter values', async () => {
    render(
      <StabilizePanel
        params={defaultParams}
        onChange={mockOnChange}
        clipContext={{ sequenceId: 's1', trackId: 't1', clipId: 'c1' }}
      />
    );

    fireEvent.change(screen.getByLabelText('Smoothing'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('Crop Mode'), { target: { value: 'dynamic' } });
    fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('analyze-button'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('stabilize_clip', {
        args: {
          sequenceId: 's1',
          trackId: 't1',
          clipId: 'c1',
          smoothing: 42,
          cropMode: 'dynamic',
          zoom: 12,
        },
      });
    });

    // Wait for async handler to fully complete so microtasks don't leak into next test
    await waitFor(() => {
      expect(screen.getByTestId('analyze-button')).toBeInTheDocument();
    });
  });

  it('should push the returned transforms path back through onChange', async () => {
    render(
      <StabilizePanel
        params={defaultParams}
        onChange={mockOnChange}
        clipContext={{ sequenceId: 's1', trackId: 't1', clipId: 'c1' }}
      />
    );

    fireEvent.click(screen.getByTestId('analyze-button'));

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalledWith('analysis_path', '/tmp/test.trf');
    });
  });

  // ===========================================================================
  // Default Parameter Handling
  // ===========================================================================

  it('should use default values for missing parameters', () => {
    render(
      <StabilizePanel params={{}} onChange={mockOnChange} />
    );

    const smoothingSlider = screen.getByLabelText('Smoothing') as HTMLInputElement;
    expect(smoothingSlider.value).toBe('10');

    const cropSelect = screen.getByLabelText('Crop Mode') as HTMLSelectElement;
    expect(cropSelect.value).toBe('crop');

    const zoomSlider = screen.getByLabelText('Zoom') as HTMLInputElement;
    expect(zoomSlider.value).toBe('0');
  });

  it('should display negative zoom value correctly', () => {
    render(
      <StabilizePanel
        params={{ ...defaultParams, zoom: -20 }}
        onChange={mockOnChange}
      />
    );

    expect(screen.getByText('-20%')).toBeInTheDocument();
  });
});
