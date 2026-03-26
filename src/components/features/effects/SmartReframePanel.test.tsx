/**
 * SmartReframePanel Integration Tests
 *
 * BDD-style tests for the AI smart reframe effect panel.
 * Tests aspect ratio selection, parameter controls, analysis button,
 * progress indicator, and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SmartReframePanel } from './SmartReframePanel';

const { mockInvoke, mockListen } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue({
    analysisData: '{"crop_w":608,"crop_h":1080,"keyframes":[]}',
    cropWidth: 608,
    cropHeight: 1080,
  }),
  mockListen: vi.fn().mockResolvedValue(vi.fn()),
}));

// Mock Tauri IPC — external boundary only
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

describe('SmartReframePanel', () => {
  const defaultParams = {
    target_aspect: '9:16',
    smoothing: 30,
    zoom: 0,
    detection_mode: 'center',
    analysis_data: '',
  };

  const mockOnChange = vi.fn();

  const clipContext = {
    sequenceId: 'seq-1',
    trackId: 'track-1',
    clipId: 'clip-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({
      analysisData: '{"crop_w":608,"crop_h":1080,"keyframes":[]}',
      cropWidth: 608,
      cropHeight: 1080,
    });
    mockListen.mockResolvedValue(vi.fn());
  });

  // ===========================================================================
  // Rendering
  // ===========================================================================

  it('should render all control sections', () => {
    render(
      <SmartReframePanel params={defaultParams} onChange={mockOnChange} />
    );

    expect(screen.getByTestId('smart-reframe-panel')).toBeInTheDocument();
    expect(screen.getByTestId('aspect-ratio-selector')).toBeInTheDocument();
    expect(screen.getByTestId('smoothing-slider')).toBeInTheDocument();
    expect(screen.getByTestId('zoom-slider')).toBeInTheDocument();
  });

  // ===========================================================================
  // Aspect Ratio Selection
  // ===========================================================================

  it('should render all aspect ratio preset buttons', () => {
    render(
      <SmartReframePanel params={defaultParams} onChange={mockOnChange} />
    );

    expect(screen.getByTestId('aspect-9-16')).toBeInTheDocument();
    expect(screen.getByTestId('aspect-1-1')).toBeInTheDocument();
    expect(screen.getByTestId('aspect-4-5')).toBeInTheDocument();
    expect(screen.getByTestId('aspect-4-3')).toBeInTheDocument();
  });

  it('should mark the active aspect ratio preset as pressed', () => {
    render(
      <SmartReframePanel params={defaultParams} onChange={mockOnChange} />
    );

    const activeBtn = screen.getByTestId('aspect-9-16');
    expect(activeBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('should call onChange when a different aspect ratio is selected', () => {
    render(
      <SmartReframePanel params={defaultParams} onChange={mockOnChange} />
    );

    fireEvent.click(screen.getByTestId('aspect-1-1'));
    expect(mockOnChange).toHaveBeenCalledWith('target_aspect', '1:1');
  });

  it('should mark only the selected aspect ratio as pressed', () => {
    const params = { ...defaultParams, target_aspect: '4:5' };
    render(
      <SmartReframePanel params={params} onChange={mockOnChange} />
    );

    const activeBtn = screen.getByTestId('aspect-4-5');
    expect(activeBtn).toHaveAttribute('aria-pressed', 'true');

    const inactiveBtn = screen.getByTestId('aspect-9-16');
    expect(inactiveBtn).toHaveAttribute('aria-pressed', 'false');
  });

  // ===========================================================================
  // Smoothing Slider
  // ===========================================================================

  it('should display current smoothing value', () => {
    render(
      <SmartReframePanel params={defaultParams} onChange={mockOnChange} />
    );

    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('should call onChange when smoothing slider changes', () => {
    render(
      <SmartReframePanel params={defaultParams} onChange={mockOnChange} />
    );

    const slider = screen.getByLabelText('Smoothing');
    fireEvent.change(slider, { target: { value: '50' } });
    expect(mockOnChange).toHaveBeenCalledWith('smoothing', 50);
  });

  it('should reset smoothing to default when reset button is clicked', () => {
    const params = { ...defaultParams, smoothing: 80 };
    render(
      <SmartReframePanel params={params} onChange={mockOnChange} />
    );

    const resetBtn = screen.getByLabelText('Reset smoothing');
    fireEvent.click(resetBtn);
    expect(mockOnChange).toHaveBeenCalledWith('smoothing', 30);
  });

  // ===========================================================================
  // Zoom Slider
  // ===========================================================================

  it('should display current zoom value with percentage', () => {
    const params = { ...defaultParams, zoom: 15 };
    render(
      <SmartReframePanel params={params} onChange={mockOnChange} />
    );

    expect(screen.getByText('+15%')).toBeInTheDocument();
  });

  it('should call onChange when zoom slider changes', () => {
    render(
      <SmartReframePanel params={defaultParams} onChange={mockOnChange} />
    );

    const slider = screen.getByLabelText('Zoom');
    fireEvent.change(slider, { target: { value: '20' } });
    expect(mockOnChange).toHaveBeenCalledWith('zoom', 20);
  });

  it('should reset zoom to 0 when reset button is clicked', () => {
    const params = { ...defaultParams, zoom: 25 };
    render(
      <SmartReframePanel params={params} onChange={mockOnChange} />
    );

    const resetBtn = screen.getByLabelText('Reset zoom');
    fireEvent.click(resetBtn);
    expect(mockOnChange).toHaveBeenCalledWith('zoom', 0);
  });

  // ===========================================================================
  // Analysis Status
  // ===========================================================================

  it('should show analysis required message when no analysis data', () => {
    render(
      <SmartReframePanel params={defaultParams} onChange={mockOnChange} />
    );

    expect(screen.getByTestId('analysis-required')).toBeInTheDocument();
    expect(
      screen.getByText(/analysis required before smart reframe/i)
    ).toBeInTheDocument();
  });

  it('should show analysis complete message when analysis data exists', () => {
    const params = {
      ...defaultParams,
      analysis_data: '{"crop_w":608,"crop_h":1080,"keyframes":[{"t":0,"x":656,"y":0}]}',
    };
    render(
      <SmartReframePanel params={params} onChange={mockOnChange} />
    );

    expect(screen.getByTestId('analysis-complete')).toBeInTheDocument();
    expect(
      screen.getByText(/reframe analysis complete/i)
    ).toBeInTheDocument();
  });

  it('should show "Analyze & Reframe" button when not yet analyzed', () => {
    render(
      <SmartReframePanel
        params={defaultParams}
        onChange={mockOnChange}
        clipContext={clipContext}
      />
    );

    expect(screen.getByText('Analyze & Reframe')).toBeInTheDocument();
  });

  it('should show "Re-analyze" button when already analyzed', () => {
    const params = {
      ...defaultParams,
      analysis_data: '{"crop_w":608,"crop_h":1080,"keyframes":[]}',
    };
    render(
      <SmartReframePanel
        params={params}
        onChange={mockOnChange}
        clipContext={clipContext}
      />
    );

    expect(screen.getByText('Re-analyze')).toBeInTheDocument();
  });

  // ===========================================================================
  // Analysis Button
  // ===========================================================================

  it('should invoke smart_reframe with correct args when analyze is clicked', async () => {
    render(
      <SmartReframePanel
        params={defaultParams}
        onChange={mockOnChange}
        clipContext={clipContext}
      />
    );

    fireEvent.click(screen.getByTestId('analyze-button'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('smart_reframe', {
        args: {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'clip-1',
          targetAspect: '9:16',
          smoothing: 30,
          zoom: 0,
        },
      });
    });
  });

  it('should invoke smart_reframe with the latest in-flight parameter values', async () => {
    render(
      <SmartReframePanel
        params={defaultParams}
        onChange={mockOnChange}
        clipContext={clipContext}
      />
    );

    fireEvent.click(screen.getByTestId('aspect-4-5'));
    fireEvent.change(screen.getByLabelText('Smoothing'), { target: { value: '55' } });
    fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '18' } });
    fireEvent.click(screen.getByTestId('analyze-button'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('smart_reframe', {
        args: {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'clip-1',
          targetAspect: '4:5',
          smoothing: 55,
          zoom: 18,
        },
      });
    });
  });

  it('should push returned analysis data back through onChange', async () => {
    render(
      <SmartReframePanel
        params={defaultParams}
        onChange={mockOnChange}
        clipContext={clipContext}
      />
    );

    fireEvent.click(screen.getByTestId('analyze-button'));

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalledWith(
        'analysis_data',
        '{"crop_w":608,"crop_h":1080,"keyframes":[]}',
      );
    });
  });

  it('should listen for reframe-progress events during analysis', async () => {
    render(
      <SmartReframePanel
        params={defaultParams}
        onChange={mockOnChange}
        clipContext={clipContext}
      />
    );

    fireEvent.click(screen.getByTestId('analyze-button'));

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith(
        'reframe-progress',
        expect.any(Function)
      );
    });
  });

  it('should display error message when analysis fails', async () => {
    mockInvoke.mockRejectedValue('Scene detection failed');

    render(
      <SmartReframePanel
        params={defaultParams}
        onChange={mockOnChange}
        clipContext={clipContext}
      />
    );

    fireEvent.click(screen.getByTestId('analyze-button'));

    await waitFor(() => {
      expect(screen.getByTestId('analysis-error')).toBeInTheDocument();
      expect(screen.getByText('Scene detection failed')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Read-Only Mode
  // ===========================================================================

  it('should disable all controls in read-only mode', () => {
    render(
      <SmartReframePanel
        params={defaultParams}
        onChange={mockOnChange}
        readOnly
        clipContext={clipContext}
      />
    );

    // Aspect preset buttons should be disabled
    expect(screen.getByTestId('aspect-9-16')).toBeDisabled();
    expect(screen.getByTestId('aspect-1-1')).toBeDisabled();
    expect(screen.getByTestId('aspect-4-5')).toBeDisabled();
    expect(screen.getByTestId('aspect-4-3')).toBeDisabled();

    // Sliders should be disabled
    expect(screen.getByLabelText('Smoothing')).toBeDisabled();
    expect(screen.getByLabelText('Zoom')).toBeDisabled();

    // Analyze button should be disabled
    expect(screen.getByTestId('analyze-button')).toBeDisabled();
  });

  // ===========================================================================
  // Default Values
  // ===========================================================================

  it('should use default values for missing parameters', () => {
    render(
      <SmartReframePanel params={{}} onChange={mockOnChange} />
    );

    // Default aspect should be 9:16 (active)
    const activeBtn = screen.getByTestId('aspect-9-16');
    expect(activeBtn).toHaveAttribute('aria-pressed', 'true');

    // Default smoothing = 30
    expect(screen.getByText('30')).toBeInTheDocument();

    // Default zoom = 0%
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('should disable analyze button when no clip context is provided', () => {
    render(
      <SmartReframePanel params={defaultParams} onChange={mockOnChange} />
    );

    expect(screen.getByTestId('analyze-button')).toBeDisabled();
  });
});
