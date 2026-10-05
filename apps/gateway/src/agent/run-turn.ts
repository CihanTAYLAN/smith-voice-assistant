import { runAgentTurn } from '@smith/core';
import type {
  AgentTurnResult,
  DeviceToolBridge,
  LoopMessage,
  LoopModel,
  ToolRegistry,
  WireStopReason,
} from '@smith/core';
import { withScope, type DbHandle } from '@smith/db';
import type { WorkspaceScope } from '@smith/tenancy';

import {
  appendUserMessageAndLoadHistory,
  completeTurn,
  runClaimedTurn,
  scheduleMessageIndex,
  type IndexMessageFn,
  type TurnResult,
} from '../turn.js';

/**
 * Loop-tabanli sohbet turu (Faz 2b). `runChatTurn`'un tek-atislik `streamChat`'i
 * yerine `packages/core`'un tool-loop'unu kullanir: model gerektiginde araclari
 * (hafizada_ara / hafizaya_kaydet) cagirir, sonuclar geri beslenir, tur model
 * arac istemeyi birakinca biter.
 *
 * Otomatik recall YOK: hafiza artik model-guduml (arac). `runChatTurn` (env
 * bayragi kapaliyken varsayilan) streaming + oto-recall ile yerinde durur.
 */

const SYSTEM_PROMPT = [
  'Sen Smith’sin — kullanicinin kendi altyapisinda kosan kisisel yapay zeka asistani.',
  'Turkce konus; teknik terimleri English birak. Kisa, dogru ve dogrudan cevap ver.',
  'Bilmedigini uydurma. Gerektiginde `hafizada_ara` ile gecmisi ara; kalici bilgiyi `hafizaya_kaydet` ile kaydet.',
].join(' ');

export interface AgentTurnInfo extends TurnResult {
  stopReason: WireStopReason;
}

/**
 * Tur `error`, `max_steps` ya da `cancelled` ile bitti: bos/kismi metin asistan
 * yaniti DEGILDIR. Eskiden bu metin idempotency anahtariyla kalici yazilir,
 * ayni messageId ile yeniden deneme "tamamlandi" bulup bos yaniti basari gibi
 * donerdi. Firlatilinca claim birakilir (`runClaimedTurn`), istemciye `error`
 * frame'i (iptalde `done:cancelled`) gider.
 */
export class AgentTurnIncompleteError extends Error {
  constructor(readonly stopReason: 'error' | 'cancelled' | 'max_steps') {
    super(`Ajan turu tamamlanamadi (${stopReason}).`);
    this.name = 'AgentTurnIncompleteError';
  }
}

/** Sebep MASKELI loglanir: yalniz hata adi (mesaj saglayici ayrintisi tasiyabilir). */
function logIncompleteTurn(result: AgentTurnResult): void {
  if (result.stopReason === 'error') {
    console.error(
      `[gateway] ajan turu hatasi (${result.error instanceof Error ? result.error.name : 'unknown'})`,
    );
  } else if (result.stopReason === 'max_steps') {
    console.error('[gateway] ajan turu adim sinirina takildi');
  }
}

export async function runAgentChatTurn(input: {
  db: DbHandle;
  model: LoopModel;
  registry: ToolRegistry;
  indexMessage?: IndexMessageFn | undefined;
  idempotencyKey?: string | undefined;
  scope: WorkspaceScope;
  sessionId: string;
  userText: string;
  signal?: AbortSignal;
  /** Device-locus araclari icin kopru (gateway WS uzerinden). Yoksa device
   *  araci cagrilirsa core `no_device_bridge` ile reddeder. */
  deviceBridge?: DeviceToolBridge | undefined;
  onDelta: (text: string) => void;
}): Promise<AgentTurnInfo> {
  const { db, model, registry, indexMessage, scope, sessionId, userText } = input;

  // 1. Kullanici mesajini yaz + gecmisi al (tek scoped transaction).
  const prepared = await withScope(db.prisma, scope, (tx) =>
    appendUserMessageAndLoadHistory(tx, scope, {
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      sessionId,
      userText,
    }),
  );
  if (prepared.replay) {
    input.onDelta(prepared.replay.text);
    return { ...prepared.replay, stopReason: 'end_turn' };
  }
  const { assistantClientMessageId, history, userMessageId } = prepared;
  if (!history || !userMessageId) throw new Error('Turn hazirligi eksik sonuc dondurdu.');

  return runClaimedTurn(
    db,
    scope,
    { sessionId, idempotencyKey: input.idempotencyKey },
    async () => {
      const messages: LoopMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.map((m): LoopMessage => ({
          role: m.authorRole === 'user' ? 'user' : 'assistant',
          content: m.text,
        })),
      ];

      // 2. Tool-loop (transaction disi). generateWithTools su an streaming
      //    yapmadigindan yanit tur sonunda tek parca olarak yayilir.
      const result = await runAgentTurn({
        model,
        registry,
        scope,
        messages,
        ...(input.deviceBridge ? { deviceBridge: input.deviceBridge } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (
        result.stopReason === 'error' ||
        result.stopReason === 'max_steps' ||
        result.stopReason === 'cancelled'
      ) {
        logIncompleteTurn(result);
        throw new AgentTurnIncompleteError(result.stopReason);
      }
      if (result.text) input.onDelta(result.text);

      // 3. Asistan cevabini yaz.
      const hasUsage = result.usage.inputTokens > 0 || result.usage.outputTokens > 0;
      await withScope(db.prisma, scope, (tx) =>
        completeTurn(tx, scope, {
          ...(assistantClientMessageId ? { assistantClientMessageId } : {}),
          sessionId,
          text: result.text,
          ...(hasUsage
            ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
            : {}),
        }),
      );

      // 4. Kullanici mesajini asenkron indeksle (best-effort).
      scheduleMessageIndex(indexMessage, userMessageId);

      return {
        text: result.text,
        stopReason: result.stopReason,
        ...(hasUsage
          ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
          : {}),
      };
    },
  );
}
