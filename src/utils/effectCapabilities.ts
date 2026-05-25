import type { EffectCapabilityDto } from '@/bindings';
import type { EffectType } from '@/types';

export type EffectRuntimeSupport = 'supported' | 'unsupported';

export interface EffectCapability {
  preview: EffectRuntimeSupport;
  export: EffectRuntimeSupport;
  renderCache: EffectRuntimeSupport;
  ffmpegFilter: string | null;
  exportReason: string | null;
  previewReason: string | null;
}

export type EffectCapabilityRecord = EffectCapabilityDto;

export type EffectCapabilityRegistry = ReadonlyMap<string, EffectCapability>;

export interface EffectCapabilityBadge {
  label: string;
  title: string;
  tone: 'success' | 'warning' | 'muted';
}

const UNKNOWN_CAPABILITY: EffectCapability = {
  preview: 'unsupported',
  export: 'unsupported',
  renderCache: 'unsupported',
  ffmpegFilter: null,
  exportReason: 'This effect needs an explicit renderer before export.',
  previewReason: 'This effect is not implemented by the interactive preview renderer yet.',
};

function toRuntimeSupport(value: string): EffectRuntimeSupport {
  return value === 'supported' ? 'supported' : 'unsupported';
}

export function getEffectTypeKey(effectType: EffectType | string): string {
  return typeof effectType === 'string' ? effectType : `custom:${effectType.custom}`;
}

export function buildEffectCapabilityRegistry(
  records: readonly EffectCapabilityRecord[],
): EffectCapabilityRegistry {
  return new Map(
    records.map((record) => [
      record.effectType,
      {
        preview: toRuntimeSupport(record.preview),
        export: toRuntimeSupport(record.export),
        renderCache: toRuntimeSupport(record.renderCache),
        ffmpegFilter: record.ffmpegFilter,
        exportReason: record.exportReason,
        previewReason: record.previewReason,
      },
    ]),
  );
}

export function getEffectCapability(
  effectType: EffectType | string,
  registry: EffectCapabilityRegistry | null | undefined,
): EffectCapability {
  return registry?.get(getEffectTypeKey(effectType)) ?? UNKNOWN_CAPABILITY;
}

export function getEffectCapabilityBadge(
  effectType: EffectType | string,
  registry: EffectCapabilityRegistry | null | undefined,
): EffectCapabilityBadge {
  const capability = getEffectCapability(effectType, registry);
  const previewSupported = capability.preview === 'supported';
  const exportSupported = capability.export === 'supported';

  if (previewSupported && exportSupported) {
    return {
      label: 'Full',
      title: 'Supported in preview and final export.',
      tone: 'success',
    };
  }

  if (exportSupported) {
    return {
      label: 'Export only',
      title: capability.previewReason ?? 'Supported in final export only.',
      tone: 'warning',
    };
  }

  if (previewSupported) {
    return {
      label: 'Preview only',
      title: capability.exportReason ?? 'Supported in preview only.',
      tone: 'warning',
    };
  }

  return {
    label: 'Setup only',
    title: capability.exportReason ?? 'This effect is not rendered yet.',
    tone: 'muted',
  };
}
