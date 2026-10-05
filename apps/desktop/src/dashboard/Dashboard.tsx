import { useCallback, useEffect, useState } from 'react';
import { Plasma, usePlasmaRuntime, type MoodName } from '@cruxgarden/plasma-ui';

import { MissionControl } from '../mission/MissionControl.js';
import { DECK_MOODS, DeckEffects, DeckProvider, loadMood, saveMood } from '../plasma/deck.js';
import { dashboardLog, dashboardReady, windowCmd } from './api.js';
import { Control } from './Control.js';
import { Files } from './Files.js';
import { Graph } from './Graph.js';
import { Fault } from './LoadView.js';
import { MemoryView } from './Memory.js';
import { useLeaveGuard } from './useLeaveGuard.js';

type Section = 'kontrol' | 'gorevler' | 'dosyalar' | 'grafik' | 'hafiza';

const SECTIONS: { id: Section; label: string; glyph: string }[] = [
  // Kontrol ILK sirada: panelin acilis sorusu "her sey yerinde mi" — is
  // gucu, kullanim ve bekleyen is tek ekranda.
  { id: 'kontrol', label: 'kontrol', glyph: '⬢' },
  { id: 'gorevler', label: 'görevler', glyph: '▦' },
  { id: 'dosyalar', label: 'dosyalar', glyph: '▤' },
  { id: 'grafik', label: 'bilgi grafiği', glyph: '◉' },
  { id: 'hafiza', label: 'hafıza', glyph: '◈' },
];

/**
 * SMITH DASHBOARD — masaustu panelinin kabugu (PLASMA DECK).
 *
 * Kabuk `@cruxgarden/plasma-ui` uzerine kurulu: tum yuzeyler (baslik, dock,
 * calisma kartlari, pano kolonlari, sahneler) WebGL'de TEK bir sivi malzeme
 * olarak cizilir; temas eden yuzeyler kaynasir, kartlar grid'e yapisir.
 * Gorsel dil ve saglayici profili icin bkz. `src/plasma/deck.tsx`.
 *
 * BOLUM MODELI:
 *  - `kontrol`   — SERBEST CALISMA ALANI: kartlar suruklenebilir, yerlesim
 *                  localStorage'da saklanir (`smith.deck.layout.v1`).
 *  - `gorevler`  — Mission Control; org/akis panelleri ve kanban kolonlari
 *                  plazma yuzeyidir (kolonlar kaynasir: tek organizma).
 *  - `dosyalar` / `grafik` / `hafiza` — yogun araclar; her biri tek bir
 *                  "sahne" yuzeyinin icinde calisir (fuse=false).
 *
 * STABILITE SOZLESMESI (kullanici: "daha stabil tasarla"):
 *  - Bir bolum ILK ZIYARETE kadar mount EDILMEZ (gizli bolum disk/gateway
 *    istegi baslatmaz); ziyaretten sonra mount'lu kalir ve `display` ile
 *    gizlenir → durum kaybolmaz. Plazma notu: gizli bolumun olcusu 0'dir ve
 *    renderer sifir-genislikli yuzeyleri atlar.
 *  - Her bolum kendi hatasini ekranda gosterir; beyaz ekran yasak
 *    (ust katmanda ayrica DashboardErrorBoundary var).
 *  - `dashboardReady()` boot sinyali Rust'taki watchdog'u besler: sinyal
 *    gelmezse pencere bir kez yeniden yuklenir (bkz. mission.rs).
 *  - WebGL yoksa plasma-ui CSS fallback'ine duser; islevsellik ayni kalir.
 *  - Baslik cubugu surukleme Rust komutundan gecer (pencere cercevesizdir);
 *    KAPATMA ise kaydedilmemis icerik icin terk korumasindan gecer
 *    (bkz. useLeaveGuard.tsx) — kapat dugmesi, Alt+F4 ve yerel kapatma ayni karar.
 */
