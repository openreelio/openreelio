/**
 * ToolResultPartRenderer Tests
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolResultPartRenderer } from './ToolResultPartRenderer';
import type { ToolResultPart } from '@/agents/engine/core/conversation';

describe('ToolResultPartRenderer', () => {
  it('should render a successful result', () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'split_clip',
      success: true,
      duration: 150,
      data: { newClipId: 'clip-2' },
    };
    render(<ToolResultPartRenderer part={part} />);

    expect(screen.getByTestId('tool-result-part')).toBeInTheDocument();
    expect(screen.getByText('split_clip')).toBeInTheDocument();
    expect(screen.getByText('150ms')).toBeInTheDocument();
  });

  it('should render a failed result', () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'split_clip',
      success: false,
      duration: 50,
      error: 'Clip not found',
    };
    render(<ToolResultPartRenderer part={part} />);

    expect(screen.getByTestId('tool-result-part')).toBeInTheDocument();
  });

  it('should expand to show error details when clicked', async () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'split_clip',
      success: false,
      duration: 50,
      error: 'Clip not found',
    };
    const user = userEvent.setup();
    render(<ToolResultPartRenderer part={part} />);

    await user.click(screen.getByText('split_clip'));

    expect(screen.getByText('Clip not found')).toBeInTheDocument();
  });

  it('should expand to show data when clicked', async () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'split_clip',
      success: true,
      duration: 100,
      data: { result: 'ok' },
    };
    const user = userEvent.setup();
    render(<ToolResultPartRenderer part={part} />);

    await user.click(screen.getByText('split_clip'));

    expect(screen.getByText(/"result": "ok"/)).toBeInTheDocument();
  });

  it('should apply custom className', () => {
    const part: ToolResultPart = {
      type: 'tool_result',
      stepId: 'step-1',
      tool: 'split_clip',
      success: true,
      duration: 100,
    };
    render(<ToolResultPartRenderer part={part} className="custom" />);

    expect(screen.getByTestId('tool-result-part')).toHaveClass('custom');
  });
});
