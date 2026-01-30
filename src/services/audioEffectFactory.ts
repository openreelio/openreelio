/**
 * AudioEffectFactory Service
 *
 * Factory for creating Web Audio API nodes from effect definitions.
 * Handles conversion between effect parameters and Web Audio node properties.
 */

// =============================================================================
// Types
// =============================================================================

export type AudioNodeType = 'gain' | 'biquad' | 'compressor' | 'delay' | 'panner';

export interface EffectNodeConfig {
  effectType: string;
  params: Record<string, number>;
  enabled: boolean;
}

export interface AudioEffectNode {
  node: AudioNode;
  effectType: string;
  nodeType: AudioNodeType;
  bypassed: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const MAX_GAIN_DB = 24;
const MIN_GAIN_DB = -96;
const MAX_FREQUENCY = 20000;
const MIN_FREQUENCY = 20;
const MAX_DELAY_MS = 5000;

// Effect type to Web Audio node type mapping
const EFFECT_NODE_MAP: Record<string, AudioNodeType> = {
  volume: 'gain',
  gain: 'gain',
  eq_band: 'biquad',
  compressor: 'compressor',
  limiter: 'compressor',
  delay: 'delay',
  pan: 'panner',
};

// =============================================================================
// Unit Conversion Functions
// =============================================================================

/**
 * Convert decibels to linear gain
 * @param db - Decibel value
 * @returns Linear gain value
 */
export function convertDbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Convert linear gain to decibels
 * @param linear - Linear gain value
 * @returns Decibel value
 */
export function convertLinearToDb(linear: number): number {
  if (linear <= 0) return -Infinity;
  return 20 * Math.log10(linear);
}

/**
 * Clamp a value to a range
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// =============================================================================
// Node Type Detection
// =============================================================================

/**
 * Get the Web Audio node type for an effect type
 * @param effectType - Effect type string
 * @returns Node type or null if unsupported
 */
export function getEffectNodeType(effectType: string): AudioNodeType | null {
  return EFFECT_NODE_MAP[effectType] ?? null;
}

// =============================================================================
// Node Creation
// =============================================================================

/**
 * Create a Web Audio effect node from configuration
 * @param context - AudioContext instance
 * @param config - Effect configuration
 * @returns AudioEffectNode or null if unsupported
 */
export function createAudioEffectNode(
  context: AudioContext,
  config: EffectNodeConfig
): AudioEffectNode | null {
  const nodeType = getEffectNodeType(config.effectType);

  if (!nodeType) {
    return null;
  }

  // If disabled, create a bypass (unity gain) node
  if (!config.enabled) {
    const bypassNode = context.createGain();
    bypassNode.gain.value = 1;
    return {
      node: bypassNode,
      effectType: config.effectType,
      nodeType: 'gain',
      bypassed: true,
    };
  }

  // Create appropriate node based on type
  switch (nodeType) {
    case 'gain':
      return createGainNode(context, config);
    case 'biquad':
      return createBiquadNode(context, config);
    case 'compressor':
      return createCompressorNode(context, config);
    case 'delay':
      return createDelayNode(context, config);
    case 'panner':
      return createPannerNode(context, config);
    default:
      return null;
  }
}

/**
 * Create a GainNode for volume/gain effects
 */
function createGainNode(context: AudioContext, config: EffectNodeConfig): AudioEffectNode {
  const node = context.createGain();
  const { effectType, params } = config;

  if (effectType === 'volume') {
    // Volume effect uses linear level (0-2)
    const level = params.level ?? 1.0;
    node.gain.value = clamp(level, 0, 2);
  } else if (effectType === 'gain') {
    // Gain effect uses dB
    const gainDb = clamp(params.gain ?? 0, MIN_GAIN_DB, MAX_GAIN_DB);
    node.gain.value = convertDbToLinear(gainDb);
  }

  return {
    node,
    effectType,
    nodeType: 'gain',
    bypassed: false,
  };
}

/**
 * Create a BiquadFilterNode for EQ effects
 */
function createBiquadNode(context: AudioContext, config: EffectNodeConfig): AudioEffectNode {
  const node = context.createBiquadFilter();
  const { params } = config;

  node.type = 'peaking';
  node.frequency.value = clamp(params.frequency ?? 1000, MIN_FREQUENCY, MAX_FREQUENCY);
  node.Q.value = clamp(params.width ?? 1.0, 0.1, 10);
  node.gain.value = clamp(params.gain ?? 0, MIN_GAIN_DB, MAX_GAIN_DB);

  return {
    node,
    effectType: config.effectType,
    nodeType: 'biquad',
    bypassed: false,
  };
}

/**
 * Create a DynamicsCompressorNode for compressor/limiter effects
 */
function createCompressorNode(context: AudioContext, config: EffectNodeConfig): AudioEffectNode {
  const node = context.createDynamicsCompressor();
  const { effectType, params } = config;

  if (effectType === 'compressor') {
    // Compressor params: threshold (0-1), ratio (1-20), attack (ms), release (ms)
    const threshold = params.threshold ?? 0.5;
    node.threshold.value = -threshold * 48; // Convert 0-1 to dB range (-48 to 0)
    node.ratio.value = clamp(params.ratio ?? 4, 1, 20);
    node.attack.value = (params.attack ?? 5) / 1000; // ms to seconds
    node.release.value = (params.release ?? 50) / 1000;
  } else if (effectType === 'limiter') {
    // Limiter is essentially a very high ratio compressor
    const limit = params.limit ?? 1.0;
    node.threshold.value = -((1 - limit) * 24); // Convert 0-1 limit to threshold
    node.ratio.value = 20; // High ratio for limiting
    node.attack.value = (params.attack ?? 5) / 1000;
    node.release.value = (params.release ?? 50) / 1000;
  }

  return {
    node,
    effectType,
    nodeType: 'compressor',
    bypassed: false,
  };
}

/**
 * Create a DelayNode for delay effects
 */
function createDelayNode(context: AudioContext, config: EffectNodeConfig): AudioEffectNode {
  const node = context.createDelay(MAX_DELAY_MS / 1000);
  const { params } = config;

  // Delay time in ms, convert to seconds
  const delayMs = clamp(params.delay ?? 0, 0, MAX_DELAY_MS);
  node.delayTime.value = delayMs / 1000;

  return {
    node,
    effectType: config.effectType,
    nodeType: 'delay',
    bypassed: false,
  };
}

/**
 * Create a StereoPannerNode for pan effects
 */
function createPannerNode(context: AudioContext, config: EffectNodeConfig): AudioEffectNode {
  const node = context.createStereoPanner();
  const { params } = config;

  // Pan value: -1 (left) to 1 (right)
  node.pan.value = clamp(params.pan ?? 0, -1, 1);

  return {
    node,
    effectType: config.effectType,
    nodeType: 'panner',
    bypassed: false,
  };
}

// =============================================================================
// Node Update
// =============================================================================

/**
 * Update an existing effect node with new parameters
 * @param effectNode - AudioEffectNode to update
 * @param params - New parameter values
 * @param context - AudioContext for timing
 */
export function updateAudioEffectNode(
  effectNode: AudioEffectNode,
  params: Record<string, number>
): void {
  // Don't update bypassed nodes
  if (effectNode.bypassed) {
    return;
  }

  const { node, effectType, nodeType } = effectNode;

  switch (nodeType) {
    case 'gain':
      updateGainNode(node as GainNode, effectType, params);
      break;
    case 'biquad':
      updateBiquadNode(node as BiquadFilterNode, params);
      break;
    case 'compressor':
      updateCompressorNode(node as DynamicsCompressorNode, effectType, params);
      break;
    case 'delay':
      updateDelayNode(node as DelayNode, params);
      break;
    case 'panner':
      updatePannerNode(node as StereoPannerNode, params);
      break;
  }
}

function updateGainNode(node: GainNode, effectType: string, params: Record<string, number>): void {
  if (effectType === 'volume' && params.level !== undefined) {
    node.gain.value = clamp(params.level, 0, 2);
  } else if (effectType === 'gain' && params.gain !== undefined) {
    const gainDb = clamp(params.gain, MIN_GAIN_DB, MAX_GAIN_DB);
    node.gain.value = convertDbToLinear(gainDb);
  }
}

function updateBiquadNode(node: BiquadFilterNode, params: Record<string, number>): void {
  if (params.frequency !== undefined) {
    node.frequency.value = clamp(params.frequency, MIN_FREQUENCY, MAX_FREQUENCY);
  }
  if (params.width !== undefined) {
    node.Q.value = clamp(params.width, 0.1, 10);
  }
  if (params.gain !== undefined) {
    node.gain.value = clamp(params.gain, MIN_GAIN_DB, MAX_GAIN_DB);
  }
}

function updateCompressorNode(
  node: DynamicsCompressorNode,
  effectType: string,
  params: Record<string, number>
): void {
  if (effectType === 'compressor') {
    if (params.threshold !== undefined) {
      node.threshold.value = -params.threshold * 48;
    }
    if (params.ratio !== undefined) {
      node.ratio.value = clamp(params.ratio, 1, 20);
    }
  } else if (effectType === 'limiter') {
    if (params.limit !== undefined) {
      node.threshold.value = -((1 - params.limit) * 24);
    }
  }

  if (params.attack !== undefined) {
    node.attack.value = params.attack / 1000;
  }
  if (params.release !== undefined) {
    node.release.value = params.release / 1000;
  }
}

function updateDelayNode(node: DelayNode, params: Record<string, number>): void {
  if (params.delay !== undefined) {
    node.delayTime.value = clamp(params.delay, 0, MAX_DELAY_MS) / 1000;
  }
}

function updatePannerNode(node: StereoPannerNode, params: Record<string, number>): void {
  if (params.pan !== undefined) {
    node.pan.value = clamp(params.pan, -1, 1);
  }
}
