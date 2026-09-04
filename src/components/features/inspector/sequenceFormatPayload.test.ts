/**
 * SetSequenceFormat payload tests
 *
 * The backend payload is flat and rejects unknown keys, so the shape the
 * inspector sends is the part worth pinning down.
 */

import { describe, it, expect } from 'vitest';
import { buildSequenceFormatPayload } from './sequenceFormatPayload';

describe('buildSequenceFormatPayload', () => {
  it('should send the frame rate as a ratio beside the sequence id', () => {
    expect(buildSequenceFormatPayload('seq_1', { fps: { num: 30000, den: 1001 } })).toEqual({
      sequenceId: 'seq_1',
      fps: { num: 30000, den: 1001 },
    });
  });

  it('should send canvas edges as flat width and height', () => {
    expect(buildSequenceFormatPayload('seq_1', { width: 1080, height: 1920 })).toEqual({
      sequenceId: 'seq_1',
      width: 1080,
      height: 1920,
    });
  });

  it('should omit fields the user did not change', () => {
    const payload = buildSequenceFormatPayload('seq_1', { width: 1280 });

    expect(Object.keys(payload).sort()).toEqual(['sequenceId', 'width']);
    expect(payload).not.toHaveProperty('format');
  });

  it('should carry the audio format when it is changed', () => {
    expect(
      buildSequenceFormatPayload('seq_1', { audioSampleRate: 44100, audioChannels: 1 }),
    ).toEqual({
      sequenceId: 'seq_1',
      audioSampleRate: 44100,
      audioChannels: 1,
    });
  });
});
