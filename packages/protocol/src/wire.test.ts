import { describe, expect, it } from 'vitest';

import {
  isProtocolCompatible,
  parseClientFrame,
  parseServerFrame,
  PROTOCOL_VERSION,
  ProtocolError,
} from './wire.js';

/**
 * Bu paket dosyanin kendi ifadesiyle "sistemin en degerli varligi": web, CLI,
 * iOS, watchOS, macOS ve Android istemcileri ayni sozlesmeyi konusur. Buna
 * ragmen 2026-08-15'e kadar TEK BIR TESTI YOKTU — yani alti istemci ailesini
 * baglayan sozlesmeyi hicbir mekanizma tutmuyordu, yalnizca dosyadaki yorumlar
 * tutuyordu. Yorum tavsiyedir, test garantidir.
 */

const SESSION = 'ses_abc123def456ghi789jk';
const MESSAGE = 'msg_abc123def456ghi789jk';
const TOOL_CALL = 'tc_abc123def456ghi789jkl';

describe('kimlik bicimleri', () => {
  it('istemcinin uydurdugu kisa messageId"yi REDDEDER', () => {
    // GERCEK ARIZA (2026-08-14 oncesi): masaustu istemcisi `msg_local_1`
    // uretiyordu; regex ihlali yuzunden HER prompt sessizce reddedildi ve
    // belirti "Smith konusmuyor" seklinde gorundu. Bicim burada kilitlenir ki
    // bir istemci yeniden ayni kisayolu bulmasin.
    expect(() =>
      parseClientFrame({
        type: 'prompt',
        sessionId: SESSION,
        messageId: 'msg_local_1',
        content: [{ kind: 'text', text: 'merhaba' }],
      }),
    ).toThrow(ProtocolError);
  });

  it('gecerli kimlikleri kabul eder', () => {
    const frame = parseClientFrame({
      type: 'prompt',
      sessionId: SESSION,
      messageId: MESSAGE,
      content: [{ kind: 'text', text: 'merhaba' }],
    });

    expect(frame.type).toBe('prompt');
  });

  it('onek karisikligini yakalar — oturum kimligi mesaj alanina konamaz', () => {
    expect(() =>
      parseClientFrame({
        type: 'prompt',
        sessionId: SESSION,
        messageId: SESSION,
        content: [{ kind: 'text', text: 'merhaba' }],
      }),
    ).toThrow(ProtocolError);
  });
});

describe('istemci frame"leri', () => {
  it('hello, cancel, tool_result ve ping cozumlenir', () => {
    expect(
      parseClientFrame({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        surface: 'windows',
        clientVersion: '0.1.0',
      }).type,
    ).toBe('hello');

    expect(parseClientFrame({ type: 'cancel', sessionId: SESSION, messageId: MESSAGE }).type).toBe(
      'cancel',
    );

    expect(
      parseClientFrame({
        type: 'tool_result',
        sessionId: SESSION,
        toolCallId: TOOL_CALL,
        ok: true,
        result: { konum: 'gizli' },
      }).type,
    ).toBe('tool_result');

    expect(parseClientFrame({ type: 'ping', at: 0 }).type).toBe('ping');
  });

  it('bos icerikli prompt kabul edilmez', () => {
    expect(() =>
      parseClientFrame({
        type: 'prompt',
        sessionId: SESSION,
        messageId: MESSAGE,
        content: [],
      }),
    ).toThrow(ProtocolError);
  });

  it('toplam prompt metni 32.000 karakteri asamaz', () => {
    expect(() =>
      parseClientFrame({
        type: 'prompt',
        sessionId: SESSION,
        messageId: MESSAGE,
        content: [
          { kind: 'text', text: 'a'.repeat(20_000) },
          { kind: 'text', text: 'b'.repeat(12_001) },
        ],
      }),
    ).toThrow(ProtocolError);

    expect(
      parseClientFrame({
        type: 'prompt',
        sessionId: SESSION,
        messageId: MESSAGE,
        content: [{ kind: 'text', text: 'a'.repeat(32_000) }],
      }).type,
    ).toBe('prompt');

    expect(() =>
      parseClientFrame({
        type: 'prompt',
        sessionId: SESSION,
        messageId: MESSAGE,
        content: [
          { kind: 'text', text: 'a'.repeat(16_000) },
          { kind: 'text', text: 'b'.repeat(16_000) },
        ],
      }),
    ).toThrow(ProtocolError);
  });

  it('bilinmeyen frame tipi sessizce gecmez', () => {
    expect(() => parseClientFrame({ type: 'kendi_uydurdugum_tip' })).toThrow(ProtocolError);
    expect(() => parseClientFrame(null)).toThrow(ProtocolError);
    expect(() => parseClientFrame('merhaba')).toThrow(ProtocolError);
  });

  it('hata protocol_mismatch kodunu tasir', () => {
    try {
      parseClientFrame({ type: 'ping' });
      expect.unreachable('cozumlenmemeliydi');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe('protocol_mismatch');
    }
  });
});