export function Dashboard(): React.JSX.Element {
  const [section, setSection] = useState<Section>('kontrol');
  const [visited, setVisited] = useState<ReadonlySet<Section>>(() => new Set(['kontrol']));
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  const [mood, setMood] = useState<MoodName>(loadMood);
  const guard = useLeaveGuard();

  useEffect(() => {
    dashboardReady();
    dashboardLog('dashboard mounted (plasma deck)');
  }, []);

  const navigate = useCallback((next: Section) => {
    setVisited((previous) => new Set(previous).add(next));
    setSection(next);
  }, []);

  /** Grafikten "Dosyalar'da ac" — bolumu degistirir ve dosyayi actirir. */
  const openFile = useCallback(
    (path: string) => {
      setPendingFile(path);
      navigate('dosyalar');
    },
    [navigate],
  );
  const consumePending = useCallback(() => setPendingFile(null), []);

  const pickMood = useCallback((next: MoodName) => {
    setMood(next);
    saveMood(next);
  }, []);

  const drag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if ((event.target as HTMLElement).closest('button, input, select, a')) return;
    event.preventDefault();
    void windowCmd('mission_start_drag').then((result) =>
      setDragError(result.ok ? null : result.error),
    );
  }, []);

  const descriptions: Record<Section, string> = {
    kontrol: 'İş gücü, kullanım ve bekleyen işler bir bakışta.',
    gorevler: 'Görevlerini takip et, ekibini yönet ve sonuçları incele.',
    dosyalar: 'Çalışma alanındaki dosyaları aç ve düzenle.',
    grafik: 'Notların ve hafızan arasındaki bağlantıları keşfet.',
    hafiza: 'Kayıtlarını incele, ihtiyacın olan bilgiyi bul.',
  };
  const titles: Record<Section, string> = {
    kontrol: 'Kontrol merkezi',
    gorevler: 'Görevler',
    dosyalar: 'Dosyalar',
    grafik: 'Bilgi grafiği',
    hafiza: 'Hafıza',
  };
  const activeLabel = SECTIONS.find((s) => s.id === section)?.label ?? section;
  const notice = guard.closeError ?? dragError;
  const panes: Record<Section, React.ReactNode> = {
    kontrol: <Control />,
    // Gizli bolum mount'lu kalir ama anket yapmaz: `aktif` yalniz Gorevler gorunurken true.
    gorevler: <MissionControl aktif={section === 'gorevler'} />,
    dosyalar: (
      <Stage>
        <Files pendingPath={pendingFile} onPendingConsumed={consumePending} guard={guard} />
      </Stage>
    ),
    grafik: (
      <Stage>
        <Graph onOpenFile={openFile} />
      </Stage>
    ),
    hafiza: (
      <Stage>
        <MemoryView />
      </Stage>
    ),
  };

  return (
    <DeckProvider mood={mood}>
      <div className="db-shell">
        <Plasma
          as="header"
          fuse={false}
          lean={false}
          radius={16}
          elevation={0.2}
          className="db-header"
          onPointerDown={drag}
        >
          <div className="db-brand-row">
            <i className="db-pulse" aria-hidden="true" />
            <span className="db-brand">SMITH</span>
            <span className="db-section-name">{activeLabel}</span>
          </div>
          <div className="db-tools">
            <div className="db-moods" role="group" aria-label="Plazma teması">
              {DECK_MOODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="db-mood"
                  data-active={mood === m.id}
                  onClick={() => pickMood(m.id)}
                  title={`Tema: ${m.label}`}
                  aria-pressed={mood === m.id}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <PulseButton />
            <button
              type="button"
              className="db-ic"
              onClick={() => void guard.requestClose()}
              title="Paneli kapat"
              aria-label="Paneli kapat"
            >
              ×
            </button>
          </div>
        </Plasma>

        {notice ? <Fault message={notice} /> : null}

        <div className="db-body">
          <Plasma
            as="nav"
            aria-label="Dashboard bölümleri"
            fuse={false}
            lean={false}
            radius={16}
            className="db-dock"
          >
            <p className="db-nav-head">smith · masaüstü</p>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="db-navlink"
                data-active={section === s.id}
                onClick={() => navigate(s.id)}
                aria-current={section === s.id ? 'page' : undefined}
              >
                <span className="db-nav-glyph" aria-hidden="true">
                  {s.glyph}
                </span>
                {s.label}
              </button>
            ))}
            <p className="db-dock-foot">Kişisel çalışma alanın</p>
          </Plasma>

          <main className="db-main">
            <div className="db-page-head">
              <h1>{titles[section]}</h1>
              <p>{descriptions[section]}</p>
            </div>
            {SECTIONS.map((s) => (
              <Pane key={s.id} active={section === s.id} mounted={visited.has(s.id)}>
                {panes[s.id]}
              </Pane>
            ))}
          </main>
        </div>
      </div>

      {guard.dialog}
      <DeckEffects signal={section} />
    </DeckProvider>
  );
}

/** Bolum kabugu: icerik yalniz ziyaret edildikten sonra mount'lanir; sonra display ile gizlenir. */
function Pane({
  active,
  mounted,
  children,
}: {
  active: boolean;
  mounted: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="db-section" data-active={active}>
      {mounted ? children : null}
    </section>
  );
}

/** Yogun araclar (dosyalar/grafik/hafiza) icin tum bolumu kaplayan tek plazma sahnesi. */
function Stage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Plasma className="db-stage" fuse={false} lean={false} radius={16}>
      {children}
    </Plasma>
  );
}

/**
 * Tiklanan noktadan alana nabiz gonderir (plasma-ui `pulse`). Islevsiz bir
 * sus DEGIL: surukleme/kaynasma disinda malzemenin canli oldugunu tek
 * dokunusla gosteren geri bildirimdir; ayrica WebGL hattinin calistiginin
 * gozle test edilebilir ispatidir.
 */
function PulseButton(): React.JSX.Element {
  const runtime = usePlasmaRuntime();
  return (
    <button
      type="button"
      className="db-ic"
      title="Alana nabız gönder"
      aria-label="Alana nabız gönder"
      onClick={(event) => runtime.pulse(event.clientX, event.clientY, 1)}
    >
      ◉
    </button>
  );
}
