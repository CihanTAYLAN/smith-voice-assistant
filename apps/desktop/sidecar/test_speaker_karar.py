"""Ses izi KARAR mantiginin regresyon testi — model, ses ve ag GEREKMEZ.

NEDEN VAR: 2026-08-15'te iki sabit deger sessizce yanlis secildi ve ozelligi
OLU birakti; ikisini de ancak gercek sesle yapilan bir olcum yakaladi.
  - ADAPT_MARGIN 0.15 -> kapi 0.63 olurken gercek ifade 0.625 aliyordu,
    yani uyarlama hicbir zaman atesleyemezdi.
  - ADAPT_MIN_S 2.0 -> gercek ifade 1.98 sn surdu, kil payi disarida kaldi ve
    "kendi kendine iyilesme" zinciri hic calismadi.
Bu sinif hata belirti URETMEZ (hata mesaji yok, log yok, test kirmizi degil);
yalnizca ozellik hicbir sey yapmaz. O yuzden kapiyi kod ile tutuyoruz.

Biyometrik veri KULLANILMAZ: sahte bir gomucu ile sentetik vektorler.

Calistirma:  python test_speaker_karar.py      (cikis kodu 0 = gecti)
"""

from __future__ import annotations

import os
import pathlib
import shutil
import sys
import tempfile

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import speaker_server as ss  # noqa: E402

BASARI = True
TMP = pathlib.Path(tempfile.mkdtemp(prefix="spk-karar-"))


def kontrol(ad: str, kosul: bool, ayrinti: str = "") -> None:
    global BASARI
    print(f"  [{'GECTI' if kosul else 'KALDI'}] {ad}" + (f" — {ayrinti}" if ayrinti else ""))
    if not kosul:
        BASARI = False


class SahteVP:
    """`Voiceprint` yerine gecer: verilen vektoru dondurur, model yuklemez."""

    def __init__(self) -> None:
        self.dim = 4
        self.model_name = "sahte"
        self._owner = None
        self._owner_mtime = -1.0
        self.next = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)

    def embed(self, audio, rate: int = ss.RATE):  # noqa: ANN001, ARG002
        v = self.next.astype(np.float32)
        return v / (float(np.linalg.norm(v)) + 1e-9)

    _load_matrix = ss.Voiceprint._load_matrix
    owner = ss.Voiceprint.owner


def birim(sim: float) -> np.ndarray:
    """Referansla (1,0,0,0) kosinusu tam `sim` olan bir vektor."""
    return np.array([sim, float(np.sqrt(max(0.0, 1 - sim * sim))), 0.0, 0.0], dtype=np.float32)


def ses(saniye: float) -> np.ndarray:
    return np.zeros(int(saniye * ss.RATE), dtype=np.float32)


def referans(rows: list[np.ndarray]) -> None:
    ss.adapt_path().unlink(missing_ok=True)
    np.save(ss.owner_path(), np.vstack([r.reshape(1, -1) for r in rows]).astype(np.float32))
    ss.VP._owner = None
    ss.VP._owner_mtime = -1.0


