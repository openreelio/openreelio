/**
 * PlanViewer Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlanViewer } from './PlanViewer';
import type { Plan, PlanStep } from '@/agents/engine';

describe('PlanViewer', () => {
  const mockSteps: PlanStep[] = [
    {
      id: 'step-1',
      description: 'Split the clip at 5 seconds',
      tool: 'split_clip',
      args: { clipId: 'clip-1', atTimelineSec: 5 },
      riskLevel: 'low',
      estimatedDuration: 250,
    },
    {
      id: 'step-2',
      description: 'Delete the second half',
      tool: 'delete_clip',
      args: { clipId: 'clip-1_right' },
      riskLevel: 'high',
      estimatedDuration: 250,
    },
  ];

  const mockPlan: Plan = {
    goal: 'Split and delete clip',
    steps: mockSteps,
    estimatedTotalDuration: 500,
    requiresApproval: true,
    rollbackStrategy: 'Undo executed steps in reverse order',
  };

  describe('rendering', () => {
    it('should display plan goal', () => {
      render(<PlanViewer plan={mockPlan} />);

      expect(screen.getByText(mockPlan.goal)).toBeInTheDocument();
    });

    it('should display all steps', () => {
      render(<PlanViewer plan={mockPlan} />);

      mockSteps.forEach((step) => {
        expect(screen.getByText(step.description)).toBeInTheDocument();
      });
    });

    it('should display risk level badge', () => {
      render(<PlanViewer plan={mockPlan} />);

      // Multiple elements may contain "high" (overall risk and step risk)
      const elements = screen.getAllByText(/high/i);
      expect(elements.length).toBeGreaterThan(0);
    });
  });

  describe('approval state', () => {
    it('should show approval buttons when awaiting approval', () => {
      render(
        <PlanViewer
          plan={mockPlan}
          isAwaitingApproval={true}
          onApprove={vi.fn()}
          onReject={vi.fn()}
        />
      );

      expect(screen.getByText('Approve')).toBeInTheDocument();
      expect(screen.getByText('Reject')).toBeInTheDocument();
    });

    it('should call onApprove when approve button is clicked', () => {
      const onApprove = vi.fn();

      render(
        <PlanViewer
          plan={mockPlan}
          isAwaitingApproval={true}
          onApprove={onApprove}
          onReject={vi.fn()}
        />
      );

      fireEvent.click(screen.getByText('Approve'));
      expect(onApprove).toHaveBeenCalled();
    });

    it('should call onReject when reject button is clicked', () => {
      const onReject = vi.fn();

      render(
        <PlanViewer
          plan={mockPlan}
          isAwaitingApproval={true}
          onApprove={vi.fn()}
          onReject={onReject}
        />
      );

      fireEvent.click(screen.getByText('Reject'));
      expect(onReject).toHaveBeenCalled();
    });

    it('should not show approval buttons when not awaiting approval', () => {
      render(<PlanViewer plan={mockPlan} isAwaitingApproval={false} />);

      expect(screen.queryByText('Approve')).not.toBeInTheDocument();
      expect(screen.queryByText('Reject')).not.toBeInTheDocument();
    });
  });

  describe('step status', () => {
    it('should highlight current step', () => {
      render(<PlanViewer plan={mockPlan} currentStepId="step-1" />);

      const step = screen.getByTestId('plan-step-step-1');
      expect(step).toHaveClass('border-primary-500');
    });

    it('should mark completed steps', () => {
      render(
        <PlanViewer
          plan={mockPlan}
          completedStepIds={['step-1']}
          currentStepId="step-2"
        />
      );

      const completedStep = screen.getByTestId('plan-step-step-1');
      expect(completedStep).toHaveClass('opacity-60');
    });
  });

  describe('collapsed mode', () => {
    it('should show collapsed view when collapsed prop is true', () => {
      render(<PlanViewer plan={mockPlan} collapsed={true} />);

      expect(screen.getByText(mockPlan.goal)).toBeInTheDocument();
      expect(screen.queryByText(mockSteps[0].description)).not.toBeInTheDocument();
    });
  });

  describe('null plan', () => {
    it('should handle null plan gracefully', () => {
      render(<PlanViewer plan={null} />);

      expect(screen.getByTestId('plan-viewer')).toBeInTheDocument();
    });
  });
});
