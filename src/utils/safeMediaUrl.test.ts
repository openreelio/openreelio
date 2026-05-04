import { describe, expect, it } from 'vitest';

import { buildSafeAssetImageUrl, sanitizeRendererImageUrl } from './safeMediaUrl';

describe('sanitizeRendererImageUrl', () => {
  it('allows renderer-safe asset and blob image URLs', () => {
    expect(sanitizeRendererImageUrl('asset://localhost/path/to/thumb.jpg')).toBe(
      'asset://localhost/path/to/thumb.jpg',
    );
    expect(sanitizeRendererImageUrl('http://asset.localhost/path/to/thumb.jpg')).toBe(
      'http://asset.localhost/path/to/thumb.jpg',
    );
    expect(sanitizeRendererImageUrl('blob:https://app.localhost/id')).toBe(
      'blob:https://app.localhost/id',
    );
  });

  it('rejects direct local, remote, data, and malformed image URLs', () => {
    expect(sanitizeRendererImageUrl('/path/to/thumb.jpg')).toBeNull();
    expect(sanitizeRendererImageUrl('file:///C:/videos/thumb.jpg')).toBeNull();
    expect(sanitizeRendererImageUrl('https://example.test/thumb.jpg')).toBeNull();
    expect(sanitizeRendererImageUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(sanitizeRendererImageUrl('asset://localhost/thumb.jpg\nonerror=alert(1)')).toBeNull();
  });
});

describe('buildSafeAssetImageUrl', () => {
  it('wraps project-relative media paths in the asset protocol', () => {
    expect(buildSafeAssetImageUrl('shots/0001.jpg')).toBe('asset://localhost/shots/0001.jpg');
  });

  it('rejects scheme-bearing and path-traversal media paths', () => {
    expect(buildSafeAssetImageUrl('https://example.test/thumb.jpg')).toBeNull();
    expect(buildSafeAssetImageUrl('file:///C:/videos/thumb.jpg')).toBeNull();
    expect(buildSafeAssetImageUrl('../secret/thumb.jpg')).toBeNull();
    expect(buildSafeAssetImageUrl('shots/../../secret/thumb.jpg')).toBeNull();
    expect(buildSafeAssetImageUrl('shots/0001.jpg\u0000.png')).toBeNull();
  });
});
