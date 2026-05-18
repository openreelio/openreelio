/**
 * WelcomeScreen Component
 *
 * Initial screen shown when no project is loaded.
 * Provides option to open a folder as a project or select from recent projects.
 */

import { useCallback, useMemo } from 'react';
import { ChevronRight, Clock, Film, FolderOpen, Loader2, Trash2 } from 'lucide-react';
import { APP_VERSION, formatAppVersion } from '@/config/appVersion';

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

/** Maximum number of recent projects to display in the UI */
const MAX_DISPLAY_PROJECTS = 5;

/** WelcomeScreen component props */
export interface WelcomeScreenProps {
  /** Callback when user wants to open a folder (optionally with path for recent projects) */
  onOpenFolder: (path?: string) => void;
  /** List of recently opened projects */
  recentProjects?: RecentProject[];
  /** Whether an operation is in progress */
  isLoading?: boolean;
  /** App version to display */
  version?: string;
  /** Callback when user wants to clear all recent projects */
  onClearRecentProjects?: () => void;
}

// =============================================================================
// Component
// =============================================================================

export function WelcomeScreen({
  onOpenFolder,
  recentProjects = [],
  isLoading = false,
  version = APP_VERSION,
  onClearRecentProjects,
}: WelcomeScreenProps): JSX.Element {
  // ===========================================================================
  // Memoized Values
  // ===========================================================================

  // Limit displayed projects to prevent UI overflow
  const displayedProjects = useMemo(
    () => recentProjects.slice(0, MAX_DISPLAY_PROJECTS),
    [recentProjects],
  );

  const hasMoreProjects = recentProjects.length > MAX_DISPLAY_PROJECTS;
  const versionLabel = formatAppVersion(version);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleOpenFolder = useCallback(() => {
    onOpenFolder();
  }, [onOpenFolder]);

  const handleRecentProjectClick = useCallback(
    (path: string) => {
      onOpenFolder(path);
    },
    [onOpenFolder],
  );

  const handleClearRecentProjects = useCallback(() => {
    onClearRecentProjects?.();
  }, [onClearRecentProjects]);

  // ===========================================================================
  // Helpers
  // ===========================================================================

  const formatLastOpened = (isoDate: string): string => {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return 'Unknown';

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
      className="min-h-full bg-editor-bg text-editor-text"
    >
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-5 sm:px-8 sm:py-7">
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary-600 text-white shadow-md shadow-black/30">
              <Film className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-editor-text">OpenReelio</p>
              <p className="text-xs text-editor-text-muted">Project Launcher</p>
            </div>
          </div>
          <p className="shrink-0 rounded border border-editor-border bg-editor-panel px-2.5 py-1 text-xs font-medium text-editor-text-muted">
            {versionLabel}
          </p>
        </header>

        <main className="grid flex-1 items-center gap-8 py-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(380px,1fr)]">
          <section className="min-w-0">
            <p className="mb-3 text-sm font-medium uppercase text-primary-400">Workspace</p>
            <h1 className="max-w-xl text-3xl font-semibold leading-tight text-editor-text sm:text-4xl">
              Select a project folder
            </h1>
            <p className="mt-4 max-w-lg text-sm leading-6 text-editor-text-muted sm:text-base">
              Open an existing OpenReelio workspace or choose a folder to initialize a new project.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                data-testid="open-folder-button"
                aria-label="Open a folder as project"
                disabled={isLoading}
                onClick={handleOpenFolder}
                className="inline-flex min-h-[3rem] w-full items-center justify-center gap-2 rounded-md bg-primary-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-black/25 transition-colors hover:bg-primary-500 disabled:cursor-not-allowed disabled:bg-primary-800 disabled:text-white/60 sm:w-auto"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <FolderOpen className="h-4 w-4" aria-hidden="true" />
                )}
                <span>{isLoading ? 'Opening...' : 'Open Folder'}</span>
              </button>
            </div>
          </section>

          <section
            data-testid="recent-projects-section"
            className="min-w-0 rounded-md border border-editor-border bg-editor-panel/80 shadow-2xl shadow-black/20"
            aria-label="Recent projects"
          >
            <div className="flex items-center justify-between gap-3 border-b border-editor-border px-4 py-3">
              <div className="flex min-w-0 items-center gap-2 text-editor-text-muted">
                <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
                <h2 className="truncate text-xs font-semibold uppercase">Recent Projects</h2>
              </div>
              {recentProjects.length > 0 && onClearRecentProjects && (
                <button
                  data-testid="clear-recent-projects-button"
                  type="button"
                  onClick={handleClearRecentProjects}
                  disabled={isLoading}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-editor-text-muted transition-colors hover:bg-editor-hover hover:text-status-error disabled:cursor-not-allowed disabled:opacity-50"
                  title="Clear recent projects"
                  aria-label="Clear recent projects"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>

            {recentProjects.length > 0 ? (
              <>
                <ul className="max-h-[22rem] overflow-y-auto p-2">
                  {displayedProjects.map((project) => (
                    <li key={project.id}>
                      <button
                        data-testid={`recent-project-${project.id}`}
                        type="button"
                        onClick={() => handleRecentProjectClick(project.path)}
                        disabled={isLoading}
                        className="group flex w-full items-center gap-3 rounded-md border border-transparent p-3 text-left transition-colors hover:border-editor-border hover:bg-editor-hover disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-editor-bg text-primary-400">
                          <FolderOpen className="h-5 w-5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <p
                            className="truncate text-sm font-medium text-editor-text"
                            title={project.name}
                          >
                            {project.name}
                          </p>
                          <p
                            className="truncate text-xs text-editor-text-muted"
                            title={project.path}
                          >
                            {project.path}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="hidden text-xs text-editor-text-muted sm:inline">
                            {formatLastOpened(project.lastOpened)}
                          </span>
                          <ChevronRight
                            className="h-4 w-4 text-editor-text-muted opacity-0 transition-opacity group-hover:opacity-100"
                            aria-hidden="true"
                          />
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>

                {hasMoreProjects && (
                  <p className="border-t border-editor-border px-4 py-3 text-center text-xs text-editor-text-muted">
                    Showing {MAX_DISPLAY_PROJECTS} of {recentProjects.length} projects
                  </p>
                )}
              </>
            ) : (
              <div className="flex min-h-[14rem] flex-col items-center justify-center px-6 py-10 text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-md bg-editor-bg text-editor-text-muted">
                  <FolderOpen className="h-6 w-6" aria-hidden="true" />
                </div>
                <p className="text-sm font-medium text-editor-text">No recent projects</p>
                <p className="mt-1 max-w-xs text-xs leading-5 text-editor-text-muted">
                  Open a folder to add it to this list.
                </p>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
