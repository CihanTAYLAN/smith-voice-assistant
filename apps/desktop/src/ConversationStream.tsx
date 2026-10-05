import { useEffect, useRef } from 'react';

import { type LiveLine } from './useLiveVoice.js';

/**
 * Konusma izi (ada 3): son birkac replik, cam balonlar halinde, eskiler
 * sonerek geri cekilir. Sohbet penceresi DEGIL: gecmis arsivi yok.
 */

/**
 * Balonlarda gorunen replik sayisi. Gecmis arsiv degil, akan konusmanin izi;
 * seffaf zeminde uzun bir liste masaustunu kirletir.
 */
export const VISIBLE_LINES = 4;

/** Balon akisinin dibine bu mesafeden yakinsak "takip modu" acik say. */
const FOLLOW_SLACK_PX = 56;

export interface ConversationStreamProps {
  lines: LiveLine[];
  /** Mikrofon acik mi: bos akista "konus" ipucunu gosterir. */
  capturing: boolean;
  /** Pencere gorunur mu; gizliyken kaydirma layout hesabini bosa tetikler. */
  visible: boolean;
  hover: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
}

export function ConversationStream({
  lines,
  capturing,
  visible,
  hover,
}: ConversationStreamProps): React.JSX.Element {
  const streamRef = useRef<HTMLElement>(null);
  const recent = lines.slice(-VISIBLE_LINES);

  /**
   * Takip NIYETI. Kullanici gecmisi okumak icin yukari kaydirdiysa onu zorla
   * asagi cekmeyiz; ama bunun disinda son replik daima gorunur kalmali.
   *
   * KUSUR (sahada gorulen, 2026-08-15: "konusmalar her zaman asagi scroll
   * olmuyor"): niyet, RENDER ANINDA dipten uzaklik olculerek tahmin ediliyordu.
   * Metin akarken balon BUYUDUGU icin bu mesafe kullanici hicbir sey yapmadan
   * da paydan buyuk olabiliyor: o an takip kapaniyor ve bir daha ACILMIYORDU.
   * Yani olcum, niyetin YANLIS bir vekiliydi.
   *
   * Dogrusu: niyeti KULLANICININ KENDI KAYDIRMA OLAYINDAN oku. Buyume kaynakli
   * mesafe artisi bir olay uretmez, dolayisiyla takibi bozamaz.
   */
  const followRef = useRef(true);
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const onScroll = (): void => {
      followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = streamRef.current;
    // Gizli pencerede kaydirma gereksiz: layout hesabini bosa tetikler.
    if (!el || !visible) return;
    const followBottom = (): void => {
      if (!followRef.current) return;
      // `scrollTo({behavior:'smooth'})` DEGIL: akarken her yeni parca yeni bir
      // animasyon baslatir, oncekini keser ve dibe hic varilmaz.
      el.scrollTop = el.scrollHeight;
    };
    followBottom();
    // Metin akisi ve CSS gecisleri yuksekligi efektten SONRA buyutur; tek
    // seferlik kaydirma kisa kalirdi. Buyumeyi izleyip pesinden gidiyoruz.
    const observer = new ResizeObserver(followBottom);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [lines, visible]);

  /*
   * `aria-relevant="additions"`: parcalar akarken son balonun METNI surekli
   * degisiyor; tum degisiklikleri duyurmak ekran okuyucuyu harf harf
   * konusturur. Yalniz YENI replikler duyurulur.
   */
  return (
    <section
      className="stream"
      ref={streamRef}
      aria-label="Konuşma izi"
      aria-live="polite"
      aria-relevant="additions"
      aria-atomic="false"
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
    >
      {recent.length === 0 ? (
        capturing ? (
          <p className="bubble hint">konuş, sözümü kesebilirsin</p>
        ) : null
      ) : (
        recent.map((line, index) => (
          <p
            key={line.id}
            className="bubble"
            data-role={line.role}
            // 0 = son replik (tam parlaklik); buyudukce soner. Sabit bir
            // "gecmis" opakligi yerine basamak: eskiler goz onunden cekilir.
            data-depth={recent.length - 1 - index}
            data-interrupted={line.interrupted === true}
          >
            {/* Rol GORSEL olarak hizalama ve renkle veriliyor (balon hissi);
              ekran okuyucu icin yazili etiket sart. */}
            <span className="sr">{line.role === 'user' ? 'sen:' : 'Smith:'}</span>
            <span className="said">{line.text}</span>
            {line.interrupted ? <span className="cut">kesildi</span> : null}
          </p>
        ))
      )}
    </section>
  );
}
