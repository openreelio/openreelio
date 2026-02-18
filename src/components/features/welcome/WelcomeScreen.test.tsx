/**
 * WelcomeScreen Component Tests
 *
 * Tests for the folder-based workspace welcome screen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WelcomeScreen } from './WelcomeScreen';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

describe('WelcomeScreen', () => {
  const mockOnOpenFolder = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  it('renders the welcome screen with logo and title', () => {
    render(
      <WelcomeScreen onOpenFolder={mockOnOpenFolder} />
    );

    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument();
    expect(screen.getByText('OpenReelio')).toBeInTheDocument();
    expect(screen.getByText(/AI-powered video editing/i)).toBeInTheDocument();
  });

  it('renders Open Folder button', () => {
    render(
      <WelcomeScreen onOpenFolder={mockOnOpenFolder} />
    );

    const openFolderBtn = screen.getByTestId('open-folder-button');
    expect(openFolderBtn).toBeInTheDocument();
    expect(openFolderBtn).toHaveTextContent(/open folder/i);
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  it('calls onOpenFolder when Open Folder button is clicked', () => {
    render(
      <WelcomeScreen onOpenFolder={mockOnOpenFolder} />
    );

    const openFolderBtn = screen.getByTestId('open-folder-button');
    fireEvent.click(openFolderBtn);

    expect(mockOnOpenFolder).toHaveBeenCalledTimes(1);
  });

  // ===========================================================================
  // Recent Projects Tests
  // ===========================================================================

  it('renders recent projects section when projects exist', () => {
    const recentProjects = [
      { id: '1', name: 'Project A', path: '/path/to/a', lastOpened: '2024-01-01' },
      { id: '2', name: 'Project B', path: '/path/to/b', lastOpened: '2024-01-02' },
    ];

    render(
      <WelcomeScreen
        onOpenFolder={mockOnOpenFolder}
        recentProjects={recentProjects}
      />
    );

    expect(screen.getByTestId('recent-projects-section')).toBeInTheDocument();
    expect(screen.getByText('Project A')).toBeInTheDocument();
    expect(screen.getByText('Project B')).toBeInTheDocument();
  });

  it('does not render recent projects section when empty', () => {
    render(
      <WelcomeScreen
        onOpenFolder={mockOnOpenFolder}
        recentProjects={[]}
      />
    );

    expect(screen.queryByTestId('recent-projects-section')).not.toBeInTheDocument();
  });

  it('calls onOpenFolder with path when recent project is clicked', () => {
    const recentProjects = [
      { id: '1', name: 'Project A', path: '/path/to/a', lastOpened: '2024-01-01' },
    ];

    render(
      <WelcomeScreen
        onOpenFolder={mockOnOpenFolder}
        recentProjects={recentProjects}
      />
    );

    const projectItem = screen.getByTestId('recent-project-1');
    fireEvent.click(projectItem);

    expect(mockOnOpenFolder).toHaveBeenCalledWith('/path/to/a');
  });

  // ===========================================================================
  // Loading State Tests
  // ===========================================================================

  it('disables button when loading', () => {
    render(
      <WelcomeScreen
        onOpenFolder={mockOnOpenFolder}
        isLoading={true}
      />
    );

    expect(screen.getByTestId('open-folder-button')).toBeDisabled();
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  it('has proper aria label for button', () => {
    render(
      <WelcomeScreen onOpenFolder={mockOnOpenFolder} />
    );

    expect(screen.getByTestId('open-folder-button')).toHaveAttribute('aria-label');
  });

  it('has proper role for main container', () => {
    render(
      <WelcomeScreen onOpenFolder={mockOnOpenFolder} />
    );

    expect(screen.getByTestId('welcome-screen')).toHaveAttribute('role', 'main');
  });
});
