"""Smith ses izi dogrulama (speaker verification) sidecar'i — YEREL, port 8124.

NE ISE YARAR: gelen bir ifadenin Cihan'a ait olup olmadigina karar verir.
Masaustu bu karari hafizaya YAZMA ve hassas arac calistirma kapisi olarak
kullanir (bkz. apps/desktop/src-tauri/src/audio/speaker.rs).

NEDEN YEREL VE NEDEN AYRI SUREC:
  - Ses izi (voiceprint) biyometrik veridir; buluta CIKMAZ. Model, referans
    embedding ve karsilastirma tamamen bu makinede kalir.
  - Sidecar deseni bu repoda STT 8123 ve konnektorlerde isini yapti: Python
    ekosistemi modeli tasir, Rust tarafi 60 satirlik bir
    TCP istemcisiyle kurtulur, sunucu yoksa uygulama zarif duser.

MODEL SECIMI (olculerek karar verildi, 2026-08-14):
  Aday havuzu sherpa-onnx speaker-recognition model zoo'su. Kriter: pip ile
  admin'siz kurulum, CPU'da <200 ms, makul boyut. `sherpa-onnx` (1.13.5) wheel
  Windows'ta sorunsuz kuruldu ve fbank cikarimini kendi tasiyor — torch
  GEREKMEZ (speechbrain/resemblyzer yolu ~2 GB torch bagimliligi getiriyordu;
  bu makinede zaten onnxruntime var, o yuzden reddedildi).

  Bu makinede olculen ayrisma (ayni-kisi vs farkli-kisi kosinus benzerligi;
  referans WAV'lari sherpa-onnx release'inden + kullanicinin kendi 2 kaydi):

    model                                 ayni kisi    impostor tavani   gecikme
    3dspeaker campplus zh_en advanced      0.64-0.87        0.32        9-33 ms
    3dspeaker eres2netv2 zh-cn (71 MB)     0.71-0.91        0.31       26-150 ms
    3dspeaker campplus en_voxceleb         0.13-0.66        0.86  <- AYRISTIRMIYOR
    wespeaker en_voxceleb CAM++_LM         0.23-0.59        0.85  <- AYRISTIRMIYOR

  SECIM: `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` (28 MB).
  Ayrisma marji genis, gecikme butcenin onda biri, boyut kucuk. Son iki model
  KAGIT UZERINDE uygun gorunuyordu ama bu harness'ta impostor skoru ayni-kisi
  skorunun UZERINE cikti (yani karar veremiyorlar) — "derlendi/kuruldu" ile
  "calisiyor" arasindaki farkin bir ornegi daha. eres2netv2 bir tik daha iyi
  ayristiriyor ama 2.5x boyut ve 5x gecikme getiriyor; gerekirse kod
  degistirmeden `SMITH_SPEAKER_MODEL` ile takilabilir (indirilmis durumda).
  Turkce onemli degil: ses izi dilden bagimsiz bir kanal (spektral/prosodik).

PROTOKOL (STT sidecar'iyla AYNI — bilincli tekrar, tek satirlik Rust istemcisi):
  istek : u32-LE ornek sayisi N + N adet f32-LE PCM (16 kHz mono)
  yanit : u32-LE bayt uzunlugu + UTF-8 JSON
          {"benzerlik": 0.0-1.0, "sahip": bool, "karar": "sahip|belirsiz|yabanci",
           "esik": float, "prototip": int, "ogrenildi": bool, "sure": float,
           "ms": int}
          kayit yoksa / ses cok kisaysa {"hata": "…"}

  `karar` UC DEGERLI (2026-08-15): esigin hemen altindaki skor "yabanci" demek
  icin zayif kanit oldugu icin ayri bir "belirsiz" durumu var. `sahip` alani
  geriye donuk uyum icin duruyor. Ayrintili gerekce: COK PROTOTIP bolumu.

KAYIT (enrollment):
  python speaker_server.py --enroll                 # mikrofondan, 8 cumle (farkli kosullarda)
  python speaker_server.py --enroll-from-wav a.wav… # WAV'lardan (kuru calisma)
  Referans: <veri koku>\\speaker\\owner.npy  (veri koku: SMITH_DATA_DIR ya da
            %USERPROFILE%\\.smith; bkz. smith_paths.py)
            (N x 192 PROTOTIP matrisi: 0. satir centroid, sonrasi tek tek
             kayit ornekleri. Eski TEK vektorlu dosyalar da okunur.)
  Uyarlama: …\\owner_adapt.npy — canlida NET dogrulanmis ifadelerden ogrenilen
            ek prototipler. Silmek uyarlamayi sifirlar, kaydi bozmaz.
  Olcum   : …\\verify-log.jsonl — her dogrulamanin skoru/karari (biyometrik
            veri YOK). "zaman zaman tanimiyor" siniftan bir kusur ancak
            DAGILIMLA teshis edilir.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import pathlib
import shutil
import socketserver
import struct
import sys
import threading
import time
import tempfile
import urllib.request
from datetime import datetime

import numpy as np

import smith_paths
import speaker_enrollment as enrollment

# --- Sabitler ------------------------------------------------------------

RATE = 16_000

DEFAULT_MODEL = "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
MODEL_BASE = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models"  # DIKKAT: yazim hatasi upstream tag'in kendisinde
)

# Esik: yukaridaki olcumden. Ayni kisi (zayif referansla bile) >= 0.64,
# olculen impostor tavani 0.32 → 0.45 iki tarafa da ~0.15 pay birakir ve
# guvenlik tarafina hafifce yaslanir. `SMITH_SPEAKER_THRESHOLD` ile ayarlanir;
# `--enroll` kendi olctugu dagilimi basip oneri verir.
# 0.45 -> 0.48 (2026-08-15): karar 2026-08-14'te CANLI OLCUMLE 0.48'e
# cekilmisti (kayit ortaminda self-verify 0.883 ama canli ifadeler 0.63-0.67;
# 0.55 ile bir ifade 0.409 alip YANLIS REDDEDILDI). Ama karar yalniz
# `dev-win.ps1` yorumunda yasiyordu: `speaker-server.ps1 -Threshold`
# varsayilani BOS oldugu icin env HIC set edilmiyor ve sunucu bu Python
# varsayilanina dusuyordu. Yani YAZILI KARAR 0.48, CALISAN DEGER 0.45'ti.
# Karar artik burada, tek yerde.
DEFAULT_THRESHOLD = 0.48

# Dogrulama penceresi tavani (sn). Sure duyarliligi olculdu: benzerlik ~1.5 sn'de
# platoya oturuyor (0.5 sn: 0.49 / 1.0 sn: 0.65 / 1.5 sn: 0.76 / 3.0 sn: 0.76).
# Daha fazla ses dogrulugu artirmiyor, yalniz gecikmeyi buyutuyor → tavan koy.
MAX_WINDOW_S = 4.0
MAX_REQUEST_S = 30
SOCKET_TIMEOUT_S = 5
# Bunun altindaki ifade ile karar VERILMEZ ("bilmiyorum" doner): 0.5 sn'de
# benzerlik gercek konusmada bile esigin altina dusebiliyor → yanlis RED uretir.
MIN_AUDIO_S = 0.8

# --- COK PROTOTIP + UYARLAMA (2026-08-15) --------------------------------
# OLCULEN KUSUR: kayit TEK oturumdan (5 ornek) alinip TEK merkez olarak
# saklaniyordu. Ayni oturumda self-verify 0.883 cikiyor, ama BASKA bir gunun
# gercek ifadeleri 0.45-0.63'e dusuyor — biri (utt-001) tam uzunlukta bile
# 0.478 alip esigin ALTINDA kaldi, yani kullanicinin kendi sesi reddedildi.
# Kusur sure degil (2 sn'de de 0.476), SEVIYE hic degil (kazanc 20x degisince
# benzerlik 0.622->0.625, gomucu normalize ediyor): referans DAR.
#
# Olculen cozum: referansi coklastir, skoru MAX al.
#   utt-001: tek merkez 0.478 [RED] -> cok prototip 0.642 [Owner]
#   impostor tavani    : 0.095 -> 0.098  (yani yanlis kabul tarafi acilmiyor)
#   ayrim payi         : 0.544
ADAPT_ENABLED_DEFAULT = True
# Uyarlama yalniz NET sahip kararinda yapilir: esigin bu kadar USTUNDE olmali.
# 0.15 DENENDI VE OLCUMLE ELENDI: esik 0.48 iken kapi 0.63 olur, oysa gercek
# bir ifade 0.625 aliyordu — yani uyarlama neredeyse hic atesleyemezdi ve
# referans hicbir zaman zenginlesmezdi. 0.10 → kapi 0.58; olculen impostor
# tavani (bu makinede 0.32) hala cok uzakta.
ADAPT_MARGIN = 0.10
# ...ve ifade bu kadar uzun olmali (kisa ifadenin embedding'i gurultulu).
# 2.0 DENENDI VE OLCUMLE ELENDI: gercek bir ifade 1.98 sn surdu ve uyarlama
# kilpayi atesleyemedi — kendi kendine iyilesme zinciri sessizce olu kaliyordu
# (regresyon testi yakaladi). 1.5 sn keyfi degil: yukaridaki SURE DUYARLILIGI
# olcumunde benzerlik tam orada platoya oturuyor (1.5s: 0.76 ~ 3.0s: 0.76),
# yani skor o noktadan sonra guvenilir.
ADAPT_MIN_S = 1.5
# Prototip tavani. Sinirsiz buyume hem yavaslatir hem de eski/bayat kayitlari
# sonsuza kadar tasir.
ADAPT_MAX = 12
# Mevcut bir prototiple bundan daha benzer olan yeni ornek BILGI KATMAZ.
ADAPT_REDUNDANT = 0.95

# KARARSIZLIK BANDI: esigin hemen altindaki skor "bu kisi yabanci" demek icin
# ZAYIF bir kanittir. Olculen ayni-kisi tabani (0.45-0.48) ile esik ic ice
# geciyor; bu bantta FOREIGN demek kullaniciyi yanlis suclar ve 60 sn boyunca
# hafizaya yazmayi kilitler. Bant icinde "belirsiz" doneriz: yazma yine
# aciImaz (fail-safe korunur) ama TAZE bir Owner karari EZILMEZ.
BAND = 0.12

_REFERENCE_LOCK = threading.RLock()


@contextlib.contextmanager
def _reference_file_lock(directory: pathlib.Path):
    """Serialize reference reads and writes across sidecar/enrollment processes."""
    lock_path = directory / ".reference.lock"
    with lock_path.open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            deadline = time.monotonic() + 30
            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("speaker referans kilidi 30 sn icinde alinamadi")
                    time.sleep(0.05)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

# --- Yollar --------------------------------------------------------------


def data_dir() -> pathlib.Path:
    """<veri koku>\\speaker: model + referans burada durur.

    Veri koku tek kuraldan gelir (smith_paths.data_root: SMITH_DATA_DIR ya da
    %USERPROFILE%\\.smith, Windows disinda ~/.smith). Repoya ne model ne
    biyometrik veri girer (AGENTS.md secret kurali ve gizlilik ilkesi).
    """
    d = smith_paths.data_root() / "speaker"
    d.mkdir(parents=True, exist_ok=True)
    return d


def owner_path() -> pathlib.Path:
    return data_dir() / "owner.npy"


def owner_meta_path() -> pathlib.Path:
    return data_dir() / "owner.json"


def adapt_path() -> pathlib.Path:
    """Uyarlama ile ogrenilen ek prototipler — kayit dosyasindan AYRI.

    Ayri tutulmasinin nedeni: `--enroll` temiz bir baslangic yapabilmeli ve
    kullanici uyarlamayi tek dosya silerek geri alabilmeli. Kayit dosyasina
    yazsaydik ikisi birbirine karisirdi.
    """
    return data_dir() / "owner_adapt.npy"


def adapt_enabled() -> bool:
    """`SMITH_SPEAKER_ADAPT=0` kapatir; varsayilan acik."""
    v = os.environ.get("SMITH_SPEAKER_ADAPT", "").strip()
    return ADAPT_ENABLED_DEFAULT if v == "" else v != "0"


def model_path() -> pathlib.Path:
    """Aktif model dosyasi. `SMITH_SPEAKER_MODEL` tam yol veya dosya adi olabilir."""
    v = os.environ.get("SMITH_SPEAKER_MODEL", "").strip()
    if v:
        p = pathlib.Path(v)
        return p if p.is_absolute() else data_dir() / v
    return data_dir() / DEFAULT_MODEL


def threshold() -> float:
    """Esik. Bozuk deger sessizce yutulmaz: varsayilana duser ve uyarir."""
    raw = os.environ.get("SMITH_SPEAKER_THRESHOLD", "").strip()
    if not raw:
        return DEFAULT_THRESHOLD
    try:
        v = float(raw)
    except ValueError:
        print(
            f"[speaker] SMITH_SPEAKER_THRESHOLD bozuk ({raw!r}) -> {DEFAULT_THRESHOLD}",
            file=sys.stderr,
        )
        return DEFAULT_THRESHOLD
    if not 0.0 < v < 1.0:
        print(f"[speaker] esik araligi disi ({v}) -> {DEFAULT_THRESHOLD}", file=sys.stderr)
        return DEFAULT_THRESHOLD
    return v


def ensure_model() -> pathlib.Path:
    """Model yoksa indirir (~28 MB). Repoya binary girmez; STT'deki ayni desen."""
    p = model_path()
    if p.is_file() and p.stat().st_size > 1_000_000:
        return p
    url = f"{MODEL_BASE}/{p.name}"
    tmp = p.with_suffix(p.suffix + ".part")
    print(f"[speaker] model indiriliyor: {p.name} …", file=sys.stderr, flush=True)
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    tmp.replace(p)
    print(f"[speaker] model hazir ({p.stat().st_size/1e6:.0f} MB)", file=sys.stderr, flush=True)
    return p


