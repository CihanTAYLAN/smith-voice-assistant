// scripts/check-data-root.mjs kapisinin testi. Kapi iki yonde kanitlanir:
//   - ESKI HAL KIRIK: kapi oncesi kodun gercek satirlari (bu repodan alinti) yakalanir;
//   - BUGUNKU KOD GECER: gercek repo taramasi temiz, izin listesinde bayat kayit yok.
// Calistirma: node --test scripts/check-data-root.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALLOWLIST,
  applyAllowlist,
  findStaleEntries,
  listFiles,
  scanRepo,
  scanText,
  validateAllowlist,
} from './check-data-root.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gateScript = join(repoRoot, 'scripts', 'check-data-root.mjs');

// Kapi oncesi kodun GERCEK satirlari (git gecmisinden birebir): hepsi yakalanmali.
const OLD_CODE_LINES = [
  ['rust window.rs', 'let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);'],
  ['rust env_file.rs', 'let base = std::env::var_os("APPDATA").map(PathBuf::from);'],
  ['rust telemetry.rs', 'let dir = match std::env::var("LOCALAPPDATA") {'],
  [
    'rust proactive_memory.rs',
    'std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("smith/proaktif-bellek.json"))',
  ],
  ['powershell smith-common.ps1', "if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'smith' }"],
  ['powershell gateway-dev.ps1', '$secretDir = Join-Path $env:LOCALAPPDATA "smith"'],
  [
    'powershell smith-env-export.ps1',
    '[string]$OutFile = (Join-Path $env:APPDATA "smith\\smith.env"),',
  ],
  ['python speaker_server.py', 'base = os.environ.get("LOCALAPPDATA") or os.path.join('],
  ['node ornek', "const dir = join(process.env.LOCALAPPDATA ?? '', 'smith');"],
  ['yol sabiti', 'const p = "C:\\\\Users\\\\x\\\\AppData\\\\Local\\\\smith\\\\logs";'],
  ['yol sabiti (roaming, /)', "const p = 'C:/Users/x/AppData/Roaming/smith';"],
  ['rust dirs api', 'let d = dirs::data_local_dir().unwrap();'],
  ['tauri path api', 'let d = app.path().app_data_dir()?;'],
  ['python platformdirs', 'd = platformdirs.user_data_dir("smith")'],
  ['dotnet SpecialFolder', "[Environment]::GetFolderPath('LocalApplicationData')"],
];

// Yeni kural satirlari ve duz yazi: HICBIRI ihlal degil.
const CLEAN_LINES = [
  'std::env::var_os("USERPROFILE").map(PathBuf::from)',
  'let root = crate::paths::data_dir();',
  "$dir = Join-Path $env:USERPROFILE '.smith'",
  'return join(home(), ".smith");',
  'SMITH_DATA_DIR ya da %USERPROFILE%\\.smith',
  '// AppData tabanli yol yok (MSIX yonlendirmesi)',
  'let x = SMITH_APPDATA_ADI;',
  'fn data_dir() -> Option<PathBuf> {',
  'def data_dir() -> pathlib.Path:',
];

test('eski kodun gercek satirlari yakalanir (kapi eski halde kirmizi)', () => {
  for (const [ad, satir] of OLD_CODE_LINES) {
    const hits = scanText('x', satir);
    assert.equal(hits.length, 1, `${ad}: yakalanmadi -> ${satir}`);
  }
});

test('yeni kural satirlari ve duz yazi ihlal sayilmaz', () => {
  for (const satir of CLEAN_LINES) {
    assert.deepEqual(scanText('x', satir), [], `yanlis pozitif: ${satir}`);
  }
});

test('ihlal raporu dosya, satir no ve kural kimligini tasir', () => {
  const hits = scanText(
    'scripts/a.ps1',
    ['# temiz', "$d = Join-Path $env:LOCALAPPDATA 'smith'", 'x'].join('\n'),
  );
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].path, hits[0].line, hits[0].rule], ['scripts/a.ps1', 2, 'appdata-env']);
});

test('izin listesi dosya + satir deseniyle eslesir; ayni satir baska dosyada ihlaldir', () => {
  const entry = {
    path: 'a/dosya.ps1',
    match: /Docker\\wsl/,
    reason: 'Docker disk yolu, Smith durumu degil',
  };
  const line = "Join-Path $env:LOCALAPPDATA 'Docker\\wsl\\disk\\x.vhdx'";
  const izinli = applyAllowlist(scanText('a/dosya.ps1', line), [entry]);
  assert.equal(izinli.violations.length, 0);
  assert.equal(izinli.allowed.length, 1);
  assert.match(izinli.allowed[0].reason, /Docker/);
  const baska = applyAllowlist(scanText('a/baska.ps1', line), [entry]);
  assert.equal(baska.violations.length, 1, 'ayni satir baska dosyada izinli olmamali');
  const baskaSatir = applyAllowlist(
    scanText('a/dosya.ps1', "Join-Path $env:LOCALAPPDATA 'smith'"),
    [entry],
  );
  assert.equal(baskaSatir.violations.length, 1, 'ayni dosyada baska satir izinli olmamali');
});

