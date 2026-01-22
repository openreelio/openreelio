/**
 * TranscriptionDialog Component Tests
 *
 * Tests for the transcription options dialog.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptionDialog } from './TranscriptionDialog';
import type { AssetData } from '@/components/explorer/AssetItem';

// =============================================================================
// Test Data
// =============================================================================

const createTestAsset = (overrides?: Partial<AssetData>): AssetData => ({
  id: 'asset_001',
  name: 'test-video.mp4',
  kind: 'video',
  duration: 120,
  ...overrides,
});

// =============================================================================
// Mocks
// =============================================================================

const mockOnConfirm = vi.fn();
const mockOnCancel = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Tests
// =============================================================================

describe('TranscriptionDialog', () => {
  describe('Rendering', () => {
    it('renders the dialog when open', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByTestId('transcription-dialog')).toBeInTheDocument();
      expect(screen.getByText(/transcribe/i)).toBeInTheDocument();
    });

    it('does not render when closed', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={false}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.queryByTestId('transcription-dialog')).not.toBeInTheDocument();
    });

    it('displays asset name in title', () => {
      const asset = createTestAsset({ name: 'my-video.mp4' });
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByText(/my-video\.mp4/)).toBeInTheDocument();
    });

    it('shows language selection dropdown', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByLabelText(/language/i)).toBeInTheDocument();
    });

    it('shows model selection when available', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
          availableModels={['tiny', 'base', 'small', 'medium']}
        />
      );

      expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
    });
  });

  describe('Language Selection', () => {
    it('has English as default language', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const languageSelect = screen.getByLabelText(/language/i);
      expect(languageSelect).toHaveValue('en');
    });

    it('allows changing language', async () => {
      const user = userEvent.setup();
      const asset = createTestAsset();

      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const languageSelect = screen.getByLabelText(/language/i);
      await user.selectOptions(languageSelect, 'ko');

      expect(languageSelect).toHaveValue('ko');
    });

    it('supports auto-detect option', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const languageSelect = screen.getByLabelText(/language/i);
      const options = Array.from((languageSelect as HTMLSelectElement).options);
      const autoOption = options.find((opt) => opt.value === 'auto');

      expect(autoOption).toBeDefined();
    });
  });

  describe('Model Selection', () => {
    it('shows available models in dropdown', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
          availableModels={['tiny', 'base', 'small']}
        />
      );

      const modelSelect = screen.getByLabelText(/model/i);
      const options = Array.from((modelSelect as HTMLSelectElement).options);

      expect(options.map((o) => o.value)).toContain('tiny');
      expect(options.map((o) => o.value)).toContain('base');
      expect(options.map((o) => o.value)).toContain('small');
    });

    it('defaults to base model', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
          availableModels={['tiny', 'base', 'small']}
        />
      );

      const modelSelect = screen.getByLabelText(/model/i);
      expect(modelSelect).toHaveValue('base');
    });
  });

  describe('Actions', () => {
    it('calls onConfirm with selected options when confirmed', async () => {
      const user = userEvent.setup();
      const asset = createTestAsset();

      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      // Change language
      const languageSelect = screen.getByLabelText(/language/i);
      await user.selectOptions(languageSelect, 'ko');

      // Click confirm
      const confirmButton = screen.getByRole('button', { name: /start transcription/i });
      await user.click(confirmButton);

      expect(mockOnConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          language: 'ko',
        })
      );
    });

    it('calls onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const asset = createTestAsset();

      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      expect(mockOnCancel).toHaveBeenCalled();
    });

    it('calls onCancel when Escape is pressed', async () => {
      const user = userEvent.setup();
      const asset = createTestAsset();

      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      await user.keyboard('{Escape}');

      expect(mockOnCancel).toHaveBeenCalled();
    });

    it('disables confirm button while processing', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
          isProcessing={true}
        />
      );

      const confirmButton = screen.getByRole('button', { name: /starting/i });
      expect(confirmButton).toBeDisabled();
    });
  });

  describe('Advanced Options', () => {
    it('has an option to add to caption track', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByLabelText(/add to timeline/i)).toBeInTheDocument();
    });

    it('includes addToTimeline option in confirm callback', async () => {
      const user = userEvent.setup();
      const asset = createTestAsset();

      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      // Toggle option
      const checkbox = screen.getByLabelText(/add to timeline/i);
      await user.click(checkbox);

      // Confirm
      const confirmButton = screen.getByRole('button', { name: /start transcription/i });
      await user.click(confirmButton);

      expect(mockOnConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          addToTimeline: true,
        })
      );
    });
  });

  describe('Duration Warning', () => {
    it('shows warning for long duration assets', () => {
      const asset = createTestAsset({ duration: 3600 }); // 1 hour
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByText(/may take a while/i)).toBeInTheDocument();
    });

    it('does not show warning for short duration assets', () => {
      const asset = createTestAsset({ duration: 60 }); // 1 minute
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.queryByText(/may take a while/i)).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('has proper ARIA attributes', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby');
    });

    it('focuses first input when opened', () => {
      const asset = createTestAsset();
      render(
        <TranscriptionDialog
          asset={asset}
          isOpen={true}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const languageSelect = screen.getByLabelText(/language/i);
      expect(languageSelect).toHaveFocus();
    });
  });
});
