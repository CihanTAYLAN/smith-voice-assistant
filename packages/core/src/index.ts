/**
 * `@smith/core` — ajan tool-loop'u (turn/step), arac registry ve monotonik guard.
 *
 * AGENTS.md §6'nin "sıradaki — Faz 1 kritik yolu" paketi. Saglayici-notr:
 * bir `LoopModel` dikisi enjekte edilir (`@smith/llm` bunu Faz 2b'de adapte eder).
 * Karar kaydi: [ADR 0010](../../docs/decisions/0010-agent-core-tool-loop.md).
 */

export * from './types.js';
export * from './tool.js';
export * from './guard.js';
export * from './loop.js';
