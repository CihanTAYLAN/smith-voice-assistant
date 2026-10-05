"""Piper TTS HTTP sunucusu icin test istemcisi: POST /synthesize ile Turkce
cumle sentezler, WAV'i diske yazar ve format + gecikme + RTF raporlar.

Kullanim:
  python test_piper_client.py --out ornek.wav
  python test_piper_client.py --text "Merhaba efendim." --out ornek.wav
  python test_piper_client.py --bench            (soguk + sicak olcum)
"""

from __future__ import annotations

import argparse
import io
import json
import time
import urllib.request
import wave

import numpy as np

DEFAULT_TEXT = "Merhaba efendim, ben Smith. Ses hatti artik gercek konusma uretiyor."

BENCH_TEXTS = [
    "Merhaba efendim, ben Smith. Ses hatti artik gercek konusma uretiyor.",
    "Bugun hava oldukca guzel, disari cikmak icin ideal bir gun olabilir.",
    "Toplanti kaydini ozetledim ve onemli maddeleri notlar bolumune ekledim.",
]


def synthesize(url: str, text: str, **params: float) -> tuple[bytes, float, str]:
    """Tek istek atar. Doner: (wav_bytes, gecikme_sn, content_type)."""
    body = {"text": text, **params}
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
        ctype = resp.headers.get("Content-Type", "")
    return data, time.perf_counter() - t0, ctype


def analyze(wav_bytes: bytes) -> dict:
    """WAV basligini cozer ve genlik istatistigi cikarir."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        rate = w.getframerate()
        channels = w.getnchannels()
        width = w.getsampwidth()
        frames = w.getnframes()
        pcm = np.frombuffer(w.readframes(frames), dtype=np.int16)

    f = pcm.astype(np.float32) / 32768.0
    return {
        "sample_rate": rate,
        "channels": channels,
        "bits": width * 8,
        "frames": frames,
        "seconds": frames / rate,
        "rms": float(np.sqrt(np.mean(f**2))),
        "peak": float(np.max(np.abs(f))),
        # Sessizlik/ton ayrimi: konusmada kisa pencere enerjisi cok degisir.
        "crest": float(np.max(np.abs(f)) / (np.sqrt(np.mean(f**2)) + 1e-9)),
        "bytes": len(wav_bytes),
    }


def _report(tag: str, text: str, ms: float, st: dict) -> None:
    rtf = (ms / 1000.0) / st["seconds"]
    print(
        f"[{tag}] {ms:7.1f}ms ses={st['seconds']:5.2f}s RTF={rtf:.3f} "
        f"rms={st['rms']:.4f} peak={st['peak']:.4f} crest={st['crest']:.1f}"
    )
    print(f"        metin: {text[:60]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--text", default=DEFAULT_TEXT)
    ap.add_argument("--out")
    ap.add_argument("--bench", action="store_true")
    args = ap.parse_args()

    url = f"http://{args.host}:{args.port}/synthesize"

    if args.bench:
        # Ilk istek soguktur: onnxruntime arena + espeak sozlugu ilk kez isinir.
        for i, text in enumerate(BENCH_TEXTS):
            wav, dt, _ = synthesize(url, text)
            _report("soguk" if i == 0 else "sicak", text, dt * 1000, analyze(wav))
        print("--- ayni cumleler ikinci turda (tamamen sicak) ---")
        for text in BENCH_TEXTS:
            wav, dt, _ = synthesize(url, text)
            _report("sicak", text, dt * 1000, analyze(wav))
        return

    wav, dt, ctype = synthesize(url, args.text)
    st = analyze(wav)
    print(f"content-type: {ctype}")
    _report("istek", args.text, dt * 1000, st)
    print(json.dumps(st, indent=2))

    if args.out:
        with open(args.out, "wb") as f:
            f.write(wav)
        print(f"yazildi: {args.out}")


if __name__ == "__main__":
    main()
