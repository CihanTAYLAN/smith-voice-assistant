import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * SUREC DUSMEYE KARSI KORUMALAR. Gateway hafiza, konusma kaydi ve gorev
 * araclarinin tek kapisidir; her cokus ses oturumu araclarini baglanti hatasina
 * dusurur. Iki bagimsiz savunma:
 *
 * 1. `guardUpgradeTarget`: kok nedeni keser (asagi bkz.).
 * 2. `installUnhandledRejectionLogger`: ayni sinifin baska bir kaynagi cikarsa
 *    surec dusmez, iz kalir. `uncaughtException` davranisi BILEREK degistirilmez:
 *    bilinmeyen senkron hata surecin tutarli kalmasini garanti etmez.
 */

/** node-ws `new URL(request.url ?? '/', init.baseUrl ?? 'http://localhost')` cagirir; gateway baseUrl vermez. */
const UPGRADE_BASE_URL = 'http://localhost';

/** Hedef node-ws'in `new URL` cagrisindan gecer mi? */
export function isParseableUpgradeTarget(target: string | undefined): boolean {
  try {
    new URL(target ?? '/', UPGRADE_BASE_URL);
    return true;
  } catch {
    return false;
  }
}

interface UpgradeEmitter {
  prependListener(
    event: 'upgrade',
    listener: (request: IncomingMessage, socket: Duplex) => void,
  ): unknown;
}

/**
 * `@hono/node-ws` upgrade dinleyicisi `new URL(request.url)` cagrisini try/catch
 * OLMADAN, async bir fonksiyonda yapar. Tek bir kimliksiz istek
 * (`GET //[ HTTP/1.1` + upgrade basliklari) `TypeError: Invalid URL`'i yakalanmamis
 * red yapar ve Node 22 sureci kapatir (olculdu).
 *
 * Bu dinleyici ONDEN calisir ve gecersiz hedefte soketi keser. Soketi kesmek
 * yetmez: EventEmitter tum dinleyicileri sirayla cagirir, node-ws dinleyicisi yine
 * calisir ve ayni satirda coker (olculdu). Bu yuzden hedef ayrica gecerli bir
 * degerle degistirilir; node-ws kapali soketle 404'u sessizce bosa yazar.
 */
export function guardUpgradeTarget(server: UpgradeEmitter): void {
  server.prependListener('upgrade', (request, socket) => {
    if (isParseableUpgradeTarget(request.url)) return;
    request.url = '/';
    socket.destroy();
  });
}

interface RejectionSource {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

/**
 * Yakalanmamis promise reddi surecin kapanmasi yerine MASKELI loglanir: yalniz
 * hata adi yazilir (mesaj ve yigin gunluge girmez, diger gateway gunlukleriyle
 * ayni kural).
 */
export function installUnhandledRejectionLogger(source: RejectionSource = process): void {
  source.on('unhandledRejection', (reason) => {
    console.error(
      `[gateway] yakalanmamis promise reddi (${reason instanceof Error ? reason.name : 'unknown'})`,
    );
  });
}
