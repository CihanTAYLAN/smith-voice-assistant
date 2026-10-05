"""Smith Obsidian konnektoru (ADR 0004 F1).

ObsidianVaults altindaki .md notlarini Smith hafizasina besler. Her not =
1 kayit (vault + baslik + ilk ~500 karakter ozeti; tam chunk'lama F2). TEKRAR
CALISTIRLABILIR: sourceId `obsidian:<vault>/<relpath>` → ayni not iki kez
yazilmaz, yeniden calistirma degisenleri tazeler.

KOTA GERCEGI (ADR 0004): ~1000 not var; free-tier embed dakikalik (RPM) ve
gunluk limitli. Bu yuzden `--max` ile sinirli, en GUNCEL notlar once
(mtime desc). Gizlilik: notlar kullanicinin kendi bilgisi → 'personal'
(Live'da gorulur, secret degil). @smith/protocol degismez;
/v1/tools/memory/remember kullanilir.

TEKRAR CALISTIRMA VE KOTA: upsert sourceId sayesinde tekrar yazma DB'yi
bozmaz, AMA gateway her POST'ta yeniden embed uretir → yazilmis notu tekrar
gondermek bosa kota harcar. `--exclude-file` bunu onler: satir basina bir
sourceId (`obsidian:<vault>/<relpath>`) iceren dosya verilir, o notlar hic
POST edilmez. Dosya DB'den uretilir:
  psql -tA -c "select \"sourceId\" from \"Memory\" where \"sourceType\"='obsidian'"
Alternatif olarak `--written-file` her basarili yazimi aninda ekler; sonraki
kosuda ayni dosya `--exclude-file` olarak verilebilir (docker gerekmez).
"""
from __future__ import annotations
import argparse, json, sys, time, urllib.request
from pathlib import Path

# Windows'ta stdout varsayilani cp1254; ASCII disi bir karakter (ok isareti veya
# not yolundaki bir harf) yazmak UnicodeEncodeError ile TUM kosuyu dusurur —
# yaziliyor gibi gorunen is orta yerde olur. UTF-8'e sabitle, cevrilemeyeni degistir.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:  # cok eski Python — sorun degil, sadece guvence
    pass

GW = "http://127.0.0.1:4100"
WS = "ws_b98888ec6fe14f64bc57ca2ff599c31f"
EMAIL = "cihan@example.test"
ROOT = Path.home() / "ObsidianVaults"


def login() -> str:
    req = urllib.request.Request(
        f"{GW}/v1/dev/login",
        data=json.dumps({"email": EMAIL, "workspaceId": WS}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)["token"]


def remember(token: str, content: str, key: str) -> int:
    body = json.dumps({
        "content": content, "key": key,
        "sourceType": "obsidian", "sensitivity": "personal",
    }).encode()
    req = urllib.request.Request(
        f"{GW}/v1/tools/memory/remember", data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:  # baglanti/timeout — hata gibi say, backoff devreye girsin
        return 0


def remember_with_backoff(token: str, content: str, key: str, waits: list[float]) -> int:
    """Kota/gecici hatada bekleyip tekrar dener. Son kodu dondurur.

    Embed kotasi dakikalik yenilendigi icin beklemek gercekten ise yarar;
    bekleme olmadan yapilan tekrar denemeler kotayi daha da doldurur.
    """
    code = remember(token, content, key)
    for wait in waits:
        if code == 200:
            return code
        print(f"    kota/hata {code} -> {wait:.0f}s bekle, tekrar", flush=True)
        time.sleep(wait)
        code = remember(token, content, key)
    return code


def collect() -> list[tuple[float, Path, str]]:
    """(mtime, path, vault) — en guncel once."""
    items: list[tuple[float, Path, str]] = []
    for vault_dir in sorted(ROOT.iterdir()):
        if not vault_dir.is_dir():
            continue
        for md in vault_dir.rglob("*.md"):
            if ".obsidian" in md.parts or ".trash" in md.parts:
                continue
            try:
                items.append((md.stat().st_mtime, md, vault_dir.name))
            except OSError:
                pass
    items.sort(key=lambda x: x[0], reverse=True)
    return items


def load_exclude(path: str | None) -> set[str]:
    if not path:
        return set()
    p = Path(path)
    if not p.exists():
        return set()
    return {ln.strip() for ln in p.read_text(encoding="utf-8-sig").splitlines() if ln.strip()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=200)
    ap.add_argument("--sleep", type=float, default=0.9)  # ~66/dk, RPM altinda
    ap.add_argument(
        "--exclude-file",
        help="Satir basina bir sourceId; bu notlar POST EDILMEZ (kota korumasi).",
    )
    ap.add_argument(
        "--written-file",
        help="Basarili her sourceId buraya eklenir; sonraki kosuda --exclude-file olur.",
    )
    ap.add_argument(
        "--max-consecutive-fail", type=int, default=6,
        help="Ust uste bu kadar hatada dur (kota tukendi, devam etmek bosa gider).",
    )
    args = ap.parse_args()

    token = login()
    items = collect()
    exclude = load_exclude(args.exclude_file)
    written = open(args.written_file, "a", encoding="utf-8") if args.written_file else None

    ok = fail = skip = already = 0
    streak = 0
    print(f"toplam not: {len(items)}, hariclenen (zaten yazili): {len(exclude)}", flush=True)
    for _mtime, md, vault in items:
        if ok + fail >= args.max:
            break
        rel = md.relative_to(ROOT).as_posix()
        key = f"obsidian:{rel}"
        if key in exclude:
            already += 1
            continue
        try:
            raw = md.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            continue
        if len(raw) < 20:  # bos/anlamsiz notu atla
            skip += 1
            continue
        title = md.stem
        summary = " ".join(raw.split())[:500]
        content = f"Obsidian notu ({vault}) '{title}': {summary}"
        code = remember_with_backoff(token, content, key, [30.0, 90.0])
        if code == 200:
            ok += 1
            streak = 0
            if written:
                written.write(key + "\n")
                written.flush()
            if ok % 25 == 0:
                print(f"  ... {ok} yazildi (son: {rel})", flush=True)
        else:
            fail += 1
            streak += 1
            print(f"  HATA {code}: {rel}", flush=True)
            if streak >= args.max_consecutive_fail:
                print(
                    f"DUR: {streak} ust uste hata — kota tukenmis gorunuyor. "
                    f"Kalan notlar icin sonra --exclude-file ile devam et.",
                    flush=True,
                )
                break
        time.sleep(args.sleep)
    if written:
        written.close()
    print(
        f"Obsidian konnektor bitti: {ok} yazildi, {fail} hata, "
        f"{skip} bos-atlandi, {already} zaten-yazili-atlandi.",
        flush=True,
    )
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
