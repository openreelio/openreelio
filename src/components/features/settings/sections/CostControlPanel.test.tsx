/**
 * CostControlPanel Tests
 *
 * Tests for the AI cost control panel component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CostControlPanel, type CostControlPanelProps } from './CostControlPanel';
import type { AISettings } from '@/stores/settingsStore';

const defaultAISettings: AISettings = {
  primaryProvider: 'anthropic',
  primaryModel: 'claude-sonnet-4-5-20251015',
  visionProvider: null,
  visionModel: null,
  openaiApiKey: null,
  anthropicApiKey: null,
  googleApiKey: null,
  ollamaUrl: null,
  temperature: 0.3,
  maxTokens: 4096,
  frameExtractionRate: 1.0,
  monthlyBudgetCents: null,
  perRequestLimitCents: 50,
  currentMonthUsageCents: 0,
  currentUsageMonth: null,
  autoAnalyzeOnImport: false,
  autoCaptionOnImport: false,
  proposalReviewMode: 'always',
  cacheDurationHours: 24,
  localOnlyMode: false,
};

describe('CostControlPanel', () => {
  const mockOnUpdate = vi.fn();

  const defaultProps: CostControlPanelProps = {
    settings: defaultAISettings,
    onUpdate: mockOnUpdate,
    disabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render the panel title', () => {
      render(<CostControlPanel {...defaultProps} />);
      expect(screen.getByText('Cost Controls')).toBeInTheDocument();
    });

    it('should render monthly budget input', () => {
      render(<CostControlPanel {...defaultProps} />);
      expect(screen.getByLabelText(/monthly budget/i)).toBeInTheDocument();
    });

    it('should render per-request limit input', () => {
      render(<CostControlPanel {...defaultProps} />);
      expect(screen.getByLabelText(/per-request limit/i)).toBeInTheDocument();
    });

    it('should render current usage display', () => {
      render(<CostControlPanel {...defaultProps} />);
      expect(screen.getByText(/current month usage/i)).toBeInTheDocument();
    });

    it('should display current usage in dollars', () => {
      const settings = {
        ...defaultAISettings,
        currentMonthUsageCents: 1234,
      };
      render(<CostControlPanel {...defaultProps} settings={settings} />);
      expect(screen.getByText('$12.34')).toBeInTheDocument();
    });
  });

  describe('Monthly Budget', () => {
    it('should display null budget as empty input', () => {
      render(<CostControlPanel {...defaultProps} />);
      const input = screen.getByLabelText(/monthly budget/i) as HTMLInputElement;
      expect(input.value).toBe('');
    });

    it('should display budget in dollars', () => {
      const settings = {
        ...defaultAISettings,
        monthlyBudgetCents: 5000,
      };
      render(<CostControlPanel {...defaultProps} settings={settings} />);
      const input = screen.getByLabelText(/monthly budget/i) as HTMLInputElement;
      expect(input.value).toBe('50.00');
    });

    it('should call onUpdate with cents when budget is changed', async () => {
      const user = userEvent.setup();
      render(<CostControlPanel {...defaultProps} />);

      const input = screen.getByLabelText(/monthly budget/i);
      await user.clear(input);
      await user.type(input, '25');

      // Blur to trigger update
      fireEvent.blur(input);

      expect(mockOnUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ monthlyBudgetCents: 2500 })
      );
    });

    it('should allow clearing the budget (sets to null)', async () => {
      const user = userEvent.setup();
      const settings = {
        ...defaultAISettings,
        monthlyBudgetCents: 5000,
      };
      render(<CostControlPanel {...defaultProps} settings={settings} />);

      const input = screen.getByLabelText(/monthly budget/i);
      await user.clear(input);
      fireEvent.blur(input);

      expect(mockOnUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ monthlyBudgetCents: null })
      );
    });
  });

  describe('Per-Request Limit', () => {
    it('should display per-request limit in cents', () => {
      const settings = {
        ...defaultAISettings,
        perRequestLimitCents: 50,
      };
      render(<CostControlPanel {...defaultProps} settings={settings} />);
      const input = screen.getByLabelText(/per-request limit/i) as HTMLInputElement;
      expect(input.value).toBe('0.50');
    });

    it('should call onUpdate with cents when limit is changed', async () => {
      const user = userEvent.setup();
      render(<CostControlPanel {...defaultProps} />);

      const input = screen.getByLabelText(/per-request limit/i);
      await user.clear(input);
      await user.type(input, '1');
      fireEvent.blur(input);

      expect(mockOnUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ perRequestLimitCents: 100 })
      );
    });
  });

  describe('Budget Progress', () => {
    it('should show progress bar when budget is set', () => {
      const settings = {
        ...defaultAISettings,
        monthlyBudgetCents: 10000,
        currentMonthUsageCents: 2500,
      };
      render(<CostControlPanel {...defaultProps} settings={settings} />);
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('should not show progress bar when no budget is set', () => {
      render(<CostControlPanel {...defaultProps} />);
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('should show correct percentage', () => {
      const settings = {
        ...defaultAISettings,
        monthlyBudgetCents: 10000,
        currentMonthUsageCents: 2500,
      };
      render(<CostControlPanel {...defaultProps} settings={settings} />);
      expect(screen.getByText('25%')).toBeInTheDocument();
    });

    it('should show warning color when usage exceeds 80%', () => {
      const settings = {
        ...defaultAISettings,
        monthlyBudgetCents: 10000,
        currentMonthUsageCents: 8500,
      };
      render(<CostControlPanel {...defaultProps} settings={settings} />);
      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveClass('bg-yellow-500');
    });

    it('should show error color when usage exceeds budget', () => {
      const settings = {
        ...defaultAISettings,
        monthlyBudgetCents: 10000,
        currentMonthUsageCents: 12000,
      };
      render(<CostControlPanel {...defaultProps} settings={settings} />);
      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveClass('bg-red-500');
    });
  });

  describe('Disabled State', () => {
    it('should disable inputs when disabled prop is true', () => {
      render(<CostControlPanel {...defaultProps} disabled={true} />);

      expect(screen.getByLabelText(/monthly budget/i)).toBeDisabled();
      expect(screen.getByLabelText(/per-request limit/i)).toBeDisabled();
    });
  });

  describe('Reset Usage Button', () => {
    it('should render reset usage button', () => {
      render(<CostControlPanel {...defaultProps} />);
      expect(screen.getByRole('button', { name: /reset usage/i })).toBeInTheDocument();
    });

    it('should call onUpdate with zero usage when reset is clicked', async () => {
      const user = userEvent.setup();
      const settings = {
        ...defaultAISettings,
        currentMonthUsageCents: 5000,
      };
      render(<CostControlPanel {...defaultProps} settings={settings} />);

      const resetButton = screen.getByRole('button', { name: /reset usage/i });
      await user.click(resetButton);

      expect(mockOnUpdate).toHaveBeenCalledWith({
        currentMonthUsageCents: 0,
        currentUsageMonth: null,
      });
    });

    it('should disable reset button when disabled prop is true', () => {
      render(<CostControlPanel {...defaultProps} disabled={true} />);
      expect(screen.getByRole('button', { name: /reset usage/i })).toBeDisabled();
    });
  });
});
