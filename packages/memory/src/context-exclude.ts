export interface ContextExcludeRules {
  sourceGlobs: string[];
  keywords: string[];
}

export interface ContextCandidate {
  sourceId: string;
  content: string;
}

/**
 * Turkce buyuk/kucuk harf farkini baglam dislama icin kararlı hale getirir.
 * I, I-noktali ve noktasiz i ayni harfe iner; combining dot ayri kalmaz.
 */
export function turkishCaseFold(value: string): string {
  let folded = '';
  for (const char of value.normalize('NFKC')) {
    if (char === 'I' || char === 'İ' || char === 'ı' || char === 'i') {
      folded += 'i';
    } else if (char !== '\u0307') {
      folded += char.toLowerCase();
    }
  }
  return folded;
}

/** Virgulle ayrilmis sourceId globlari ve `kw:` literal anahtar kelimeleri. */
export function parseContextExclude(raw: string | undefined): ContextExcludeRules {
  const sourceGlobs: string[] = [];
  const keywords: string[] = [];
  for (const item of (raw ?? '').split(',')) {
    const normalized = turkishCaseFold(item.trim());
    if (!normalized) continue;
    if (normalized.startsWith('kw:')) {
      const keyword = normalized.slice(3).trim();
      if (keyword) keywords.push(keyword);
    } else {
      sourceGlobs.push(normalized);
    }
  }
  return { sourceGlobs, keywords };
}

/** Tum-string glob: `*` her karakter dizisi, `?` tek karakterdir. */
export function sourceIdGlobMatches(sourceId: string, glob: string): boolean {
  const value = [...turkishCaseFold(sourceId)];
  const pattern = [...turkishCaseFold(glob)];
  let previous = new Array<boolean>(value.length + 1).fill(false);
  previous[0] = true;

  for (const token of pattern) {
    const current = new Array<boolean>(value.length + 1).fill(false);
    if (token === '*') current[0] = previous[0] ?? false;
    for (let index = 1; index <= value.length; index += 1) {
      current[index] =
        token === '*'
          ? Boolean(previous[index] || current[index - 1])
          : Boolean(previous[index - 1] && (token === '?' || token === value[index - 1]));
    }
    previous = current;
  }
  return previous[value.length] ?? false;
}

export function contextExcluded(
  candidate: ContextCandidate,
  rules: ContextExcludeRules | string | undefined = process.env.SMITH_CONTEXT_EXCLUDE,
): boolean {
  const parsed = typeof rules === 'object' && rules !== null ? rules : parseContextExclude(rules);
  const sourceId = turkishCaseFold(candidate.sourceId);
  if (parsed.sourceGlobs.some((glob) => sourceIdGlobMatches(sourceId, glob))) return true;
  const content = turkishCaseFold(candidate.content);
  return parsed.keywords.some((keyword) => content.includes(keyword));
}

export function contextExcludeRulesFromEnv(): ContextExcludeRules {
  return parseContextExclude(process.env.SMITH_CONTEXT_EXCLUDE);
}
