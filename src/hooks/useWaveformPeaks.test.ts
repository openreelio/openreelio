import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useWaveformPeaks } from './useWaveformPeaks';
import type { WaveformData } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

function createWaveformData(peaks: number[]): WaveformData {
  return {
    samplesPerSecond: 100,
    peaks,
    durationSec: peaks.length / 100,
    channels: 1,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('useWaveformPeaks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should ignore stale generate success after the selected asset changes', async () => {
    const staleGeneration = deferred<WaveformData | null>();
    const currentGeneration = deferred<WaveformData | null>();
    const currentData = createWaveformData([0.2, 0.4]);

    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'get_waveform_data') {
        return Promise.resolve(null);
      }
      if (
        command === 'generate_waveform_for_asset' &&
        (args as { assetId?: string }).assetId === 'asset-a'
      ) {
        return staleGeneration.promise;
      }
      if (
        command === 'generate_waveform_for_asset' &&
        (args as { assetId?: string }).assetId === 'asset-b'
      ) {
        return currentGeneration.promise;
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const { result, rerender } = renderHook(
      ({ assetId }) =>
        useWaveformPeaks(assetId, {
          enabled: false,
        }),
      { initialProps: { assetId: 'asset-a' } },
    );

    act(() => {
      void result.current.generate();
    });

    expect(result.current.isGenerating).toBe(true);

    rerender({ assetId: 'asset-b' });

    act(() => {
      void result.current.generate();
    });

    await act(async () => {
      currentGeneration.resolve(currentData);
      await currentGeneration.promise;
    });

    expect(result.current.data).toEqual(currentData);
    expect(result.current.isGenerating).toBe(false);

    await act(async () => {
      staleGeneration.resolve(createWaveformData([0.9]));
      await staleGeneration.promise;
    });

    expect(result.current.data).toEqual(currentData);
    expect(result.current.error).toBeNull();
    expect(result.current.isGenerating).toBe(false);
  });

  it('should ignore stale generate failure after the selected asset changes', async () => {
    const staleGeneration = deferred<WaveformData | null>();
    const currentGeneration = deferred<WaveformData | null>();
    const currentData = createWaveformData([0.1, 0.3]);

    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'get_waveform_data') {
        return Promise.resolve(null);
      }
      if (
        command === 'generate_waveform_for_asset' &&
        (args as { assetId?: string }).assetId === 'asset-a'
      ) {
        return staleGeneration.promise;
      }
      if (
        command === 'generate_waveform_for_asset' &&
        (args as { assetId?: string }).assetId === 'asset-b'
      ) {
        return currentGeneration.promise;
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    const { result, rerender } = renderHook(
      ({ assetId }) =>
        useWaveformPeaks(assetId, {
          enabled: false,
        }),
      { initialProps: { assetId: 'asset-a' } },
    );

    act(() => {
      void result.current.generate();
    });

    rerender({ assetId: 'asset-b' });

    act(() => {
      void result.current.generate();
    });

    await act(async () => {
      currentGeneration.resolve(currentData);
      await currentGeneration.promise;
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
    });

    await act(async () => {
      staleGeneration.reject(new Error('stale generation failed'));
      await staleGeneration.promise.catch(() => null);
    });

    expect(result.current.data).toEqual(currentData);
    expect(result.current.error).toBeNull();
    expect(result.current.isGenerating).toBe(false);
  });
});
