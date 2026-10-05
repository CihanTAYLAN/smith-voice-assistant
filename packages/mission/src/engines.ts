/**
 * Ajan kosusunu yapan MOTOR kimlikleri.
 *
 * NEDEN AYRI DOSYA: motor adi uc yerde geciyor — gateway (atama istegini
 * dogrular), worker (dispecc eder), pano (kullanici secer). Uc yerde elle
 * yazilan liste kacinilmaz olarak ayrisir; ayrisan bir ad "bilinmeyen motor"
 * hatasina duser. Tek kaynak burasidir.
 *
 * `claude-code` — WSL'de kurulu headless Claude Code CLI. Kimlik: Claude
 * aboneligi (`claude setup-token`, kullanici eylemi). Bugune kadar tek motor.
 *
 * `codex` — OpenAI Codex CLI. Kimlik: ChatGPT aboneligi (`codex login`).
 * Ikinci gercek kullanim ciktiginda eklendi; ADR 0007 §4 tam olarak bunu
 * ongormustu ("`packages/core` geldiginde ... yanina ikinci motor gelir").
 * Gerekce ve olculen kisitlar: docs → `codex-motoru.md`.
 */
export const AGENT_ENGINES = ['claude-code', 'codex'] as const;
export type AgentEngine = (typeof AGENT_ENGINES)[number];

/** Yeni kosunun varsayilani: bugune kadar fiilen calisan motor. */
export const DEFAULT_AGENT_ENGINE: AgentEngine = 'claude-code';

export function isAgentEngine(value: string): value is AgentEngine {
  return (AGENT_ENGINES as readonly string[]).includes(value);
}
