/**
 * CaptionEditor Component Tests
 *
 * Tests for the caption editing modal dialog.
 * Follows TDD methodology - these tests are written before implementation.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CaptionEditor } from './CaptionEditor';
import type { Caption } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const createTestCaption = (overrides?: Partial<Caption>): Caption => ({
  id: 'caption_001',
  startSec: 1.5,
  endSec: 5.5,
  text: 'Hello world',
  speaker: 'Speaker 1',
  ...overrides,
});

// =============================================================================
// Mocks
// =============================================================================

const mockOnSave = vi.fn();
const mockOnCancel = vi.fn();
const mockOnDelete = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Tests
// =============================================================================

describe('CaptionEditor', () => {
  describe('Rendering', () => {
    it('renders the modal with caption data', () => {
      const caption = createTestCaption({ text: 'Test caption text' });
      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      expect(screen.getByTestId('caption-editor-modal')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Test caption text')).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      const caption = createTestCaption();
      render(
        <CaptionEditor
          caption={caption}
          isOpen={false}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      expect(screen.queryByTestId('caption-editor-modal')).not.toBeInTheDocument();
    });

    it('displays speaker name in input field', () => {
      const caption = createTestCaption({ speaker: 'John Doe' });
      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      expect(screen.getByDisplayValue('John Doe')).toBeInTheDocument();
    });

    it('displays time inputs with formatted values', () => {
      const caption = createTestCaption({ startSec: 65.5, endSec: 125.25 });
      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      // Time should be formatted as MM:SS.ms or similar
      const startInput = screen.getByLabelText(/start/i);
      const endInput = screen.getByLabelText(/end/i);

      expect(startInput).toBeInTheDocument();
      expect(endInput).toBeInTheDocument();
    });

    it('displays delete button when onDelete is provided', () => {
      const caption = createTestCaption();
      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
          onDelete={mockOnDelete}
        />,
      );

      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    });

    it('does not display delete button when onDelete is not provided', () => {
      const caption = createTestCaption();
      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    });
  });

  describe('Text Editing', () => {
    it('allows editing caption text', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({ text: 'Original text' });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const textInput = screen.getByDisplayValue('Original text');
      await user.clear(textInput);
      await user.type(textInput, 'New caption text');

      expect(screen.getByDisplayValue('New caption text')).toBeInTheDocument();
    });

    it('allows multiline text input', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({ text: 'Line 1' });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const textArea = screen.getByRole('textbox', { name: /text/i });
      await user.clear(textArea);
      await user.type(textArea, 'Line 1{enter}Line 2');

      expect(textArea).toHaveValue('Line 1\nLine 2');
    });
  });

  describe('Speaker Editing', () => {
    it('allows editing speaker name', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({ speaker: 'Original Speaker' });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const speakerInput = screen.getByLabelText(/speaker/i);
      await user.clear(speakerInput);
      await user.type(speakerInput, 'New Speaker');

      expect(screen.getByDisplayValue('New Speaker')).toBeInTheDocument();
    });

    it('allows clearing speaker name', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({ speaker: 'Speaker Name' });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const speakerInput = screen.getByLabelText(/speaker/i);
      await user.clear(speakerInput);

      expect(speakerInput).toHaveValue('');
    });
  });

  describe('Time Editing', () => {
    it('allows editing start time', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({ startSec: 10 });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const startInput = screen.getByLabelText(/start/i);
      await user.clear(startInput);
      await user.type(startInput, '15.5');

      expect(startInput).toHaveValue(15.5);
    });

    it('allows editing end time', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({ endSec: 20 });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const endInput = screen.getByLabelText(/end/i);
      await user.clear(endInput);
      await user.type(endInput, '25.0');

      expect(endInput).toHaveValue(25);
    });

    it('shows validation error when end time is before start time', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({ startSec: 10, endSec: 20 });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const endInput = screen.getByLabelText(/end/i);
      await user.clear(endInput);
      await user.type(endInput, '5');

      // Try to save
      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      expect(screen.getByText(/end time must be after start time/i)).toBeInTheDocument();
      expect(mockOnSave).not.toHaveBeenCalled();
    });

    it('shows validation error for negative time values', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({ startSec: 10 });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const startInput = screen.getByLabelText(/start/i);
      await user.clear(startInput);
      await user.type(startInput, '-5');

      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      expect(screen.getByText(/time must be non-negative/i)).toBeInTheDocument();
      expect(mockOnSave).not.toHaveBeenCalled();
    });
  });

  describe('Save Action', () => {
    it('calls onSave with updated caption data', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({
        text: 'Original',
        speaker: 'Speaker 1',
        startSec: 1,
        endSec: 5,
      });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      // Edit text
      const textInput = screen.getByDisplayValue('Original');
      await user.clear(textInput);
      await user.type(textInput, 'Updated text');

      // Save
      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      expect(mockOnSave).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'caption_001',
          text: 'Updated text',
          speaker: 'Speaker 1',
        }),
      );
    });

    it('disables save button when text is empty', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({ text: 'Some text' });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const textInput = screen.getByDisplayValue('Some text');
      await user.clear(textInput);

      const saveButton = screen.getByRole('button', { name: /save/i });
      expect(saveButton).toBeDisabled();
    });

    it('shows loading state during save', async () => {
      const user = userEvent.setup();
      const slowOnSave = vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));
      const caption = createTestCaption();

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={slowOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      expect(screen.getByText(/saving/i)).toBeInTheDocument();

      await waitFor(() => {
        expect(slowOnSave).toHaveBeenCalled();
      });
    });
  });

  describe('Cancel Action', () => {
    it('calls onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption();

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      expect(mockOnCancel).toHaveBeenCalled();
    });

    it('calls onCancel when Escape key is pressed', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption();

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      await user.keyboard('{Escape}');

      expect(mockOnCancel).toHaveBeenCalled();
    });

    it('calls onCancel when clicking outside the modal', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption();

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const backdrop = screen.getByTestId('caption-editor-backdrop');
      await user.click(backdrop);

      expect(mockOnCancel).toHaveBeenCalled();
    });

    it('discards unsaved changes when cancelled', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({ text: 'Original' });

      const { rerender } = render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      // Make changes
      const textInput = screen.getByDisplayValue('Original');
      await user.clear(textInput);
      await user.type(textInput, 'Changed');

      // Cancel
      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      // Reopen with original caption
      rerender(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      // Should show original text
      expect(screen.getByDisplayValue('Original')).toBeInTheDocument();
    });
  });

  describe('Delete Action', () => {
    it('calls onDelete when delete button is clicked and confirmed', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption();

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
          onDelete={mockOnDelete}
        />,
      );

      const deleteButton = screen.getByRole('button', { name: /delete/i });
      await user.click(deleteButton);

      // Confirmation dialog should appear
      expect(screen.getByText(/are you sure/i)).toBeInTheDocument();

      // Confirm deletion
      const confirmButton = screen.getByRole('button', { name: /confirm/i });
      await user.click(confirmButton);

      expect(mockOnDelete).toHaveBeenCalledWith('caption_001');
    });

    it('does not delete when confirmation is cancelled', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption();

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
          onDelete={mockOnDelete}
        />,
      );

      const deleteButton = screen.getByRole('button', { name: /delete/i });
      await user.click(deleteButton);

      // Cancel deletion
      const cancelDeleteButton = screen.getByRole('button', { name: /no, keep it/i });
      await user.click(cancelDeleteButton);

      expect(mockOnDelete).not.toHaveBeenCalled();
    });
  });

  describe('Keyboard Shortcuts', () => {
    it('saves when Ctrl+Enter is pressed', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption();

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      await user.keyboard('{Control>}{Enter}{/Control}');

      expect(mockOnSave).toHaveBeenCalled();
    });

    it('focuses text input when modal opens', () => {
      const caption = createTestCaption({ text: 'Focus me' });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const textInput = screen.getByRole('textbox', { name: /text/i });
      expect(textInput).toHaveFocus();
    });
  });

  describe('Duration Display', () => {
    it('displays calculated duration', () => {
      const caption = createTestCaption({ startSec: 10, endSec: 15.5 });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      expect(screen.getByText(/5\.5s/i)).toBeInTheDocument();
    });

    it('updates duration when times change', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption({ startSec: 10, endSec: 15 });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const endInput = screen.getByLabelText(/end/i);
      await user.clear(endInput);
      await user.type(endInput, '20');

      expect(screen.getByText(/10\.0s/i)).toBeInTheDocument();
    });
  });

  describe('Character Count', () => {
    it('displays character count for caption text', () => {
      const caption = createTestCaption({ text: 'Hello' });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      expect(screen.getByText(/5 characters/i)).toBeInTheDocument();
    });

    it('shows warning when text exceeds recommended length', async () => {
      const longText = 'A'.repeat(100);
      const caption = createTestCaption({ text: longText });

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
          maxRecommendedLength={80}
        />,
      );

      expect(screen.getByText(/exceeds recommended/i)).toBeInTheDocument();
    });
  });

  describe('Read-only Mode', () => {
    it('disables all inputs when readOnly is true', () => {
      const caption = createTestCaption();

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
          readOnly={true}
        />,
      );

      const textInput = screen.getByRole('textbox', { name: /text/i });
      const speakerInput = screen.getByLabelText(/speaker/i);
      const saveButton = screen.getByRole('button', { name: /save/i });

      expect(textInput).toBeDisabled();
      expect(speakerInput).toBeDisabled();
      expect(saveButton).toBeDisabled();
    });
  });

  describe('Accessibility', () => {
    it('has accessible labels for all form fields', () => {
      const caption = createTestCaption();

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      expect(screen.getByLabelText(/caption text/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/speaker/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/start/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/end/i)).toBeInTheDocument();
    });

    it('has proper ARIA attributes on modal', () => {
      const caption = createTestCaption();

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      const modal = screen.getByRole('dialog');
      expect(modal).toHaveAttribute('aria-modal', 'true');
      expect(modal).toHaveAttribute('aria-labelledby');
    });

    it('traps focus within modal', async () => {
      const user = userEvent.setup();
      const caption = createTestCaption();

      render(
        <CaptionEditor
          caption={caption}
          isOpen={true}
          onSave={mockOnSave}
          onCancel={mockOnCancel}
        />,
      );

      // Tab should cycle through elements within modal
      await user.tab();
      expect(document.activeElement).not.toBe(document.body);
    });
  });
});
