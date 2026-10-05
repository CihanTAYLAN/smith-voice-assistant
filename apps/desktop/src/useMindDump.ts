import { useCallback, useEffect, useRef, useState } from 'react';

import { callHost } from './tauriHost.js';

/**
 * `zihin_dokumu` okumasinin durumu. Dokum her acilista YENIDEN okunur (canli
 * veriden uretiliyor, onbelleklenmis bir kopya "gorunen" ile "gonderilen"i
 * ayirirdi), bu yuzden `bayat` durumu yoktur.
 *
 * `loading` ile `empty` AYRIDIR: yavas gelen bir komut "henuz baglam yok"
 * gibi gorunmemeli. Komut yoksa/yanit vermiyorsa (tarayici onizlemesi, eski
 * Rust) UYDURMA icerik gosterilmez: `error` durumu yeniden dene sunar.
 */
export type MindDump =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error' }
  | { status: 'ready'; text: string };

/** Komut ciktisini gosterim durumuna cevirir; yalniz bosluktan olusan metin bostur. */
export function mindDumpFrom(text: string): MindDump {
  return text.trim() ? { status: 'ready', text } : { status: 'empty' };
}

/**
 * Dokumu okur ve yeniden dene sunar. Her okuma monoton bir istek kimligi alir:
 * yeniden deneme sirasinda gec donen eski cevap yeni durumu ezmez; dialog
 * kapaninca (`mounted` kapanir) bekleyen cevap yok sayilir.
 */
export function useMindDump(): { dump: MindDump; retry: () => void } {
  const [dump, setDump] = useState<MindDump>({ status: 'loading' });
  const latestRequest = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(() => {
    const request = ++latestRequest.current;
    setDump({ status: 'loading' });
    void callHost<string>('zihin_dokumu').then((response) => {
      if (!mounted.current || request !== latestRequest.current) return;
      setDump(response.ok ? mindDumpFrom(response.value) : { status: 'error' });
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  return { dump, retry: load };
}
