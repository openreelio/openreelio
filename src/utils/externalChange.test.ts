import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_CHANGE_DETECTED_CODE,
  isExternalChangeError,
  parseExternalChangeEvent,
} from './externalChange';

describe('isExternalChangeError', () => {
  it('should recognize the backend external-change error when it is an Error', () => {
    const error = new Error(
      `${EXTERNAL_CHANGE_DETECTED_CODE}: the project operation log changed on disk outside this session ` +
        '(expected 4 operations, found 6). Reload the project to continue.',
    );

    expect(isExternalChangeError(error)).toBe(true);
  });

  it('should recognize the error when it arrives as a bare string', () => {
    expect(isExternalChangeError(`${EXTERNAL_CHANGE_DETECTED_CODE}: something changed`)).toBe(true);
  });

  it('should not match unrelated command failures', () => {
    expect(isExternalChangeError(new Error('Clip not found: clip_001'))).toBe(false);
    expect(isExternalChangeError(undefined)).toBe(false);
  });
});

describe('parseExternalChangeEvent', () => {
  it('should parse a full payload', () => {
    const parsed = parseExternalChangeEvent({
      opCount: 12,
      expectedOpCount: 9,
      relativePath: '.openreelio/state/ops.jsonl',
    });

    expect(parsed).toEqual({
      opCount: 12,
      expectedOpCount: 9,
      relativePath: '.openreelio/state/ops.jsonl',
    });
  });

  it('should tolerate a payload with only the operation count', () => {
    expect(parseExternalChangeEvent({ opCount: 3 })).toEqual({
      opCount: 3,
      expectedOpCount: undefined,
      relativePath: undefined,
    });
  });

  it('should return null when the payload is not usable', () => {
    expect(parseExternalChangeEvent(null)).toBeNull();
    expect(parseExternalChangeEvent('ops.jsonl')).toBeNull();
    expect(parseExternalChangeEvent({})).toBeNull();
    expect(parseExternalChangeEvent({ opCount: 'many' })).toBeNull();
    expect(parseExternalChangeEvent({ opCount: Number.NaN })).toBeNull();
  });
});
