/**
 * URI utilities tests
 */

import { describe, it, expect } from 'vitest';
import { normalizeFileUriToPath } from './uri';

describe('normalizeFileUriToPath', () => {
  it('returns the input for non-file URIs', () => {
    expect(normalizeFileUriToPath('/path/to/file.mp4')).toBe('/path/to/file.mp4');
    expect(normalizeFileUriToPath('C:/path/to/file.mp4')).toBe('C:/path/to/file.mp4');
    expect(normalizeFileUriToPath('https://example.com/video.mp4')).toBe('https://example.com/video.mp4');
  });

  it('strips file:// prefix for POSIX file URLs', () => {
    expect(normalizeFileUriToPath('file:///path/to/video.mp4')).toBe('/path/to/video.mp4');
  });

  it('decodes percent-encoded path segments', () => {
    expect(normalizeFileUriToPath('file:///path/to/My%20Video.mp4')).toBe('/path/to/My Video.mp4');
  });

  it('normalizes Windows file URLs to drive paths', () => {
    expect(normalizeFileUriToPath('file:///C:/path/to/video.mp4')).toBe('C:/path/to/video.mp4');
    expect(normalizeFileUriToPath('file:///c:/path/to/video.mp4')).toBe('c:/path/to/video.mp4');
    expect(normalizeFileUriToPath('file:///C:/Program%20Files/App/video.mp4')).toBe(
      'C:/Program Files/App/video.mp4',
    );
  });

  it('does not throw on malformed file URLs', () => {
    // Invalid percent encoding should not crash callers.
    expect(() => normalizeFileUriToPath('file:///path/to/%E0%A4%A')).not.toThrow();
    expect(normalizeFileUriToPath('file:///path/to/%E0%A4%A')).toBe('/path/to/%E0%A4%A');
  });
});
