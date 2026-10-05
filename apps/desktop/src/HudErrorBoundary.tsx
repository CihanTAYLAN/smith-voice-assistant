import { Component, type ReactNode } from 'react';

import { logFailure } from './logFailure.js';
import { useHitAreas } from './useHitAreas.js';

/**
 * Ana pencerenin son savunma hatti. Pencere seffaf ve cercevesiz: bir RENDER
 * hatasi yakalanmazsa geriye aciklamasiz, bos bir seffaf pencere kalir ve
 * kullanici ne oldugunu anlayamaz. Bu sinir hatayi gorunur ve geri alinabilir
 * kilar: kisa Turkce aciklama + yeniden yukle.
 *
 * Yalniz render hatalari yakalanir. Yakalanmamis promise reddi arayuzu DEGISTIRMEZ:
 * ses oturumu (mikrofon, ekran akisi) Rust'ta calisir ve bir kutuphane
 * reddi yuzunden kontrol panelinin yok olmasi, oturum acikken kullaniciyi
 * kontrolsuz birakirdi. Komut hatalari zaten komut yuzeyinde gorunur
 * (`callHost`, `useWindowCommands`).
 */

function Fallback(): React.JSX.Element {
  // Yedek yuzey de bir "ada"dir: bildirilmezse tiklanamaz.
  useHitAreas('fallback');
  return (
    <section className="hud-fallback" role="alert">
      <h1>Smith arayüzü açılamadı</h1>
      <p>
        Ses oturumu çalışmaya devam ediyor olabilir. Kontrol etmek için pencereyi yeniden yükle.
      </p>
      <button type="button" onClick={() => window.location.reload()}>
        Yeniden yükle
      </button>
    </section>
  );
}

export class HudErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    logFailure('hud render', error);
  }

  override render(): ReactNode {
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}
