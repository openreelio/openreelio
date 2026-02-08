/**
 * ThinkingPartRenderer Tests
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThinkingPartRenderer } from './ThinkingPartRenderer';
import type { ThinkingPart } from '@/agents/engine/core/conversation';

const mockThinkingPart: ThinkingPart = {
  type: 'thinking',
  thought: {
    understanding: 'Need to split the clip',
    approach: 'Use the split tool at the playhead',
    requirements: ['Playhead position', 'Target clip'],
    uncertainties: ['What if no clip is selected?'],
    needsMoreInfo: false,
  },
};

describe('ThinkingPartRenderer', () => {
  it('should render thinking label', () => {
    render(<ThinkingPartRenderer part={mockThinkingPart} />);

    expect(screen.getByTestId('thinking-part')).toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();
  });

  it('should show requirement count', () => {
    render(<ThinkingPartRenderer part={mockThinkingPart} />);

    expect(screen.getByText('2 requirements')).toBeInTheDocument();
  });

  it('should be collapsed by default', () => {
    render(<ThinkingPartRenderer part={mockThinkingPart} />);

    expect(screen.queryByText('Need to split the clip')).not.toBeInTheDocument();
  });

  it('should expand to show details when clicked', async () => {
    const user = userEvent.setup();
    render(<ThinkingPartRenderer part={mockThinkingPart} />);

    await user.click(screen.getByText('Thinking'));

    expect(screen.getByText('Need to split the clip')).toBeInTheDocument();
    expect(screen.getByText('Use the split tool at the playhead')).toBeInTheDocument();
  });

  it('should show uncertainties when expanded', async () => {
    const user = userEvent.setup();
    render(<ThinkingPartRenderer part={mockThinkingPart} />);

    await user.click(screen.getByText('Thinking'));

    expect(screen.getByText('What if no clip is selected?')).toBeInTheDocument();
  });

  it('should apply custom className', () => {
    render(<ThinkingPartRenderer part={mockThinkingPart} className="custom" />);

    expect(screen.getByTestId('thinking-part')).toHaveClass('custom');
  });
});
