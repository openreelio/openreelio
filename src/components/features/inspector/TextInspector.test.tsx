/**
 * TextInspector Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextInspector, SelectedTextClip } from './TextInspector';
import { createTextClipData, createTitleTextClipData } from '@/types';

describe('TextInspector', () => {
  const mockOnTextDataChange = vi.fn();

  const defaultTextClip: SelectedTextClip = {
    id: 'clip-1',
    textData: createTextClipData('Test Text'),
    timelineInSec: 5.0,
    durationSec: 3.0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render the inspector with text content', () => {
      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      expect(screen.getByTestId('text-inspector')).toBeInTheDocument();
      expect(screen.getByText('Text Properties')).toBeInTheDocument();
      expect(screen.getByTestId('text-content-input')).toHaveValue('Test Text');
    });

    it('should render all sections', () => {
      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      expect(screen.getByText('Content')).toBeInTheDocument();
      expect(screen.getByText('Font')).toBeInTheDocument();
      expect(screen.getByText('Color')).toBeInTheDocument();
      expect(screen.getByText('Position')).toBeInTheDocument();
      expect(screen.getByText('Shadow')).toBeInTheDocument();
      expect(screen.getByText('Outline')).toBeInTheDocument();
    });

    it('should render font family selector with default value', () => {
      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      const fontSelector = screen.getByRole('combobox');
      expect(fontSelector).toHaveValue('Arial');
    });

    it('should render with title preset styling', () => {
      const titleClip: SelectedTextClip = {
        id: 'clip-2',
        textData: createTitleTextClipData('Title Text'),
        timelineInSec: 0.0,
        durationSec: 5.0,
      };

      render(
        <TextInspector
          selectedTextClip={titleClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      expect(screen.getByTestId('text-content-input')).toHaveValue('Title Text');
    });
  });

  describe('content editing', () => {
    it('should call onTextDataChange when content is edited', async () => {
      const user = userEvent.setup();

      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      const textarea = screen.getByTestId('text-content-input');
      await user.clear(textarea);
      await user.type(textarea, 'New Text');

      expect(mockOnTextDataChange).toHaveBeenCalled();
      // Check the last call includes the new content
      const lastCall = mockOnTextDataChange.mock.calls[mockOnTextDataChange.mock.calls.length - 1];
      expect(lastCall[0]).toBe('clip-1');
      expect(lastCall[1].content).toBe('New Text');
    });
  });

  describe('font styling', () => {
    it('should toggle bold style', async () => {
      const user = userEvent.setup();

      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      const boldButton = screen.getByTitle('Bold');
      await user.click(boldButton);

      expect(mockOnTextDataChange).toHaveBeenCalledWith(
        'clip-1',
        expect.objectContaining({
          style: expect.objectContaining({ bold: true }),
        })
      );
    });

    it('should toggle italic style', async () => {
      const user = userEvent.setup();

      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      const italicButton = screen.getByTitle('Italic');
      await user.click(italicButton);

      expect(mockOnTextDataChange).toHaveBeenCalledWith(
        'clip-1',
        expect.objectContaining({
          style: expect.objectContaining({ italic: true }),
        })
      );
    });

    it('should toggle underline style', async () => {
      const user = userEvent.setup();

      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      const underlineButton = screen.getByTitle('Underline');
      await user.click(underlineButton);

      expect(mockOnTextDataChange).toHaveBeenCalledWith(
        'clip-1',
        expect.objectContaining({
          style: expect.objectContaining({ underline: true }),
        })
      );
    });

    it('should change text alignment', async () => {
      const user = userEvent.setup();

      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      const leftAlignButton = screen.getByTitle('Align left');
      await user.click(leftAlignButton);

      expect(mockOnTextDataChange).toHaveBeenCalledWith(
        'clip-1',
        expect.objectContaining({
          style: expect.objectContaining({ alignment: 'left' }),
        })
      );
    });

    it('should change font family', async () => {
      const user = userEvent.setup();

      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      const fontSelector = screen.getByRole('combobox');
      await user.selectOptions(fontSelector, 'Helvetica');

      expect(mockOnTextDataChange).toHaveBeenCalledWith(
        'clip-1',
        expect.objectContaining({
          style: expect.objectContaining({ fontFamily: 'Helvetica' }),
        })
      );
    });
  });

  describe('shadow controls', () => {
    it('should toggle shadow on', async () => {
      const user = userEvent.setup();

      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      await user.click(screen.getByTitle('Enable shadow'));

      // Should have been called with shadow data
      const calls = mockOnTextDataChange.mock.calls;
      const shadowCall = calls.find(
        (call) => call[1].shadow !== undefined
      );
      expect(shadowCall).toBeDefined();
    });
  });

  describe('outline controls', () => {
    it('should toggle outline on', async () => {
      const user = userEvent.setup();

      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      await user.click(screen.getByTitle('Enable outline'));

      // Should have been called with outline data
      const calls = mockOnTextDataChange.mock.calls;
      const outlineCall = calls.find(
        (call) => call[1].outline !== undefined
      );
      expect(outlineCall).toBeDefined();
    });
  });

  describe('position controls', () => {
    it('should update position via slider', async () => {
      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      const sliders = screen.getAllByRole('slider');
      // First two sliders are X and Y position
      const xSlider = sliders[0];

      // Simulate slider change
      fireEvent.change(xSlider, { target: { value: '0.25' } });

      expect(mockOnTextDataChange).toHaveBeenCalledWith(
        'clip-1',
        expect.objectContaining({
          position: expect.objectContaining({ x: 0.25 }),
        })
      );
    });
  });

  describe('reset functionality', () => {
    it('should reset to defaults when reset button is clicked', async () => {
      const user = userEvent.setup();

      // Start with custom styling
      const customTextClip: SelectedTextClip = {
        id: 'clip-1',
        textData: {
          content: 'Custom Text',
          style: {
            fontFamily: 'Helvetica',
            fontSize: 72,
            color: '#FF0000',
            bold: true,
            italic: true,
            underline: true,
            alignment: 'left',
            lineHeight: 2.0,
            letterSpacing: 5,
            backgroundPadding: 20,
          },
          position: { x: 0.2, y: 0.8 },
          rotation: 45,
          opacity: 0.5,
          shadow: { color: '#000000', offsetX: 5, offsetY: 5, blur: 10 },
          outline: { color: '#FFFFFF', width: 3 },
        },
        timelineInSec: 0.0,
        durationSec: 5.0,
      };

      render(
        <TextInspector
          selectedTextClip={customTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      const resetButton = screen.getByTitle('Reset to defaults');
      await user.click(resetButton);

      expect(mockOnTextDataChange).toHaveBeenCalledWith(
        'clip-1',
        expect.objectContaining({
          content: 'Custom Text', // Content should be preserved
          style: expect.objectContaining({
            fontFamily: 'Arial',
            fontSize: 48,
            bold: false,
            italic: false,
          }),
          rotation: 0,
          opacity: 1.0,
        })
      );
    });
  });

  describe('read-only mode', () => {
    it('should disable all inputs when readOnly is true', () => {
      render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
          readOnly={true}
        />
      );

      const textarea = screen.getByTestId('text-content-input');
      expect(textarea).toBeDisabled();

      const fontSelector = screen.getByRole('combobox');
      expect(fontSelector).toBeDisabled();

      const boldButton = screen.getByTitle('Bold');
      expect(boldButton).toBeDisabled();
    });
  });

  describe('prop updates', () => {
    it('should update local state when props change', () => {
      const { rerender } = render(
        <TextInspector
          selectedTextClip={defaultTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      // Verify initial content
      expect(screen.getByTestId('text-content-input')).toHaveValue('Test Text');

      // Update props with new text clip
      const updatedTextClip: SelectedTextClip = {
        id: 'clip-1',
        textData: createTextClipData('Updated Text'),
        timelineInSec: 5.0,
        durationSec: 3.0,
      };

      rerender(
        <TextInspector
          selectedTextClip={updatedTextClip}
          onTextDataChange={mockOnTextDataChange}
        />
      );

      // Verify content updated
      expect(screen.getByTestId('text-content-input')).toHaveValue('Updated Text');
    });
  });
});
