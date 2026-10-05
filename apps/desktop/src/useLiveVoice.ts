import { useEffect, useRef, useState } from 'react';

import {
  eventBridgeError,
  linkErrorAfterStatus,
  linkErrorFromTool,
  type LinkError,
} from './linkError.js';
import { logFailure } from './logFailure.js';
import { parseScreenToolEvent } from './screenStream.js';
import { callHost, hasTauri } from './tauriHost.js';
import {
  useListeningMode,
  parseListeningTool,
  type ListeningModeState,
  type ListeningModeControl,
} from './useOwnerListening.js';
import { useScreenStream, type ScreenState, type ScreenStreamControl } from './useScreenStream.js';
import { createSubscriptions } from './useTauriSubscriptions.js';
export type { ScreenState } from './useScreenStream.js';

/**
 * Gemini Live (speech-to-speech) oturumunun UI tarafi.
 *
 * Ses hattinin TAMAMI Rust'ta: mikrofon -> Live WS -> hoparlor. Burada yalniz
 * konusmanin yazili izi, baglanti durumu ve arac gorunurlugu tutulur. Webview'e
 * MIKROFON ACILMAZ (proje ilkesi) — bu hook salt dinleyicidir.
 *
 * TUKETILEN RUST OLAYLARI (kaynak: `src-tauri/src/lib.rs`)
 *
 * - `audio://live` — LiveTurn {role,text,interrupted}. Transkripsiyon parca
 *   parca akar; ayni rolun parcalari TEK satirda birikir.
 * - `audio://live-status` — {connected}. Setup tamamlaninca true; oturum hata
 *   alip kapandiginda false. Yani "henuz gelmedi" ile "kapandi" AYRI seylerdir;
 *   `link` bu ucunu (`unknown`/`up`/`down`) oldugu gibi tasir.
 * - `audio://tool` — {ad, durum, sebep?}. ALAN ADLARI TURKCE ve sabit (Rust'ta
 *   `rename_all` yok). Sozlesme: her cagri `basladi` ile acilir ve TEK bitis
 *   durumu alir — ya `bitti` (yurutuldu; arac hata donse bile) ya `reddedildi`
 *   (ses izi kapisi engelledi, `sebep` teknik gerekce). `reddedildi` geldiyse
 *   `bitti` GELMEZ; bu yuzden UI "yapildi" gostermez.
 * - `audio://vad` — {speaking}. OPSIYONEL: bu olay `spawn_transcription`
 *   icinde uretilir, ama Live modunda o hat HIC kosmaz (`audio_start` Live
 *   basariliysa erken doner). Dolayisiyla Live'da GELMEZ ve `userSpeaking`
 *   false kalir. Yerine tahmin URETMIYORUZ; UI bu sinyali "yok" kabul eder.
 *
 * SOZDE-ARAC OLAYLARI (`audio://tool`, gercek arac degil; `LiveEvent`e yeni
 * varyant eklenmedi, lib.rs exhaustive match):
 *
 * - `ad='live_baglanti', durum='hata', sebep` — PLANSIZ Live kapanisi. `linkError`
 *   durumuna yazilir (sinif + yeniden deneme suresi, bkz. `linkError.ts`) ve bir
 *   sonraki basarili baglantida (`audio://live-status` connected=true) temizlenir.
 *   8 sn'lik ret zamanlayicisi KULLANILMAZ: hata baglanti duzelene kadar dogrudur.
 * - `ad='ekran_akisi_durumu', durum='akis_acik'|'akis_kapali'` — surekli ekran
 *   akisinin calisma zamani degisimi (HUD dugmesi, tepsi ya da `ekran_akisi`
 *   sesli araci). `screen.aktif` buna gore guncellenir.
 *
 * Ekran durumu acilista komutla okunur; `audio://screen` Live baglaninca
 * durumu ve kare araligini tamamlar. Tum kaynaklar `useScreenStream`e yazilir.
 */

export type LiveRole = 'user' | 'assistant';

/** Live oturumunun baglanti durumu — `audio://live-status`'in dogrudan izi. */
export type LiveLink = 'unknown' | 'up' | 'down';

export interface LiveLine {
  id: string;
  role: LiveRole;
  text: string;
  /** Smith'in bu cevabi kullanici tarafindan kesildi. */
  interrupted?: boolean;
}

