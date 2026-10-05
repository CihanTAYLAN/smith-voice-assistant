import type { AgentRecord, TaskCommentRecord, TaskRecord } from './repo.js';

/**
 * SOUL → prompt cevirisi.
 *
 * Ajanin davranisi DB'deki `soul` alanindan gelir; buradaki sabit metin yalniz
 * headless kosunun cercevesidir (rapor bicimi, soru soramama, sinirlar). Ikisi
 * kasten ayri: kisilik panodan degisir, cerceve kodla birlikte surumlenir.
 *
 * NOT: buradaki "sinirlarin disina cikma" cumleleri bir GUVENLIK KAPISI DEGIL,
 * niyet bildirimidir. Gercek kapi executor'un CLI bayraklaridir (--add-dir,
 * --allowedTools, --permission-mode) ve zaman asimidir. Talimat tavsiyedir,
 * mekanizma garantidir.
 */

/** Ajanin son mesajinda dosya teslimini bildirdigi satir oneki. */
export const ARTIFACT_MARKER = 'TESLIM-DOSYA:';

export function buildAgentSystemPrompt(agent: AgentRecord): string {
  const roots = agent.workRoots.length > 0 ? agent.workRoots.join(', ') : 'yok (dosya isi yok)';
  return [
    `Sen ${agent.displayName} (@${agent.slug}), Cihan'in Smith ekibinde "${agent.role}" rolundeki ajanisin.`,
    '',
    '--- KIMLIK VE CALISMA KURALLARIN (SOUL) ---',
    agent.soul.trim(),
    '',
    '--- KOSU CERCEVESI ---',
    'Bu bir headless kosudur: karsinda kimse yok, soru soramazsin. Belirsizlik',
    'varsa en makul varsayimi yapar, varsayimini raporunda ACIKCA yazarsin.',
    `Calisma alanin: ${roots}. Bu koklerin disina yazma.`,
    'Kendi basina commit veya push YAPMA; gorev acikca istemiyorsa yalniz',
    'dosyayi hazirla ve raporla.',
    'Isi bitirdiginde son mesajin RAPOR olmalidir: ne yaptin, ne dogruladin,',
    'ne kaldi. Iddia degil kanit yaz — calistirdigin komutu ve sonucunu goster.',
    `Bir dosya urettiysen son satira "${ARTIFACT_MARKER} <tam yol>" ekle.`,
    // parseDeliverable engeli YALNIZ son satirda, buyuk harfle ve nedenle arar.
    'Isi tamamlayamadiysan raporun son satirina (varsa TESLIM-DOSYA satirindan once)',
    '"ENGEL: <neden>" yaz: tek satir, buyuk harfle. Engel yoksa bu satiri yazma.',
    'Basarisiz isi basarili gibi raporlamak en kotu sonuctur.',
  ].join('\n');
}

/** Thread icin varsayilan karakter butcesi (kabaca 4k token). */
const DEFAULT_MAX_COMMENT_CHARS = 16_000;

/**
 * Gorev prompt'u. Thread de eklenir: bir ajan panodaki tartismayi gormeden
 * calisirsa "@nova sunu da ekle" yorumu sessizce kaybolur. Binlerce yorumlu
 * bir gorev motor prompt'unu sinirsiz sisirmesin diye thread EN YENI yorumdan
 * geriye karakter butcesi kadar alinir; sigmayan eski yorumlar belirtilir.
 * Tek basina butceyi asan en yeni yorum (ajanin uzun raporu) thread'i silmez:
 * kirpilarak alinir (bkz. `takeRecentComments`).
 */
export function buildTaskPrompt(input: {
  task: TaskRecord;
  comments?: TaskCommentRecord[];
  maxCommentChars?: number;
}): string {
  const { task } = input;
  const lines = [`GOREV (${task.id}): ${task.title}`];
  if (task.detail?.trim()) {
    lines.push('', 'AYRINTI:', task.detail.trim());
  }
  if (task.dueAt) {
    lines.push('', `TERMIN: ${task.dueAt.toISOString()}`);
  }

  const thread = (input.comments ?? []).filter((c) => c.kind !== 'deliver');
  const previousDelivery = task.deliverable?.trim();
  const maxCommentChars = input.maxCommentChars ?? DEFAULT_MAX_COMMENT_CHARS;
  const previousDeliveryLine = previousDelivery
    ? clipMiddle(`Onceki teslim (revizyon icin):\n${previousDelivery}`, maxCommentChars)
    : null;
  const threadBudget = previousDeliveryLine
    ? Math.max(0, maxCommentChars - previousDeliveryLine.length - 1)
    : maxCommentChars;
  const { recent, omitted } = takeRecentComments(thread, threadBudget);
  if (previousDeliveryLine || recent.length > 0 || omitted > 0) {
    lines.push('', 'PANODAKI TARTISMA (eski → yeni):');
    if (previousDeliveryLine) lines.push(previousDeliveryLine);
    if (omitted > 0) {
      lines.push(`(${omitted} eski yorum prompt butcesi nedeniyle gosterilmiyor)`);
    }
    lines.push(...recent);
  }
  return lines.join('\n');
}

