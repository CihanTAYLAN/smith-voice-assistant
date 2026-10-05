import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConversationStream, VISIBLE_LINES } from './ConversationStream.js';
import { buildSignals, noticeFor, sessionState, toFaceState } from './hudState.js';
import { MindDialogView } from './MindDialog.js';
import { StatusBar } from './StatusBar.js';
import { type MindDump } from './useMindDump.js';

const noop = (): void => {};
const hover = { onPointerEnter: noop, onPointerLeave: noop };

describe('MindDialogView', () => {
  const render = (dump: MindDump): string =>
    renderToStaticMarkup(
      <MindDialogView
        dump={dump}
        onRetry={noop}
        onClose={noop}
        fallbackFocus={{ current: null }}
      />,
    );

  it('adli yerel dialog olarak cizilir', () => {
    const html = render({ status: 'loading' });
    expect(html).toContain('<dialog');
    expect(html).toContain('aria-labelledby="mind-title"');
    expect(html).toContain('aria-label="Zihin dökümünü kapat"');
  });

  it('okunuyor, bos, hata ve icerik durumlarini ayirir', () => {
    expect(render({ status: 'loading' })).toContain('Bağlam okunuyor');
    const empty = render({ status: 'empty' });
    expect(empty).toContain('Henüz bağlam bulunmuyor');
    expect(empty).not.toContain('okunuyor');
    const failed = render({ status: 'error' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Yeniden dene');
    expect(failed).not.toContain('okunuyor');
    const ready = render({ status: 'ready', text: 'Yeni bağlam' });
    expect(ready).toContain('Yeni bağlam');
    // Kaydirilabilir metin klavyeyle odaklanabilmeli.
    expect(ready).toContain('tabindex="0"');
    expect(ready).not.toContain('Henüz bağlam');
  });
});

describe('ConversationStream', () => {
  const lines = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `l${index}`,
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `replik ${index}`,
    }));
  const render = (props: Partial<Parameters<typeof ConversationStream>[0]> = {}): string =>
    renderToStaticMarkup(
      <ConversationStream lines={[]} capturing={false} visible hover={hover} {...props} />,
    );

  it('her konusmaciyi ekran okuyucuya adlandirir ve kesilen cevabi isaretler', () => {
    const html = render({
      lines: [
        { id: 'a', role: 'user', text: 'Merhaba' },
        { id: 'b', role: 'assistant', text: 'Selam efendim', interrupted: true },
      ],
    });
    expect(html).toContain('aria-label="Konuşma izi"');
    expect(html).toContain('sen:');
    expect(html).toContain('Smith:');
    expect(html).toContain('kesildi');
    expect(html).toContain('data-depth="0"');
  });

  it('yalniz son replikleri gosterir, en yenisi tam parlaklikta', () => {
    const html = render({ lines: lines(VISIBLE_LINES + 3) });
    expect(html).not.toContain('replik 0');
    expect(html).toContain(`replik ${VISIBLE_LINES + 2}`);
    expect(html.match(/class="bubble"/g)).toHaveLength(VISIBLE_LINES);
  });

  it('konusma ipucunu yalniz dinlerken ve henuz soz yokken sunar', () => {
    expect(render({ capturing: true })).toContain('sözümü kesebilirsin');
    expect(render({ capturing: false })).not.toContain('sözümü kesebilirsin');
    expect(render({ capturing: true, lines: lines(1) })).not.toContain('sözümü kesebilirsin');
  });
});

describe('StatusBar', () => {
  it('yalniz title yerine klavyeyle acilan sinyal ayrintisi sunar', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        signals={[
          { id: 'mic', label: 'Mikrofon', value: 'açık', tone: 'live', hint: 'Ses gönderiliyor.' },
        ]}
      />,
    );
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('<p>Ses gönderiliyor.</p>');
    expect(html).not.toContain('title=');
  });

  it('gorunen deger yer tutucuysa ekran okuyucuya okunacak degeri verir', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        signals={[
          {
            id: 'memory',
            label: 'Hafıza',
            value: '?',
            tone: 'unknown',
            hint: 'Gözlem yok.',
            spoken: 'henüz gözlem yok',
          },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Hafıza: henüz gözlem yok"');
  });
});

