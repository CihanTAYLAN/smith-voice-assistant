import { MantineProvider } from '@mantine/core';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Hud } from '../Hud.js';
import { MindCloud } from '../MindCloud.js';
import { Dashboard } from '../dashboard/Dashboard.js';
import { HudPlasmaProvider } from './deck.js';

/**
 * PLASMA DECK duman testi — WebGL'siz ortam (SSR / `supported=false`, yani
 * plasma-ui'nin CSS fallback yolu). Amac piksel dogrulamak DEGIL; render
 * zincirindeki anlik cokmeleri (eksik import, bozuk prop, provider disi
 * `usePlasmaRuntime` cagrisi) CI'da yakalamak.
 *
 * Fallback yolu bilincli olarak test edilir: Tauri webview'inde WebGL var
 * sayilir ama bu testin gectigi ortam fallback'tir — iki yol da calisir
 * olmali (depo ilkesi: beyaz ekran yasak).
 *
 * `App` KAPSAM DISI: pencere komutlari/`document` gibi tarayici API'lerini
 * render sirasinda okur (SSR guvenli degildir, hicbir zaman da olmadi).
 * HUD'un plazma yuzeyi tasiyan parcalari (Hud, MindCloud) dogrudan
 * `HudPlasmaProvider` altinda test edilir — ayni sozlesme.
 */

const noop = (): void => {};

const HUD_PROPS: Parameters<typeof Hud>[0] = {
  signals: [],
  state: 'hazir',
  listening: false,
  micReady: false,
  screen: null,
  owner: null,
  ownerListening: { ready: false, pending: false, error: null, setMode: noop },
  screenStream: { ready: false, pending: false, error: null, toggle: noop },
  linkError: null,
  mixer: {
    ready: false,
    micMuted: false,
    outputMuted: false,
    outputVolume: 0.8,
    micRms: 0,
    onToggleMicMute: noop,
    onToggleOutputMute: noop,
    onOutputVolume: noop,
  },
  collapsed: false,
  framed: false,
  onCollapse: noop,
  onToggleMic: noop,
  onOpenMission: noop,
  onGrab: noop,
  onFrame: noop,
  onQuit: noop,
  hover: { onPointerEnter: noop, onPointerLeave: noop },
};

describe('plasma deck duman testi', () => {
  it('dashboard fallback yolunda cokeri olmadan render edilir', () => {
    // MantineProvider: mission/main.tsx ile AYNI sarmalayici (Control ve
    // diger bolumler Mantine bilesenleri kullanir).
    const html = renderToString(
      <MantineProvider>
        <Dashboard />
      </MantineProvider>,
    );
    // Kabuk parcalari
    expect(html).toContain('db-shell');
    expect(html).toContain('db-dock');
    expect(html).toContain('db-header');
    // Bes bolum kabugu hep vardir; ziyaret edilmemis bolumun ICERIGI mount
    // edilmez (gizli bolum disk/gateway istegi baslatmaz).
    expect(html.match(/db-section/g)?.length).toBeGreaterThanOrEqual(5);
    expect(html).toContain('wk-field');
    expect(html).not.toContain('fs-toolbar');
    expect(html).not.toContain('graph-canvas');
    expect(html).not.toContain('mem-toolbar');
    expect(html).not.toMatch(/class="mc[ "]/);
    // Plazma yuzeyleri fallback sinifiyla cizilir (WebGL yok)
    expect(html).toContain('plasma-fallback');
  });

  it('hud panosu plazma saglayicisi altinda render edilir', () => {
    const html = renderToString(
      <HudPlasmaProvider>
        <Hud {...HUD_PROPS} />
      </HudPlasmaProvider>,
    );
    // Hit-alani sozlesmesi: `.hud` sinifi korunur (Rust gozcusu onu olcer)
    expect(html).toContain('hud');
    expect(html).toContain('plasma-panel');
  });

  it('dusunce baloncugu plazma yuzeyi, zihin dokumu yerel dialog olarak cizilir', () => {
    const html = renderToString(
      <HudPlasmaProvider>
        <MindCloud
          bubbles={[
            { id: 'b1', text: 'arac calisiyor: fs_xray', source: 'tool', at: 1000 },
            { id: 'b2', text: 'hafizaya yazildi', source: 'memory', at: 2000 },
          ]}
          open={true}
          onOpen={noop}
          onClose={noop}
          fallbackFocus={{ current: null }}
          hover={{ onPointerEnter: noop, onPointerLeave: noop }}
        />
      </HudPlasmaProvider>,
    );
    expect(html).toContain('mind-thought');
    expect(html).toContain('<dialog');
    expect(html).toContain('mind-dump');
    // Iki dusunce = iki plazma yuzeyi. Dokum ust katmandaki yerel <dialog>dur
    // (WebGL canvas'i ust katmanin altinda kalir), plazma yuzeyi DEGILDIR.
    // Sayim, saglayicinin enjekte ettigi <style> icerigini saymamak icin sinif
    // OZNITELIGI uzerinden yapilir.
    expect(html.match(/class="plasma-panel/g)?.length).toBe(2);
  });
});
