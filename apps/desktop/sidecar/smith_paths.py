"""Smith durum dosyalarinin TEK veri koku (sidecar tarafi).

TEK KURAL (Rust `src-tauri/src/paths.rs`, `scripts/smith-common.ps1`
`Resolve-SmithDataDir` ve `apps/worker/src/engines/run-dir.ts` ile AYNI):
  1. `SMITH_DATA_DIR` tanimli ve bos degilse o,
  2. degilse Windows'ta `%USERPROFILE%\\.smith`, diger sistemlerde `~/.smith`.

ASLA `%LOCALAPPDATA%` / `%APPDATA%` tabanli DEGIL. NEDEN: Claude masaustu
uygulamasi MSIX paketidir; ondan baslatilan surecler AppData yazilarini gizli
paket klasorune yonlendirir (`AppData\\Local\\Packages\\<aile>\\LocalCache\\...`),
zamanlanmis gorevler ve kullanicinin terminali ise GERCEK AppData'yi gorur.
Sonuc iki ayri "gercek" (2026-10-03: ses izi kaydi, yedek aynasi ayari,
gunlukler, oturum sirri ve kilitler ikiye bolundu). Profil koku yonlendirilmez.
Kapi: `scripts/check-data-root.mjs` (repo genelinde AppData tabanli yolu yakalar).

Bu modul yalniz yol cozer; dizin olusturmaz (yazan kod `mkdir` kendisi yapar).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Mapping, Optional, Sequence

DATA_DIR_ENV = "SMITH_DATA_DIR"
DEFAULT_DIR_NAME = ".smith"

#: Tasima betigi (`scripts/smith-migrate-data.ps1 -Apply`) veri kokune bu isaret
#: dosyasini yazar; varligi "eski konumdaki veri icin karar verildi" demektir ve
#: acilis uyarisini susturur.
MIGRATION_MARKER = ".veri-koku-tasindi"

#: Tasima betigi bu adlari kopyalamaz; uyari da saymaz (kilit/gecici dosya veri degildir).
IGNORED_SUFFIXES = (".lock", ".tmp", ".migrate-part")

_legacy_warned = False


def _clean(value: Optional[str]) -> Optional[str]:
    """Bos / yalniz bosluk degeri tanimsiz sayar; dolu degeri kirpar."""
    if value is None:
        return None
    value = value.strip()
    return value or None


def resolve_data_root(
    env: Optional[Mapping[str, str]] = None, windows: Optional[bool] = None
) -> Optional[Path]:
    """Saf cozumleme: ortam disaridan gelir (testte process env'ine dokunulmaz).

    `None`: ne SMITH_DATA_DIR ne ev dizini bulunabildi. `%LOCALAPPDATA%` /
    `%APPDATA%` hicbir kosulda yedek DEGILDIR.
    """
    env = os.environ if env is None else env
    windows = (os.name == "nt") if windows is None else windows

    explicit = _clean(env.get(DATA_DIR_ENV))
    if explicit:
        return Path(explicit)
    # Birincil degisken platforma gore; digeri WSL/CI gibi karma ortamlar icin yedek.
    first, second = ("USERPROFILE", "HOME") if windows else ("HOME", "USERPROFILE")
    home = _clean(env.get(first)) or _clean(env.get(second))
    if home:
        return Path(home) / DEFAULT_DIR_NAME
    return None


def data_root() -> Path:
    """Smith veri koku. Ortamdan cozulemezse `Path.home()` kullanilir."""
    return resolve_data_root() or (Path.home() / DEFAULT_DIR_NAME)


# --------------------------------------------------------------------------
# Geri uyum: eski (AppData tabanli) konumdaki veri icin acik uyari
# --------------------------------------------------------------------------


def _ignored(name: str) -> bool:
    return name.lower().endswith(IGNORED_SUFFIXES)


def _dir_has_data(directory: Path, budget: int = 5000) -> bool:
    """`directory` altinda (sembolik baglanti izlenmez) veri sayilan ilk dosyayi arar."""
    if not directory.is_dir():
        return False
    for _dirpath, _dirs, files in os.walk(directory, followlinks=False):
        for name in files:
            budget -= 1
            if budget < 0:
                return False
            if not _ignored(name):
                return True
    return False


def legacy_roots(
    env: Optional[Mapping[str, str]] = None, windows: Optional[bool] = None
) -> list[Path]:
    """Eski konumlar (YALNIZ Windows): gercek `%LOCALAPPDATA%\\smith` ve MSIX
    paketlerinin sanal deposu `Packages\\<aile>\\LocalCache\\Local\\smith`.

    Hicbir bilesen artik buralara yazmaz; liste yalniz acilis uyarisi icindir.
    """
    env = os.environ if env is None else env
    windows = (os.name == "nt") if windows is None else windows
    if not windows:
        return []
    local = _clean(env.get("LOCALAPPDATA"))
    if not local:
        return []
    roots = [Path(local) / "smith"]
    packages = Path(local) / "Packages"
    if packages.is_dir():
        found = sorted(
            candidate
            for candidate in (
                pkg / "LocalCache" / "Local" / "smith" for pkg in packages.iterdir()
            )
            if candidate.is_dir()
        )
        roots.extend(found)
    return roots


def legacy_notice(root: Path, legacy: Sequence[Path]) -> Optional[str]:
    """Veri kokunde tasima isareti yoksa ve eski konumlarda veri varsa uyari metni.

    Isaret varsa (tasima yapildi ya da bilincli atlandi) ya da eski konumda veri
    yoksa `None`.
    """
    if (root / MIGRATION_MARKER).exists():
        return None
    with_data = [str(d) for d in legacy if _dir_has_data(d)]
    if not with_data:
        return None
    return (
        f"[veri] UYARI: veri koku bos veya tasinmamis ({root}); eski konumda veri var "
        f"({'; '.join(with_data)}). Eski konuma YAZILMAZ, yeni kokle devam ediliyor. "
        "Veri koku bos, tasima betigini calistir: "
        "pwsh scripts\\smith-migrate-data.ps1 (once -DryRun, sonra -Apply)"
    )


def warn_if_legacy_data() -> None:
    """Surec basina bir kez: eski konumda tasinmamis veri varsa stderr'e acik uyari."""
    global _legacy_warned
    if _legacy_warned:
        return
    _legacy_warned = True
    message = legacy_notice(data_root(), legacy_roots())
    if message:
        print(message, file=sys.stderr, flush=True)
