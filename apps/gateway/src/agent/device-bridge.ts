import type { DeviceToolBridge, ToolResult } from '@smith/core';
import { newToolCallId } from '@smith/db';
import type { ServerFrame } from '@smith/protocol';

/**
 * Device-locus tool koprusu (Faz 3, device registry hattinin ilk dilimi).
 *
 * `packages/core` bir arac `locus: 'device'` ise onu YURUTMEZ; `DeviceToolBridge`'e
 * devreder. Gateway bunu WebSocket uzerinden saglar: modelin istedigi arac
 * cagrisini `tool_call` frame'i olarak istemciye (cihaza) yollar ve istemciden
 * eslesen `tool_result` frame'i gelene kadar bekler. Boylece protokoldeki (bugune
 * dek atil) `tool_call`/`tool_result` cifti canlanir ve model, cihaz uzerinde is
 * yaptirabilir (or. uygulama ac, sistem durumu) — mantik istemcide, karar modelde.
 *
 * Sozlesme: her cagri protokol formatinda TAZE bir `tc_...` kimligi uretir;
 * istemci ayni kimligi `tool_result`'ta geri verir. Zaman asiminda tur KIRILMAZ,
 * arac `ok:false` (`device_timeout`) doner; iptal (turn signal) beklemeyi reddeder
 * → loop `cancelled` olur.
 */

export interface DeviceResult {
  readonly ok: boolean;
  readonly result: unknown;
}

/** tc_id -> bekleyen cagriyi cozen fonksiyon. Baglanti basina tek harita. */
export type PendingDeviceCalls = Map<string, (r: DeviceResult) => void>;

export interface DeviceBridgeDeps {
  /** `tool_call` frame'ini istemciye yollar (gateway `send(ws, frame)`). */
  readonly emit: (frame: ServerFrame) => void;
  /** Baglanti basina paylasilan bekleyen-cagri haritasi. */
  readonly pending: PendingDeviceCalls;
  readonly sessionId: string;
  readonly messageId: string;
  /** Istemci yanit vermezse bu sure sonunda ok:false doner. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createDeviceBridge(deps: DeviceBridgeDeps): DeviceToolBridge {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return (call, ctx) =>
    new Promise<ToolResult>((resolve, reject) => {
      const tcId = newToolCallId();
      const settle = (r: DeviceResult): void =>
        resolve({ toolCallId: call.toolCallId, ok: r.ok, result: r.result });

      const timer = setTimeout(() => {
        if (deps.pending.delete(tcId)) settle({ ok: false, result: { error: 'device_timeout' } });
      }, timeoutMs);

      const onAbort = (): void => {
        clearTimeout(timer);
        deps.pending.delete(tcId);
        reject(new Error('device tool iptal edildi'));
      };

      if (ctx.signal) {
        if (ctx.signal.aborted) {
          onAbort();
          return;
        }
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }

      deps.pending.set(tcId, (r) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        settle(r);
      });

      deps.emit({
        type: 'tool_call',
        sessionId: deps.sessionId,
        messageId: deps.messageId,
        toolCallId: tcId,
        name: call.name,
        input: call.input,
        // Onay bayragi ilerde arac metadata'sindan turetilecek (geri-donussuz
        // cihaz eylemleri icin). Su an device araci kayitli degil → false.
        requiresApproval: false,
      });
    });
}

/**
 * Gelen `tool_result` frame'ini bekleyen cagriya baglar. Eslesme bulunduysa
 * true; bilinmeyen/gec kalan kimlik icin false (sessizce yok sayilir).
 */
export function resolveDeviceResult(
  pending: PendingDeviceCalls,
  toolCallId: string,
  r: DeviceResult,
): boolean {
  const settle = pending.get(toolCallId);
  if (!settle) return false;
  pending.delete(toolCallId);
  settle(r);
  return true;
}
