import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plasma } from '@cruxgarden/plasma-ui';

import { HUD_SURFACE, HudPlasmaProvider } from './plasma/deck.js';

import { resolveActivityState, type ActivityInput } from './activityState.js';
import { ConversationStream, VISIBLE_LINES } from './ConversationStream.js';
import { Face } from './Face.js';
import { Hud } from './Hud.js';
import { buildSignals, noticeFor, sessionState, toFaceState } from './hudState.js';
import { MindCloud } from './MindCloud.js';
import { useHitAreas, useInteractiveHint, useWindowInteractive } from './useHitAreas.js';
import {
  useDevBackdrop,
  useDocumentVisible,
  useHudCollapse,
  useLinkStall,
  useTimeTheme,
} from './useHudEnvironment.js';
import { useLiveVoice } from './useLiveVoice.js';
import { useMicLevel } from './useMicLevel.js';
import { useMindStream } from './useMindStream.js';
import { useMixer } from './useMixer.js';
import { useWindowCommands } from './useWindowCommands.js';
import { Visualizer } from './Visualizer.js';

/**
 * Smith masaustu: SEFFAF HUD + masaustu pet.
 *
 * Tasarim sozlesmesi (kullanici mandasi 2026-08-14, sesli):
 * - "Pencerede gormek istemiyorum." Pencere cercevesiz, seffaf ve her zaman
 *   ustte (Rust tarafi). Bu dosya artik bir PENCERE ICI degil, masaustune
 *   yerlestirilmis DORT ADA cizer: pet, kose panosu, konusma balonlari,
 *   dusunce baloncugu.
 * - Adalar arasindaki her yer GERCEKTEN gecirgendir: hem gorsel olarak
 *   (`background: transparent`) hem de fare acisindan (`window_set_hit_areas`,
 *   bkz. useHitAreas.ts).
 * - Yazili giris YOK. Tek girdi mikrofon; tek cikti ses. Ses hattinin tamami
 *   Rust'ta (Gemini Live speech-to-speech); webview'e MIKROFON ACILMAZ.
 *
 * DORT ADA
 *  1. PET (merkez): Vector tarzi yuz + altinda ince enerji seridi, arkasinda
 *     yumusak halo. Pencerenin surukleme tutamagi da burasidir.
 *  2. PANO (sag ust kose, dar pencerede altta): cam panel: "su an ne yapiyor"
 *     satiri + dikey sinyal listesi (Live/Mikrofon/Hoparlor/Ekran/Arac/Hafiza)
 *     + kacis kapilari.
 *  3. BALONLAR (pet'in altinda): son birkac replik, sonerek kaybolan. Sohbet
 *     penceresi DEGIL: gecmis arsivi yok, cam balonlar akip gider.
 *  4. DUSUNCE BALONCUGU (pet'in USTUNDE): Smith'in su anki IC FAALIYETI: hangi
 *     arac calisiyor, ses izi ne dedi, ekran acildi mi, hat koptu mu. Olay
 *     yokken hic cizilmez. UYDURMA YOK: Gemini Live bir dusunce izi
 *     dondurmez, bu yuzden buraya yalniz GERCEKLESEN olaylarin karsiligi
 *     yazilir (bkz. `mindBubbles.ts`); bir LLM'e cumle URETTIRILMEZ.
 *     Tiklaninca `zihin_dokumu` komutu ile modele GIDEN baglam gosterilir.
 *
 * OKUNABILIRLIK: zemin seffaf oldugu icin metin dogrudan masaustunun uzerine
 * duser. Kural: HICBIR metin cam bir yuzey olmadan cizilmez (bkz. styles.css
 * `--glass`); boylece hem beyaz hem koyu masaustunde okunur kalir.
 *
 * DURUM GORUNURLUGU: hangi gosterge gercek veriden gelir, hangisi hala Rust
 * olayi bekler: `hudState.ts` `buildSignals` icinde tek tek yazili.
 */

/**
 * Face ve Visualizer prop'larini kendi ref'lerine kopyalayip cizimi kendi
 * dongusunde yapiyor; React render'i onlar icin yalnizca "prop tasima" isi.
 * `memo` + yuvarlanmis `level` ikilisi bu tasimayi seviye GERCEKTEN degistiginde
 * yapar; pencere gizliyken (level donduruldugunda) hic yapmaz.
 */
