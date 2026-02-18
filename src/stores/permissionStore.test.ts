/**
 * Permission Store Tests
 */

import {
  usePermissionStore,
  matchPattern,
} from './permissionStore';

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
    expect(store.resolvePermission('analyze_video')).toBe('allow');
    expect(store.resolvePermission('search_assets')).toBe('allow');
  });

  it('should resolve unknown tools as ask by default', () => {
    const store = usePermissionStore.getState();
    expect(store.resolvePermission('delete_clip')).toBe('ask');
    expect(store.resolvePermission('custom_tool')).toBe('ask');
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

  it('should use last-match-wins resolution', () => {
    const store = usePermissionStore.getState();
    // Global: * = ask, then add allow for delete_*
    store.addRule('delete_*', 'allow', 'global');
    // Then deny delete_clip specifically
    store.addRule('delete_clip', 'deny', 'global');
    expect(usePermissionStore.getState().resolvePermission('delete_clip')).toBe('deny');
    expect(usePermissionStore.getState().resolvePermission('delete_track')).toBe('allow');
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
});