# --- Embedding -----------------------------------------------------------


class Voiceprint:
    """Ses izi cikarici + referans. Tek yer: kayit ve dogrulama AYNI kodu kullanir.

    Kayit ile dogrulama farkli hesaplama yollarindan gecerse esik anlamsizlasir
    (sessiz kalibrasyon kaymasi). O yuzden enrollment de bu sinifi kullanir.
    """

    def __init__(self, model: pathlib.Path, threads: int = 2) -> None:
        import sherpa_onnx

        self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(model), num_threads=threads, debug=False
            )
        )
        self.dim = self.extractor.dim
        self.model_name = model.name
        self._owner: np.ndarray | None = None
        self._owner_mtime: float = -1.0

    def embed(self, audio: np.ndarray, rate: int = RATE) -> np.ndarray:
        """16 kHz mono f32 -> L2-normalize edilmis embedding."""
        s = self.extractor.create_stream()
        s.accept_waveform(rate, audio)
        s.input_finished()
        v = np.asarray(self.extractor.compute(s), dtype=np.float32)
        n = float(np.linalg.norm(v))
        return v / (n + 1e-9)

    def _load_matrix(self, p: pathlib.Path) -> np.ndarray | None:
        """Bir .npy'yi (N, dim) satir-normalize matrise cevirir; uymuyorsa None.

        Geriye donuk uyum: eski dosyalar TEK vektor (1-D centroid). O da tek
        satirlik matris sayilir, yani eski kayitla sistem calismaya devam eder.
        """
        if not p.is_file():
            return None
        a = np.load(p).astype(np.float32)
        if a.ndim == 1:
            a = a.reshape(1, -1)
        if a.ndim != 2 or a.shape[1] != self.dim:
            print(
                f"[speaker] referans boyutu uyusmuyor ({a.shape} != (N,{self.dim})); "
                "model degistiyse yeniden kayit gerekir",
                file=sys.stderr,
            )
            return None
        n = np.linalg.norm(a, axis=1, keepdims=True)
        return a / (n + 1e-9)

    def owner(self) -> np.ndarray | None:
        """Referans PROTOTIPLERI, (N, dim). Dosya degistiyse yeniden okur.

        Ad geriye donuk uyum icin korundu ama artik MATRIS doner: tek centroid
        yerine birden cok referans tutuyoruz ve skor MAX aliniyor. Gerekcesi ve
        olcumu yukarida (COK PROTOTIP bolumu).

        Neden mtime: kullanici sunucu ayaktayken yeni kayit yaparsa yeni ses izi
        ANINDA gecerli olmali; yoksa "kaydettim ama tanimiyor" diye geri doner.
        Uyarlama dosyasi da izlenir — kendi yazdigimiz prototip bir sonraki
        dogrulamada gecerli olsun.
        """
        p, pa = owner_path(), adapt_path()
        with _REFERENCE_LOCK, _reference_file_lock(p.parent):
            if not p.is_file():
                self._owner = None
                self._owner_mtime = -1.0
                return None
            m = p.stat().st_mtime + (pa.stat().st_mtime if pa.is_file() else 0.0)
            if self._owner is None or m != self._owner_mtime:
                base = self._load_matrix(p)
                if base is None:
                    self._owner = None
                    self._owner_mtime = m
                    return None
                ek = self._load_matrix(pa)
                self._owner = base if ek is None else np.vstack([base, ek])
                self._owner_mtime = m
                print(
                    f"[speaker] referans yuklendi ({self._owner.shape[0]} prototip: "
                    f"{base.shape[0]} kayit + {0 if ek is None else ek.shape[0]} uyarlama)",
                    file=sys.stderr,
                    flush=True,
                )
            return self._owner


