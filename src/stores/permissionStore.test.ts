/**
 * Permission Store Tests
 */

import { usePermissionStore, matchPattern } from './permissionStore';

beforeEach(() => {
  usePermissionStore.getState().loadDefaults();
});

describe('matchPattern', () => {
  it('should match wildcard *', () => {
    expect(matchPattern('*', 'anything')).toBe(true);
    expect(matchPattern('*', 'get_clip')).toBe(true);
  });

  it('should match prefix wildcard', () => {
    expect(matchPattern('get_*', 'get_clip')).toBe(true);
    expect(matchPattern('get_*', 'get_timeline')).toBe(true);
    expect(matchPattern('get_*', 'delete_clip')).toBe(false);
  });

  it('should match suffix wildcard', () => {
    expect(matchPattern('*_clip', 'get_clip')).toBe(true);
    expect(matchPattern('*_clip', 'delete_clip')).toBe(true);
    expect(matchPattern('*_clip', 'get_timeline')).toBe(false);
  });

  it('should match exact name', () => {
    expect(matchPattern('delete_clip', 'delete_clip')).toBe(true);
    expect(matchPattern('delete_clip', 'delete_clips')).toBe(false);
  });
});

describe('permissionStore', () => {
  it('should resolve read-only tools as allow by default (balanced preset)', () => {
    const store = usePermissionStore.getState();
    expect(store.resolvePermission('get_clip')).toBe('allow');
    expect(store.resolvePermission('list_tracks')).toBe('allow');
    expect(store.resolvePermission('find_clip')).toBe('allow');
    expect(store.resolvePermission('read_source_analysis_report')).toBe('allow');
    expect(store.resolvePermission('analyze_video')).toBe('allow');
    expect(store.resolvePermission('search_assets')).toBe('allow');
  });

  it('should resolve unknown tools as ask by default', () => {
    const store = usePermissionStore.getState();
    expect(store.resolvePermission('delete_clip')).toBe('ask');
    expect(store.resolvePermission('custom_tool')).toBe('ask');
  });

  it('should allow workspace reads but require approval for workspace mutations by default', () => {
    const store = usePermissionStore.getState();

    expect(store.resolvePermission('read_workspace_document')).toBe('allow');
    expect(
      store.resolvePermission('write_workspace_document', {
        relativePath: 'docs/ROADMAP.md',
      }),
    ).toBe('ask');
    expect(
      store.resolvePermission('delete_workspace_entry', {
        relativePath: 'docs/ROADMAP.md',
      }),
    ).toBe('ask');
  });

  it('should add global rules', () => {
    const store = usePermissionStore.getState();
    store.addRule('delete_*', 'deny', 'global');
    expect(usePermissionStore.getState().resolvePermission('delete_clip')).toBe('deny');
  });

  it('should add session rules that override global', () => {
    const store = usePermissionStore.getState();
    store.addRule('delete_*', 'deny', 'global');
    store.addRule('delete_clip', 'allow', 'session');
    expect(usePermissionStore.getState().resolvePermission('delete_clip')).toBe('allow');
    // Other delete_ tools are still denied
    expect(usePermissionStore.getState().resolvePermission('delete_track')).toBe('deny');
  });

  it('should let a newer exact rule win over a broader legacy rule in the same scope', () => {
    const store = usePermissionStore.getState();
    // Global: * = ask, then add allow for delete_*
    store.addRule('delete_*', 'allow', 'global');
    // Then deny delete_clip specifically
    store.addRule('delete_clip', 'deny', 'global');
    expect(usePermissionStore.getState().resolvePermission('delete_clip')).toBe('deny');
    expect(usePermissionStore.getState().resolvePermission('delete_track')).toBe('allow');
  });

  it('should prefer more specific canonical rules over newer broader rules in the same scope', () => {
    const store = usePermissionStore.getState();
    store.addRule('timeline.clip.*', 'allow', 'global');
    store.addRule('timeline.**', 'deny', 'global');

    expect(usePermissionStore.getState().resolvePermission('split_clip')).toBe('allow');
  });

  it('should resolve canonical workspace rules', () => {
    const store = usePermissionStore.getState();
    store.addRule('workspace.**', 'deny', 'global');

    expect(usePermissionStore.getState().resolvePermission('write_workspace_document')).toBe(
      'deny',
    );
    expect(usePermissionStore.getState().resolvePermission('read_workspace_document')).toBe('deny');
  });

  it('should expose workspace read policy details when no user rule overrides it', () => {
    const store = usePermissionStore.getState();
    usePermissionStore.setState({ globalRules: [] });

    const resolution = store.resolvePermissionDetails('read_workspace_document', {
      relativePath: 'docs/ROADMAP.md',
    });

    expect(resolution).toMatchObject({
      subjectType: 'resource',
      subject: 'workspace.document.read#path:docs/ROADMAP.md',
      permission: 'allow',
      matchedPattern: 'workspace.document.read',
      matchedScope: null,
      source: 'builtin',
    });
  });

  it('should not let workspace rules shadow media-analysis subjects', () => {
    const store = usePermissionStore.getState();
    store.addRule('workspace.**', 'deny', 'global');

    expect(
      usePermissionStore.getState().resolvePermission('analyze_workspace_video', {
        file: 'media/intro.mp4',
      }),
    ).toBe('allow');
  });

  it('should remove rules', () => {
    const store = usePermissionStore.getState();
    store.addRule('test_tool', 'deny', 'global');
    const rules = usePermissionStore.getState().globalRules;
    const testRule = rules.find((r) => r.pattern === 'test_tool');
    expect(testRule).toBeTruthy();

    usePermissionStore.getState().removeRule(testRule!.id);
    expect(usePermissionStore.getState().resolvePermission('test_tool')).toBe('ask');
  });

  it('should allowAlways (session scope)', () => {
    const store = usePermissionStore.getState();
    store.allowAlways('split_clip');
    expect(usePermissionStore.getState().resolvePermission('split_clip')).toBe('allow');
    expect(usePermissionStore.getState().sessionRules[0]?.pattern).toBe('timeline.clip.split');
  });

  it('should resolve canonical subject rules for matching tool calls', () => {
    const store = usePermissionStore.getState();
    store.addRule('timeline.clip.delete', 'deny', 'global');

    expect(
      usePermissionStore.getState().resolvePermission('delete_clip', { clipId: 'clip-7' }),
    ).toBe('deny');
    expect(
      usePermissionStore.getState().resolvePermission('split_clip', { clipId: 'clip-7' }),
    ).toBe('ask');
  });

  it('should resolve canonical rules for meta-tool actions', () => {
    const store = usePermissionStore.getState();
    store.addRule('timeline.clip.delete', 'deny', 'global');

    expect(
      usePermissionStore.getState().resolvePermission('edit', {
        action: 'delete_clip',
        clipId: 'clip-7',
      }),
    ).toBe('deny');
  });

  it('should expose normalized subject details for permission decisions', () => {
    const store = usePermissionStore.getState();
    store.addRule('timeline.clip.delete#clip:clip-1', 'deny', 'global');

    const resolution = usePermissionStore.getState().resolvePermissionDetails('delete_clip', {
      clipId: 'clip-1',
    });

    expect(resolution.subjectType).toBe('resource');
    expect(resolution.subject).toBe('timeline.clip.delete#clip:clip-1');
    expect(resolution.permission).toBe('deny');
    expect(resolution.matchedPattern).toBe('timeline.clip.delete#clip:clip-1');
  });

  it('should keep allowAlways scoped to the concrete canonical resource subject', () => {
    const store = usePermissionStore.getState();
    store.allowAlways('delete_clip', { clipId: 'clip-1' });

    expect(
      usePermissionStore.getState().resolvePermission('delete_clip', { clipId: 'clip-1' }),
    ).toBe('allow');
    expect(
      usePermissionStore.getState().resolvePermission('delete_clip', { clipId: 'clip-2' }),
    ).toBe('ask');
    expect(usePermissionStore.getState().sessionRules[0]?.pattern).toBe(
      'timeline.clip.delete#clip:clip-1',
    );
  });

  it('should scope workspace allowAlways rules to the concrete path binding', () => {
    const store = usePermissionStore.getState();
    store.addRule('workspace.**', 'deny', 'global');
    store.allowAlways('write_workspace_document', {
      relativePath: 'docs/ROADMAP.md',
    });

    expect(
      usePermissionStore.getState().resolvePermission('write_workspace_document', {
        relativePath: 'docs/ROADMAP.md',
      }),
    ).toBe('allow');
    expect(
      usePermissionStore.getState().resolvePermission('write_workspace_document', {
        relativePath: 'docs/ARCHITECTURE.md',
      }),
    ).toBe('deny');
    expect(usePermissionStore.getState().sessionRules[0]?.pattern).toBe(
      'workspace.document.write#path:docs/ROADMAP.md',
    );
  });

  it('should scope generation allowAlways rules to the concrete job binding', () => {
    const store = usePermissionStore.getState();
    store.allowAlways('cancel_generation', { jobId: 'job-1' });

    expect(
      usePermissionStore.getState().resolvePermission('cancel_generation', { jobId: 'job-1' }),
    ).toBe('allow');
    expect(
      usePermissionStore.getState().resolvePermission('cancel_generation', { jobId: 'job-2' }),
    ).toBe('ask');
    expect(usePermissionStore.getState().sessionRules[0]?.pattern).toBe(
      'external_provider.cancel#job:job-1',
    );
  });

  it('should merge hydrated allow_always decisions for the active session', () => {
    const store = usePermissionStore.getState();
    store.hydrateSessionRulesFromPersistedDecisions('session-1', [
      {
        id: 'decision-1',
        subject: 'timeline.clip.delete#clip:clip-1',
        action: 'allow_always',
        createdAt: 10,
      },
      {
        id: 'decision-2',
        subject: 'timeline.clip.trim',
        action: 'deny',
        createdAt: 11,
      },
    ]);
    store.hydrateSessionRulesFromPersistedDecisions('session-1', [
      {
        id: 'decision-3',
        subject: 'timeline.clip.split#clip:clip-2',
        action: 'allow_always',
        createdAt: 12,
      },
    ]);

    expect(usePermissionStore.getState().sessionRules).toEqual([
      {
        id: 'decision-1',
        pattern: 'timeline.clip.delete#clip:clip-1',
        permission: 'allow',
        scope: 'session',
      },
      {
        id: 'decision-3',
        pattern: 'timeline.clip.split#clip:clip-2',
        permission: 'allow',
        scope: 'session',
      },
    ]);
    expect(usePermissionStore.getState().hasHydratedSessionRules('session-1')).toBe(true);
  });

  it('should avoid duplicating hydrated rules that already exist in memory', () => {
    const store = usePermissionStore.getState();
    store.allowAlways('delete_clip', { clipId: 'clip-1' });
    store.hydrateSessionRulesFromPersistedDecisions('session-1', [
      {
        id: 'decision-1',
        subject: 'timeline.clip.delete#clip:clip-1',
        action: 'allow_always',
        createdAt: 10,
      },
    ]);

    expect(usePermissionStore.getState().sessionRules).toHaveLength(1);
  });

  it('should replace hydrated session rules when switching to a different session', () => {
    const store = usePermissionStore.getState();
    store.hydrateSessionRulesFromPersistedDecisions('session-1', [
      {
        id: 'decision-1',
        subject: 'timeline.clip.delete#clip:clip-1',
        action: 'allow_always',
        createdAt: 10,
      },
    ]);

    store.hydrateSessionRulesFromPersistedDecisions('session-2', []);

    expect(usePermissionStore.getState().sessionRules).toEqual([]);
    expect(usePermissionStore.getState().hasHydratedSessionRules('session-1')).toBe(false);
    expect(usePermissionStore.getState().hasHydratedSessionRules('session-2')).toBe(true);
  });

  it('should reset session rules', () => {
    const store = usePermissionStore.getState();
    store.allowAlways('split_clip');
    expect(usePermissionStore.getState().resolvePermission('split_clip')).toBe('allow');

    usePermissionStore.getState().resetSessionRules();
    // Falls back to global rules
    expect(usePermissionStore.getState().resolvePermission('split_clip')).toBe('ask');
  });

  it('should set restrictive preset', () => {
    usePermissionStore.getState().setPreset('restrictive');
    const store = usePermissionStore.getState();
    expect(store.resolvePermission('get_clip')).toBe('allow');
    expect(store.resolvePermission('analyze_video')).toBe('ask'); // Not in restrictive
    expect(store.resolvePermission('delete_clip')).toBe('ask');
  });

  it('should set permissive preset', () => {
    usePermissionStore.getState().setPreset('permissive');
    const store = usePermissionStore.getState();
    expect(store.resolvePermission('split_clip')).toBe('allow');
    expect(store.resolvePermission('delete_clip')).toBe('ask');
    expect(store.resolvePermission('remove_track')).toBe('ask');
  });

  it('should load defaults', () => {
    usePermissionStore.getState().setPreset('permissive');
    usePermissionStore.getState().loadDefaults();
    const store = usePermissionStore.getState();
    expect(store.resolvePermission('get_clip')).toBe('allow');
    expect(store.resolvePermission('split_clip')).toBe('ask');
  });

  it('should expose canonical resolution details for live permission decisions', () => {
    const store = usePermissionStore.getState();
    store.addRule('timeline.clip.delete', 'deny', 'global');

    const resolution = store.resolvePermissionDetails('delete_clip');
    expect(resolution).toMatchObject({
      subjectType: 'capability',
      subject: 'timeline.clip.delete',
      permission: 'deny',
      matchedRuleId: expect.any(String),
      matchedPattern: 'timeline.clip.delete',
      matchedScope: 'global',
      source: 'global_policy',
    });
    expect(resolution.aliases).toEqual(
      expect.arrayContaining(['timeline.clip.delete', 'delete_clip', 'tool.delete_clip']),
    );
  });
});
