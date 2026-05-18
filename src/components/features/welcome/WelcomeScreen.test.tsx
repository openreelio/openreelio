import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WelcomeScreen, type RecentProject } from './WelcomeScreen';

const recentProjects: RecentProject[] = [
  {
    id: 'project-1',
    name: 'Launch Cut',
    path: '/projects/launch-cut',
    lastOpened: new Date().toISOString(),
  },
];

describe('WelcomeScreen', () => {
  it('should display the current version without release-stage copy', () => {
    render(<WelcomeScreen onOpenFolder={vi.fn()} version="1.2.3" />);

    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
    expect(screen.queryByText(/MVP/i)).not.toBeInTheDocument();
  });

  it('should open a folder from the primary action', async () => {
    const user = userEvent.setup();
    const onOpenFolder = vi.fn();

    render(<WelcomeScreen onOpenFolder={onOpenFolder} />);

    await user.click(screen.getByTestId('open-folder-button'));

    expect(onOpenFolder).toHaveBeenCalledWith();
  });

  it('should open a recent project by path', async () => {
    const user = userEvent.setup();
    const onOpenFolder = vi.fn();

    render(<WelcomeScreen onOpenFolder={onOpenFolder} recentProjects={recentProjects} />);

    await user.click(screen.getByTestId('recent-project-project-1'));

    expect(onOpenFolder).toHaveBeenCalledWith('/projects/launch-cut');
  });
});
