import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

/**
 * Gateway'in ag yuzeyi yardimcilari.
 *
 * Gecmis: `serve()` hostname vermiyordu, yani Node tum arayuzlerde (0.0.0.0)
 * dinliyordu; baslangic logu ise `127.0.0.1` yaziyordu. Ayni agdaki herhangi
 * bir makine, "yalniz bu makine" sanilan gateway'e (dev login dahil) erisebilirdi.
 * Dinleme adresi artik `SMITH_GATEWAY_HOST` env'inden gelir (varsayilan loopback)
 * ve log GERCEK baglanan adresi yazar.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Adres loopback mu? 127.0.0.0/8, `::1` ve IPv4-eslemeli IPv6 (`::ffff:127.x`).
 * Tanimsiz veya cozumlenemeyen adres loopback SAYILMAZ (guvenli taraf).
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;

  const v4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  const match = IPV4.exec(v4);
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

/**
 * Istegi atan soketin uzak adresi. Yalniz soket adresi guvenilir: proxy
 * basliklari (X-Forwarded-For vb.) istemci tarafindan uydurulabilir, bu yuzden
 * BILEREK okunmaz. Node sunucusu disinda (env'de soket yok) adres bilinmez.
 */
export function resolveRemoteAddress(c: Context): string | undefined {
  if (!c.env) return undefined;
  return getConnInfo(c).remote.address;
}

/** Baslangic logu icin gercek baglanan adresten URL (IPv6 koseli parantezle). */
export function formatListenUrl(info: { address: string; family: string; port: number }): string {
  const host = info.family === 'IPv6' ? `[${info.address}]` : info.address;
  return `http://${host}:${info.port}`;
}
