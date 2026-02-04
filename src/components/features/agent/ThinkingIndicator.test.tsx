/**
 * ThinkingIndicator Tests
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThinkingIndicator } from './ThinkingIndicator';
import type { Thought } from '@/agents/engine';

describe('ThinkingIndicator', () => {
  const mockThought: Thought = {
    understanding: 'User wants to split a clip at 5 seconds',
    requirements: ['clipId', 'split position'],
    uncertainties: ['which clip to split'],
    approach: 'Use split_clip tool with the specified position',
    needsMoreInfo: false,
  };

  describe('loading state', () => {
    it('should show loading indicator when isThinking is true', () => {
      render(<ThinkingIndicator isThinking={true} thought={null} />);

      expect(screen.getByText('Analyzing your request...')).toBeInTheDocument();
    });

    it('should show spinner when thinking', () => {
      render(<ThinkingIndicator isThinking={true} thought={null} />);

      expect(screen.getByTestId('thinking-spinner')).toBeInTheDocument();
    });
  });

  describe('with thought', () => {
    it('should display understanding when thought is provided', () => {
      render(<ThinkingIndicator isThinking={false} thought={mockThought} />);

      expect(screen.getByText(mockThought.understanding)).toBeInTheDocument();
    });

    it('should display approach', () => {
      render(<ThinkingIndicator isThinking={false} thought={mockThought} />);

      expect(screen.getByText(mockThought.approach)).toBeInTheDocument();
    });

    it('should display requirements', () => {
      render(<ThinkingIndicator isThinking={false} thought={mockThought} />);

      mockThought.requirements.forEach((req) => {
        expect(screen.getByText(req)).toBeInTheDocument();
      });
    });

    it('should display uncertainties when present', () => {
      render(<ThinkingIndicator isThinking={false} thought={mockThought} />);

      mockThought.uncertainties.forEach((uncertainty) => {
        expect(screen.getByText(uncertainty)).toBeInTheDocument();
      });
    });
  });

  describe('needsMoreInfo state', () => {
    it('should show clarification message when needsMoreInfo is true', () => {
      const thoughtWithClarification: Thought = {
        ...mockThought,
        needsMoreInfo: true,
        clarificationQuestion: 'Which clip would you like to split?',
      };

      render(
        <ThinkingIndicator isThinking={false} thought={thoughtWithClarification} />
      );

      expect(screen.getByText('Which clip would you like to split?')).toBeInTheDocument();
    });
  });

  describe('collapsed state', () => {
    it('should show collapsed view when collapsed prop is true', () => {
      render(
        <ThinkingIndicator isThinking={false} thought={mockThought} collapsed={true} />
      );

      // Should show understanding but not full details
      expect(screen.getByText(mockThought.understanding)).toBeInTheDocument();
      // Requirements should not be visible
      expect(screen.queryByText('Requirements')).not.toBeInTheDocument();
    });
  });

  describe('null thought', () => {
    it('should handle null thought gracefully', () => {
      render(<ThinkingIndicator isThinking={false} thought={null} />);

      // Should not throw
      expect(screen.queryByTestId('thinking-indicator')).toBeInTheDocument();
    });
  });
});
