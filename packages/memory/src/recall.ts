import type { MemoryHit } from './repo.js';

/**
 * Geri cagrilan hafizalari LLM baglamina donusturur.
 *
 * Basit bir karakter butcesi uygular (onceki projenin token budgeter'inin hafif hali;
 * gercek token sayimi ikinci kullanimda gelir). En benzer olanlar once gelir —
 * searchMemories zaten similarity'ye gore siralar — ve butce dolunca kesilir.
 * Alakasiz baglam eklemektense az baglam eklemek yeglenir.
 */
export function buildRecallBlock(
  hits: readonly MemoryHit[],
  options: { maxChars?: number } = {},
): string | null {
  if (hits.length === 0) return null;
  const maxChars = options.maxChars ?? 1500;

  const lines: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const line = `- ${hit.content}`;
    if (used + line.length > maxChars) {
      // En ilgili kayit tek basina butceyi asiyorsa atlanmaz, butceye kirpilir;
      // aksi halde model hic baglam almadan cevap verirdi.
      if (lines.length === 0 && maxChars > 1) lines.push(`${line.slice(0, maxChars - 1)}…`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return null;

  return [
    'Kullanicinin gecmisinden ilgili notlar (gerekirse kullan, alakasizsa yok say):',
    ...lines,
  ].join('\n');
}
