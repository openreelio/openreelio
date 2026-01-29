/**
 * ContextPanel Component Tests
 *
 * TDD tests for the context panel showing editing context.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextPanel } from './ContextPanel';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@/stores', () => ({
  useTimelineStore: (selector: (state: unknown) => unknown) => {
    const state = {
      selectedClipIds: ['clip_001', 'clip_002'],
    };
    return selector(state);
  },
  usePlaybackStore: (selector: (state: unknown) => unknown) => {
    const state = {
      currentTime: 65.5,
    };
    return selector(state);
  },
  useProjectStore: (selector: (state: unknown) => unknown) => {
    // Mock sequence with tracks containing clips
    // Total duration: clip ends at 120 + 60 = 180 seconds
    const mockSequence = {
      id: 'seq_001',
      name: 'Main Sequence',
      tracks: [
        {
          id: 'track_001',
          clips: [
            { place: { timelineInSec: 0, durationSec: 120 } },
            { place: { timelineInSec: 120, durationSec: 60 } },
          ],
        },
      ],
    };
    const sequencesMap = new Map([['seq_001', mockSequence]]);
    const state = {
      sequences: sequencesMap,
      activeSequenceId: 'seq_001',
    };
    return selector(state);
  },
}));

// =============================================================================
// Tests
// =============================================================================

describe('ContextPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders with test id', () => {
      render(<ContextPanel />);
      expect(screen.getByTestId('context-panel')).toBeInTheDocument();
    });

    it('renders Context header', () => {
      render(<ContextPanel />);
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    it('displays playhead position formatted', () => {
      render(<ContextPanel />);
      expect(screen.getByText('Playhead:')).toBeInTheDocument();
      // 65.5 seconds = 1:05
      expect(screen.getByText('1:05')).toBeInTheDocument();
    });

    it('displays selected clip count', () => {
      render(<ContextPanel />);
      expect(screen.getByText('Selected:')).toBeInTheDocument();
      expect(screen.getByText('2 clips')).toBeInTheDocument();
    });

    it('displays duration formatted', () => {
      render(<ContextPanel />);
      expect(screen.getByText('Duration:')).toBeInTheDocument();
      // 180 seconds = 3:00
      expect(screen.getByText('3:00')).toBeInTheDocument();
    });
  });

  describe('Collapse/Expand', () => {
    it('is expanded by default', () => {
      render(<ContextPanel />);
      expect(screen.getByText('Playhead:')).toBeInTheDocument();
    });

    it('can start collapsed', () => {
      render(<ContextPanel defaultExpanded={false} />);
      expect(screen.queryByText('Playhead:')).not.toBeInTheDocument();
    });

    it('toggles content when header clicked', async () => {
      const user = userEvent.setup();
      render(<ContextPanel />);

      // Initially expanded
      expect(screen.getByText('Playhead:')).toBeInTheDocument();

      // Click to collapse
      await user.click(screen.getByText('Context'));
      expect(screen.queryByText('Playhead:')).not.toBeInTheDocument();

      // Click to expand
      await user.click(screen.getByText('Context'));
      expect(screen.getByText('Playhead:')).toBeInTheDocument();
    });

    it('has correct aria-expanded attribute', async () => {
      const user = userEvent.setup();
      render(<ContextPanel />);

      const button = screen.getByRole('button', { name: /Context/i });
      expect(button).toHaveAttribute('aria-expanded', 'true');

      await user.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'false');
    });
  });

  describe('Styling', () => {
    it('applies custom className', () => {
      render(<ContextPanel className="custom-class" />);
      const container = screen.getByTestId('context-panel');
      expect(container).toHaveClass('custom-class');
    });
  });
});
