import { describe, expect, it } from 'vitest';
import { requiresProjectMutationPreflight } from './toolSemantics';

describe('toolSemantics', () => {
  it('requires project mutation preflight for timeline-changing generation actions', () => {
    expect(
      requiresProjectMutationPreflight('generate', 'generation', {
        action: 'generate_timeline_media',
        sequenceId: 'seq-1',
        trackId: 'track-1',
      }),
    ).toBe(true);

    expect(
      requiresProjectMutationPreflight('generate', 'generation', {
        action: 'resolve_generation_job',
        jobId: 'job-1',
        sequenceId: 'seq-1',
        trackId: 'track-1',
        placeWhenComplete: true,
      }),
    ).toBe(true);

    expect(
      requiresProjectMutationPreflight('generate_video', 'generation', {
        prompt: 'Create a skyline shot',
        placement: { sequenceId: 'seq-1', trackId: 'track-1', timelineStart: 0 },
      }),
    ).toBe(true);
  });

  it('does not require project mutation preflight for read-only or import-only generation actions', () => {
    expect(
      requiresProjectMutationPreflight('generate', 'generation', {
        action: 'generate_timeline_media',
        placementMode: 'import_only',
      }),
    ).toBe(false);

    expect(
      requiresProjectMutationPreflight('generate', 'generation', {
        action: 'resolve_generation_job',
        jobId: 'job-1',
      }),
    ).toBe(false);

    expect(
      requiresProjectMutationPreflight('generate', 'generation', {
        action: 'search_sound_for_scene',
        sceneDescription: 'door slam',
      }),
    ).toBe(false);
  });
});