def main() -> int:
    ss.owner_path = lambda: TMP / "owner.npy"
    ss.adapt_path = lambda: TMP / "owner_adapt.npy"
    ss.olcum_path = lambda: TMP / "log.jsonl"
    os.environ["SMITH_SPEAKER_THRESHOLD"] = "0.48"
    os.environ.pop("SMITH_SPEAKER_ADAPT", None)
    thr = ss.threshold()
    ss.VP = SahteVP()
    ref = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)

    print("1) KARAR BANTLARI")
    for sim, beklenen in [
        (thr + 0.20, "sahip"),
        (thr + 0.001, "sahip"),
        (thr - 0.001, "belirsiz"),
        (thr - ss.BAND + 0.001, "belirsiz"),
        (thr - ss.BAND - 0.01, "yabanci"),
        (0.05, "yabanci"),
    ]:
        referans([ref])
        ss.VP.next = birim(sim)
        r = ss.verify(ses(2.0))
        kontrol(f"benzerlik ~{sim:.3f} -> {beklenen}", r["karar"] == beklenen, r["karar"])

    print("\n2) UYARLAMA KAPISI — sabitler ozelligi OLU birakmamali")
    # Bu iki kontrol, yasanan iki gercek hatanin dogrudan karsiligi.
    referans([ref])
    ss.VP.next = birim(0.6254)  # sahada olculen gercek deger
    r = ss.verify(ses(1.98))  # sahada olculen gercek sure
    kontrol(
        "sahada olculen ifade (benzerlik 0.625, sure 1.98s) OGRENILIR",
        r["ogrenildi"] is True,
        "ADAPT_MARGIN veya ADAPT_MIN_S fazla katiysa uyarlama hic calismaz",
    )

    referans([ref])
    ss.VP.next = birim(thr + ss.ADAPT_MARGIN - 0.01)
    r = ss.verify(ses(3.0))
    kontrol("marjin ALTI ogrenilmez", r["ogrenildi"] is False)

    referans([ref])
    ss.VP.next = birim(0.9)
    r = ss.verify(ses(ss.ADAPT_MIN_S - 0.1))
    kontrol("sure ALTI ogrenilmez", r["ogrenildi"] is False)

    referans([ref])
    ss.VP.next = birim(0.99)  # mevcut prototiple neredeyse ayni
    r = ss.verify(ses(3.0))
    kontrol("gereksiz (cok benzer) ornek ogrenilmez", r["ogrenildi"] is False)

    print("\n3) KENDI KENDINE IYILESME ZINCIRI")
    referans([ref])
    zayif = birim(0.40)  # tek basina bant ici
    ss.VP.next = zayif
    once = ss.verify(ses(2.0))["karar"]
    # Zayif ifadeye YAKIN ama net dogrulanan bir ifade gelir ve ogrenilir.
    ss.VP.next = zayif * 0.98 + ref * 0.35
    orta = ss.verify(ses(2.0))
    ss.VP._owner = None
    ss.VP._owner_mtime = -1.0
    ss.VP.next = zayif
    sonra = ss.verify(ses(2.0))
    kontrol("once kabul edilmiyordu", once != "sahip", once)
    kontrol("net ifade ogrenildi", orta["ogrenildi"] is True)
    kontrol("ayni ifade artik kabul ediliyor", sonra["karar"] == "sahip", sonra["karar"])

    print("\n4) TAVAN VE GERIYE DONUK UYUM")
    referans([ref])
    # CESITLI ornekler uret: hepsi referansa yeterince yakin (ogrenilecek kadar)
    # ama BIRBIRINDEN uzak (gereksizlik kapisina takilmayacak kadar). Ayni
    # duzlemde uretilen ornekler neredeyse ozdes olur ve tavan hic zorlanmaz —
    # o zaman bu test tavan mantigi BOZUK olsa da gecerdi.
    rng = np.random.default_rng(7)
    eklenen = 0
    for _ in range(ss.ADAPT_MAX * 3):
        yon = rng.normal(size=3)
        yon /= np.linalg.norm(yon) + 1e-9
        s = 0.62
        v = np.concatenate(([s], yon * float(np.sqrt(1 - s * s)))).astype(np.float32)
        ss.VP.next = v
        ss.VP._owner = None
        ss.VP._owner_mtime = -1.0
        if ss.verify(ses(2.0))["ogrenildi"]:
            eklenen += 1
    n = np.load(ss.adapt_path()).shape[0] if ss.adapt_path().is_file() else 0
    kontrol(
        f"tavan gercekten zorlandi ({eklenen} ekleme denemesi basarili)",
        eklenen > ss.ADAPT_MAX,
        f"{eklenen} — tavan zorlanmadiysa asagidaki iddia bos gecer",
    )
    kontrol(f"uyarlama tavani asilmiyor ({n} <= {ss.ADAPT_MAX})", n <= ss.ADAPT_MAX, str(n))

    ss.adapt_path().unlink(missing_ok=True)
    np.save(ss.owner_path(), ref)  # ESKI bicim: tek boyutlu vektor
    ss.VP._owner = None
    ss.VP._owner_mtime = -1.0
    ss.VP.next = birim(0.9)
    r = ss.verify(ses(2.0))
    kontrol("eski TEK VEKTORLU referans dosyasi okunuyor", r["prototip"] == 1, str(r["prototip"]))

    print("\n5) KISA SES KARAR URETMEZ")
    r = ss.verify(ses(ss.MIN_AUDIO_S - 0.1))
    kontrol("hata donuyor, 'yabanci' denmiyor", "hata" in r and "karar" not in r)

    shutil.rmtree(TMP, ignore_errors=True)
    print(f"\n=== {'HEPSI GECTI' if BASARI else 'BASARISIZ'} ===")
    return 0 if BASARI else 1


if __name__ == "__main__":
    sys.exit(main())
