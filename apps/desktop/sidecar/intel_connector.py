"""Smith dis istihbarat konnektoru — surekli farkindalik katmani (ADR 0006).

Amac: kullanicinin takip ettigi kaynaklar (Product Hunt, There's An AI For
That, Hacker News) Smith'in hafizasinda olsun; "bugun ne cikti" sorusu
tarayici acmadan cevaplanabilsin. Kullanici mandati: proaktif istihbarat.

UYDURMA YASAK — bu dosyanin en onemli kurali
--------------------------------------------
Bir kaynak 403/ag hatasi verirse o kaynak ATLANIR ve durum log'a yazilir.
Hicbir kosulda "muhtemelen sunlar cikti" turu uretilmis icerik hafizaya
girmez: hafiza Smith'in gercek dunya modeli, tahmin deposu degil. Hicbir
kaynak calismazsa kayit hic yazilmaz (bos/uydurma kayit yazmaktan iyidir).

Kaynak tuzaklari (olculmus, hafizada kayitli)
---------------------------------------------
- **Product Hunt leaderboard sayfasi Cloudflare CAPTCHA'sina takilir** —
  `r.jina.ai` onekiyle bile ("Performing security verification"). Buna karsin
  **Atom feed'i (`/feed`) DOGRUDAN acilir** ve tam veri verir. Bu yuzden
  birincil yol RSS, jina yalnizca yedek.
- **PH gunu Pasifik saatiyle doner** → sabah kosusunda DUNUN listesi okunur.
- **TAAFT 403 verir**; `https://r.jina.ai/<url>` oneki bu duvari asar.
- **daily.dev tamamen kapali** (jina bile gecemiyor) → HN vekil olarak
  kullanilir; HN'in resmi Firebase API'si acik, kazima gerekmez.

KOTA: gunde TEK kayit (`intel:YYYY-MM-DD`). Ayni gun tekrar kosarsa durum
dosyasindaki IMZA (yalniz urun/baslik kimlikleri — bkz. `signature_of`)
karsilastirilir; ayniysa POST yapilmaz → 0 embed.

Kullanim:
  python intel_connector.py --probe      # kaynaklari cek, POST yok
  python intel_connector.py --dry-run    # ozeti uret, POST yok
  python intel_connector.py
  python intel_connector.py --force      # ayni gun icerik ayni olsa da yaz
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import smith_paths

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:  # pragma: no cover
    pass

GW = "http://127.0.0.1:4100"
WS = "ws_b98888ec6fe14f64bc57ca2ff599c31f"
EMAIL = "cihan@example.test"
SOURCE_TYPE = "intel"
#: Istihbarat halka acik kaynaklardan gelir → Live'da serbestce kullanilabilir.
SENSITIVITY = "public"

# DURUM DIZINI tek veri kokunun altinda (smith_paths.data_root: SMITH_DATA_DIR ya da
# %USERPROFILE%.smith); AppData tabanli DEGIL. MSIX tuzagi (zamanlanmis gorev ile
# paketli uygulama ayni yolu farkli gorur, delta durumu her kosuda "bos" gorunur ve
# kota bosa yanar) ve gerekce: smith_paths.py basligi.
STATE_DIR = smith_paths.data_root() / "awareness"
STATE_FILE = STATE_DIR / "intel.json"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SmithAwareness/1.0"
#: Pasifik saati (PDT). PH gunu bu saate gore doner.
PACIFIC_OFFSET = timedelta(hours=-7)
TOP_N = 5
FETCH_TIMEOUT = 45


def fetch(url: str, timeout: int = FETCH_TIMEOUT, headers: dict[str, str] | None = None) -> tuple[bool, str]:
    """(basari, govde). Hata YUTULMAZ — cagiran taraf kaynagi atlar ve log'lar."""
    hdrs = {"User-Agent": UA, "Accept": "*/*", **(headers or {})}
    req = urllib.request.Request(url, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — ag/DNS/timeout
        return False, f"{type(e).__name__}: {e}"


def fetch_via_jina(url: str) -> tuple[bool, str]:
    """403 duvarini asan okuyucu vekili (olculmus: TAAFT boyle cozuldu).

    `X-Return-Format: markdown` SART. Bu onek olmadan jina ayni URL icin kosudan
    kosuya IKI FARKLI bicim dondurur — bir kez markdown link'li, bir kez duz
    metin (olculdu: ayni sayfa, iki ardisik istek, iki farkli yapi). Duz metin
    surumunde urun kartlarinin sinirlari kaybolur ve satir-tabanli her parser
    sessizce bos doner. Bicimi sabitlemek, parser'i saglam kilmanin onkosulu.
    """
    return fetch(f"https://r.jina.ai/{url}", timeout=60, headers={"X-Return-Format": "markdown"})


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
        {"content": content, "key": key, "sourceType": SOURCE_TYPE, "sensitivity": SENSITIVITY}
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
    except Exception:  # noqa: BLE001
        return 0


def remember_with_backoff(token: str, content: str, key: str, waits: list[float]) -> int:
    code = remember(token, content, key)
    for wait in waits:
        if code == 200:
            return code
        print(f"    kota/hata {code} -> {wait:.0f}s bekle, tekrar", flush=True)
        time.sleep(wait)
        code = remember(token, content, key)
    return code


# --------------------------------------------------------------------------
# Durum dosyasi
# --------------------------------------------------------------------------


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"version": 1, "gunler": {}}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"UYARI: durum dosyasi okunamadi ({e}); sifirdan varsayiliyor.", flush=True)
        return {"version": 1, "gunler": {}}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STATE_FILE)


