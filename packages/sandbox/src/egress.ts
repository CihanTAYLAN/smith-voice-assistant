/**
 * Sandbox dis erisim politikasi.
 *
 * Tasarim karari: bu paketin en kritik parcasi cekirdek sinirinda degil
 * burada. Cekirdek sinirini asmak icin bir 0-day gerekir; sinirsiz egress'i
 * somurmek icin yalnizca kotu niyetli bir prompt yeter. server'te ayni ag
 * uzerinde Postgres (5433), Redis (6380), Ollama (11434) ve Langfuse
 * dinliyor -- yani sinirsiz egress hem veri sizdirma hem de ic aga SSRF
 * yoludur.
 *
 * Iki katman var ve sirasi onemli:
 *
 * 1. ALTYAPI KORUMASI -- kosulsuz. Loopback, ozel araliklar, link-local ve
 *    bulut metadata adresi (169.254.169.254) allowlist'e yazilsa bile reddedilir.
 *    Bu, yanlis yapilandirmanin sistemi acmasini imkansiz kilar.
 * 2. POLITIKA -- varsayilan deny-all. Genis politika gerekce olmadan
 *    uretilemez; scope'taki createSystemScope ile ayni disiplin.
 *
 * SINIR (dogru anlasilmasi icin acikca yaziliyor): hostname allowlist'i tek
 * basina DNS rebinding'i engellemez -- `evil.com` 127.0.0.1'e cozulebilir.
 * Bu yuzden evaluateEgress hem hostname'i hem *cozulmus adresi* alir ve
 * proxy'nin baglanti aninda, cozumden SONRA yeniden cagirmasi zorunludur.
 * Yalnizca hostname ile alinan karar guvenli degildir.
 */

/** Politika modu. Varsayilan daima deny-all. */
export type EgressMode = 'deny-all' | 'allowlist';

export interface EgressPolicy {
  readonly mode: EgressMode;
  /** Tam eshleme (`api.anthropic.com`) veya son-ek jokeri (`*.githubusercontent.com`). */
  readonly allowedHosts: readonly string[];
  /** allowlist modunda zorunlu, deny-all modunda null. Audit kaydina gider. */
  readonly justification: string | null;
}

export class EgressPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressPolicyError';
  }
}

export class EgressDeniedError extends Error {
  constructor(
    message: string,
    readonly host: string,
    readonly rule: EgressRule,
  ) {
    super(message);
    this.name = 'EgressDeniedError';
  }
}

/**
 * IPv4 altyapi araliklari. Sandbox'in hicbir kiracisi bunlara ulasamaz.
 * Liste RFC1918/RFC6890 ozel kullanim araliklarini ve bulut metadata
 * uc noktasini kapsar.
 */
const BLOCKED_IPV4_RANGES: readonly { readonly cidr: string; readonly why: string }[] = [
  { cidr: '0.0.0.0/8', why: 'bu-host / gecersiz' },
  { cidr: '10.0.0.0/8', why: 'ozel ag' },
  { cidr: '100.64.0.0/10', why: 'CGNAT / mesh VPN' },
  { cidr: '127.0.0.0/8', why: 'loopback -- host servisleri' },
  { cidr: '169.254.0.0/16', why: 'link-local / bulut metadata' },
  { cidr: '172.16.0.0/12', why: 'ozel ag -- Docker koprulerinin varsayilani' },
  { cidr: '192.168.0.0/16', why: 'ozel ag' },
  { cidr: '198.18.0.0/15', why: 'benchmark ayrilmis' },
  { cidr: '224.0.0.0/4', why: 'multicast' },
  { cidr: '240.0.0.0/4', why: 'ayrilmis' },
];

interface Range4 {
  readonly base: number;
  readonly bits: number;
  readonly why: string;
}

function parseIpv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let numeric = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    numeric = numeric * 256 + octet;
  }
  return numeric >>> 0;
}

const PARSED_IPV4_RANGES: readonly Range4[] = BLOCKED_IPV4_RANGES.map(({ cidr, why }) => {
  const [address, prefix] = cidr.split('/');
  const base = parseIpv4(address ?? '');
  if (base === null || prefix === undefined) {
    throw new EgressPolicyError(`Bozuk dahili CIDR tanimi: ${cidr}`);
  }
  return { base, bits: Number(prefix), why };
});

function blockedIpv4Reason(numeric: number): string | null {
  for (const range of PARSED_IPV4_RANGES) {
    const shift = 32 - range.bits;
    if (numeric >>> shift === range.base >>> shift) return range.why;
  }
  return null;
}

function blockedIpv6Reason(value: string): string | null {
  const address = value.toLowerCase();

  // IPv4-mapped (::ffff:10.0.0.1) ve IPv4-compatible formlar IPv4 kurallarina tabi.
  const mapped = /^::(?:ffff:)?((?:\d{1,3}\.){3}\d{1,3})$/.exec(address);
  if (mapped?.[1]) {
    const numeric = parseIpv4(mapped[1]);
    return numeric === null ? 'bicimsiz IPv4-mapped adres' : blockedIpv6MappedReason(numeric);
  }

  if (address === '::' || address === '::1') return 'IPv6 loopback / belirsiz';
  if (/^f[cd][0-9a-f]{0,2}:/.test(address)) return 'IPv6 unique-local (fc00::/7)';
  if (/^fe[89ab][0-9a-f]?:/.test(address)) return 'IPv6 link-local (fe80::/10)';
  if (/^ff[0-9a-f]{2}:/.test(address)) return 'IPv6 multicast';
  return null;
}

