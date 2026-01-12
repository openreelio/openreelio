/**
 * ProjectCreationDialog Component Tests
 *
 * TDD: Tests for project creation dialog
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectCreationDialog } from './ProjectCreationDialog';

// Mock Tauri dialog API
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

describe('ProjectCreationDialog', () => {
  const mockOnCreate = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  it('renders the dialog when open', () => {
    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    expect(screen.getByTestId('project-creation-dialog')).toBeInTheDocument();
    expect(screen.getByText('Create New Project')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <ProjectCreationDialog
        isOpen={false}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    expect(screen.queryByTestId('project-creation-dialog')).not.toBeInTheDocument();
  });

  it('renders project name input', () => {
    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    expect(screen.getByTestId('project-name-input')).toBeInTheDocument();
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
  });

  it('renders location picker', () => {
    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    expect(screen.getByTestId('location-picker')).toBeInTheDocument();
    expect(screen.getByText(/browse/i)).toBeInTheDocument();
  });

  it('renders format preset selector', () => {
    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    expect(screen.getByTestId('format-preset-selector')).toBeInTheDocument();
  });

  it('renders create and cancel buttons', () => {
    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    expect(screen.getByTestId('create-button')).toBeInTheDocument();
    expect(screen.getByTestId('cancel-button')).toBeInTheDocument();
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  it('updates project name on input', async () => {
    const user = userEvent.setup();

    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    const input = screen.getByTestId('project-name-input');
    await user.clear(input);
    await user.type(input, 'My Project');

    expect(input).toHaveValue('My Project');
  });

  it('calls onCancel when cancel button is clicked', async () => {
    const user = userEvent.setup();

    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    await user.click(screen.getByTestId('cancel-button'));

    expect(mockOnCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCreate with form data when create button is clicked', async () => {
    const user = userEvent.setup();

    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
        defaultLocation="/default/path"
      />
    );

    const input = screen.getByTestId('project-name-input');
    await user.clear(input);
    await user.type(input, 'Test Project');

    await user.click(screen.getByTestId('create-button'));

    expect(mockOnCreate).toHaveBeenCalledWith({
      name: 'Test Project',
      path: '/default/path',
      format: expect.any(String),
    });
  });

  // ===========================================================================
  // Validation Tests
  // ===========================================================================

  it('disables create button when name is empty', () => {
    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    const createButton = screen.getByTestId('create-button');
    const nameInput = screen.getByTestId('project-name-input');

    // Clear the input
    fireEvent.change(nameInput, { target: { value: '' } });

    expect(createButton).toBeDisabled();
  });

  it('disables create button when location is empty', () => {
    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
        defaultLocation=""
      />
    );

    const createButton = screen.getByTestId('create-button');
    expect(createButton).toBeDisabled();
  });

  it('shows error message for invalid project name', async () => {
    const user = userEvent.setup();

    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    const input = screen.getByTestId('project-name-input');
    await user.clear(input);
    await user.type(input, '   '); // Only whitespace

    // Blur to trigger validation
    fireEvent.blur(input);

    expect(screen.getByText(/project name is required/i)).toBeInTheDocument();
  });

  // ===========================================================================
  // Format Preset Tests
  // ===========================================================================

  it('allows selecting different format presets', async () => {
    const user = userEvent.setup();

    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
        defaultLocation="/path"
      />
    );

    const selector = screen.getByTestId('format-preset-selector');
    await user.click(selector);

    // Check that options are available
    expect(screen.getByText(/1080p/i)).toBeInTheDocument();
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  it('has proper role for dialog', () => {
    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('has proper aria-labelledby', () => {
    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby');
  });

  it('traps focus within dialog', () => {
    render(
      <ProjectCreationDialog
        isOpen={true}
        onCancel={mockOnCancel}
        onCreate={mockOnCreate}
      />
    );

    const nameInput = screen.getByTestId('project-name-input');
    expect(document.activeElement).toBe(nameInput);
  });
});
