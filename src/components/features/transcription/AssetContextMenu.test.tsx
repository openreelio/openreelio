/**
 * AssetContextMenu Component Tests
 *
 * Tests for the asset context menu with transcription option.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AssetContextMenu } from './AssetContextMenu';
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

const mockOnTranscribe = vi.fn();
const mockOnDelete = vi.fn();
const mockOnRename = vi.fn();
const mockOnClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Tests
// =============================================================================

describe('AssetContextMenu', () => {
  describe('Rendering', () => {
    it('renders the context menu at specified position', () => {
      const asset = createTestAsset();
      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
        />
      );

      const menu = screen.getByTestId('asset-context-menu');
      expect(menu).toBeInTheDocument();
      expect(menu).toHaveStyle({ left: '100px', top: '200px' });
    });

    it('does not render when isOpen is false', () => {
      const asset = createTestAsset();
      render(
        <AssetContextMenu
          asset={asset}
          isOpen={false}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
        />
      );

      expect(screen.queryByTestId('asset-context-menu')).not.toBeInTheDocument();
    });

    it('shows transcribe option for video assets', () => {
      const asset = createTestAsset({ kind: 'video' });
      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText(/transcribe/i)).toBeInTheDocument();
    });

    it('shows transcribe option for audio assets', () => {
      const asset = createTestAsset({ kind: 'audio' });
      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText(/transcribe/i)).toBeInTheDocument();
    });

    it('does not show transcribe option for image assets', () => {
      const asset = createTestAsset({ kind: 'image' });
      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
        />
      );

      expect(screen.queryByText(/transcribe/i)).not.toBeInTheDocument();
    });

    it('shows all menu options', () => {
      const asset = createTestAsset();
      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onRename={mockOnRename}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText(/transcribe/i)).toBeInTheDocument();
      expect(screen.getByText(/rename/i)).toBeInTheDocument();
      expect(screen.getByText(/delete/i)).toBeInTheDocument();
    });
  });

  describe('Actions', () => {
    it('calls onTranscribe when transcribe option is clicked', async () => {
      const user = userEvent.setup();
      const asset = createTestAsset();

      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
        />
      );

      await user.click(screen.getByText(/transcribe/i));

      expect(mockOnTranscribe).toHaveBeenCalledWith(asset);
      expect(mockOnClose).toHaveBeenCalled();
    });

    it('calls onDelete when delete option is clicked', async () => {
      const user = userEvent.setup();
      const asset = createTestAsset();

      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
        />
      );

      await user.click(screen.getByText(/delete/i));

      expect(mockOnDelete).toHaveBeenCalledWith(asset);
      expect(mockOnClose).toHaveBeenCalled();
    });

    it('calls onRename when rename option is clicked', async () => {
      const user = userEvent.setup();
      const asset = createTestAsset();

      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onRename={mockOnRename}
          onClose={mockOnClose}
        />
      );

      await user.click(screen.getByText(/rename/i));

      expect(mockOnRename).toHaveBeenCalledWith(asset);
      expect(mockOnClose).toHaveBeenCalled();
    });

    it('closes menu when clicking outside', async () => {
      const user = userEvent.setup();
      const asset = createTestAsset();

      render(
        <>
          <div data-testid="outside-element">Outside</div>
          <AssetContextMenu
            asset={asset}
            isOpen={true}
            position={{ x: 100, y: 200 }}
            onTranscribe={mockOnTranscribe}
            onDelete={mockOnDelete}
            onClose={mockOnClose}
          />
        </>
      );

      await user.click(screen.getByTestId('outside-element'));

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('closes menu when Escape is pressed', async () => {
      const user = userEvent.setup();
      const asset = createTestAsset();

      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
        />
      );

      await user.keyboard('{Escape}');

      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe('Disabled States', () => {
    it('disables transcribe option when transcription is in progress', () => {
      const asset = createTestAsset();
      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
          isTranscribing={true}
        />
      );

      const transcribeButton = screen.getByText(/transcribing/i);
      expect(transcribeButton.closest('button')).toBeDisabled();
    });

    it('disables transcribe when transcription is not available', () => {
      const asset = createTestAsset();
      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
          isTranscriptionAvailable={false}
        />
      );

      const transcribeButton = screen.getByText(/transcribe/i).closest('button');
      expect(transcribeButton).toBeDisabled();
    });
  });

  describe('Accessibility', () => {
    it('has proper ARIA attributes', () => {
      const asset = createTestAsset();
      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
        />
      );

      const menu = screen.getByRole('menu');
      expect(menu).toBeInTheDocument();
    });

    it('menu items are focusable', () => {
      const asset = createTestAsset();
      render(
        <AssetContextMenu
          asset={asset}
          isOpen={true}
          position={{ x: 100, y: 200 }}
          onTranscribe={mockOnTranscribe}
          onDelete={mockOnDelete}
          onClose={mockOnClose}
        />
      );

      const menuItems = screen.getAllByRole('menuitem');
      menuItems.forEach((item) => {
        expect(item).toHaveAttribute('tabIndex');
      });
    });
  });
});
