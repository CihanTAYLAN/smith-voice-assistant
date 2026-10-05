"""Smith STT sidecar — faster-whisper (CTranslate2) sunucusu.

Neden sidecar: whisper.cpp her ifadeyi 30 sn'lik pencereye pad'leyip CPU'da
encode ediyor; bu makinede ifade basina sabit ~16 sn (RTF 8-19) olculdu.
faster-whisper ayni whisper agirliklarini CTranslate2 ile kosar: GPU'da
(RTX 5060) int8_float16 ile ifade basina beklenen sure ~0.2-0.5 sn.
Dogruluk ayni (ayni model agirliklari), fark yalniz runtime.

Protokol (TCP 127.0.0.1:PORT, istek basina baglanti):
  istek : u32-LE ornek sayisi N + N adet f32-LE PCM (16 kHz mono)
          N yuksek biti 1 ise yalniz yerel motor (bulut yasak)
          0x80000000: PCM olmadan modeli isit; ready=true yaniti bekle
  yanit : u32-LE bayt uzunlugu + UTF-8 JSON {"text","ms","device"}

Rust tarafi: apps/desktop/src-tauri/src/audio/live.rs yerel_stt.
Calistirma: scripts/smith-up.ps1 stt bileseni (mevcut venv gerekir).
"""

from __future__ import annotations

import argparse
import gc
import threading
import json
import os
import pathlib
import socketserver
import struct
import sys
import time

_DLL_DIRECTORY_HANDLES = []


def _add_nvidia_dll_dirs() -> None:
    """pip'in nvidia-* wheel'lerindeki CUDA DLL'lerini yukle (Windows).

    DIKKAT: `nvidia` paketi namespace-package'dir — `nvidia.__file__` None
    doner; o yoldan gidilemez. site-packages'i dogrudan tarayip her
    nvidia/*/bin dizinini hem add_dll_directory hem PATH'e ekleriz
    (ctranslate2 bagimli DLL'leri her iki mekanizmayla da arayabiliyor).
    """
    try:
        import site

        roots = list(site.getsitepackages())
        try:
            roots.append(site.getusersitepackages())
        except Exception:
            pass
        seen = set()
        for root in roots:
            nv = pathlib.Path(root) / "nvidia"
            if not nv.is_dir():
                continue
            for bin_dir in nv.glob("*/bin"):
                key = str(bin_dir).lower()
                if key in seen:
                    continue
                seen.add(key)
                _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(bin_dir)))
                os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
        if seen:
            print(f"[stt-sidecar] {len(seen)} CUDA DLL dizini eklendi", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"[stt-sidecar] DLL dizini eklenemedi: {e!r}", file=sys.stderr)


def load_model(name: str):
    """GPU (int8_float16) dene; olmazsa CPU (int8) fallback."""
    from faster_whisper import WhisperModel

    try:
        m = WhisperModel(name, device="cuda", compute_type="int8_float16", local_files_only=True)
        # Kucuk bir isinma: CUDA kernelleri ilk cagrida derlenir/yuklenir.
        import numpy as np

        list(m.transcribe(np.zeros(16000, dtype=np.float32), language="tr", beam_size=1)[0])
        print("[stt-sidecar] CUDA modeli aktif", file=sys.stderr, flush=True)
        return m, "cuda"
    except Exception as e:  # noqa: BLE001 — sebep ne olursa olsun CPU'ya dus
        print(f"[stt-sidecar] CUDA olmadi ({e!r}); CPU int8'e dusuluyor", file=sys.stderr)
        m = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=max(4, (os.cpu_count() or 4) - 4), local_files_only=True)
        return m, "cpu"


MODEL = None
MODEL_NAME = "large-v3-turbo"
MODEL_LOCK = threading.Lock()
LAST_REQUEST = 0.0
IDLE_SECONDS = 600
DEVICE = "?"
LANGUAGE = "tr"
INITIAL_PROMPT = "Smith adlı sesli asistana Türkçe konuşma."

# --- Bulut STT (Deepgram) ------------------------------------------------
# Kullanici karari (2026-08-12): dogruluk icin bulut STT denenecek. Deepgram
# gercek-zaman ASR icin tasarlandi; ham PCM'i dogrudan kabul eder (donusum yok).
# Yerel faster-whisper KALDIRILMADI: `--engine local` ile geri donulur, ayrica
# bulut hata verirse istek basina yerele DUSER (sessiz kesinti olmaz).
DEEPGRAM_KEY = os.environ.get("SMITH_DEEPGRAM_KEY", "")
DEEPGRAM_MODEL = os.environ.get("SMITH_DEEPGRAM_MODEL", "nova-3")
ENGINE = "local"  # local | deepgram


