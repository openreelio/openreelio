/**
 * WelcomeScreen Component
 *
 * Initial screen shown when no project is loaded.
 * Provides options to create new project or open existing one.
 */

import { useCallback } from 'react';
import { FolderOpen, Plus, Clock, Film } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

/** Recent project entry */
export interface RecentProject {
  /** Unique identifier */
  id: string;
  /** Project name */
  name: string;
  /** Project file path */
  path: string;
  /** ISO date string of last opened */
  lastOpened: string;
}

/** WelcomeScreen component props */
export interface WelcomeScreenProps {
  /** Callback when user wants to create new project */
  onNewProject: () => void;
  /** Callback when user wants to open a project (optionally with path) */
  onOpenProject: (path?: string) => void;
  /** List of recently opened projects */
  recentProjects?: RecentProject[];
  /** Whether an operation is in progress */
  isLoading?: boolean;
  /** App version to display */
  version?: string;
  /** Whether to show "Don't show again" checkbox */
  showDontShowOption?: boolean;
  /** Callback when user toggles "Don't show again" */
  onDontShowAgain?: (dontShow: boolean) => void;
}

// =============================================================================
// Component
// =============================================================================

export function WelcomeScreen({
  onNewProject,
  onOpenProject,
  recentProjects = [],
  isLoading = false,
  version = '0.1.0',
  showDontShowOption = false,
  onDontShowAgain,
}: WelcomeScreenProps): JSX.Element {
  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleNewProject = useCallback(() => {
    onNewProject();
  }, [onNewProject]);

  const handleOpenProject = useCallback(() => {
    onOpenProject();
  }, [onOpenProject]);

  const handleRecentProjectClick = useCallback(
    (path: string) => {
      onOpenProject(path);
    },
    [onOpenProject]
  );

  // ===========================================================================
  // Helpers
  // ===========================================================================

  const formatLastOpened = (isoDate: string): string => {
    const date = new Date(isoDate);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    return date.toLocaleDateString();
  };

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="welcome-screen"
      role="main"
      className="flex flex-col items-center justify-center min-h-full bg-editor-bg text-editor-text p-4 sm:p-8"
    >
      {/* Logo and Title */}
      <div className="text-center mb-8 sm:mb-12">
        <div className="w-20 h-20 sm:w-24 sm:h-24 mx-auto mb-4 sm:mb-6 bg-primary-600 rounded-2xl flex items-center justify-center shadow-lg">
          <Film className="w-10 h-10 sm:w-12 sm:h-12 text-white" />
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold text-editor-text mb-2">OpenReelio</h1>
        <p className="text-editor-text-muted text-base sm:text-lg">
          AI-powered video editing IDE
        </p>
      </div>

      {/* Action Buttons */}
      <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 mb-8 sm:mb-12 w-full sm:w-auto px-4 sm:px-0">
        <button
          data-testid="new-project-button"
          aria-label="Create a new project"
          disabled={isLoading}
          onClick={handleNewProject}
          className="flex items-center justify-center gap-3 px-6 py-4 bg-primary-600 hover:bg-primary-700 disabled:bg-primary-800 disabled:cursor-not-allowed text-white rounded-lg transition-colors shadow-md"
        >
          <Plus className="w-5 h-5" />
          <span className="font-medium">New Project</span>
        </button>

        <button
          data-testid="open-project-button"
          aria-label="Open an existing project"
          disabled={isLoading}
          onClick={handleOpenProject}
          className="flex items-center justify-center gap-3 px-6 py-4 bg-editor-panel hover:bg-editor-sidebar border border-editor-border text-editor-text rounded-lg transition-colors shadow-md"
        >
          <FolderOpen className="w-5 h-5" />
          <span className="font-medium">Open Project</span>
        </button>
      </div>

      {/* Recent Projects */}
      {recentProjects.length > 0 && (
        <div
          data-testid="recent-projects-section"
          className="w-full max-w-md px-4 sm:px-0"
        >
          <div className="flex items-center gap-2 mb-4 text-editor-text-muted">
            <Clock className="w-4 h-4 flex-shrink-0" />
            <h2 className="text-sm font-medium uppercase tracking-wide">
              Recent Projects
            </h2>
          </div>

          <ul className="space-y-2">
            {recentProjects.map((project) => (
              <li key={project.id}>
                <button
                  data-testid={`recent-project-${project.id}`}
                  onClick={() => handleRecentProjectClick(project.path)}
                  disabled={isLoading}
                  className="w-full flex items-center gap-3 p-3 bg-editor-panel hover:bg-editor-sidebar border border-editor-border rounded-lg transition-colors text-left disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="w-10 h-10 bg-editor-bg rounded flex items-center justify-center flex-shrink-0">
                    <Film className="w-5 h-5 text-primary-500" />
                  </div>
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <p className="font-medium text-editor-text truncate" title={project.name}>
                      {project.name}
                    </p>
                    <p className="text-xs text-editor-text-muted truncate" title={project.path}>
                      {project.path}
                    </p>
                  </div>
                  <span className="text-xs text-editor-text-muted flex-shrink-0 whitespace-nowrap">
                    {formatLastOpened(project.lastOpened)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Don't Show Again Option */}
      {showDontShowOption && (
        <label className="mt-8 flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            onChange={(e) => onDontShowAgain?.(e.target.checked)}
            className="w-4 h-4 rounded border-editor-border bg-editor-bg text-primary-500 focus:ring-primary-500/50 focus:ring-offset-0"
          />
          <span className="text-sm text-editor-text-muted">
            Don&apos;t show this on startup
          </span>
        </label>
      )}

      {/* Version Info */}
      <p className="mt-8 text-xs text-editor-text-muted">
        Version {version} (MVP)
      </p>
    </div>
  );
}
