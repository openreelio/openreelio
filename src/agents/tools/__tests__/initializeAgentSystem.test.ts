/**
 * Integration test: Verify agent tool initialization at app bootstrap.
 *
 * Tests that initializeAgentSystem() registers all expected tool categories
 * and that the global registry has the correct number of tools available.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { globalToolRegistry } from '@/agents';
import { initializeAgentSystem } from '@/stores/aiStore';
import { hasCompoundExpander } from '@/agents/engine/adapters/tools/BackendToolExecutor';

describe('initializeAgentSystem', () => {
  beforeAll(() => {
    initializeAgentSystem();
  });

  it('should register all 56+ tools after initialization', () => {
    const tools = globalToolRegistry.listAll();
    expect(tools.length).toBeGreaterThanOrEqual(56);
  });

  it('should be idempotent — calling again does not change tool count', () => {
    const countBefore = globalToolRegistry.listAll().length;
    initializeAgentSystem();
    const countAfter = globalToolRegistry.listAll().length;
    expect(countAfter).toBe(countBefore);
  });

  it('should register tools from all expected categories', () => {
    const toolNames = globalToolRegistry.listAll().map((t) => t.name);

    // Editing tools
    expect(toolNames).toContain('split_clip');
    expect(toolNames).toContain('insert_clip');
    expect(toolNames).toContain('move_clip');

    // Analysis tools
    expect(toolNames).toContain('get_timeline_info');
    expect(toolNames).toContain('get_playhead_position');

    // Audio tools
    expect(toolNames).toContain('adjust_volume');

    // Caption tools
    expect(toolNames).toContain('add_caption');

    // Effect tools
    expect(toolNames).toContain('add_effect');

    // Transition tools
    expect(toolNames).toContain('add_transition');
  });

  it('should register default backend compound expanders', () => {
    expect(hasCompoundExpander('ripple_edit')).toBe(true);
    expect(hasCompoundExpander('roll_edit')).toBe(true);
    expect(hasCompoundExpander('slip_edit')).toBe(true);
    expect(hasCompoundExpander('slide_edit')).toBe(true);
  });
});
