import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assetMatchesWorkspaceRelativePath, decodeAssetAudioBuffer } from './audioPreview';

const { mockInvoke, mockConvertFileSrc } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockConvertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
  convertFileSrc: mockConvertFileSrc,
}));

describe('audioPreview utilities', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockConvertFileSrc.mockClear();
    vi.unstubAllGlobals();
  });

  it('matches workspace relative paths after normalization', () => {
    const asset = {
      id: 'asset-1',
      relativePath: 'Audio\\Voice.MP3',
    } as const;

    expect(assetMatchesWorkspaceRelativePath(asset as any, './audio/voice.mp3')).toBe(true);
    expect(assetMatchesWorkspaceRelativePath(asset as any, 'audio/music.mp3')).toBe(false);
  });

  it('falls back to a generated audio preview when direct decode fails', async () => {
    const decodeAudioData = vi.fn().mockResolvedValue({ id: 'buffer' } as unknown as AudioBuffer);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('unsupported codec'))
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      });
    vi.stubGlobal('fetch', fetchMock);

    mockInvoke.mockResolvedValue('/tmp/audio-preview.mp3');

    const result = await decodeAssetAudioBuffer(
      { decodeAudioData } as Pick<AudioContext, 'decodeAudioData'>,
      { id: 'asset-1', uri: '/tmp/source.flac' },
    );

    expect(result.usedPreview).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith('ensure_audio_preview_for_asset', {
      assetId: 'asset-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith('asset://localhost/tmp/audio-preview.mp3');
  });
});
