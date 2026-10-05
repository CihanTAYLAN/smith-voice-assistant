import { AGENT_ENGINES, isAgentEngine, type AgentEngine } from '@smith/mission';

import { runClaudeCode } from './claude-code.js';
import { runCodex } from './codex.js';
import type { EngineRunInput, EngineRunResult } from './engine-result.js';

/**
 * MOTOR KAYIT YERI (ADR 0007 §4'te ongorulen "ikinci motor" adimi).
 *
 * KAYIT NEDEN SIMDI KURULDU: ADR "ikinci gercek kullanim cikmadan motor
 * registry'si kurulmadi" diyordu; Codex motoru o ikinci kullanimdir.
 *
 * TIP NEDEN `Record<AgentEngine, ...>` VE `switch` DEGIL: bu bir
 * TAMLIK (exhaustiveness) kapisidir. Kanonik listeye ucuncu bir motor
 * eklendiginde bu dosya DERLENMEZ — "eklendi ama kayit yerine yazilmadi"
 * hatasi sessiz bir runtime hatasina donusemez. Elle tutulan ikinci bir liste
 * yok; tip zaten kanonik kaynaktan (`@smith/mission` → `AGENT_ENGINES`) gelir.
 */
const ENGINES: Record<AgentEngine, (input: EngineRunInput) => Promise<EngineRunResult>> = {
  'claude-code': runClaudeCode,
  codex: runCodex,
};

export async function runAgentEngine(
  engine: string,
  input: EngineRunInput,
): Promise<EngineRunResult> {
  if (!isAgentEngine(engine)) {
    // Bilinmeyen motor SESSIZCE claude'a dusmez: yanlis motorda kosan bir is,
    // panoda "basarili" gorunup yanlis yerde is yapardi.
    throw new Error(`Bilinmeyen motor: ${engine}. Tanimli motorlar: ${AGENT_ENGINES.join(', ')}.`);
  }
  return ENGINES[engine](input);
}

export type { EngineRunInput, EngineRunResult } from './engine-result.js';
