/**
 * Recent Projects Storage Utility
 *
 * Manages persistence of recently opened projects using localStorage.
 * Provides CRUD operations with automatic sorting by last opened date.
 */

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
  /** Optional thumbnail path */
  thumbnailPath?: string;
}

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY = 'openreelio:recent-projects';
const MAX_RECENT_PROJECTS = 10;

// =============================================================================
// Functions
// =============================================================================

/**
 * Load recent projects from storage
 * @returns Array of recent projects sorted by last opened (most recent first)
 */
export function loadRecentProjects(): RecentProject[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return [];
    }

    const projects = JSON.parse(stored) as unknown;

    // Validate the structure
    if (!Array.isArray(projects)) {
      console.warn('Invalid recent projects data, resetting');
      return [];
    }

    // Filter out invalid entries and sort by lastOpened
    const validProjects = projects
      .filter(isValidRecentProject)
      .sort((a, b) => new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime());

    return validProjects;
  } catch (error) {
    console.error('Failed to load recent projects:', error);
    return [];
  }
}

/**
 * Save recent projects to storage
 * @param projects Array of recent projects to save
 */
export function saveRecentProjects(projects: RecentProject[]): void {
  try {
    // Sort and limit before saving
    const sorted = [...projects]
      .sort((a, b) => new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime())
      .slice(0, MAX_RECENT_PROJECTS);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(sorted));
  } catch (error) {
    console.error('Failed to save recent projects:', error);
  }
}

/**
 * Add or update a project in the recent projects list
 * @param project Project to add or update
 * @returns Updated list of recent projects
 */
export function addRecentProject(project: Omit<RecentProject, 'id' | 'lastOpened'>): RecentProject[] {
  const projects = loadRecentProjects();

  // Check if project already exists (by path)
  const existingIndex = projects.findIndex((p) => p.path === project.path);

  const now = new Date().toISOString();
  const newProject: RecentProject = {
    id: existingIndex >= 0 ? projects[existingIndex].id : generateId(),
    name: project.name,
    path: project.path,
    lastOpened: now,
    thumbnailPath: project.thumbnailPath,
  };

  if (existingIndex >= 0) {
    // Remove existing and add to front (to maintain sort order after save)
    projects.splice(existingIndex, 1);
  }

  // Add new/updated project to front
  projects.unshift(newProject);

  // Sort by lastOpened (most recent first) and limit
  const sorted = projects
    .sort((a, b) => new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime())
    .slice(0, MAX_RECENT_PROJECTS);

  saveRecentProjects(sorted);
  return sorted;
}

/**
 * Remove a project from the recent projects list
 * @param projectId Project ID to remove
 * @returns Updated list of recent projects
 */
export function removeRecentProject(projectId: string): RecentProject[] {
  const projects = loadRecentProjects();
  const filtered = projects.filter((p) => p.id !== projectId);

  saveRecentProjects(filtered);
  return filtered;
}

/**
 * Remove a project by path from the recent projects list
 * @param path Project path to remove
 * @returns Updated list of recent projects
 */
export function removeRecentProjectByPath(path: string): RecentProject[] {
  const projects = loadRecentProjects();
  const filtered = projects.filter((p) => p.path !== path);

  saveRecentProjects(filtered);
  return filtered;
}

/**
 * Clear all recent projects
 */
export function clearRecentProjects(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear recent projects:', error);
  }
}

/**
 * Get a project by ID
 * @param projectId Project ID to find
 * @returns The project if found, undefined otherwise
 */
export function getRecentProjectById(projectId: string): RecentProject | undefined {
  const projects = loadRecentProjects();
  return projects.find((p) => p.id === projectId);
}

/**
 * Get a project by path
 * @param path Project path to find
 * @returns The project if found, undefined otherwise
 */
export function getRecentProjectByPath(path: string): RecentProject | undefined {
  const projects = loadRecentProjects();
  return projects.find((p) => p.path === path);
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Type guard for RecentProject
 */
function isValidRecentProject(value: unknown): value is RecentProject {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.path === 'string' &&
    typeof obj.lastOpened === 'string' &&
    (obj.thumbnailPath === undefined || typeof obj.thumbnailPath === 'string')
  );
}

/**
 * Generate a unique ID for a new project entry
 */
function generateId(): string {
  return `prj_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
