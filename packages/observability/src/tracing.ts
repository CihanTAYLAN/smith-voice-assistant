import { LangfuseSpanProcessor } from '@langfuse/otel';
import { startActiveObservation } from '@langfuse/tracing';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * Langfuse OTel tracing (earlier-project deseninden uyarlandi).
 *
 * Ilke: gozlemlenebilirlik OPSIYONEL ama davranisi ACIK olmali. Uc anahtar
 * (baseUrl, publicKey, secretKey) tam degilse tracing baslatilmaz, sistem
 * bunu "disabled" olarak RAPOR EDER ve tum yardimcilar passthrough calisir.
 * Yarim yapilandirma sessizce yutulmaz — eksik alan adi soylenir.
 */

export interface TracingConfig {
  baseUrl?: string | undefined;
  publicKey?: string | undefined;
  secretKey?: string | undefined;
}

export type TracingState =
  { enabled: true; shutdown: () => Promise<void> } | { enabled: false; reason: string };

let active: NodeSDK | undefined;

export function initTracing(config: TracingConfig): TracingState {
  const { baseUrl, publicKey, secretKey } = config;
  const missing = (['baseUrl', 'publicKey', 'secretKey'] as const).filter((k) => !config[k]);

  if (missing.length === 3) {
    return { enabled: false, reason: 'Langfuse yapilandirilmamis (tracing kapali).' };
  }
  if (!baseUrl || !publicKey || !secretKey) {
    return {
      enabled: false,
      reason: `Langfuse yapilandirmasi eksik: ${missing.join(', ')}. Tracing kapali.`,
    };
  }
  if (active) {
    return { enabled: true, shutdown: shutdownTracing };
  }

  active = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor({ baseUrl, publicKey, secretKey })],
  });
  active.start();
  return { enabled: true, shutdown: shutdownTracing };
}

export async function shutdownTracing(): Promise<void> {
  if (!active) return;
  const sdk = active;
  active = undefined;
  await sdk.shutdown();
}

/** Test ve yeniden-baslatma icin. */
export function isTracingActive(): boolean {
  return active !== undefined;
}

/**
 * Bir asenkron isi adlandirilmis observation icinde kosar. Tracing kapaliysa
 * isi oldugu gibi calistirir — cagiran taraf if/else yazmaz.
 *
 * Metadata'ya secret koyma; workspaceId/sessionId gibi kimlikler yeterli.
 */
export async function observe<T>(
  name: string,
  metadata: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!active) return fn();
  return startActiveObservation(name, async (span) => {
    span.update({ metadata });
    return fn();
  });
}