const FaceView = memo(Face);
const WaveView = memo(Visualizer);

export function App(): React.JSX.Element {
  const mic = useMicLevel();
  const mixer = useMixer();
  const live = useLiveVoice();
  const mind = useMindStream();
  const visible = useDocumentVisible();
  const linkStalled = useLinkStall(mic.capturing, live.link);
  const hover = useWindowInteractive();
  const inert = useInteractiveHint();
  const hud = useHudCollapse();
  const windowCommands = useWindowCommands();
  const { framed, startDragging } = windowCommands;
  const [dumpOpen, setDumpOpen] = useState(false);
  /** Zihin dokumu kapaninca, tetikleyici baloncuk sondugunde odagin gidecegi yer. */
  const mindButton = useRef<HTMLButtonElement>(null);

  useDevBackdrop();
  useTimeTheme();

  const openDump = useCallback(() => setDumpOpen(true), []);
  const closeDump = useCallback(() => setDumpOpen(false), []);

  // Gorsellestirme seviyesi: Smith konusurken mikrofon RMS'i anlamsiz (kendi
  // sesimizi olcerdik; ustelik echo kapisi mikrofonu sessizlige cevirir) →
  // konusma sirasinda canli ama sabit bir taban enerji verilir.
  const raw = live.assistantSpeaking ? 0.55 + Math.min(0.35, mic.rms * 0.5) : mic.rms;
  // Gizli pencerede cizim dongusu zaten duruyor (Face/Visualizer
  // visibilitychange dinliyor); seviyeyi de dondurunca memo'lu cocuklar hic
  // render edilmez. 0.02'lik adim goz icin farksiz, render sayisi icin yarim.
  const level = visible ? Math.round(raw * 50) / 50 : 0;

  /*
   * BASKIN FAALIYET: tek oncelik sirasi, `activityState.ts`ten. Yuz pozu
   * (`faceState`), panel aksani (`data-activity`) ve ortam etiketi (`state`
   * asagida) AYNI cozumden turer; birbirinden bagimsiz sirlanip sessizce
   * ayrisamazlar (Faz 3, UI_IMPLEMENTATION_PLAN.md §5.3).
   */
  const initializing = mic.status === 'initializing';
  const activityInput: ActivityInput = {
    micError: mic.error,
    hostReady: mic.available,
    capturing: mic.capturing,
    link: live.link,
    linkStalled,
    assistantSpeaking: live.assistantSpeaking,
    thinking: live.thinking,
    tools: live.tools,
  };
  const activity = resolveActivityState(activityInput);
  const faceState = toFaceState(activity);
  // Acilista host henuz sorgulaniyor: "masaustu host yok" demek icin erken.
  const state = initializing ? 'Mikrofon hazırlanıyor…' : sessionState(activity, activityInput);

  const notice = initializing
    ? null
    : noticeFor({
        micError: mic.error,
        hostReady: mic.available,
        capturing: mic.capturing,
        deviceCount: mic.devices.length,
        link: live.link,
        linkStalled,
        refusal: live.refusal,
        linkError: live.linkError,
        playbackNotice: live.playbackNotice,
      });

  const signals = useMemo(
    () =>
      buildSignals({
        hostReady: mic.available,
        initializing,
        capturing: mic.capturing,
        deviceCount: mic.devices.length,
        link: live.link,
        linkStalled,
        userSpeaking: live.userSpeaking,
        assistantSpeaking: live.assistantSpeaking,
        toolCount: live.tools.length,
        memoryWrite: live.memoryWrite,
        micMuted: mixer.micMuted,
        outputMuted: mixer.outputMuted,
        screen: live.screen,
      }),
    // Ilkel bagimliliklar: dizi kimligi ancak GERCEK bir sinyal degisince
    // degissin, yoksa liste her seviye olayinda bosa render edilir.
    [
      mic.available,
      initializing,
      mic.capturing,
      mic.devices.length,
      live.link,
      linkStalled,
      live.userSpeaking,
      live.assistantSpeaking,
      live.tools.length,
      live.memoryWrite,
      mixer.micMuted,
      mixer.outputMuted,
      live.screen,
    ],
  );

  // "dinlemeyi durdur" / "dinlemeye basla": YALNIZ BU OTURUM icin. Kalici bir tercih
  // DEGIL, bkz. asagidaki otomatik baslatma notu.
  const toggleMic = useCallback(() => {
    if (mic.capturing) mic.stop();
    else mic.start();
  }, [mic]);

  // OTOMATIK DINLEME. Kusur olarak yasandi (2026-08-15): `mic.start()` YALNIZ
  // bu bilesenin ac/kapa dugmesinden cagriliyordu, dolayisiyla Smith her
  // acilista sessiz duruyordu: pencere geliyor, frontend yukleniyor, ama Rust
  // tarafi hicbir baglanti kurmuyordu (Live WS oturumu `audio_start` ile
  // basliyor). Belirti "acildi ama duymuyor" seklindeydi ve dis gozlemde
  // "kurulu TCP baglantisi YOK" olarak gorunuyordu.
  //
  // Kullanici mandasi hitapsiz always-on: her yeniden baslatmada dugmeye
  // basmak o mandayla celisir.
  //
  // IKINCI KUSUR, BU DUZELTMENIN KENDISINDEN CIKTI (ayni gun): kapatma karari
  // `localStorage`'a yazilip KALICI tercih sayiliyordu. Ama HUD'daki tek dugme
  // "sustur", yani ANLIK bir eylem. Kullanici bir kez susturunca Smith bir
  // daha HIC kendiliginden dinlemedi; belirti yine "acildi ama duymuyor"du ve
  // dis gozlemde yine "kurulu TCP baglantisi YOK" olarak gorundu.
  // IKI KAVRAM KARISTIRILMISTI: "simdi sus" ile "bir daha kendiliginden acilma"
  // ayni sey degildir. Anlik eylemi kalici tercihe terfi ettirmek, kullanicinin
  // soylemedigi bir seyi soylemis saymaktir.
  //
  // Dogrusu: acilista DAIMA dinlemeye basla; "dinlemeyi durdur" yalniz o oturumu susturur.
  // Mikrofon durumu HUD'da her an gorunur oldugu icin bu sessiz bir eylem
  // degil. Bilincli olarak kapali baslatmak isteyen icin dogru yer bir env
  // ayaridir (bugun yok), yanlislikla tetiklenen bir yan etki degil.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    if (!mic.available || mic.capturing) return;
    autoStarted.current = true;
    mic.start();
  }, [mic]);

  // Ada geometrisini degistiren her sey burada: `useHitAreas` bu dizgi
  // degisince gozlemciyi yeniden kurar ve geometriyi yeniden bildirir.
  useHitAreas(
    [
      hud.collapsed,
      notice !== null,
      Math.min(live.lines.length, VISIBLE_LINES),
      framed,
      mic.available,
      mind.length,
      dumpOpen,
    ].join(':'),
  );

  /*
   * PLASMA KATMANI (2026-09-25): pano, bildirim ve dusunce baloncugu WebGL'de
   * cizilen SIVI cam yuzeylerdir (`ground="clear"`: zemin alani cizilmez,
   * pencere seffaf kalir; bkz. plasma/deck.tsx). Zihin dokumu ise ust katmanda
   * bir `<dialog>`dur ve kendi opak dolgusunu tasir. Konusma balonlari
   * (.bubble) bilincli olarak CSS caminda KALIR: asimetrik balon kosesi (13/5px)
   * ve depth-sonme basamaklari plazmanin tekduze yaricap modeline sigmiyor;
   * kucuk elemanlar yuzey DEGIL, yuzeyin ustunde duz HTML olmali (plasma-ui
   * dokumani).
   *
   * Hit-alani sozlesmesi degismez: Plasma siniflari KORUR (`.hud`, `.notice`,
   * `.mind`, `.mind-dump` aynen durur), Rust gozcusu ayni secicileri olcmeye
   * devam eder.
   */
  return (
    <HudPlasmaProvider>
      <div
        className="stage"
        data-speaking={live.assistantSpeaking}
        data-on={mic.capturing}
        // Panel aksani buradan okur (bkz. hud.css `.stage[data-activity]`):
        // yalniz gercekten agir basan durum (error) gorsel karsilik alir,
        // digerlerinde vurgu degismez (plan §2: "durum degisince duzen degil
        // vurgu degismeli").
        data-activity={activity}
        // Gozcu gecirgene gecmek uzere: takili :hover gorunumlerini kapat.
        data-inert={inert}
      >
        {/* Pet + bildirim + balonlar tek dikey kolon: pano yan kolonu (dar
          pencerede alt satiri) isgal eder, boylece gostergeler pet'in uzerine
          HIC binmez. */}
        <div className="field">
          {/*
          DUSUNCE BALONCUGU: pet'in USTUNDE, konusma balonlarindan ayri.
          Akista durur (absolute DEGIL): pet'i ortmez, kendine yer acar ve
          `.field` dikey ortalamasi pet'i asagi kaydirir.
        */}
          <MindCloud
            bubbles={mind}
            open={dumpOpen}
            onOpen={openDump}
            onClose={closeDump}
            fallbackFocus={mindButton}
            hover={hover}
          />

          {/*
          PET: ayni zamanda pencerenin surukleme tutamagi (bkz.
          `useWindowCommands` `startDragging`).
        */}
          <div
            className="pet"
            onPointerDown={startDragging}
            onPointerEnter={hover.onPointerEnter}
            onPointerLeave={hover.onPointerLeave}
          >
            <div className="pet-halo" aria-hidden="true" />
            <div className="pet-face">
              <FaceView state={faceState} level={level} />
            </div>
            {/* Dalga: yuzun altinda ince enerji seridi (ikincil gosterge). Ayni
              `level`den beslenir, pet'le birlikte nefes alir. */}
            <div className="pet-wave">
              <WaveView level={level} speaking={live.assistantSpeaking} listening={mic.capturing} />
            </div>
          </div>

          {notice ? (
            // Plazma yuzeyi: tur basina tint (ariza koyu kizil, kapi koyu mor),
            // opaklik saglayicidan (`HUD_SURFACE`).
            <Plasma
              as="p"
              className="notice"
              data-kind={notice.kind}
              // exactOptionalPropertyTypes: tint YALNIZ anlamli oldugunda prop
              // olarak gecilir (info = saglayici varsayilani).
              {...(notice.kind === 'fault'
                ? { tint: HUD_SURFACE.fault }
                : notice.kind === 'gate'
                  ? { tint: HUD_SURFACE.gate }
                  : {})}
              radius={14}
              role={notice.kind === 'info' ? undefined : 'alert'}
              onPointerEnter={hover.onPointerEnter}
              onPointerLeave={hover.onPointerLeave}
            >
              {notice.text}
            </Plasma>
          ) : null}

          <ConversationStream
            lines={live.lines}
            capturing={mic.capturing}
            visible={visible}
            hover={hover}
          />
        </div>

        <Hud
          signals={signals}
          state={state}
          listening={mic.capturing}
          micReady={mic.available}
          micPending={mic.pending}
          windowPending={windowCommands.pending}
          windowError={windowCommands.error}
          onOpenMind={openDump}
          mindButtonRef={mindButton}
          screen={live.screen}
          owner={live.owner}
          ownerListening={live.ownerListening}
          screenStream={live.screenStream}
          linkError={live.linkError}
          mixer={{
            ready: mixer.ready,
            pending: mixer.pending,
            error: mixer.error,
            micMuted: mixer.micMuted,
            outputMuted: mixer.outputMuted,
            outputVolume: mixer.outputVolume,
            micRms: mic.rms,
            onToggleMicMute: () => mixer.setMicMuted(!mixer.micMuted),
            onToggleOutputMute: () => mixer.setOutputMuted(!mixer.outputMuted),
            onOutputVolume: mixer.setOutputVolume,
          }}
          collapsed={hud.collapsed}
          framed={framed}
          onCollapse={hud.toggle}
          onToggleMic={toggleMic}
          onOpenMission={() => windowCommands.run('mission_open')}
          onGrab={startDragging}
          onFrame={windowCommands.toggleFrame}
          onQuit={() => windowCommands.run('window_quit')}
          hover={hover}
        />
      </div>
    </HudPlasmaProvider>
  );
}
