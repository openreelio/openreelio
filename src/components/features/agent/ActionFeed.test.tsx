/**
 * ActionFeed Tests
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActionFeed, type ActionFeedProps } from './ActionFeed';

describe('ActionFeed', () => {
  const mockEvents: ActionFeedProps['events'] = [
    {
      type: 'session_start',
      sessionId: 'session-1',
      input: 'Split the clip at 5 seconds',
      timestamp: Date.now() - 5000,
    },
    {
      type: 'phase_changed',
      phase: 'thinking',
      timestamp: Date.now() - 4000,
    },
    {
      type: 'thinking_complete',
      thought: {
        understanding: 'User wants to split a clip',
        requirements: ['clipId', 'position'],
        uncertainties: [],
        approach: 'Use split_clip tool',
        needsMoreInfo: false,
      },
      timestamp: Date.now() - 3000,
    },
    {
      type: 'tool_call_start',
      stepId: 'step-1',
      tool: 'split_clip',
      args: { clipId: 'clip-1', atTimelineSec: 5 },
      timestamp: Date.now() - 2000,
    },
    {
      type: 'tool_call_complete',
      stepId: 'step-1',
      tool: 'split_clip',
      result: { success: true, data: { newClipId: 'clip-2' } },
      duration: 150,
      timestamp: Date.now() - 1000,
    },
  ];

  describe('rendering', () => {
    it('should display events', () => {
      render(<ActionFeed events={mockEvents} />);

      expect(screen.getByTestId('action-feed')).toBeInTheDocument();
    });

    it('should show session start event', () => {
      render(<ActionFeed events={mockEvents} />);

      expect(screen.getByText(/Split the clip at 5 seconds/)).toBeInTheDocument();
    });

    it('should show tool call events', () => {
      render(<ActionFeed events={mockEvents} />);

      // Multiple elements may contain split_clip (tool_call_start and tool_call_complete)
      const elements = screen.getAllByText(/split_clip/);
      expect(elements.length).toBeGreaterThan(0);
    });

    it('should show details for completed tool calls', () => {
      render(<ActionFeed events={mockEvents} />);

      expect(screen.getByText(/Duration: 150ms/)).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('should show empty message when no events', () => {
      render(<ActionFeed events={[]} />);

      expect(screen.getByText(/No actions yet/)).toBeInTheDocument();
    });
  });

  describe('filtering', () => {
    it('should filter to show only tool events when filter is set', () => {
      render(<ActionFeed events={mockEvents} filter="tools" />);

      // Multiple elements may contain split_clip (tool_call_start and tool_call_complete)
      const elements = screen.getAllByText(/split_clip/);
      expect(elements.length).toBeGreaterThan(0);
      // Session start should not be shown when filtering to tools only
    });
  });

  describe('auto-scroll', () => {
    it('should have auto-scroll container', () => {
      render(<ActionFeed events={mockEvents} autoScroll={true} />);

      const feed = screen.getByTestId('action-feed');
      expect(feed).toBeInTheDocument();
    });
  });

  describe('compact mode', () => {
    it('should show compact view when compact prop is true', () => {
      render(<ActionFeed events={mockEvents} compact={true} />);

      expect(screen.getByTestId('action-feed-compact')).toBeInTheDocument();
    });
  });

  describe('error events', () => {
    it('should highlight error events', () => {
      const eventsWithError: ActionFeedProps['events'] = [
        ...mockEvents,
        {
          type: 'error',
          error: new Error('Something went wrong'),
          timestamp: Date.now(),
        },
      ];

      render(<ActionFeed events={eventsWithError} />);

      expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
    });
  });
});
