/**
 * ErrorPartRenderer Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorPartRenderer } from './ErrorPartRenderer';
import type { ErrorPart } from '@/agents/engine/core/conversation';

describe('ErrorPartRenderer', () => {
  it('should render error message', () => {
    const part: ErrorPart = {
      type: 'error',
      code: 'TOOL_EXECUTION_FAILED',
      message: 'Failed to split clip',
      phase: 'executing',
      recoverable: false,
    };
    render(<ErrorPartRenderer part={part} />);

    expect(screen.getByTestId('error-part')).toBeInTheDocument();
    expect(screen.getByText('Failed to split clip')).toBeInTheDocument();
  });

  it('should show error code and phase', () => {
    const part: ErrorPart = {
      type: 'error',
      code: 'TOOL_EXECUTION_FAILED',
      message: 'Failed to split clip',
      phase: 'executing',
      recoverable: false,
    };
    render(<ErrorPartRenderer part={part} />);

    expect(screen.getByText('TOOL_EXECUTION_FAILED')).toBeInTheDocument();
    expect(screen.getByText(/executing/)).toBeInTheDocument();
  });

  it('should show retry button when recoverable and onRetry provided', () => {
    const part: ErrorPart = {
      type: 'error',
      code: 'TIMEOUT',
      message: 'Operation timed out',
      phase: 'executing',
      recoverable: true,
    };
    render(<ErrorPartRenderer part={part} onRetry={vi.fn()} />);

    expect(screen.getByTestId('error-retry-btn')).toBeInTheDocument();
  });

  it('should not show retry button when not recoverable', () => {
    const part: ErrorPart = {
      type: 'error',
      code: 'FATAL',
      message: 'Fatal error',
      phase: 'thinking',
      recoverable: false,
    };
    render(<ErrorPartRenderer part={part} onRetry={vi.fn()} />);

    expect(screen.queryByTestId('error-retry-btn')).not.toBeInTheDocument();
  });

  it('should call onRetry when retry button clicked', async () => {
    const onRetry = vi.fn();
    const part: ErrorPart = {
      type: 'error',
      code: 'TIMEOUT',
      message: 'Timed out',
      phase: 'executing',
      recoverable: true,
    };
    const user = userEvent.setup();
    render(<ErrorPartRenderer part={part} onRetry={onRetry} />);

    await user.click(screen.getByTestId('error-retry-btn'));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('should apply custom className', () => {
    const part: ErrorPart = {
      type: 'error',
      code: 'ERR',
      message: 'Error',
      phase: 'thinking',
      recoverable: false,
    };
    render(<ErrorPartRenderer part={part} className="custom" />);

    expect(screen.getByTestId('error-part')).toHaveClass('custom');
  });
});
