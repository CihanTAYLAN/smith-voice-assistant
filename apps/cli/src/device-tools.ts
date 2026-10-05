import os from 'node:os';

/**
 * Istemci-tarafi (device-locus) arac yurutucusu.
 *
 * Gateway tool-loop'ta model bir `locus:'device'` araci cagirinca, gateway
 * `tool_call` frame'i yollar (bkz. apps/gateway device-bridge); CLI o araci YEREL
 * calistirir ve `tool_result` doner. Karar modelde, yurutme cihazda.
 *
 * Bugun tek arac: `cihaz_bilgisi` — SALT-OKUR sistem bilgisi, sandbox gerektirmez.
 * Kabuk/dosya gibi geri-donussuz ya da keyfi-exec araclar Faz 3 sandbox (Docker+
 * gVisor + egress) gelene kadar EKLENMEZ (AGENTS.md §2).
 */

export interface DeviceToolResult {
  readonly ok: boolean;
  readonly result: unknown;
}

export function executeDeviceTool(name: string, _input: unknown): DeviceToolResult {
  switch (name) {
    case 'cihaz_bilgisi':
      return { ok: true, result: deviceInfo() };
    default:
      return { ok: false, result: { error: 'bilinmeyen device araci', name } };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function deviceInfo(): Record<string, unknown> {
  return {
    platform: os.platform(),
    release: os.release(),
    hostname: os.hostname(),
    arch: os.arch(),
    cpuCount: os.cpus().length,
    totalMemGb: round1(os.totalmem() / 1024 ** 3),
    freeMemGb: round1(os.freemem() / 1024 ** 3),
    uptimeSaat: round1(os.uptime() / 3600),
  };
}
