/**
 * useAutoSave Hook Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoSave } from './useAutoSave';

// Mock the project store
vi.mock('@/stores', () => ({
  useProjectStore: vi.fn(() => ({
    isDirty: false,
    isLoaded: true,
    saveProject: vi.fn(),
  })),
}));

import { useProjectStore } from '@/stores';

const mockUseProjectStore = vi.mocked(useProjectStore);

describe('useAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Default mock state
    mockUseProjectStore.mockReturnValue({
      isDirty: false,
      isLoaded: true,
      saveProject: vi.fn().mockResolvedValue(undefined),
    } as ReturnType<typeof useProjectStore>);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ===========================================================================
  // Initial State Tests
  // ===========================================================================

  it('returns initial state correctly', () => {
    const { result } = renderHook(() => useAutoSave());

    expect(result.current.isSaving).toBe(false);
    expect(result.current.lastSavedAt).toBe(null);
    expect(result.current.lastError).toBe(null);
    expect(result.current.timeUntilSave).toBe(null);
  });

  it('does not schedule save when not dirty', () => {
    mockUseProjectStore.mockReturnValue({
      isDirty: false,
      isLoaded: true,
      saveProject: vi.fn(),
    } as ReturnType<typeof useProjectStore>);

    const { result } = renderHook(() => useAutoSave({ delay: 1000 }));

    expect(result.current.timeUntilSave).toBe(null);
  });

  // ===========================================================================
  // Auto-save Scheduling Tests
  // ===========================================================================

  it('schedules save when dirty and loaded', async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    mockUseProjectStore.mockReturnValue({
      isDirty: true,
      isLoaded: true,
      saveProject: mockSave,
    } as ReturnType<typeof useProjectStore>);

    const { result } = renderHook(() => useAutoSave({ delay: 1000 }));

    expect(result.current.timeUntilSave).toBe(1000);

    // Fast-forward time
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve(); // Allow async save to complete
    });

    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('updates countdown every second', async () => {
    mockUseProjectStore.mockReturnValue({
      isDirty: true,
      isLoaded: true,
      saveProject: vi.fn().mockResolvedValue(undefined),
    } as ReturnType<typeof useProjectStore>);

    const { result } = renderHook(() => useAutoSave({ delay: 3000 }));

    expect(result.current.timeUntilSave).toBe(3000);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    // Should be approximately 2000ms remaining (with some tolerance)
    expect(result.current.timeUntilSave).toBeLessThanOrEqual(2000);
  });

  // ===========================================================================
  // Disabled Tests
  // ===========================================================================

  it('does not save when disabled', async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    mockUseProjectStore.mockReturnValue({
      isDirty: true,
      isLoaded: true,
      saveProject: mockSave,
    } as ReturnType<typeof useProjectStore>);

    renderHook(() => useAutoSave({ enabled: false, delay: 1000 }));

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(mockSave).not.toHaveBeenCalled();
  });

  it('does not save when project not loaded', async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    mockUseProjectStore.mockReturnValue({
      isDirty: true,
      isLoaded: false,
      saveProject: mockSave,
    } as ReturnType<typeof useProjectStore>);

    renderHook(() => useAutoSave({ delay: 1000 }));

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(mockSave).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Manual Save Tests
  // ===========================================================================

  it('allows manual save via saveNow', async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    mockUseProjectStore.mockReturnValue({
      isDirty: true,
      isLoaded: true,
      saveProject: mockSave,
    } as ReturnType<typeof useProjectStore>);

    const { result } = renderHook(() => useAutoSave());

    await act(async () => {
      await result.current.saveNow();
    });

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(result.current.lastSavedAt).not.toBe(null);
  });

  it('clears pending auto-save when saveNow is called', async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    mockUseProjectStore.mockReturnValue({
      isDirty: true,
      isLoaded: true,
      saveProject: mockSave,
    } as ReturnType<typeof useProjectStore>);

    const { result } = renderHook(() => useAutoSave({ delay: 5000 }));

    // Auto-save is scheduled
    expect(result.current.timeUntilSave).toBe(5000);

    // Manual save
    await act(async () => {
      await result.current.saveNow();
    });

    expect(mockSave).toHaveBeenCalledTimes(1);

    // Fast-forward past the original auto-save time
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });

    // Should not have saved again
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  it('handles save errors', async () => {
    const error = new Error('Save failed');
    const mockSave = vi.fn().mockRejectedValue(error);
    const onSaveError = vi.fn();

    mockUseProjectStore.mockReturnValue({
      isDirty: true,
      isLoaded: true,
      saveProject: mockSave,
    } as ReturnType<typeof useProjectStore>);

    const { result } = renderHook(() => useAutoSave({ onSaveError }));

    await act(async () => {
      await result.current.saveNow();
    });

    expect(result.current.lastError).toEqual(error);
    expect(onSaveError).toHaveBeenCalledWith(error);
  });

  // ===========================================================================
  // Callback Tests
  // ===========================================================================

  it('calls onSaveStart and onSaveComplete callbacks', async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    const onSaveStart = vi.fn();
    const onSaveComplete = vi.fn();

    mockUseProjectStore.mockReturnValue({
      isDirty: true,
      isLoaded: true,
      saveProject: mockSave,
    } as ReturnType<typeof useProjectStore>);

    const { result } = renderHook(() =>
      useAutoSave({ onSaveStart, onSaveComplete })
    );

    await act(async () => {
      await result.current.saveNow();
    });

    expect(onSaveStart).toHaveBeenCalledTimes(1);
    expect(onSaveComplete).toHaveBeenCalledTimes(1);
  });

  // ===========================================================================
  // isSaving State Tests
  // ===========================================================================

  it('sets isSaving during save operation', async () => {
    // Use real timers for this test since it involves complex async behavior
    vi.useRealTimers();

    let resolveSave: () => void = () => {};
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const mockSave = vi.fn().mockReturnValue(savePromise);

    mockUseProjectStore.mockReturnValue({
      isDirty: false, // Start not dirty to avoid auto-save interference
      isLoaded: true,
      saveProject: mockSave,
    } as ReturnType<typeof useProjectStore>);

    const { result } = renderHook(() => useAutoSave());

    // Trigger manual save
    let savePromiseResult: Promise<void>;
    act(() => {
      savePromiseResult = result.current.saveNow();
    });

    // Should be saving immediately after calling saveNow
    expect(result.current.isSaving).toBe(true);

    // Resolve the save
    resolveSave();

    // Wait for save to complete
    await act(async () => {
      await savePromiseResult;
    });

    // Should no longer be saving
    expect(result.current.isSaving).toBe(false);

    // Restore fake timers for other tests
    vi.useFakeTimers();
  });
});
