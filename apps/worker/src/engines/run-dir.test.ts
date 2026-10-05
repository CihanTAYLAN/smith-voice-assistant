import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertRunId,
  engineRunDir,
  prepareEngineRunDir,
  smithDataDir,
  writeEngineLog,
} from './run-dir.js';

const FAKE_HOME = join('C:', 'Users', 'x');
const home = () => FAKE_HOME;

describe('smithDataDir (tek veri koku kurali)', () => {
  it('SMITH_DATA_DIR varsa o kullanilir (varsayilani ezer)', () => {
    expect(smithDataDir({ SMITH_DATA_DIR: join('D:', 'veri') }, home)).toBe(join('D:', 'veri'));
  });

  it('bos veya yalniz bosluk deger tanimsiz sayilir, dolu deger kirpilir', () => {
    for (const blank of ['', '   ', '\t']) {
      expect(smithDataDir({ SMITH_DATA_DIR: blank }, home)).toBe(join(FAKE_HOME, '.smith'));
    }
    expect(smithDataDir({ SMITH_DATA_DIR: `  ${join('D:', 'veri')}  ` }, home)).toBe(
      join('D:', 'veri'),
    );
  });

  it('varsayilan ev dizini altinda .smith', () => {
    expect(smithDataDir({}, home)).toBe(join(FAKE_HOME, '.smith'));
  });

  it('LOCALAPPDATA / APPDATA kurulu olsa bile ASLA kullanilmaz', () => {
    const env = {
      LOCALAPPDATA: join(FAKE_HOME, 'AppData', 'Local'),
      APPDATA: join(FAKE_HOME, 'AppData', 'Roaming'),
    };
    const dir = smithDataDir(env, home);
    expect(dir).toBe(join(FAKE_HOME, '.smith'));
    expect(dir).not.toContain('AppData');
  });
});

describe('engineRunDir / prepareEngineRunDir', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('kosu dizini veri kokunun altinda mission/runs/<runId>', () => {
    const root = join(tmpdir(), 'smith-veri-koku');
    expect(engineRunDir('run_1', { SMITH_DATA_DIR: root })).toBe(
      join(root, 'mission', 'runs', 'run_1'),
    );
    expect(engineRunDir('run_1', {})).toBe(join(smithDataDir({}), 'mission', 'runs', 'run_1'));
  });

  it('dizin gecici veri kokunde olusturulur (gercek veri kokune yazilmaz)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smith-run-dir-'));
    created.push(root);
    const dir = await prepareEngineRunDir('run_2', { SMITH_DATA_DIR: root });
    expect(dir).toBe(join(root, 'mission', 'runs', 'run_2'));
    expect((await stat(dir)).isDirectory()).toBe(true);
  });
});

describe('assertRunId', () => {
  it.each(['run_abc123', 'run-1', 'A_b-9'])('%s gecerli kosu kimligidir', (runId) => {
    expect(() => assertRunId(runId)).not.toThrow();
  });

  it.each(['', 'run; rm -rf ~', 'a b', '../x', 'run$(id)', "run'x", 'run\nx'])(
    '%j kabuk komutuna ve yola girmeden reddedilir',
    (runId) => {
      expect(() => assertRunId(runId)).toThrow(/Gecersiz runId/);
    },
  );
});

describe('writeEngineLog (en iyi caba)', () => {
  const created: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('yazar ve dosya yolunu dondurur', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smith-engine-log-'));
    created.push(root);
    const path = join(root, 'engine.log');

    await expect(writeEngineLog(path, 'icerik')).resolves.toBe(path);
    await expect(readFile(path, 'utf8')).resolves.toBe('icerik');
  });

  it('yazilamazsa firlatmaz: uyari verir ve olmayan dosyayi gostermemek icin bos yol doner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smith-engine-log-'));
    created.push(root);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const path = join(root, 'olmayan-dizin', 'engine.log');

    await expect(writeEngineLog(path, 'icerik')).resolves.toBe('');
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('engine.log yazilamadi'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(path));
  });
});