function blockedIpv6MappedReason(numeric: number): string | null {
  const reason = blockedIpv4Reason(numeric);
  return reason === null ? null : `IPv4-mapped IPv6 -> ${reason}`;
}

/** Kabaca "IPv6 gorunuyor" testi; adres ayristirmasi icin degil dallanma icin. */
function looksLikeIpv6(value: string): boolean {
  return value.includes(':');
}

/**
 * Kosulsuz altyapi korumasi. Politika ne derse desin bu kazanir.
 * Donen deger null ise hedef altyapi araliklarinda degildir.
 */
export function blockedInfrastructureReason(host: string): string | null {
  const normalized = normalizeHost(host);

  const numeric = parseIpv4(normalized);
  if (numeric !== null) return blockedIpv4Reason(numeric);
  if (looksLikeIpv6(normalized)) return blockedIpv6Reason(normalized);

  // Cozumlenmemis isimler: yalnizca acik yerel isimler burada yakalanir.
  // Gercek koruma cozulmus adres uzerinde yapilir -- bkz. dosya basligi.
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return 'localhost adi';
  }
  if (normalized.endsWith('.internal') || normalized.endsWith('.local')) {
    return 'dahili isim alani';
  }
  return null;
}

function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  // Mutlak DNS adlarinin sonundaki nokta eslemeyi bozmasin.
  while (value.endsWith('.')) value = value.slice(0, -1);
  return value;
}

const HOST_ENTRY_PATTERN =
  /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

function assertValidHostEntry(entry: string): string {
  const normalized = normalizeHost(entry);
  if (normalized.length === 0) {
    throw new EgressPolicyError('Bos allowlist girdisi.');
  }
  if (/[:/?#]/.test(normalized)) {
    throw new EgressPolicyError(
      `Allowlist girdisi yalnizca host olmali, sema/port/yol icermez: ${JSON.stringify(entry)}`,
    );
  }
  if (parseIpv4(normalized) === null && !HOST_ENTRY_PATTERN.test(normalized)) {
    throw new EgressPolicyError(`Gecersiz allowlist girdisi: ${JSON.stringify(entry)}`);
  }
  return normalized;
}

export function denyAllEgress(): EgressPolicy {
  return { mode: 'deny-all', allowedHosts: [], justification: null };
}

/**
 * Genis politika gerekce ister. Neden: allowlist'i genisletmek bir guvenlik
 * karari; audit log'da niye genisletildigi yazili olmadan uretilmemeli.
 */
export function allowlistEgress(input: {
  hosts: readonly string[];
  justification: string;
}): EgressPolicy {
  if (input.justification.trim().length < 8) {
    throw new EgressPolicyError('Egress allowlist icin anlamli bir gerekce zorunlu.');
  }
  if (input.hosts.length === 0) {
    throw new EgressPolicyError('Bos allowlist icin denyAllEgress() kullan.');
  }

  const hosts = input.hosts.map(assertValidHostEntry);

  // Yanlis yapilandirma acilista patlar, ilk istekte degil.
  for (const host of hosts) {
    const blocked = blockedInfrastructureReason(host);
    if (blocked !== null) {
      throw new EgressPolicyError(
        `Allowlist'e altyapi hedefi yazilamaz (${blocked}): ${JSON.stringify(host)}`,
      );
    }
  }

  return { mode: 'allowlist', allowedHosts: hosts, justification: input.justification };
}

export type EgressRule =
  'infrastructure-guard' | 'deny-all' | 'not-in-allowlist' | 'allowlist-match';

export interface EgressVerdict {
  readonly allowed: boolean;
  readonly rule: EgressRule;
  readonly reason: string;
}

export interface EgressTarget {
  readonly host: string;
  /**
   * DNS cozumunden SONRA gelen adres. Proxy baglanti aninda bunu doldurmak
   * ZORUNDA; aksi halde allowlist'teki bir isim ic aga yonlendirilebilir.
   */
  readonly resolvedIp?: string;
}

function matchesHostEntry(host: string, entry: string): boolean {
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1); // '.example.com'
    // Joker yalnizca alt alan adlarini kapsar; koku kapsamaz.
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === entry;
}

/**
 * Tek karar noktasi. Altyapi korumasi her zaman ilk sirada calisir; bu yuzden
 * allowlist'e sizmis ya da DNS ile ic aga yonlenmis bir hedef gecemez.
 */
export function evaluateEgress(policy: EgressPolicy, target: EgressTarget): EgressVerdict {
  const host = normalizeHost(target.host);

  for (const candidate of [host, target.resolvedIp]) {
    if (candidate === undefined) continue;
    const blocked = blockedInfrastructureReason(candidate);
    if (blocked !== null) {
      return {
        allowed: false,
        rule: 'infrastructure-guard',
        reason: `Altyapi hedefi reddedildi (${blocked}): ${normalizeHost(candidate)}`,
      };
    }
  }

  if (policy.mode === 'deny-all') {
    return { allowed: false, rule: 'deny-all', reason: `Egress kapali: ${host}` };
  }

  const matched = policy.allowedHosts.some((entry) => matchesHostEntry(host, entry));
  return matched
    ? { allowed: true, rule: 'allowlist-match', reason: `Allowlist esledi: ${host}` }
    : { allowed: false, rule: 'not-in-allowlist', reason: `Allowlist'te yok: ${host}` };
}

export function assertEgressAllowed(policy: EgressPolicy, target: EgressTarget): void {
  const verdict = evaluateEgress(policy, target);
  if (!verdict.allowed) {
    throw new EgressDeniedError(verdict.reason, normalizeHost(target.host), verdict.rule);
  }
}
