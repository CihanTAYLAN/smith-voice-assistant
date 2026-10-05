#!/usr/bin/env node
// Veri koku kapisi: Smith durum dosyalari TEK veri kokunde durur (SMITH_DATA_DIR ya da
// %USERPROFILE%\.smith, Windows disinda ~/.smith). AppData tabanli (LOCALAPPDATA / APPDATA)
// Smith yolu repoya GIRMEZ. Talimat tavsiyedir, bu kapi garantidir.
//
// NEDEN VAR (2026-10-03, sahada olculdu): Claude masaustu uygulamasi MSIX paketidir; ondan
// baslatilan surecler AppData yazilarini gizli paket klasorune yonlendirir, zamanlanmis gorevler
// ve kullanicinin terminali ise GERCEK AppData'yi gorur. Sonuc iki ayri "gercek": ses izi kaydi
// eski uyarlama dosyasini silemedi, yedek aynasi ayari gece gorevine gorunmedi, gunlukler, oturum
// sirri, smith-up kilidi ve health.json ikiye bolundu. Ayni hata sinifi daha once de yasanmisti
// (ADR 0006). Bu kapi o sinifi kaynakta yakalar.
//
// NE TARAR: git'in izledigi (ve henuz eklenmemis ama yok sayilmayan) kod dosyalari: .rs .ps1
// .py .ts .tsx .js .mjs .cjs .sh .yml .yaml. docs/ (belge ve tarihli gun kayitlari) ve
// uretilmis dosyalar (src-tauri/gen) taranmaz. Aranan: LOCALAPPDATA/APPDATA ortam degiskenleri,
// AppData\Local|Roaming yol sabitleri, platform dizin API'leri (dirs/Tauri/platformdirs/.NET
// SpecialFolder). "AppData" kelimesinin duz yazi olarak gecmesi (yol ya da ortam degiskeni
// olmadan) sorun degildir.
//
// ISTISNALAR: asagidaki ALLOWLIST ACIK ve gerekcelidir. Her kayit bir dosya + o dosyadaki izinli
// satirin deseni + neden tasir; kayit hicbir satira eslesmezse (dosya tasindi, kod degisti)
// kapi BAYAT KAYIT diye kirmizi olur: izin listesi sessizce curumez.
//
// Kullanim:
//   node scripts/check-data-root.mjs            # tum repo (git ls-files); cikis 0 = temiz
//   node scripts/check-data-root.mjs --root <dizin>   # baska bir agac (git yoksa dizin gezilir)
// Cikis: 0 = temiz, 1 = ihlal ya da bayat izin kaydi.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCANNED_EXTENSIONS = new Set([
  '.rs',
  '.ps1',
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.sh',
  '.yml',
  '.yaml',
]);

// Taranmayan yol onekleri ('/' ayiricili, repo kokune gore).
const EXCLUDED_PREFIXES = [
  'docs/', // belgeler ve tarihli gun kayitlari (yasayan belgeler elle guncellenir)
  'apps/desktop/src-tauri/gen/', // uretilmis semalar
  '.claude/worktrees/', // ic ice worktree'ler
  'node_modules/',
  'target/',
  'dist/',
];
const EXCLUDED_FILES = new Set(['pnpm-lock.yaml']);

// Kurallar: kimlik + desen (satir bazli). Ortam degiskeni adlari BUYUK harfle ve duz kelime
// siniriyla aranir (SMITH_APPDATA_X gibi adlar eslesmez); yol sabiti buyuk/kucuk harf duyarsiz.
export const RULES = [
  { id: 'appdata-env', re: /\b(?:LOCAL)?APPDATA\b/ },
  { id: 'appdata-path', re: /AppData[\\/]+(?:Local|Roaming|LocalLow)\b/i },
  {
    id: 'dir-api-rust',
    re: /\b(?:local_data_dir|data_local_dir|app_local_data_dir|app_data_dir|app_config_dir|app_cache_dir|app_log_dir|ProjectDirs|BaseDirs)\b/,
  },
  {
    id: 'dir-api-python',
    re: /\b(?:platformdirs|appdirs|user_data_dir|user_config_dir|user_cache_dir|user_log_dir)\b/,
  },
  {
    id: 'dir-api-dotnet',
    re: /\b(?:LocalApplicationData|CommonApplicationData|ApplicationData)\b/,
  },
  { id: 'dir-api-node', re: /\b(?:env-paths|xdg-basedir)\b/ },
];

