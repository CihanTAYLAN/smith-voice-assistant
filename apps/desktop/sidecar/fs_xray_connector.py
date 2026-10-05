"""Smith dosya sistemi rontgeni — surekli farkindalik katmani (ADR 0006).

Amac: Smith "X klasorunde ne var", "dun ne degisti", "disk neyle dolu"
sorularini TAHMINLE degil gercek dizin verisiyle cevaplasin. Bu konnektor
`code_connector`in tamamlayicisidir: orada git REPOLARI (icerik, dil, commit)
var, burada DOSYA SISTEMI TOPOGRAFYASI (nerede ne kadar dosya, ne kadar yer,
en son ne degisti) var.

SALT-METAVERI. Hicbir dosyanin ICERIGI okunmaz — yalniz ad, boyut, mtime.
Bu, gizlilik yuzeyini kasten kucuk tutar; icerik hasadi `code_connector`in
kara-listeli ve git-takipli yolundan gecer.

KOTA — bu dosyanin en onemli tasarim kisiti
-------------------------------------------
Gateway her `/remember` POST'unda YENIDEN embedding uretir ve embed ucu
free-tier'da dakikalik VE gunluk limitlidir. "Surekli tarama" naif yazilirsa
her saat basi kotayi yakar ve canli hafizayi kirar. Iki savunma:

1. **Kok basina 1 kayit** (`fs:<kok>`). Dosya basina kayit YOK.
2. **DELTA ZORUNLU.** Her kosu yapisal bir SNAPSHOT uretir ve
   `<veri koku>\\awareness\\fs_xray.json`e yazar (veri koku: SMITH_DATA_DIR ya da
   %USERPROFILE%\\.smith; AppData DEGIL, nedeni `STATE_DIR` yanindaki notta). Yeni kosu ONCE
   kaydedilmis snapshot'la karsilastirir; **birebir aynisa POST hic
   yapilmaz** → 0 embed. Bu yuzden snapshot bilincli olarak KABADIR
   (boyutlar kova'lanir, tarihler gun granulerliginde): bir dosyanin
   dokunulmasi degil, agacin gercekten degismesi embed harcar.

Snapshot esitse "degisiklik yok" cumlesi bile URETILMEZ; uretilse icerik
run-1'den farkli olur ve bosa bir embed yakardi (bu tuzak olculdu).

Kullanim:
  python fs_xray_connector.py --dry-run     # POST yok, snapshot + delta + icerik
  python fs_xray_connector.py --probe       # yalniz tarama suresi/sayilari
  python fs_xray_connector.py               # delta varsa yazar
  python fs_xray_connector.py --force       # snapshot esit olsa da yazar
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

# Windows stdout varsayilani cp1254; ASCII disi tek bir dosya adi
# UnicodeEncodeError ile TUM kosuyu dusurur (yaziliyor gorunen is orta yerde
# kalir). UTF-8'e sabitle, cevrilemeyeni degistir.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:  # pragma: no cover — cok eski Python
    pass

# KARA LISTE TEK KAYNAKTAN GELIR. ADR 0004'un gizlilik kirmizi cizgisi
# `code_connector.BLACKLIST_*` icinde tanimli; ikinci bir kopya cikarmak iki
# listenin zamanla ayrismasi demektir (ve gizlilik listesinde ayrisma =
# sizinti). Bu yuzden ithal edilir, kopyalanmaz.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from code_connector import BLACKLIST_DIRS, blacklist_reason  # noqa: E402
import smith_paths  # noqa: E402

GW = "http://127.0.0.1:4100"
WS = "ws_b98888ec6fe14f64bc57ca2ff599c31f"
EMAIL = "cihan@example.test"
SOURCE_TYPE = "fs"
SENSITIVITY = "personal"

WSL_DISTRO = "Ubuntu"

# DURUM DIZINI tek veri kokunun altinda (smith_paths.data_root: SMITH_DATA_DIR ya da
# %USERPROFILE%.smith); AppData tabanli DEGIL. MSIX tuzagi (zamanlanmis gorev ile
# paketli uygulama ayni yolu farkli gorur, delta durumu her kosuda "bos" gorunur ve
# kota bosa yanar) ve gerekce: smith_paths.py basligi.
STATE_DIR = smith_paths.data_root() / "awareness"
STATE_FILE = STATE_DIR / "fs_xray.json"

#: Raporlanan agac derinligi. Ust duzeyin BIR alt seviyesi gosterilir;
#: daha derini ozet degil dokum olur ve embed'e sigmaz.
REPORT_DEPTH = 3
#: Kok basina yurume suresi tavani. Tarama makineyi yormamali — saatlik
#: kosuyor. Tavana carpilirsa ozet "kismi" olarak isaretlenir.
WALK_SECONDS = 20.0
#: Kok basina dosya sayisi tavani (patolojik agaclara karsi emniyet).
WALK_FILE_CAP = 300_000

#: Boyut kovalari — snapshot'i KABALASTIRIR, delta gurultusunu keser.
#: Kucuk bir log dosyasinin buyumesi embed harcamasin diye.
DIR_BUCKET_MB = 10
TOTAL_BUCKET_MB = 100

TOP_N_BIGGEST = 5
RECENT_N = 10


class Root:
    """Taranacak bir kok. `kind` = 'win' (yerel dosya sistemi) veya 'wsl'.

    `question_hint`: kaydin ILK cumlesi. Semantik geri cagirmanin kalite
    kapisidir — kullanicinin bu klasor hakkinda soracagi soruyu kendi
    kelimeleriyle icerir (bkz. `build_content` icindeki olcum notu).
    """

    def __init__(self, key: str, kind: str, path: str, label: str, question_hint: str) -> None:
        self.key = key
        self.kind = kind
        self.path = path
        self.label = label
        self.question_hint = question_hint


ROOTS = [
    Root(
        "workspace",
        "wsl",
        "$HOME/workspace",
        "WSL Ubuntu ~/workspace",
        "Cihan'in ana proje klasoru olan workspace dizininde neler var, hangi "
        "projeler ve klasorler duruyor, ne kadar yer kapliyor.",
    ),
    Root(
        "smith-monorepo",
        "win",
        str(Path.home() / "smith-monorepo"),
        "Windows smith-monorepo (Smith'in kendi kaynak agaci)",
        "Smith'in kendi kaynak kodu klasorunde (smith-monorepo) neler var, "
        "hangi alt klasorler ve dosyalar duruyor.",
    ),
    Root(
        "obsidian-vaults",
        "win",
        str(Path.home() / "ObsidianVaults"),
        "Windows ObsidianVaults",
        "Cihan'in Obsidian not kasalari klasorunde neler var, hangi vault'lar "
        "ve kac not dosyasi duruyor.",
    ),
    Root(
        "desktop",
        "win",
        str(Path.home() / "Desktop"),
        "Windows Masaustu (%USERPROFILE%\\Desktop)",
        "Cihan'in bilgisayarinin masaustunde (Desktop) hangi dosya ve klasorler var.",
    ),
    Root(
        "downloads",
        "win",
        str(Path.home() / "Downloads"),
        "Windows Indirilenler (%USERPROFILE%\\Downloads)",
        "Cihan'in indirilenler (Downloads) klasorunde hangi dosyalar var, "
        "indirdigi dosyalar ne kadar yer kapliyor.",
    ),
]


# --------------------------------------------------------------------------
# Gateway
# --------------------------------------------------------------------------


def login() -> str:
    req = urllib.request.Request(
        f"{GW}/v1/dev/login",
        data=json.dumps({"email": EMAIL, "workspaceId": WS}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)["token"]


def remember(token: str, content: str, key: str) -> int:
    body = json.dumps(
        {
            "content": content,
            "key": key,
            "sourceType": SOURCE_TYPE,
            "sensitivity": SENSITIVITY,
        }
    ).encode()
    req = urllib.request.Request(
        f"{GW}/v1/tools/memory/remember",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:  # noqa: BLE001 — baglanti/timeout: hata say, backoff calissin
        return 0


def remember_with_backoff(token: str, content: str, key: str, waits: list[float]) -> int:
    """Kota duvarinda bekleyip tekrar dener. Embed kotasi DAKIKALIK yenilendigi
    icin beklemek gercekten ise yarar; beklemesiz tekrar deneme kotayi daha da
    doldurur."""
    code = remember(token, content, key)
    for wait in waits:
        if code == 200:
            return code
        print(f"    kota/hata {code} -> {wait:.0f}s bekle, tekrar", flush=True)
        time.sleep(wait)
        code = remember(token, content, key)
    return code


# --------------------------------------------------------------------------
# Durum (snapshot) dosyasi
# --------------------------------------------------------------------------


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"version": 1, "roots": {}}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        # Bozuk durum dosyasi taramayi durdurmaz; en kotu bir kez fazla embed.
        print(f"UYARI: durum dosyasi okunamadi ({e}); sifirdan varsayiliyor.", flush=True)
        return {"version": 1, "roots": {}}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STATE_FILE)  # atomik — yarim yazilmis durum dosyasi kalmasin


# --------------------------------------------------------------------------
# Tarama — yalniz METAVERI (ad, boyut, mtime). Icerik ASLA okunmaz.
# --------------------------------------------------------------------------


class Entry:
    """Bir dosyanin ozeti: gorece yol (POSIX), boyut (bayt), mtime (epoch)."""

    __slots__ = ("rel", "size", "mtime")

    def __init__(self, rel: str, size: int, mtime: float) -> None:
        self.rel = rel
        self.size = size
        self.mtime = mtime


def walk_windows(root: Path, deadline: float) -> tuple[list[Entry], list[str], bool]:
    """(girdiler, kara-listeyle atlanan yollar, kismi_mi)."""
    entries: list[Entry] = []
    skipped: list[str] = []
    partial = False
    if not root.exists():
        return entries, skipped, False
    for dirpath, dirnames, filenames in os.walk(root, onerror=lambda _e: None):
        # Kara liste dizinleri PRUNE edilir; reddedilen her biri log'a duser
        # (iddia degil, gorunur kanit).
        keep: list[str] = []
        for d in dirnames:
            if d in BLACKLIST_DIRS:
                skipped.append(f"{Path(dirpath, d).relative_to(root).as_posix()} (kara liste dizini: {d})")
            else:
                keep.append(d)
        dirnames[:] = keep

        if time.monotonic() > deadline or len(entries) >= WALK_FILE_CAP:
            partial = True
            dirnames[:] = []
            break

        rel_dir = Path(dirpath).relative_to(root)
        for fname in filenames:
            if time.monotonic() > deadline or len(entries) >= WALK_FILE_CAP:
                partial = True
                dirnames[:] = []
                break
            rel = (rel_dir / fname).as_posix()
            reason = blacklist_reason(rel)
            if reason:
                skipped.append(f"{rel} ({reason})")
                continue
            try:
                st = os.stat(Path(dirpath, fname))
            except OSError:
                continue  # yaristik/izin yok — bu dosya yok say
            entries.append(Entry(rel, st.st_size, st.st_mtime))
        if partial:
            break
    return entries, skipped, partial


BASH_PRELUDE = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n"


def wsl_bash(script: str, timeout: int = 120) -> str:
    """WSL'de bash. TUZAK (hafizada kayitli): `wsl.exe` varsayilan UTF-16 yazar
    → `WSL_UTF8=1` sart. Script stdin'den verilir; boylece Windows argv
    alintilama kurallari bash alintilama kurallariyla carpismaz."""
    env = {**os.environ, "WSL_UTF8": "1"}
    proc = subprocess.run(
        ["wsl", "-d", WSL_DISTRO, "--", "bash", "-s"],
        input=(BASH_PRELUDE + script).encode("utf-8"),
        capture_output=True,
        timeout=timeout,
        env=env,
    )
    out = (proc.stdout or b"").decode("utf-8", "replace").lstrip("\ufeff")
    if proc.returncode != 0 and not out.strip():
        err = (proc.stderr or b"").decode("utf-8", "replace")[:300]
        raise RuntimeError(f"wsl bash hata ({proc.returncode}): {err}")
    return out


def walk_wsl(root_expr: str, seconds: float) -> tuple[list[Entry], list[str], bool]:
    """WSL kokunu `find -printf` ile tarar. Tek gecis, tek process — Windows'tan
    dosya dosya `stat` cagirmak (9p uzerinden) dakikalar surerdi.

    PRUNE EDILEN DIZIN DE BASILIR (`P\\t...`). Ciplak `-prune` sessizdir; o
    zaman "customers/ ve db-dumps/ taramaya girmedi" bir IDDIA olur, kanit
    olmaz. Windows tarafi (`walk_windows`) prune'lananlari zaten log'luyor;
    iki yol ayni kanit seviyesinde olmali.
    """
    names = " -o ".join(f'-name "{d}"' for d in sorted(BLACKLIST_DIRS))
    find_expr = (
        f'\\( {names} \\) -prune -printf "P\\t%P\\n" '
        r'-o -type f -printf "F\t%s\t%T@\t%P\n"'
    )
    script = (
        f'cd "{root_expr}" 2>/dev/null || {{ echo "@@@MISSING"; exit 0; }}\n'
        f"timeout {int(seconds)} find . {find_expr} 2>/dev/null\n"
        "ec=$?\n"
        'if [ $ec -eq 124 ]; then echo "@@@PARTIAL"; fi\n'
    )
    raw = wsl_bash(script, timeout=int(seconds) + 40)
    entries: list[Entry] = []
    skipped: list[str] = []
    partial = False
    for line in raw.splitlines():
        if line == "@@@MISSING":
            return [], [], False
        if line == "@@@PARTIAL":
            partial = True
            continue
        if line.startswith("P\t"):
            rel = line[2:]
            if rel:
                name = rel.rsplit("/", 1)[-1]
                skipped.append(f"{rel} (kara liste dizini: {name})")
            continue
        if not line.startswith("F\t"):
            continue
        parts = line[2:].split("\t", 2)
        if len(parts) != 3:
            continue
        size_s, mtime_s, rel = parts
        if not rel:
            continue
        # find PRUNE dizinleri atladi; dosya DESENLERI (`.env`, `*.pem`, ham
        # `.sql`) burada elenir — kara listenin ikinci katmani.
        reason = blacklist_reason(rel)
        if reason:
            skipped.append(f"{rel} ({reason})")
            continue
        try:
            entries.append(Entry(rel, int(size_s), float(mtime_s)))
        except ValueError:
            continue
    return entries, skipped, partial


# --------------------------------------------------------------------------
# Snapshot uretimi — KABA olmasi bilinclidir (delta gurultusu = bosa embed)
# --------------------------------------------------------------------------


def human(size: int) -> str:
    if size >= 1 << 30:
        return f"{size / (1 << 30):.1f} GB"
    if size >= 1 << 20:
        return f"{size / (1 << 20):.0f} MB"
    if size >= 1 << 10:
        return f"{size / (1 << 10):.0f} KB"
    return f"{size} B"


def bucket_mb(size: int, mb: int) -> int:
    """Boyutu `mb` katina yuvarlar. Snapshot'i kabalastirir: bir log satirinin
    buyumesi delta tetiklemesin, gercek buyume tetiklesin."""
    step = mb * (1 << 20)
    return int(round(size / step)) * mb


def build_snapshot(entries: list[Entry], partial: bool) -> dict:
    """Yapisal snapshot. Bu sozluk delta karsilastirmasinin TEK olcutudur;
    icine giren her alan bir embed maliyeti riskidir."""
    total_size = 0
    # Ust duzey gruplar: kokteki her dizin + kokteki dosyalar icin '.' kovasi.
    groups: dict[str, list[int]] = {}  # ad -> [dosya_sayisi, bayt]
    sub: dict[str, set[str]] = {}  # ust duzey -> ikinci duzey adlar
    for e in entries:
        total_size += e.size
        parts = e.rel.split("/")
        top = parts[0] if len(parts) > 1 else "."
        g = groups.setdefault(top, [0, 0])
        g[0] += 1
        g[1] += e.size
        if len(parts) > 2 and REPORT_DEPTH >= 3:
            sub.setdefault(top, set()).add(parts[1])

    tops = [
        {
            "ad": name,
            "dosya": g[0],
            "mb": bucket_mb(g[1], DIR_BUCKET_MB),
            "alt": sorted(sub.get(name, set()))[:6],
        }
        for name, g in sorted(groups.items())
    ]
    biggest = [t["ad"] for t in sorted(tops, key=lambda t: -int(t["mb"]))[:TOP_N_BIGGEST]]
    recent = [
        # Tarih GUN granulerliginde: ayni gun icinde tekrar dokunulan dosya
        # delta tetiklemesin.
        {"ad": e.rel, "gun": datetime.fromtimestamp(e.mtime, timezone.utc).strftime("%Y-%m-%d")}
        for e in sorted(entries, key=lambda e: -e.mtime)[:RECENT_N]
    ]
    return {
        "dosya": len(entries),
        "toplam_mb": bucket_mb(total_size, TOTAL_BUCKET_MB),
        "ust": tops,
        "en_buyuk": biggest,
        "son_degisen": recent,
        "kismi": partial,
    }


def compare_key(snap: dict) -> str:
    """Delta kapisinin karsilastirdigi NORMALLESTIRILMIS imza.

    `son_degisen` listesi gorunumde mtime sirasindadir (kullanici icin "en son
    ne degisti" boyle anlamli). Ama HAM sirayi karsilastirmak, ayni gun icinde
    ayni 10 dosyanin yeniden siralanmasini bile "degisiklik" sayar ve saatlik
    kosuda bosa embed yakar (olculdu: dosya sayisi ayni, yalniz sira farkli →
    yeniden yazim). Bu yuzden imzada o liste ADA gore siralanir: gercekten YENI
    bir dosya ilk 10'a girerse imza degisir, salt yeniden siralanma degistirmez.
    """
    norm = dict(snap)
    norm["son_degisen"] = sorted(
        ({"ad": r["ad"], "gun": r["gun"]} for r in snap.get("son_degisen", [])),
        key=lambda r: (r["ad"], r["gun"]),
    )
    return json.dumps(norm, ensure_ascii=False, sort_keys=True)


def diff_sentence(old: dict | None, new: dict) -> str:
    """Onceki snapshot'a gore Turkce delta cumlesi. Degisiklik yoksa bos.

    ONEMLI: cagiran taraf snapshot'lar BIREBIR AYNIYSA buraya hic gelmez —
    "degisiklik yok" cumlesi bile uretmek run-1'den farkli icerik demek olur
    ve bosa bir embed yakar.
    """
    if not old:
        return ""
    old_tops = {t["ad"]: t for t in old.get("ust", [])}
    new_tops = {t["ad"]: t for t in new.get("ust", [])}
    added = sorted(set(new_tops) - set(old_tops))
    removed = sorted(set(old_tops) - set(new_tops))
    grown: list[str] = []
    shrunk: list[str] = []
    for name in sorted(set(new_tops) & set(old_tops)):
        d_files = int(new_tops[name]["dosya"]) - int(old_tops[name]["dosya"])
        d_mb = int(new_tops[name]["mb"]) - int(old_tops[name]["mb"])
        if d_files > 0 or d_mb > 0:
            grown.append(f"{name} (+{d_files} dosya, +{d_mb} MB)" if d_files else f"{name} (+{d_mb} MB)")
        elif d_files < 0 or d_mb < 0:
            shrunk.append(f"{name} ({d_files} dosya, {d_mb} MB)" if d_files else f"{name} ({d_mb} MB)")

    bits: list[str] = []
    if added:
        bits.append(f"YENI eklenen ust duzey: {', '.join(added[:8])}")
    if removed:
        bits.append(f"SILINEN/kaybolan ust duzey: {', '.join(removed[:8])}")
    if grown:
        bits.append(f"buyuyen: {', '.join(grown[:8])}")
    if shrunk:
        bits.append(f"kuculen: {', '.join(shrunk[:8])}")
    if not bits:
        d = int(new.get("dosya", 0)) - int(old.get("dosya", 0))
        bits.append(
            f"ust duzey yapisi ayni, dosya sayisi {d:+d} degisti"
            if d
            else "yalniz son degisen dosyalar farkli"
        )
    return "Onceki taramaya gore: " + "; ".join(bits) + "."


def build_content(root: Root, snap: dict, delta: str) -> str:
    tops = snap.get("ust", [])
    top_txt = (
        ", ".join(
            f"{t['ad']}/ ({t['dosya']} dosya, ~{t['mb']} MB"
            + (f", alt: {', '.join(t['alt'])}" if t.get("alt") else "")
            + ")"
            for t in sorted(tops, key=lambda t: -int(t["mb"]))[:14]
        )
        or "ust duzey dizin yok"
    )
    biggest = ", ".join(snap.get("en_buyuk", [])) or "yok"
    recent = ", ".join(f"{r['ad']} ({r['gun']})" for r in snap.get("son_degisen", [])) or "yok"
    partial_note = (
        " (tarama sure/dosya tavanina carpti, ozet KISMI)" if snap.get("kismi") else ""
    )
    total_mb = int(snap.get("toplam_mb", 0))
    total_txt = f"{total_mb / 1024:.1f} GB" if total_mb >= 1024 else f"{total_mb} MB"
    # SORU BICIMINDE ACILIS. Onceki surum "Dosya sistemi rontgeni — <yol>" ile
    # basliyordu ve semantik aramada KAYBEDIYORDU: "workspace klasorumde neler
    # var" sorgusu, adinda 'workspace' gecen GitHub repo kayitlarini (0.722)
    # gercek dizin dokumunun (esik alti) ONUNE gecirdi. Cozum, kullanicinin
    # sordugu kelimeleri (klasor, dizin, icinde ne var, kac dosya, ne kadar yer)
    # icerige koymak; boylece embedding sorunun kendisine yakin duser.
    parts = [
        f"{root.question_hint} Klasorun/dizinin tam yolu: {root.label}. "
        f"Bu klasorde toplam {snap.get('dosya', 0)} dosya var ve yaklasik "
        f"{total_txt} yer kapliyor{partial_note}. "
        f"Icindeki ust duzey klasorler, her birinin dosya sayisi ve boyutu: {top_txt}. "
        f"En cok yer kaplayan {TOP_N_BIGGEST} klasor: {biggest}. "
        f"Bu dizinde en son degisen/guncellenen dosyalar: {recent}."
    ]
    if delta:
        parts.append(delta)
    parts.append(
        "Bu ozet metaveridir (ad/boyut/tarih); dosya icerikleri okunmaz ve "
        "gizlilik kara listesindeki yollar (node_modules, .git, target, .venv, "
        "db-dumps, customers, github-backup, .env, anahtar ve ham SQL dokumleri) "
        "taramaya girmez."
    )
    return " ".join(parts)


# --------------------------------------------------------------------------


def scan_root(root: Root, show_skips: bool) -> tuple[dict | None, list[str], float]:
    started = time.monotonic()
    if root.kind == "wsl":
        entries, skipped, partial = walk_wsl(root.path, WALK_SECONDS)
    else:
        p = Path(root.path)
        if not p.exists():
            print(f"  {root.key}: yol yok ({root.path}), atlandi", flush=True)
            return None, [], 0.0
        entries, skipped, partial = walk_windows(p, started + WALK_SECONDS)
    elapsed = time.monotonic() - started
    if not entries:
        print(f"  {root.key}: dosya bulunamadi ({elapsed:.1f}s), atlandi", flush=True)
        return None, skipped, elapsed
    snap = build_snapshot(entries, partial)
    print(
        f"  {root.key}: {len(entries)} dosya, ~{human(sum(e.size for e in entries))}, "
        f"{len(snap['ust'])} ust duzey, {elapsed:.1f}s"
        + (" [KISMI]" if partial else ""),
        flush=True,
    )
    print(f"    kara listeyle atlanan: {len(skipped)}", flush=True)
    if skipped and show_skips:
        for s in skipped[:12]:
            print(f"      ATLANDI: {s}", flush=True)
        if len(skipped) > 12:
            print(f"      ... ve {len(skipped) - 12} yol daha", flush=True)
    return snap, skipped, elapsed


def main() -> int:
    smith_paths.warn_if_legacy_data()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="POST yok; snapshot, delta ve icerigi basar.")
    ap.add_argument("--probe", action="store_true", help="Yalniz tarama; snapshot yazilmaz, POST yok.")
    ap.add_argument("--force", action="store_true", help="Snapshot esit olsa da yazar (kota harcar).")
    ap.add_argument("--show-skips", action="store_true", help="Kara listeyle atlanan yollari basar.")
    ap.add_argument("--only", help="Yalniz bu kok anahtari (virgullu liste).")
    args = ap.parse_args()

    only = {s.strip() for s in args.only.split(",")} if args.only else None
    roots = [r for r in ROOTS if not only or r.key in only]

    state = load_state()
    saved: dict = state.setdefault("roots", {})

    print(f"FS rontgeni: {len(roots)} kok taraniyor (derinlik {REPORT_DEPTH}, "
          f"kok basina <= {WALK_SECONDS:.0f}s).", flush=True)
    print(f"Durum dosyasi: {STATE_FILE}", flush=True)

    pending: list[tuple[str, str, dict]] = []  # (key, content, snapshot)
    unchanged = 0
    total_skipped = 0
    for root in roots:
        snap, skipped, _elapsed = scan_root(root, args.show_skips or args.dry_run or args.probe)
        total_skipped += len(skipped)
        if snap is None:
            continue
        if snap.get("kismi"):
            print("    KISMI -> POST ve canonical state guncellemesi atlandi", flush=True)
            continue
        prev = saved.get(root.key, {})
        prev_snap = prev.get("snapshot")
        # DELTA KAPISI: normallestirilmis imza aynıysa POST hic denenmez → 0 embed.
        if prev_snap is not None and compare_key(prev_snap) == compare_key(snap) and not args.force:
            unchanged += 1
            print("    DEGISMEDI -> POST atlandi (0 embed)", flush=True)
            continue
        delta = diff_sentence(prev_snap, snap)
        content = build_content(root, snap, delta)
        pending.append((f"fs:{root.key}", content, snap))
        print(f"    DEGISTI -> yazilacak ({len(content)} karakter)", flush=True)
        if delta:
            print(f"    delta: {delta}", flush=True)

    print(
        f"\nOzet: {len(pending)} kayit yazilacak, {unchanged} kok degismedi, "
        f"kara listeyle atlanan {total_skipped} yol.",
        flush=True,
    )

    if args.probe:
        print("PROBE: snapshot kaydedilmedi, POST yapilmadi.", flush=True)
        return 0

    if args.dry_run:
        for key, content, _snap in pending:
            print(f"\n--- {key}\n{content}", flush=True)
        print(f"\nKURU CALISTIRMA: {len(pending)} kayit uretildi, POST yapilmadi, "
              "durum dosyasi DEGISMEDI.", flush=True)
        print(f"EMBED HARCANAN: 0 (kuru calistirma)", flush=True)
        return 0

    if not pending:
        print("EMBED HARCANAN: 0 (hicbir kokte degisiklik yok)", flush=True)
        return 0

    token = login()
    ok = fail = 0
    for key, content, snap in pending:
        code = remember_with_backoff(token, content, key, [30.0, 90.0])
        if code == 200:
            ok += 1
            # Durum ANCAK basarili POST'tan sonra guncellenir; yoksa kirilan bir
            # kosudan sonra degisiklik sessizce kaybolur.
            saved[key.split(":", 1)[1]] = {
                "snapshot": snap,
                "yazildi": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            save_state(state)
            print(f"  yazildi: {key}", flush=True)
        else:
            fail += 1
            print(f"  HATA {code}: {key}", flush=True)
        time.sleep(0.9)  # RPM nezaketi

    print(f"FS rontgeni bitti: {ok} yazildi, {fail} hata, {unchanged} degismedi.", flush=True)
    print(f"EMBED HARCANAN: {ok + fail} (basarili {ok})", flush=True)
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
