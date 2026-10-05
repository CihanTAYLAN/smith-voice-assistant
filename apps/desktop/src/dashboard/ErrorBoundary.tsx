import { Component, type ReactNode } from 'react';
import { reportDashboardError } from './api.js';

/**
 * Panel hata siniri — "BEYAZ EKRAN YASAGI".
 *
 * React render sirasinda bir hata firlarsa (bos ekranla sonuclanan klasik
 * bozulma) bu sinir hatayi yakalar ve yeniden yukleme sunar. Kullaniciya ham
 * hata GOSTERILMEZ (yol/ayrinti sizabilir); maskelenmis ayrinti Rust log'una
 * yazilir (`[dashboard] render failed ...`) — pencere ici hatalar disaridan,
 * log dosyasindan teshis edilebilir.
 *
 * Bu sinir Mantine saglayicisinin ICINDE yasar; CSS'i dashboard.css'ten
 * gelir ve Mantine'e bagimli degildir (saglayici coker de cizilebilsin).
 */
interface Props {
  children: ReactNode;
}

interface State {
  crashed: boolean;
}

export class DashboardErrorBoundary extends Component<Props, State> {
  override state: State = { crashed: false };

  // NOT: `getDerivedStateFromError` React.Component TIPINDE bildirilmis bir
  // uye degildir (runtime konvansiyonu) — bu yuzden `override` ALMAZ.
  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  override componentDidCatch(error: unknown): void {
    reportDashboardError('render', error);
  }

  override render(): ReactNode {
    if (!this.state.crashed) {
      return this.props.children;
    }
    return (
      <div className="db-crash" role="alert">
        <h2>Panel görüntülenemedi</h2>
        <p className="db-crash-msg">
          Beklenmeyen bir hata oluştu. Yeniden yüklemeyi dene; sorun sürerse teknik ayrıntı günlüğe
          yazıldı.
        </p>
        <button type="button" className="db-btn" onClick={() => window.location.reload()}>
          yeniden yükle
        </button>
      </div>
    );
  }
}
