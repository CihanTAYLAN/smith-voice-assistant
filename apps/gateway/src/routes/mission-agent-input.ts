import { z } from 'zod';

/**
 * Ajan tanimindan worker'in motor komut satirina DOGRUDAN akan iki girdi
 * (`--allowedTools`, `--add-dir`). Dogrulama olmadan:
 *
 * - `allowedTools: ["Read", "--dangerously-skip-permissions"]` argv'ye bagimsiz
 *   bayrak olarak girer (variadic liste tireyle baslayan sozcukte biter; olculdu,
 *   t2-worker #25) ve ADR 0007'nin "izin modu allowlist'ten gecer" kapisini deler;
 * - `workRoots: ["C:\\"]` motora tum surucu erisimi verir.
 *
 * Ajani tanimlayabilen rol zaten `admin` ile sinirli (routes/mission.ts); bu sema
 * ikinci katmandir. Izinli kok LISTESI (env) bilincli olarak yok: ayri karar.
 */

/**
 * Arac adi harfle baslar (bu yuzden `-` ile baslayamaz) ve yalniz arac sozdiziminin
 * karakterlerini icerir: `Bash`, `Bash(git:*)`, `WebFetch(domain:x.y)`, `mcp__a__b`.
 * Tirnak, `;`, `$`, satir sonu gibi kabuk/ayrac karakterleri disarida kalir.
 */
const ALLOWED_TOOL_PATTERN = /^[A-Za-z][\w:.*()/@ -]*$/;

export const allowedToolSchema = z
  .string()
  .max(200)
  .regex(
    ALLOWED_TOOL_PATTERN,
    'arac adi harfle baslar; harf, rakam ve : . * ( ) / @ _ - bosluk icerir',
  );

/** C0 kontrol karakterleri ve DEL (NUL, satir sonu, ...). */
function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
const UNC_PREFIX = /^[\\/]{2}/;
/** WSL'de surucu koku: `/mnt/c`. */
const WSL_DRIVE_ROOT = /^mnt\/[A-Za-z]$/;

/**
 * Is koku mutlak bir yol olmali: `/...` (WSL) ya da `C:\...` / `C:/...` (Windows).
 * Reddedilenler: goreli yol ve `-` ile baslayanlar (bayrak gibi okunur), UNC
 * (`\\sunucu\paylasim`, `//sunucu/...`, `\\?\...`), `..` segmenti, kontrol
 * karakterleri ve surucu/dosya sistemi kokleri (`C:\`, `/`, `/mnt/c`).
 */
export function isSafeWorkRoot(root: string): boolean {
  if (hasControlCharacter(root) || UNC_PREFIX.test(root)) return false;
  const windowsDrive = DRIVE_PREFIX.test(root);
  if (!windowsDrive && !root.startsWith('/')) return false;

  const segments = root
    .slice(windowsDrive ? 3 : 1)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.includes('..')) return false;
  return windowsDrive || !WSL_DRIVE_ROOT.test(segments.join('/'));
}

export const workRootSchema = z
  .string()
  .max(400)
  .refine(isSafeWorkRoot, 'is koku mutlak yol olmali (UNC, surucu koku ve .. yasak)');
