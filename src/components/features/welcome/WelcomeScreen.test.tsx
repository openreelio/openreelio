/**
 * WelcomeScreen Component Tests
 *
 * TDD: RED phase - Write failing tests first
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
  const mockOnNewProject = vi.fn();
  const mockOnOpenProject = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  it('renders the welcome screen with logo and title', () => {
    render(
      <WelcomeScreen
        onNewProject={mockOnNewProject}
        onOpenProject={mockOnOpenProject}
      />
    );

    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument();
    expect(screen.getByText('OpenReelio')).toBeInTheDocument();
    expect(screen.getByText(/AI-powered video editing/i)).toBeInTheDocument();
  });

  it('renders New Project button', () => {
    render(
      <WelcomeScreen
        onNewProject={mockOnNewProject}
        onOpenProject={mockOnOpenProject}
      />
    );

    const newProjectBtn = screen.getByTestId('new-project-button');
    expect(newProjectBtn).toBeInTheDocument();
    expect(newProjectBtn).toHaveTextContent(/new project/i);
  });

  it('renders Open Project button', () => {
    render(
      <WelcomeScreen
        onNewProject={mockOnNewProject}
        onOpenProject={mockOnOpenProject}
      />
    );

    const openProjectBtn = screen.getByTestId('open-project-button');
    expect(openProjectBtn).toBeInTheDocument();
    expect(openProjectBtn).toHaveTextContent(/open project/i);
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  it('calls onNewProject when New Project button is clicked', () => {
    render(
      <WelcomeScreen
        onNewProject={mockOnNewProject}
        onOpenProject={mockOnOpenProject}
      />
    );

    const newProjectBtn = screen.getByTestId('new-project-button');
    fireEvent.click(newProjectBtn);

    expect(mockOnNewProject).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenProject when Open Project button is clicked', () => {
    render(
      <WelcomeScreen
        onNewProject={mockOnNewProject}
        onOpenProject={mockOnOpenProject}
      />
    );

    const openProjectBtn = screen.getByTestId('open-project-button');
    fireEvent.click(openProjectBtn);

    expect(mockOnOpenProject).toHaveBeenCalledTimes(1);
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
        onNewProject={mockOnNewProject}
        onOpenProject={mockOnOpenProject}
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
        onNewProject={mockOnNewProject}
        onOpenProject={mockOnOpenProject}
        recentProjects={[]}
      />
    );

    expect(screen.queryByTestId('recent-projects-section')).not.toBeInTheDocument();
  });

  it('calls onOpenProject with path when recent project is clicked', () => {
    const recentProjects = [
      { id: '1', name: 'Project A', path: '/path/to/a', lastOpened: '2024-01-01' },
    ];

    render(
      <WelcomeScreen
        onNewProject={mockOnNewProject}
        onOpenProject={mockOnOpenProject}
        recentProjects={recentProjects}
      />
    );

    const projectItem = screen.getByTestId('recent-project-1');
    fireEvent.click(projectItem);

    expect(mockOnOpenProject).toHaveBeenCalledWith('/path/to/a');
  });

  // ===========================================================================
  // Loading State Tests
  // ===========================================================================

  it('disables buttons when loading', () => {
    render(
      <WelcomeScreen
        onNewProject={mockOnNewProject}
        onOpenProject={mockOnOpenProject}
        isLoading={true}
      />
    );

    expect(screen.getByTestId('new-project-button')).toBeDisabled();
    expect(screen.getByTestId('open-project-button')).toBeDisabled();
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  it('has proper aria labels for buttons', () => {
    render(
      <WelcomeScreen
        onNewProject={mockOnNewProject}
        onOpenProject={mockOnOpenProject}
      />
    );

    expect(screen.getByTestId('new-project-button')).toHaveAttribute('aria-label');
    expect(screen.getByTestId('open-project-button')).toHaveAttribute('aria-label');
  });

  it('has proper role for main container', () => {
    render(
      <WelcomeScreen
        onNewProject={mockOnNewProject}
        onOpenProject={mockOnOpenProject}
      />
    );

    expect(screen.getByTestId('welcome-screen')).toHaveAttribute('role', 'main');
  });
});
