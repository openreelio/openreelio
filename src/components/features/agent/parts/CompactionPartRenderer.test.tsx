import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompactionPartRenderer } from './CompactionPartRenderer';
import type { CompactionPart } from '@/agents/engine/core/conversation';

describe('CompactionPartRenderer', () => {
  const autoPart: CompactionPart = {
    type: 'compaction',
    summary: 'The user has been working on color correction for clips in Track 1.',
    auto: true,
  };

  const manualPart: CompactionPart = {
    type: 'compaction',
    summary: 'User requested a summary of the current progress.',
    auto: false,
  };

  it('should render collapsed by default', () => {
    render(<CompactionPartRenderer part={autoPart} />);
    expect(screen.getByTestId('compaction-part')).toBeInTheDocument();
    expect(screen.getByText('Context summarized')).toBeInTheDocument();
  });

  it('should show (auto) label for auto-triggered compaction', () => {
    render(<CompactionPartRenderer part={autoPart} />);
    expect(screen.getByText('(auto)')).toBeInTheDocument();
  });

  it('should show (manual) label for manual compaction', () => {
    render(<CompactionPartRenderer part={manualPart} />);
    expect(screen.getByText('(manual)')).toBeInTheDocument();
  });

  it('should expand on click and show summary', async () => {
    const user = userEvent.setup();
    render(<CompactionPartRenderer part={autoPart} />);

    const button = screen.getByRole('button');
    await user.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText(autoPart.summary),
    ).toBeInTheDocument();
  });

  it('should collapse on second click', async () => {
    const user = userEvent.setup();
    render(<CompactionPartRenderer part={autoPart} />);

    const button = screen.getByRole('button');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('should apply custom className', () => {
    render(<CompactionPartRenderer part={autoPart} className="my-2" />);
    expect(screen.getByTestId('compaction-part')).toHaveClass('my-2');
  });
});
