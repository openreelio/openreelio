import { renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffectCapabilityRegistry } from './useEffectCapabilities';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock('@/services/framePaths', () => ({
  isTauriRuntime: runtimeMocks.isTauriRuntime,
}));

const mockedInvoke = vi.mocked(invoke);

describe('useEffectCapabilityRegistry', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    runtimeMocks.isTauriRuntime.mockReturnValue(true);
  });

  it('should load effect capabilities from the backend contract', async () => {
    mockedInvoke.mockResolvedValue([
      {
        effectType: 'text_overlay',
        preview: 'supported',
        export: 'supported',
        renderCache: 'supported',
        ffmpegFilter: 'drawtext',
        exportReason: null,
        previewReason: null,
      },
    ]);

    const { result } = renderHook(() => useEffectCapabilityRegistry());

    await waitFor(() => {
      expect(result.current?.get('text_overlay')?.export).toBe('supported');
    });

    expect(mockedInvoke).toHaveBeenCalledWith('get_effect_capabilities');
  });

  it('should return null when capability loading fails', async () => {
    mockedInvoke.mockRejectedValue(new Error('capabilities unavailable'));

    const { result } = renderHook(() => useEffectCapabilityRegistry());

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_effect_capabilities');
    });

    expect(result.current).toBeNull();
  });

  it('should avoid backend calls outside the Tauri runtime', () => {
    runtimeMocks.isTauriRuntime.mockReturnValue(false);

    const { result } = renderHook(() => useEffectCapabilityRegistry());

    expect(result.current).toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
