import { useEffect, useState } from 'react';

import { logFailure } from './logFailure.js';
import { hasTauri } from './tauriHost.js';
import { loadToolLabels, toolLabel } from './useLiveVoice.js';
import { createSubscriptions } from './useTauriSubscriptions.js';

import {
  MIND_SWEEP_MS,
  pruneMindBubbles,
  pushMindBubble,
  type LinkPayload,
  type MindBubble,
  type MindEvent,
  type ScreenPayload,
  type SpeakerPayload,
  type ToolPayload,
} from './mindBubbles.js';

/**
 * Dusunce baloncugunun OLAY tarafi. `useLiveVoice` ile ayni dort Rust olayini
 * dinler ama farkli bir soru sorar: o "su anki DURUM ne", bu "az once NE OLDU".
 *
 * NEDEN AYRI BIR DINLEYICI: `useLiveVoice` durum tutar (acik araclar, baglanti,
 * son karar). Durumdan olay TURETILEMEZ — biten bir arac listeden dusuyor,
 * tekrarlanan bir ses izi karari durumu hic degistirmiyor. Baloncuk tam da o
 * anlari gosterdigi icin olaylara DOGRUDAN abone olmak zorunda. Tauri ayni
 * olaya birden fazla dinleyiciye izin verir; iki hook birbirini etkilemez.
 *
 * Tarayici modunda (`__TAURI_INTERNALS__` yok) hicbir sey dinlenmez ve liste
 * daima bos kalir — baloncuk da hic cizilmez.
 */

let mindSeq = 0;

export function useMindStream(): MindBubble[] {
  const [bubbles, setBubbles] = useState<MindBubble[]>([]);

  useEffect(() => {
    if (!hasTauri()) return;
    let alive = true;
    const subscriptions = createSubscriptions();
    void loadToolLabels()
      .then(() => {
        if (!alive) return;
        // Ilk olay etiketten once geldiyse yalniz ham arac adi olan yedegi yenile.
        setBubbles((items) =>
          items.map((bubble) =>
            bubble.source === 'tool' ? { ...bubble, text: toolLabel(bubble.text) } : bubble,
          ),
        );
      })
      .catch((error: unknown) => logFailure('mind tool labels', error));

    const push = (event: MindEvent): void => {
      if (!alive) return;
      mindSeq += 1;
      const id = `mb${mindSeq}`;
      const now = Date.now();
      // `id` ve `now` updater'in DISINDA sabitlenir: StrictMode updater'i iki
      // kez cagirir ve iceride uretilseler ayni olay iki farkli kabarcik olurdu.
      setBubbles((b) => pushMindBubble(b, event, { now, id }));
    };

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      // Kurulamayan abonelik `connect` icinde gunluge yazilir ve grup kapanir:
      // dusunce baloncugu dekoratif bir yuzeydir, durum gostergeleri etkilenmez.
      await subscriptions.connect([
        listen<ToolPayload>('audio://tool', (e) => push({ kind: 'tool', payload: e.payload })),
        listen<SpeakerPayload>('audio://speaker', (e) =>
          push({ kind: 'speaker', payload: e.payload }),
        ),
        listen<ScreenPayload>('audio://screen', (e) =>
          push({ kind: 'screen', payload: e.payload }),
        ),
        listen<LinkPayload>('audio://live-status', (e) =>
          push({ kind: 'link', payload: e.payload }),
        ),
      ]);
    })().catch((error: unknown) => {
      subscriptions.close();
      logFailure('mind events', error);
    });

    return () => {
      alive = false;
      subscriptions.close();
    };
  }, []);

  /*
   * Sonme suepurgesi. Kabarcik VARKEN kisa araliklarla calisir, liste bosalinca
   * tamamen durur.
   *
   * Tek bir `setTimeout` ile "en eskisinin tam sonme aninda uyan" yaklasimi
   * DAHA KIRILGAN olurdu: `pruneMindBubbles` hicbir sey sonmediginde AYNI
   * diziyi donuyor, React o durumda render etmiyor, dolayisiyla efekt yeniden
   * kurulmuyor ve bir daha hic zamanlayici kurulmuyordu. Aralikli suepurge bu
   * kilitlenmeyi yapisal olarak imkansiz kilar.
   */
  const idle = bubbles.length === 0;
  useEffect(() => {
    if (idle) return;
    const id = window.setInterval(
      () => setBubbles((b) => pruneMindBubbles(b, Date.now())),
      MIND_SWEEP_MS,
    );
    return () => window.clearInterval(id);
  }, [idle]);

  return bubbles;
}
