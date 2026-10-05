/**
 * `resolveActivityState`in oncelik sozlesmesini korur: eski `sessionState()`
 * mantiginin BIREBIR ayni sirasi. Bir dal kayarsa ya da yeni bir arac yanlis
 * kategoriye duserse burasi kirmizi olur.
 */
import { describe, expect, it } from 'vitest';

import { resolveActivityState, type ActivityInput } from './activityState.js';
import { type ActiveTool } from './useLiveVoice.js';

const BASE: ActivityInput = {
  micError: null,
  hostReady: true,
  capturing: true,
  link: 'up',
  linkStalled: false,
  assistantSpeaking: false,
  thinking: false,
  tools: [],
};

function tool(name: string): ActiveTool {
  return { id: 1, name, label: name };
}

describe('resolveActivityState — oncelik sirasi', () => {
  it('mikrofon arizasi her seyin onune gecer', () => {
    expect(resolveActivityState({ ...BASE, micError: 'izin yok', capturing: false })).toBe('error');
    expect(resolveActivityState({ ...BASE, micError: 'izin yok', assistantSpeaking: true })).toBe(
      'error',
    );
  });

  it('host yoksa (tarayici onizlemesi) idle', () => {
    expect(resolveActivityState({ ...BASE, hostReady: false, capturing: false })).toBe('idle');
  });

  it('mikrofon kapaliysa muted — konusma/arac gecmisinden bagimsiz', () => {
    expect(resolveActivityState({ ...BASE, capturing: false })).toBe('muted');
    expect(
      resolveActivityState({ ...BASE, capturing: false, tools: [tool('terminal_calistir')] }),
    ).toBe('muted');
  });

  it('acik arac Smith konusuyor olsa bile kazanir (tool > speaking)', () => {
    expect(
      resolveActivityState({ ...BASE, assistantSpeaking: true, tools: [tool('dosya_oku')] }),
    ).toBe('reading');
  });

  it('arac kategorileri gercek arac adindan turer', () => {
    expect(resolveActivityState({ ...BASE, tools: [tool('internette_ara')] })).toBe('researching');
    expect(resolveActivityState({ ...BASE, tools: [tool('web_sayfa_oku')] })).toBe('reading');
    expect(resolveActivityState({ ...BASE, tools: [tool('terminal_calistir')] })).toBe('acting');
    expect(resolveActivityState({ ...BASE, tools: [tool('derin_dusun')] })).toBe('thinking');
  });

  it('bilinmeyen arac guvenli varsayilana (acting) duser, uydurma kategori atmaz', () => {
    expect(resolveActivityState({ ...BASE, tools: [tool('yeni_gelecek_arac')] })).toBe('acting');
  });

  it('paralel araclarda ILK acilan kazanir', () => {
    const tools = [tool('internette_ara'), tool('terminal_calistir')];
    expect(resolveActivityState({ ...BASE, tools })).toBe('researching');
  });

  it('arac yokken konusma kazanir', () => {
    expect(resolveActivityState({ ...BASE, assistantSpeaking: true })).toBe('speaking');
  });

  it('konusma yokken turetilmis "isliyor" kazanir', () => {
    expect(resolveActivityState({ ...BASE, thinking: true })).toBe('thinking');
  });

  it('hat kapandiysa error (ariza, warn degil)', () => {
    expect(resolveActivityState({ ...BASE, link: 'down' })).toBe('error');
  });

  it('hat ayaktaysa listening', () => {
    expect(resolveActivityState(BASE)).toBe('listening');
  });

  it('hat yanit vermiyorsa bile KESIN ariza sayilmaz — waiting (noticeFor ile ayni ihtiyat)', () => {
    expect(resolveActivityState({ ...BASE, link: 'unknown', linkStalled: true })).toBe('waiting');
  });

  it('hicbiri degilse (baglaniyor) waiting', () => {
    expect(resolveActivityState({ ...BASE, link: 'unknown' })).toBe('waiting');
  });
});
