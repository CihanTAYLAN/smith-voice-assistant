import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createTheme, MantineProvider } from '@mantine/core';

import '@mantine/core/styles.css';
import './mission.css';
import '../dashboard/dashboard.css';
import { dashboardLog, reportDashboardError } from '../dashboard/api.js';
import { Dashboard } from '../dashboard/Dashboard.js';
import { DashboardErrorBoundary } from '../dashboard/ErrorBoundary.js';

/**
 * SMITH DASHBOARD giris noktasi (`mission.html`).
 *
 * ESKI ADI "Mission Control" penceresiydi; ayni pencere artik Dashboard:
 * gorev panosu + dosyalar + bilgi grafigi + hafiza (bkz. Dashboard.tsx).
 *
 * STABILITE KATMANLARI (beyaz ekrana karsi, sahadan ogrenildi):
 *  1. `DashboardErrorBoundary` — render hatasi ekranda kontrollu bir mesajla
 *     gorunur (ham hata degil) ve yeniden yukleme sunar.
 *  2. `window.error` / `unhandledrejection` → MASKELI olarak Rust log'una
 *     yazilir (`[dashboard] window.error ...`), boylece pencere ici hatalar
 *     dosyadan teshis edilir; kullaniciya ham metin gosterilmez.
 *  3. `dashboardReady()` - cizim tamamlandi sinyali; Rust tarafi (mission.rs)
 *     sayfa yuklemesi bitmisse geciken sinyal icin yalniz uyari verir.
 */

const theme = createTheme({
  primaryColor: 'violet',
  defaultRadius: 'md',
  fontFamily: "Inter, 'Segoe UI', system-ui, -apple-system, sans-serif",
  fontFamilyMonospace: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
});

window.addEventListener('error', (event) => {
  reportDashboardError('window.error', `${event.message} @ ${event.filename}:${event.lineno}`);
});
window.addEventListener('unhandledrejection', (event) => {
  reportDashboardError('unhandledrejection', event.reason);
});

// Boot fallback'i React ciziminden ONCE temizle (gorsel devralma):
// mission.html'daki "yukleniyor" katmani cizim baslayinca kaybolur.
document.getElementById('boot-fallback')?.remove();

const root = document.getElementById('root');
if (!root) throw new Error('root elementi bulunamadi');

createRoot(root).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark">
      <DashboardErrorBoundary>
        <Dashboard />
      </DashboardErrorBoundary>
    </MantineProvider>
  </StrictMode>,
);

type DashboardBootWindow = Window & {
  __SMITH_DASHBOARD_BOOT__?: { htmlMs: number; firstPaintMs: number | null };
};

// Yalniz sure ve istek sayisi: URL, dosya yolu veya pencere basligi loglanmaz.
// Iki kare React'in ilk commit'inin boyanmasina firsat verir.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const boot = (window as DashboardBootWindow).__SMITH_DASHBOARD_BOOT__;
    const firstPaintMs = boot?.firstPaintMs ?? performance.now();
    const resourceCount = performance.getEntriesByType('resource').length;
    dashboardLog(
      `boot metrics html_ms=${Math.round(boot?.htmlMs ?? 0)} first_paint_ms=${Math.round(firstPaintMs)} resources=${resourceCount}`,
    );
  });
});