/**
 * En yeni yorum tek basina butceyi asarsa (ajanin uzun ENGEL raporu) dusurulmez:
 * butcenin YARISINA kirpilir, boylece eski yorumlara da yer kalir. Kirpma bas ve
 * sonu korur (rapor basi ne yapildigini, sonu engelin nedenini tasir). Daha eski
 * bir yorum sigmazsa thread eskiden oldugu gibi orada biter.
 */
function takeRecentComments(
  comments: readonly TaskCommentRecord[],
  maxChars: number,
): { recent: string[]; omitted: number } {
  const recent: string[] = [];
  let used = 0;
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (!comment) continue;
    let line = `- [${comment.kind}] ${comment.authorType}:${comment.authorId}: ${comment.body}`;
    if (used + line.length + 1 > maxChars) {
      if (recent.length > 0) break;
      line = clipMiddle(line, Math.floor(maxChars / 2));
      if (line === '') break; // butce sifir: hicbir sey sigmaz
    }
    recent.push(line);
    used += line.length + 1;
  }
  return { recent: recent.reverse(), omitted: comments.length - recent.length };
}

const CLIP_MARKER = ' [...kirpildi...] ';

/** Metni `max` karaktere indirir: bas ve sonu tutar, ortasini CLIP_MARKER ile degistirir. */
function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= CLIP_MARKER.length * 2) return text.slice(0, max);
  const keep = max - CLIP_MARKER.length;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}${CLIP_MARKER}${text.slice(text.length - (keep - head))}`;
}

export interface ParsedDeliverable {
  /** Rapor metni — marker satiri cikarilmis haliyle. */
  summary: string;
  artifactPath?: string;
  /** Ajan isi tamamlayamadigini bildirdi mi (son satirda `ENGEL: <neden>`). */
  blocked: boolean;
}

/** `ENGEL:` satirinin icerigi "engel yok" demekse isaret degildir: `yok`, `none`, `-` (+ parantezli not). */
const NO_BLOCKER_REASON = /^(?:yok|none|-+)(?:\s*\(.*\))?\s*\.?$/i;

/**
 * Engel isareti: raporun SON bos olmayan satiri, buyuk harfli `ENGEL:` ve bir
 * neden tasiyor. Rapor icinde dogal gecen "Engel: yok" / "engel yok" satirlari
 * basarili teslimi `blocked` yapmasin diye isaret bilincli olarak dar tutulur;
 * sistem prompt'u ajana tam bu bicimi tarif eder.
 */
function declaresBlocker(reportLines: readonly string[]): boolean {
  const lastLine = reportLines.findLast((line) => line.trim() !== '')?.trim();
  const reason = lastLine?.match(/^ENGEL\s*:\s*(.*)$/)?.[1];
  return reason !== undefined && !NO_BLOCKER_REASON.test(reason);
}

/**
 * Ajanin son mesajini teslime cevirir.
 *
 * Neden in-band ayristirma: motorun (Claude Code) yapisal cikisi zaten
 * `--output-format json` ile geliyor ve `result` alani son mesajin METNIDIR;
 * dosya yolu icin ek bir kanal yok. Tek satirlik, opsiyonel bir marker en
 * dayanikli cozum — yoksa teslim yine gecerlidir, sadece dosya yolu bos kalir.
 */
export function parseDeliverable(resultText: string): ParsedDeliverable {
  const lines = resultText.split(/\r?\n/);
  const kept: string[] = [];
  let artifactPath: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(ARTIFACT_MARKER)) {
      const value = trimmed.slice(ARTIFACT_MARKER.length).trim();
      // Son marker kazanir: ajan duzeltirse dogru olan sonuncusudur.
      if (value) artifactPath = value;
      continue;
    }
    kept.push(line);
  }

  return {
    summary: kept.join('\n').trim(),
    ...(artifactPath ? { artifactPath } : {}),
    blocked: declaresBlocker(kept),
  };
}
