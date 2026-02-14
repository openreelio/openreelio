import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

describe('UnsavedChangesDialog', () => {
  it('does not render when closed', () => {
    render(
      <UnsavedChangesDialog
        isOpen={false}
        isSaving={false}
        onCancel={vi.fn()}
        onDiscard={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders when open', () => {
    render(
      <UnsavedChangesDialog
        isOpen={true}
        isSaving={false}
        onCancel={vi.fn()}
        onDiscard={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
  });

  it('calls onCancel when backdrop is clicked', () => {
    const onCancel = vi.fn();
    render(
      <UnsavedChangesDialog
        isOpen={true}
        isSaving={false}
        onCancel={onCancel}
        onDiscard={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const backdrop = screen.getByRole('dialog').firstElementChild as HTMLElement;
    fireEvent.click(backdrop);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls action callbacks from buttons', () => {
    const onCancel = vi.fn();
    const onDiscard = vi.fn();
    const onSave = vi.fn();
    render(
      <UnsavedChangesDialog
        isOpen={true}
        isSaving={false}
        onCancel={onCancel}
        onDiscard={onDiscard}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: "Don't Save" }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('disables save button while saving', () => {
    render(
      <UnsavedChangesDialog
        isOpen={true}
        isSaving={true}
        onCancel={vi.fn()}
        onDiscard={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