def transcribe_deepgram(audio) -> str:
    """16 kHz mono f32 -> Deepgram (s16le raw). Bos string = konusma yok."""
    import urllib.error
    import urllib.request

    import numpy as np

    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    url = (
        "https://api.deepgram.com/v1/listen"
        f"?model={DEEPGRAM_MODEL}&language={LANGUAGE}"
        "&encoding=linear16&sample_rate=16000&channels=1"
        "&punctuate=true&smart_format=true"
    )
    req = urllib.request.Request(
        url,
        data=pcm,
        headers={"Authorization": f"Token {DEEPGRAM_KEY}", "Content-Type": "audio/raw"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.load(r)
    alts = d["results"]["channels"][0]["alternatives"]
    return (alts[0].get("transcript") or "").strip() if alts else ""


def transcribe_local(audio):
    global MODEL, DEVICE, LAST_REQUEST
    if not MODEL_LOCK.acquire(timeout=1.5):
        raise TimeoutError("yerel STT mesgul")
    try:
        try:
            if MODEL is None:
                MODEL, DEVICE = load_model(MODEL_NAME)
            if audio is None:
                return "", DEVICE
            segments, _info = MODEL.transcribe(
                audio,
                language=LANGUAGE,
                beam_size=1,
                best_of=1,
                # Sicaklik MERDIVENI (tek 0.0 degil): compression_ratio /
                # log_prob esikleri patlarsa yeniden decode dener — "Dööööö…"
                # tarzi tekrar donguleri sahada gozlendi, bu merdiven onlarin
                # standart panzehiri.
                temperature=[0.0, 0.2, 0.4],
                compression_ratio_threshold=2.2,
                log_prob_threshold=-0.9,
                # Sessizlik/nefes pencerelerinde uydurmayi kes: cihaz VAD'i
                # kaba kapi, bu ise segment-ici emniyet.
                no_speech_threshold=0.45,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
                condition_on_previous_text=False,
                without_timestamps=True,
                initial_prompt=INITIAL_PROMPT,
            )
            text = "".join(s.text for s in segments).strip()
            return text, DEVICE
        finally:
            LAST_REQUEST = time.monotonic()
    finally:
        MODEL_LOCK.release()


def release_idle_model(now=None):
    global MODEL, DEVICE
    if not MODEL_LOCK.acquire(blocking=False):
        return
    try:
        if MODEL is not None and (time.monotonic() if now is None else now) - LAST_REQUEST >= IDLE_SECONDS:
            MODEL = None
            DEVICE = "?"
            gc.collect()
            print("[stt-sidecar] 10 dk bos: model bellekten birakildi", file=sys.stderr, flush=True)
    finally:
        MODEL_LOCK.release()


class Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:  # noqa: D102
        import socket

        try:
            import numpy as np

            # Nagle kapali: yanit tek kucuk paket; gecikmeli ACK beklemesin.
            self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.request.settimeout(5)
            header = _read_exact(self.request, 4)
            (n,) = struct.unpack("<I", header)
            local_only = bool(n & 0x80000000)
            n &= 0x7fffffff
            if n > 30 * 16000 or (n == 0 and not local_only):
                raise ValueError("PCM uzunlugu 0..30 sn araliginda olmali")
            raw = _read_exact(self.request, n * 4)
            audio = None if n == 0 else np.frombuffer(raw, dtype=np.float32)

            t0 = time.time()

            # Bulut motoru secilmisse once onu dene; hata olursa YEREL'e dus
            # (istek kaybolmaz — kullanici sessizlik yerine biraz daha az
            # dogru bir sonuc alir, bu daha iyi bir bozulma modu).
            if ENGINE == "deepgram" and not local_only:
                try:
                    text = transcribe_deepgram(audio)
                    ms = int((time.time() - t0) * 1000)
                    body = json.dumps({"text": text, "ms": ms, "device": "deepgram"}).encode("utf-8")
                    self.request.sendall(struct.pack("<I", len(body)) + body)
                    print(
                        f"[stt-sidecar] {len(audio)/16000:.2f}s ses -> {ms}ms (deepgram) \"{text}\"",
                        file=sys.stderr,
                        flush=True,
                    )
                    return
                except Exception as e:  # noqa: BLE001
                    print(f"[stt-sidecar] deepgram hatasi ({e!r}) -> yerele dusuldu", file=sys.stderr, flush=True)

            text, device = transcribe_local(audio)
            ms = int((time.time() - t0) * 1000)

            body = json.dumps({"text": text, "ms": ms, "device": device, "ready": True}).encode("utf-8")
            self.request.sendall(struct.pack("<I", len(body)) + body)
            dur = n / 16000.0
            print(
                f"[stt-sidecar] {dur:.2f}s ses -> {ms}ms decode ({device}) \"{text}\"",
                file=sys.stderr,
                flush=True,
            )
        except Exception as e:  # noqa: BLE001
            print(f"[stt-sidecar] istek hatasi: {e!r}", file=sys.stderr, flush=True)
            body = json.dumps({"error": "yerel STT kullanilamiyor"}).encode("utf-8")
            try:
                self.request.sendall(struct.pack("<I", len(body)) + body)
            except OSError:
                pass  # Istemcinin 1.5 sn butcesi dolmus olabilir.


def _read_exact(sock, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("baglanti kapandi")
        buf += chunk
    return buf


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def service_actions(self):
        release_idle_model()


def main() -> None:
    global MODEL_NAME, ENGINE

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--engine", choices=["local", "deepgram"], default="local")
    args = ap.parse_args()
    ENGINE = args.engine
    if ENGINE == "deepgram" and not DEEPGRAM_KEY:
        print("[stt-sidecar] SMITH_DEEPGRAM_KEY yok -> yerel motora dusuldu", file=sys.stderr)
        ENGINE = "local"

    _add_nvidia_dll_dirs()
    MODEL_NAME = args.model
    print(f"[stt-sidecar] READY model=lazy port={args.port}", file=sys.stderr, flush=True)

    with Server(("127.0.0.1", args.port), Handler) as srv:
        srv.serve_forever()


if __name__ == "__main__":
    main()
