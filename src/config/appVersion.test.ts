import { describe, expect, it } from 'vitest';
import { APP_VERSION, formatAppVersion, normalizeAppVersion } from './appVersion';

describe('appVersion', () => {
  it('should use the build-time version when runtime version is unavailable', () => {
    expect(normalizeAppVersion(null)).toBe(APP_VERSION);
    expect(normalizeAppVersion('unknown')).toBe(APP_VERSION);
    expect(normalizeAppVersion('web')).toBe(APP_VERSION);
  });

  it('should format version labels with a single v prefix', () => {
    expect(formatAppVersion('1.2.3')).toBe('v1.2.3');
    expect(formatAppVersion('v1.2.3')).toBe('v1.2.3');
  });
});
