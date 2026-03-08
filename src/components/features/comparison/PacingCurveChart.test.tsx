import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PacingCurveChart } from './PacingCurveChart';

const mockContext = {
  clearRect: vi.fn(),
  scale: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(),
  fillText: vi.fn(),
  measureText: vi.fn(() => ({ width: 32 })),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
  setLineDash: vi.fn(),
  roundRect: vi.fn(),
  font: '',
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  textAlign: 'left' as CanvasTextAlign,
};

describe('PacingCurveChart', () => {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => mockContext,
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the chart canvas', () => {
    render(<PacingCurveChart referenceCurve={[]} outputCurve={[]} correlation={0} />);

    expect(screen.getByTestId('pacing-curve-chart')).toBeInTheDocument();
  });

  it('should render an empty-state message when both curves are missing', async () => {
    render(<PacingCurveChart referenceCurve={[]} outputCurve={[]} correlation={0} />);

    await waitFor(() => {
      expect(mockContext.fillText).toHaveBeenCalledWith('No pacing data available', 200, 100);
    });
  });

  it('should render a signed correlation badge for inverse pacing', async () => {
    render(
      <PacingCurveChart
        referenceCurve={[
          { time: 0.2, value: 1 },
          { time: 0.8, value: 3 },
        ]}
        outputCurve={[
          { time: 0.2, value: 3 },
          { time: 0.8, value: 1 },
        ]}
        correlation={-0.4}
      />,
    );

    await waitFor(() => {
      expect(mockContext.fillText).toHaveBeenCalledWith('r = -40%', expect.any(Number), 34);
    });
    expect(mockContext.setLineDash).toHaveBeenCalledWith([6, 4]);
  });
});
