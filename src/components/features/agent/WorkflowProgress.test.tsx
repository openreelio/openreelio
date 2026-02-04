/**
 * WorkflowProgress Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkflowProgress } from './WorkflowProgress';
import type { WorkflowStepData } from '@/hooks/useAgentWorkflow';

describe('WorkflowProgress', () => {
  const defaultProps = {
    phase: 'executing' as const,
    steps: [] as WorkflowStepData[],
    progress: 50,
    isActive: true,
  };

  describe('rendering', () => {
    it('should render in full mode by default', () => {
      render(<WorkflowProgress {...defaultProps} />);

      expect(screen.getByTestId('workflow-progress')).toBeInTheDocument();
    });

    it('should render in compact mode', () => {
      render(<WorkflowProgress {...defaultProps} compact={true} />);

      expect(screen.getByTestId('workflow-progress-compact')).toBeInTheDocument();
    });

    it('should display phase label', () => {
      render(<WorkflowProgress {...defaultProps} />);

      expect(screen.getByText('Executing')).toBeInTheDocument();
    });

    it('should display progress bar', () => {
      render(<WorkflowProgress {...defaultProps} progress={75} />);

      const progressBar = document.querySelector('[style*="width: 75%"]');
      expect(progressBar).toBeInTheDocument();
    });
  });

  describe('phases', () => {
    it('should show idle state correctly', () => {
      render(<WorkflowProgress {...defaultProps} phase="idle" isActive={false} />);

      expect(screen.getByText('Ready')).toBeInTheDocument();
    });

    it('should show analyzing state correctly', () => {
      render(<WorkflowProgress {...defaultProps} phase="analyzing" />);

      expect(screen.getByText('Analyzing')).toBeInTheDocument();
    });

    it('should show complete state correctly', () => {
      render(<WorkflowProgress {...defaultProps} phase="complete" isActive={false} />);

      expect(screen.getByText('Complete')).toBeInTheDocument();
    });

    it('should show failed state with error', () => {
      render(
        <WorkflowProgress
          {...defaultProps}
          phase="failed"
          error="Something went wrong"
          isActive={false}
        />
      );

      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });

  describe('steps', () => {
    const stepsData: WorkflowStepData[] = [
      { id: '1', name: 'Analyze intent', status: 'completed' },
      { id: '2', name: 'Plan execution', status: 'in_progress' },
      { id: '3', name: 'Execute commands', status: 'pending' },
    ];

    it('should display steps', () => {
      render(<WorkflowProgress {...defaultProps} steps={stepsData} />);

      expect(screen.getByText('Analyze intent')).toBeInTheDocument();
      expect(screen.getByText('Plan execution')).toBeInTheDocument();
      expect(screen.getByText('Execute commands')).toBeInTheDocument();
    });

    it('should show step descriptions', () => {
      const stepsWithDesc: WorkflowStepData[] = [
        {
          id: '1',
          name: 'Step 1',
          status: 'completed',
          description: 'First step description',
        },
      ];

      render(<WorkflowProgress {...defaultProps} steps={stepsWithDesc} />);

      expect(screen.getByText('First step description')).toBeInTheDocument();
    });

    it('should show step errors', () => {
      const stepsWithError: WorkflowStepData[] = [
        { id: '1', name: 'Step 1', status: 'failed', error: 'Step failed' },
      ];

      render(<WorkflowProgress {...defaultProps} steps={stepsWithError} />);

      expect(screen.getByText('Step failed')).toBeInTheDocument();
    });
  });

  describe('cancel button', () => {
    it('should show cancel button when onCancel provided and active', () => {
      const onCancel = vi.fn();
      render(
        <WorkflowProgress {...defaultProps} isActive={true} onCancel={onCancel} />
      );

      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    it('should call onCancel when clicked', () => {
      const onCancel = vi.fn();
      render(
        <WorkflowProgress {...defaultProps} isActive={true} onCancel={onCancel} />
      );

      fireEvent.click(screen.getByText('Cancel'));

      expect(onCancel).toHaveBeenCalled();
    });

    it('should not show cancel button when not active', () => {
      const onCancel = vi.fn();
      render(
        <WorkflowProgress
          {...defaultProps}
          isActive={false}
          phase="complete"
          onCancel={onCancel}
        />
      );

      expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
    });
  });

  describe('spinner', () => {
    it('should show spinner when active and not complete/failed', () => {
      render(<WorkflowProgress {...defaultProps} isActive={true} />);

      // Check for the animate-spin class on spinner
      const spinner = document.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
    });

    it('should not show spinner when complete', () => {
      render(
        <WorkflowProgress {...defaultProps} phase="complete" isActive={false} />
      );

      // Should show checkmark instead
      expect(screen.getByText('✓')).toBeInTheDocument();
    });

    it('should show error icon when failed', () => {
      render(
        <WorkflowProgress {...defaultProps} phase="failed" isActive={false} />
      );

      expect(screen.getByText('✗')).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('should show preparing message when active with no steps', () => {
      render(<WorkflowProgress {...defaultProps} steps={[]} isActive={true} />);

      expect(screen.getByText('Preparing workflow...')).toBeInTheDocument();
    });
  });

  describe('compact mode', () => {
    it('should show phase and progress in compact mode', () => {
      render(
        <WorkflowProgress {...defaultProps} compact={true} progress={60} />
      );

      expect(screen.getByText('Executing')).toBeInTheDocument();
    });

    it('should show cancel button in compact mode when active', () => {
      const onCancel = vi.fn();
      render(
        <WorkflowProgress
          {...defaultProps}
          compact={true}
          isActive={true}
          onCancel={onCancel}
        />
      );

      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
  });
});
