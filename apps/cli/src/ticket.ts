/**
 * WebSocket bileti: JWT'yi `?token=` ile URL'e koymak yerine kisa omurlu, tek
 * kullanimlik bilet (`POST /v1/ws/ticket`, 60 sn). URL'e dusen deger nginx erisim
 * gunlugunde ve proxy kayitlarinda kalir; JWT'nin kendisi yalniz `Authorization`
 * basliginda gider.
 */

const TICKET_REQUEST_TIMEOUT_MS = 10_000;

/** `ws://host:port/yol/` -> `http://host:port/yol` (`wss` -> `https`). */
export function toHttpBase(wsUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    throw new Error(`--url ws:// veya wss:// ile baslamali: ${wsUrl}`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`--url ws:// veya wss:// ile baslamali: ${wsUrl}`);
  }
  const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return `${scheme}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Sunucunun `{ error }` govdesi varsa mesaj; yoksa bos (HTML hata sayfasi gosterilmez). */
async function serverMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

export async function fetchWsTicket(input: {
  wsUrl: string;
  token: string;
  /** Test dikisi. */
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const base = toHttpBase(input.wsUrl);
  const doFetch = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`${base}/v1/ws/ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.token}` },
      signal: AbortSignal.timeout(TICKET_REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Ag hatasinin ayrintisi (istek basliklari dahil olabilir) yazilmaz.
    throw new Error(`bilet ucuna ulasilamadi: ${base}/v1/ws/ticket`);
  }

  if (!response.ok) {
    const message = await serverMessage(response);
    const retryAfter = response.headers.get('retry-after');
    throw new Error(
      `bilet alinamadi (HTTP ${response.status})` +
        (message ? `: ${message}` : '') +
        (retryAfter ? ` (${retryAfter} sn sonra dene)` : ''),
    );
  }

  const body = (await response.json().catch(() => null)) as { ticket?: unknown } | null;
  if (typeof body?.ticket !== 'string' || body.ticket.length === 0) {
    throw new Error('bilet ucu beklenmeyen yanit verdi (bilet yok)');
  }
  return body.ticket;
}
