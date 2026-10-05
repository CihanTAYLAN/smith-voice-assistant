import { useCallback, useEffect, useRef, useState } from 'react';

import { logFailure } from './logFailure.js';
import { callHost, hasTauri } from './tauriHost.js';

/**
 * TIKLAMA GECIRGENLIGI (seffaf pencere).
 *
 * Pencere seffaf ve her zaman ustte; adalarin disindaki her yer fareyi
 * masaustune birakmali. Isletim sistemi katmani Rust'taki imlec gozcusudur:
 * imleci 40 ms'de bir okuyup pencereyi bildirilen dikdortgenlerin icinde
 * etkilesimli, disinda gecirgen yapar. Biz yalniz GEOMETRIYI bildiririz
 * (`window_set_hit_areas`); anahtarlamayi yapan taraf JS degil (JS gecirgen
 * durumda hicbir fare olayi gormezdi, eski tasarimin yapisal kusuru buydu).
 */

/** Fare bir adadan cikinca pencereyi gecirgen yapmadan once beklenen sure (yalniz yedek yol). */
const INTERACTIVE_RELEASE_MS = 140;

/**
 * Rust gozcusune bildirilen dokunulabilir adalar. Sira onemsiz; her biri
 * `getBoundingClientRect()` ile CSS (logical) px olarak gonderilir.
 *
 * `.notice`, `.stream`, `.mind`, `.mind-dump` ve `.hud-fallback` KOSULLU:
 * yoklarsa (ya da yuksekligi 0 ise) hic bildirilmez; hayalet bir hit alani
 * masaustunun o parcasini sebepsiz kilitler. `.mind` listede cunku kabarcik
 * TIKLANABILIR (dokumu acar); olay yokken DOM'da hic bulunmaz, kisa pencerede
 * CSS ile `display: none` olur ve olculen dikdortgeni sifirlandigi icin yine
 * dusmez.
 */
const HIT_SELECTORS = [
  '.pet',
  '.hud',
  '.notice',
  '.stream',
  '.mind',
  '.mind-dump',
  '.hud-fallback',
] as const;

/**
 * Hit alani olcumunun rAF'siz yedek gecikmesi. rAF, pencere gizliyken ya da
 * henuz kare uretmiyorken CALISMAZ; bu zamanlayici olmadan hit alanlari hic
 * bildirilmez ve pet kalici olarak gecirgen kalir (tarayicida olculdu).
 */
const HIT_AREA_FALLBACK_MS = 48;

/** Basarisiz bildirimin yeniden deneme sayisi ve basamak gecikmesi. */
const HIT_AREA_MAX_RETRIES = 3;
const HIT_AREA_RETRY_STEP_MS = 150;

interface HitArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Gecirgenligin SAHIBI kim? `window_set_hit_areas` bir kez KABUL edildiyse
 * sahibi Rust'taki imlec gozcusudur ve `window_set_interactive` cagirmayiz
 * (yetki kurali: ikisi birden yapilirsa gozcu ile UI birbirini ezer).
 *
 * Modul kapsaminda tutuluyor: tek bir isletim sistemi penceresi var, yani bu
 * gercekten global bir durum. Kabul edilmezse (eski Rust / komut yok) yedek
 * hover yolu devreye girer.
 */
let hitAreasOwned = false;

/**
 * Adalarin dikdortgenlerini CSS (logical) px olarak toplar: Rust gozcusu tam
 * bunu bekliyor, DPI olcegini kendisi uyguluyor. Modal `<dialog>` aciksa tum
 * pencere etkilesimlidir (arka plan inert, tiklama dialog'a gitmeli).
 */
function collectHitAreas(): HitArea[] {
  if (document.querySelector('dialog[open]')) {
    return [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }];
  }
  const areas: HitArea[] = [];
  for (const selector of HIT_SELECTORS) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const box = element.getBoundingClientRect();
    // Bos akis (0 yukseklikli `.stream`) bildirilmez: masaustunun o seridini
    // sebepsiz kilitlerdi.
    if (box.width < 1 || box.height < 1) continue;
    areas.push({
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
  }
  return areas;
}

/**
 * Geometri bildirim kuyrugu. TEK teslimat ucuslu: ucta paket varken gelen
 * istek isaretlenir ve cevap gelince yeniden olculur. Yalniz KABUL EDILEN
 * paket tekrar gonderimi bastirir: ilk bildirim hata alirsa ayni geometri
 * yeniden denenir, aksi halde pencere kalici olarak tiklanamaz kalabilirdi.
 */
export function createHitAreaSender(read: () => HitArea[]): {
  send: () => void;
  close: () => void;
} {
  let alive = true;
  let pending = false;
  let dirty = false;
  let acknowledged = '';
  let attempts = 0;
  let retry = 0;
  const send = (): void => {
    if (!alive) return;
    if (pending) {
      dirty = true;
      return;
    }
    const areas = read();
    const key = JSON.stringify(areas);
    if (key === acknowledged) return;
    window.clearTimeout(retry);
    pending = true;
    void callHost('window_set_hit_areas', { areas })
      .then((response) => {
        if (!alive) return;
        if (response.ok) {
          acknowledged = key;
          hitAreasOwned = true;
          attempts = 0;
        } else if (++attempts <= HIT_AREA_MAX_RETRIES) {
          retry = window.setTimeout(send, attempts * HIT_AREA_RETRY_STEP_MS);
        }
      })
      .finally(() => {
        pending = false;
        if (alive && dirty) {
          dirty = false;
          send();
        }
      });
  };
  return {
    send,
    close() {
      alive = false;
      window.clearTimeout(retry);
    },
  };
}

