/**
 * Permission Store
 *
 * Manages per-tool permission rules for the agentic engine.
 * Supports wildcard pattern matching (e.g., 'get_*', 'delete_*')
 * with session and global scopes.
 *
 * Resolution: last-match-wins across [...globalRules, ...sessionRules].
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// =============================================================================
// Types
// =============================================================================

export type ToolPermission = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  id: string;
  pattern: string;
  permission: ToolPermission;
  scope: 'global' | 'session';
}

export type PermissionPreset = 'restrictive' | 'balanced' | 'permissive';

export interface PermissionStoreState {
  globalRules: PermissionRule[];
  sessionRules: PermissionRule[];

  resolvePermission: (toolName: string) => ToolPermission;
  addRule: (
    pattern: string,
    permission: ToolPermission,
    scope: 'global' | 'session',
  ) => void;
  removeRule: (id: string) => void;
  allowAlways: (toolName: string) => void;
  resetSessionRules: () => void;
  loadDefaults: () => void;
  setPreset: (preset: PermissionPreset) => void;
}

// =============================================================================
// Pattern Matching
// =============================================================================

/**
 * Match a tool name against a wildcard pattern.
 * Supports simple glob: '*' matches any characters.
 * 'get_*' matches 'get_clip', 'get_timeline', etc.
 */
export function matchPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;

  // Convert glob pattern to regex
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = `^${escaped.replace(/\*/g, '.*')}$`;
  try {
    return new RegExp(regexStr).test(toolName);
  } catch {
    return pattern === toolName;
  }
}

// =============================================================================
// Default Rules
// =============================================================================

const BALANCED_RULES: Omit<PermissionRule, 'id'>[] = [
  { pattern: '*', permission: 'ask', scope: 'global' },
  { pattern: 'get_*', permission: 'allow', scope: 'global' },
  { pattern: 'list_*', permission: 'allow', scope: 'global' },
  { pattern: 'find_*', permission: 'allow', scope: 'global' },
  { pattern: 'analyze_*', permission: 'allow', scope: 'global' },
  { pattern: 'search_*', permission: 'allow', scope: 'global' },
  { pattern: 'inspect_*', permission: 'allow', scope: 'global' },
  { pattern: 'query_*', permission: 'allow', scope: 'global' },
];

const RESTRICTIVE_RULES: Omit<PermissionRule, 'id'>[] = [
  { pattern: '*', permission: 'ask', scope: 'global' },
  { pattern: 'get_*', permission: 'allow', scope: 'global' },
  { pattern: 'list_*', permission: 'allow', scope: 'global' },
];

const PERMISSIVE_RULES: Omit<PermissionRule, 'id'>[] = [
  { pattern: '*', permission: 'allow', scope: 'global' },
  { pattern: 'delete_*', permission: 'ask', scope: 'global' },
  { pattern: 'remove_*', permission: 'ask', scope: 'global' },
];

function createRules(templates: Omit<PermissionRule, 'id'>[]): PermissionRule[] {
  return templates.map((t) => ({
    ...t,
    id: crypto.randomUUID(),
  }));
}

function getPresetRules(preset: PermissionPreset): Omit<PermissionRule, 'id'>[] {
  switch (preset) {
    case 'restrictive':
      return RESTRICTIVE_RULES;
    case 'permissive':
      return PERMISSIVE_RULES;
    case 'balanced':
    default:
      return BALANCED_RULES;
  }
}

// =============================================================================
// Store
// =============================================================================

export const usePermissionStore = create<PermissionStoreState>()(
  persist(
    (set, get) => ({
      globalRules: createRules(BALANCED_RULES),
      sessionRules: [],

      resolvePermission: (toolName: string): ToolPermission => {
        const { globalRules, sessionRules } = get();
        const allRules = [...globalRules, ...sessionRules];

        // Last-match-wins
        let result: ToolPermission = 'ask';
        for (const rule of allRules) {
          if (matchPattern(rule.pattern, toolName)) {
            result = rule.permission;
          }
        }
        return result;
      },

      addRule: (
        pattern: string,
        permission: ToolPermission,
        scope: 'global' | 'session',
      ) => {
        const rule: PermissionRule = {
          id: crypto.randomUUID(),
          pattern,
          permission,
          scope,
        };

        set((state) => {
          if (scope === 'global') {
            return { globalRules: [...state.globalRules, rule] };
          }
          return { sessionRules: [...state.sessionRules, rule] };
        });
      },

      removeRule: (id: string) => {
        set((state) => ({
          globalRules: state.globalRules.filter((r) => r.id !== id),
          sessionRules: state.sessionRules.filter((r) => r.id !== id),
        }));
      },

      allowAlways: (toolName: string) => {
        const rule: PermissionRule = {
          id: crypto.randomUUID(),
          pattern: toolName,
          permission: 'allow',
          scope: 'session',
        };
        set((state) => ({
          sessionRules: [...state.sessionRules, rule],
        }));
      },

      resetSessionRules: () => {
        set({ sessionRules: [] });
      },

      loadDefaults: () => {
        set({
          globalRules: createRules(BALANCED_RULES),
          sessionRules: [],
        });
      },

      setPreset: (preset: PermissionPreset) => {
        set({
          globalRules: createRules(getPresetRules(preset)),
          sessionRules: [],
        });
      },
    }),
    {
      name: 'openreelio_permissions',
      partialize: (state) => ({
        globalRules: state.globalRules,
        // Session rules are NOT persisted
      }),
    },
  ),
);
