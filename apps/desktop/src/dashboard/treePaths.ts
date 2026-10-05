import type { FsRoot } from './api.js';

const trimEnd = (path: string): string => path.replace(/[\\/]+$/, '');

/**
 * Bir dosyayi agacta gorunur kilmak icin acilacak dizinler: dosyanin ait oldugu
 * kok dahil, dosyaya kadar her ust dizin (sirayla). Yol hicbir kokun altinda
 * degilse bos doner. Kokun ayiraci (\ veya /) korunur; kokler ic ice olabilir
 * (`home` en sonda), ilk eslesen kok kazanir.
 */
export function ancestorDirs(roots: FsRoot[], filePath: string): string[] {
  for (const root of roots) {
    const base = trimEnd(root.path);
    const separator = root.path.includes('\\') ? '\\' : '/';
    if (!filePath.startsWith(base + separator)) continue;

    const folders = filePath
      .slice(base.length + 1)
      .split(/[\\/]/)
      .slice(0, -1);
    const dirs = [root.path];
    let current = base;
    for (const folder of folders) {
      current += separator + folder;
      dirs.push(current);
    }
    return dirs;
  }
  return [];
}
