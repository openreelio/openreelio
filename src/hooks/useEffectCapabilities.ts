import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  buildEffectCapabilityRegistry,
  type EffectCapabilityRecord,
  type EffectCapabilityRegistry,
} from '@/utils/effectCapabilities';
import { isTauriRuntime } from '@/services/framePaths';

export function useEffectCapabilityRegistry(): EffectCapabilityRegistry | null {
  const [registry, setRegistry] = useState<EffectCapabilityRegistry | null>(null);

  useEffect(() => {
    let active = true;

    if (!isTauriRuntime()) {
      return () => {
        active = false;
      };
    }

    void Promise.resolve(invoke<EffectCapabilityRecord[]>('get_effect_capabilities'))
      .then((records) => {
        if (active) {
          setRegistry(Array.isArray(records) ? buildEffectCapabilityRegistry(records) : null);
        }
      })
      .catch(() => {
        if (active) {
          setRegistry(null);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return registry;
}
