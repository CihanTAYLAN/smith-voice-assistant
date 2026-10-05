import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type * as React from 'react';

import { Hud, type HudProps } from './Hud.js';
import {
  defaultListen,
  emit,
  find,
  findAll,
  fire,
  host,
  hookRunner,
  installHost,
  listen,
  removeHost,
  settle,
  textOf,
  type TreeElement,
} from './hookTestHost.js';
import { loadToolLabels, useLiveVoice } from './useLiveVoice.js';

// Node ortaminda hook state/effect surucusu (bkz. hookTestHost.ts). Gercek Tauri
// listener'lari ve komut siniri sahtedir; hook'un olay isleyicileri ve HUD
// dugmesi gercektir.
const t = await vi.hoisted(() => import('./hookTestHost.js'));
vi.mock('react', async (original) => t.reactWithHost(await original<typeof React>()));
vi.mock('@tauri-apps/api/core', () => ({ invoke: t.host.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: t.listen }));

const hook = hookRunner(useLiveVoice);
const Render = hook.render;

beforeEach(async () => {
  installHost();
  // Basarisiz komutlar maskeli olarak console'a yazilir; test ciktisini kirletmesin.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  host.invoke.mockImplementation((cmd: string) =>
    Promise.resolve(
      cmd === 'tool_labels'
        ? { kod_gorevi_durum: 'kod gorevinin durumunu okuyor…' }
        : cmd === 'listen_mode_get'
          ? 'herkes'
          : false,
    ),
  );
  await hook.mount();
});
afterEach(() => {
  hook.unmount();
  removeHost();
  vi.restoreAllMocks();
});