describe('sunucu frame"leri', () => {
  it('ready, delta, usage, done, error ve pong cozumlenir', () => {
    expect(
      parseServerFrame({
        type: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: SESSION,
        capabilities: ['chat'],
      }).type,
    ).toBe('ready');

    expect(
      parseServerFrame({ type: 'delta', sessionId: SESSION, messageId: MESSAGE, text: 'me' }).type,
    ).toBe('delta');

    expect(
      parseServerFrame({
        type: 'usage',
        sessionId: SESSION,
        messageId: MESSAGE,
        inputTokens: 10,
        outputTokens: 20,
        costMicros: 0,
      }).type,
    ).toBe('usage');

    expect(
      parseServerFrame({
        type: 'done',
        sessionId: SESSION,
        messageId: MESSAGE,
        stopReason: 'end_turn',
      }).type,
    ).toBe('done');

    expect(parseServerFrame({ type: 'error', code: 'tool_denied', message: 'olmaz' }).type).toBe(
      'error',
    );

    expect(parseServerFrame({ type: 'pong', at: 1 }).type).toBe('pong');
  });

  it('tool_call onay bayragi verilmezse VARSAYILAN OLARAK KAPALIDIR', () => {
    // Guvenlik varsayilani: onay alani eksikse "onay gerekmiyor" degil,
    // "onay istenmemis" anlamina gelir ve istemci arac calistirmaz varsayimina
    // dayanmaz. Bayragin varsayilani sessizce true"ya kayarsa istemciler
    // onay UI"ini atlar; bu yuzden deger burada kilitlidir.
    const frame = parseServerFrame({
      type: 'tool_call',
      sessionId: SESSION,
      messageId: MESSAGE,
      toolCallId: TOOL_CALL,
      name: 'sistem_durumu',
      input: {},
    });

    expect(frame.type).toBe('tool_call');
    if (frame.type === 'tool_call') {
      expect(frame.requiresApproval).toBe(false);
    }
  });

  it('onay istendiginde bayrak tasinir', () => {
    const frame = parseServerFrame({
      type: 'tool_call',
      sessionId: SESSION,
      messageId: MESSAGE,
      toolCallId: TOOL_CALL,
      name: 'terminal',
      input: { komut: 'Get-Process' },
      requiresApproval: true,
    });

    if (frame.type === 'tool_call') {
      expect(frame.requiresApproval).toBe(true);
    }
  });
});

describe('icerik parcalari', () => {
  it('buyuk ikili veri wire"da tasinmaz, referans tasinir', () => {
    // Bu bir performans tercihi degil sozlesme invariant"i: goruntu ve dosya
    // icerigi frame"e gomulurse hem WS cerceve siniri hem de log/tracing
    // yuzeyi patlar. Sema yalnizca blobRef kabul eder.
    const frame = parseClientFrame({
      type: 'prompt',
      sessionId: SESSION,
      messageId: MESSAGE,
      content: [
        { kind: 'image', mediaType: 'image/jpeg', blobRef: 'blob_1' },
        {
          kind: 'file',
          name: 'a.pdf',
          mediaType: 'application/pdf',
          blobRef: 'blob_2',
          sizeBytes: 3,
        },
      ],
    });

    if (frame.type === 'prompt') {
      expect(frame.content).toHaveLength(2);
      expect(frame.content[0]).not.toHaveProperty('data');
    }

    // Ham veri gondermeye calisan istemci reddedilir (blobRef eksik).
    expect(() =>
      parseClientFrame({
        type: 'prompt',
        sessionId: SESSION,
        messageId: MESSAGE,
        content: [{ kind: 'image', mediaType: 'image/jpeg', data: 'AAAA' }],
      }),
    ).toThrow(ProtocolError);
  });

  it('negatif dosya boyutu kabul edilmez', () => {
    expect(() =>
      parseClientFrame({
        type: 'prompt',
        sessionId: SESSION,
        messageId: MESSAGE,
        content: [
          { kind: 'file', name: 'a', mediaType: 'text/plain', blobRef: 'b', sizeBytes: -1 },
        ],
      }),
    ).toThrow(ProtocolError);
  });
});

describe('geriye donuk uyumluluk sozlesmesi', () => {
  it('yeni istemcinin ekledigi BILINMEYEN alan eski sunucuyu dusurmez', () => {
    // Dosyanin kurali: "buraya eklenen her alan geriye donuk uyumlu olmak
    // zorundadir". Bu kuralin islemesi, bilinmeyen alanlarin HATA degil
    // yok sayma uretmesine baglidir. Sema `strict` yapilirsa kural sessizce
    // bozulur ve yeni istemci eski sunucuya baglanamaz — test onu tutar.
    const frame = parseClientFrame({
      type: 'cancel',
      sessionId: SESSION,
      messageId: MESSAGE,
      gelecektenGelenAlan: 'onemli',
    });

    expect(frame.type).toBe('cancel');
    expect(frame).not.toHaveProperty('gelecektenGelenAlan');
  });

  it('surum uyumlulugu tam esitlik ister', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolCompatible(PROTOCOL_VERSION + 1)).toBe(false);
    expect(isProtocolCompatible(PROTOCOL_VERSION - 1)).toBe(false);
  });
});
