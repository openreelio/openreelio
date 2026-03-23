/**
 * RemoveAttributesDialog Component Tests
 *
 * Integration tests for the remove attributes dialog that allows
 * selective removal of effects and clip attributes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RemoveAttributesDialog } from './RemoveAttributesDialog';

const defaultProps = {
  isOpen: true,
  clipEffects: [
    { id: 'effect-1', label: 'Brightness' },
    { id: 'effect-2', label: 'Gaussian Blur' },
  ],
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe('RemoveAttributesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('should render clip effects and reset attribute options', () => {
    render(<RemoveAttributesDialog {...defaultProps} />);

    expect(screen.getByText('Brightness')).toBeInTheDocument();
    expect(screen.getByText('Gaussian Blur')).toBeInTheDocument();
    expect(screen.getByText('Transform')).toBeInTheDocument();
    expect(screen.getByText('Audio Settings')).toBeInTheDocument();
  });

  it('should call onConfirm with selected effects and reset flags', () => {
    const onConfirm = vi.fn();
    render(<RemoveAttributesDialog {...defaultProps} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByLabelText('Brightness'));
    fireEvent.click(screen.getByLabelText('Opacity'));
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));

    expect(onConfirm).toHaveBeenCalledWith({
      effectIds: ['effect-1'],
      resetTransform: false,
      resetOpacity: true,
      resetBlendMode: false,
      resetSpeed: false,
      resetAudio: false,
    });
  });

  it('should call onCancel when Escape is pressed', () => {
    const onCancel = vi.fn();
    render(<RemoveAttributesDialog {...defaultProps} onCancel={onCancel} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('should reset selections when reopened', () => {
    const { rerender } = render(<RemoveAttributesDialog {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Brightness'));
    expect(screen.getByRole('button', { name: /remove/i })).not.toBeDisabled();

    rerender(<RemoveAttributesDialog {...defaultProps} isOpen={false} />);
    rerender(<RemoveAttributesDialog {...defaultProps} isOpen />);

    expect(screen.getByLabelText('Brightness')).not.toBeChecked();
    expect(screen.getByRole('button', { name: /remove/i })).toBeDisabled();
  });
});