def loudest_window(audio: np.ndarray, max_s: float = MAX_WINDOW_S) -> np.ndarray:
    """Ifade tavandan uzunsa EN GUCLU max_s'lik pencereyi sec.

    Bastan/sondan kirpmak yerine enerjiye gore secmenin nedeni: ifadenin basi
    veya sonu sessizlik/nefes olabilir ve sessizlik embedding'i kanal
    gurultusune dogru kaydirir. Kayan kare-toplami ile O(n).
    """
    cap = int(max_s * RATE)
    if audio.size <= cap:
        return audio
    sq = np.cumsum(np.concatenate(([0.0], audio.astype(np.float64) ** 2)))
    # her baslangic icin pencere enerjisi; adim 80 ms (hassasiyet fazlasi gereksiz)
    step = RATE // 12
    starts = np.arange(0, audio.size - cap + 1, step)
    energies = sq[starts + cap] - sq[starts]
    return audio[starts[int(np.argmax(energies))] :][:cap]


# --- Sunucu --------------------------------------------------------------

VP: Voiceprint | None = None


def _atomic_save_matrix(path: pathlib.Path, matrix: np.ndarray) -> None:
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".npy", delete=False) as handle:
        pending = pathlib.Path(handle.name)
    try:
        np.save(pending, matrix.astype(np.float32))
        pending.replace(path)
    finally:
        pending.unlink(missing_ok=True)


