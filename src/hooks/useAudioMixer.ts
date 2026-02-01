/**
 * useAudioMixer Hook
 *
 * Connects the AudioMixerStore to Web Audio API for real audio processing.
 *
 * Features:
 * - Track audio chains (GainNode → StereoPannerNode → AnalyserNode)
 * - Real-time level metering with AnalyserNode
 * - Volume control with proper dB to linear conversion
 * - Pan control with StereoPannerNode
 * - Solo/Mute logic
 * - Master output chain
 *
 * @module hooks/useAudioMixer
 */

import { useRef, useCallback, useEffect, useState } from 'react';
import { useAudioMixerStore, type StereoLevels } from '@/stores/audioMixerStore';
import { dbToLinear, calculatePeak, linearToDb } from '@/utils/audioMeter';
import { createLogger } from '@/services/logger';

const logger = createLogger('AudioMixer');

// =============================================================================
// Types
// =============================================================================

export interface UseAudioMixerOptions {
  /** Whether the mixer is enabled */
  enabled: boolean;
  /** Metering update interval in ms (default: 50) */
  meterUpdateInterval?: number;
  /** FFT size for analyser nodes (default: 2048) */
  fftSize?: number;
}

export interface UseAudioMixerReturn {
  /** Whether the audio system is ready */
  isReady: boolean;
  /** Whether level metering is active */
  isMetering: boolean;
  /** Initialize the audio context (call on user interaction) */
  initialize: () => Promise<void>;
  /** Connect a track's audio chain */
  connectTrack: (trackId: string) => void;
  /** Disconnect a track's audio chain */
  disconnectTrack: (trackId: string) => void;
  /** Start level metering */
  startMetering: () => void;
  /** Stop level metering */
  stopMetering: () => void;
  /** Get track's input node for connecting audio sources */
  getTrackInputNode: (trackId: string) => AudioNode | null;
  /** Get track's gain node for volume control */
  getTrackGainNode: (trackId: string) => GainNode | null;
  /** Get track's panner node for pan control */
  getTrackPannerNode: (trackId: string) => StereoPannerNode | null;
  /** Get master gain node */
  getMasterGainNode: () => GainNode | null;
  /** Get master analyser node */
  getMasterAnalyserNode: () => AnalyserNode | null;
}