/** Su an calisan bir arac cagrisi. */
export interface ActiveTool {
  /**
   * Yerel kimlik. Olayda cagri kimligi YOK ve ayni arac paralel iki kez
   * calisabilir; ad tek basina bitisi eslestirmeye yetmez.
   */
  id: number;
  /** Ham arac adi (`ad`), or. "hafizada_ara". */
  name: string;
  /** Kullaniciya gosterilecek okunur etiket. */
  label: string;
}

/** Ses izi kapisinin reddettigi son cagri. */
export interface ToolRefusal {
  name: string;
  label: string;
  /** Teknik gerekce (`sebep`). Kullaniciya degil, tooltip'e/teshise gider. */
  reason: string | null;
  /** Reddedilen arac hafizaya YAZMA araci miydi. */
  memoryWrite: boolean;
}

/**
 * Hafizaya yazma yetkisinin SON GOZLENEN durumu. `unknown` = henuz gozlem yok
 * (tahmin edilmez); `blocked` = bir yazma cagrisi gercekten reddedildi;
 * `allowed` = bir yazma cagrisi gercekten yurutuldu.
 */
export type MemoryWriteState = 'unknown' | 'allowed' | 'blocked';

export interface LiveVoiceState {
  /**
   * `unknown` = oturum durumu henuz bildirilmedi (baglaniyor ya da Live hic
   * kurulmadi), `up` = kuruldu, `down` = kapandi/kurulamadi.
   */
  link: LiveLink;
  lines: LiveLine[];
  /**
   * Smith SU AN konusuyor mu. Cevap parcalari akarken true, son parcadan
   * SPEAK_TAIL_MS sonra false. Gorsellestirme paletini bu bayrak dondurur;
   * ses cikisinin RMS'ini UI'a ayrica tasimaya gerek kalmaz.
   */
  assistantSpeaking: boolean;
  /** Yerel VAD kullaniciyi konusurken duyuyor — YALNIZ basamakli hatta gelir. */
  userSpeaking: boolean;
  /**
   * Smith isliyor (dusunuyor). Live ayri bir sinyal vermedigi icin TURETILIR:
   * kullanicinin transkript parcalari bittikten THINK_AFTER_MS sonra, Smith'ten
   * ne metin ne ses gelmemisse model gercekten calisiyordur (Gemini'nin
   * konusma-sonu esigi Rust SunucuVad tarafindan belirlenir). Ilk asistan parcasi,
   * kesinti veya oturum kopmasi kapatir; cevap hic gelmezse THINK_CEILING_MS
   * sonra kendiliginden duser — asili kalan bir gosterge yanlis bilgidir.
   *
   * NOT: bu TURETME'dir. Arac calistigi ANDA ne oldugunu `tools` soyler ve
   * gosterimde ondan once gelir.
   */
  thinking: boolean;
  /** Acik arac cagrilari (paralel olabilir), baslama sirasinda. */
  tools: ActiveTool[];
  /** Son reddedilen cagri; REFUSAL_SHOW_MS sonra kendiliginden temizlenir. */
  refusal: ToolRefusal | null;
  memoryWrite: MemoryWriteState;
  /** Ekran akisi tercihi; ilk komut/olay gelmediyse null. */
  screen: ScreenState | null;
  screenStream: ScreenStreamControl;
  owner: ListeningModeState | null;
  ownerListening: ListeningModeControl;
  /** Son plansiz Live kapanisi; bir sonraki basarili baglantida null olur. */
  linkError: LinkError | null;
  /** Oynatma aygiti yeniden kurulurken ya da yeni toparlanmisken gorunen durum. */
  playbackNotice: string | null;
}

interface LiveTurn {
  role: LiveRole;
  text: string;
  interrupted: boolean;
}

interface LiveStatus {
  connected: boolean;
}

interface VadEvent {
  speaking: boolean;
}

interface ToolEvent {
  ad: string;
  /**
   * `basladi` | `bitti` | `reddedildi`. Tipi bilincli olarak `string`: bu deger
   * wire'dan geliyor; Rust yeni bir durum eklerse UI cokmemeli, bilmedigini
   * sessizce yok saymali.
   */
  durum: string;
  /** Yalniz `reddedildi` durumunda dolu; digerlerinde alan hic serilesmez. */
  sebep?: string;
}

interface PlaybackStatus {
  durum: 'cleared' | 'recovering' | 'retrying' | 'retry_failed' | 'recovered';
  deneme: number;
  kayipMs: number;
  cihaz?: string;
  sebep?: string;
}

interface Timers {
  speak: number | null;
  think: number | null;
  thinkCeiling: number | null;
  refusal: number | null;
  memory: number | null;
  playback: number | null;
}

