/**
 * ToolCallPartRenderer Tests
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallPartRenderer } from './ToolCallPartRenderer';
import type { ToolCallPart } from '@/agents/engine/core/conversation';

const mockToolCallPart: ToolCallPart = {
  type: 'tool_call',
  stepId: 'step-1',
  tool: 'split_clip',
  args: { position: 5, clipId: 'clip-1' },
  description: 'Split clip at 5 seconds',
  riskLevel: 'low',
  status: 'running',
};

describe('ToolCallPartRenderer', () => {
  it('should render the tool call', () => {
    render(<ToolCallPartRenderer part={mockToolCallPart} />);

    expect(screen.getByTestId('tool-call-part')).toBeInTheDocument();
    expect(screen.getByText('split_clip')).toBeInTheDocument();
  });

  it('should show the description', () => {
    render(<ToolCallPartRenderer part={mockToolCallPart} />);

    expect(screen.getByText('Split clip at 5 seconds')).toBeInTheDocument();
  });

  it('should show running indicator when status is running', () => {
    render(<ToolCallPartRenderer part={mockToolCallPart} />);

    const pulse = document.querySelector('.animate-pulse');
    expect(pulse).toBeInTheDocument();
  });

  it('should not show running indicator when completed', () => {
    const completed: ToolCallPart = { ...mockToolCallPart, status: 'completed' };
    render(<ToolCallPartRenderer part={completed} />);

    const pulse = document.querySelector('.animate-pulse');
    expect(pulse).not.toBeInTheDocument();
  });

  it('should expand to show arguments when clicked', async () => {
    const user = userEvent.setup();
    render(<ToolCallPartRenderer part={mockToolCallPart} />);

    await user.click(screen.getByText('split_clip'));

    expect(screen.getByText(/"position": 5/)).toBeInTheDocument();
  });

  it('should apply custom className', () => {
    render(<ToolCallPartRenderer part={mockToolCallPart} className="custom" />);

    expect(screen.getByTestId('tool-call-part')).toHaveClass('custom');
  });
});
