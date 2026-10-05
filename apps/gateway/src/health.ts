import { PROTOCOL_VERSION } from '@smith/protocol';
import type { Handler } from 'hono';

/**
 * `/v1/health`: surecin ayakta olmasi degil BAGIMLILIKLARIN erisilebilir olmasi.
 *
 * Eskiden sabit `{ok:true}` donuyordu. Docker Desktop port yonlendirmesi TCP el
 * sikismasini kabul edip iletmediginde (`packages/db/src/client.ts` yorumundaki
 * gercek ariza) TCP yoklamasi yesil, bu uc "up" olurken DB'ye dokunan her istek
 * dusuyordu ve bekci hicbir sey gormuyordu. Artik DB (`SELECT 1`) ve Redis
 * (`PING`) 2 sn sinirla yoklanir; basarisizlikta 503 ve `{ok:false, db|redis:false}`.
 * `scripts/smith-common.ps1` `ok -eq $true` bekler: basarili govde sozlesmesi ayni.
 *
 * Uc kimliksizdir: hata ayrintisi (baglanti dizesi, sunucu mesaji) govdeye
 * girmez, yalniz hangi bagimliligin dustugu boolean olarak yazilir.
 */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export interface HealthProbes {
  db: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

/** Yoklama zamaninda basariyla biterse true; hata, senkron firlatma ya da zaman asimi false. */
async function succeeds(probe: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('zaman asimi')), timeoutMs);
  });
  try {
    await Promise.race([probe(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createHealthHandler(
  probes: HealthProbes,
  timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS,
): Handler {
  return async (c) => {
    const [db, redis] = await Promise.all([
      succeeds(probes.db, timeoutMs),
      succeeds(probes.redis, timeoutMs),
    ]);
    const healthy = db && redis;
    c.header('Cache-Control', 'no-store');
    return c.json(
      { ok: healthy, db, redis, protocolVersion: PROTOCOL_VERSION },
      healthy ? 200 : 503,
    );
  };
}
