import { describe, expect, it } from 'vitest';
import {
  SessionGuard,
  SessionMismatchError,
  InvalidPhaseTransitionError,
} from './sessionGuard';

describe('SessionGuard', () => {
  // ===========================================================================
  // Project ID validation
  // ===========================================================================

  describe('validateProjectId', () => {
    it('should pass when project ID matches', () => {
      const guard = new SessionGuard('session-1', 'project-1', () => 'project-1');
      expect(() => guard.validateProjectId()).not.toThrow();
    });

    it('should pass when provider returns undefined (no active project)', () => {
      const guard = new SessionGuard('session-1', 'project-1', () => undefined);
      expect(() => guard.validateProjectId()).not.toThrow();
    });

    it('should throw SessionMismatchError when project ID changes', () => {
      const guard = new SessionGuard('session-1', 'project-1', () => 'project-2');
      expect(() => guard.validateProjectId()).toThrow(SessionMismatchError);
    });

    it('should include both project IDs in error message', () => {
      const guard = new SessionGuard('session-1', 'project-1', () => 'project-2');
      try {
        guard.validateProjectId();
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as SessionMismatchError;
        expect(err.expectedProjectId).toBe('project-1');
        expect(err.actualProjectId).toBe('project-2');
        expect(err.message).toContain('project-1');
        expect(err.message).toContain('project-2');
      }
    });
  });

  // ===========================================================================
  // Phase transition validation
  // ===========================================================================

  describe('transition', () => {
    it('should allow valid TPAO sequence', () => {
      const guard = new SessionGuard('s1', 'p1', () => 'p1');

      expect(() => guard.transition('thinking')).not.toThrow();
      expect(guard.getPhase()).toBe('thinking');

      expect(() => guard.transition('planning')).not.toThrow();
      expect(guard.getPhase()).toBe('planning');

      expect(() => guard.transition('executing')).not.toThrow();
      expect(guard.getPhase()).toBe('executing');

      expect(() => guard.transition('observing')).not.toThrow();
      expect(guard.getPhase()).toBe('observing');

      // Back to thinking (multi-iteration)
      expect(() => guard.transition('thinking')).not.toThrow();
      expect(guard.getPhase()).toBe('thinking');

      expect(() => guard.transition('completed')).not.toThrow();
      expect(guard.getPhase()).toBe('completed');
    });

    it('should allow abort from any active phase', () => {
      const phases = ['thinking', 'planning', 'awaiting_approval', 'executing', 'observing'] as const;

      for (const phase of phases) {
        const guard = new SessionGuard('s1', 'p1', () => 'p1');
        guard.transition('thinking');
        if (phase !== 'thinking') {
          // Get to the right phase
          if (phase === 'planning' || phase === 'awaiting_approval' || phase === 'executing' || phase === 'observing') {
            guard.transition('planning');
          }
          if (phase === 'awaiting_approval') {
            guard.transition('awaiting_approval');
          }
          if (phase === 'executing') {
            guard.transition('executing');
          }
          if (phase === 'observing') {
            guard.transition('executing');
            guard.transition('observing');
          }
        }
        expect(() => guard.transition('aborted')).not.toThrow();
      }
    });

    it('should reject idle → executing (skipping think/plan)', () => {
      const guard = new SessionGuard('s1', 'p1', () => 'p1');
      expect(() => guard.transition('executing')).toThrow(InvalidPhaseTransitionError);
    });

    it('should reject idle → observing', () => {
      const guard = new SessionGuard('s1', 'p1', () => 'p1');
      expect(() => guard.transition('observing')).toThrow(InvalidPhaseTransitionError);
    });

    it('should reject thinking → executing (skipping plan)', () => {
      const guard = new SessionGuard('s1', 'p1', () => 'p1');
      guard.transition('thinking');
      expect(() => guard.transition('executing')).toThrow(InvalidPhaseTransitionError);
    });

    it('should include from and to phases in error', () => {
      const guard = new SessionGuard('s1', 'p1', () => 'p1');
      try {
        guard.transition('executing');
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as InvalidPhaseTransitionError;
        expect(err.from).toBe('idle');
        expect(err.to).toBe('executing');
      }
    });

    it('should allow planning → awaiting_approval → executing', () => {
      const guard = new SessionGuard('s1', 'p1', () => 'p1');
      guard.transition('thinking');
      guard.transition('planning');
      guard.transition('awaiting_approval');
      expect(() => guard.transition('executing')).not.toThrow();
    });

    it('should allow completed → idle for reset', () => {
      const guard = new SessionGuard('s1', 'p1', () => 'p1');
      guard.transition('thinking');
      guard.transition('completed');
      expect(() => guard.transition('idle')).not.toThrow();
    });
  });

  // ===========================================================================
  // guardPhase (combined)
  // ===========================================================================

  describe('guardPhase', () => {
    it('should validate project and transition in one call', () => {
      const guard = new SessionGuard('s1', 'p1', () => 'p1');
      expect(() => guard.guardPhase('thinking')).not.toThrow();
      expect(guard.getPhase()).toBe('thinking');
    });

    it('should throw SessionMismatchError before checking transition', () => {
      const guard = new SessionGuard('s1', 'p1', () => 'p2');
      expect(() => guard.guardPhase('thinking')).toThrow(SessionMismatchError);
      // Phase should NOT have changed
      expect(guard.getPhase()).toBe('idle');
    });
  });

  // ===========================================================================
  // Reset
  // ===========================================================================

  describe('reset', () => {
    it('should reset phase to idle', () => {
      const guard = new SessionGuard('s1', 'p1', () => 'p1');
      guard.transition('thinking');
      guard.transition('planning');
      guard.reset();
      expect(guard.getPhase()).toBe('idle');
    });
  });

  // ===========================================================================
  // Accessors
  // ===========================================================================

  describe('getSessionId', () => {
    it('should return the session ID', () => {
      const guard = new SessionGuard('session-42', 'p1', () => 'p1');
      expect(guard.getSessionId()).toBe('session-42');
    });
  });
});
