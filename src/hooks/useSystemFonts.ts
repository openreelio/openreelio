import { useEffect, useMemo, useState } from 'react';
import { commands } from '@/bindings';
import { DEFAULT_TEXT_FONT_FAMILIES, mergeTextFontFamilies } from '@/utils/textFonts';

export function useSystemFonts(currentFamily?: string): string[] {
  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    void commands.listSystemFontFamilies().then((result) => {
      if (!cancelled && result.status === 'ok' && Array.isArray(result.data)) {
        setSystemFonts(result.data);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(
    () => mergeTextFontFamilies([currentFamily], systemFonts, DEFAULT_TEXT_FONT_FAMILIES),
    [currentFamily, systemFonts],
  );
}