# --------------------------------------------------------------------------
# Kaynak 1 — Product Hunt (Atom feed; leaderboard CAPTCHA'ya takiliyor)
# --------------------------------------------------------------------------

PH_FEED = "https://www.producthunt.com/feed"

ENTRY_RE = re.compile(r"<entry>(.*?)</entry>", re.S)
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)
PUB_RE = re.compile(r"<published>(.*?)</published>", re.S)
CONTENT_RE = re.compile(r"<content[^>]*>(.*?)</content>", re.S)
LINK_RE = re.compile(r'<link[^>]*href="([^"]+)"')
P_RE = re.compile(r"<p>(.*?)</p>", re.S)


def strip_tags(text: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", text)).split())


def pacific_target_day() -> str:
    """PH'in "dun"u. Sabah kosusunda dunun listesi okunur (mandat)."""
    return (datetime.now(timezone.utc) + PACIFIC_OFFSET - timedelta(days=1)).strftime("%Y-%m-%d")


def collect_product_hunt() -> tuple[list[str], str]:
    """([urun satirlari], durum notu)."""
    ok, body = fetch(PH_FEED)
    source = "RSS (dogrudan)"
    if not ok or "<entry>" not in body:
        print(f"    PH dogrudan RSS basarisiz ({body[:60]}), jina yedegi deneniyor", flush=True)
        ok, body = fetch_via_jina(PH_FEED)
        source = "RSS (jina vekili)"
    if not ok or "<entry>" not in body:
        return [], f"Product Hunt okunamadi ({body[:80]})"

    target = pacific_target_day()
    parsed: list[tuple[str, str, str]] = []  # (gun, ad, tagline)
    for raw in ENTRY_RE.findall(body):
        tm = TITLE_RE.search(raw)
        pm = PUB_RE.search(raw)
        if not tm or not pm:
            continue
        name = strip_tags(tm.group(1))
        day = pm.group(1).strip()[:10]
        tagline = ""
        cm = CONTENT_RE.search(raw)
        if cm:
            inner = html.unescape(cm.group(1))
            paras = [strip_tags(p) for p in P_RE.findall(inner)]
            # Ilk <p> tagline, ikinci <p> "Discussion | Link" navigasyonudur.
            paras = [p for p in paras if p and "Discussion" not in p]
            tagline = paras[0] if paras else ""
        if name:
            parsed.append((day, name, tagline))

    same_day = [p for p in parsed if p[0] == target]
    if same_day:
        # FEED SIRASI BIR SIRALAMA DEGIL ve istekten istege KARISIR (olculdu:
        # ayni gunun 12 urunu 3 istekte de AYNI kume, ama her seferinde farkli
        # sirada → ham feed sirasindan ilk 5'i almak her kosuda farkli 5 urun
        # verir ve bosa embed yakar). Kume kararli oldugu icin ADA GORE siralanir.
        # Oy sayisi bu feed'de YOK; leaderboard sirasi ise CAPTCHA arkasinda —
        # bu yuzden "en cok oylanan 5" iddiasi EDILMEZ, gunun urun listesi
        # verilir ve toplam sayi soylenir.
        chosen = sorted(same_day, key=lambda p: p[1].lower())[:TOP_N]
        note = (
            f"Product Hunt {target} (Pasifik gunu) — {source}; o gun toplam "
            f"{len(same_day)} urun, alfabetik ilk {len(chosen)} listelendi "
            "(feed oy sirasi vermiyor, leaderboard sirasi CAPTCHA arkasinda)"
        )
    else:
        # DUZLUK: hedef gunde girdi yoksa feed'in en yenilerini alir ama bunu
        # ACIKCA soyler. "Dunun listesi" diye sunmak uydurma olurdu.
        latest_day = max((p[0] for p in parsed), default="")
        latest = [p for p in parsed if p[0] == latest_day]
        chosen = sorted(latest, key=lambda p: p[1].lower())[:TOP_N]
        note = (
            f"Product Hunt — {source}; feed'de {target} gunune ait girdi yoktu, "
            f"en yeni gun {latest_day} icin alfabetik ilk {len(chosen)} urun alindi"
        )
    items = [
        (name, f"{name} ({day}) — {tagline}" if tagline else f"{name} ({day})")
        for day, name, tagline in chosen
    ]
    return items, note


# --------------------------------------------------------------------------
# Kaynak 2 — There's An AI For That (403 → jina sart)
# --------------------------------------------------------------------------

TAAFT_URL = "https://theresanaiforthat.com/"


#: Bir aracin KANONIK adresi. Parser'in tutundugu tek yapi budur — sayfa
#: yerlesimi (satir sirasi, kart sinirlari, navigasyon blogu) degisse bile bu
#: adres semasi degismez. Onceki satir-tabanli surum tam bu yuzden kirilmisti.
TAAFT_LINK_RE = re.compile(r"\[([^\]\n]{2,80})\]\(https://theresanaiforthat\.com/ai/([a-z0-9-]+)/\)")


def collect_taaft() -> tuple[list[str], str]:
    ok, body = fetch_via_jina(TAAFT_URL)
    if not ok:
        return [], f"TAAFT okunamadi ({body[:80]})"

    # Ayni arac icin birden fazla link gecer: once ADI, sonra TAGLINE'i (ikisi de
    # ayni slug'a isaret eder). Slug'lari GORUNME SIRASINDA gruplariz; sira
    # "Today" akisinin sirasidir, yani ilk slug'lar gunun en yenileri.
    order: list[str] = []
    texts: dict[str, list[str]] = {}
    for text, slug in TAAFT_LINK_RE.findall(body):
        text = " ".join(html.unescape(text).split())
        if not text or text.startswith("!"):  # gorsel alt metni
            continue
        if slug not in texts:
            texts[slug] = []
            order.append(slug)
        if text not in texts[slug]:
            texts[slug].append(text)

    products: list[tuple[str, str]] = []
    for slug in order:
        if len(products) >= TOP_N:
            break
        cands = texts[slug]
        name = cands[0]
        # Tagline = ayni slug'a isaret eden, adindan farkli, cumle gorunumlu metin.
        tagline = next((t for t in cands[1:] if len(t) > 12 and t.lower() != name.lower()), "")
        # Kimlik = slug (kanonik, degismez); gosterim = ad + tagline.
        products.append((slug, f"{name} — {tagline}" if tagline else name))

    if not products:
        # Sayfa yapisi gercekten degistiyse UYDURMA YAPILMAZ, kaynak atlanir.
        return [], "TAAFT: arac linkleri cozulemedi (sayfa yapisi degismis)"
    return products, "There's An AI For That gunun yeni araclari (jina vekili, markdown)"


# --------------------------------------------------------------------------
# Kaynak 3 — Hacker News (resmi Firebase API; kazima yok, daily.dev vekili)
# --------------------------------------------------------------------------

HN_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json"
HN_ITEM = "https://hacker-news.firebaseio.com/v0/item/{}.json"


def collect_hn() -> tuple[list[str], str]:
    ok, body = fetch(HN_TOP, timeout=25)
    if not ok:
        return [], f"Hacker News okunamadi ({body[:80]})"
    try:
        ids = json.loads(body)[:12]
    except (json.JSONDecodeError, TypeError):
        return [], "Hacker News: topstories cozulemedi"

    stories: list[tuple[int, str]] = []
    for sid in ids:
        ok2, raw = fetch(HN_ITEM.format(sid), timeout=20)
        if not ok2:
            continue
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(item, dict) or not item.get("title"):
            continue
        stories.append((int(item.get("score") or 0), str(item["title"])))
    if not stories:
        return [], "Hacker News: hicbir basliga ulasilamadi"
    stories.sort(key=lambda s: -s[0])
    # Kimlik = BASLIK (gun icinde sabit); gosterim puani da tasir. Puan
    # dakikalar icinde degisir; delta imzasina GIRMEZ (bkz. `signature_of`).
    return [(title, f"{title} ({score} puan)") for score, title in stories[:TOP_N]], "Hacker News on sayfa"


# --------------------------------------------------------------------------


Block = tuple[str, list[tuple[str, str]], str]  # (etiket, [(kimlik, gosterim)], not)


def build_content(day: str, blocks: list[Block], failures: list[str]) -> str:
    parts = [
        f"Gunluk teknoloji/AI istihbarat brifi ({day}). Bu ozet Smith'in "
        "otomatik farkindalik taramasiyla, kullanicinin takip ettigi kaynaklardan "
        "dogrudan cekilmistir."
    ]
    for label, items, note in blocks:
        listed = "; ".join(f"{i + 1}) {shown}" for i, (_id, shown) in enumerate(items))
        parts.append(f"{label} [{note}]: {listed}.")
    if failures:
        # Basarisiz kaynak GIZLENMEZ: Smith "TAAFT'a bakamadim" diyebilmeli.
        parts.append("Ulasilamayan kaynaklar: " + "; ".join(failures) + ".")
    return " ".join(parts)


def signature_of(blocks: list[Block]) -> dict[str, list[str]]:
    """Delta imzasi — yalniz KIMLIKLER, gosterim metni degil.

    NEDEN ICERIGIN TAMAMI DEGIL: HN puanlari dakikalar icinde degisir
    (olculdu: ayni 5 baslik, iki kosu arasinda 937/482/385 -> 937/482/380).
    Ham icerigi karsilastirmak, ayni haberler icin her kosuda bir embed
    yakardi. Kimlik kumesi (urun adi / slug / baslik) gun icinde sabittir;
    gercekten yeni bir urun cikarsa imza degisir ve brif tazelenir.
    """
    return {label: sorted(ident for ident, _shown in items) for label, items, _note in blocks}


def main() -> None:
    smith_paths.warn_if_legacy_data()
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true", help="Kaynaklari cek ve bas; POST yok, durum yazilmaz.")
    ap.add_argument("--dry-run", action="store_true", help="Ozeti uret ve bas; POST yok.")
    ap.add_argument("--force", action="store_true", help="Icerik ayni olsa da yazar.")
    args = ap.parse_args()

    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    key = f"intel:{day}"
    print(f"Istihbarat taramasi ({day}). Durum dosyasi: {STATE_FILE}", flush=True)
    print(f"PH hedef gunu (Pasifik, dun): {pacific_target_day()}", flush=True)

    blocks: list[Block] = []
    failures: list[str] = []

    for label, collector in (
        ("Product Hunt one cikanlar", collect_product_hunt),
        ("There's An AI For That yeni araclar", collect_taaft),
        ("Hacker News on sayfa", collect_hn),
    ):
        print(f"  {label} cekiliyor...", flush=True)
        try:
            items, note = collector()
        except Exception as e:  # noqa: BLE001 — bir kaynagin cokmesi digerlerini iptal etmesin
            items, note = [], f"{label}: beklenmeyen hata {type(e).__name__}: {e}"
        if items:
            blocks.append((label, items, note))
            print(f"    OK ({len(items)} oge) — {note}", flush=True)
            for _ident, shown in items:
                print(f"      - {shown[:110]}", flush=True)
        else:
            failures.append(note)
            print(f"    ATLANDI — {note}", flush=True)

    if not blocks:
        # UYDURMA YASAK: hicbir kaynak calismadiysa kayit YAZILMAZ.
        print("\nHicbir kaynak okunamadi -> kayit YAZILMADI (uydurma icerik yasak).", flush=True)
        for f in failures:
            print(f"  {f}", flush=True)
        print("EMBED HARCANAN: 0", flush=True)
        sys.exit(1)

    content = build_content(day, blocks, failures)
    signature = signature_of(blocks)
    print(f"\nOzet uretildi ({len(content)} karakter, {len(blocks)} kaynak, "
          f"{len(failures)} basarisiz).", flush=True)

    if args.probe:
        print("PROBE: durum kaydedilmedi, POST yapilmadi.", flush=True)
        return

    state = load_state()
    days: dict = state.setdefault("gunler", {})
    prev = (days.get(day) or {}).get("imza")
    if prev == signature and not args.force:
        # Ayni gun ikinci kosu, ayni urun/baslik kumesi → 0 embed.
        print("DEGISMEDI (imza ayni) -> POST atlandi (0 embed)", flush=True)
        print("EMBED HARCANAN: 0", flush=True)
        return

    if args.dry_run:
        print(f"\n--- {key}\n{content}", flush=True)
        print("\nKURU CALISTIRMA: POST yapilmadi.", flush=True)
        print("EMBED HARCANAN: 0 (kuru calistirma)", flush=True)
        return

    token = login()
    code = remember_with_backoff(token, content, key, [30.0, 90.0])
    if code == 200:
        days[day] = {
            "imza": signature,
            "yazildi": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        # Durum dosyasi sinirsiz buyumesin: son 30 gun yeter (delta karsilastirmasi
        # yalniz AYNI gune bakar; eski gunler yalniz iz kaydidir).
        for old in sorted(days)[:-30]:
            days.pop(old, None)
        save_state(state)
        print(f"  yazildi: {key}", flush=True)
        print("EMBED HARCANAN: 1", flush=True)
    else:
        print(f"  HATA {code}: {key}", flush=True)
        print("EMBED HARCANAN: 1 (basarisiz)", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