def _adapt(emb: np.ndarray, sims: np.ndarray, dur: float, sim: float, thr: float) -> bool:
    """Net bir sahip karari, referansi ZENGINLESTIRIR. Kosullar sert.

    Neden gerekli: kayit tek oturumdan geliyor ve baska bir gunun ifadeleri
    esigin altina dusebiliyor (olculdu). Referans kullanicinin GERCEK
    kosullarini zamanla ogrenmezse ayni yanlis ret tekrarlar.

    Neden guvenli: yalniz esigin ADAPT_MARGIN kadar USTUNDE ve ADAPT_MIN_S'den
    UZUN ifadeler eklenir — yani ekleme yapabilmek icin zaten NET sahip olarak
    dogrulanmis olmak gerekir. Zayif/kisa/bant-ici ornek ASLA ogrenilmez, bu
    yuzden yavas kayma (template drift) ile yabanci bir sese acilamaz.
    """
    if not adapt_enabled() or dur < ADAPT_MIN_S or sim < thr + ADAPT_MARGIN:
        return False
    if float(sims.max()) >= ADAPT_REDUNDANT:
        return False  # zaten cok benzer bir prototip var, bilgi katmaz
    target = adapt_path()
    with _REFERENCE_LOCK, _reference_file_lock(target.parent):
        cur = VP._load_matrix(target) if VP is not None else None
        yeni = emb.reshape(1, -1) if cur is None else np.vstack([cur, emb.reshape(1, -1)])
        if yeni.shape[0] > ADAPT_MAX:
            # Tavan doluysa EN GEREKSIZ olani at (digerlerine en cok benzeyen),
            # boylece set cesitliligini korur — en eskiyi atmak cesitliligi degil
            # yalniz yasi olcerdi.
            g = yeni @ yeni.T
            np.fill_diagonal(g, -1.0)
            yeni = np.delete(yeni, int(np.argmax(g.max(axis=1))), axis=0)
        _atomic_save_matrix(target, yeni)
    print(
        f"[speaker] referans zenginlestirildi ({yeni.shape[0]} uyarlama prototipi, "
        f"benzerlik {sim:.3f} >= {thr:.2f}+{ADAPT_MARGIN})",
        file=sys.stderr,
        flush=True,
    )
    return True