describe('hudState metinleri', () => {
  const baseNotice = {
    micError: null,
    hostReady: true,
    capturing: true,
    deviceCount: 1,
    link: 'up' as const,
    linkStalled: false,
    linkError: null,
    playbackNotice: null,
    refusal: null,
  };

  it('mikrofon hazirlanirken "host yok" demez', () => {
    const signals = buildSignals({
      initializing: true,
      hostReady: false,
      capturing: false,
      deviceCount: 0,
      link: 'unknown',
      linkStalled: false,
      userSpeaking: false,
      assistantSpeaking: false,
      toolCount: 0,
      memoryWrite: 'unknown',
      micMuted: false,
      outputMuted: false,
      screen: null,
    });
    expect(signals.find((signal) => signal.id === 'mic')).toMatchObject({
      value: 'hazırlanıyor',
      tone: 'pending',
    });
  });

  it('ret nedenini kullanici bildiriminde asla gostermez', () => {
    const notice = noticeFor({
      ...baseNotice,
      refusal: { name: 'tool', label: 'tool', reason: 'token=private', memoryWrite: true },
    });
    expect(notice).toEqual({
      kind: 'gate',
      text: 'Hafızaya yazılmadı: ses izi doğrulanamadı. İstersen bir daha söyle.',
    });
  });

  it('cumleleri dogru Turkce karakterler ve buyuk harfle yazar', () => {
    expect(noticeFor({ ...baseNotice, hostReady: false })?.text).toBe(
      'Ses masaüstü uygulamasında çalışır; tarayıcı önizlemesinde mikrofon yoktur.',
    );
    expect(noticeFor({ ...baseNotice, deviceCount: 0 })?.text).toBe(
      'Giriş cihazı görünmüyor. Mikrofonu bağladıktan sonra pencereyi yeniden aç.',
    );
    expect(noticeFor({ ...baseNotice, link: 'down' })?.text).toBe(
      'Live oturumu kapandı. Dinlemeyi durdurup yeniden başlatmak yeni bir oturum kurar.',
    );
  });

  it('en kritik bildirim kazanir, ust uste yigilmaz', () => {
    const refusal = { name: 't', label: 't', reason: null, memoryWrite: false };
    expect(noticeFor({ ...baseNotice, micError: 'Mikrofon hazırlanamadı.', refusal })?.kind).toBe(
      'fault',
    );
    expect(noticeFor({ ...baseNotice, refusal })?.kind).toBe('gate');
    expect(noticeFor({ ...baseNotice, linkStalled: true })?.kind).toBe('info');
    expect(noticeFor({ ...baseNotice, playbackNotice: 'Ses çıkışı yeniden kuruluyor.' })).toEqual({
      kind: 'info',
      text: 'Ses çıkışı yeniden kuruluyor.',
    });
    expect(noticeFor(baseNotice)).toBeNull();
  });

  it('paralel araclari durum satirinda ozetler', () => {
    const input = {
      micError: null,
      hostReady: true,
      capturing: true,
      link: 'up' as const,
      linkStalled: false,
      assistantSpeaking: false,
      thinking: false,
      tools: [
        { id: 1, name: 'a', label: 'hafızama bakıyorum' },
        { id: 2, name: 'b', label: 'dosyayı okuyorum' },
      ],
    };
    expect(sessionState('researching', input)).toBe('hafızama bakıyorum (+1)');
  });

  it('faaliyetten yuz durumuna eslemeyi korur', () => {
    expect(toFaceState('waiting')).toBe('idle');
    expect(toFaceState('speaking')).toBe('speaking');
    expect(toFaceState('reading')).toBe('reading');
  });
});