/**
 * DOKUNULABILIR ADALARI RUST'A BILDIR. Boyut/konum degisimini `ResizeObserver`
 * yakalar: pet'in KONUMU da degisir, cunku `.field` icerigi buyudukce dikey
 * ortalanma kayar; balon akisi boy degistirdiginde gozlemci tetiklenir ve TUM
 * rect'ler yeniden toplanir.
 *
 * `revision` bilincli olarak "yeniden GOZLEMLE tetikleyicileri" listesidir,
 * effect icinde okunan degerler degil: `.notice`, `.stream`, `.mind` ve
 * `.mind-dump` kosullu render edildigi icin gozlemcinin yeni elemanlara
 * baglanmasi gerekir. Dusunce baloncugu birkac saniyede bir belirip sondugu
 * icin kabarcik sayisi da revizyonda: yoksa kabarcik cikinca hit alani
 * bildirilmez ve tiklama masaustune duserdi.
 *
 * Olcumu ertele: ayni turda gelen birden fazla degisiklik TEK pakete duser ve
 * layout'u bosa zorlamayiz. rAF + zamanlayici IKISI BIRLIKTE ve bu bir
 * kemer-aski degil (bkz. `HIT_AREA_FALLBACK_MS`); gonderici paket
 * karsilastirmasi yaptigi icin ikisi de calissa ikinci cagri bos gecer.
 */
export function useHitAreas(revision: string): void {
  const observe = useRef<() => void>(() => {});
  useEffect(() => {
    if (!hasTauri()) return;
    const sender = createHitAreaSender(collectHitAreas);
    let frame = 0;
    let timer = 0;
    const schedule = (): void => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      frame = window.requestAnimationFrame(sender.send);
      timer = window.setTimeout(sender.send, HIT_AREA_FALLBACK_MS);
    };
    const observer = new ResizeObserver(schedule);
    observe.current = (): void => {
      observer.disconnect();
      // `.field` de gozlenir: pet'in konumu onun icerigine gore kayar.
      for (const selector of [...HIT_SELECTORS, '.field']) {
        const element = document.querySelector(selector);
        if (element) observer.observe(element);
      }
      schedule();
    };
    observe.current();
    window.addEventListener('resize', schedule);
    return () => {
      sender.close();
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.removeEventListener('resize', schedule);
      observe.current = () => {};
    };
  }, []);
  useEffect(() => observe.current(), [revision]);
}

/**
 * YEDEK YOL: yalniz `window_set_hit_areas` kabul edilMEDIYSE anlamli.
 *
 * Fare bir adanin uzerine gelince pencere fareyi yakalar, ayrilinca birakir.
 * YAPISAL KUSURU BILINIYOR: gecirgenlik `ignore_cursor_events` ile
 * uygulaniyorsa webview artik fare olayi ALMAZ ve geri donusu goremez → pet
 * kalici olarak olur. Bu yuzden birincil cozum hit alanlaridir; bu yol yalniz
 * hit alani komutu yoksa (ve o zaman gecirgenlik de zaten yoktur) kalir.
 */
export function useWindowInteractive(): {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
} {
  const inside = useRef(0);
  const timer = useRef<number | null>(null);
  /** Son gonderilen deger; ayni degeri tekrar gondermeyiz (gereksiz IPC). */
  const sent = useRef<boolean | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const onPointerEnter = useCallback(() => {
    inside.current += 1;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (hitAreasOwned || sent.current === true) return;
    sent.current = true;
    void callHost('window_set_interactive', { interactive: true });
  }, []);

  const onPointerLeave = useCallback(() => {
    inside.current = Math.max(0, inside.current - 1);
    if (timer.current !== null) window.clearTimeout(timer.current);
    // Iki ada arasinda gecerken `leave` + `enter` sirali gelir; gecikme olmasa
    // pencere her gecidde bir kez gecirgen olup geri donerdi.
    timer.current = window.setTimeout(() => {
      timer.current = null;
      // Bu arada baska bir adaya girildiyse ya da gozcu devraldiysa birakmiyoruz.
      if (hitAreasOwned || inside.current > 0 || sent.current === false) return;
      sent.current = false;
      void callHost('window_set_interactive', { interactive: false });
    }, INTERACTIVE_RELEASE_MS);
  }, []);

  return { onPointerEnter, onPointerLeave };
}

/**
 * `window://interactive`: Rust gozcusu gecirgene GECMEDEN ONCE yayinlar. Donen
 * `false`, "webview bundan sonra fare olayi almayacak" demektir; o anda takili
 * kalan `:hover` durumlarini temizlemek icin sahneye `data-inert` basiyoruz
 * (CSS hover kurallarini o bayrakla kapatiyor). Aksi halde pet/dugme "fare
 * uzerinde" gorunumunde donar kalir.
 */
export function useInteractiveHint(): boolean {
  const [inert, setInert] = useState(false);

  useEffect(() => {
    if (!hasTauri()) return;
    let alive = true;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const handle = await listen<{ interactive: boolean }>('window://interactive', (e) =>
          setInert(!e.payload.interactive),
        );
        if (!alive) {
          handle();
          return;
        }
        unlisten = handle;
      } catch (error) {
        // Olay yayinlanmiyorsa (eski Rust) hover temizligi gerekmez; yalniz
        // dinleyici kurulamadiysa gunluge yazilir.
        logFailure('window interactive hint', error);
      }
    })();

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return inert;
}