/** Son asistan parcasindan sonra "konusuyor" bayraginin sonme suresi. */
const SPEAK_TAIL_MS = 700;
/** Kullanici parcasi bittikten sonra "isliyor" saymaya baslama gecikmesi. */
const THINK_AFTER_MS = 700;
/** "Isliyor" gostergesinin tavani: cevap gelmezse gosterge asili kalmaz. */
const THINK_CEILING_MS = 31_000;
/**
 * Bir arac gostergesinin tavani. Bitis olayi herhangi bir sebeple kaybolursa
 * (oturum koptu, kanal dustu) chip sonsuza kadar "calisiyor" demesin.
 */
const TOOL_TTL_MS = 30_000;
/** Ret mesajinin ekranda kalma suresi. */
const REFUSAL_SHOW_MS = 10_000;
/**
 * Hafiza-yazma gozleminin bayatlama suresi. `speaker.rs` icindeki
 * VERDICT_TTL_MS ile AYNI olmali: Rust bir ses izi kararini 60 sn sonra bayat
 * sayiyor, dolayisiyla UI'in ondan eski bir gozleme dayanip "yazma acik"
 * demesi dogrulanamaz bir iddia olur.
 */
const MEMORY_VERDICT_TTL_MS = 60_000;
/**
 * Bellekte tutulan satir tavani. Serit yalniz son bir kaci gosterir; saatler
 * suren bir oturumda diziyi sinirsiz buyutmek sizinti olur.
 */
const MAX_LINES = 200;

/** Rust arac tablosunun bu webview icin yuklenen etiketleri. */
let toolLabels: Readonly<Record<string, string>> = {};
let toolLabelsLoad: Promise<void> | null = null;

async function readToolLabels(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  toolLabels = await invoke<Record<string, string>>('tool_labels');
}

/**
 * Etiketleri yerel Rust tablosundan okur. Acilista iki dinleyici (durum ve
 * dusunce baloncugu) ayni anda ister: TEK komut ucusu paylasilir ve bitince
 * birakilir, boylece basarisiz bir okuma sonraki cagrida yeniden denenir.
 * Hata cagiran yuzeyde raporlanir.
 */
export function loadToolLabels(): Promise<void> {
  toolLabelsLoad ??= readToolLabels().finally(() => {
    toolLabelsLoad = null;
  });
  return toolLabelsLoad;
}

/**
 * Kalici yazma araclarinin UI'a ozel gosterimi (hafiza, hatirlatma, profil).
 * Yetki karari Rust arac tablosunun Hafiza sinifindan gelir; bu kume yalniz
 * gosterge ve ret metnini secer. Kume tablonun Hafiza sinifiyla BIREBIR ayni
 * olmali: ayrisirsa `toolTable.test.ts` kirmizi olur.
 *
 * DISA ACIK cunku dusunce baloncugu (`mindBubbles.ts`) ayni ayrimi yapiyor:
 * kalici yazma reddedildiginde mesaj farklidir. Liste TEK yerde durmali.
 */
export const MEMORY_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'hafizaya_kaydet_ACIK_TALEP_ILE',
  'hafizaya_kaydet',
  'hatirlatma_kur',
  'hatirlatma_iptal',
  'profil_kaydet',
  'profil_sil',
  'hafiza_sorusu_cevapla',
  'hafiza_sorusu_gec',
]);

let seq = 0;
let toolSeq = 0;

/** Arac adinin kullaniciya gosterilecek hali. */
export function toolLabel(ad: string): string {
  return toolLabels[ad] ?? ad;
}

/**
 * Yeni parcayi satirlara isler: ayni rol devam ediyorsa son satira ekler,
 * degistiyse yeni satir acar. SAF fonksiyon — id disaridan verilir, cunku
 * StrictMode updater'i iki kez cagirir ve sayaci burada artirsak ayni satir
 * iki farkli key alirdi.
 */
function appendChunk(
  lines: LiveLine[],
  turn: Pick<LiveTurn, 'role' | 'text'>,
  continues: boolean,
  id: string,
): LiveLine[] {
  const last = lines.length > 0 ? lines[lines.length - 1] : undefined;
  if (continues && last && last.role === turn.role) {
    return [...lines.slice(0, -1), { ...last, text: last.text + turn.text }];
  }
  const next = [...lines, { id, role: turn.role, text: turn.text }];
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

/** Kesinti geldiginde en son asistan satirini isaretler. */
function markLastAssistantInterrupted(lines: LiveLine[]): LiveLine[] {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line && line.role === 'assistant') {
      const copy = [...lines];
      copy[i] = { ...line, interrupted: true };
      return copy;
    }
  }
  return lines;
}

