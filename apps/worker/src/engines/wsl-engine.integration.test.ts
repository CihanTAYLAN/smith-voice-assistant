import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runCodex } from './codex.js';
import { collectProcess, terminateProcessTree } from './process-control.js';
import {
  buildWslEngineCommand,
  collectWslEngine,
  listEngineProcesses,
  spawnWslEngine,
  stopWslEngine,
  sweepOrphanWslEngines,
} from './wsl-engine.js';
import { execCapture } from './wsl-path.js';

/**
 * GERCEK WSL ile motor yasam dongusu kaniti. Varsayilan `pnpm test` bunu
 * KOSMAZ (CI Linux'ta `wsl.exe` yok, yerelde soguk WSL acilisi yavas):
 *
 *   SMITH_WSL_INTEGRATION=1 pnpm --filter @smith/worker exec vitest run \
 *     src/engines/wsl-engine.integration.test.ts
 *
 * Gercek `claude` / `codex` CAGRILMAZ: motor yerine WSL'de bir sahte betik
 * kosar (uzun `sleep`, biri `setsid` ile ayri oturuma kacan torun). Bu testin
 * amaci tam olarak "Windows istemcisini oldurmek Linux motorunu oldurmuyor"
 * bulgusunun (t2-worker #3) duzeltildigini olcmektir.
 */

const ENABLED = process.env.SMITH_WSL_INTEGRATION === '1' && process.platform === 'win32';
const FAKE_ENGINE = `/tmp/w3a-fake-engine-${process.pid}.sh`;

