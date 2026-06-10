import { describe, expect, it } from 'vitest';
import { EffectType as CommandSchemaEffectType } from '@/schemas/commandSchemas';
import { getEffectCapabilityBadge } from '@/utils/effectCapabilities';
import { EFFECT_CATEGORIES, totalEffectCount } from './effectCategoryData';

describe('effectCategoryData', () => {
  const browserEffects = EFFECT_CATEGORIES.flatMap((category) =>
    category.effects.map((effect) => ({ ...effect, categoryId: category.id })),
  );

  it('should keep the exported total in sync with the browser list', () => {
    expect(totalEffectCount).toBe(browserEffects.length);
  });

  it('should only expose command-schema-supported effect types', () => {
    for (const effect of browserEffects) {
      const parsed = CommandSchemaEffectType.safeParse(effect.type);
      expect(parsed.success, `${effect.categoryId}:${effect.type} is missing from command schema`)
        .toBe(true);
      expect(effect.label.trim(), `${effect.type} should have a visible label`).not.toBe('');
    }
  });

  it('should not list duplicate effect types in the browser', () => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();

    for (const effect of browserEffects) {
      expect(typeof effect.type, `${effect.categoryId}:${String(effect.type)} should be string`)
        .toBe('string');
      const effectType = effect.type as string;
      if (seen.has(effectType)) {
        duplicates.add(effectType);
      }
      seen.add(effectType);
    }

    expect([...duplicates]).toEqual([]);
  });

  it('should show honest setup-only badges when capability data is unavailable', () => {
    for (const effect of browserEffects) {
      const badge = getEffectCapabilityBadge(effect.type, null);
      expect(badge.label).toBe('Setup only');
      expect(badge.title).not.toBe('');
    }
  });
});