describe('Live HUD olay ve komut baglantisi', () => {
  it('ilk acilista otoriter Live durumunu komutla okur', async () => {
    hook.unmount();
    host.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === 'tool_labels'
          ? {}
          : cmd === 'listen_mode_get'
            ? 'herkes'
            : cmd === 'live_status_get'
              ? { connected: true }
              : false,
      ),
    );
    await hook.mount();
    await settle();
    expect(host.invoke).toHaveBeenCalledWith('live_status_get', {});
    expect(Render().link).toBe('up');
  });

  it('anlik goruntu surerken gelen daha yeni olayi eski yanitla ezmez', async () => {
    hook.unmount();
    let resolveStatus: (status: { connected: boolean }) => void = () => {};
    const pendingStatus = new Promise<{ connected: boolean }>((resolve) => {
      resolveStatus = resolve;
    });
    host.invoke.mockImplementation((cmd: string) =>
      cmd === 'tool_labels'
        ? Promise.resolve({})
        : cmd === 'listen_mode_get'
          ? Promise.resolve('herkes')
          : cmd === 'live_status_get'
            ? pendingStatus
            : Promise.resolve(false),
    );
    await hook.mount();
    await settle();
    emit('audio://live-status', { connected: true });
    resolveStatus({ connected: false });
    await settle();
    expect(Render().link).toBe('up');
  });

  it('arac etiketini Rust komutundan alir, bilinmeyen adi korur', () => {
    expect(host.invoke).toHaveBeenCalledWith('tool_labels');
    emit('audio://tool', { ad: 'kod_gorevi_durum', durum: 'basladi' });
    expect(Render().tools[0]?.label).toBe('kod gorevinin durumunu okuyor…');
    emit('audio://tool', { ad: 'yeni_arac', durum: 'basladi' });
    expect(Render().tools[1]?.label).toBe('yeni_arac');
  });

  it('baglanti ve oynatma kurtarmasini HUD icin gorunur tutar', () => {
    emit('audio://tool', {
      ad: 'baglanti_kurtarma',
      durum: 'bitti',
      sebep: 'Bağlantı yenilendi; son söylediğin yeniden gönderildi.',
    });
    expect(Render().playbackNotice).toContain('yeniden gönderildi');

    emit('audio://playback-status', {
      durum: 'retrying',
      deneme: 3,
      kayipMs: 0,
    });
    expect(Render().playbackNotice).toContain('3. deneme');

    emit('audio://playback-status', {
      durum: 'cleared',
      deneme: 0,
      kayipMs: 420,
      sebep: 'device_rate_changed',
    });
    expect(Render().playbackNotice).toContain("420 ms'lik");

    emit('audio://playback-status', {
      durum: 'recovered',
      deneme: 3,
      kayipMs: 0,
      cihaz: 'Speakers',
    });
    expect(Render().playbackNotice).toBe('Ses çıkışı yeniden kuruldu: Speakers.');
  });

  it('30 saniyelik bekciye kadar uzun turu dusunuyor gosterir', () => {
    emit('audio://live', { role: 'user', text: 'Uzun bir soru.', interrupted: false });
    vi.advanceTimersByTime(25_000);
    expect(Render().thinking).toBe(true);
    vi.advanceTimersByTime(7_000);
    expect(Render().thinking).toBe(false);
  });

  it('geciken etiket komutu erken arac ve ret olaylarini kaybetmez', async () => {
    hook.unmount();
    let resolveLabels: (labels: Record<string, string>) => void = () => {};
    const labels = new Promise<Record<string, string>>((resolve) => {
      resolveLabels = resolve;
    });
    host.invoke.mockImplementation((cmd: string) =>
      cmd === 'tool_labels'
        ? labels
        : Promise.resolve(cmd === 'listen_mode_get' ? 'herkes' : false),
    );
    await hook.mount();
    emit('audio://tool', { ad: 'erken_arac', durum: 'basladi' });
    emit('audio://tool', { ad: 'erken_ret', durum: 'reddedildi' });
    expect(Render().tools[0]?.label).toBe('erken_arac');
    expect(Render().refusal?.label).toBe('erken_ret');
    resolveLabels({ erken_arac: 'calisiyor', erken_ret: 'reddedildi' });
    await settle();
    expect(Render().tools[0]?.label).toBe('calisiyor');
    expect(Render().refusal?.label).toBe('reddedildi');
  });

  it('ayni anda gelen etiket isteklerini tek komuta indirir, bitince yeniden okur', async () => {
    host.invoke.mockClear();
    await Promise.all([loadToolLabels(), loadToolLabels()]);
    expect(host.invoke.mock.calls.filter(([cmd]) => cmd === 'tool_labels')).toHaveLength(1);
    await loadToolLabels();
    expect(host.invoke.mock.calls.filter(([cmd]) => cmd === 'tool_labels')).toHaveLength(2);
  });

  it('dinleme modu acilista okunur, sesli arac ve tepsi ayni durumu gunceller', () => {
    expect(host.invoke).toHaveBeenCalledWith('listen_mode_get');
    expect(Render().owner).toEqual({ kip: 'herkes', warning: null });
    emit('audio://tool', { ad: 'dinleme_modu_durumu', durum: 'yalniz_beni' });
    expect(Render().owner?.kip).toBe('yalniz_beni');
    expect(Render().tools).toEqual([]);
    emit('audio://listen-mode', { kip: 'herkes' });
    expect(Render().owner?.kip).toBe('herkes');
  });

  it('oyun modu tepsi ve sesli aractan gelir, STT uyarisi kalicidir', () => {
    emit('audio://listen-mode', { kip: 'isimle' });
    expect(Render().owner?.kip).toBe('isimle');
    emit('audio://tool', {
      ad: 'dinleme_modu_durumu',
      durum: 'isimle',
      sebep: 'adla seslenme algilanamiyor (yerel STT yok)',
    });
    vi.advanceTimersByTime(60_000);
    expect(Render().owner?.warning).toContain('yerel STT yok');
    expect(Render().tools).toEqual([]);
    emit('audio://tool', { ad: 'dinleme_modu_durumu', durum: 'isimle' });
    expect(Render().owner?.warning).toBeNull();
    emit('audio://listen-mode', { kip: 'herkes' });
    expect(Render().owner?.kip).toBe('herkes');
  });

  it('oyun modu komutu enum yollar ve boolean yaniti kabul etmez', async () => {
    host.invoke.mockResolvedValueOnce('isimle');
    Render().ownerListening.setMode('isimle');
    await settle();
    expect(host.invoke).toHaveBeenCalledWith('listen_mode_set', { kip: 'isimle' });
    expect(Render().owner?.kip).toBe('isimle');
    host.invoke.mockResolvedValueOnce(true);
    Render().ownerListening.setMode('herkes');
    await settle();
    expect(Render().owner?.kip).toBe('isimle');
    expect(Render().ownerListening.error).toContain('değiştirilemedi');
  });

  it('ses izi uyarisini kalici gosterir, mod kapatilinca temizler', () => {
    emit('audio://tool', {
      ad: 'dinleme_modu_durumu',
      durum: 'yalniz_beni',
      sebep: 'Ses izi dogrulanamadi: bu ifade buluta gonderilmedi.',
    });
    vi.advanceTimersByTime(60_000);
    expect(Render().owner?.warning).toContain('buluta gonderilmedi');
    expect(Render().linkError).toBeNull();
    emit('audio://listen-mode', { kip: 'herkes' });
    expect(Render().owner?.warning).toBeNull();
  });

  it('dinleme dugmesi dogru komutu cagirir, beklerken ikinci cagriyi engeller', async () => {
    let finish: ((value: string) => void) | undefined;
    host.invoke.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    Render().ownerListening.setMode('yalniz_beni');
    Render().ownerListening.setMode('yalniz_beni');
    expect(host.invoke.mock.calls.filter(([cmd]) => cmd === 'listen_mode_set')).toEqual([
      ['listen_mode_set', { kip: 'yalniz_beni' }],
    ]);
    expect(Render().ownerListening.pending).toBe(true);
    emit('audio://tool', { ad: 'dinleme_modu_durumu', durum: 'herkes' });
    finish?.('yalniz_beni');
    await settle();
    expect(Render().owner?.kip).toBe('herkes');
    expect(Render().ownerListening.pending).toBe(false);
  });

  it('dinleme komut hatasi modu iyimser degistirmez', async () => {
    host.invoke.mockRejectedValueOnce(new Error('host error'));
    Render().ownerListening.setMode('yalniz_beni');
    await settle();
    expect(Render().owner?.kip).toBe('herkes');
    expect(Render().ownerListening.error).toContain('değiştirilemedi');
  });

  it('bozuk dinleme olayi mevcut modu degistirmez', () => {
    emit('audio://listen-mode', { kip: 'evet' });
    emit('audio://tool', { ad: 'dinleme_modu_durumu', durum: 'bozuk' });
    expect(Render().owner?.kip).toBe('herkes');
  });

  it('baglanti hatasi 8 sn sonra kalir, yalniz basarili baglantida temizlenir', () => {
    emit('audio://tool', {
      ad: 'live_baglanti',
      durum: 'hata',
      sebep:
        'kota veya yuk siniri (Gemini Live); kod=1011 sebep=quota; 30 sn sonra yeniden denenecek',
    });
    expect(Render().linkError).toMatchObject({ kind: 'kota', retrySec: 30 });
    vi.advanceTimersByTime(8001);
    emit('audio://live-status', { connected: false });
    expect(Render().linkError).not.toBeNull();
    expect(Render().refusal).toBeNull();
    expect(Render().tools).toEqual([]);
    emit('audio://live-status', { connected: true });
    expect(Render().linkError).toBeNull();
  });

  it('VAD arizasi HUD uyarisina ulasir ve baglanti kopmus gibi gosterilmez', () => {
    emit('audio://live-status', { connected: true });
    emit('audio://tool', {
      ad: 'mikrofon_akisi',
      durum: 'hata',
      sebep: 'mikrofon kapisi arizalandi: bu oturumda surekli ses aktarimi kullaniliyor',
    });
    expect(Render().link).toBe('up');
    expect(Render().linkError).toMatchObject({ kind: 'mikrofon', retrySec: null });
    expect(Render().linkError?.text).toContain('sürekli ses');
    expect(Render().tools).toEqual([]);
  });

  it('olay koprusu kurulamazsa Live koptu demez, olay koprusu hatasi gosterir', async () => {
    hook.unmount();
    listen.mockImplementation((name, listener) =>
      name === 'audio://vad'
        ? Promise.reject(new Error('token=private'))
        : defaultListen(name, listener),
    );
    await hook.mount();
    expect(Render().linkError).toMatchObject({ kind: 'olaylar' });
    expect(Render().linkError?.text).not.toContain('Gemini');
    // Kismen kurulan dinleyiciler birakilir: yarim bir abonelik kalmaz.
    expect(host.listeners.has('audio://live')).toBe(false);
    expect(host.listeners.has('audio://tool')).toBe(false);
  });

  it('ilk ekran olayini beklemeden sesli arac ve tepsi ayni durumu gunceller', () => {
    emit('audio://tool', { ad: 'ekran_akisi_durumu', durum: 'akis_acik' });
    expect(Render().screen?.aktif).toBe(true);
    emit('audio://screen-stream', { acik: false });
    expect(Render().screen?.aktif).toBe(false);
    emit('audio://screen', { aktif: true, aralikMs: 2000 });
    expect(Render().screen).toEqual({ aktif: true, aralikMs: 2000 });
    expect(Render().tools).toEqual([]);
  });

  it('ses izi karari onceki arac kararinin suresini tazeler', async () => {
    emit('audio://tool', { ad: 'hafizaya_kaydet', durum: 'bitti' });
    await vi.advanceTimersByTimeAsync(50_000);
    emit('audio://speaker', { karar: 'owner' });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(Render().memoryWrite).toBe('allowed');
    await vi.advanceTimersByTimeAsync(50_000);
    expect(Render().memoryWrite).toBe('unknown');
  });

  it('yalniz ses izi karari sure dolunca bayatlar', async () => {
    emit('audio://speaker', { karar: 'owner' });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(Render().memoryWrite).toBe('unknown');
  });

  it('bekleyen komuta ikinci tiklama eklemez, gec yanit yeni olayi ezmez', async () => {
    let finish: ((value: boolean) => void) | undefined;
    host.invoke.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const control = Render().screenStream;
    control.toggle();
    control.toggle();
    expect(host.invoke.mock.calls.filter(([cmd]) => cmd === 'screen_stream_set')).toHaveLength(1);
    expect(Render().screenStream.pending).toBe(true);
    emit('audio://tool', { ad: 'ekran_akisi_durumu', durum: 'akis_kapali' });
    finish?.(true);
    await settle();
    expect(Render().screen?.aktif).toBe(false);
    expect(Render().screenStream.pending).toBe(false);
  });

  it.each(['audio://screen-stream', 'audio://tool'])(
    'audit 7: %s basarisi eski hatayi temizler',
    async (event) => {
      host.invoke.mockRejectedValueOnce(new Error('invoke failed'));
      Render().screenStream.toggle();
      await settle();
      expect(Render().screenStream.error).not.toBeNull();
      emit(
        event,
        event === 'audio://tool'
          ? { ad: 'ekran_akisi_durumu', durum: 'akis_acik' }
          : { acik: true },
      );
      expect(Render().screen?.aktif).toBe(true);
      expect(Render().screenStream.error).toBeNull();
    },
  );

  it.each(['audio://screen-stream', 'audio://tool'])(
    'ilk okuma hatasindan sonra %s recovery',
    async (event) => {
      hook.unmount();
      host.listeners.clear();
      host.invoke.mockRejectedValueOnce(new Error('temporary read failure'));
      await hook.mount();
      expect(Render().screenStream.error).toContain('okunamadı');
      emit(
        event,
        event === 'audio://tool'
          ? { ad: 'ekran_akisi_durumu', durum: 'akis_acik' }
          : { acik: true },
      );
      expect(Render().screen?.aktif).toBe(true);
      expect(Render().screenStream.error).toBeNull();
    },
  );

  it('komut hatasi gorunur, ekran kapandi diye iyimser durum uretmez', async () => {
    emit('audio://screen-stream', { acik: true });
    host.invoke.mockRejectedValueOnce(new Error('invoke failed'));
    Render().screenStream.toggle();
    await settle();
    expect(Render().screen?.aktif).toBe(true);
    expect(Render().screenStream.error).toContain('değiştirilemedi');
    expect(Render().screenStream.pending).toBe(false);
  });
});