const usedRuns = new Set<string>();
let counter = 0;
function newRunId(): string {
  counter += 1;
  const runId = `run_w3aint${process.pid}x${counter}`;
  usedRuns.add(runId);
  return runId;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function family(runId: string): Promise<number[]> {
  return (await listEngineProcesses()).filter((ref) => ref.runId === runId).map((ref) => ref.pid);
}

describe.runIf(ENABLED)('WSL motor yasam dongusu (gercek WSL, sahte motor)', () => {
  beforeAll(async () => {
    // Sahte motor: ayni grupta uzun uyku + SETSID ile ayri oturuma kacan torun.
    const script = [
      '#!/bin/bash',
      "setsid -f bash -c 'exec sleep 300' </dev/null >/dev/null 2>&1",
      'exec sleep 300',
    ].join('\n');
    const created = await execCapture('wsl.exe', [
      '-e',
      'bash',
      '-c',
      `cat > ${FAKE_ENGINE} <<'EOF'\n${script}\nEOF\nchmod +x ${FAKE_ENGINE}`,
    ]);
    expect(created.code).toBe(0);
  }, 60_000);

  afterEach(async () => {
    for (const runId of usedRuns) await stopWslEngine(runId);
    usedRuns.clear();
  }, 60_000);

  afterAll(async () => {
    await execCapture('wsl.exe', ['-e', 'rm', '-f', FAKE_ENGINE]);
  }, 60_000);

  function launch(runId: string, options: { timeoutSeconds?: number; ownerPid?: number } = {}) {
    const command = buildWslEngineCommand({
      runId,
      cwd: '/tmp',
      timeoutSeconds: options.timeoutSeconds ?? 120,
      engineCommand: FAKE_ENGINE,
      promptPath: '/dev/null',
      ...(options.ownerPid === undefined ? {} : { ownerPid: options.ownerPid }),
    });
    return spawnWslEngine(command);
  }

  it('iptal: motor ailesi (setsid torunu dahil) durur ve kosu "durduruldu" doner', async () => {
    const runId = newRunId();
    const controller = new AbortController();
    const child = launch(runId);
    const collecting = collectWslEngine(child, runId, {
      timeoutMs: 120_000,
      signal: controller.signal,
    });

    await sleep(3_000);
    const before = await family(runId);
    expect(before.length).toBeGreaterThanOrEqual(3); // timeout + sleep + setsid torunu
    const t0 = Date.now();
    controller.abort(new Error('worker kapaniyor'));
    const outcome = await collecting;

    expect(outcome.aborted).toBe(true);
    expect(await family(runId)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 60_000);

  it('dis zaman asimi: aile durur', async () => {
    const runId = newRunId();
    const child = launch(runId);

    const outcome = await collectWslEngine(child, runId, { timeoutMs: 3_000 });

    expect(outcome.timedOut).toBe(true);
    expect(await family(runId)).toEqual([]);
  }, 60_000);

  it('ic timeout (cikis 124) grubu oldurur ama setsid torunu kalir; collectWslEngine onu da temizler', async () => {
    // Negatif kontrol: stopRemote OLMADAN ayni durumda kacak torun hayatta kalir.
    const control = newRunId();
    const controlOutcome = await collectProcess(launch(control, { timeoutSeconds: 3 }), {
      timeoutMs: 60_000,
    });
    expect(controlOutcome.exitCode).toBe(124);
    expect((await family(control)).length).toBeGreaterThanOrEqual(1);

    const runId = newRunId();
    const outcome = await collectWslEngine(launch(runId, { timeoutSeconds: 3 }), runId, {
      timeoutMs: 60_000,
    });

    expect(outcome.exitCode).toBe(124);
    expect(await family(runId)).toEqual([]);
  }, 60_000);

  it('worker zorla olurse (istemci taskkill) kacak torun yetim kalir; acilis taramasi supurur', async () => {
    const orphanRun = newRunId();
    const aliveRun = newRunId();
    const DEAD_OWNER = 2_000_000_000;
    const orphanClient = launch(orphanRun, { ownerPid: DEAD_OWNER });
    const aliveClient = launch(aliveRun); // sahibi bu test sureci: canli

    await sleep(3_000);
    expect((await family(orphanRun)).length).toBeGreaterThanOrEqual(3);
    terminateProcessTree(orphanClient); // worker taskkill /T /F ile olmus gibi
    await sleep(3_000);

    const left = await family(orphanRun);
    expect(left.length).toBeGreaterThanOrEqual(1); // en az setsid torunu yetim

    const swept = await sweepOrphanWslEngines();

    expect(swept).toContain(orphanRun);
    expect(swept).not.toContain(aliveRun);
    expect(await family(orphanRun)).toEqual([]);
    expect((await family(aliveRun)).length).toBeGreaterThanOrEqual(3); // canli sahipli aile korundu
    terminateProcessTree(aliveClient);
  }, 90_000);

  it('runCodex uctan uca: iptal edilen WSL kosusu ailesini birakmaz ve engine.log yazar', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'smith-w3a-int-'));
    const workRoot = join(dataRoot, 'is koku');
    await mkdir(workRoot, { recursive: true });
    const previousDataDir = process.env.SMITH_DATA_DIR;
    process.env.SMITH_DATA_DIR = dataRoot;
    const runId = newRunId();
    const controller = new AbortController();
    try {
      const running = runCodex({
        runId,
        systemPrompt: 'sistem',
        prompt: 'gorev',
        cwd: workRoot,
        workRoots: [workRoot],
        allowedTools: [],
        host: 'wsl',
        sandbox: 'read-only',
        bin: FAKE_ENGINE,
        signal: controller.signal,
      });
      await sleep(4_000);
      expect((await family(runId)).length).toBeGreaterThanOrEqual(3);
      controller.abort(new Error('SIGTERM: worker kapaniyor'));

      const result = await running;

      expect(result).toMatchObject({ ok: false, timedOut: false });
      expect(result.text).toBe('Kosu durduruldu: SIGTERM: worker kapaniyor');
      expect(result.logPath).toBe(join(dataRoot, 'mission', 'runs', runId, 'engine.log'));
      expect(await family(runId)).toEqual([]);
    } finally {
      if (previousDataDir === undefined) delete process.env.SMITH_DATA_DIR;
      else process.env.SMITH_DATA_DIR = previousDataDir;
      await rm(dataRoot, { recursive: true, force: true });
    }
  }, 90_000);
});
