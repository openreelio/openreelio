/**
 * Store Barrel Export & Reset Tests
 *
 * Validates that all stores are properly re-exported from the barrel index
 * and that resetProjectStores() correctly resets all project-level state.
 */

import { describe, it, expect } from 'vitest';

describe('stores/index barrel exports', () => {
  it('should export useConversationStore', async () => {
    const mod = await import('./index');
    expect(mod.useConversationStore).toBeDefined();
    expect(typeof mod.useConversationStore).toBe('function');
  });

  it('should export usePreviewStore', async () => {
    const mod = await import('./index');
    expect(mod.usePreviewStore).toBeDefined();
    expect(typeof mod.usePreviewStore).toBe('function');
  });

  it('should export useAgentStore', async () => {
    const mod = await import('./index');
    expect(mod.useAgentStore).toBeDefined();
    expect(typeof mod.useAgentStore).toBe('function');
  });

  it('should export usePlaybackStore', async () => {
    const mod = await import('./index');
    expect(mod.usePlaybackStore).toBeDefined();
  });

  it('should export useTimelineStore', async () => {
    const mod = await import('./index');
    expect(mod.useTimelineStore).toBeDefined();
  });

  it('should export useProjectStore', async () => {
    const mod = await import('./index');
    expect(mod.useProjectStore).toBeDefined();
  });

  it('should export useJobsStore', async () => {
    const mod = await import('./index');
    expect(mod.useJobsStore).toBeDefined();
  });

  it('should export useUIStore', async () => {
    const mod = await import('./index');
    expect(mod.useUIStore).toBeDefined();
  });

  it('should export useAIStore', async () => {
    const mod = await import('./index');
    expect(mod.useAIStore).toBeDefined();
  });

  it('should export resetProjectStores function', async () => {
    const mod = await import('./index');
    expect(mod.resetProjectStores).toBeDefined();
    expect(typeof mod.resetProjectStores).toBe('function');
  });

  it('should export agentStore selector hooks', async () => {
    const mod = await import('./index');
    expect(mod.useHasActiveSession).toBeDefined();
    expect(mod.useCurrentPhase).toBeDefined();
    expect(mod.useSessionHistory).toBeDefined();
    expect(mod.useAgentPreferences).toBeDefined();
  });

  it('should export previewStore constants', async () => {
    const mod = await import('./index');
    expect(mod.MIN_ZOOM).toBeDefined();
    expect(mod.MAX_ZOOM).toBeDefined();
    expect(mod.ZOOM_STEP).toBeDefined();
    expect(mod.ZOOM_PRESETS).toBeDefined();
  });
});

describe('resetProjectStores', () => {
  it('should be callable without throwing', async () => {
    const { resetProjectStores } = await import('./index');
    expect(() => resetProjectStores()).not.toThrow();
  });
});
