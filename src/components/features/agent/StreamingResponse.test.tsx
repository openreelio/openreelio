/**
 * StreamingResponse Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StreamingResponse } from './StreamingResponse';

describe('StreamingResponse', () => {
  const defaultProps = {
    content: '',
    isStreaming: false,
    isComplete: false,
    isAborted: false,
  };

  describe('rendering', () => {
    it('should render component', () => {
      render(<StreamingResponse {...defaultProps} />);

      expect(screen.getByTestId('streaming-response')).toBeInTheDocument();
    });

    it('should show empty state when no content', () => {
      render(<StreamingResponse {...defaultProps} />);

      expect(screen.getByText('No response yet...')).toBeInTheDocument();
    });

    it('should display content', () => {
      render(
        <StreamingResponse {...defaultProps} content="Hello, world!" />
      );

      expect(screen.getByText('Hello, world!')).toBeInTheDocument();
    });
  });

  describe('status badge', () => {
    it('should show Generating when streaming', () => {
      render(<StreamingResponse {...defaultProps} isStreaming={true} />);

      expect(screen.getByText('Generating')).toBeInTheDocument();
    });

    it('should show Complete when done', () => {
      render(
        <StreamingResponse {...defaultProps} isComplete={true} content="Done" />
      );

      expect(screen.getByText('Complete')).toBeInTheDocument();
    });

    it('should show Aborted when aborted', () => {
      render(<StreamingResponse {...defaultProps} isAborted={true} />);

      expect(screen.getByText('Aborted')).toBeInTheDocument();
    });

    it('should show Error when error', () => {
      render(<StreamingResponse {...defaultProps} error="Something failed" />);

      expect(screen.getByText('Error')).toBeInTheDocument();
    });
  });

  describe('typing indicator', () => {
    it('should show typing indicator when streaming', () => {
      render(
        <StreamingResponse
          {...defaultProps}
          isStreaming={true}
          content="Typing"
        />
      );

      // Check for the bouncing dots (they have animate-bounce class)
      const dots = document.querySelectorAll('.animate-bounce');
      expect(dots.length).toBe(3);
    });

    it('should not show typing indicator when complete', () => {
      render(
        <StreamingResponse {...defaultProps} isComplete={true} content="Done" />
      );

      const dots = document.querySelectorAll('.animate-bounce');
      expect(dots.length).toBe(0);
    });
  });

  describe('error state', () => {
    it('should display error message', () => {
      render(
        <StreamingResponse {...defaultProps} error="Network error occurred" />
      );

      expect(screen.getByText('Network error occurred')).toBeInTheDocument();
    });
  });

  describe('aborted state', () => {
    it('should display aborted message', () => {
      render(<StreamingResponse {...defaultProps} isAborted={true} />);

      expect(
        screen.getByText('Generation was stopped by user.')
      ).toBeInTheDocument();
    });
  });

  describe('actions', () => {
    it('should show Stop button when streaming and onAbort provided', () => {
      const onAbort = vi.fn();
      render(
        <StreamingResponse
          {...defaultProps}
          isStreaming={true}
          onAbort={onAbort}
        />
      );

      expect(screen.getByText('Stop')).toBeInTheDocument();
    });

    it('should call onAbort when Stop clicked', () => {
      const onAbort = vi.fn();
      render(
        <StreamingResponse
          {...defaultProps}
          isStreaming={true}
          onAbort={onAbort}
        />
      );

      fireEvent.click(screen.getByText('Stop'));

      expect(onAbort).toHaveBeenCalled();
    });

    it('should show Retry button when error and onRetry provided', () => {
      const onRetry = vi.fn();
      render(
        <StreamingResponse
          {...defaultProps}
          error="Error"
          onRetry={onRetry}
        />
      );

      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('should call onRetry when Retry clicked', () => {
      const onRetry = vi.fn();
      render(
        <StreamingResponse
          {...defaultProps}
          error="Error"
          onRetry={onRetry}
        />
      );

      fireEvent.click(screen.getByText('Retry'));

      expect(onRetry).toHaveBeenCalled();
    });

    it('should show Retry button when aborted and onRetry provided', () => {
      const onRetry = vi.fn();
      render(
        <StreamingResponse
          {...defaultProps}
          isAborted={true}
          onRetry={onRetry}
        />
      );

      expect(screen.getByText('Retry')).toBeInTheDocument();
    });
  });

  describe('statistics', () => {
    it('should show duration when showStats enabled', () => {
      render(
        <StreamingResponse
          {...defaultProps}
          showStats={true}
          duration={1500}
          isStreaming={true}
        />
      );

      expect(screen.getByText('1.5s')).toBeInTheDocument();
    });

    it('should show chunk count when showStats enabled', () => {
      render(
        <StreamingResponse
          {...defaultProps}
          showStats={true}
          chunkCount={10}
          isStreaming={true}
        />
      );

      expect(screen.getByText('10 chunks')).toBeInTheDocument();
    });

    it('should show character count in footer when complete', () => {
      render(
        <StreamingResponse
          {...defaultProps}
          showStats={true}
          content="Hello World"
          isComplete={true}
        />
      );

      expect(screen.getByText('11 characters')).toBeInTheDocument();
    });

    it('should not show footer stats when not showStats', () => {
      render(
        <StreamingResponse
          {...defaultProps}
          showStats={false}
          content="Hello World"
          isComplete={true}
        />
      );

      expect(screen.queryByText('11 characters')).not.toBeInTheDocument();
    });
  });

  describe('styling', () => {
    it('should apply custom className', () => {
      render(
        <StreamingResponse {...defaultProps} className="custom-class" />
      );

      expect(screen.getByTestId('streaming-response')).toHaveClass(
        'custom-class'
      );
    });

    it('should apply maxHeight style', () => {
      render(<StreamingResponse {...defaultProps} maxHeight={200} />);

      // The content container should have maxHeight style
      const contentContainer = document.querySelector('[style*="max-height"]');
      expect(contentContainer).toHaveStyle({ maxHeight: '200px' });
    });
  });
});