// ACIK IZIN LISTESI. path: repo-kokune gore '/' ayiricili tam yol; match: satirda aranan desen
// (satirin TAMAMI degil, o izinli kullanimi taniyan parca); reason: neden izinli.
export const ALLOWLIST = [
  // --- Eski (AppData tabanli) konumlari OKUYAN kod: tasima betigi ve acilis uyarisi ---------
  {
    path: 'scripts/smith-migrate-data.ps1',
    match: /./,
    reason:
      'tasima betigi eski (AppData tabanli) iki konumu OKUR; hedefe/kaynaga AppData yazmaz (guvenlik korumasi testli)',
  },
  {
    path: 'scripts/smith-migrate-data-test.ps1',
    match: /./,
    reason: 'tasima betigi testi: sahte LocalAppData ile eski konum korumasini sinar',
  },
  {
    path: 'scripts/smith-common.ps1',
    match: /^# (?:ASLA %LOCALAPPDATA%|Eski veri konumlari: gercek %LOCALAPPDATA%)/,
    reason: 'veri koku kuralinin gerekcesini ve eski konum tanimini anlatan baslik yorumlari',
  },
  {
    path: 'scripts/smith-common.ps1',
    match: /AppData\\Local\\Packages\\<aile>/,
    reason: 'MSIX paket deposunun yolunu aciklayan yorumlar (paket kopyasi nerede)',
  },
  {
    path: 'scripts/smith-common.ps1',
    match: /param\(\[string\]\$LocalAppData = \$env:LOCALAPPDATA\)/,
    reason:
      'Get-SmithLegacyDataRoots: eski konumlari bulmak icin LocalAppData (yalniz tasima betigi ve acilis uyarisi okur)',
  },
  {
    path: 'scripts/smith-common.ps1',
    match: /Docker\\wsl\\disk\\docker_data\.vhdx/,
    reason:
      'Docker Desktop VHDX yolu: Smith durumu degil, disk esigi olcumu icin Docker verisinin konumu',
  },
  {
    path: 'apps/desktop/src-tauri/src/system_tools.rs',
    match: /appdata\\\\local\\\\temp/,
    reason:
      'dosya arama gurultu listesi: kullanicinin TEMP dizini aramalardan elenir, Smith durumu degil',
  },
  {
    path: 'scripts/smith-common-test.ps1',
    match: /LOCALAPPDATA|APPDATA|AppData/i,
    reason:
      'veri koku testi: LOCALAPPDATA/APPDATA kurulu olsa bile AppData tabanli YOL cikmadigini kanitlar',
  },
  {
    path: 'scripts/dev-win.ps1',
    match: /Microsoft\\WinGet\\Packages\\Kitware\.CMake/,
    reason: 'winget ile kurulan CMake konumu (arac yolu), Smith durum dosyasi degil',
  },
  {
    path: 'apps/desktop/src-tauri/src/paths.rs',
    match: /./,
    reason:
      'tek veri koku modulu: kuralin gerekcesi, eski konum uyarisi ve "AppData asla kullanilmaz" testleri',
  },
  {
    path: 'apps/desktop/sidecar/smith_paths.py',
    match: /./,
    reason: 'tek veri koku modulu (sidecar): kuralin gerekcesi ve eski konum uyarisi',
  },
  {
    path: 'apps/desktop/sidecar/test_smith_paths.py',
    match: /./,
    reason:
      'veri koku testi: LOCALAPPDATA/APPDATA kurulu olsa bile AppData tabanli YOL cikmadigini kanitlar',
  },
  {
    path: 'apps/worker/src/engines/run-dir.ts',
    match: /LOCALAPPDATA|APPDATA/,
    reason: 'veri koku kuralinin gerekcesini anlatan yorum (MSIX)',
  },
  {
    path: 'apps/worker/src/engines/run-dir.test.ts',
    match: /LOCALAPPDATA|APPDATA/,
    reason:
      'veri koku testi: LOCALAPPDATA/APPDATA kurulu olsa bile AppData tabanli YOL cikmadigini kanitlar',
  },
  // --- Kapinin kendisi ---------------------------------------------------------------------
  {
    path: 'scripts/check-data-root.mjs',
    match: /./,
    reason: 'kapinin kendi desenleri ve aciklamalari',
  },
  {
    path: 'scripts/check-data-root.test.mjs',
    match: /./,
    reason: 'kapinin testi: eski kodu temsil eden ornek satirlar',
  },
];

function toPosix(p) {
  return p.split(sep).join('/');
}

function isExcluded(relPath) {
  if (EXCLUDED_FILES.has(relPath.split('/').pop() ?? '')) return true;
  return EXCLUDED_PREFIXES.some(
    (prefix) => relPath.startsWith(prefix) || relPath.includes(`/${prefix}`),
  );
}

function hasScannedExtension(relPath) {
  const dot = relPath.lastIndexOf('.');
  return dot >= 0 && SCANNED_EXTENSIONS.has(relPath.slice(dot).toLowerCase());
}

/** Bir dosyanin metnini tarar; her ihlal {path, line, text, rule}. Izin listesi UYGULANMAZ. */
export function scanText(relPath, text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        hits.push({ path: relPath, line: i + 1, text: line.trim().slice(0, 160), rule: rule.id });
        break; // satir basina tek rapor yeter
      }
    }
  }
  return hits;
}