test('bayat izin kaydi bulunur (hicbir satira eslesmeyen)', () => {
  const kayitlar = [
    { path: 'a.ps1', match: /LOCALAPPDATA/, reason: 'kullanilan kayit, gerekce yeterince uzun' },
    { path: 'b.ps1', match: /LOCALAPPDATA/, reason: 'dosya tasinmis, kayit bayat kalmis' },
  ];
  const { usedEntries } = applyAllowlist(scanText('a.ps1', '$env:LOCALAPPDATA'), kayitlar);
  const bayat = findStaleEntries(usedEntries, kayitlar);
  assert.deepEqual(
    bayat.map((e) => e.path),
    ['b.ps1'],
  );
});

test('izin listesinin kendisi gecerli: gerekce zorunlu, yol / ayiricili', () => {
  assert.deepEqual(validateAllowlist(ALLOWLIST), []);
  const kotu = validateAllowlist([
    { path: 'a\\b.ps1', match: /x/, reason: 'yeterince uzun bir gerekce' },
    { path: 'a/b.ps1', match: 'x', reason: 'yeterince uzun bir gerekce' },
    { path: 'a/c.ps1', match: /x/, reason: 'kisa' },
  ]);
  assert.equal(kotu.length, 3, kotu.join('; '));
});

test('gecici agacta: taranan uzantilar yakalanir, belge/uretilmis/baska uzantilar taranmaz', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-data-root-'));
  try {
    const dosya = (rel, icerik) => {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, icerik);
    };
    dosya('src/eski.rs', 'let b = std::env::var_os("LOCALAPPDATA");\n');
    dosya('scripts/eski.ps1', "$d = Join-Path $env:APPDATA 'smith'\n");
    dosya('sidecar/eski.py', 'b = os.environ["LOCALAPPDATA"]\n');
    dosya('docs/03-10-2026/not.md', '%LOCALAPPDATA%\\smith\n');
    dosya('docs/araclar/x.mjs', 'process.env.LOCALAPPDATA\n');
    dosya('apps/desktop/src-tauri/gen/schemas/a.js', 'process.env.APPDATA\n');
    dosya('README.md', '%LOCALAPPDATA%\\smith\n');
    dosya('node_modules/x/index.js', 'process.env.APPDATA\n');
    dosya('temiz.ps1', "$d = Join-Path $env:USERPROFILE '.smith'\n");

    const { violations, files } = scanRepo(dir, []);
    assert.deepEqual(violations.map((v) => v.path).sort(), [
      'scripts/eski.ps1',
      'sidecar/eski.py',
      'src/eski.rs',
    ]);
    assert.ok(files.includes('temiz.ps1'));
    assert.ok(
      !files.some((f) => f.startsWith('docs/') || f.includes('/gen/') || f.endsWith('.md')),
    );
    assert.deepEqual(listFiles(dir).sort(), files.slice().sort());

    // CLI: ihlalli agacta cikis 1 ve dosya:satir basar; temiz agacta cikis 0.
    const kirmizi = spawnSync(process.execPath, [gateScript, '--root', dir], { encoding: 'utf8' });
    assert.equal(kirmizi.status, 1);
    assert.match(kirmizi.stderr, /src\/eski\.rs:1: \[appdata-env\]/);
    const temiz = join(dir, 'temiz-agac');
    mkdirSync(temiz);
    writeFileSync(join(temiz, 'a.ps1'), "$d = Join-Path $env:USERPROFILE '.smith'\n");
    const yesil = spawnSync(process.execPath, [gateScript, '--root', temiz], { encoding: 'utf8' });
    assert.equal(yesil.status, 0, yesil.stderr);
    assert.match(yesil.stdout, /temiz/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUGUNKU REPO temiz: AppData tabanli Smith yolu yok, izin listesinde bayat kayit yok', () => {
  const { violations, allowed, stale, files } = scanRepo(repoRoot);
  assert.ok(files.length > 50, `tarama anlamli sayida dosya gormeli (bulunan ${files.length})`);
  assert.deepEqual(
    violations.map((v) => `${v.path}:${v.line} [${v.rule}] ${v.text}`),
    [],
    'izin listesinde olmayan AppData tabanli kullanim',
  );
  assert.deepEqual(
    stale.map((e) => `${e.path} ${e.match}`),
    [],
    'bayat izin kaydi',
  );
  assert.ok(allowed.length > 0, 'kapi izinli kullanimlari (eski konum okuyan kod vb.) gormeli');
});