export function useLiveVoice(): LiveVoiceState {
  const { screen, apply: applyScreen, ...screenStream } = useScreenStream();
  const { owner, apply: applyOwner, ...ownerListening } = useListeningMode();
  const [state, setState] = useState<
    Omit<LiveVoiceState, 'screen' | 'screenStream' | 'owner' | 'ownerListening'>
  >({
    link: 'unknown',
    lines: [],
    assistantSpeaking: false,
    userSpeaking: false,
    thinking: false,
    tools: [],
    refusal: null,
    memoryWrite: 'unknown',
    linkError: null,
    playbackNotice: null,
  });

  const timers = useRef<Timers>({
    speak: null,
    think: null,
    thinkCeiling: null,
    refusal: null,
    memory: null,
    playback: null,
  });
  const openRole = useRef<LiveRole | null>(null);
  /**
   * Acik araclarin YETKILI listesi. State'in kopyasi degil kaynagi: bitis
   * olayini eslestirmek icin listeyi SENKRON okumam gerekiyor ve bunu setState
   * updater'i icinde yapmak StrictMode'da yan etki olurdu.
   */
  const openTools = useRef<ActiveTool[]>([]);
  const toolTimers = useRef(new Map<number, number>());

  useEffect(() => {
    let alive = true;
    const subscriptions = createSubscriptions();
    if (hasTauri()) {
      void loadToolLabels()
        .then(() => {
          if (!alive) return;
          openTools.current = openTools.current.map((tool) => ({
            ...tool,
            label: toolLabel(tool.name),
          }));
          setState((state) => ({
            ...state,
            tools: state.tools.map((tool) => ({ ...tool, label: toolLabel(tool.name) })),
            refusal: state.refusal
              ? { ...state.refusal, label: toolLabel(state.refusal.name) }
              : null,
          }));
        })
        .catch((error: unknown) => logFailure('live tool labels', error));
    }

    const t = timers.current;
    let liveStatusEventVersion = 0;
    // Ref'lerin KENDISI sabit (useRef bir kez kurdu); cleanup'ta `.current`
    // okumamak icin yerel degiskene aliyoruz — hem lint kurali bunu ister hem
    // de niyet netlesir: burada takip edilen sey DOM degil, zamanlayici tablosu.
    const toolTimer = toolTimers.current;

    const clear = (key: keyof Timers): void => {
      const id = t[key];
      if (id !== null) {
        window.clearTimeout(id);
        t[key] = null;
      }
    };
    const stopThinking = (): void => {
      clear('think');
      clear('thinkCeiling');
    };

    const publishTools = (next: ActiveTool[]): void => {
      openTools.current = next;
      setState((s) => ({ ...s, tools: next }));
    };

    const dropTool = (id: number): void => {
      const timer = toolTimer.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        toolTimer.delete(id);
      }
      publishTools(openTools.current.filter((tool) => tool.id !== id));
    };

    const dropAllTools = (): void => {
      toolTimer.forEach((timer) => window.clearTimeout(timer));
      toolTimer.clear();
      if (openTools.current.length > 0) publishTools([]);
    };

    const onTurn = (turn: LiveTurn): void => {
      if (!alive) return;
      clear('speak');

      if (turn.interrupted) {
        // Kullanici sozu kesti: Rust kuyruktaki sesi ANINDA atti, gosterge de
        // ayni anda dusmeli — yoksa susmus Smith'i "konusuyor" gosteririz.
        stopThinking();
        openRole.current = null;
        setState((s) => ({
          ...s,
          assistantSpeaking: false,
          thinking: false,
          lines: markLastAssistantInterrupted(s.lines),
        }));
        return;
      }

      const continues = openRole.current === turn.role;
      openRole.current = turn.role;
      seq += 1;
      const id = `lv${seq}`;

      if (turn.role === 'assistant') {
        // Cevap geldi: "isliyor" penceresi kapanir.
        stopThinking();
        t.speak = window.setTimeout(
          () => setState((s) => (s.assistantSpeaking ? { ...s, assistantSpeaking: false } : s)),
          SPEAK_TAIL_MS,
        );
        setState((s) => ({
          ...s,
          assistantSpeaking: true,
          thinking: false,
          lines: appendChunk(s.lines, turn, continues, id),
        }));
        return;
      }

      // Kullanici parcasi: her parca "isliyor" sayacini bastan kurar, boylece
      // kapi ancak konusma GERCEKTEN bittikten sonra acilir.
      stopThinking();
      t.think = window.setTimeout(() => {
        setState((s) => ({ ...s, thinking: true }));
        t.thinkCeiling = window.setTimeout(
          () => setState((s) => (s.thinking ? { ...s, thinking: false } : s)),
          THINK_CEILING_MS,
        );
      }, THINK_AFTER_MS);
      setState((s) => ({
        ...s,
        thinking: false,
        lines: appendChunk(s.lines, turn, continues, id),
      }));
    };

    const onStatus = (status: LiveStatus): void => {
      if (!alive) return;
      if (status.connected) {
        // Baglanti kuruldu: onceki baglanti hatasi artik gecersiz.
        setState((s) => {
          const linkError = linkErrorAfterStatus(s.linkError, true);
          return s.link === 'up' && linkError === s.linkError ? s : { ...s, link: 'up', linkError };
        });
        return;
      }
      // Oturum kapandi: konusma/isleme/arac gostergeleri asili kalmasin.
      clear('speak');
      stopThinking();
      dropAllTools();
      openRole.current = null;
      setState((s) => ({ ...s, link: 'down', assistantSpeaking: false, thinking: false }));
    };

    const onVad = (ev: VadEvent): void => {
      if (!alive) return;
      if (ev.speaking) stopThinking();
      setState((s) => {
        if (s.userSpeaking === ev.speaking) return s;
        return {
          ...s,
          userSpeaking: ev.speaking,
          thinking: ev.speaking ? false : s.thinking,
        };
      });
    };

    const setVerdict = (memoryWrite: MemoryWriteState): void => {
      if (!alive) return;
      clear('memory');
      setState((s) => ({ ...s, memoryWrite }));
      t.memory = window.setTimeout(
        () => setState((s) => ({ ...s, memoryWrite: 'unknown' })),
        MEMORY_VERDICT_TTL_MS,
      );
    };

    const onTool = (ev: ToolEvent): void => {
      if (!alive) return;
      if (ev.ad === 'baglanti_kurtarma' && ev.durum === 'bitti' && ev.sebep) {
        clear('playback');
        setState((s) => ({ ...s, playbackNotice: ev.sebep ?? null }));
        t.playback = window.setTimeout(
          () => setState((s) => ({ ...s, playbackNotice: null })),
          8_000,
        );
        return;
      }
      const ownerChange = parseListeningTool(ev);
      if (ownerChange) {
        applyOwner(ownerChange.kip, ownerChange.warning);
        return;
      }

      // Baglanti hatasi gercek bir arac degil: arac listesine/ret akisina
      // girmez, yalniz `linkError` durumuna yazilir.
      const linkError = linkErrorFromTool(ev);
      if (linkError !== null) {
        setState((s) => ({ ...s, linkError }));
        return;
      }

      // Ekran akisi degisimi: yine sozde-arac, arac listesine girmez.
      const akis = parseScreenToolEvent(ev);
      if (akis !== null) {
        applyScreen(akis);
        return;
      }

      const label = toolLabel(ev.ad);

      if (ev.durum === 'basladi') {
        toolSeq += 1;
        const id = toolSeq;
        toolTimer.set(
          id,
          window.setTimeout(() => dropTool(id), TOOL_TTL_MS),
        );
        publishTools([...openTools.current, { id, name: ev.ad, label }]);
        return;
      }

      const done = ev.durum === 'bitti';
      const refused = ev.durum === 'reddedildi';
      if (!done && !refused) return; // bilinmeyen durum: yok say, cokme.

      // Ayni addan paralel cagri olabilir; olayda cagri kimligi yok →
      // EN ESKI acik olani kapat (FIFO). Sayilar dogru kalir, hangi somut
      // cagrinin bittigi zaten kullaniciyi ilgilendirmiyor.
      const open = openTools.current.find((tool) => tool.name === ev.ad);
      if (open) dropTool(open.id);

      // Hafizaya yazma yetkisi: TAHMIN degil GOZLEM. Bir yazma cagrisi
      // reddedildiyse kapi kapali, yurutulduyse aciktir. Gozlem
      // MEMORY_VERDICT_TTL_MS sonra bayatlar (bkz. sabitin yorumu).
      if (MEMORY_WRITE_TOOLS.has(ev.ad)) {
        const verdict: MemoryWriteState = refused ? 'blocked' : 'allowed';
        setVerdict(verdict);
      }

      if (!refused) return;

      clear('refusal');
      t.refusal = window.setTimeout(
        () => setState((s) => (s.refusal ? { ...s, refusal: null } : s)),
        REFUSAL_SHOW_MS,
      );
      setState((s) => ({
        ...s,
        refusal: {
          name: ev.ad,
          label,
          reason: ev.sebep ?? null,
          memoryWrite: MEMORY_WRITE_TOOLS.has(ev.ad),
        },
      }));
    };

    const onPlayback = (ev: PlaybackStatus): void => {
      if (!alive) return;
      clear('playback');
      if (ev.durum === 'cleared') {
        if (ev.sebep === 'device_rate_changed' && ev.kayipMs > 0) {
          setState((s) => ({
            ...s,
            playbackNotice: `Ses aygıtı değişti; yanıtın ${ev.kayipMs} ms'lik bölümü atlandı.`,
          }));
          t.playback = window.setTimeout(
            () => setState((s) => ({ ...s, playbackNotice: null })),
            8_000,
          );
        }
        return;
      }

      if (ev.durum === 'recovered') {
        const cihaz = ev.cihaz ? `: ${ev.cihaz}` : '';
        setState((s) => ({ ...s, playbackNotice: `Ses çıkışı yeniden kuruldu${cihaz}.` }));
        t.playback = window.setTimeout(
          () => setState((s) => ({ ...s, playbackNotice: null })),
          8_000,
        );
        return;
      }

      const deneme = ev.deneme > 0 ? ` (${ev.deneme}. deneme)` : '';
      setState((s) => ({
        ...s,
        playbackNotice: `Ses çıkışı yeniden kuruluyor${deneme}; oturum açık kalacak.`,
      }));
    };

    void (async () => {
      if (!hasTauri()) return;
      const { listen } = await import('@tauri-apps/api/event');
      const connected = await subscriptions.connect([
        listen<LiveTurn>('audio://live', (e) => onTurn(e.payload)),
        listen<LiveStatus>('audio://live-status', (e) => {
          liveStatusEventVersion += 1;
          onStatus(e.payload);
        }),
        listen<VadEvent>('audio://vad', (e) => onVad(e.payload)),
        listen<ToolEvent>('audio://tool', (e) => onTool(e.payload)),
        listen<PlaybackStatus>('audio://playback-status', (e) => onPlayback(e.payload)),
        // Ses izi karari: hafizaya yazma yetkisini YAZMA DENEMESI BEKLEMEDEN
        // belirler ('owner' -> allowed, digerleri -> blocked). Kullanici
        // gostergenin "—" takili kalmasindan sikayet etti; kaynak gercegi budur.
        listen<{ karar: string }>('audio://speaker', (e) =>
          setVerdict(e.payload.karar === 'owner' ? 'allowed' : 'blocked'),
        ),
        // Baglantida durum + aralik; kopus ekran akisi tercihini kapatmaz.
        listen<{ aktif: boolean; aralikMs: number }>(
          'audio://screen',
          (e) => alive && applyScreen(e.payload.aktif, e.payload.aralikMs),
        ),
      ]);
      if (!alive) return;
      if (!connected) {
        setState((s) => ({ ...s, linkError: eventBridgeError() }));
        return;
      }
      // Dinleyiciler once kurulur, sonra otoriter anlik goruntu okunur. Bu sira,
      // sorgu surerken gelen bir degisimin kacmasini engeller.
      const eventVersionBeforeQuery = liveStatusEventVersion;
      const snapshot = await callHost<LiveStatus>('live_status_get');
      if (
        alive &&
        liveStatusEventVersion === eventVersionBeforeQuery &&
        snapshot.ok &&
        typeof snapshot.value.connected === 'boolean'
      ) {
        onStatus(snapshot.value);
      }
    })().catch((error: unknown) => {
      subscriptions.close();
      logFailure('live events', error);
      if (alive) setState((s) => ({ ...s, linkError: eventBridgeError() }));
    });

    return () => {
      alive = false;
      subscriptions.close();
      clear('speak');
      clear('refusal');
      clear('memory');
      clear('playback');
      stopThinking();
      toolTimer.forEach((timer) => window.clearTimeout(timer));
      toolTimer.clear();
    };
  }, [applyScreen, applyOwner]);

  return { ...state, screen, screenStream, owner, ownerListening };
}
