import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReasoningPartRenderer } from './ReasoningPartRenderer';
import type { ReasoningPart } from '@/agents/engine/core/conversation';

describe('ReasoningPartRenderer', () => {
  const shortPart: ReasoningPart = {
    type: 'reasoning',
    content: 'The user wants to split a clip. I should use the split_clip tool.',
  };

  const longPart: ReasoningPart = {
    type: 'reasoning',
    content:
      'This is a very long reasoning chain that exceeds the preview limit. '.repeat(5) +
      'The final conclusion is to use the trim tool.',
  };

  it('should render collapsed by default', () => {
    render(<ReasoningPartRenderer part={shortPart} />);
    expect(screen.getByTestId('reasoning-part')).toBeInTheDocument();
    expect(screen.getByText('Reasoning')).toBeInTheDocument();
  });

  it('should show preview text when collapsed for short content', () => {
    render(<ReasoningPartRenderer part={shortPart} />);
    expect(
      screen.getByText(/The user wants to split a clip/),
    ).toBeInTheDocument();
  });

  it('should truncate preview for long content', () => {
    render(<ReasoningPartRenderer part={longPart} />);
    expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
  });

  it('should expand on click and show full content', async () => {
    const user = userEvent.setup();
    render(<ReasoningPartRenderer part={shortPart} />);

    const button = screen.getByRole('button');
    await user.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText(shortPart.content),
    ).toBeInTheDocument();
  });

  it('should collapse on second click', async () => {
    const user = userEvent.setup();
    render(<ReasoningPartRenderer part={shortPart} />);

    const button = screen.getByRole('button');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('should apply custom className', () => {
    render(<ReasoningPartRenderer part={shortPart} className="mt-4" />);
    expect(screen.getByTestId('reasoning-part')).toHaveClass('mt-4');
  });
});
