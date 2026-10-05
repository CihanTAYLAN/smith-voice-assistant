import { useEffect, useRef } from 'react';
import {
  PlasmaProvider,
  usePlasmaRuntime,
  type MoodName,
  type Offset,
} from '@cruxgarden/plasma-ui';

/**
 * SMITH × PLASMA — iki pencerenin ortak sivi-yuzey katmani.
 *
 * `@cruxgarden/plasma-ui` panelleri WebGL canvas'inda TEK bir sivi olarak
 * cizer: yuzeyler temas edince kaynasir, arkasindakini kirar, grid'e yapisir.
 * Bu dosya iki pencere icin iki farkli saglayici profili tanimlar:
 *
 *  1. `DeckProvider` (SMITH DASHBOARD, opak pencere) — mood alani zemin olarak
 *     cizilir (aurora/tidal/ember); yuzeyler buzlu cam olarak uzerinde yuzer.
 *     Surtuklenebilir kartlar icin grid + magnet burada.
 *  2. `HudPlasmaProvider` (pet penceresi, SEFFAF) — `ground="clear"`: zemin
 *     ALANI CIZILMEZ, canvas seffaf kalir; yalniz yuzeyler (pano, bildirim,
 *     dusunce baloncugu) sivi cam olarak masaustunun uzerine duser. Pet
 *     penceresinin en kritik kurali ("zemin YOK", bkz. styles.css) bu yuzden
 *     bozulmaz; `body { background: transparent }` aynen kalir.
 *
 * OKUNABILIRLIK SOZLESMESI HUD'da da korunur: yuzey dolgusu koyu ve neredeyse
 * opak (`HUD_SURFACE`) — metin hicbir zaman dogrudan masaustunun uzerine dusmez.
 * WebGL yoksa plasma-ui'nin kendi CSS fallback'i (`plasma-fallback`) devreye
 * girer ve dolgu `tint` x `opacity` x 0.85 + beyaz gradyan olur (satir ici stil,
 * CSS'teki cam dolgudan once gelir); bu yuzden kontrast sozlesmesi stil
 * dosyasina degil bu degerlere baglidir.
 */

/** Dashboard'da secilebilir mood'lar (baslik cubugundaki secici). */
export const DECK_MOODS: { id: MoodName; label: string }[] = [
  { id: 'aurora', label: 'aurora' },
  { id: 'tidal', label: 'tidal' },
  { id: 'ember', label: 'ember' },
];

const MOOD_KEY = 'smith.deck.mood.v1';
const LAYOUT_KEY = 'smith.deck.layout.v1';

export function loadMood(): MoodName {
  try {
    const raw = localStorage.getItem(MOOD_KEY);
    if (raw === 'aurora' || raw === 'tidal' || raw === 'ember') return raw;
  } catch {
    // localStorage kapaliysa (tarayici onizleme) sessizce varsayilana duseriz.
  }
  return 'aurora';
}

export function saveMood(mood: MoodName): void {
  try {
    localStorage.setItem(MOOD_KEY, mood);
  } catch {
    // Kalicilik bir kolayliktur; yazilamazsa mood yalniz oturum boyunca surer.
  }
}

/* --- calisma alani yerlesimi (suruklenebilir kartlar) --------------------- */

type DeckLayout = Record<string, Offset>;

export function loadDeckLayout(): DeckLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const layout: DeckLayout = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Offset).x === 'number' &&
        typeof (value as Offset).y === 'number' &&
        Number.isFinite((value as Offset).x) &&
        Number.isFinite((value as Offset).y)
      ) {
        layout[id] = value as Offset;
      }
    }
    return layout;
  } catch {
    return {};
  }
}

export function saveDeckOffset(id: string, offset: Offset): void {
  try {
    const layout = loadDeckLayout();
    layout[id] = { x: Math.round(offset.x), y: Math.round(offset.y) };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Surukleme kaybedilmez; yalniz kalici olmaz.
  }
}

export function clearDeckLayout(): void {
  try {
    localStorage.removeItem(LAYOUT_KEY);
  } catch {
    // yoksay
  }
}

/* --- saglayicilar ---------------------------------------------------------- */

/**
 * Dashboard (opak pencere) icin plazma alani.
 *
 *  - `tint` + `opacity`: yuzeyler koyu menekse cam — yogun veri uzerinde metin
 *    kontrasti alanin uzerinde degil, camin uzerinde okunur.
 *  - `frost`: arkadaki aurora alani yuzeyin icinden yumusak sizer.
 *  - `blend` 30px: pano kolonlari (8px aralik) kaynasip tek organizma gibi
 *    cizilir; ana paneller arasi >=34px oldugundan onlar AYRI kalir.
 *  - `maxSurfaces` 24: ziyaret edilen bolumler MOUNT'lu kalir (stabilite
 *    sozlesmesi; ilk ziyarete kadar mount edilmez, bkz. Dashboard.tsx);
 *    gizli bolumlerin olcusu 0 oldugu icin cizilmez ama kayitli yuzey sayisi
 *    varsayilan 16'yi asar.
 */
export function DeckProvider({
  mood,
  children,
}: {
  mood: MoodName;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <PlasmaProvider
      mood={mood}
      theme="dark"
      tint="#150a2a"
      opacity={0.34}
      frost={0.4}
      blend={30}
      radius={18}
      grid={24}
      magnet={40}
      elevation={0.35}
      maxSurfaces={24}
    >
      {children}
    </PlasmaProvider>
  );
}

/**
 * Pet penceresindeki plazma yuzeylerinin DOLGUSU (pano, bildirim, dusunce
 * kabarcigi): metin tasiyan yuzeyler opak koyu olmali. Tek kaynak burasi;
 * `mainCss.test.ts` bu degerlerden plasma-ui fallback dolgusunu hesaplar ve
 * beyaz masaustunde kucuk metnin 4.5:1 (WCAG AA) sagladigini dogrular.
 */
export const HUD_SURFACE = {
  tint: '#0c061c',
  opacity: 0.96,
  /** Ariza bildirimi: koyu kirmizi dolgu. */
  fault: '#3d0f0c',
  /** Ses izi kapisinin karari: koyu mor dolgu. */
  gate: '#1a0c38',
} as const;

/**
 * Pet penceresi (SEFFAF) icin plazma katmani.
 *
 * `ground="clear"`: alan cizilmez, canvas seffaflasir; sivi yuzeyler dogrudan
 * masaustunun uzerinde yuzer. Dolgu koyu ve opak tutulur (`HUD_SURFACE`).
 * `pointerDrop` acik: imlec adalara yaklasken altinda sivi damla belirir —
 * pencerenin geri kalaninda OS tik-gecirgenligi calistigi icin damla yalniz
 * adalarin civarinda gorunur.
 */
export function HudPlasmaProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <PlasmaProvider
      mood="aurora"
      theme="dark"
      ground="clear"
      tint={HUD_SURFACE.tint}
      opacity={HUD_SURFACE.opacity}
      frost={0.3}
      radius={16}
      grid={24}
      glow={1}
      rim={1}
      maxSurfaces={16}
    >
      {children}
    </PlasmaProvider>
  );
}

/**
 * Bolum degisiminde malzemeyi kisaca parlatir (`bump`). Ilk cizimde CALISMAZ —
 * acilista zaten form-in animasyonu var, ustune bump gereksiz parlama olurdu.
 */
export function DeckEffects({ signal }: { signal: string }): null {
  const runtime = usePlasmaRuntime();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    runtime.bump(0.6);
  }, [runtime, signal]);
  return null;
}