/** Ham ihlalleri izin listesine gore ayirir: { violations, allowed, usedEntries }. */
export function applyAllowlist(hits, allowlist = ALLOWLIST) {
  const violations = [];
  const allowed = [];
  const used = new Set();
  for (const hit of hits) {
    const entryIndex = allowlist.findIndex((e) => e.path === hit.path && e.match.test(hit.text));
    if (entryIndex >= 0) {
      allowed.push({ ...hit, reason: allowlist[entryIndex].reason });
      used.add(entryIndex);
    } else {
      violations.push(hit);
    }
  }
  return { violations, allowed, usedEntries: used };
}

/** Hicbir ham ihlale eslesmeyen (bayat) izin kayitlari. */
export function findStaleEntries(usedEntries, allowlist = ALLOWLIST) {
  return allowlist.filter((_, i) => !usedEntries.has(i));
}

/** Izin listesi biciminin kendisini denetler (gerekce zorunlu, desen RegExp, yol '/' ayiricili). */
export function validateAllowlist(allowlist = ALLOWLIST) {
  const problems = [];
  for (const [i, e] of allowlist.entries()) {
    if (typeof e.path !== 'string' || e.path.includes('\\') || e.path.startsWith('/'))
      problems.push(`#${i}: path gecersiz`);
    if (!(e.match instanceof RegExp)) problems.push(`#${i} (${e.path}): match RegExp olmali`);
    if (typeof e.reason !== 'string' || e.reason.trim().length < 15)
      problems.push(`#${i} (${e.path}): gerekce zorunlu`);
  }
  return problems;
}

function gitFiles(root) {
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return out.split('\0').filter(Boolean);
  } catch {
    return null; // git yok / depo degil
  }
}

function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'target') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(root, full, out);
    else out.push(toPosix(relative(root, full)));
  }
  return out;
}

/** Kok altindaki taranacak dosyalar: once git (izlenen + izlenmeyen-ama-yok-sayilmayan), yoksa yuru. */
export function listFiles(root) {
  const git = existsSync(join(root, '.git')) ? gitFiles(root) : null;
  const files = (git ?? walk(root)).map(toPosix);
  return files.filter((f) => hasScannedExtension(f) && !isExcluded(f));
}

/** Tum agaci tarar. Sonuc: { files, violations, allowed, stale }. */
export function scanRepo(root, allowlist = ALLOWLIST) {
  const files = listFiles(root);
  const hits = [];
  for (const rel of files) {
    const full = join(root, rel);
    if (!existsSync(full)) continue; // silinmis ama indekste duran dosya
    hits.push(...scanText(rel, readFileSync(full, 'utf8')));
  }
  const { violations, allowed, usedEntries } = applyAllowlist(hits, allowlist);
  return { files, violations, allowed, stale: findStaleEntries(usedEntries, allowlist) };
}

function main(argv) {
  const rootArg = argv.indexOf('--root');
  const here = dirname(fileURLToPath(import.meta.url));
  const root = rootArg >= 0 ? resolve(argv[rootArg + 1] ?? '') : resolve(here, '..');
  const allowlistProblems = validateAllowlist();
  const { files, violations, allowed, stale } = scanRepo(root);
  let failed = false;

  if (allowlistProblems.length > 0) {
    failed = true;
    console.error('check-data-root: izin listesi gecersiz:');
    for (const p of allowlistProblems) console.error(`  ${p}`);
  }
  if (violations.length > 0) {
    failed = true;
    console.error(
      `check-data-root: ${violations.length} AppData tabanli kullanim (izin listesinde degil):`,
    );
    for (const v of violations) console.error(`  ${v.path}:${v.line}: [${v.rule}] ${v.text}`);
    console.error(
      '\n  Smith durum dosyalari tek veri kokunde durur: SMITH_DATA_DIR ya da %USERPROFILE%\\.smith (Windows disinda ~/.smith).\n' +
        '  Rust: crate::paths::data_dir(); Python: smith_paths.data_root(); PowerShell: Resolve-SmithDataDir/Get-SmithDataDir;\n' +
        '  Node: smithDataDir() (apps/worker/src/engines/run-dir.ts). MSIX gerekcesi: scripts/smith-common.ps1 basligi.\n' +
        "  Gercekten Smith durumu olmayan bir kullanimsa scripts/check-data-root.mjs ALLOWLIST'ine gerekceyle ekle.",
    );
  }
  if (stale.length > 0 && rootArg < 0) {
    // Bayat kayit denetimi yalniz bu reponun kendi taramasinda anlamlidir.
    failed = true;
    console.error(
      `check-data-root: ${stale.length} bayat izin kaydi (hicbir satira eslesmiyor, kaldir ya da guncelle):`,
    );
    for (const e of stale) console.error(`  ${e.path}  match=${e.match}  (${e.reason})`);
  }
  if (failed) process.exit(1);
  console.log(
    `check-data-root: temiz (${files.length} dosya tarandi, ${allowed.length} izinli kullanim, ${ALLOWLIST.length} izin kaydi).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
