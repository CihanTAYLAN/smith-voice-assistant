/**
 * NOT (2026-08-14): varsayilan davranis ARTIK `alwaysOn: true` — Smith duydugu
 * her konusmaya cevap verir, hitap ("Smith") zorunlu DEGIL. Bu dosyadaki
 * hitap/takip-penceresi testleri o kapiyi sinadigi icin gate'i acikca
 * `alwaysOn: false` ile kurar; aksi halde hepsi 'sent' doner ve kapi hic
 * sinanmamis olur.
 */
import { describe, expect, it } from 'vitest';

import {
  createUtteranceGate,
  DEFAULT_WAKE_WORD,
  normalizeForWake,
  type UtteranceSink,
} from './dispatchUtterance.js';

function sinkSpy(ready = true): UtteranceSink & { sent: string[] } {
  const sent: string[] = [];
  return { sent, ready, send: (t: string) => sent.push(t) };
}

describe('createUtteranceGate', () => {
  it('hitap iceren konusmayi sevk eder', () => {
    const sink = sinkSpy();
    const gate = createUtteranceGate({ now: () => 0 });
    expect(gate.dispatch(sink, 'Smith yarinki toplantiyi iptal et')).toBe('sent');
    expect(sink.sent).toEqual(['Smith yarinki toplantiyi iptal et']);
  });

  it('hitapsiz arka plan konusmasini yutar', () => {
    const sink = sinkSpy();
    const gate = createUtteranceGate({ alwaysOn: false, now: () => 0 });
    expect(gate.dispatch(sink, 'aksama ne yesek acaba')).toBe('dropped-no-wake-word');
    expect(sink.sent).toEqual([]);
  });

  it('bos ve bagli-olmayan durumlari ayirt eder', () => {
    const gate = createUtteranceGate({ alwaysOn: false, now: () => 0 });
    expect(gate.dispatch(sinkSpy(), '   ')).toBe('dropped-empty');
    expect(gate.dispatch(sinkSpy(false), 'smith saat kac')).toBe('dropped-not-ready');
  });

  it('takip penceresinde hitap tekrari istemez', () => {
    const sink = sinkSpy();
    let t = 0;
    const gate = createUtteranceGate({ alwaysOn: false, now: () => t, followUpMs: 15_000 });

    expect(gate.dispatch(sink, 'smith saat kac')).toBe('sent');
    t = 5_000;
    expect(gate.dispatch(sink, 'peki yarin hava nasil')).toBe('sent');
    expect(sink.sent).toHaveLength(2);
  });

  it('takip penceresi dolunca yeniden hitap ister', () => {
    const sink = sinkSpy();
    let t = 0;
    const gate = createUtteranceGate({ alwaysOn: false, now: () => t, followUpMs: 15_000 });

    expect(gate.dispatch(sink, 'smith saat kac')).toBe('sent');
    t = 15_000;
    expect(gate.dispatch(sink, 'peki yarin hava nasil')).toBe('dropped-no-wake-word');
    expect(sink.sent).toHaveLength(1);
  });

  it('takip penceresi her sevkte tazelenir', () => {
    const sink = sinkSpy();
    let t = 0;
    const gate = createUtteranceGate({ alwaysOn: false, now: () => t, followUpMs: 10_000 });

    expect(gate.dispatch(sink, 'smith baslat')).toBe('sent');
    t = 9_000;
    // NOT: burada eskiden 'devam et' vardi; o ifade artik SUS/DEVAM kontrol
    // komutu olarak yorumlaniyor ve sevk yerine 'unmuted' doner. Takip
    // penceresini sinamak icin kontrol komutu OLMAYAN notr bir ifade sart.
    expect(gate.dispatch(sink, 'sunu da ekle')).toBe('sent'); // pencere tazelendi
    t = 17_000;
    expect(gate.dispatch(sink, 'bir de sunu yap')).toBe('sent'); // 9_000'den beri 8sn
    t = 30_000;
    expect(gate.dispatch(sink, 'kapat sunu')).toBe('dropped-no-wake-word');
  });

  it('followUpMs=0 ile her konusmada hitap zorunlu olur', () => {
    const sink = sinkSpy();
    const gate = createUtteranceGate({ alwaysOn: false, now: () => 0, followUpMs: 0 });
    expect(gate.dispatch(sink, 'smith saat kac')).toBe('sent');
    expect(gate.dispatch(sink, 'peki yarin')).toBe('dropped-no-wake-word');
  });

  it('hitap kelimenin icinde gecerse saymaz (kelime siniri)', () => {
    const sink = sinkSpy();
    const gate = createUtteranceGate({ alwaysOn: false, now: () => 0 });
    expect(gate.dispatch(sink, 'blacksmithing kursuna yazildim')).toBe('dropped-no-wake-word');
  });

  it('global flagli regex verilse bile her cagride dogru calisir', () => {
    const sink = sinkSpy();
    const gate = createUtteranceGate({
      alwaysOn: false,
      now: () => 0,
      wakeWord: /\bsmith\b/giu,
      followUpMs: 0,
    });
    expect(gate.dispatch(sink, 'smith bir')).toBe('sent');
    expect(gate.dispatch(sink, 'smith iki')).toBe('sent'); // lastIndex tuzagi
    expect(sink.sent).toHaveLength(2);
  });
});

// Rust live.rs ayni JSON vektorlerini okur.
// prettier-ignore
const WAKE_VECTORS = /* wake-vectors:start */ [
  ["Smith ekranimda ne var", true], ["SMITH!", true],
  ["smit", true], ["smitt", true], ["smitth", true], ["zmit", true],
  ["simit", true], ["simith", true], ["ismit", true], ["ismith", true],
  ["ismis", true], ["ismish", true], ["cemil", true], ["cemiyet", true],
  ["semt", true], ["schmidt", true], ["smid", true], ["İSMİTH", true],
  ["ısmıt", true], ["sîmît", true], ["simit aldim", true],
  ["(Smith), bak", true], ["Smith'in ekrani", true],
  ["blacksmithing", false], ["cemile", false], ["semtler", false],
  ["özsmith", false], ["smithçi", false], ["_smith", false],
  ["smith2", false], ["arkadaslar saga gidin", false], ["", false]
]; /* wake-vectors:end */

it.each(WAKE_VECTORS)('ortak hitap vektoru: %s', (text, expected) => {
  expect(DEFAULT_WAKE_WORD.test(normalizeForWake(String(text)))).toBe(expected);
});
