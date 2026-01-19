/**
 * Recent Projects Utility Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadRecentProjects,
  saveRecentProjects,
  addRecentProject,
  removeRecentProject,
  removeRecentProjectByPath,
  clearRecentProjects,
  getRecentProjectById,
  getRecentProjectByPath,
  type RecentProject,
} from './recentProjects';

// Mock the logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// Mock localStorage
// =============================================================================

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

// =============================================================================
// Test Data
// =============================================================================

const mockProject1: RecentProject = {
  id: 'prj_1',
  name: 'Project 1',
  path: '/path/to/project1',
  lastOpened: '2024-01-15T10:00:00Z',
};

const mockProject2: RecentProject = {
  id: 'prj_2',
  name: 'Project 2',
  path: '/path/to/project2',
  lastOpened: '2024-01-16T10:00:00Z',
};

const mockProject3: RecentProject = {
  id: 'prj_3',
  name: 'Project 3',
  path: '/path/to/project3',
  lastOpened: '2024-01-14T10:00:00Z',
};

// =============================================================================
// Tests
// =============================================================================

describe('recentProjects', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  // ===========================================================================
  // loadRecentProjects Tests
  // ===========================================================================

  describe('loadRecentProjects', () => {
    it('returns empty array when no data exists', () => {
      const projects = loadRecentProjects();
      expect(projects).toEqual([]);
    });

    it('loads and sorts projects by lastOpened', () => {
      localStorageMock.setItem(
        'openreelio:recent-projects',
        JSON.stringify([mockProject1, mockProject2, mockProject3])
      );

      const projects = loadRecentProjects();

      expect(projects).toHaveLength(3);
      expect(projects[0].id).toBe('prj_2'); // Most recent
      expect(projects[1].id).toBe('prj_1');
      expect(projects[2].id).toBe('prj_3'); // Oldest
    });

    it('handles invalid JSON gracefully', () => {
      localStorageMock.setItem('openreelio:recent-projects', 'invalid json');

      // The function should handle invalid JSON and return empty array
      const projects = loadRecentProjects();

      expect(projects).toEqual([]);
    });

    it('filters out invalid project entries', () => {
      localStorageMock.setItem(
        'openreelio:recent-projects',
        JSON.stringify([
          mockProject1,
          { invalid: 'data' },
          mockProject2,
          null,
        ])
      );

      const projects = loadRecentProjects();

      expect(projects).toHaveLength(2);
    });
  });

  // ===========================================================================
  // saveRecentProjects Tests
  // ===========================================================================

  describe('saveRecentProjects', () => {
    it('saves projects to localStorage', () => {
      saveRecentProjects([mockProject1, mockProject2]);

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'openreelio:recent-projects',
        expect.any(String)
      );
    });

    it('limits saved projects to 10', () => {
      const manyProjects = Array.from({ length: 15 }, (_, i) => ({
        id: `prj_${i}`,
        name: `Project ${i}`,
        path: `/path/to/project${i}`,
        lastOpened: new Date(Date.now() - i * 1000).toISOString(),
      }));

      saveRecentProjects(manyProjects);

      const saved = JSON.parse(
        localStorageMock.getItem('openreelio:recent-projects') ?? '[]'
      );
      expect(saved).toHaveLength(10);
    });
  });

  // ===========================================================================
  // addRecentProject Tests
  // ===========================================================================

  describe('addRecentProject', () => {
    it('adds a new project', () => {
      const projects = addRecentProject({
        name: 'New Project',
        path: '/path/to/new-project',
      });

      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('New Project');
      expect(projects[0].path).toBe('/path/to/new-project');
      expect(projects[0].id).toMatch(/^prj_/);
    });

    it('updates existing project by path', () => {
      localStorageMock.setItem(
        'openreelio:recent-projects',
        JSON.stringify([mockProject1])
      );

      const projects = addRecentProject({
        name: 'Updated Name',
        path: mockProject1.path,
      });

      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('Updated Name');
      expect(projects[0].id).toBe(mockProject1.id); // Same ID
    });

    it('moves existing project to top when re-opened', () => {
      // mockProject2 has newer lastOpened so it will be first after sorting
      // mockProject1 has older lastOpened
      localStorageMock.setItem(
        'openreelio:recent-projects',
        JSON.stringify([mockProject2, mockProject1])
      );

      // Re-open mockProject1 - this should update its lastOpened to now
      const projects = addRecentProject({
        name: mockProject1.name,
        path: mockProject1.path,
      });

      // Now mockProject1 should be first because its lastOpened is updated to now
      expect(projects[0].path).toBe(mockProject1.path);
      // And its lastOpened should be recent (not the old date)
      expect(new Date(projects[0].lastOpened).getTime()).toBeGreaterThan(
        new Date(mockProject2.lastOpened).getTime()
      );
    });
  });

  // ===========================================================================
  // removeRecentProject Tests
  // ===========================================================================

  describe('removeRecentProject', () => {
    it('removes project by ID', () => {
      localStorageMock.setItem(
        'openreelio:recent-projects',
        JSON.stringify([mockProject1, mockProject2])
      );

      const projects = removeRecentProject(mockProject1.id);

      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(mockProject2.id);
    });

    it('returns unchanged list if ID not found', () => {
      localStorageMock.setItem(
        'openreelio:recent-projects',
        JSON.stringify([mockProject1])
      );

      const projects = removeRecentProject('nonexistent');

      expect(projects).toHaveLength(1);
    });
  });

  // ===========================================================================
  // removeRecentProjectByPath Tests
  // ===========================================================================

  describe('removeRecentProjectByPath', () => {
    it('removes project by path', () => {
      localStorageMock.setItem(
        'openreelio:recent-projects',
        JSON.stringify([mockProject1, mockProject2])
      );

      const projects = removeRecentProjectByPath(mockProject1.path);

      expect(projects).toHaveLength(1);
      expect(projects[0].path).toBe(mockProject2.path);
    });
  });

  // ===========================================================================
  // clearRecentProjects Tests
  // ===========================================================================

  describe('clearRecentProjects', () => {
    it('clears all recent projects', () => {
      localStorageMock.setItem(
        'openreelio:recent-projects',
        JSON.stringify([mockProject1])
      );

      clearRecentProjects();

      expect(localStorageMock.removeItem).toHaveBeenCalledWith(
        'openreelio:recent-projects'
      );
    });
  });

  // ===========================================================================
  // getRecentProjectById Tests
  // ===========================================================================

  describe('getRecentProjectById', () => {
    it('returns project by ID', () => {
      localStorageMock.setItem(
        'openreelio:recent-projects',
        JSON.stringify([mockProject1, mockProject2])
      );

      const project = getRecentProjectById(mockProject1.id);

      expect(project).toBeDefined();
      expect(project?.name).toBe(mockProject1.name);
    });

    it('returns undefined if not found', () => {
      const project = getRecentProjectById('nonexistent');
      expect(project).toBeUndefined();
    });
  });

  // ===========================================================================
  // getRecentProjectByPath Tests
  // ===========================================================================

  describe('getRecentProjectByPath', () => {
    it('returns project by path', () => {
      localStorageMock.setItem(
        'openreelio:recent-projects',
        JSON.stringify([mockProject1, mockProject2])
      );

      const project = getRecentProjectByPath(mockProject1.path);

      expect(project).toBeDefined();
      expect(project?.id).toBe(mockProject1.id);
    });

    it('returns undefined if not found', () => {
      const project = getRecentProjectByPath('/nonexistent/path');
      expect(project).toBeUndefined();
    });
  });
});
