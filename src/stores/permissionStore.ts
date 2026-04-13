/**
 * Permission Store
 *
 * Manages permission rules for the agentic engine.
 * Supports both legacy tool-name patterns (e.g., 'get_*', 'delete_*')
 * and canonical capability subjects (e.g., 'timeline.clip.delete').
 *
 * Resolution prefers higher-precedence scopes, then exact and more-specific
 * matches, then newer rules.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  buildPermissionSubject,
  getPermissionPatternSpecificity,
  isExactPermissionPatternMatch,
  matchLegacyPermissionPattern,
  matchPermissionPattern,
  toPermissionRulePattern,
  type PermissionSubject,
  type PermissionSubjectType,
} from '@/agents/engine/core/permissionSubject';
import type {
  PermissionDecision,
  PermissionDecisionSource,
} from '@/agents/engine/core/agentSession';

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

type PermissionRuleScope = PermissionRule['scope'] | 'builtin';

interface MatchablePermissionRule {
  id: string | null;
  pattern: string;
  permission: ToolPermission;
  scope: PermissionRuleScope;
}

export type PermissionPreset = 'restrictive' | 'balanced' | 'permissive';

export interface PermissionResolution {
  subjectType: PermissionSubjectType;
  subject: string;
  aliases: string[];
  permission: ToolPermission;
  matchedRuleId: string | null;
  matchedPattern: string | null;
  matchedScope: PermissionRule['scope'] | null;
  source: PermissionDecisionSource;
}

export interface PermissionStoreState {
  globalRules: PermissionRule[];
  sessionRules: PermissionRule[];
  hydratedSessionId: string | null;

  resolvePermission: (toolName: string, args?: Record<string, unknown>) => ToolPermission;
  resolvePermissionDetails: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => PermissionResolution;
  hasHydratedSessionRules: (sessionId: string) => boolean;
  hydrateSessionRulesFromPersistedDecisions: (
    sessionId: string,
    decisions: Array<Pick<PermissionDecision, 'id' | 'subject' | 'action' | 'createdAt'>>,
  ) => void;
  addRule: (pattern: string, permission: ToolPermission, scope: 'global' | 'session') => void;
  removeRule: (id: string) => void;
  allowAlways: (toolName: string, args?: Record<string, unknown>) => void;
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
  return matchLegacyPermissionPattern(pattern, toolName);
}

// =============================================================================
// Default Rules
// =============================================================================

const BALANCED_RULES: Omit<PermissionRule, 'id'>[] = [
  { pattern: '*', permission: 'ask', scope: 'global' },
  { pattern: 'get_*', permission: 'allow', scope: 'global' },
  { pattern: 'list_*', permission: 'allow', scope: 'global' },
  { pattern: 'find_*', permission: 'allow', scope: 'global' },
  { pattern: 'read_*', permission: 'allow', scope: 'global' },
  { pattern: 'analyze_*', permission: 'allow', scope: 'global' },
  { pattern: 'search_*', permission: 'allow', scope: 'global' },
  { pattern: 'inspect_*', permission: 'allow', scope: 'global' },
  { pattern: 'query_*', permission: 'allow', scope: 'global' },
];

const RESTRICTIVE_RULES: Omit<PermissionRule, 'id'>[] = [
  { pattern: '*', permission: 'ask', scope: 'global' },
  { pattern: 'get_*', permission: 'allow', scope: 'global' },
  { pattern: 'list_*', permission: 'allow', scope: 'global' },
  { pattern: 'read_*', permission: 'allow', scope: 'global' },
];

const PERMISSIVE_RULES: Omit<PermissionRule, 'id'>[] = [
  { pattern: '*', permission: 'allow', scope: 'global' },
  { pattern: 'delete_*', permission: 'ask', scope: 'global' },
  { pattern: 'remove_*', permission: 'ask', scope: 'global' },
];

const BUILTIN_RULES: readonly MatchablePermissionRule[] = [
  {
    id: null,
    pattern: 'workspace.**',
    permission: 'allow',
    scope: 'builtin',
  },
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

const PERMISSION_PRIORITY: Record<ToolPermission, number> = {
  allow: 1,
  ask: 2,
  deny: 3,
};

interface MatchedPermissionRule {
  rule: MatchablePermissionRule;
  scopeRank: number;
  insertionRank: number;
  specificity: number;
  exact: boolean;
}

function toResolution(
  subject: PermissionSubject,
  match: MatchedPermissionRule | null,
): PermissionResolution {
  const source: PermissionDecisionSource = match
    ? match.rule.scope === 'session'
      ? 'session_rule'
      : match.rule.scope === 'global'
        ? 'global_policy'
        : 'builtin'
    : 'builtin';

  return {
    subjectType: subject.subjectType,
    subject: subject.subject,
    aliases: subject.aliases,
    permission: match?.rule.permission ?? 'ask',
    matchedRuleId: match?.rule.id ?? null,
    matchedPattern: match?.rule.pattern ?? null,
    matchedScope: match && match.rule.scope !== 'builtin' ? match.rule.scope : null,
    source,
  };
}

function chooseBetterMatch(
  current: MatchedPermissionRule | null,
  candidate: MatchedPermissionRule,
): MatchedPermissionRule {
  if (!current) {
    return candidate;
  }

  if (candidate.scopeRank !== current.scopeRank) {
    return candidate.scopeRank > current.scopeRank ? candidate : current;
  }

  if (candidate.exact !== current.exact) {
    return candidate.exact ? candidate : current;
  }

  if (candidate.specificity !== current.specificity) {
    return candidate.specificity > current.specificity ? candidate : current;
  }

  if (candidate.insertionRank !== current.insertionRank) {
    return candidate.insertionRank > current.insertionRank ? candidate : current;
  }

  return PERMISSION_PRIORITY[candidate.rule.permission] >=
    PERMISSION_PRIORITY[current.rule.permission]
    ? candidate
    : current;
}

function resolveMatchingRule(
  globalRules: PermissionRule[],
  sessionRules: PermissionRule[],
  subject: PermissionSubject,
): MatchedPermissionRule | null {
  let bestMatch: MatchedPermissionRule | null = null;

  const ruleLayers: Array<{ rules: readonly MatchablePermissionRule[]; scopeRank: number }> = [
    { rules: globalRules, scopeRank: 1 },
    // Workspace tools are project-root scoped by construction:
    // frontend path validation rejects absolute/traversal paths and the Rust
    // backend re-validates the resolved target before mutating the filesystem.
    //
    // Keep builtin workspace rules at the same precedence tier as global rules
    // so explicit user rules can still override them, while the more specific
    // workspace pattern beats the default global "*" ask rule.
    { rules: BUILTIN_RULES, scopeRank: 1 },
    { rules: sessionRules, scopeRank: 2 },
  ];

  for (const layer of ruleLayers) {
    layer.rules.forEach((rule, index) => {
      if (!matchPermissionPattern(rule.pattern, subject)) {
        return;
      }

      bestMatch = chooseBetterMatch(bestMatch, {
        rule,
        scopeRank: layer.scopeRank,
        insertionRank: index,
        specificity: getPermissionPatternSpecificity(rule.pattern),
        exact: isExactPermissionPatternMatch(rule.pattern, subject),
      });
    });
  }

  return bestMatch;
}

function buildHydratedSessionRules(
  decisions: Array<Pick<PermissionDecision, 'id' | 'subject' | 'action' | 'createdAt'>>,
): PermissionRule[] {
  const latestAllowAlwaysBySubject = new Map<
    string,
    Pick<PermissionDecision, 'id' | 'subject' | 'action' | 'createdAt'>
  >();

  for (const decision of decisions) {
    if (decision.action !== 'allow_always') {
      continue;
    }

    const current = latestAllowAlwaysBySubject.get(decision.subject);
    if (!current || decision.createdAt >= current.createdAt) {
      latestAllowAlwaysBySubject.set(decision.subject, decision);
    }
  }

  return Array.from(latestAllowAlwaysBySubject.values())
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((decision) => ({
      id: decision.id,
      pattern: decision.subject,
      permission: 'allow' as const,
      scope: 'session' as const,
    }));
}

function mergeHydratedSessionRules(
  existing: PermissionRule[],
  hydrated: PermissionRule[],
): PermissionRule[] {
  const merged = [...existing];
  const existingKeys = new Set(
    existing.map((rule) => `${rule.pattern}:${rule.permission}:${rule.scope}`),
  );

  for (const rule of hydrated) {
    const key = `${rule.pattern}:${rule.permission}:${rule.scope}`;
    if (existingKeys.has(key)) {
      continue;
    }
    existingKeys.add(key);
    merged.push(rule);
  }

  return merged;
}

// =============================================================================
// Store
// =============================================================================

export const usePermissionStore = create<PermissionStoreState>()(
  persist(
    (set, get) => ({
      globalRules: createRules(BALANCED_RULES),
      sessionRules: [],
      hydratedSessionId: null,

      resolvePermission: (toolName: string, args: Record<string, unknown> = {}): ToolPermission => {
        return get().resolvePermissionDetails(toolName, args).permission;
      },

      resolvePermissionDetails: (
        toolName: string,
        args: Record<string, unknown> = {},
      ): PermissionResolution => {
        const { globalRules, sessionRules } = get();
        const subject = buildPermissionSubject(toolName, args);
        const bestMatch = resolveMatchingRule(globalRules, sessionRules, subject);
        return toResolution(subject, bestMatch);
      },

      hasHydratedSessionRules: (sessionId: string): boolean => {
        return get().hydratedSessionId === sessionId;
      },

      hydrateSessionRulesFromPersistedDecisions: (
        sessionId: string,
        decisions: Array<Pick<PermissionDecision, 'id' | 'subject' | 'action' | 'createdAt'>>,
      ) => {
        set((state) => {
          const hydratedRules = buildHydratedSessionRules(decisions);

          return {
            sessionRules:
              state.hydratedSessionId === sessionId
                ? mergeHydratedSessionRules(state.sessionRules, hydratedRules)
                : hydratedRules,
            hydratedSessionId: sessionId,
          };
        });
      },

      addRule: (pattern: string, permission: ToolPermission, scope: 'global' | 'session') => {
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

      allowAlways: (toolName: string, args: Record<string, unknown> = {}) => {
        const subject = buildPermissionSubject(toolName, args);
        const rule: PermissionRule = {
          id: crypto.randomUUID(),
          pattern: toPermissionRulePattern(subject),
          permission: 'allow',
          scope: 'session',
        };
        set((state) => ({
          sessionRules: [...state.sessionRules, rule],
        }));
      },

      resetSessionRules: () => {
        set({ sessionRules: [], hydratedSessionId: null });
      },

      loadDefaults: () => {
        set({
          globalRules: createRules(BALANCED_RULES),
          sessionRules: [],
          hydratedSessionId: null,
        });
      },

      setPreset: (preset: PermissionPreset) => {
        set({
          globalRules: createRules(getPresetRules(preset)),
          sessionRules: [],
          hydratedSessionId: null,
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
