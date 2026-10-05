import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri, dev sunucusunu sabit bir portta bekler (tauri.conf.json devUrl).
// 1420 baska proje deseniyle ayni.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // ONBELLEK (2026-09-18): Mantine + CodeMirror ilk kez yuklendiginde Vite
  // bagimlilik taramasi yapiyordu; dashboard ilk acilista bu sirada BEYAZ
  // kaliyordu (sahada olculdu; watchdog reload'i kurtariyordu). include ile
  // dev sunucusu ACILIRKEN onbelleklenir — ilk acilis hizli olur.
  // Uretim derlemesini etkilemez.
  optimizeDeps: {
    include: [
      '@cruxgarden/plasma-ui',
      '@mantine/core',
      '@mantine/hooks',
      'codemirror',
      '@codemirror/lang-markdown',
      '@codemirror/theme-one-dark',
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    // Dev'de renderer kendi origin'inden konusur; Vite /v1'i gateway'e
    // proxy'ler (WebSocket dahil). Tauri/uretimde renderer dogrudan gateway
    // URL'sine baglanir (arayuzdeki alan). Boylece tek origin, CORS derdi yok.
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:4100',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    // Tauri, modern webview hedefler; kucuk ve hizli cikti.
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      /*
       * IKI GIRIS NOKTASI (cok sayfali derleme):
       *  - index.html   → pet penceresi (seffaf HUD, styles.css)
       *  - mission.html → Mission Control panosu (opak pano, mission.css)
       *
       * Neden ayri: iki pencerenin CSS'i celisir. Pet penceresinin en kritik
       * kurali "zemin YOK" (pencere seffaf); pano ise opak yuzeylerden olusur.
       * Ayni belgede bulussalar biri gorunmez olurdu. Rust tarafi panoyu
       * `WebviewUrl::App("mission.html")` ile acar — dev'de Vite, paketli
       * uygulamada dist icinden ayni ad.
       *
       * Bu giris SILINIRSE pano paketli uygulamada 404 verir ve yalniz `tauri
       * dev`de calisir; belirti "uretimde bos pencere" olur.
       */
      input: {
        index: 'index.html',
        mission: 'mission.html',
      },
    },
  },
});