def verify(audio: np.ndarray) -> dict:
    """Bir ifadeyi degerlendirir ve JSON'a gidecek sozlugu uretir."""
    assert VP is not None
    dur = audio.size / RATE
    if dur < MIN_AUDIO_S:
        # Kararsizlik acikca bildirilir. Rust tarafi bunu "bilmiyorum" sayar ve
        # YAZMA'yi bloke eder; sessizce "sahip degil" demek yanlis suclama olur.
        return {"hata": f"ses cok kisa ({dur:.2f}s < {MIN_AUDIO_S}s)"}
    ref = VP.owner()
    if ref is None:
        return {"hata": "kayit yok"}
    t0 = time.time()
    win = loudest_window(audio)
    emb = VP.embed(win)
    # COK PROTOTIP: en yakin referansa benzerlik. Merkeze olan tek benzerlik,
    # farkli oturum/koşuldaki gercek ifadeleri reddediyordu (olculdu).
    sims = ref @ emb
    sim = float(sims.max())
    thr = threshold()

    # KARARSIZLIK BANDI — esigin hemen altini "yabanci" saymayiz.
    if sim >= thr:
        karar = "sahip"
    elif sim >= thr - BAND:
        karar = "belirsiz"
    else:
        karar = "yabanci"

    ogrenildi = _adapt(emb, sims, dur, sim, thr) if karar == "sahip" else False
    return {
        "benzerlik": round(max(0.0, min(1.0, sim)), 4),
        # `sahip` geriye donuk uyum icin duruyor: eski istemci yalniz bunu okur.
        # Yeni istemci `karar`i okur ve "belirsiz"i "bilmiyorum" sayar.
        "sahip": bool(karar == "sahip"),
        "karar": karar,
        "esik": thr,
        "prototip": int(ref.shape[0]),
        "ogrenildi": ogrenildi,
        "sure": round(dur, 2),
        "ms": int((time.time() - t0) * 1000),
    }


def olcum_path() -> pathlib.Path:
    return data_dir() / "verify-log.jsonl"


