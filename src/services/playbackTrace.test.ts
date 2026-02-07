import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetPlaybackTraceForTesting,
  clearPlaybackTrace,
  getPlaybackTrace,
  recordPlaybackTrace,
} from './playbackTrace';

describe('playbackTrace', () => {
  beforeEach(() => {
    _resetPlaybackTraceForTesting();
  });

  it('records trace entries with sequence ordering', () => {
    recordPlaybackTrace('seek', 'test-seek', 1, 2, false);
    recordPlaybackTrace('time-update', 'engine-tick', 2, 2.1, true);

    const traces = getPlaybackTrace();
    expect(traces).toHaveLength(2);
    expect(traces[0].seq).toBe(1);
    expect(traces[1].seq).toBe(2);
    expect(traces[0].source).toBe('test-seek');
    expect(traces[1].source).toBe('engine-tick');
  });

  it('keeps only the latest 200 entries', () => {
    for (let index = 0; index < 210; index++) {
      recordPlaybackTrace('seek', `src-${index}`, index, index + 1, false);
    }

    const traces = getPlaybackTrace();
    expect(traces).toHaveLength(200);
    expect(traces[0].source).toBe('src-10');
    expect(traces[199].source).toBe('src-209');
  });

  it('clears trace entries', () => {
    recordPlaybackTrace('seek', 'to-clear', 0, 1, false);
    expect(getPlaybackTrace()).toHaveLength(1);

    clearPlaybackTrace();
    expect(getPlaybackTrace()).toHaveLength(0);
  });
});

