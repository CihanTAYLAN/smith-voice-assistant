import { Plasma } from '@cruxgarden/plasma-ui';

import { MindDialog } from './MindDialog.js';
import { type MindBubble } from './mindBubbles.js';

/**
 * Pet'in USTUNDEKI dusunce baloncugu: "Smith'in su an aklinda ne var".
 *
 * KONUSMA BALONLARINDAN AYRI: replikler pet'in ALTINDA, sivri kosesi olan cam
 * balonlar halinde akar (`.stream`/`.bubble`). Bu ada pet'in USTUNDE durur,
 * tamamen yuvarlak kabarciklardan olusur ve pet'e dogru KUCULEN iki nokta ile
 * baglanir: klasik dusunce baloncugu dili. Ikisi gorsel olarak karistirilamaz.
 *
 * Bu bilesen SUNUM'dan sorumludur: olay dinlemez (`useMindStream`); dokum
 * komutunu `MindDialog` (`useMindDump`) okur. Hud.tsx ile ayni sozlesme.
 *
 * DOSYA ADI NOTU: mantik `mindBubbles.ts`te; bilesen `MindCloud` cunku Windows
 * dosya sistemi yalniz buyuk/kucuk harfte ayrisan iki dosyayi ayirt etmez
 * (`forceConsistentCasingInFileNames` bunu hata sayiyor).
 *
 * TIKLANABILIR: kabarciga tiklamak `zihin_dokumu` dokumunu acar. Bu yuzden
 * `.mind` ve `.mind-dump` Rust gozcusune bildirilen hit alanlarindadir
 * (useHitAreas.ts `HIT_SELECTORS`); aksi halde tiklama masaustune duserdi.
 */

export interface MindCloudProps {
  /** En eskiden en yeniye; sonuncusu en belirgin cizilir. */
  bubbles: MindBubble[];
  /** Detay dokumu acik mi. */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Dokum kapaninca tetikleyici sondugunden odagin gidecegi yer (panodaki dokum dugmesi). */
  fallbackFocus: React.RefObject<HTMLElement | null>;
  hover: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
}

export function MindCloud(props: MindCloudProps): React.JSX.Element | null {
  const { bubbles, open } = props;
  // Olay yokken HICBIR SEY cizilmez: seffaf pencerede bos bir yuzey masaustunu
  // sebepsiz kirletir (ve hit alani olarak bildirilirse fareyi de yakalar).
  if (bubbles.length === 0 && !open) return null;

  return (
    <>
      {bubbles.length > 0 ? (
        <div
          className="mind"
          aria-live="polite"
          aria-relevant="additions"
          onPointerEnter={props.hover.onPointerEnter}
          onPointerLeave={props.hover.onPointerLeave}
        >
          <button
            type="button"
            className="mind-cloud"
            onClick={props.onOpen}
            title="Modele giden bağlamın tamamını göster"
            aria-label="Smith'in zihin dökümünü aç"
          >
            {bubbles.map((b, i) => (
              // Her dusunce AYRI plazma yuzeyi: kucuk araliklarla istiflendik-
              // lerinde birbirlerine kaynasip tek bir sivi BULUT cizilir:
              // dusunce baloncugu dili, malzemenin kendisiyle anlatilir.
              <Plasma
                as="span"
                key={b.id}
                className="mind-thought"
                radius={18}
                // 0 = en yeni (tam parlaklik); buyudukce geri cekilir.
                data-depth={bubbles.length - 1 - i}
                data-source={b.source}
              >
                {b.text}
              </Plasma>
            ))}
          </button>
          {/* Kuyruk: pet'e dogru kuculen iki kabarcik. Dekoratif. */}
          <i className="mind-tail" data-size="m" aria-hidden="true" />
          <i className="mind-tail" data-size="s" aria-hidden="true" />
        </div>
      ) : null}

      {open ? <MindDialog onClose={props.onClose} fallbackFocus={props.fallbackFocus} /> : null}
    </>
  );
}
