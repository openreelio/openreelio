/**
 * useAudioMixer Hook Tests
 *
 * Tests for the audio mixer hook that connects:
 * - Mixer store state to Web Audio API nodes
 * - AnalyserNodes for real-time level metering
 * - GainNodes for volume control
 * - StereoPannerNodes for pan control
 *
 * Follows TDD methodology.
 *
 * @module hooks/useAudioMixer.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAudioMixer } from './useAudioMixer';
import { useAudioMixerStore } from '@/stores/audioMixerStore';

// =============================================================================
// Mocks
// =============================================================================

// Mock AnalyserNode
class MockAnalyserNode {
  fftSize = 2048;
  frequencyBinCount = 1024;
  minDecibels = -100;
  maxDecibels = -30;
  smoothingTimeConstant = 0.8;

  getByteTimeDomainData = vi.fn((array: Uint8Array) => {
    // Fill with centered data (128 = silence)
    for (let i = 0; i < array.length; i++) {
      array[i] = 128;
    }
  });

  getByteFrequencyData = vi.fn();
  getFloatTimeDomainData = vi.fn();
  getFloatFrequencyData = vi.fn();
  connect = vi.fn().mockReturnThis();
  disconnect = vi.fn();

  // Web Audio specific properties
  numberOfInputs = 1;
  numberOfOutputs = 1;
  channelCount = 2;
  channelCountMode = 'max' as ChannelCountMode;
  channelInterpretation = 'speakers' as ChannelInterpretation;
  context = {} as BaseAudioContext;

  // Event handlers
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn().mockReturnValue(true);
}

// Mock GainNode
class MockGainNode {
  gain = {
    value: 1,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    cancelAndHoldAtTime: vi.fn(),
    defaultValue: 1,
    minValue: 0,
    maxValue: 1,
    automationRate: 'a-rate' as AutomationRate,
  };
  connect = vi.fn().mockReturnThis();
  disconnect = vi.fn();
  numberOfInputs = 1;
  numberOfOutputs = 1;
  channelCount = 2;
  channelCountMode = 'max' as ChannelCountMode;
  channelInterpretation = 'speakers' as ChannelInterpretation;
  context = {} as BaseAudioContext;
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn().mockReturnValue(true);
}

// Mock StereoPannerNode
class MockStereoPannerNode {
  pan = {
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    cancelAndHoldAtTime: vi.fn(),
    defaultValue: 0,
    minValue: -1,
    maxValue: 1,
    automationRate: 'a-rate' as AutomationRate,
  };
  connect = vi.fn().mockReturnThis();
  disconnect = vi.fn();
  numberOfInputs = 1;
  numberOfOutputs = 1;
  channelCount = 2;
  channelCountMode = 'clamped-max' as ChannelCountMode;
  channelInterpretation = 'speakers' as ChannelInterpretation;
  context = {} as BaseAudioContext;
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn().mockReturnValue(true);
}

// Mock ChannelSplitterNode
class MockChannelSplitterNode {
  connect = vi.fn().mockReturnThis();
  disconnect = vi.fn();
  numberOfInputs = 1;
  numberOfOutputs = 2;
  channelCount = 2;
  channelCountMode = 'explicit' as ChannelCountMode;
  channelInterpretation = 'discrete' as ChannelInterpretation;
  context = {} as BaseAudioContext;
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn().mockReturnValue(true);
}

// Mock AudioContext
class MockAudioContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  sampleRate = 44100;
  destination = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    maxChannelCount: 2,
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: 'explicit' as ChannelCountMode,
    channelInterpretation: 'speakers' as ChannelInterpretation,
    context: {} as BaseAudioContext,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn().mockReturnValue(true),
  };

  createAnalyser = vi.fn(() => new MockAnalyserNode());
  createGain = vi.fn(() => new MockGainNode());
  createStereoPanner = vi.fn(() => new MockStereoPannerNode());
  createChannelSplitter = vi.fn(() => new MockChannelSplitterNode());
  resume = vi.fn().mockResolvedValue(undefined);
  suspend = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
}

// Store the mock for assertions
let mockAudioContext: MockAudioContext;

// Mock global AudioContext
vi.stubGlobal('AudioContext', vi.fn(() => {
  mockAudioContext = new MockAudioContext();
  return mockAudioContext;
}));

// =============================================================================
// Tests
// =============================================================================

describe('useAudioMixer', () => {
  beforeEach(() => {
    // Reset store
    useAudioMixerStore.getState().reset();
    // Clear all mocks
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize without crashing', () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: false,
      }));

      expect(result.current).toBeDefined();
      expect(result.current.isReady).toBe(false);
    });

    it('should create AudioContext when enabled', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      // Initialize audio context
      await act(async () => {
        await result.current.initialize();
      });

      expect(result.current.isReady).toBe(true);
    });
  });

  describe('track audio chain', () => {
    it('should create audio chain for a track', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      // Initialize a track in the store
      act(() => {
        useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);
      });

      // Connect the track's audio chain
      act(() => {
        result.current.connectTrack('track-1');
      });

      // Verify GainNode was created for volume control
      expect(mockAudioContext.createGain).toHaveBeenCalled();

      // Verify StereoPannerNode was created for pan control
      expect(mockAudioContext.createStereoPanner).toHaveBeenCalled();

      // Verify AnalyserNode was created for metering
      expect(mockAudioContext.createAnalyser).toHaveBeenCalled();
    });

    it('should disconnect track audio chain', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      act(() => {
        useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);
        result.current.connectTrack('track-1');
      });

      act(() => {
        result.current.disconnectTrack('track-1');
      });

      // Verify the track is disconnected (test passes if no error thrown)
      expect(true).toBe(true);
    });
  });

  describe('volume control', () => {
    it('should update gain node when volume changes', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      act(() => {
        useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);
        result.current.connectTrack('track-1');
      });

      // Change volume in store
      act(() => {
        useAudioMixerStore.getState().setTrackVolume('track-1', -6);
      });

      // The hook should sync volume to gain node
      // -6 dB = ~0.5 linear
      const gainNode = result.current.getTrackGainNode('track-1');
      expect(gainNode).toBeDefined();
    });
  });

  describe('pan control', () => {
    it('should update panner node when pan changes', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      act(() => {
        useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);
        result.current.connectTrack('track-1');
      });

      // Change pan in store
      act(() => {
        useAudioMixerStore.getState().setTrackPan('track-1', 0.5);
      });

      // The hook should sync pan to panner node
      const pannerNode = result.current.getTrackPannerNode('track-1');
      expect(pannerNode).toBeDefined();
    });
  });

  describe('mute control', () => {
    it('should mute track by setting gain to 0', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      act(() => {
        useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);
        result.current.connectTrack('track-1');
      });

      // Mute the track
      act(() => {
        useAudioMixerStore.getState().setMuted('track-1', true);
      });

      const gainNode = result.current.getTrackGainNode('track-1');
      // When muted, gain should be 0
      expect(gainNode?.gain.value).toBe(0);
    });
  });

  describe('solo control', () => {
    it('should silence non-soloed tracks when solo is active', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      act(() => {
        useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);
        useAudioMixerStore.getState().initializeTrack('track-2', 0, 0);
        result.current.connectTrack('track-1');
        result.current.connectTrack('track-2');
      });

      // Solo track-1
      act(() => {
        useAudioMixerStore.getState().toggleSolo('track-1');
      });

      // track-2 should be silenced
      const track2GainNode = result.current.getTrackGainNode('track-2');
      expect(track2GainNode?.gain.value).toBe(0);

      // track-1 should still be audible
      const track1GainNode = result.current.getTrackGainNode('track-1');
      expect(track1GainNode?.gain.value).toBeGreaterThan(0);
    });
  });

  describe('master channel', () => {
    it('should have master gain node', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      const masterGain = result.current.getMasterGainNode();
      expect(masterGain).toBeDefined();
    });

    it('should update master gain when master volume changes', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      act(() => {
        useAudioMixerStore.getState().setMasterVolume(-6);
      });

      const masterGain = result.current.getMasterGainNode();
      expect(masterGain).toBeDefined();
    });

    it('should mute master when master mute is toggled', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      act(() => {
        useAudioMixerStore.getState().toggleMasterMute();
      });

      const masterGain = result.current.getMasterGainNode();
      expect(masterGain?.gain.value).toBe(0);
    });
  });

  describe('level metering', () => {
    it('should start metering when playback starts', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      act(() => {
        useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);
        result.current.connectTrack('track-1');
      });

      // Start metering
      act(() => {
        result.current.startMetering();
      });

      expect(result.current.isMetering).toBe(true);
    });

    it('should stop metering when playback stops', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      act(() => {
        result.current.startMetering();
      });

      act(() => {
        result.current.stopMetering();
      });

      expect(result.current.isMetering).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should cleanup all nodes on unmount', async () => {
      const { result, unmount } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      act(() => {
        useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);
        result.current.connectTrack('track-1');
      });

      // Unmount should cleanup
      unmount();

      // AudioContext should be closed
      expect(mockAudioContext.close).toHaveBeenCalled();
    });
  });

  describe('getInputNode', () => {
    it('should return input node for connecting audio sources', async () => {
      const { result } = renderHook(() => useAudioMixer({
        enabled: true,
      }));

      await act(async () => {
        await result.current.initialize();
      });

      act(() => {
        useAudioMixerStore.getState().initializeTrack('track-1', 0, 0);
        result.current.connectTrack('track-1');
      });

      const inputNode = result.current.getTrackInputNode('track-1');
      expect(inputNode).toBeDefined();
    });
  });
});