def _olcum_yaz(dur: float, out: dict) -> None:
    """Her dogrulamayi doner bir JSONL'e yazar.

    NEDEN: "zaman zaman dogrulayamiyor" sinifindaki bir kusur TEK olcumle
    teshis edilemez, DAGILIM ister. stderr log'u `tauri dev` zincirinde
    kayboluyor (olculdu), o yuzden kalici bir iz sart. Bicim tek satir JSON:
    sonradan tek komutla histogram cikarilabilir.

    Biyometrik veri YAZILMAZ — yalniz skor, sure ve karar. Ham ses veya
    embedding diske dusmez.
    """
    try:
        kayit = {
            "t": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "sure": round(dur, 2),
            "benzerlik": out.get("benzerlik"),
            "esik": out.get("esik"),
            "karar": out.get("karar") or ("hata" if "hata" in out else None),
            "prototip": out.get("prototip"),
            "ogrenildi": out.get("ogrenildi"),
            "hata": out.get("hata"),
        }
        p = olcum_path()
        # Dosya buyurse basi kirp: teshis icin son birkac bin satir yeter.
        if p.is_file() and p.stat().st_size > 2_000_000:
            satirlar = p.read_text(encoding="utf-8").splitlines()[-2000:]
            p.write_text("\n".join(satirlar) + "\n", encoding="utf-8")
        with p.open("a", encoding="utf-8") as f:
            f.write(json.dumps(kayit, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001
        pass  # olcum log'u bir teshis katmanidir; dogrulamayi ASLA dusurmez


def _read_exact(sock, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("baglanti kapandi")
        buf += chunk
    return buf


class Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:  # noqa: D102
        import socket

        try:
            self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.request.settimeout(SOCKET_TIMEOUT_S)
            (n,) = struct.unpack("<I", _read_exact(self.request, 4))
            if n == 0 or n > MAX_REQUEST_S * RATE:
                raise ValueError(f"PCM uzunlugu 1..{MAX_REQUEST_S} sn araliginda olmali")
            audio = np.frombuffer(_read_exact(self.request, n * 4), dtype=np.float32)
            out = verify(audio)
            body = json.dumps(out).encode("utf-8")
            self.request.sendall(struct.pack("<I", len(body)) + body)
            if "hata" in out:
                print(
                    f"[speaker] {audio.size/RATE:.2f}s ses -> {out['hata']}",
                    file=sys.stderr,
                    flush=True,
                )
            else:
                print(
                    f"[speaker] {out['sure']:.2f}s ses -> benzerlik {out['benzerlik']:.3f} "
                    f"esik {out['esik']:.2f} karar={out['karar']} "
                    f"({out['prototip']} prototip, {out['ms']}ms)",
                    file=sys.stderr,
                    flush=True,
                )
            _olcum_yaz(audio.size / RATE, out)
        except Exception as e:  # noqa: BLE001 — tek istek coker, sunucu ayakta kalir
            print(f"[speaker] istek hatasi: {e!r}", file=sys.stderr, flush=True)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


# --- Kayit (enrollment) --------------------------------------------------

# Kayit cumleleri: farkli fonetik icerik + farkli tonlama. Tek cumleyi tekrar
# okumak referansi o cumlenin prosodisine asiri uydurur (overfit) ve baska
# baglamda konusurken benzerlik duser.
# Vary voice/prosody, not microphone geometry: a headset moves with the head,
# and turning away can make its noise suppression erase speech entirely.
PROMPTS = [
    ("Merhaba Smith, bugun neler yapacagiz?", "normal"),
    ("Bir, iki, uc, dort, bes, alti, yedi, sekiz, dokuz, on.", "yavas"),
    ("Bu bilgisayarda ne kadar bos disk alani var?", "hizli"),
    ("Aksam yedide toplantim oldugunu hatirlatmani istiyorum.", "alcak ama net"),
    ("Yapay zeka projeleri uzerinde calismak bana keyif veriyor.", "yuksek"),
    ("Ekranda ne goruyorsun, kisaca anlatir misin?", "soru tonu"),
    ("Bugun hava nasil, disari cikmali miyim?", "yorgun / rahat"),
    ("Sistem durumunu kontrol et ve bana ozetle.", "gulumseyerek"),
]


def _pairwise(embs: list[np.ndarray]) -> list[float]:
    out = []
    for i in range(len(embs)):
        for j in range(i + 1, len(embs)):
            out.append(float(np.dot(embs[i], embs[j])))
    return out


def _prepare_owner(vp: Voiceprint, embs: list[np.ndarray], source: str) -> tuple[np.ndarray, dict]:
    """Build the candidate and statistics without accessing the saved reference.

    ARTIK CENTROID DEGIL, PROTOTIP SETI yazilir: 0. satir centroid, sonraki
    satirlar tek tek kayit ornekleri. Gerekcesi olculdu — tek centroid baska
    bir oturumun gercek ifadesini reddediyordu (utt-001: merkez 0.478 RED,
    cok prototip 0.642 Owner), impostor tavani ise 0.095'ten 0.098'e cikiyor,
    yani yanlis kabul tarafi pratik olarak acilmiyor.
    """
    c = np.mean(np.stack(embs), axis=0)
    c /= float(np.linalg.norm(c)) + 1e-9
    proto = np.vstack([c.reshape(1, -1), np.stack(embs)]).astype(np.float32)
    pw = _pairwise(embs)
    # Her kaydin centroid'e benzerligi: kayit ici tutarlilik olcusu.
    to_c = [float(np.dot(e, c)) for e in embs]

    # ESIK ONERISI, SKORLAMA YOLUYLA AYNI OLMALI. Uretim skoru artik TUM
    # prototiplere MAX; oysa oneri eskiden ikili minimuma bakiyordu ve bu
    # ikisi ayni sey DEGIL. Ornek (2026-08-15 gercek kaydi): farkli akustik
    # kosullarda okunan 8 cumlenin ikili min'i 0.446 -> eski formul esigi
    # 0.40'a cekiyordu, oysa MAX skorlamada gercek ayni-kisi tabani 0.753'tu.
    # Yani oneri, korumayi gereksiz yere ~0.35 zayiflatacakti.
    #
    # Dogru olcu LEAVE-ONE-OUT: her ornegi disarida birak, KALAN prototiplere
    # MAX benzerligine bak. Bu, yeni bir ifadenin uretimde alacagi skorun
    # dogrudan taklidi. Kosul cesitliligi ikili minimumu DUSURUR (istenen sey
    # budur, referans genisliyor) ama LOO tabanini YUKSELTIR.
    loo = []
    E = np.stack(embs)
    for i in range(E.shape[0]):
        kalan = np.vstack([c.reshape(1, -1), np.delete(E, i, axis=0)])
        loo.append(float((kalan @ E[i]).max()))
    loo_min = min(loo)
    # Gozlenen tabandan pay dus; guvenlik icin bant disina cikma (tek kisinin
    # kendi dagilimi impostor tarafini OLCEMEZ, o yuzden olculmus varsayilanin
    # cok uzagina gidilmez).
    rec = max(0.40, min(0.60, round(loo_min - 0.20, 2)))
    meta = {
        "model": vp.model_name,
        "dim": int(vp.dim),
        "kayit_sayisi": len(embs),
        "kaynak": source,
        "tarih": time.strftime("%Y-%m-%d %H:%M:%S"),
        # Ikili min/ort BILGI amacli kalir: dusuk olmasi kotu DEGIL, kosul
        # cesitliliginin olcusudur. Karar LOO tabanina gore verilir.
        "ayni_kisi_ikili_min": round(min(pw), 4) if pw else None,
        "ayni_kisi_ikili_ort": round(float(np.mean(pw)), 4) if pw else None,
        "centroid_min": round(min(to_c), 4),
        "loo_taban": round(loo_min, 4),
        "loo_ort": round(float(np.mean(loo)), 4),
        "aktif_esik": threshold(),
        "onerilen_esik": rec,
    }
    return proto, meta


def _save_owner(vp: Voiceprint, embs: list[np.ndarray], source: str) -> dict:
    """Commit owner, metadata and adaptation reset as one rollback-safe update."""
    proto, meta = _prepare_owner(vp, embs, source)
    target = owner_path()
    meta_target = owner_meta_path()
    adapt_target = adapt_path()
    with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".npy", delete=False) as handle:
        pending_owner = pathlib.Path(handle.name)
    with tempfile.NamedTemporaryFile(
        mode="w", dir=target.parent, suffix=".json", encoding="utf-8", delete=False
    ) as handle:
        pending_meta = pathlib.Path(handle.name)
        json.dump(meta, handle, ensure_ascii=False, indent=2)
    backup = None
    try:
        np.save(pending_owner, proto)
        with _REFERENCE_LOCK, _reference_file_lock(target.parent):
            old_owner = target.read_bytes() if target.exists() else None
            old_meta = meta_target.read_bytes() if meta_target.exists() else None
            old_adapt = adapt_target.read_bytes() if adapt_target.exists() else None
            replaced_owner = False
            replaced_meta = False
            removed_adapt = False
            try:
                if target.exists():
                    backup = target.with_name(
                        target.name + ".bak-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f")
                    )
                    shutil.copy2(target, backup)
                pending_owner.replace(target)
                replaced_owner = True
                pending_meta.replace(meta_target)
                replaced_meta = True
                adapt_target.unlink(missing_ok=True)
                removed_adapt = old_adapt is not None
            except Exception:
                if replaced_owner:
                    _restore_bytes(target, old_owner)
                if replaced_meta:
                    _restore_bytes(meta_target, old_meta)
                if removed_adapt:
                    _restore_bytes(adapt_target, old_adapt)
                if backup is not None:
                    backup.unlink(missing_ok=True)
                raise
    finally:
        pending_owner.unlink(missing_ok=True)
        pending_meta.unlink(missing_ok=True)
    if backup is not None:
        print(f"  Eski referans yedegi: {backup}")
    return meta


def _restore_bytes(path: pathlib.Path, content: bytes | None) -> None:
    if content is None:
        path.unlink(missing_ok=True)
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        pending = pathlib.Path(handle.name)
        handle.write(content)
    try:
        pending.replace(path)
    finally:
        pending.unlink(missing_ok=True)


def _report(vp: Voiceprint, embs: list[np.ndarray], meta: dict, holdout: np.ndarray | None) -> None:
    # URETIMLE AYNI YOL: referans artik prototip SETI, skor MAX aliniyor.
    # Burada tek vektor varsayip `np.dot` demek raporu uretimden ayirirdi ve
    # "kayit raporu gecti ama canlida rediyor" sinifina kapi acardi.
    proto, _ = _prepare_owner(vp, embs, meta["kaynak"])
    print("")
    print(f"  model            : {meta['model']}  (dim {meta['dim']})")
    print(f"  prototip sayisi  : {proto.shape[0]}  (1 centroid + {proto.shape[0] - 1} ornek)")
    print(f"  kayit sayisi     : {meta['kayit_sayisi']}  ({meta['kaynak']})")
    print(f"  ayni kisi ikili  : min {meta['ayni_kisi_ikili_min']}  ort {meta['ayni_kisi_ikili_ort']}")
    print("                     (DUSUK OLMASI KOTU DEGIL: kosul cesitliliginin olcusu)")
    print(f"  centroid'e en dusuk: {meta['centroid_min']}")
    print(f"  LOO TABANI       : {meta['loo_taban']}  ort {meta['loo_ort']}")
    print("                     (uretimdeki MAX skorlamanin taklidi — KARAR BUNA GORE)")
    print(f"  aktif esik       : {meta['aktif_esik']}")
    if holdout is not None:
        sim = float((proto @ vp.embed(loudest_window(holdout))).max())
        ok = "GECTI" if sim >= meta["aktif_esik"] else "KALDI"
        print(f"  KENDI KENDINI DOGRULAMA (kayitta kullanilmayan ifade): {sim:.3f} -> {ok}")
    print(f"  onerilen esik    : {meta['onerilen_esik']}")
    if meta["onerilen_esik"] != meta["aktif_esik"]:
        print(
            f"\n  ONERI: olculen dagilima gore esik {meta['onerilen_esik']} olabilir. "
            f'Ayarlamak icin: $env:SMITH_SPEAKER_THRESHOLD = "{meta["onerilen_esik"]}"'
        )
    print("")


def _finish_enrollment(vp: Voiceprint, embs: list[np.ndarray], source: str,
                       holdout: np.ndarray | None) -> int:
    _, meta = _prepare_owner(vp, embs, source)
    _report(vp, embs, meta, holdout)
    if input("Kaydedeyim mi? (E/h) ").strip().lower() != "e":
        print("Kayit iptal edildi. owner.npy degistirilmedi.")
        return 0
    _save_owner(vp, embs, source)
    print("Kayit tamam. owner.npy kaydedildi.")
    return 0


def _read_wav(path: str) -> np.ndarray:
    """16 bit PCM WAV -> 16 kHz mono f32 (basit lineer resample, bagimlilik yok)."""
    import wave

    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"{path}: yalniz 16-bit PCM WAV destekli")
        ch, rate, n = w.getnchannels(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if rate != RATE:
        idx = np.arange(0, a.size, rate / RATE)[: int(a.size * RATE / rate)]
        lo = np.floor(idx).astype(np.int64).clip(0, a.size - 1)
        hi = np.minimum(lo + 1, a.size - 1)
        a = a[lo] + (a[hi] - a[lo]) * (idx - lo).astype(np.float32)
    return np.ascontiguousarray(a, dtype=np.float32)


def enroll_from_wav(paths: list[str]) -> int:
    """Kuru calisma / mikrofonsuz kayit yolu: WAV'lardan referans uret."""
    if len(paths) < 2:
        print("[speaker] en az 2 WAV gerekir (dagilim olculemez)", file=sys.stderr)
        return 2
    audios = [_read_wav(p) for p in paths]
    qualities = [enrollment.assess(audio, enrollment.RMS_FLOOR) for audio in audios]
    invalid = [paths[index] for index, quality in enumerate(qualities) if not quality.valid]
    if invalid:
        print(
            "[speaker] gecersiz WAV: " + ", ".join(invalid)
            + " (finite ses, en az 1.2 sn aktif konusma ve yeterli enerji gerekli)",
            file=sys.stderr,
        )
        return 2
    vp = Voiceprint(ensure_model())
    total = sum(a.size for a in audios) / RATE
    print(f"[speaker] {len(paths)} dosya, toplam {total:.1f} sn ses")
    if total < 10.0:
        print(f"[speaker] UYARI: toplam ses 10 sn'nin altinda ({total:.1f} sn)")
    # Son dosya kayitta KULLANILMAZ: kendi kendini dogrulama gorulmemis ses
    # ister, yoksa test kendini onaylar (anlamsiz kanit).
    embs = [vp.embed(loudest_window(a)) for a in audios[:-1]]
    holdout = audios[-1]
    if len(embs) < 2:
        embs = [vp.embed(loudest_window(a)) for a in audios]
        holdout = None
    return _finish_enrollment(vp, embs, f"wav x{len(embs)}", holdout)


def enroll_mic(device: int | str | None = None) -> int:
    """Eight quality-gated sentences and an independent, equally gated holdout."""
    import sounddevice as sd

    selected = sd.default.device[0] if device is None else device
    info = sd.query_devices(selected, "input")
    # query_devices resolves names; use its index for every stream if available.
    selected = info.get("index", selected)
    host = sd.query_hostapis(info["hostapi"])["name"]
    print(f"[speaker] Giris cihazi: {info['name']} (device={selected}, {host})")
    print("=" * 62)
    print(" Smith ses izi kaydi: yalniz CIHAN konussun.")
    print(" Mikrofonu sabit tut; her cumlede belirtilen ses tonunu kullan.")
    print(" ENTER sonrasi 6 sn ses beklenir; baslayinca on-tamponla 5 sn kaydedilir.")
    print("=" * 62)
    input("Gurultu tabani icin ENTER'a bas, 2 sn sessiz kal: ")
    try:
        floor = enrollment.calibrate(sd, selected)
    except ValueError as exc:
        print(f"[speaker] Kalibrasyon gecersiz: {exc}. owner.npy degistirilmedi.")
        return 2
    print(f"[speaker] Gurultu tabani RMS: {floor:.6f}; gerekli konusma SNR >= 4x")
    audios: list[np.ndarray] = []
    qualities: list[enrollment.Quality] = []
    for i, (prompt, kosul) in enumerate(PROMPTS, 1):
        print(f"\n[{i}/{len(PROMPTS)}] KOSUL: {kosul}")
        sample = enrollment.take_sample(sd, selected, floor, prompt)
        if sample is None:
            return 2
        audio, quality = sample
        audios.append(audio)
        qualities.append(quality)

    print("\n[dogrulama] Kayitta kullanilmayan yeni ifade, normal sesle.")
    sample = enrollment.take_sample(sd, selected, floor, "Bu benim sesim, Smith. Beni taniyor musun?")
    if sample is None:
        return 2
    holdout, holdout_quality = sample

    total = sum(a.size for a in audios) / RATE
    print(f"\n[speaker] kayit sesi toplam {total:.1f} sn")
    for i, quality in enumerate(qualities, 1):
        print(f"  Ornek {i}: SNR {quality.snr:.2f}x ({quality.snr_db:.1f} dB),"
              f" konusma {quality.speech_seconds:.2f} sn")
    print(f"  Dogrulama: SNR {holdout_quality.snr:.2f}x ({holdout_quality.snr_db:.1f} dB)")
    vp = Voiceprint(ensure_model())
    embs = [vp.embed(loudest_window(a)) for a in audios]
    return _finish_enrollment(vp, embs, f"mikrofon x{len(embs)}", holdout)


def _device_arg(value: str) -> int | str:
    return int(value) if value.lstrip("-").isdigit() else value


# --- main ----------------------------------------------------------------


def main() -> int:
    global VP

    ap = argparse.ArgumentParser(description="Smith ses izi dogrulama sidecar'i")
    ap.add_argument("--port", type=int, default=8124)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--enroll", action="store_true", help="mikrofondan ses izi kaydi")
    ap.add_argument("--device", type=_device_arg, help="giris cihazi indeksi veya adi (varsayilan: sistem)")
    ap.add_argument("--enroll-from-wav", nargs="+", metavar="WAV", help="WAV'lardan kayit")
    ap.add_argument("--check-wav", nargs="+", metavar="WAV", help="kayitli ize karsi WAV dogrula")
    args = ap.parse_args()

    # Eski (AppData tabanli) konumda tasinmamis ses izi/log varsa acik uyari; kayit ve
    # sunucu yine yeni kokle devam eder (bkz. smith_paths.py).
    smith_paths.warn_if_legacy_data()

    if args.enroll or args.enroll_from_wav:
        try:
            return enroll_mic(args.device) if args.enroll else enroll_from_wav(args.enroll_from_wav)
        except (KeyboardInterrupt, EOFError):
            print("\n[speaker] Kayit kesildi; onaylanmamis aday kaydedilmedi.")
            return 130

    VP = Voiceprint(ensure_model(), threads=args.threads)

    if args.check_wav:
        for p in args.check_wav:
            print(f"{os.path.basename(p):34s} -> {json.dumps(verify(_read_wav(p)))}")
        return 0

    have = "var" if owner_path().is_file() else "YOK (once --enroll)"
    print(
        f"[speaker] READY port={args.port} model={VP.model_name} dim={VP.dim} "
        f"esik={threshold()} kayit={have}",
        file=sys.stderr,
        flush=True,
    )
    with Server(("127.0.0.1", args.port), Handler) as srv:
        srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
