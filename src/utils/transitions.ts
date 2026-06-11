import type { Clip, Effect } from '@/types';

export const TRANSITION_EFFECT_TYPES = new Set([
  'cross_dissolve',
  'fade',
  'wipe',
  'slide',
  'zoom',
]);

export function isTransitionEffect(effect: Effect | undefined): effect is Effect {
  return (
    effect != null &&
    typeof effect.effectType === 'string' &&
    TRANSITION_EFFECT_TYPES.has(effect.effectType)
  );
}

export function getClipTransitionEffect(
  clip: Clip,
  effects: ReadonlyMap<string, Effect>,
): Effect | undefined {
  for (const effectId of clip.effects) {
    const effect = effects.get(effectId);
    if (isTransitionEffect(effect)) {
      return effect;
    }
  }
  return undefined;
}
