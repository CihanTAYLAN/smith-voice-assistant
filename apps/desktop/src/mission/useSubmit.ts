import { useCallback, useState } from 'react';

import type { MutationResult } from './api.js';

export interface Submitter {
  /** Son eylemin kullanici mesaji; sonraki denemede ve `clearError` ile temizlenir. */
  error: string | null;
  /** Eylemi calistirir; basarili olup olmadigini doner. Taslak YALNIZ basarida temizlenir. */
  submit: (action: () => Promise<MutationResult<unknown>>) => Promise<boolean>;
  clearError: () => void;
}

/**
 * Bir yuzeyin eylem hatasini KENDI yaninda tutar. Kipli pencere acikken sayfa
 * bandi arka planda kalir (inert + karartma): hata eylemin yapildigi yuzeyde
 * gorunmezse kullanici basarisizligi hic gormez ve taslagi neden kaldigini bilmez.
 *
 * `null` sonuc (baska bir mutasyon suruyor) hata sayilmaz ama basari da degildir.
 */
export function useSubmit(): Submitter {
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (action: () => Promise<MutationResult<unknown>>): Promise<boolean> => {
      setError(null);
      const result = await action();
      if (result === null) return false;
      if (!result.ok) setError(result.error);
      return result.ok;
    },
    [],
  );
  const clearError = useCallback(() => setError(null), []);

  return { error, submit, clearError };
}