describe('HUD panosu', () => {
  const noop = (): void => {};

  /** `Hud` hook kullanmaz: dogrudan cagirip donen eleman agacini inceleriz. */
  function hudTree(overrides: Partial<HudProps> = {}): ReactNode {
    const live = Render();
    return Hud({
      signals: [],
      state: 'hazir',
      listening: false,
      micReady: true,
      mixer: {
        ready: true,
        micMuted: false,
        outputMuted: false,
        outputVolume: 1,
        micRms: 0,
        onToggleMicMute: noop,
        onToggleOutputMute: noop,
        onOutputVolume: noop,
      },
      screenStream: live.screenStream,
      owner: live.owner,
      ownerListening: live.ownerListening,
      screen: live.screen,
      linkError: live.linkError,
      collapsed: false,
      framed: false,
      onCollapse: noop,
      onToggleMic: noop,
      onOpenMission: noop,
      onGrab: noop,
      onFrame: noop,
      onQuit: noop,
      hover: { onPointerEnter: noop, onPointerLeave: noop },
      ...overrides,
    });
  }

  it('HUD ekran dugmesi dogru komutu cagirir ve Rust yanitini uygular', async () => {
    const tree = hudTree();
    for (const label of ['Herkesi dinle', 'Yalnız adımla (oyun modu)']) {
      expect(find(tree, byLabel(label))).toBeDefined();
    }
    host.invoke.mockResolvedValue(true);
    fire(find(tree, byLabel('Ekran akışı')), 'onClick');
    await settle();
    expect(host.invoke).toHaveBeenCalledWith('screen_stream_set', { acik: true });
    expect(Render().screen?.aktif).toBe(true);
    host.invoke.mockResolvedValue('yalniz_beni');
    fire(find(tree, byLabel('Yalnız beni dinle')), 'onClick');
    await settle();
    expect(host.invoke).toHaveBeenCalledWith('listen_mode_set', { kip: 'yalniz_beni' });
    expect(Render().owner?.kip).toBe('yalniz_beni');
  });

  it('acikken tum ayrinti kontrollerini gosterir', () => {
    const tree = hudTree();
    expect(labelsOf(tree)).toEqual(
      expect.arrayContaining([
        'Dinleme kipi',
        'Ekran akışı',
        'Ses düzeyleri',
        'Mikrofonu kapat',
        'Sesi kapat',
        'Smith ses düzeyi',
      ]),
    );
    for (const text of ['Zihninde ne var', 'dinlemeye başla', 'hazir']) {
      expect(textOf(tree)).toContain(text);
    }
  });

  it('daraltilmis HUD yalniz marka, durum ve pencere kontrollerini tutar', () => {
    const tree = hudTree({ collapsed: true });
    const labels = labelsOf(tree);
    for (const hidden of [
      'Dinleme kipi',
      'Ekran akışı',
      'Ses düzeyleri',
      'Mikrofonu kapat',
      'Smith ses düzeyi',
    ]) {
      expect(labels).not.toContain(hidden);
    }
    expect(textOf(tree)).not.toContain('Zihninde ne var');
    expect(textOf(tree)).not.toContain('dinlemeye başla');
    // Durum satiri ve kacis kapilari daraltilmis panoda da durur.
    expect(textOf(tree)).toContain('hazir');
    expect(labels).toEqual(expect.arrayContaining(['Panoyu aç', "Smith'i kapat"]));
  });

  it('daraltilmis olsa da pencere komutu hatalari gorunur kalir', () => {
    const tree = hudTree({ collapsed: true, windowError: 'Dashboard açılamadı. Yeniden dene.' });
    expect(textOf(tree)).toContain('Dashboard açılamadı. Yeniden dene.');
  });

  it('sustur komutu ucundayken ses kaydiricisini asla kilitlemez', () => {
    const tree = hudTree({
      mixer: {
        ready: true,
        pending: true,
        micMuted: false,
        outputMuted: false,
        outputVolume: 0.5,
        micRms: 0,
        onToggleMicMute: noop,
        onToggleOutputMute: noop,
        onOutputVolume: noop,
      },
    });
    expect(
      find(tree, (element) => element.props.className === 'mix-vol').props.disabled,
    ).toBeUndefined();
    expect(find(tree, byLabel('Mikrofonu kapat')).props.disabled).toBe(true);
  });
});

/** `aria-label`i verilen eleman. */
const byLabel =
  (label: string) =>
  (element: TreeElement): boolean =>
    element.props['aria-label'] === label;

/** Agactaki tum `aria-label`ler. */
const labelsOf = (tree: ReactNode): string[] =>
  findAll(tree, (element) => typeof element.props['aria-label'] === 'string').map((element) =>
    String(element.props['aria-label']),
  );
