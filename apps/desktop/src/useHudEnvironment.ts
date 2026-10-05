import { useCallback, useEffect, useState } from 'react';

import { currentTimeTheme } from './timeTheme.js';
import { callHost, hasTauri } from './tauriHost.js';
import { type LiveLink } from './useLiveVoice.js';

/**
 * Mikrofon acildiktan sonra Live durumu icin beklenecek sure. Asilirsa
 * "baglaniyor…" sonsuza kadar asili kalmaz: SMITH_LIVE kapaliysa
 * `audio://live-status` HIC gelmez ve kullanici sebepsiz bekler.
 */
const LINK_STALL_MS = 12_000;

/** Pencere gorunur mu; gizliyken gereksiz is yapmamak icin. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = (): void => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/**
 * Mikrofon acik ama Live durumu hic gelmediyse LINK_STALL_MS sonra true olur.
 * "baglaniyor…" yazisinin sonsuza kadar asili kalmasini engeller.
 */
export function useLinkStall(capturing: boolean, link: LiveLink): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!capturing || link !== 'unknown') {
      setStalled(false);
      return;
    }
    let alive = true;
    let id: number | null = null;
    const arm = (): void => {
      if (!alive || id !== null) return;
      id = window.setTimeout(() => setStalled(true), LINK_STALL_MS);
    };
    if (!hasTauri()) {
      arm();
    } else {
      void callHost<{ connected: boolean }>('live_status_get').then((snapshot) => {
        if (
          snapshot.ok &&
          typeof snapshot.value === 'object' &&
          snapshot.value !== null &&
          typeof snapshot.value.connected === 'boolean'
        ) {
          // Gecerli anlik goruntu geldiyse useLiveVoice ayni komutla link'i
          // gunceller; arada yanlis bir "yanit vermiyor" sayaci baslatma.
          return;
        }
        arm();
      });
    }
    return () => {
      alive = false;
      if (id !== null) window.clearTimeout(id);
    };
  }, [capturing, link]);
  return stalled;
}

/**
 * Dar pencere (varsayilan 420x520, Rust minimum 320x360): pano burada yan yana
 * degil altta tek kolon olarak dizilir (bkz. styles.css, ayni esik). ESIK
 * styles.css'teki dar pencere medya sorgusuyla AYNI olmali.
 */
export const COMPACT_VIEWPORT_QUERY = '(max-width: 599px)';

/**
 * Pano daraltma durumu. Kullanici bilerek acip kapadiysa onun secimi kazanir;
 * secim yoksa dar pencerede daraltilmis, genis pencerede acik baslar ve pencere
 * yeniden boyutlanirsa buna uyar. Dar pencerede ayrintili pano zaten tum
 * yuksekligi yutar ve pet gorunmez olurdu.
 */
export function useHudCollapse(): { collapsed: boolean; toggle: () => void } {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_VIEWPORT_QUERY).matches);
  const [chosen, setChosen] = useState<boolean | null>(null);
  useEffect(() => {
    const media = window.matchMedia(COMPACT_VIEWPORT_QUERY);
    const sync = (): void => setCompact(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const collapsed = chosen ?? compact;
  const toggle = useCallback(() => setChosen(!collapsed), [collapsed]);
  return { collapsed, toggle };
}

/**
 * YALNIZ GELISTIRME ARACI: uretim derlemesinde tamamen elenir.
 *
 * Pencere seffaf oldugu icin tarayici onizlemesinde (`pnpm dev`, Tauri host'u
 * yok) zemin bembeyaz gorunur; cam panellerin kontrasti ve adalarin yerlesimi
 * olculemez. `?backdrop=check|light|dark` ile body'ye gecici bir zemin basar:
 *  - `check` → satranc deseni (seffafligin nerede oldugunu gosterir)
 *  - `light` → beyaz masaustu benzetimi (en zor okunabilirlik durumu)
 *  - `dark`  → koyu masaustu benzetimi
 * `import.meta.env.DEV` false oldugunda Vite bu blogu tumden atar.
 */
export function useDevBackdrop(): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const want = new URLSearchParams(window.location.search).get('backdrop');
    if (!want) return;
    document.body.dataset.devBackdrop = want;
    return () => {
      delete document.body.dataset.devBackdrop;
    };
  }, []);
}

/** Dakikalik kontrol yeterli: tema sinirlari saat basinda, saniyelik hassasiyet gereksiz uyanma demek. */
const TIME_THEME_POLL_MS = 60_000;

/**
 * Zaman temasi motoru (Faz 6, plan §7). Cihaz saatine gore periyodik olarak
 * `:root[data-time-theme]`i gunceller (styles.css'teki dort blok: yalniz
 * --accent-* uctur, bkz. o dosyanin yorumu ve `timeTheme.ts`).
 *
 * GELISTIRME'de `?theme=…` bunu GERSIZ birakir (`useDevBackdrop` ile ayni
 * desen; attribute `documentElement`e yazilir cunku tema tokenlari `:root`
 * kapsaminda tanimli): saat motoru o oturumda hic kurulmaz, boylece dort
 * temayi elle test etmek saat degistirmeden mumkun olur. Parametre yoksa
 * (uretimde her zaman) otomatik motor calisir.
 */
export function useTimeTheme(): void {
  useEffect(() => {
    const override = import.meta.env.DEV
      ? new URLSearchParams(window.location.search).get('theme')
      : null;
    if (override) {
      document.documentElement.dataset.timeTheme = override;
      return () => {
        delete document.documentElement.dataset.timeTheme;
      };
    }

    const apply = (): void => {
      document.documentElement.dataset.timeTheme = currentTimeTheme();
    };
    apply();
    const id = window.setInterval(apply, TIME_THEME_POLL_MS);
    return () => {
      window.clearInterval(id);
      delete document.documentElement.dataset.timeTheme;
    };
  }, []);
}