/** Audio chain for a single track */
interface TrackAudioChain {
  /** Input gain node for connecting sources */
  inputGain: GainNode;
  /** Volume control gain node */
  volumeGain: GainNode;
  /** Stereo pan node */
  panner: StereoPannerNode;
  /** Channel splitter for stereo metering */
  splitter: ChannelSplitterNode;
  /** Left channel analyser */
  leftAnalyser: AnalyserNode;
  /** Right channel analyser */
  rightAnalyser: AnalyserNode;
  /** Time domain data buffer for left channel */
  leftBuffer: Uint8Array<ArrayBuffer>;
  /** Time domain data buffer for right channel */
  rightBuffer: Uint8Array<ArrayBuffer>;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_METER_UPDATE_INTERVAL = 50; // ms
const DEFAULT_FFT_SIZE = 2048;
const SILENCE_DB = -60;

// =============================================================================
// Hook
// =============================================================================

export function useAudioMixer({
  enabled,
  meterUpdateInterval = DEFAULT_METER_UPDATE_INTERVAL,
  fftSize = DEFAULT_FFT_SIZE,
}: UseAudioMixerOptions): UseAudioMixerReturn {
  // Refs for Web Audio nodes
  const audioContextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const masterAnalyserRef = useRef<AnalyserNode | null>(null);
  const masterSplitterRef = useRef<ChannelSplitterNode | null>(null);
  const masterLeftAnalyserRef = useRef<AnalyserNode | null>(null);
  const masterRightAnalyserRef = useRef<AnalyserNode | null>(null);
  const masterLeftBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const masterRightBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  // Track audio chains
  const trackChainsRef = useRef<Map<string, TrackAudioChain>>(new Map());

  // Metering state
  const meteringIntervalRef = useRef<number | null>(null);

  // State
  const [isReady, setIsReady] = useState(false);
  const [isMetering, setIsMetering] = useState(false);

  // Store access
  const {
    trackStates,
    soloedTrackIds,
    masterState,
    updateTrackLevels,
    updateMasterLevels,
  } = useAudioMixerStore();

  // ==========================================================================
  // Initialize Audio Context
  // ==========================================================================

  const initialize = useCallback(async () => {
    if (audioContextRef.current) {
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      setIsReady(true);
      return;
    }

    try {
      // Create AudioContext
      audioContextRef.current = new AudioContext();

      // Create master gain node
      masterGainRef.current = audioContextRef.current.createGain();
      masterGainRef.current.gain.value = dbToLinear(masterState.volumeDb);

      // Create master analyser for combined output
      masterAnalyserRef.current = audioContextRef.current.createAnalyser();
      masterAnalyserRef.current.fftSize = fftSize;

      // Create stereo metering for master
      masterSplitterRef.current = audioContextRef.current.createChannelSplitter(2);
      masterLeftAnalyserRef.current = audioContextRef.current.createAnalyser();
      masterRightAnalyserRef.current = audioContextRef.current.createAnalyser();
      masterLeftAnalyserRef.current.fftSize = fftSize;
      masterRightAnalyserRef.current.fftSize = fftSize;

      // Allocate buffers - use explicit ArrayBuffer for TypeScript compatibility
      const bufferLength = masterLeftAnalyserRef.current.frequencyBinCount;
      masterLeftBufferRef.current = new Uint8Array(new ArrayBuffer(bufferLength));
      masterRightBufferRef.current = new Uint8Array(new ArrayBuffer(bufferLength));

      // Connect master chain: masterGain → splitter → analysers
      //                       masterGain → destination
      masterGainRef.current.connect(masterSplitterRef.current);
      masterSplitterRef.current.connect(masterLeftAnalyserRef.current, 0);
      masterSplitterRef.current.connect(masterRightAnalyserRef.current, 1);
      masterGainRef.current.connect(audioContextRef.current.destination);

      // Resume if needed
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      setIsReady(true);
      logger.info('Audio mixer initialized');
    } catch (error) {
      logger.error('Failed to initialize audio mixer', { error });
      throw error;
    }
  }, [masterState.volumeDb, fftSize]);

  // ==========================================================================
  // Track Audio Chain Management
  // ==========================================================================

  const connectTrack = useCallback((trackId: string) => {
    if (!audioContextRef.current || !masterGainRef.current) {
      logger.warn('Cannot connect track - audio not initialized', { trackId });
      return;
    }

    if (trackChainsRef.current.has(trackId)) {
      logger.debug('Track already connected', { trackId });
      return;
    }

    const ctx = audioContextRef.current;

    // Create track audio chain
    const inputGain = ctx.createGain();
    const volumeGain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const splitter = ctx.createChannelSplitter(2);
    const leftAnalyser = ctx.createAnalyser();
    const rightAnalyser = ctx.createAnalyser();

    // Configure analysers
    leftAnalyser.fftSize = fftSize;
    rightAnalyser.fftSize = fftSize;

    // Allocate buffers - use explicit ArrayBuffer for TypeScript compatibility
    const bufferLength = leftAnalyser.frequencyBinCount;
    const leftBuffer = new Uint8Array(new ArrayBuffer(bufferLength));
    const rightBuffer = new Uint8Array(new ArrayBuffer(bufferLength));

    // Get initial state from store
    const trackState = trackStates.get(trackId);
    if (trackState) {
      const isAudible = useAudioMixerStore.getState().isTrackAudible(trackId);
      volumeGain.gain.value = isAudible ? dbToLinear(trackState.volumeDb) : 0;
      panner.pan.value = trackState.pan;
    }

    // Connect chain: inputGain → volumeGain → panner → splitter → analysers
    //                                         panner → masterGain
    inputGain.connect(volumeGain);
    volumeGain.connect(panner);
    panner.connect(splitter);
    splitter.connect(leftAnalyser, 0);
    splitter.connect(rightAnalyser, 1);
    panner.connect(masterGainRef.current);

    // Store chain
    trackChainsRef.current.set(trackId, {
      inputGain,
      volumeGain,
      panner,
      splitter,
      leftAnalyser,
      rightAnalyser,
      leftBuffer,
      rightBuffer,
    });

    logger.debug('Track connected', { trackId });
  }, [trackStates, fftSize]);

  const disconnectTrack = useCallback((trackId: string) => {
    const chain = trackChainsRef.current.get(trackId);
    if (!chain) return;

    try {
      chain.inputGain.disconnect();
      chain.volumeGain.disconnect();
      chain.panner.disconnect();
      chain.splitter.disconnect();
      chain.leftAnalyser.disconnect();
      chain.rightAnalyser.disconnect();
    } catch {
      // Nodes may already be disconnected
    }

    trackChainsRef.current.delete(trackId);
    logger.debug('Track disconnected', { trackId });
  }, []);

  // ==========================================================================
  // Sync Store State to Audio Nodes
  // ==========================================================================

  // Sync track volumes and pans
  useEffect(() => {
    if (!isReady) return;

    for (const [trackId, chain] of trackChainsRef.current) {
      const trackState = trackStates.get(trackId);
      if (!trackState) continue;

      const isAudible = useAudioMixerStore.getState().isTrackAudible(trackId);
      const targetGain = isAudible ? dbToLinear(trackState.volumeDb) : 0;

      chain.volumeGain.gain.value = targetGain;
      chain.panner.pan.value = trackState.pan;
    }
  }, [isReady, trackStates, soloedTrackIds]);

  // Sync master volume
  useEffect(() => {
    if (!masterGainRef.current) return;

    if (masterState.muted) {
      masterGainRef.current.gain.value = 0;
    } else {
      masterGainRef.current.gain.value = dbToLinear(masterState.volumeDb);
    }
  }, [masterState.volumeDb, masterState.muted]);

  // ==========================================================================
  // Level Metering
  // ==========================================================================

  const updateLevels = useCallback(() => {
    // Update track levels
    for (const [trackId, chain] of trackChainsRef.current) {
      chain.leftAnalyser.getByteTimeDomainData(chain.leftBuffer);
      chain.rightAnalyser.getByteTimeDomainData(chain.rightBuffer);

      const leftPeak = calculatePeak(chain.leftBuffer);
      const rightPeak = calculatePeak(chain.rightBuffer);

      const levels: StereoLevels = {
        left: linearToDb(leftPeak, SILENCE_DB),
        right: linearToDb(rightPeak, SILENCE_DB),
      };

      updateTrackLevels(trackId, levels);
    }

    // Update master levels
    if (masterLeftAnalyserRef.current && masterRightAnalyserRef.current &&
        masterLeftBufferRef.current && masterRightBufferRef.current) {
      masterLeftAnalyserRef.current.getByteTimeDomainData(masterLeftBufferRef.current);
      masterRightAnalyserRef.current.getByteTimeDomainData(masterRightBufferRef.current);

      const leftPeak = calculatePeak(masterLeftBufferRef.current);
      const rightPeak = calculatePeak(masterRightBufferRef.current);

      updateMasterLevels({
        left: linearToDb(leftPeak, SILENCE_DB),
        right: linearToDb(rightPeak, SILENCE_DB),
      });
    }
  }, [updateTrackLevels, updateMasterLevels]);

  const startMetering = useCallback(() => {
    if (meteringIntervalRef.current) return;

    meteringIntervalRef.current = window.setInterval(updateLevels, meterUpdateInterval);
    setIsMetering(true);
    logger.debug('Metering started');
  }, [updateLevels, meterUpdateInterval]);

  const stopMetering = useCallback(() => {
    if (meteringIntervalRef.current) {
      window.clearInterval(meteringIntervalRef.current);
      meteringIntervalRef.current = null;
    }
    setIsMetering(false);

    // Reset all levels to silence
    for (const trackId of trackChainsRef.current.keys()) {
      updateTrackLevels(trackId, { left: SILENCE_DB, right: SILENCE_DB });
    }
    updateMasterLevels({ left: SILENCE_DB, right: SILENCE_DB });

    logger.debug('Metering stopped');
  }, [updateTrackLevels, updateMasterLevels]);

  // ==========================================================================
  // Node Getters
  // ==========================================================================

  const getTrackInputNode = useCallback((trackId: string): AudioNode | null => {
    return trackChainsRef.current.get(trackId)?.inputGain ?? null;
  }, []);

  const getTrackGainNode = useCallback((trackId: string): GainNode | null => {
    return trackChainsRef.current.get(trackId)?.volumeGain ?? null;
  }, []);

  const getTrackPannerNode = useCallback((trackId: string): StereoPannerNode | null => {
    return trackChainsRef.current.get(trackId)?.panner ?? null;
  }, []);

  const getMasterGainNode = useCallback((): GainNode | null => {
    return masterGainRef.current;
  }, []);

  const getMasterAnalyserNode = useCallback((): AnalyserNode | null => {
    return masterAnalyserRef.current;
  }, []);

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  useEffect(() => {
    const trackChains = trackChainsRef.current;
    return () => {
      // Stop metering
      if (meteringIntervalRef.current) {
        window.clearInterval(meteringIntervalRef.current);
      }

      // Disconnect all tracks
      for (const trackId of trackChains.keys()) {
        const chain = trackChains.get(trackId);
        if (chain) {
          try {
            chain.inputGain.disconnect();
            chain.volumeGain.disconnect();
            chain.panner.disconnect();
            chain.splitter.disconnect();
            chain.leftAnalyser.disconnect();
            chain.rightAnalyser.disconnect();
          } catch {
            // Already disconnected
          }
        }
      }
      trackChains.clear();

      // Disconnect master nodes
      try {
        masterGainRef.current?.disconnect();
        masterSplitterRef.current?.disconnect();
        masterLeftAnalyserRef.current?.disconnect();
        masterRightAnalyserRef.current?.disconnect();
        masterAnalyserRef.current?.disconnect();
      } catch {
        // Already disconnected
      }

      // Close audio context
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }

      logger.info('Audio mixer cleaned up');
    };
  }, []);

  // Auto-initialize if enabled
  useEffect(() => {
    if (enabled && !isReady) {
      // Note: We don't auto-initialize because AudioContext requires user gesture
      // The consumer must call initialize() on user interaction
    }
  }, [enabled, isReady]);

  return {
    isReady,
    isMetering,
    initialize,
    connectTrack,
    disconnectTrack,
    startMetering,
    stopMetering,
    getTrackInputNode,
    getTrackGainNode,
    getTrackPannerNode,
    getMasterGainNode,
    getMasterAnalyserNode,
  };
}
