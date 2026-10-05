/**
 * Arac calistirma kapisi.
 *
 * Guard MONOTONIKTIR: yalniz *deny* edebilir. Hicbir dinleyici sirasi bir
 * denial'i geri izne ceviremez — dsh'nin `ToolGuard` deseni (ADR 0010).
 * Izin veren tarafin (onay) ayri bir yolu vardir; guard yalnizca reddeder.
 */

import type { Scope } from '@smith/tenancy';
import type { AgentTool } from './tool.js';

export interface GuardInput {
  readonly tool: AgentTool;
  readonly input: unknown;
  readonly scope: Scope;
}

/** Deny sebebini doner; izin veriyorsa undefined. */
export type ToolGuard = (call: GuardInput) => string | undefined;

/** Ilk deny kazanir. Bos liste => izin (monotonik: eklemek yalniz kisitlar). */
export function evaluateGuards(guards: readonly ToolGuard[], call: GuardInput): string | undefined {
  for (const guard of guards) {
    const reason = guard(call);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * Cihaz-tarafi `system_tools.rs`'in DENIED listesinin sunucu-tarafi aynasi
 * (ADR 0010 #4). Geri donusu OLMAYAN sistem komutlarini reddeder; dosya silme
 * gibi geri alinabilir isler bilincli olarak SERBEST.
 *
 * Desenler kelime siniri kullanir: Rust tarafinda `"format "` deseni bir ara
 * `Get-Date -Format ...` icindeki `-Format`'i yakalayip yanlis pozitif
 * uretmisti; o regresyon dersi burada test ile birlikte tasiniyor.
 */
const DENIED_PATTERNS: readonly RegExp[] = [
  /\bformat-volume\b/i,
  /\bformat\s+[a-z]:/i, // format c:
  /\bclear-disk\b/i,
  /\bdiskpart\b/i,
  /\b(?:stop|restart)-computer\b/i,
  /\bshutdown\b/i,
  /\bcipher\s+\/w/i,
  /\bbcdedit\b/i,
  /\bvssadmin\s+delete\b/i,
  /\breg\s+delete\s+hklm\b/i,
  /\bset-mppreference\b/i, // Windows Defender kapatma
  /\brm\s+-rf\s+\//i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
];

const COMMAND_KEYS: readonly string[] = ['command', 'cmd', 'komut', 'script'];

function commandStringOf(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (input !== null && typeof input === 'object') {
    for (const key of COMMAND_KEYS) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
    }
  }
  return undefined;
}

export interface IrreversibleGuardOptions {
  /** Bu adlardaki araclarin komut girdisi taranir. */
  readonly shellToolNames?: readonly string[];
}

const DEFAULT_SHELL_TOOL_NAMES: readonly string[] = [
  'shell',
  'terminal',
  'terminal_calistir',
  'run_powershell',
];

export function createIrreversibleShellGuard(options: IrreversibleGuardOptions = {}): ToolGuard {
  const shellNames = new Set(options.shellToolNames ?? DEFAULT_SHELL_TOOL_NAMES);
  return ({ tool, input }) => {
    if (!shellNames.has(tool.name)) return undefined;
    const command = commandStringOf(input);
    if (command === undefined) return undefined;
    for (const pattern of DENIED_PATTERNS) {
      if (pattern.test(command)) {
        return `Geri donusu olmayan sistem komutu reddedildi (${pattern.source}).`;
      }
    }
    return undefined;
  };
}
